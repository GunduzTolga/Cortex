"""Keep the vault in step with the git remote its branch follows: `beyin.py esitle`.

One set of rules for every place a vault is synced (the desktop app's timer, a server's timer): everything is
added, the lines a commit would add are scanned for a secret, then commit, pull with rebase, push. Nothing is
ever written over: a conflict is backed out of (`rebase --abort`) and said, the notes left as they were on both
sides; a secret in a new line stops it before the commit, the files untouched; with no network the notes stay
here and go the next time. Git is the person's own, found on the PATH and never inside the vault; it is told
never to prompt, runs no hook of the repository's and no file-system monitor.

First time (Faz 1, 4 November): `--baslat <url>` makes the vault a repository and sends it to an empty remote;
`--baglan <url>` joins a vault to a remote that already holds one (a second computer). Neither ever deletes a
file: a note that differs on the two sides keeps both, this computer's copy renamed "<ad> (bu bilgisayar)". The
desktop app gives a GitHub token only in the environment (CORTEX_GIT_TOKEN); it reaches git as an HTTP header
through GIT_CONFIG_* variables, never a file, the command line or the repository's config. CORTEX_GIT names a git
the app brought (MinGit), outside the vault.

Standard library only. The result is one line: JSON with --json (the desktop app reads it), else a sentence.
Exit code: with --json always 0 once the line is written (the state is in it: the desktop app's runner takes a JSON
result only from an exit 0); without it 0 synced / nothing to do / busy, 3 missing (git, a repository, a remote
branch), 1 otherwise. Never 2.
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
TOKEN_ENV = 'CORTEX_GIT_TOKEN'
GIT_ENV = 'CORTEX_GIT'
KEPT = 'bu bilgisayar'
SECRET_ALLOWED = 'sir-tarama:izin'
UNREACHABLE = re.compile(
    r'could not resolve host|unable to access|failed to connect|connection (?:timed out|refused|reset)|'
    r'network is unreachable|could not read from remote repository|timed out', re.I)
# The remote turned the credentials down (a GitHub token expired or taken back, no access to the repository): no
# network trouble and no conflict, but a connection to renew. Seen with GitHub, 4 November: a pull without the token
# said "could not read Username ... terminal prompts disabled", and the sync called it a conflict.
DENIED = re.compile(
    r'could not read (?:username|password)|authentication failed|invalid username or (?:password|token)|'
    r'permission to \S+ denied|returned error: 40[13]|repository not found|write access to repository not granted', re.I)


def _remote_state(err: str) -> str:
    """Why talking to the remote failed: its credentials turned down, the network, or something else."""
    return 'denied' if DENIED.search(err) else 'offline' if UNREACHABLE.search(err) else 'error'
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
    brought = os.environ.get(GIT_ENV, '')
    if brought and os.path.isabs(brought):
        try:
            resolved = Path(brought).resolve()
        except OSError:
            resolved = None
        if resolved and resolved.is_file() and root not in (resolved, *resolved.parents):
            return str(resolved)
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


def token_config(token: str) -> dict:
    """A GitHub token as git's HTTP header for github.com alone, in GIT_CONFIG_* variables (git 2.31+): never written
    to a file, the command line (other users can read a process's arguments) or the repository's config."""
    token = (token or '').strip()
    if not token or any(ch.isspace() for ch in token):
        return {}
    import base64
    basic = base64.b64encode(f'x-access-token:{token}'.encode()).decode()
    count = int(os.environ.get('GIT_CONFIG_COUNT', '0') or 0)
    return {'GIT_CONFIG_COUNT': str(count + 1), f'GIT_CONFIG_KEY_{count}': 'http.https://github.com/.extraheader',
            f'GIT_CONFIG_VALUE_{count}': f'Authorization: Basic {basic}'}


class Git:
    def __init__(self, vault: Path):
        self.vault = Path(vault)
        self.program = git_program(self.vault)

    def __call__(self, *args: str, timeout: int = GIT_TIMEOUT, input_text: str | None = None) -> tuple[int, str, str]:
        if not self.program:
            return 127, '', 'git not found'
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'never', 'LC_ALL': 'C', 'LANG': 'C'}
        env.update(token_config(env.pop(TOKEN_ENV, '')))
        command = [self.program, '-C', str(self.vault), '-c', 'core.quotepath=false',
                   '-c', f'core.hooksPath={os.devnull}', '-c', 'core.fsmonitor=false', *args]
        try:
            # Run from outside the vault (see git_program); the home folder, or the temp folder where it is gone.
            outside = Path.home() if Path.home().is_dir() else Path(tempfile.gettempdir())
            feed = {'input': input_text.encode('utf-8')} if input_text is not None else {'stdin': subprocess.DEVNULL}
            done = subprocess.run(command, cwd=str(outside), env=env, capture_output=True, timeout=timeout, **feed,
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
        reach = _remote_state(err)
        if not conflicted and reach != 'error':
            return {**result, 'state': reach, 'detail': [_last(err)]}
        return {**result, 'state': 'conflict', 'detail': conflicted[:10] or [_last(err)]}
    result['pulled'] = _count(git, f'{before}..@{{u}}') if before else 0
    ahead = _count(git, '@{u}..HEAD')
    if ahead:
        code, _, err = git('push', '-q')
        if code:
            return {**result, 'state': _remote_state(err), 'detail': [_last(err)]}
        result['pushed'] = ahead
    result['state'] = 'synced' if (committed or ahead or result['pulled']) else 'nothing'
    return result


# ---------- the first time: a new backup, or joining one ----------

# What every machine installs or makes for itself, and what stays on it (docs/v3/MULTI-MACHINE.md shows the same
# list; a test holds the two together). Written into .gitignore the first time; lines already there are kept.
IGNORE = (
    ("# Beyin kurulumu: her makine Beyin'i kendisi kurar ve günceller", (
        '.beyin-runtime.json', '.beyin-version', 'beyin.py', 'Beyni Guncelle.cmd', 'Beyni Güncelle.sh',
        'Beyni Güncelle.desktop', '.claude/settings.local.json', '.claude/scripts/', '.claude/hermes-plugin/',
        '.claude/skills/beyin/', '.claude/skills/beyin-doktor/', '.claude/skills/beyin-guncelle/',
        '.claude/skills/beyin-yakala/', '.agents/hooks.json', '.agents/skills/beyin/', '.agents/skills/beyin-doktor/',
        '.agents/skills/beyin-guncelle/', '.agents/skills/beyin-yakala/', '.codex/config.toml', '.codex/hooks.json',
        '.gemini/settings.json', '.qwen/settings.json', '.kiro/hooks/beyin-v3.json', '.kiro/skills/beyin/',
        '.kiro/skills/beyin-doktor/', '.kiro/skills/beyin-guncelle/', '.opencode/plugins/beyin-v3.js',
        '.omp/hooks/pre/beyin-v3.ts')),
    ('# companion-compact süreçler arası kilidi; kalıcıdır ama kullanıcı verisi değildir', ('**/.beyin-compact.lock',)),
    ("# note-edit'in bu makineye ait yazma kilidi ve notların eski hâllerinin yedekleri", ('.beyin-note-write/',)),
    ('# Yerel veritabanından üretilen görünümler: her makine kendisininkini üretir', ('daily/v3/', 'knowledge/v3/')),
    ('# Yakala: ham metinler ve yakalanan dosyalar bu bilgisayarda kalır',
     ('📥 000-Inbox/Yakala/.ham/', '📥 000-Inbox/Yakala/dosyalar/')),
    ('# Gizli değerler ve makineye özel çalışma alanı', ('.env', '.obsidian/workspace*.json')),
)
ATTRIBUTES = (
    ('# Receipt dosyaları bayt bayt karşılaştırılır: satır sonu dönüştürülmez', ('receipts/** -text',)),
    ('# Kart ve kayıt düzenindeki companion dosyaları: iki makinenin eklemeleri birlikte kalır',
     ('**/Last-Session.md merge=union', '**/Journal.md merge=union', '**/Arşiv/*.md merge=union')),
)


def render(groups) -> str:
    return '\n'.join(line for comment, entries in groups for line in (comment, *entries)) + '\n'


def add_lines(file: Path, groups) -> bool:
    """The groups' lines missing from the file added at its end (with their comment); what is there stays. True if written."""
    try:
        text = file.read_text(encoding='utf-8')
    except FileNotFoundError:
        text = ''
    have = {line.strip() for line in text.splitlines()}
    missing = [(comment, [one for one in entries if one not in have]) for comment, entries in groups]
    missing = [(comment, entries) for comment, entries in missing if entries]
    if not missing:
        return False
    if text and not text.endswith('\n'):
        text += '\n'
    file.write_text(text + ('\n' if text else '') + render(missing), encoding='utf-8')
    return True


def _usable_url(url: str) -> bool:
    """An https remote, or a folder (a bare repository on this computer or the network: the tests, a NAS)."""
    text = (url or '').strip()
    if not text or text.startswith('-') or any(ch in text for ch in '\r\n\0'):
        return False
    if re.match(r'^https://[^\s/@]+/', text):
        return True
    return os.path.isabs(text) and os.path.isdir(text)


def _identity(git: Git, host: str) -> None:
    """A name for the commits where git has none (a fresh computer, a MinGit the app brought): the app's, else the host's."""
    if git('config', 'user.name', timeout=15)[0] != 0:
        git('config', 'user.name', os.environ.get('CORTEX_GIT_NAME') or host, timeout=15)
    if git('config', 'user.email', timeout=15)[0] != 0:
        git('config', 'user.email', os.environ.get('CORTEX_GIT_EMAIL') or f'cortex@{host}.local', timeout=15)


def _begin(git: Git, vault: Path, url: str, result: dict) -> dict | None:
    """Git there, the vault a repository of its own that follows no remote yet, `origin` pointing at the url.
    Returns the result to give back when it cannot go on, else None."""
    if not _usable_url(url):
        return {**result, 'detail': ['url']}
    if git('--version', timeout=15)[0] != 0:
        return {**result, 'state': 'missing', 'missing': 'git'}
    if not vault.is_dir():
        return {**result, 'state': 'missing', 'missing': 'repo'}
    code, out, _ = git('rev-parse', '--show-toplevel', timeout=15)
    if code == 0 and _same(out.strip(), vault):
        seen = inspect(git)
        if not seen['missing']:
            return {**result, 'state': 'already', 'remote': seen['remote']}
    else:
        # Not a repository, or a folder inside another one: the vault becomes its own.
        code, _, err = git('init', '-q', '-b', 'main')
        if code:  # git before 2.28 has no -b: the branch named after
            code, _, err = git('init', '-q')
            if not code:
                code, _, err = git('symbolic-ref', 'HEAD', 'refs/heads/main', timeout=15)
        if code:
            return {**result, 'detail': [_last(err)]}
    if git('remote', 'get-url', 'origin', timeout=15)[0] == 0:
        code, _, err = git('remote', 'set-url', 'origin', url, timeout=15)
    else:
        code, _, err = git('remote', 'add', 'origin', url, timeout=15)
    if code:
        return {**result, 'detail': [_last(err)]}
    result['remote'] = remote_label(url)
    return None


def _remote_branch(git: Git) -> tuple[int, str | None, str]:
    """The remote's default branch: (0, name) if it has one, (0, None) if it is empty, else git's failure."""
    code, out, err = git('ls-remote', '--symref', 'origin', 'HEAD')
    if code:
        return code, None, err
    found = re.search(r'^ref: refs/heads/(\S+)\s+HEAD', out, re.M)
    if found:
        return 0, found.group(1), ''
    code, out, err = git('ls-remote', '--heads', 'origin')
    if code:
        return code, None, err
    heads = [line.split('refs/heads/', 1)[1] for line in out.splitlines() if 'refs/heads/' in line]
    return 0, ('main' if 'main' in heads else heads[0]) if heads else None, ''


def _failed(result: dict, err: str) -> dict:
    return {**result, 'state': _remote_state(err), 'detail': [_last(err)]}


def _commit_all(git: Git, state: Path | None, message: str, result: dict) -> dict | None:
    """Everything added and, with no secret in it, committed. Returns the result to give back when it stops."""
    code, _, err = git('add', '-A')
    if code:
        return {**result, 'detail': [_last(err)]}
    found = secrets_added(git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff')[1], _literals(state))
    if found:
        git('reset', '-q')
        return {**result, 'state': 'secret', 'detail': [f"{one['file']}:{one['line']} {one['kind']}" for one in found[:10]]}
    if git('diff', '--cached', '--quiet')[0] == 1 or git('rev-parse', '-q', '--verify', 'HEAD', timeout=15)[0] != 0:
        code, out, err = git('commit', '-q', '--no-verify', '--allow-empty', '-m', message)
        if code:
            return {**result, 'detail': [_last(err or out)]}
    return None


def start(vault: Path, url: str, state: Path | None = None, host: str | None = None) -> dict:
    """`--baslat`: the vault sent, for the first time, to an empty remote (a new private repository)."""
    git, host = Git(vault), host or socket.gethostname()
    result = {'state': 'error', 'mode': 'baslat', 'missing': None, 'remote': None, 'detail': [], 'pulled': 0,
              'pushed': 0, 'kept': []}
    stop = _begin(git, Path(vault), url, result)
    if stop:
        return stop
    code, branch, err = _remote_branch(git)
    if code:
        return _failed(result, err)
    if branch:
        return {**result, 'state': 'not_empty'}  # a vault is there already: --baglan joins it
    add_lines(Path(vault) / '.gitignore', IGNORE)
    add_lines(Path(vault) / '.gitattributes', ATTRIBUTES)
    _identity(git, host)
    stop = _commit_all(git, state, f'ilk yedek: {host} {_stamp()}', result)
    if stop:
        return stop
    current = git('symbolic-ref', '--short', 'HEAD', timeout=15)[1].strip() or 'main'
    code, _, err = git('push', '-q', '-u', 'origin', f'HEAD:refs/heads/{current}')
    if code:
        return _failed(result, err)
    git('branch', '-q', f'--set-upstream-to=origin/{current}', current, timeout=15)
    return {**result, 'state': 'synced', 'pushed': _count(git, 'HEAD')}


def _kept_name(vault: Path, path: str, taken: set[str]) -> str:
    """`<ad> (bu bilgisayar)<.uzantı>`, numbered if that is taken too, here or on the remote."""
    folder, name = os.path.split(path)
    stem, dot, ext = name.rpartition('.') if '.' in name.lstrip('.') else (name, '', '')
    for n in range(1, 1000):
        label = KEPT if n == 1 else f'{KEPT} {n}'
        candidate = f'{stem} ({label}){dot}{ext}' if dot else f'{name} ({label})'
        whole = f'{folder}/{candidate}' if folder else candidate
        if whole not in taken and not os.path.lexists(vault / whole):
            return whole
    raise RuntimeError(path)


def join(vault: Path, url: str, state: Path | None = None, host: str | None = None) -> dict:
    """`--baglan`: the vault joined to a remote that already holds one. The remote's notes come in, this computer's
    stay; a path both have with different content keeps both, this computer's copy renamed. Nothing is deleted."""
    vault = Path(vault)
    git, host = Git(vault), host or socket.gethostname()
    result = {'state': 'error', 'mode': 'baglan', 'missing': None, 'remote': None, 'detail': [], 'pulled': 0,
              'pushed': 0, 'kept': []}
    stop = _begin(git, vault, url, result)
    if stop:
        return stop
    code, branch, err = _remote_branch(git)
    if code:
        return _failed(result, err)
    if not branch:
        return {**result, 'state': 'empty'}  # nothing there yet: --baslat sends this vault
    code, _, err = git('fetch', '-q', 'origin', f'+refs/heads/{branch}:refs/remotes/origin/{branch}')
    if code:
        return _failed(result, err)
    code, out, err = git('ls-tree', '-r', '-z', '--full-tree', f'origin/{branch}')
    if code:
        return {**result, 'detail': [_last(err)]}
    remote = {}
    for row in out.split('\0'):
        if '\t' in row:
            meta, path = row.split('\t', 1)
            mode, kind, sha = meta.split()
            if kind == 'blob':
                remote[path] = sha
    taken = set(remote) | {os.path.dirname(p) for p in remote}
    moves: list[tuple[str, str]] = []

    def set_aside(path: str) -> None:
        if path in (old for old, _ in moves):
            return
        new = _kept_name(vault, path, taken)
        taken.add(new)
        moves.append((path, new))

    # A local file where the remote has a folder, a local folder where it has a file: set aside.
    for path in remote:
        parts = path.split('/')
        for depth in range(1, len(parts)):
            prefix = '/'.join(parts[:depth])
            if (vault / prefix).is_file() or (vault / prefix).is_symlink():
                set_aside(prefix)
        if (vault / path).is_dir() and not (vault / path).is_symlink():
            set_aside(path)
    # Files both have: compared as git would store them (its line-ending rules applied), different ones set aside.
    both = [p for p in remote if (vault / p).is_file() and not any(p == old or p.startswith(old + '/') for old, _ in moves)]
    for at in range(0, len(both), 200):
        chunk = both[at:at + 200]
        code, out, err = git('hash-object', '--stdin-paths', input_text='\n'.join(chunk) + '\n')
        if code:
            return {**result, 'detail': [_last(err)]}
        for path, sha in zip(chunk, out.split()):
            if sha != remote[path]:
                set_aside(path)
    for old, new in moves:
        os.replace(vault / old, vault / new)
        result['kept'].append({'file': old, 'as': new})
    result['pulled'] = sum(1 for p in remote if not (vault / p).exists())
    # The branch made the remote's; the index its tree; the files it has that are not here written out.
    code, _, err = git('update-ref', f'refs/heads/{branch}', f'origin/{branch}', timeout=15)
    if not code:
        code, _, err = git('symbolic-ref', 'HEAD', f'refs/heads/{branch}', timeout=15)
    if not code:
        code, _, err = git('reset', '-q')
    if not code:
        code, _, err = git('checkout', '-q', '--', '.')
    if code:
        return {**result, 'detail': [_last(err)]}
    git('branch', '-q', f'--set-upstream-to=origin/{branch}', branch, timeout=15)
    add_lines(vault / '.gitignore', IGNORE)
    add_lines(vault / '.gitattributes', ATTRIBUTES)
    _identity(git, host)
    stop = _commit_all(git, state, f'bağlandı: {host} {_stamp()}', result)
    if stop:
        return stop
    ahead = _count(git, '@{u}..HEAD')
    if ahead:
        code, _, err = git('push', '-q')
        if code:
            return _failed(result, err)
        result['pushed'] = ahead
    return {**result, 'state': 'synced'}


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


def sync(vault: Path, state: Path | None = None, start_url: str | None = None, join_url: str | None = None) -> dict:
    """One sync at a time: while one runs, another says `busy` at once instead of waiting. With a url, the first
    time instead (`start` to an empty remote, `join` one that holds a vault), under the same lock."""
    def work():
        if start_url is not None:
            return start(vault, start_url, state)
        if join_url is not None:
            return join(vault, join_url, state)
        return sync_once(vault, state)
    if state is None:
        return work()
    state.mkdir(parents=True, exist_ok=True)
    with open(state / 'esitle.lock', 'a+b') as handle:
        if not _lock(handle):
            return {'state': 'busy', 'missing': None, 'remote': None, 'detail': [], 'pulled': 0, 'pushed': 0}
        try:
            return work()
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
    'denied': lambda r: 'Uzak depo girişi reddetti (' + ', '.join(r['detail']) + '); bağlantıyı yenile. Notlar burada duruyor.',
    'error': lambda r: 'Eşitlenemedi: ' + ', '.join(r['detail']),
    'already': lambda r: 'Bu kasa zaten ' + (r['remote'] or 'bir uzak depo') + ' ile eşitleniyor; önce bağlantıyı kes.',
    'not_empty': lambda r: 'Bu depoda zaten bir kasa var; yeni yedek yerine ona bağlan.',
    'empty': lambda r: 'Bu depo boş; bağlanmak yerine yeni yedek olarak bu kasayı gönder.',
}


def sentence(result: dict) -> str:
    said = SENTENCE[result['state']](result)
    if result.get('kept'):
        n = len(result['kept'])
        said += f" {n} not iki yerde farklıydı; buradakiler '({KEPT})' adıyla kaldı."
    return said


def main(argv=None, vault=None, state=None) -> int:
    parser = argparse.ArgumentParser(prog='beyin.py esitle', description='Kasayı git uzak deposuyla eşitler.')
    parser.add_argument('--json', action='store_true', help='Sonucu tek satır JSON yaz')
    first = parser.add_mutually_exclusive_group()
    first.add_argument('--baslat', metavar='URL', help='Kasayı ilk kez boş bir uzak depoya gönder (yeni yedek)')
    first.add_argument('--baglan', metavar='URL', help='Kasayı içinde kasa olan bir uzak depoya bağla')
    # Run on its own (the desktop app's tests, a folder with no engine installed): the vault and state said here.
    parser.add_argument('--vault', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--state', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    vault = vault if vault is not None else args.vault
    state = state if state is not None else args.state
    if vault is None:
        raise SystemExit('Kasa bilinmiyor; beyin.py esitle ile çalıştırın.')
    result = sync(Path(vault), Path(state) if state else None, start_url=args.baslat, join_url=args.baglan)
    if args.json:
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    print(sentence(result), flush=True)
    return 0 if result['state'] in ('synced', 'nothing', 'busy') else 3 if result['state'] == 'missing' else 1


if __name__ == '__main__':
    raise SystemExit(main())
