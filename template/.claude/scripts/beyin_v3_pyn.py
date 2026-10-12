"""pyn: open Pyn (this vault's companion) in the AI client you pick, from any folder.

`beyin.py pyn` lists the clients installed on this machine, remembers the last choice and
starts the chosen one inside the vault, so its instructions and memory load. `pyn kur` adds a
one-word `pyn` command to the user's shell profile; `pyn kaldir` removes it.

Memory, honestly labelled:
- tam (full): hooks load Pyn's memory into every turn (Claude Code, Codex, OpenCode, OMP, and
  Gemini CLI and Qwen Code once the vault's install has written their hooks).
- talimat (instructions): the client reads AGENTS.md and loads the companion files itself;
  no per-turn retrieval and no receipt reminders (Cursor Agent).

Local models run through OpenCode when it is installed, otherwise through Codex (`--oss`); both
keep full memory. OpenCode only knows the LM Studio models in its catalog, so the model that runs
is declared for that one launch in OPENCODE_CONFIG_CONTENT: nothing is written to the synced
vault, where a desktop and a laptop with different models would overwrite each other.
Ollama and LM Studio are found only by asking servers that are already running: no command is
run that could start one. No network beyond 127.0.0.1, no model call, standard library only.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

LAST = 'pyn-son.json'
CONTEXT_FILE = 'AGENTS.md'

# id, display name, executables (first found wins), memory, note,
# and for instruction clients the project settings that make them read AGENTS.md.
CLIENTS = (
    {'id': 'claude', 'ad': 'Claude Code', 'komut': ('claude',), 'hafiza': 'tam'},
    {'id': 'codex', 'ad': 'Codex', 'komut': ('codex',), 'hafiza': 'tam'},
    {'id': 'opencode', 'ad': 'OpenCode', 'komut': ('opencode',), 'hafiza': 'tam',
     'not': 'z.ai, OpenCode Go ve yerel modeller', 'kur': 'npm i -g opencode-ai'},
    {'id': 'omp', 'ad': 'Oh My Pi', 'komut': ('omp',), 'hafiza': 'tam'},
    {'id': 'gemini', 'ad': 'Gemini CLI', 'komut': ('gemini',), 'hafiza': 'talimat',
     'ayar': '.gemini/settings.json', 'varsayilan': 'GEMINI.md'},
    {'id': 'qwen', 'ad': 'Qwen Code', 'komut': ('qwen',), 'hafiza': 'talimat',
     'ayar': '.qwen/settings.json', 'varsayilan': 'QWEN.md'},
    {'id': 'cursor', 'ad': 'Cursor Agent', 'komut': ('cursor-agent',), 'hafiza': 'talimat'},
)

EMBEDDING = ('embed', 'bge-', 'e5-', 'minilm', 'nomic-bert')


def _chat_model(name, family=''):
    """Embedding models answer no prompt: a coding client opened on one would only fail."""
    text = (name + ' ' + (family or '')).casefold()
    return family not in ('bert', 'nomic-bert') and not any(mark in text for mark in EMBEDDING)


def _get(url, timeout=0.4):
    """JSON from a local server that is already up, or None when nothing answers.

    Only an HTTP request to 127.0.0.1: unlike `ollama list`, it can never start a server.
    """
    import urllib.error
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as response:
            return json.loads(response.read(2_000_000))
    except urllib.error.HTTPError as exc:
        exc.close()  # an answering server without this endpoint (an older version)
        return None
    except Exception:
        return None


def _context_lengths(models, field):
    """{model: tokens} for loaded models whose server reports the context they were loaded with."""
    return {m['id']: m[field] for m in models if isinstance(m.get(field), int) and m[field] > 0}


def ollama_models(get=_get, base='http://127.0.0.1:11434'):
    """(downloaded chat models, models in memory right now, their context lengths)."""
    tags = get(base + '/api/tags')
    if not isinstance(tags, dict):
        return [], [], {}
    downloaded = [m['name'] for m in tags.get('models', []) if isinstance(m.get('name'), str)
                  and _chat_model(m['name'], (m.get('details') or {}).get('family', ''))]
    running = [m for m in (get(base + '/api/ps') or {}).get('models', []) if m.get('name') in downloaded]
    contexts = _context_lengths([dict(m, id=m['name']) for m in running], 'context_length')
    return downloaded, [m['name'] for m in running], contexts


def lmstudio_models(get=_get, base='http://127.0.0.1:1234'):
    """(downloaded chat models, models loaded in LM Studio right now, their context lengths)."""
    rich = get(base + '/api/v0/models')  # says which model is loaded and which are embeddings
    if isinstance(rich, dict):
        models = [m for m in rich.get('data', []) if isinstance(m.get('id'), str) and m.get('type') in ('llm', 'vlm')]
        loaded = [m for m in models if m.get('state') == 'loaded']
        return [m['id'] for m in models], [m['id'] for m in loaded], _context_lengths(loaded, 'loaded_context_length')
    plain = get(base + '/v1/models')  # an older server: names only, no load state
    if not isinstance(plain, dict):
        return [], [], {}
    return [m['id'] for m in plain.get('data', []) if isinstance(m.get('id'), str) and _chat_model(m['id'])], [], {}


# Local model servers: (provider, display name, discovery).
LOCAL = (('ollama', 'Ollama', ollama_models), ('lmstudio', 'LM Studio', lmstudio_models))
LOCAL_TOOLS = {'ollama': ('ollama',), 'lmstudio': ('lms',)}

# The client that opens local models: OpenCode when installed (its own LM Studio provider, any
# OpenAI-compatible server), else Codex --oss.
LOCAL_RUNNERS = ('opencode', 'codex')

# OpenCode's system prompt and tools plus Pyn's session context take well over 8K tokens. A model
# loaded with less fails the request or loses the memory; LM Studio often loads at 4096.
MIN_CONTEXT = 32768

# OpenCode provider for each local server, declared for one launch only.
OPENCODE_LOCAL = {
    'lmstudio': {},  # built in; only the model is missing from its catalog
    'ollama': {'npm': '@ai-sdk/openai-compatible', 'name': 'Ollama (yerel)',
               'options': {'baseURL': 'http://127.0.0.1:11434/v1'}},
}

MEMORY_LABEL = {'tam': 'tam hafıza', 'talimat': 'hafıza talimatla (AGENTS.md)'}


def hooked(vault, option):
    """True when this vault's install wired the client's hooks (Gemini CLI, Qwen Code since 1.0.4)."""
    if vault is None or not option.get('ayar'):
        return False
    try:
        text = (Path(vault) / option['ayar']).read_text(encoding='utf-8')
    except OSError:
        return False
    return 'beyin_v3_hook.py' in text or 'cortex-pyn' in text


def options(clients=CLIENTS, local=LOCAL, which=shutil.which, vault=None):
    """Everything `pyn` can open on this machine, in menu order, and hints for what is missing."""
    found, hints = [], []
    for client in clients:
        path = next((p for p in (which(name) for name in client['komut']) if p), None)
        if path:
            option = dict(client, yol=path, args=[])
            if hooked(vault, option):
                option['hafiza'] = 'tam'  # the hooks load memory every turn, as for Claude and Codex
            found.append(option)
        elif client.get('kur'):
            hints.append(client['ad'] + ': kurulu değil, kurmak için ' + client['kur'])
    runner = next((option for wanted in LOCAL_RUNNERS for option in found if option['id'] == wanted), None)
    for provider, name, discover in local:
        downloaded, loaded, *rest = discover() if runner else ([], [])
        if downloaded:
            args = [] if runner['id'] == 'opencode' else ['--oss', '--local-provider', provider]
            found.append(dict(runner, id=runner['id'] + '-' + provider, ad=runner['ad'] + ' · yerel (' + name + ')',
                              istemci=runner['ad'], yerel=name, saglayici=provider, args=args,
                              modeller=downloaded, yuklu=loaded, baglam=rest[0] if rest else {}))
        elif runner and any(which(tool) for tool in LOCAL_TOOLS.get(provider, ())):
            # "Name: what is missing"; the menu aligns the names in a column.
            hints.append(name + ': sunucu kapalı ya da yüklü model yok, model açınca burada görünür')
    return found, hints


def local_model(option, last):
    """The model that runs, without asking whenever the machine already says which one.

    Loaded right now (LM Studio's loaded model, Ollama's model in memory) first; then the last
    one used on this machine; then the only one downloaded. None: several downloaded, none
    loaded, nothing remembered here, so ask once. "Last used" lives in this machine's state,
    never in the synced vault: a desktop and a laptop keep their own models.
    """
    loaded, downloaded = option.get('yuklu') or [], option.get('modeller') or []
    remembered = (last.get('modeller') or {}).get(option.get('saglayici'))
    if loaded:
        return remembered if remembered in loaded else loaded[0]
    if remembered in downloaded:
        return remembered
    return downloaded[0] if len(downloaded) == 1 else None


def _merge(base, extra):
    merged = dict(base)
    for key, value in extra.items():
        merged[key] = _merge(merged[key], value) if isinstance(value, dict) and isinstance(merged.get(key), dict) else value
    return merged


def local_launch(option, model, environ=None):
    """(client arguments, environment or None, warning or None) for running `model` locally."""
    tokens = (option.get('baglam') or {}).get(model)
    warning = None
    if tokens and tokens < MIN_CONTEXT:
        warning = (option['yerel'] + ' bu modeli ' + str(tokens) + ' token bağlamla yüklemiş; Pyn\'in hafızası ve '
                   + option['istemci'] + ' için en az ' + str(MIN_CONTEXT) + ' gerekir. Modeli ' + option['yerel']
                   + '\'da daha uzun bağlamla (Context Length) yeniden yükle, yoksa hafıza kesilebilir.')
    if option['id'] != 'opencode-' + option['saglayici']:
        return option['args'] + ['-m', model], None, warning
    entry = {'name': model + ' (' + option['yerel'] + ')'}
    if tokens:  # OpenCode compacts the session before the loaded context overflows
        entry['limit'] = {'context': tokens, 'output': min(tokens // 4, 16384)}
    declared = {'provider': {option['saglayici']: dict(OPENCODE_LOCAL[option['saglayici']], models={model: entry})}}
    environ = os.environ if environ is None else environ
    try:  # a value the user set themselves is kept and extended, never replaced
        own = json.loads(environ.get('OPENCODE_CONFIG_CONTENT') or '{}')
    except ValueError:
        own = {}
    content = _merge(own if isinstance(own, dict) else {}, declared)
    env = dict(environ, OPENCODE_CONFIG_CONTENT=json.dumps(content, ensure_ascii=False))
    return option['args'] + ['-m', option['saglayici'] + '/' + model], env, warning


def _last(state):
    try:
        data = json.loads((Path(state) / LAST).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _remember(state, choice, model=None):
    path = Path(state) / LAST
    data = _last(state)
    data['secim'] = choice['id']
    if model and choice.get('saglayici'):
        data.setdefault('modeller', {})[choice['saglayici']] = model
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')


def by_id(found, wanted):
    """The option with this id. A local model id names its server, not its client: before 1.0.5
    `codex-lmstudio` was the only one, and with OpenCode installed it is `opencode-lmstudio`, so
    a remembered choice or an old shortcut finds the same server under either client."""
    for option in found:
        if option['id'] == wanted:
            return option
    client, _, provider = (wanted or '').partition('-')
    if client in LOCAL_RUNNERS and provider:
        return next((option for option in found if option.get('saglayici') == provider), None)
    return None


def pick(found, answer, default):
    """Match a menu answer: empty (the default), a number, an id or the start of a name."""
    answer = (answer or '').strip().casefold()
    if not answer:
        return default
    if answer.isdigit() and 1 <= int(answer) <= len(found):
        return found[int(answer) - 1]
    if by_id(found, answer):
        return by_id(found, answer)
    matches = [option for option in found if option['ad'].casefold().startswith(answer)]
    return matches[0] if len(matches) == 1 else None


def ensure_context(vault, option):
    """Make an instruction client read AGENTS.md too; other settings stay as they are."""
    if not option.get('ayar'):
        return None
    path = Path(vault) / option['ayar']
    try:
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    except ValueError:
        return 'okunamadı'  # a settings file we cannot parse is the user's; never rewritten
    context = data.get('context', {}) if isinstance(data, dict) else None
    if not isinstance(context, dict):
        return 'okunamadı'
    names = context.get('fileName')
    names = [names] if isinstance(names, str) else list(names) if isinstance(names, list) else [option['varsayilan']]
    if CONTEXT_FILE in names:
        return 'hazir'
    context['fileName'] = [CONTEXT_FILE] + names
    data['context'] = context
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 'yazildi'


def launch(vault, option, extra, run=subprocess.call):
    """Run the client in the vault and return its exit code; Ctrl+C belongs to the client."""
    import signal
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        if option.get('env'):
            return run([option['yol'], *option['args'], *extra], cwd=str(vault), env=option['env'])
        return run([option['yol'], *option['args'], *extra], cwd=str(vault))
    finally:
        signal.signal(signal.SIGINT, previous)


def _ask(prompt, read=input):
    try:
        return read(prompt)
    except (EOFError, KeyboardInterrupt):
        return None


# ---------------------------------------------------------------- welcome box

GOLD, BOLD, DIM, RESET = '\x1b[38;2;232;178;58m', '\x1b[1m', '\x1b[2m', '\x1b[0m'
# The Sixel seal is 120 px; Windows Terminal draws Sixel on a 10x20 px virtual cell.
LOGO_COLUMNS, LOGO_ROWS = 12, 6
LEFT_WIDTH = 34
GREETING = 'Bugün neyi düşünelim?'


def _device_attributes(timeout=0.4):
    """The terminal's answer to DA1 (ESC [ c), or '' when it does not answer in time.

    Asked rather than guessed from the environment: Windows Terminal opened as the default
    terminal (cmd from the Start menu) sets no WT_SESSION, yet draws Sixel.
    """
    import time
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return ''
    answer, deadline = '', time.monotonic() + timeout
    if os.name == 'nt':
        try:
            import ctypes
            import msvcrt
            kernel = ctypes.windll.kernel32
            handle, mode = kernel.GetStdHandle(-10), ctypes.c_uint32()
            if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
                return ''
            # Replies arrive as input only with VT input on; no echo, no waiting for Enter.
            kernel.SetConsoleMode(handle, (mode.value | 0x0200) & ~0x0006)
        except (AttributeError, OSError, ImportError):
            return ''
        try:
            sys.stdout.write('\x1b[c')
            sys.stdout.flush()
            while time.monotonic() < deadline and not answer.endswith('c'):
                if msvcrt.kbhit():
                    answer += msvcrt.getwch()
                else:
                    time.sleep(0.01)
        finally:
            kernel.SetConsoleMode(handle, mode.value)
        return answer
    try:
        import select
        import termios
        import tty
    except ImportError:
        return ''
    try:
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
    except (OSError, termios.error):
        return ''
    try:
        tty.setcbreak(fd)
        sys.stdout.write('\x1b[c')
        sys.stdout.flush()
        while time.monotonic() < deadline and not answer.endswith('c'):
            ready, _, _ = select.select([fd], [], [], max(deadline - time.monotonic(), 0))
            if not ready:
                break
            answer += os.read(fd, 64).decode('ascii', 'replace')
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    return answer


def sixel_terminal(environ=None, ask=_device_attributes):
    """True where the terminal draws Sixel images: it lists 4 in its DA1 answer. `PYN_LOGO=0`
    turns the image off, `PYN_LOGO=1` forces it."""
    environ = os.environ if environ is None else environ
    if environ.get('PYN_LOGO') in ('0', '1'):
        return environ['PYN_LOGO'] == '1'
    found = re.search(r'\x1b\[\?([\d;]*)c', ask() or '')
    if found:
        return '4' in found.group(1).split(';')
    return bool(environ.get('WT_SESSION')) or environ.get('TERM_PROGRAM') in ('WezTerm', 'iTerm.app')


def _sixel_seal():
    try:
        import base64
        import beyin_v3_marka as marka
        return base64.b64decode(''.join(marka.SIXEL)).decode('ascii')
    except (ImportError, AttributeError, ValueError):
        return None


def _companion_file(vault, name):
    try:
        return next(Path(vault).glob('*/' + name), None)
    except OSError:
        return None


def _last_session(vault):
    """The latest session card's heading without its session id: 'date · label'."""
    path = _companion_file(vault, 'Last-Session.md')
    try:
        text = path.read_text(encoding='utf-8') if path else ''
    except (OSError, UnicodeDecodeError):
        return None
    heading = next((line[3:].strip() for line in text.splitlines() if line.startswith('## ')), None)
    return re.sub(r'\s*·\s*[0-9a-f]{8}$', '', heading) if heading else None


def _cut(text, width):
    return text if len(text) <= width else text[:max(width - 1, 0)] + '…'


def welcome_box(vault, columns, logo=False):
    """(lines of the box, (row, column) where the seal goes or None). Claude Code's welcome
    box is the model: greeting and seal on the left, last session and tips on the right."""
    vault = Path(vault)
    try:
        version = (vault / '.beyin-version').read_text(encoding='utf-8').strip()
    except OSError:
        version = ''
    width = max(64, min(columns, 104))
    right_width = width - LEFT_WIDTH - 4  # borders, divider and a margin on each side
    text_width = right_width - 1
    home = str(Path.home())
    place = '~' + str(vault)[len(home):] if str(vault).startswith(home) else str(vault)

    left = [('', ''), (GREETING, BOLD), ('', '')]
    logo_row = len(left) + 1 if logo else None
    left += [('', '')] * LOGO_ROWS + [('', '')] if logo else []
    left += [('ikinci beynin hazır', DIM), (_cut(place, LEFT_WIDTH - 2), DIM)]
    right = [('', ''), ('Son oturum', GOLD + BOLD), (_cut(_last_session(vault) or 'Henüz kayıt yok', text_width), ''),
             ('─' * text_width, GOLD), ('İpuçları', GOLD + BOLD),
             (_cut('pyn 1 ya da pyn claude: menüsüz aç', text_width), ''),
             (_cut('pyn liste: bulunan istemciler', text_width), ''),
             (_cut('pyn kaldir: komutu kaldır', text_width), '')]
    rows = max(len(left), len(right))
    left += [('', '')] * (rows - len(left))
    right += [('', '')] * (rows - len(right))

    def cell(text, style, size, center=False):
        padded = text.center(size) if center else ' ' + text.ljust(size - 1)
        return style + padded + RESET if style else padded

    title = ' Pyn' + (' · Cortex ' + version if version else '') + ' '
    lines = [GOLD + '╭───' + RESET + BOLD + title + RESET + GOLD + '─' * (width - 5 - len(title)) + '╮' + RESET]
    for (ltext, lstyle), (rtext, rstyle) in zip(left, right):
        lines.append(GOLD + '│' + RESET + cell(ltext, lstyle, LEFT_WIDTH, center=True) + GOLD + '│' + RESET
                     + cell(rtext, rstyle, right_width) + ' ' + GOLD + '│' + RESET)
    lines.append(GOLD + '╰' + '─' * (width - 2) + '╯' + RESET)
    return lines, ((logo_row, 1 + (LEFT_WIDTH - LOGO_COLUMNS) // 2) if logo else None)


def _enable_ansi():
    """Windows' classic console reads colour codes only once asked to."""
    if os.name != 'nt':
        return
    try:
        import ctypes
        kernel = ctypes.windll.kernel32
        handle, mode = kernel.GetStdHandle(-11), ctypes.c_uint32()
        if kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel.SetConsoleMode(handle, mode.value | 0x0004)
    except (AttributeError, OSError):
        pass


def show_welcome(vault, out=None, environ=None):
    """Draws the box on a colour terminal; True when it did, so the menu below matches it."""
    out = sys.stdout if out is None else out
    if not (hasattr(out, 'isatty') and out.isatty()) or (environ or os.environ).get('NO_COLOR'):
        return False
    _enable_ansi()
    seal = _sixel_seal() if sixel_terminal(environ) else None
    lines, place = welcome_box(vault, shutil.get_terminal_size().columns, logo=bool(seal))
    out.write('\n' + '\n'.join(lines) + '\n')
    if seal:
        # The box is already on screen, so the image draws inside it without scrolling.
        row, column = place
        out.write('\x1b7\x1b[' + str(len(lines) - row) + 'A\x1b[' + str(column + 1) + 'G' + seal + '\x1b8')
    out.flush()
    return True


def menu_text(found, default, hints, color=False):
    """The numbered client list, then what is missing on this machine, each in aligned columns."""
    def paint(text, style):
        return style + text + RESET if color else text

    labels = [option.get('etiket', option['ad']) for option in found]
    width = max(map(len, labels), default=0)
    lines = ['', '  ' + paint('Hangi istemciyle konuşalım?', BOLD), '']
    for number, (option, label) in enumerate(zip(found, labels), 1):
        mark = '   ' + paint('← son kullanılan', GOLD) if option is default else ''
        lines.append('  ' + paint(f'{number:>2}', GOLD) + '  ' + label.ljust(width) + '   '
                     + paint(MEMORY_LABEL[option['hafiza']], DIM) + mark)
    notes = [hint.split(': ', 1) if ': ' in hint else ['', hint] for hint in hints]
    if notes:
        name_width = max(len(name) for name, _ in notes)
        lines += ['', '  ' + paint('Notlar', BOLD)]
        for name, text in notes:
            lines.append('   ·  ' + name.ljust(name_width) + '   ' + paint(text, DIM))
    lines.append('')
    return '\n'.join(lines)


def choose_model(models, previous, read=input, write=print):
    if len(models) == 1:
        return models[0]
    default = previous if previous in models else models[0]
    write('')
    for number, name in enumerate(models, 1):
        write(f'  {number}  {name}' + ('  (son kullanılan)' if name == default else ''))
    answer = (_ask('  Model [Enter = ' + default + ']: ', read) or '').strip()
    if answer.isdigit() and 1 <= int(answer) <= len(models):
        return models[int(answer) - 1]
    return answer if answer in models else default


# ---------------------------------------------------------------- shell command

BEGIN, END = '# >>> pyn (Cortex) >>>', '# <<< pyn (Cortex) <<<'


def _documents():
    if os.name == 'nt':
        import ctypes
        buffer = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) == 0:  # CSIDL_PERSONAL
            return Path(buffer.value)
    return Path.home() / 'Documents'


def profile_paths():
    """Shell startup files that should carry `pyn`."""
    if os.name == 'nt':
        documents = _documents()
        paths = [documents / 'WindowsPowerShell' / 'Microsoft.PowerShell_profile.ps1']
        if shutil.which('pwsh') or (documents / 'PowerShell').is_dir():
            paths.append(documents / 'PowerShell' / 'Microsoft.PowerShell_profile.ps1')
        return paths
    home = Path.home()
    paths = [home / name for name in ('.zshrc', '.bashrc') if (home / name).exists()]
    return paths or [home / ('.zshrc' if sys.platform == 'darwin' else '.bashrc')]


def shell_block(vault, python=None, windows=None):
    python = python or sys.executable
    windows = os.name == 'nt' if windows is None else windows
    entry = Path(vault) / 'beyin.py'
    if windows:
        body = 'function pyn { & "' + str(python) + '" "' + str(entry) + '" pyn @args }'
    else:
        body = 'pyn() { "' + str(python) + '" "' + str(entry) + '" pyn "$@"; }'
    return BEGIN + '\n# Cortex: Pyn\'i istediğin istemciyle aç. Kaldırmak için: pyn kaldir\n' + body + '\n' + END + '\n'


def cmd_dir(environ=None):
    """Where `pyn.cmd` goes for cmd.exe: WindowsApps, which Windows puts on every user's PATH.
    None when it is not on PATH; the user's PATH itself is never changed."""
    environ = os.environ if environ is None else environ
    local = environ.get('LOCALAPPDATA')
    if not local:
        return None
    folder = Path(local) / 'Microsoft' / 'WindowsApps'
    on_path = any(part.strip().rstrip('\\/').casefold() == str(folder).casefold()
                  for part in environ.get('PATH', '').split(';'))
    return folder if on_path and folder.is_dir() else None


def cmd_bytes(vault, python=None):
    """pyn.cmd. cmd.exe reads a batch file in the console's OEM code page, so the paths are
    written in it; a path it cannot hold switches the console to UTF-8 first."""
    python = python or sys.executable
    run = '"' + str(python) + '" "' + str(Path(vault) / 'beyin.py') + '" pyn %*'
    head = '@echo off\r\nrem ' + BEGIN + '\r\nrem Cortex: Pyn. Kaldirmak icin: pyn kaldir\r\n'
    try:
        return (head + run + '\r\n').encode('oem' if os.name == 'nt' else 'ascii')
    except (UnicodeEncodeError, LookupError):
        return (head + 'chcp 65001 >nul\r\n' + run + '\r\n').encode('utf-8')


def _ours(path):
    try:
        return BEGIN.encode('ascii') in Path(path).read_bytes()
    except OSError:
        return False


def _without_block(text):
    return re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', '', text, flags=re.S)


def install_shell(vault, paths=None, python=None, windows=None, cmd=None):
    """Profiles for PowerShell and bash/zsh, and on Windows `pyn.cmd` for cmd.exe. `cmd` is the
    folder for it; by default WindowsApps, but only on a real install (no explicit `paths`)."""
    block = shell_block(vault, python, windows)
    windows = os.name == 'nt' if windows is None else windows
    if cmd is None and paths is None and windows:
        cmd = cmd_dir()
    written = []
    if cmd is not None:
        target = Path(cmd) / 'pyn.cmd'
        if target.exists() and not _ours(target):
            print('Uyarı: ' + str(target) + ' Cortex\'e ait değil, dokunulmadı; cmd\'de `pyn` çalışmayabilir.',
                  file=sys.stderr)
        else:
            data = cmd_bytes(vault, python)
            if not target.exists() or target.read_bytes() != data:
                target.write_bytes(data)
                written.append(str(target))
    for path in paths if paths is not None else profile_paths():
        path = Path(path)
        text = path.read_text(encoding='utf-8-sig') if path.exists() else ''
        updated = _without_block(text)
        updated = (updated.rstrip('\n') + '\n\n' if updated.strip() else '') + block
        if updated != text:
            path.parent.mkdir(parents=True, exist_ok=True)
            # PowerShell 5.1 reads a BOM-less file in the ANSI code page: keep the BOM there.
            path.write_text(updated, encoding='utf-8-sig' if path.suffix == '.ps1' else 'utf-8', newline='\n')
            written.append(str(path))
    return {'status': 'kuruldu', 'yazilan': written, 'profil': [str(p) for p in (paths or profile_paths())]}


def uninstall_shell(paths=None, cmd=None):
    removed = []
    if cmd is None and paths is None and os.name == 'nt':
        cmd = cmd_dir()
    target = Path(cmd) / 'pyn.cmd' if cmd is not None else None
    if target is not None and target.exists() and _ours(target):
        target.unlink()
        removed.append(str(target))
    for path in paths if paths is not None else profile_paths():
        path = Path(path)
        if not path.exists():
            continue
        text = path.read_text(encoding='utf-8-sig')
        if BEGIN not in text:
            continue
        updated = _without_block(text).rstrip('\n')
        path.write_text(updated + '\n' if updated else '', encoding='utf-8-sig' if path.suffix == '.ps1' else 'utf-8',
                        newline='\n')
        removed.append(str(path))
    return {'status': 'kaldirildi' if removed else 'kurulu_degil', 'silinen': removed}


# ---------------------------------------------------------------- command line

def main(argv, vault, state, interactive=None):
    """`pyn [secim] [istemci argümanları]`, `pyn liste`, `pyn kur`, `pyn kaldir`."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    vault, argv = Path(vault), list(argv)
    if argv[:1] in (['kur'], ['kaldir']):
        result = install_shell(vault) if argv[0] == 'kur' else uninstall_shell()
        if result['status'] == 'kuruldu':
            print('`pyn` komutu eklendi. Yeni bir terminal aç ve her yerden `pyn` yaz.')
        else:
            print('`pyn` komutu kaldırıldı.' if result['status'] == 'kaldirildi' else '`pyn` komutu zaten kurulu değildi.')
        return 0
    found, hints = options(vault=vault)
    if argv[:1] == ['liste']:
        print(json.dumps({'secenekler': [{k: o[k] for k in ('id', 'ad', 'hafiza')} for o in found], 'notlar': hints},
                         ensure_ascii=False, indent=2))
        return 0
    if not found:
        print('Bu makinede Pyn\'i açabilecek bir istemci bulunamadı. Örnek: npm i -g @anthropic-ai/claude-code',
              file=sys.stderr)
        return 1
    last = _last(state)
    for option in found:
        if option.get('saglayici'):
            option['model'] = local_model(option, last)
            why = ('yüklü' if option['model'] in option['yuklu'] else 'son kullanılan') if option['model'] else ''
            name, client = option['yerel'], option['istemci']
            option['etiket'] = (client + ' · ' + option['model'] + ' (' + name + (', ' + why if why else '') + ')'
                                if option['model'] else client + ' · yerel (' + name + ', model sorulacak)')
    default = by_id(found, last.get('secim')) or found[0]
    interactive = sys.stdin.isatty() if interactive is None else interactive
    choice, extra = None, argv
    if argv and not argv[0].startswith('-'):
        choice = pick(found, argv[0], None)
        if choice is None:
            print('Böyle bir seçenek yok: ' + argv[0] + '. Seçenekler: ' + ', '.join(o['id'] for o in found),
                  file=sys.stderr)
            return 2
        extra = argv[1:]
    if choice is None:
        if len(found) == 1 or not interactive:
            choice = default
        else:
            print(menu_text(found, default, hints, color=show_welcome(vault)))
            while choice is None:
                answer = _ask('\n  Seçimin [1-' + str(len(found)) + ', Enter = ' + default['ad'] + ', q = çık]: ')
                if answer is None or answer.strip().casefold() in ('q', 'vazgec', 'vazgeç'):
                    return 0
                choice = pick(found, answer, default)
                if choice is None:
                    print('  Anlamadım; numara ya da ad yaz.')
    model = None
    if choice.get('saglayici'):
        # Whatever the machine has loaded runs; asked only when nothing says which one.
        model = choice.get('model') or (choose_model(choice['modeller'], None) if interactive
                                        else choice['modeller'][0])
        args, env, warning = local_launch(choice, model)
        choice = dict(choice, args=args, env=env)
        print('  Yerel model: ' + model)
        if warning:
            print('  Uyarı: ' + warning, file=sys.stderr)
    if ensure_context(vault, choice) == 'okunamadı':
        print('Uyarı: ' + choice['ayar'] + ' okunamadı; ' + choice['ad'] + ' AGENTS.md\'yi okumayabilir.', file=sys.stderr)
    _remember(state, choice, model)
    if choice['hafiza'] == 'talimat':
        print('  ' + choice['ad'] + ': Pyn hafızasını AGENTS.md talimatıyla dosyalardan okur '
              '(her mesajda otomatik bağlam yok).')
    return launch(vault, choice, extra)
