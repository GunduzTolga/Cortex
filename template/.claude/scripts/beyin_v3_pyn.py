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
            # Installed but its server is off or has no model: a red row, not a launchable one.
            found.append({'id': provider, 'ad': name, 'hafiza': 'tam', 'kapali': True})
    return found, hints


def usable(found):
    return [option for option in found if not option.get('kapali')]


OFF_LABEL = 'kapalı · açıp bir model yükle'


def off_message(option):
    return (option['ad'] + ' kapalı ya da yüklü modeli yok. Uygulamayı açıp bir model yükle; '
            'satır yeşile döner ve o modelle açılır.')


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
GREEN, RED = '\x1b[38;2;94;186;92m', '\x1b[38;2;217;83;79m'
# The Sixel seal is 120 px; Windows Terminal draws Sixel on a 10x20 px virtual cell.
LOGO_COLUMNS, LOGO_ROWS = 12, 6
LEFT_WIDTH = 34
GREETING = 'Bugün neyi düşünelim?'
SIGNATURE = 'SoleLuna Tech'


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


def available_update(vault, state):
    """{'version', 'current'} when a newer Cortex is published, else None. Reads only the cache the
    session-start check keeps (at most one GitHub request a day, made by that check); no network here."""
    if state is None:
        return None
    try:
        import beyin_v3_releases as releases
        result = releases.status(Path(vault), Path(state))
    except Exception:
        return None
    if result.get('status') != 'available':
        return None
    return {'version': result.get('version'), 'current': result.get('current_version')}


def update_hint(update):
    return ('Cortex: ' + update['version'] + ' çıktı (sende ' + (update['current'] or '?') + '); güncelle: pyn guncelle'
            if update else None)


def welcome_box(vault, columns, logo=False, update=None):
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
    right = [('', '')]
    if update:  # first, where it is seen: a newer Cortex is out
        right += [(_cut('Yeni sürüm: Cortex ' + update['version'] + ' hazır', text_width), GOLD + BOLD),
                  (_cut('pyn guncelle ile kur (sende ' + (update['current'] or '?') + ')', text_width), ''),
                  ('─' * text_width, GOLD)]
    right += [('Son oturum', GOLD + BOLD), (_cut(_last_session(vault) or 'Henüz kayıt yok', text_width), ''),
              ('─' * text_width, GOLD), ('İpuçları', GOLD + BOLD),
              (_cut('pyn 1 ya da pyn claude: menüsüz aç', text_width), ''),
              (_cut('pyn guncelle: Cortex\'i güncelle', text_width), ''),
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
    signature = ' ' + SIGNATURE + ' '  # the maker, quietly in the bottom edge
    lines.append(GOLD + '╰' + '─' * (width - 4 - len(signature)) + RESET + DIM + signature + RESET + GOLD + '──╯' + RESET)
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


def show_welcome(vault, out=None, environ=None, update=None):
    """Draws the box on a colour terminal; True when it did, so the menu below matches it."""
    out = sys.stdout if out is None else out
    if not (hasattr(out, 'isatty') and out.isatty()) or (environ or os.environ).get('NO_COLOR'):
        return False
    _enable_ansi()
    seal = _sixel_seal() if sixel_terminal(environ) else None
    lines, place = welcome_box(vault, shutil.get_terminal_size().columns, logo=bool(seal), update=update)
    out.write('\n' + '\n'.join(lines) + '\n')
    if seal:
        # The box is already on screen, so the image draws inside it without scrolling.
        row, column = place
        out.write('\x1b7\x1b[' + str(len(lines) - row) + 'A\x1b[' + str(column + 1) + 'G' + seal + '\x1b8')
    out.flush()
    return True


def menu_text(found, default, hints, color=False):
    """The numbered list with a status dot (green ready, red off), then what needs attention."""
    def paint(text, style):
        return style + text + RESET if color else text

    labels = [option.get('etiket', option['ad']) for option in found]
    width = max(map(len, labels), default=0)
    lines = ['', '  ' + paint('Hangi istemciyle konuşalım?', BOLD), '']
    for number, (option, label) in enumerate(zip(found, labels), 1):
        off = option.get('kapali')
        # Without colour the dot's shape carries the state.
        dot = paint('●', RED if off else GREEN) if color else ('○' if off else '●')
        mark = '   ' + paint('← son kullanılan', GOLD) if option is default else ''
        state = OFF_LABEL if off else MEMORY_LABEL[option['hafiza']]
        lines.append('  ' + paint(f'{number:>2}', GOLD) + '  ' + dot + ' ' + label.ljust(width) + '   '
                     + paint(state, DIM) + mark)
    notes = [hint.split(': ', 1) if ': ' in hint else ['', hint] for hint in hints]
    if notes:
        name_width = max(len(name) for name, _ in notes)
        lines += ['', '  ' + paint('Dikkat', BOLD)]
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


# ---------------------------------------------------------------- terminal look

# A fixed id, so a second `pyn kur` updates the same profile: uuid5(URL, 'cortex:pyn:windows-terminal').
PROFILE_GUID = '{b6965b45-0f5a-5807-8742-aa4972eb0c0b}'
PROFILE_IMAGES = {'pyn-ikon.png': 'MUHUR_56', 'pyn-muhur-200.png': 'MUHUR_200'}
OWNED = 'pyn-kur.json'  # what `pyn kur` wrote, so `pyn kaldir` removes only that


def _owned(state):
    try:
        data = json.loads((Path(state) / OWNED).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _own(state, **changes):
    data = _owned(state)
    data.update(changes)
    data = {key: value for key, value in data.items() if value is not None}
    path = Path(state) / OWNED
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')


def _powershell(argv):
    """The installer's hook form: Claude Code runs Windows commands through Git Bash or cmd, and
    an encoded PowerShell call is the one spelling that survives both with any path."""
    import base64
    script = '& ' + ' '.join("'" + str(value).replace("'", "''") + "'" for value in argv) + '; exit $LASTEXITCODE'
    root = os.environ.get('SYSTEMROOT') or os.environ.get('WINDIR') or 'C:\\Windows'
    launcher = str(Path(root) / 'System32/WindowsPowerShell/v1.0/powershell.exe').replace('\\', '/')
    return (subprocess.list2cmdline([launcher]) + ' -NoProfile -NonInteractive -EncodedCommand '
            + base64.b64encode(script.encode('utf-16le')).decode())


def statusline_command(vault, python=None, windows=None):
    import shlex
    windows = os.name == 'nt' if windows is None else windows
    argv = [str(python or sys.executable), str(Path(vault) / '.claude' / 'scripts' / 'beyin_v3_statusline.py'),
            '--vault', str(vault)]
    return _powershell(argv) if windows else shlex.join(argv)


def install_statusline(vault, state, python=None, windows=None):
    """Pyn's line under Claude Code's prompt, in this vault only (`.claude/settings.local.json`;
    the installer keeps keys it does not manage). A status line someone else set stays."""
    path = Path(vault) / '.claude' / 'settings.local.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    except (OSError, ValueError):
        return 'okunamadı'
    if not isinstance(data, dict):
        return 'okunamadı'
    command = statusline_command(vault, python, windows)
    current = data.get('statusLine')
    theirs = current.get('command') if isinstance(current, dict) else current
    if current and theirs not in (command, _owned(state).get('statusLine')):
        return 'başkasının'
    data['statusLine'] = {'type': 'command', 'command': command, 'padding': 0}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    _own(state, statusLine=command)
    return 'kuruldu'


def uninstall_statusline(vault, state):
    path = Path(vault) / '.claude' / 'settings.local.json'
    owned = _owned(state).get('statusLine')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return 'kurulu_degil'
    current = data.get('statusLine') if isinstance(data, dict) else None
    if not owned or not isinstance(current, dict) or current.get('command') != owned:
        return 'kurulu_degil'
    del data['statusLine']
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    _own(state, statusLine=None)
    return 'kaldirildi'


def terminal_folders(environ=None):
    """Windows Terminal settings folders on this machine: (folder, packaged). The Store and
    preview builds read their own folder through ms-appdata, the unpackaged build any path."""
    environ = os.environ if environ is None else environ
    local = environ.get('LOCALAPPDATA')
    if not local:
        return []
    packages = Path(local) / 'Packages'
    candidates = [(packages / name / 'LocalState', True) for name in
                  ('Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe')]
    candidates.append((Path(local) / 'Microsoft' / 'Windows Terminal', False))
    return [(folder, packaged) for folder, packaged in candidates if (folder / 'settings.json').is_file()]


def pyn_profile(folder, packaged):
    def image(name):
        return 'ms-appdata:///local/' + name if packaged else str(folder / name)
    return {'guid': PROFILE_GUID, 'name': 'Pyn', 'commandline': '%SystemRoot%\\System32\\cmd.exe /k pyn',
            'startingDirectory': '%USERPROFILE%', 'icon': image('pyn-ikon.png'), 'tabTitle': 'Pyn',
            'suppressApplicationTitle': True, 'tabColor': '#E8B23A', 'backgroundImage': image('pyn-muhur-200.png'),
            'backgroundImageAlignment': 'bottomRight', 'backgroundImageStretchMode': 'none',
            'backgroundImageOpacity': 0.18}


def _profiles(data):
    profiles = data.setdefault('profiles', {})
    return profiles if isinstance(profiles, list) else profiles.setdefault('list', [])


def install_terminal_profile(environ=None):
    """A 'Pyn' profile in Windows Terminal: the seal as tab icon and as a faint corner mark, a
    gold tab named Pyn that keeps its name while a client runs. Returns one status per folder."""
    import base64
    try:
        import beyin_v3_marka as marka
        images = {name: base64.b64decode(''.join(getattr(marka, part))) for name, part in PROFILE_IMAGES.items()}
    except (ImportError, AttributeError, ValueError):
        images = {}
    results = []
    for folder, packaged in terminal_folders(environ):
        settings = folder / 'settings.json'
        try:
            raw = settings.read_text(encoding='utf-8-sig')
            data = json.loads(raw)
        except (OSError, ValueError):
            # Comments or a half-written file: never rewrite what cannot be read back exactly.
            results.append((str(settings), 'okunamadı'))
            continue
        backup = folder / 'settings.pyn-yedek.json'
        if not backup.exists():
            backup.write_text(raw, encoding='utf-8')
        for name, content in images.items():
            target = folder / name
            try:
                if not target.exists() or target.read_bytes() != content:
                    target.write_bytes(content)
            except OSError:
                pass  # an open Pyn tab holds its image; the one there keeps showing
        profiles = _profiles(data)
        profiles[:] = [p for p in profiles if not (isinstance(p, dict) and p.get('guid') == PROFILE_GUID)]
        profiles.insert(0, pyn_profile(folder, packaged))
        settings.write_text(json.dumps(data, indent=4, ensure_ascii=False) + '\n', encoding='utf-8')
        results.append((str(settings), 'kuruldu'))
    return results


def uninstall_terminal_profile(environ=None):
    results = []
    for folder, _packaged in terminal_folders(environ):
        settings = folder / 'settings.json'
        try:
            data = json.loads(settings.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            continue
        profiles = _profiles(data)
        kept = [p for p in profiles if not (isinstance(p, dict) and p.get('guid') == PROFILE_GUID)]
        if len(kept) != len(profiles):
            profiles[:] = kept
            if isinstance(data.get('defaultProfile'), str) and data['defaultProfile'].lower() == PROFILE_GUID:
                del data['defaultProfile']
            settings.write_text(json.dumps(data, indent=4, ensure_ascii=False) + '\n', encoding='utf-8')
            results.append(str(settings))
        for name in PROFILE_IMAGES:
            try:
                (folder / name).unlink()
            except OSError:
                pass
    return results


# ---------------------------------------------------------------- client health

# npm packages of the clients installed through npm; `pyn kontrol` compares versions.
NPM_PACKAGES = {'claude': '@anthropic-ai/claude-code', 'codex': '@openai/codex', 'opencode': 'opencode-ai',
                'gemini': '@google/gemini-cli', 'qwen': '@qwen-code/qwen-code'}
HEALTH = 'pyn-saglik.json'
HEALTH_DAYS = 14


def _version(text):
    found = re.search(r'(\d+)\.(\d+)\.(\d+)', text or '')
    return '.'.join(found.groups()) if found else None


def _newer(latest, installed):
    def key(version):
        return tuple(int(part) for part in version.split('.'))
    return bool(latest and installed) and key(latest) > key(installed)


def _output(argv, timeout):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8', errors='replace',
                              timeout=timeout, stdin=subprocess.DEVNULL)
        return done.stdout + done.stderr
    except (OSError, subprocess.SubprocessError, ValueError):
        return ''


def check_clients(found, run=_output, which=shutil.which):
    """{id: {ad, kurulu, son, paket}}: each client's own `--version` and, for npm clients, the
    version npm publishes. The one `pyn` command that uses the network, and only when asked."""
    from concurrent.futures import ThreadPoolExecutor
    npm = which('npm')
    clients = [o for o in found if not o.get('saglayici') and not o.get('kapali')]

    def one(option):
        package = NPM_PACKAGES.get(option['id'])
        installed = _version(run([option['yol'], '--version'], 30))
        latest = _version(run([npm, 'view', package, 'version'], 30)) if npm and package else None
        return option['id'], {'ad': option['ad'], 'kurulu': installed, 'son': latest, 'paket': package}

    with ThreadPoolExecutor(max_workers=max(len(clients), 1)) as pool:
        return dict(pool.map(one, clients))


def save_health(state, results, now=None):
    import time
    path = Path(state) / HEALTH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'zaman': now or time.time(), 'istemciler': results}, ensure_ascii=False) + '\n',
                    encoding='utf-8')


def health_hints(state, now=None):
    """Menu notes from the last `pyn kontrol`: outdated clients, or a reminder when it is old."""
    import time
    try:
        data = json.loads((Path(state) / HEALTH).read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    hints = []
    for info in (data.get('istemciler') or {}).values():
        if isinstance(info, dict) and _newer(info.get('son'), info.get('kurulu')):
            hints.append(info['ad'] + ': ' + info['kurulu'] + ' kurulu, ' + info['son'] + ' çıktı; güncelle: npm i -g '
                         + info['paket'] + '@latest')
    days = int(((now or time.time()) - float(data.get('zaman') or 0)) // 86400)
    if days >= HEALTH_DAYS:
        hints.append('İstemciler: sürümler ' + str(days) + ' gün önce kontrol edildi; yeniden bak: pyn kontrol')
    return hints


def health_report(results):
    lines = ['', '  İstemci sürümleri', '']
    width = max((len(info['ad']) for info in results.values()), default=0)
    for info in results.values():
        if _newer(info['son'], info['kurulu']):
            state = info['kurulu'] + ' → ' + info['son'] + ' çıktı · npm i -g ' + info['paket'] + '@latest'
        elif info['kurulu']:
            state = info['kurulu'] + ' · güncel' if info['son'] else info['kurulu']
        else:
            state = 'sürümü okunamadı'
        lines.append('   ·  ' + info['ad'].ljust(width) + '   ' + state)
    return '\n'.join(lines + [''])


# ---------------------------------------------------------------- command line

def main(argv, vault, state, interactive=None):
    """`pyn [secim] [istemci argümanları]`, `pyn liste`, `pyn kontrol`, `pyn guncelle`, `pyn kur`, `pyn kaldir`."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    vault, argv = Path(vault), list(argv)
    if argv[:1] in (['guncelle'], ['güncelle']):
        # The vault's own updater: verified package, trial install, rollback. Arguments pass through
        # (`pyn guncelle --check`).
        print('  Cortex güncelleniyor (vault: ' + str(vault) + ')…')
        return subprocess.call([sys.executable, str(vault / 'beyin.py'), 'update', *argv[1:]], cwd=str(vault))
    if argv[:1] == ['kur']:
        install_shell(vault)
        print('`pyn` komutu eklendi. Yeni bir terminal aç ve her yerden `pyn` yaz.')
        line = install_statusline(vault, state)
        print({'kuruldu': '  Claude Code: Pyn durum satırı eklendi (yalnız bu vault\'ta).',
               'başkasının': '  Claude Code: bu vault\'ta başka bir durum satırı var, dokunulmadı.',
               'okunamadı': '  Claude Code: .claude/settings.local.json okunamadı, durum satırı eklenmedi.'}[line])
        if os.name == 'nt':
            for settings, status in install_terminal_profile():
                print('  Windows Terminal: Pyn profili eklendi (sekme menüsünde, en üstte).' if status == 'kuruldu'
                      else '  Windows Terminal: ' + settings + ' okunamadı (yorum satırı olabilir), profil eklenmedi.')
        return 0
    if argv[:1] == ['kaldir']:
        result = uninstall_shell()
        line = uninstall_statusline(vault, state)
        profiles = uninstall_terminal_profile() if os.name == 'nt' else []
        removed = (['`pyn` komutu'] if result['status'] == 'kaldirildi' else []) + (
            ['Claude durum satırı'] if line == 'kaldirildi' else []) + (['Windows Terminal profili'] if profiles else [])
        print('Kaldırıldı: ' + ', '.join(removed) + '.' if removed else '`pyn` zaten kurulu değildi.')
        return 0
    found, hints = options(vault=vault)
    if argv[:1] == ['kontrol']:
        print('  İstemcilerin sürümleri soruluyor (npm), birkaç saniye sürebilir…')
        results = check_clients(found)
        save_health(state, results)
        print(health_report(results))
        return 0
    update = available_update(vault, state)
    hints += ([update_hint(update)] if update else []) + health_hints(state)
    if argv[:1] == ['liste']:
        print(json.dumps({'secenekler': [dict({k: o[k] for k in ('id', 'ad', 'hafiza')}, aktif=not o.get('kapali'))
                                         for o in found], 'notlar': hints}, ensure_ascii=False, indent=2))
        return 0
    if not usable(found):
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
    remembered = by_id(found, last.get('secim'))
    default = remembered if remembered and not remembered.get('kapali') else usable(found)[0]
    interactive = sys.stdin.isatty() if interactive is None else interactive
    choice, extra = None, argv
    if argv and not argv[0].startswith('-'):
        choice = pick(found, argv[0], None)
        if choice is None:
            print('Böyle bir seçenek yok: ' + argv[0] + '. Seçenekler: ' + ', '.join(o['id'] for o in usable(found)),
                  file=sys.stderr)
            return 2
        if choice.get('kapali'):
            print(off_message(choice), file=sys.stderr)
            return 1
        extra = argv[1:]
    if choice is None:
        if len(found) == 1 or not interactive:
            choice = default
        else:
            print(menu_text(found, default, hints, color=show_welcome(vault, update=update)))
            while choice is None:
                answer = _ask('\n  Seçimin [1-' + str(len(found)) + ', Enter = ' + default['ad'] + ', q = çık]: ')
                if answer is None or answer.strip().casefold() in ('q', 'vazgec', 'vazgeç'):
                    return 0
                choice = pick(found, answer, default)
                if choice is None:
                    print('  Anlamadım; numara ya da ad yaz.')
                elif choice.get('kapali'):
                    print('  ' + off_message(choice))
                    choice = None
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
