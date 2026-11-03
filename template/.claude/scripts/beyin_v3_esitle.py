"""Keep the vault in step with the git remote its branch follows: `beyin.py esitle`.

One set of rules for every place a vault is synced (the desktop app's timer, a server's timer): everything is
added, the lines a commit would add are scanned for a secret, then commit, pull with rebase, push. Nothing is
ever written over: a conflict is backed out of (`rebase --abort`) and said, the notes left as they were on both
sides; a secret in a new line stops it before the commit, the files untouched; with no network the notes stay
here and go the next time. Git is the person's own, found on the PATH and never inside the vault; it is told
never to prompt, runs no hook of the repository's and no file-system monitor.

Standard library only. The result is one line: JSON with --json (the desktop app reads it), else a sentence.
Exit code: 0 synced / nothing to do / busy, 3 missing (git, a repository, a remote branch), 1 otherwise; never 2.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

GIT_TIMEOUT = 120
SECRET_ALLOWED = 'sir-tarama:izin'
UNREACHABLE = re.compile(
    r'could not resolve host|unable to access|failed to connect|connection (?:timed out|refused|reset)|'
    r'network is unreachable|could not read from remote repository|authentication failed|timed out', re.I)
PATTERNS = (
    ('private key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY')),
    ('GitHub token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})')),
    ('Anthropic key', re.compile(r'\bsk-ant-[A-Za-z0-9_-]{20,}')),
    ('OpenAI key', re.compile(r'\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}')),
    ('AWS key', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('Google API key', re.compile(r'\bAIza[0-9A-Za-z_-]{35}')),
    ('Slack token', re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}')),
    ('Telegram bot token', re.compile(r'\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b')),
    ('Hugging Face token', re.compile(r'\bhf_[A-Za-z0-9]{30,}')),
    ('Tailscale key', re.compile(r'\btskey-[a-z]+-[A-Za-z0-9-]{20,}')),
    ('Notion token', re.compile(r'\b(?:secret_|ntn_)[A-Za-z0-9]{40,}')),
    ('JWT', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
)
# "parola: Xy7…", "api_key = …": counted only where the value looks random (a placeholder or a plain word is not).
ASSIGNMENT = re.compile(
    r'\b(?:password|passwd|parola|şifre|sifre|secret|token|api[_-]?key|access[_-]?key)\b["\']?\s*[:=]\s*["\']?([^\s"\'`<>]{16,})',
    re.I)
PLACEHOLDER = re.compile(r'(\$\{|\$\(|xxx|\.\.\.|<|example|ornek|örnek|placeholder|your[_-]|changeme)', re.I)


# ---------- the secret scan ----------

def _entropy(text: str) -> float:
    counts: dict[str, int] = {}
    for ch in text:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum((n / len(text)) * math.log2(n / len(text)) for n in counts.values())


def secret_in(line: str, literals: tuple[str, ...] = ()) -> str | None:
    """The kind of secret a line holds, or None. `literals`: the person's own values (state/secret-patterns.txt)."""
    if SECRET_ALLOWED in line:
        return None
    for kind, pattern in PATTERNS:
        if pattern.search(line):
            return kind
    for value in literals:
        if value in line:
            return 'known secret'
    assigned = ASSIGNMENT.search(line)
    if assigned and not PLACEHOLDER.search(assigned.group(1)) and _entropy(assigned.group(1)) >= 3.5:
        return 'password or key'
    return None


def secrets_added(diff: str, literals: tuple[str, ...] = ()) -> list[dict]:
    """The secrets in the lines a diff adds (`git diff --cached -U0`): where and what kind, never the secret."""
    found, file, line = [], '', 0
    for row in diff.split('\n'):
        if row.startswith('+++ '):
            file = row[6:] if row.startswith('+++ b/') else row[4:]
            continue
        hunk = re.match(r'^@@ -\d+(?:,\d+)? \+(\d+)', row)
        if hunk:
            line = int(hunk.group(1))
            continue
        if row.startswith('+') and not row.startswith('+++'):
            kind = secret_in(row[1:], literals)
            if kind:
                found.append({'file': file, 'line': line, 'kind': kind})
            line += 1
    return found


def _literals(state: Path | None) -> tuple[str, ...]:
    if state is None:
        return ()
    try:
        import beyin_v3_secrets
        return tuple(beyin_v3_secrets._custom_literals(state))
    except Exception:
        return ()  # no list, or one that is not valid: the built-in kinds still stop a commit


# ---------- git ----------

def remote_label(url: str) -> str | None:
    """The remote said without a name, password or token: `github.com/owner/repo`."""
    text = (url or '').strip()
    if not text:
        return None
    scp = re.match(r'^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?$', text)
    if scp and '://' not in text:
        return f'{scp.group(1)}/{scp.group(2)}'
    if not re.match(r'^[a-z][a-z0-9+.-]*://', text, re.I):
        return text  # a folder on this computer or the network: no name or password is ever in one
    try:
        parts = urlsplit(text)
        host = parts.hostname or ''
        if parts.port:
            host += f':{parts.port}'
        return host + re.sub(r'\.git$', '', parts.path)
    except ValueError:
        return None


def git_program(vault: Path) -> str | None:
    """Git found on the PATH alone and never inside the vault (a git.exe a remote brought must not run)."""
    names = ('git.exe',) if os.name == 'nt' else ('git',)
    root = Path(vault).resolve()
    for folder in os.environ.get('PATH', '').split(os.pathsep):
        if not folder or not os.path.isabs(folder):
            continue
        for name in names:
            candidate = Path(folder) / name
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if candidate.is_file() and os.access(candidate, os.X_OK) and root not in (resolved, *resolved.parents):
                return str(candidate)
    return None


class Git:
    def __init__(self, vault: Path):
        self.vault = Path(vault)
        self.program = git_program(self.vault)

    def __call__(self, *args: str, timeout: int = GIT_TIMEOUT) -> tuple[int, str, str]:
        if not self.program:
            return 127, '', 'git not found'
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'never', 'LC_ALL': 'C', 'LANG': 'C'}
        command = [self.program, '-C', str(self.vault), '-c', 'core.quotepath=false',
                   '-c', f'core.hooksPath={os.devnull}', '-c', 'core.fsmonitor=false', *args]
        try:
            # Run from outside the vault (see git_program); the home folder, or the temp folder where it is gone.
            outside = Path.home() if Path.home().is_dir() else Path(tempfile.gettempdir())
            done = subprocess.run(command, cwd=str(outside), env=env, capture_output=True, timeout=timeout,
                                  stdin=subprocess.DEVNULL,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except subprocess.TimeoutExpired:
            return 124, '', 'timed out'
        except OSError as exc:
            return 127, '', str(exc)
        return done.returncode, done.stdout.decode('utf-8', 'replace'), done.stderr.decode('utf-8', 'replace')


def _last(text: str) -> str:
    lines = [one for one in (text or '').strip().split('\n') if one.strip()]
    return lines[-1][:300] if lines else ''


def _same(a: str, b: Path) -> bool:
    try:
        one, two = os.path.realpath(a), os.path.realpath(str(b))
    except OSError:
        return False
    return os.path.normcase(one) == os.path.normcase(two)


def inspect(git: Git) -> dict:
    """What the vault offers: git, a repository at its top, a branch that follows a remote one, the remote's name."""
    if git('--version', timeout=15)[0] != 0:
        return {'missing': 'git', 'remote': None}
    code, out, _ = git('rev-parse', '--show-toplevel', timeout=15)
    if code != 0 or not _same(out.strip(), git.vault):
        return {'missing': 'repo', 'remote': None}
    code, out, _ = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}', timeout=15)
    if code != 0 or not out.strip():
        return {'missing': 'remote', 'remote': None}
    name = out.strip().split('/')[0]
    code, url, _ = git('remote', 'get-url', name, timeout=15)
    return {'missing': None, 'remote': remote_label(url) if code == 0 else None}


def _count(git: Git, span: str) -> int:
    code, out, _ = git('rev-list', '--count', span, timeout=30)
    return int(out.strip()) if code == 0 and out.strip().isdigit() else 0


def _stamp() -> str:
    return time.strftime('%d.%m.%Y %H:%M')


def sync_once(vault: Path, state: Path | None = None, host: str | None = None) -> dict:
    git = Git(vault)
    result = {'state': 'error', 'missing': None, 'remote': None, 'detail': [], 'pulled': 0, 'pushed': 0}
    result.update(inspect(git))
    if result['missing']:
        result['state'] = 'missing'
        return result
    git_dir = Path(git('rev-parse', '--absolute-git-dir', timeout=15)[1].strip() or vault / '.git')
    # A rebase left standing (a conflict being solved by hand) is the person's: nothing is done over it.
    if (git_dir / 'rebase-merge').exists() or (git_dir / 'rebase-apply').exists():
        return {**result, 'state': 'conflict', 'detail': ['git: rebase']}
    code, _, err = git('add', '-A')
    if code:
        return {**result, 'detail': [_last(err)]}
    # Only what is new is read; a secret found, nothing is committed and the files stay as they are.
    found = secrets_added(git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff')[1], _literals(state))
    if found:
        git('reset', '-q')
        return {**result, 'state': 'secret', 'detail': [f"{one['file']}:{one['line']} {one['kind']}" for one in found[:10]]}
    committed = False
    if git('diff', '--cached', '--quiet')[0] == 1:
        code, out, err = git('commit', '-q', '--no-verify', '-m', f'senkron: {host or socket.gethostname()} {_stamp()}')
        if code:
            return {**result, 'detail': [_last(err or out)]}
        committed = True
    before = git('rev-parse', '@{u}', timeout=15)[1].strip()
    code, _, err = git('pull', '-q', '--rebase')
    if code:
        conflicted = [one for one in git('diff', '--name-only', '--diff-filter=U')[1].split('\n') if one]
        git('rebase', '--abort')
        if not conflicted and UNREACHABLE.search(err):
            return {**result, 'state': 'offline', 'detail': [_last(err)]}
        return {**result, 'state': 'conflict', 'detail': conflicted[:10] or [_last(err)]}
    result['pulled'] = _count(git, f'{before}..@{{u}}') if before else 0
    ahead = _count(git, '@{u}..HEAD')
    if ahead:
        code, _, err = git('push', '-q')
        if code:
            return {**result, 'state': 'offline' if UNREACHABLE.search(err) else 'error', 'detail': [_last(err)]}
        result['pushed'] = ahead
    result['state'] = 'synced' if (committed or ahead or result['pulled']) else 'nothing'
    return result


# One sync per vault on this machine: an OS advisory lock on state/esitle.lock (flock / msvcrt; the `_portalock`
# primitive written inline, as beyin_v3_telegram does: that helper is not in the release package).
def _lock(handle) -> bool:
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(handle) -> None:
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def sync(vault: Path, state: Path | None = None) -> dict:
    """One sync at a time: while one runs, another says `busy` at once instead of waiting."""
    if state is None:
        return sync_once(vault)
    state.mkdir(parents=True, exist_ok=True)
    with open(state / 'esitle.lock', 'a+b') as handle:
        if not _lock(handle):
            return {'state': 'busy', 'missing': None, 'remote': None, 'detail': [], 'pulled': 0, 'pushed': 0}
        try:
            return sync_once(vault, state)
        finally:
            _unlock(handle)


SENTENCE = {
    'synced': lambda r: f"Eşitlendi: {r['pulled']} commit geldi, {r['pushed']} gitti" + (f" ({r['remote']})" if r['remote'] else '') + '.',
    'nothing': lambda r: 'Eşit: gönderilecek ya da gelecek bir şey yok.',
    'busy': lambda r: 'Başka bir eşitleme sürüyor; bu tur atlandı.',
    'missing': lambda r: {'git': 'Git bu bilgisayarda bulunamadı.',
                          'repo': 'Bu kasa bir git deposu değil.',
                          'remote': 'Kasanın dalı bir uzak dalı izlemiyor; eşitlenecek yer yok.'}.get(r['missing'], 'Eksik.'),
    'secret': lambda r: 'Gönderilmedi: yeni satırlarda sır olabilir (' + ', '.join(r['detail']) + '). Sırrı sil; örnekse satıra sir-tarama:izin yaz.',
    'conflict': lambda r: 'Eşitleme durdu: buradaki ve uzaktaki notlar aynı yerde ayrıştı, hiçbir şey silinmedi (' + ', '.join(r['detail']) + ').',
    'offline': lambda r: 'Uzak depoya ulaşılamadı; notlar burada, bir sonraki turda gider.',
    'error': lambda r: 'Eşitlenemedi: ' + ', '.join(r['detail']),
}


def main(argv=None, vault=None, state=None) -> int:
    parser = argparse.ArgumentParser(prog='beyin.py esitle', description='Kasayı git uzak deposuyla eşitler.')
    parser.add_argument('--json', action='store_true', help='Sonucu tek satır JSON yaz')
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    if vault is None:
        raise SystemExit('Kasa bilinmiyor; beyin.py esitle ile çalıştırın.')
    result = sync(Path(vault), Path(state) if state else None)
    if args.json:
        print(json.dumps(result, ensure_ascii=False), flush=True)
    else:
        print(SENTENCE[result['state']](result), flush=True)
    return 0 if result['state'] in ('synced', 'nothing', 'busy') else 3 if result['state'] == 'missing' else 1


if __name__ == '__main__':
    raise SystemExit(main())
