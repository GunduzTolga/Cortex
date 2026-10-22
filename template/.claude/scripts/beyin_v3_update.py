"""Verified stable-release updates with local journal recovery. Standard library only."""
from contextlib import contextmanager, nullcontext
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

OFFICIAL = 'https://api.github.com/repos/GunduzTolga/Cortex/releases/latest'
MAX_PACKAGE = 32 * 1024 * 1024
# The installer mirrors each starter skill into all client roots. Mirrors
# install_v3.MANAGED_SKILL_PATHS.
MANAGED_SKILL_PATHS = frozenset(root + '/skills/' + name + '/SKILL.md' for root in ('.agents', '.claude', '.kiro')
                                for name in ('beyin', 'beyin-doktor', 'beyin-guncelle'))
# The managed block inside AGENTS.md and CLAUDE.md; mirrors install_v3.START and END, which this
# vault-side module cannot import (tests/v3_update_test.py holds the two together).
START, END = '<!-- beyin-v3:start -->', '<!-- beyin-v3:end -->'
BLOCK_FILES = ('AGENTS.md', 'CLAUDE.md')
# Settings files whose managed part is the engine's entries among the person's own keys (the JSON
# half of install_v3.USER_REGION_FILES): a key added beside them is no conflict.
JSON_REGION_FILES = ('.claude/settings.local.json', '.claude/settings.json', '.codex/hooks.json',
                     '.agents/hooks.json', '.gemini/settings.json', '.qwen/settings.json')
# All of install_v3.USER_REGION_FILES.
USER_REGION_FILES = BLOCK_FILES + JSON_REGION_FILES + ('.codex/config.toml',)


def transaction_hook(phase, index=None):
    """Fault-injection seam; no behavior in normal use."""


def failure(message, code=None, kind=ValueError):
    """A failure said to the person: one Turkish sentence with the detail they need, and, where the
    desktop app knows it, its name (`code`: updater_busy, update_conflict...). beyin.py and the
    installer print both in their error JSON; the app says a named one in the window's language
    and offers what it can do about it (a retry, a recovery) instead of showing English JSON."""
    error = kind(message)
    if code:
        error.code = code
    return error


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('stable semantic version required')
    return tuple(map(int, value.split('.')))


def allowed(name):
    return name in ('scripts/install_v3.py', 'scripts/beyin_v3.py', 'scripts/beyin_entry.py') or bool(re.fullmatch(r'template/\.claude/scripts/beyin_v3(?:_[a-z]+)*\.py', name)) or bool(re.fullmatch(r'template/\.agents/skills/(beyin|beyin-doktor|beyin-guncelle)/SKILL\.md', name))


def _read_only(path):
    """True only for a file that carries the Windows read-only attribute.

    Read from the file's own attributes: os.access also answers False for a target it cannot
    query at all, such as one pending deletion, and that one is worth a retry.
    """
    try:
        return bool(os.stat(path).st_file_attributes & stat.FILE_ATTRIBUTE_READONLY)
    except (OSError, AttributeError):
        return False


def _safe_replace(source, destination):
    """os.replace, retried briefly only for a Windows sharing violation.

    An antivirus scan, the search indexer or an editor can hold the target open for a few
    milliseconds there (WinError 5/32/33): four retries, 225 ms in all. A POSIX
    PermissionError is a real EACCES/EPERM and is raised at once, as is any other error and
    WinError 5 for a read-only target, which no wait will lift (#230).
    """
    attempts = 5 if os.name == 'nt' else 1
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except PermissionError as exc:
            if (attempt == attempts - 1 or getattr(exc, 'winerror', None) not in (5, 32, 33)
                    or _read_only(destination)):
                raise
            time.sleep(0.015 * (2 ** attempt))


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.beyin-update-')
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _safe_replace(temporary, path)
        try:
            fd = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
        except OSError:
            pass
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def encode(data):
    return base64.b64encode(data).decode() if data is not None else None


def decode(data):
    return base64.b64decode(data) if data is not None else None


def jbytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def unchanged(actual, *expected):
    """Managed files are UTF-8 text, so a CRLF rewrite by git autocrlf or an editor is not an edit."""
    return any(actual == value or (actual is not None and value is not None and
                                   actual.replace(b'\r\n', b'\n') == value.replace(b'\r\n', b'\n'))
               for value in expected)


def roots(vault, state):
    vault, state = Path(vault).resolve(), Path(state).resolve()
    if not vault.is_dir() or state.is_relative_to(vault):
        raise ValueError('existing vault and dedicated external state required')
    return vault, state


def current_version(vault):
    path = vault / '.beyin-version'
    value = path.read_text(encoding='utf-8').strip() if path.exists() else '0.0.0'
    version(value)
    return value


def validate_package(package):
    with zipfile.ZipFile(package) as archive:
        infos = archive.infolist()
        names = [entry.filename for entry in infos]
        if len(names) != len(set(names)) or sum(i.file_size for i in infos) > MAX_PACKAGE:
            raise ValueError('duplicate or oversized package')
        for entry in infos:
            name = entry.filename
            if name != 'manifest.json' and not allowed(name):
                raise ValueError('package path outside allowlist')
            if PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or '\\' in name or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('unsafe archive entry')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('schema') != 1 or manifest.get('runtime_schema', 1) != 1 or not isinstance(manifest.get('files'), dict):
            raise ValueError('unsupported package schema')
        version(manifest.get('version'))
        if manifest.get('migrations', []) not in ([], ['v2-cutover']):
            raise ValueError('unsupported migration')
        legacy_skill_hashes = manifest.get('legacy_skill_hashes', {})
        if not isinstance(legacy_skill_hashes, dict) or any(
                name not in MANAGED_SKILL_PATHS or not isinstance(values, list) or
                not all(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) for value in values)
                for name, values in legacy_skill_hashes.items()):
            raise ValueError('invalid legacy skill hashes')
        minimum = manifest.get('min_python', '3.11')
        if not isinstance(minimum, str) or not re.fullmatch(r'\d+\.\d+', minimum) or tuple(map(int, minimum.split('.'))) > sys.version_info[:2]:
            raise failure('Bu Python (' + '.'.join(map(str, sys.version_info[:3])) + ') Cortex için çok eski; ' +
                          (minimum if isinstance(minimum, str) else '3.11') + ' ya da sonrası gerekir.', 'python_too_old')
        if set(names) != set(manifest['files']) | {'manifest.json'}:
            raise ValueError('manifest/archive file mismatch')
        files = {}
        for name, expected in manifest['files'].items():
            data = archive.read(name)
            if not isinstance(expected, str) or digest(data) != expected:
                raise ValueError('package checksum mismatch')
            files[name] = data
        required = {'scripts/install_v3.py', 'scripts/beyin_entry.py', 'scripts/beyin_v3.py', 'template/.claude/scripts/beyin_v3.py', 'template/.claude/scripts/beyin_v3_update.py'}
        if not required <= files.keys():
            raise ValueError('incomplete release package')
        return manifest, files


def _release_failure(exc):
    """A release lookup or download that failed, said as a sentence: its short code (`http_404`,
    `network_unavailable`) came out alone as the whole message before, and as a `code` the
    desktop app does not know."""
    reason = str(getattr(exc, 'code', '') or exc)
    if reason in ('network_unavailable', 'response_too_large', 'http_403', 'http_429') or reason.startswith('http_5'):
        return failure("GitHub'daki Cortex sürümlerine ulaşılamadı (" + reason + '); internet bağlantını denetleyip '
                       'biraz sonra yeniden dene.', 'network')
    return failure("GitHub'da kurulabilecek bir Cortex sürümü bulunamadı (" + reason + '); güncelleme şimdilik '
                   'yapılamıyor, biraz sonra yeniden dene.')


def _release():
    """The latest stable release's metadata and ETag, read before any package is downloaded."""
    import beyin_v3_releases as releases
    try:
        metadata, tag = releases.fetch_metadata()
    except releases.ReleaseError as exc:
        raise _release_failure(exc) from None
    if metadata is None: raise failure("GitHub'dan Cortex sürüm bilgisi alınamadı; biraz sonra yeniden dene.", 'network')
    return metadata, tag


def _download(directory, with_metadata=False, metadata=None, tag=None):
    import beyin_v3_releases as releases
    if metadata is None:
        metadata, tag = _release()
    try:
        data, _ = releases.request_bytes(metadata['asset_url'], MAX_PACKAGE)
    except releases.ReleaseError as exc:
        raise _release_failure(exc) from None
    if data is None or len(data) != metadata['asset_size']:
        raise ValueError('release asset size mismatch')
    actual = digest(data)
    expected = metadata['asset_sha256']
    if expected and actual != expected:
        raise ValueError('release asset checksum mismatch')
    if metadata['checksum_url']:
        try:
            checksum, _ = releases.request_bytes(metadata['checksum_url'], 1024)
        except releases.ReleaseError as exc:
            raise _release_failure(exc) from None
        try:
            line = checksum.decode('ascii').strip()
        except (AttributeError, UnicodeError):
            raise ValueError('invalid release checksum file') from None
        match = re.fullmatch(r'([a-f0-9]{64})  ' + re.escape(metadata['asset_name']), line)
        if not match or match[1] != actual:
            raise ValueError('release checksum file mismatch')
    elif not expected:
        raise ValueError('release package has no external checksum')
    path = Path(directory) / metadata['asset_name']
    path.write_bytes(data)
    if with_metadata:
        return path, metadata['version'], metadata, tag
    return path, metadata['version']


@contextmanager
def locked(vault, state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    connections = []
    try:
        # Use the same SQLite writer lock as participating runtime operations.
        for path in (state / 'update-lock.sqlite3', state / 'memory.sqlite3'):
            if path.name == 'memory.sqlite3':
                # The runtime creates its index on first sync; locking must not leave an empty
                # one behind. mode=rw never creates the file, and as_uri() escapes '#', '?' and
                # '%' in the state path: an unescaped URI opened another path, and a skipped
                # lock let runtime writers run during apply.
                if not path.is_file():
                    continue
                connection = sqlite3.connect(path.resolve().as_uri() + '?mode=rw', uri=True, timeout=5)
            else:
                connection = sqlite3.connect(path, timeout=5)
            connections.append(connection)
            connection.execute('BEGIN IMMEDIATE')
        yield
    except sqlite3.OperationalError as exc:
        raise failure("Cortex şu an başka bir işi bitiriyor (bir sohbetin hafızası yazılıyor olabilir); "
                      'birkaç saniye sonra yeniden dene.', 'updater_busy') from exc
    finally:
        for connection in reversed(connections): connection.close()


def _is_link(path):
    """A symlink, junction or other reparse point: a name that can lead out of its directory."""
    info = os.lstat(path)
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0))


def _contained(root, path):
    """Whether root/name stays inside root. update, recover and rollback all ask here.

    Resolve both sides at write time: a root resolved before it existed gains a Windows
    redirect (MSIX-virtualised AppData, junction) once created (#97). An MSIX package can
    also see AppData through a merged view that redirects the children but not the root:
    a directory that exists outside the package keeps its spelling, while files the package
    wrote resolve under Packages\\<id>\\LocalCache (#139). That redirect is not a link in the
    tree, so a diverging resolution is still accepted when the name is lexically below the
    root and nothing between the root and the target is a link. Links that leave still fail.
    """
    if path.resolve().is_relative_to(root.resolve()):
        return True
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False  # a drive or rooted name replaced the root while joining
    current = root
    for part in relative.parts:
        current = current / part
        try:
            if _is_link(current): return False
        except FileNotFoundError:
            return True  # nothing below a missing component exists, so nothing can lead away
        except OSError:
            return False
    return True


def _destination(vault, state, operation):
    root = vault if operation['scope'] == 'vault' else state
    name = operation['name']
    if Path(name).is_absolute() or '..' in Path(name).parts:
        raise ValueError('unsafe transaction path')
    path = root / name
    if not _contained(root, path):
        raise ValueError('transaction target escapes root')
    return path


def _runtime_health(state):
    path = state / 'memory.sqlite3'
    if not path.exists(): return
    connection = sqlite3.connect(path)
    try:
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('installed runtime database integrity check failed')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name, required in {'records': {'id','payload'}, 'receipts': {'id','payload'}, 'events': {'sequence','event_type','record_id','revision','record'}}.items():
            if name in tables:
                columns = {row[1] for row in connection.execute('PRAGMA table_info(' + name + ')')}
                if not required <= columns:
                    raise ValueError('installed runtime schema unsupported: ' + name)
    finally:
        connection.close()


def _blocks(text):
    return re.findall(re.escape(START) + r'.*?' + re.escape(END), text, re.S)


def _splice_block(base, current, target):
    """`current` with `base`'s managed block turned into `target`'s; None when that is no splice.

    The text outside the block is the person's. When only that text changed since `base`, the step
    the installer took from `base` to `target` - its block replaced in place, or appended after the
    text, or that append taken back - is taken again on the text as it is now (with LF line endings,
    as the installer writes them). A block edited by hand, or any other step, is not spliced."""
    try:
        b, c, t = (value.decode('utf-8').replace('\r\n', '\n') for value in (base, current, target))
    except (AttributeError, UnicodeError):
        return None
    ours, theirs, wanted = _blocks(b), _blocks(c), _blocks(t)
    if theirs != ours or len(ours) > 1 or len(wanted) > 1:
        return None
    if ours and wanted:
        start = c.index(ours[0])
        return (c[:start] + wanted[0] + c[start + len(ours[0]):]).encode('utf-8')
    if wanted and t == b.rstrip() + '\n\n' + wanted[0] + '\n':
        return (c.rstrip() + '\n\n' + wanted[0] + '\n').encode('utf-8')
    if ours and b == t.rstrip() + '\n\n' + ours[0] + '\n':
        start = c.index(ours[0])
        before, after = c[:start], c[start + len(ours[0]):]
        if before.endswith('\n\n') and after.startswith('\n'):
            return (before[:-2] + t[len(t.rstrip()):] + after[1:]).encode('utf-8')
    return None


def _managed_part_kept(name, data):
    """Whether a file whose managed part is one line still has it: CLAUDE.md's import of AGENTS.md
    (the file install creates holds nothing else), .codex/config.toml's `hooks = true`."""
    try:
        text = data.decode('utf-8')
    except UnicodeError:
        return False
    if name == 'CLAUDE.md':
        return bool(re.search(r'(?m)^@(?:\./)?AGENTS\.md\s*$', text))
    return name == '.codex/config.toml' and bool(re.search(r'(?m)^hooks\s*=\s*true\s*$', text))


def _user_region_merge(name, base, current, target):
    """`target` with what the person changed in `current` since `base`, for a file whose managed part
    sits among their own text or keys; None for any other file, or for an edit to the managed part."""
    if base is None or current is None or target is None:
        return None
    if name in BLOCK_FILES:
        spliced = _splice_block(base, current, target)
        if spliced is None and base == target and _managed_part_kept(name, current):
            # Left as it was by the update, with the import still in place: theirs as it is now.
            return current
        return spliced
    if name in JSON_REGION_FILES:
        try:
            return _merge_json(base, current, target)
        except (ValueError, TypeError, UnicodeError):
            return None
    if name == '.codex/config.toml' and base == target and _managed_part_kept(name, current):
        # Only `hooks = true` is the engine's here, and the update did not change the file.
        return current
    return None


def _rebase(state, journal, index, actual):
    """An update operation not applied yet whose file the person changed after it was planned.

    Recovery used to demand the bytes the journal saw before the interruption, so a permission
    granted in a chat (`.claude/settings.local.json`) or a line added to AGENTS.md in between made
    `recover` and `update` fail forever (install-update-6). For the user-region files the change is
    merged into the planned content instead, and the journal, with the installer's record that will
    describe the file, is rewritten before the file is: a recovery after this one finds the merged
    bytes already planned. Returns the merged bytes, or None where the change still conflicts."""
    operation = journal['operations'][index]
    if journal.get('direction') != 'update' or operation['scope'] != 'vault':
        return None
    merged = _user_region_merge(operation['name'], decode(operation['old']), actual, decode(operation['new']))
    if merged is None:
        return None
    operation['old'], operation['new'] = encode(actual), encode(merged)
    for record in journal['operations'][index + 1:]:
        if record['scope'] == 'state' and record['name'] == 'v3-install.json' and record['new'] is not None:
            manifest = json.loads(decode(record['new']))
            entry = manifest.get('files', {}).get(operation['name'])
            if isinstance(entry, dict):
                entry['installed_hash'] = digest(merged)
                entry['installed_content'] = encode(merged)
                record['new'] = encode(jbytes(manifest))
    atomic(state / 'update-journal.json', jbytes(journal))
    return merged


def _conflict(name, actual):
    return failure("Güncelleme durdu: Cortex'in yönettiği " + name + ' dosyası güncelleme sırasında ' +
                   ('silindi' if actual is None else 'değişti') + '; üzerine yazılmadı. O değişikliği geri alıp '
                   'yeniden dene ya da beyin.py rollback ile önceki sürüme dön.', 'update_conflict')


def _apply(vault, state, journal, migration=None):
    for index, operation in enumerate(journal['operations']):
        path = _destination(vault, state, operation)
        if operation['name'] == '.beyin-version':
            _runtime_health(state)
            for prior in journal['operations'][:index]:
                target = _destination(vault, state, prior)
                actual_prior = target.read_bytes() if target.exists() else None
                if actual_prior != decode(prior['new']):
                    raise _conflict(prior['name'], actual_prior)
            if migration is not None and journal['direction'] == 'update':
                migration[0].finalize_migration(vault, state, migration[1])
                marker = state / 'v2-migration.json'
                journal['migration_result'] = encode(marker.read_bytes()) if marker.exists() else None
                atomic(state / 'update-journal.json', jbytes(journal))
        before, after = decode(operation['old']), decode(operation['new'])
        actual = path.read_bytes() if path.exists() else None
        if actual != after:
            if actual != before:
                merged = _rebase(state, journal, index, actual)
                if merged is None:
                    raise _conflict(operation['name'], actual)
                before, after = actual, merged
            # Windows refuses to replace or delete a read-only file (WinError 5); POSIX does not.
            # Lift the flag for the replacement only and put it back below: a user who locked a
            # managed file keeps the lock, and rollback restores the recorded old mode anyway.
            read_only = path.exists() and not os.access(path, os.W_OK)
            if read_only:
                try:
                    path.chmod(stat.S_IWRITE | stat.S_IREAD)
                except OSError:
                    pass
            if after is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, after)
                if operation.get('new_mode') is not None: path.chmod(operation['new_mode'])
                if read_only:
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
        if path.exists() and operation.get('new_mode') is not None and os.access(path, os.W_OK):
            path.chmod(operation['new_mode'])
        if path.exists() and operation.get('new_mtime') is not None:
            os.utime(path, (operation['new_mtime'], operation['new_mtime']))
        transaction_hook('after_replace', index)
    if journal['direction'] == 'update':
        atomic(state / 'last-update.json', jbytes(journal))
    else:
        (state / 'last-update.json').unlink(missing_ok=True)
    (state / 'update-journal.json').unlink(missing_ok=True)


@contextmanager
def _migration_guard(vault, state, directory, carried=None):
    """The cutover guard of the package's own migration module, its plan taken now.

    A recovery passes the plan its journal recorded (`carried`). Only what that install decided is
    kept from it - the runners the person chose to keep, and what it reported as left behind by
    V2; the proof itself is taken again from the vault as it is now, under the V2 writer locks this
    guard holds for the whole recovery. Replaying the old inventory made a note edited during the
    install, or after an interruption, fail every retry with "source or legacy state changed"
    (install-update-6)."""
    module_path = directory / 'beyin_v3_migrate.py'
    if not module_path.exists():
        yield None
        return
    sys.path.insert(0, str(directory))
    try:
        spec = importlib.util.spec_from_file_location('beyin_update_migration', module_path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with module.migration_guard(vault, state) as current:
            if isinstance(carried, dict):
                if 'kept_legacy' in carried:
                    current['kept_legacy'] = carried['kept_legacy']
                else:
                    current.pop('kept_legacy', None)
                for key in ('orphaned_legacy_state', 'stale_legacy_locks'):
                    found = set(carried.get(key) or []) | set(current.get(key) or [])
                    if found:
                        current[key] = sorted(found)
            yield module, current
    finally:
        sys.path.remove(str(directory))


def _recover_locked(vault, state):
    path = state / 'update-journal.json'
    if not path.exists(): return {'status': 'noop', 'version': current_version(vault)}
    journal = json.loads(path.read_text(encoding='utf-8'))
    if journal.get('vault') != str(vault):
        raise failure('Yarım kalan güncellemenin kaydı başka bir klasördeki kasaya ait (' + str(journal.get('vault')) +
                      '); kasa taşındıysa önce bu kasada beyin.py relocate çalıştır.', 'vault_moved')
    with tempfile.TemporaryDirectory(prefix='beyin-recover-') as temporary:
        directory = Path(temporary)
        for operation in journal['operations']:
            if operation['scope'] == 'vault' and operation['name'].startswith('.claude/scripts/') and operation['name'].endswith('.py') and operation['new']:
                (directory / Path(operation['name']).name).write_bytes(decode(operation['new']))
        with _migration_guard(vault, state, directory, journal.get('migration_plan')) as migration:
            _apply(vault, state, journal, migration)
            try:
                (state / 'release-cache.json').unlink(missing_ok=True)
            except Exception:
                pass
    return {'status': 'recovered', 'version': current_version(vault)}


def recover(vault, state):
    vault, state = roots(vault, state)
    with locked(vault, state): return _recover_locked(vault, state)


def _preflight(stage, files):
    for name, data in files.items():
        if name.endswith('.py'):
            compile(data, name, 'exec')
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    test_vault, test_state = stage.parent / 'probe-vault', stage.parent / 'probe-state'
    test_vault.mkdir()
    (test_vault / 'proof.md').write_text('---\n{"id":"release-probe","kind":"fact","status":"active"}\n---\nsynthetic checksum verification\n', encoding='utf-8')
    receipt = stage.parent / 'probe-receipt.json'
    receipt.write_text(json.dumps({'event_id':'release-probe','summary':'Synthetic release validation','refs':['proof.md']}), encoding='utf-8')
    environment = os.environ.copy()
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    for command in (['init'], ['sync'], ['context','checksum'], ['receipt','--file',str(receipt)]):
        result = subprocess.run([sys.executable,str(stage/'scripts/beyin_v3.py'),'--vault',str(test_vault),'--state',str(test_state)]+command,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=environment)
        if result.returncode:
            raise ValueError('release synthetic runtime preflight failed: ' + command[0])
        try: payload = json.loads(result.stdout)
        except ValueError as exc: raise ValueError('release preflight returned invalid result') from exc
        if command[0] == 'context' and not payload.get('records'):
            raise ValueError('release preflight could not retrieve source')
        if command[0] in ('sync','receipt') and payload.get('status') != 'succeeded':
            raise ValueError('release preflight did not succeed')


def _installed_name(packaged):
    """Where the installer writes a package file in the vault (install_v3 `add`); None for its own files."""
    if packaged == 'scripts/beyin_entry.py':
        return 'beyin.py'
    if packaged == 'scripts/beyin_v3.py':
        return '.claude/scripts/beyin_v3_cli.py'
    if re.fullmatch(r'template/\.claude/scripts/beyin_v3[a-z_]*\.py', packaged):
        return '.claude/scripts/' + packaged.rsplit('/', 1)[1]
    if re.fullmatch(r'template/\.agents/skills/[a-z-]+/SKILL\.md', packaged):
        return packaged[len('template/'):]
    return None


def _refresh_needed(state, files):
    """Whether a package of the installed version carries other code than the installer last wrote.

    Builds of one version that differ (several 1.0.32s went to testers) were a 'noop' here, so a
    fix shipped under an unchanged VERSION never reached a vault (install-update-1). The package's
    files are held to the installer's own record of what it wrote (`installed_hash`), not to the
    files as they are now: a script edited by hand is no reason to refresh, and an update over it
    would only stop at its conflict. A file the record does not list (an excluded skill) is skipped."""
    try:
        installed = json.loads((state / 'v3-install.json').read_text(encoding='utf-8')).get('files', {})
    except (OSError, ValueError, AttributeError):
        return False
    for name, data in files.items():
        there = _installed_name(name)
        entry = installed.get(there) if there and isinstance(installed, dict) else None
        if isinstance(entry, dict) and entry.get('installed_hash') != digest(data):
            return True
    return False


def _refresh_theme(vault):
    """The Ananas snippet brought to the release just written, where the person installed it
    (misc-scripts-5). The vault's own theme module is loaded - the one this update wrote - and only
    when a snippet is there, so most updates never read its 580 KB of data. A failure here is never
    the update's: the theme stays as it was and `beyin.py tema yenile` can be run by hand."""
    directory = vault / '.claude/scripts'
    if not (vault / '.obsidian/snippets/ananas.css').is_file() or not (directory / 'beyin_v3_tema.py').is_file():
        return None
    sys.path.insert(0, str(directory))
    # The data module the theme imports is this release's, not one an earlier import left behind.
    sys.modules.pop('beyin_v3_tema_veri', None)
    try:
        spec = importlib.util.spec_from_file_location('beyin_update_tema', directory / 'beyin_v3_tema.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        refresh = getattr(module, 'refresh', None)
        return refresh(vault).get('status') if refresh else None
    except Exception:
        return None
    finally:
        sys.path.remove(str(directory))
        sys.modules.pop('beyin_v3_tema_veri', None)


def _older(old, new):
    return failure('Bu paket (' + new + ') kurulu Cortex sürümünden (' + old + ') eski; kurulu sürüm korundu. '
                   'Önceki sürüme dönmek istiyorsan beyin.py rollback kullanılır.')


def update(vault, state, package=None, check=False):
    vault, state = roots(vault, state)
    with tempfile.TemporaryDirectory(prefix='beyin-release-') as temporary:
        expected = None
        release_meta = None
        release_tag = None
        if package is None:
            release_meta, release_tag = _release()
            # An engine ahead of the latest stable release (one the desktop app brought before its
            # release was published) is as it should be: nothing is downloaded, and no error reads
            # like advice to roll back the newer engine (install-update-9).
            installed = current_version(vault)
            if version(release_meta['version']) < version(installed):
                return {'status': 'ahead', 'current_version': installed, 'version': release_meta['version']}
            package, expected = _download(temporary, metadata=release_meta, tag=release_tag)
        manifest, files = validate_package(package)
        if expected and manifest['version'] != expected: raise ValueError('release tag/package mismatch')
        old, new = current_version(vault), manifest['version']
        if version(new) < version(old):
            if check: return {'status': 'ahead', 'current_version': old, 'version': new}
            raise _older(old, new)
        stage = Path(temporary) / 'package'
        _preflight(stage, files)
        if check:
            if new != old:
                return {'status': 'available', 'current_version': old, 'version': new}
            if _refresh_needed(state, files):
                return {'status': 'available', 'current_version': old, 'version': new, 'refresh': True}
            return {'status': 'noop', 'current_version': old, 'version': new}
        with locked(vault, state):
            _recover_locked(vault, state)
            old = current_version(vault)
            if version(new) < version(old):
                raise _older(old, new)
            # The same version with other code is written like an update: the plan rewrites only the
            # files that differ, under the same journal, and rollback can take it back.
            refresh = new == old
            if refresh and not _refresh_needed(state, files):
                return {'status': 'noop', 'version': old}
            with _migration_guard(vault, state, stage / 'template/.claude/scripts') as migration:
                spec = importlib.util.spec_from_file_location('beyin_release_installer', stage / 'scripts/install_v3.py')
                installer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(installer)
                plan = installer.install(vault, state, plan_only=True, version=new,
                                         legacy_hashes=manifest.get('legacy_hashes', {}),
                                         legacy_skill_hashes=manifest.get('legacy_skill_hashes', {}))
                trust_review = False
                for name in ('.claude/settings.local.json', '.codex/hooks.json', '.agents/hooks.json',
                             '.kiro/hooks/beyin-v3.json'):
                    if name in plan['planned']:
                        path = vault / name
                        before = json.loads(path.read_bytes()) if path.exists() else {}
                        planned = plan['planned'][name]
                        after = json.loads(planned) if planned is not None else {}
                        key = 'beyin-v3' if name == '.agents/hooks.json' else 'hooks'
                        trust_review = trust_review or before.get(key) != after.get(key)
                operations = []
                for name, data in plan['planned'].items():
                    if name == '.beyin-version': continue
                    path = vault / name
                    previous = path.read_bytes() if path.exists() else None
                    operations.append({'scope': 'vault', 'name': name, 'old': encode(previous), 'new': encode(data), 'old_mode': stat.S_IMODE(path.stat().st_mode) if path.exists() else None, 'old_mtime': path.stat().st_mtime if path.exists() else None, 'new_mode': plan.get('modes', {}).get(name, 0o644)})
                path = state / 'v3-install.json'
                operations.append({'scope': 'state', 'name': 'v3-install.json', 'old': encode(path.read_bytes() if path.exists() else None), 'new': encode(jbytes(plan['manifest']))})
                path = vault / '.beyin-version'
                operations.append({'scope': 'vault', 'name': '.beyin-version', 'old': encode(path.read_bytes() if path.exists() else None), 'new': encode((new + '\n').encode())})
                journal = {'schema': 1, 'vault': str(vault), 'direction': 'update', 'from_version': old, 'to_version': new, 'operations': operations, 'migration_plan': migration[1] if migration else None, 'migration_backup': encode((state/'v2-migration.json').read_bytes() if (state/'v2-migration.json').exists() else None)}
                atomic(state / 'update-journal.json', jbytes(journal))
                _apply(vault, state, journal, migration)
                try:
                    import beyin_v3_releases as releases
                    if release_meta is not None:
                        now = time.time()
                        releases.atomic_json(state / 'release-cache.json', {
                            'schema': 1,
                            'checked_at': now,
                            'attempted_at': now,
                            'next_check_at': now + 86400,
                            'etag': release_tag,
                            'release': release_meta,
                            'failures': 0,
                        })
                    else:
                        (state / 'release-cache.json').unlink(missing_ok=True)
                except Exception:
                    pass
        result = {'status': 'refreshed' if refresh else 'updated', 'from_version': old, 'version': new,
                  'trust_review_required': trust_review}
        if _refresh_theme(vault) == 'yenilendi':
            result['theme'] = 'yenilendi'

        if plan.get('removed'):
            result['removed'] = plan['removed']
        if plan.get('preserved_excluded'):
            result['preserved_excluded'] = plan['preserved_excluded']
        if plan.get('manifest', {}).get('excluded_components'):
            result['excluded_components'] = plan['manifest']['excluded_components']
        # A kept V2 flush that died mid-summary: the guard let its sentinel through on proof,
        # but nothing else would ever tell the user that session's summary is missing. Sentinels
        # the cutover receipt already lists were reported by that install and never change again
        # once the flush is retired, so repeating them here would follow every update forever.
        # The same goes for a prompt-counter lock directory the guard read as stale.
        for key in ('orphaned_legacy_state', 'stale_legacy_locks'):
            if migration and migration[1].get(key):
                receipt = migration[1].get('previous')
                reported = set(receipt.get(key) or []) if isinstance(receipt, dict) else set()
                later = [name for name in migration[1][key] if name not in reported]
                if later:
                    result[key] = later
        return result


def _merge_json(base, current, target):
    absent = object()
    def merge(b, c, t):
        if c == b: return t
        if t == b: return c
        if c == t: return c
        if all(isinstance(v, dict) for v in (b, c, t)):
            result = {}
            for key in b.keys() | c.keys() | t.keys():
                value = merge(b.get(key, absent), c.get(key, absent), t.get(key, absent))
                if value is not absent: result[key] = value
            return result
        raise ValueError('overlapping configuration edit')
    return jbytes(merge(json.loads(base), json.loads(current), json.loads(target)))


def rollback(vault, state):
    vault, state = roots(vault, state)
    with locked(vault, state):
        pending = state / 'update-journal.json'
        backup = pending if pending.exists() else state / 'last-update.json'
        if not backup.exists():
            raise failure('Geri alınacak bir güncelleme yedeği yok: Cortex bu kasada henüz güncellenmedi ya da son '
                          'güncelleme zaten geri alındı.')
        original = json.loads(backup.read_text(encoding='utf-8'))
        if original.get('vault') != str(vault):
            raise failure('Güncelleme yedeği başka bir klasördeki kasaya ait (' + str(original.get('vault')) +
                          '); kasa taşındıysa önce bu kasada beyin.py relocate çalıştır.', 'vault_moved')
        # A pending rollback already contains the intended restore direction.
        # Reversing it again would restore the upgrade instead of finishing rollback.
        if pending.exists() and original.get('direction') == 'rollback':
            _apply(vault, state, original)
            return {'status': 'rolled_back' if (vault/'.beyin-version').exists() else 'uninstalled', 'version': current_version(vault) if (vault/'.beyin-version').exists() else None}
        operations = []
        for item in original['operations']:
            path = _destination(vault, state, item)
            actual = path.read_bytes() if path.exists() else None
            restore = decode(item['old'])
            # Optional note templates become user data as soon as they are seeded.
            # Preserve edits (and deletions) through rollback just like companion notes.
            if item.get('scope') == 'vault' and item['name'] == '📋 Templates/Kisi.md':
                restore = actual
            if not unchanged(actual, decode(item['new']), restore):
                # What the person added since the update outside the managed part (a line in
                # CLAUDE.md, a Gemini setting) stays: only that part goes back (install-update-7).
                merged = (_user_region_merge(item['name'], decode(item['new']), actual, restore)
                          if item.get('scope') == 'vault' else None)
                if merged is None:
                    raise failure('Geri alma durdu: Cortex\'in yönettiği ' + item['name'] + ' dosyası güncellemeden sonra ' +
                                  ('silinmiş' if actual is None else 'değiştirilmiş') + '; üzerine yazılmadı.',
                                  'rollback_conflict')
                restore = merged
            operations.append(dict(item, old=encode(actual), new=encode(restore), old_mode=item.get('new_mode'), new_mode=item.get('old_mode'),
                                   # A merged settings file holds edits made after the update: keep its new mtime.
                                   new_mtime=item.get('old_mtime') if restore == decode(item['old']) else None))
        if 'migration_result' in original:
            marker = state / 'v2-migration.json'
            actual = marker.read_bytes() if marker.exists() else None
            if actual != decode(original['migration_result']):
                raise failure('Geri alma durdu: V2 geçiş kaydı (v2-migration.json) güncellemeden sonra değişmiş; '
                              'üzerine yazılmadı.', 'rollback_conflict')
            operations.append({'scope':'state','name':'v2-migration.json','old':encode(actual),'new':original.get('migration_backup')})
        operations.sort(key=lambda item: item['name'] == '.beyin-version')
        journal = {'schema': 1, 'vault': str(vault), 'direction': 'rollback', 'operations': operations}
        atomic(pending, jbytes(journal))
        _apply(vault, state, journal)
        try:
            (state / 'release-cache.json').unlink(missing_ok=True)
        except Exception:
            pass
        return {'status': 'rolled_back' if (vault/'.beyin-version').exists() else 'uninstalled', 'version': current_version(vault) if (vault/'.beyin-version').exists() else None}
