"""pyn: open Pyn (this vault's companion) in the AI client you pick, from any folder.

`beyin.py pyn` lists the clients installed on this machine, remembers the last choice and
starts the chosen one inside the vault, so its instructions and memory load. `pyn kur` adds a
one-word `pyn` command to the user's shell profile; `pyn kaldir` removes it.

Memory, honestly labelled:
- tam (full): hooks load Pyn's memory into every turn (Claude Code, Codex, OpenCode, OMP).
- talimat (instructions): the client reads AGENTS.md and loads the companion files itself;
  no per-turn retrieval and no receipt reminders (Gemini CLI, Qwen Code, Cursor Agent).

Local models run through Codex (`--oss`) so they keep full memory. Ollama and LM Studio are
found only by asking servers that are already running: no command is run that could start one.
No network beyond 127.0.0.1, no model call, standard library only.
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
     'not': 'yerel modeller ve OpenCode Go aboneliği', 'kur': 'npm i -g opencode-ai'},
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


def ollama_models(get=_get, base='http://127.0.0.1:11434'):
    """(downloaded chat models, models in memory right now)."""
    tags = get(base + '/api/tags')
    if not isinstance(tags, dict):
        return [], []
    downloaded = [m['name'] for m in tags.get('models', []) if isinstance(m.get('name'), str)
                  and _chat_model(m['name'], (m.get('details') or {}).get('family', ''))]
    running = get(base + '/api/ps') or {}
    loaded = [m.get('name') for m in running.get('models', []) if m.get('name') in downloaded]
    return downloaded, loaded


def lmstudio_models(get=_get, base='http://127.0.0.1:1234'):
    """(downloaded chat models, models loaded in LM Studio right now)."""
    rich = get(base + '/api/v0/models')  # says which model is loaded and which are embeddings
    if isinstance(rich, dict):
        models = [m for m in rich.get('data', []) if isinstance(m.get('id'), str) and m.get('type') in ('llm', 'vlm')]
        return [m['id'] for m in models], [m['id'] for m in models if m.get('state') == 'loaded']
    plain = get(base + '/v1/models')  # an older server: names only, no load state
    if not isinstance(plain, dict):
        return [], []
    return [m['id'] for m in plain.get('data', []) if isinstance(m.get('id'), str) and _chat_model(m['id'])], []


# Local model servers Codex can use with --oss: (provider, display name, discovery).
LOCAL = (('ollama', 'Ollama', ollama_models), ('lmstudio', 'LM Studio', lmstudio_models))
LOCAL_TOOLS = {'ollama': ('ollama',), 'lmstudio': ('lms',)}

MEMORY_LABEL = {'tam': 'tam hafıza', 'talimat': 'hafıza talimatla (AGENTS.md)'}


def options(clients=CLIENTS, local=LOCAL, which=shutil.which):
    """Everything `pyn` can open on this machine, in menu order, and hints for what is missing."""
    found, hints = [], []
    for client in clients:
        path = next((p for p in (which(name) for name in client['komut']) if p), None)
        if path:
            found.append(dict(client, yol=path, args=[]))
        elif client.get('kur'):
            hints.append(client['ad'] + ' kurulu değil (' + client['not'] + '): ' + client['kur'])
    codex = next((option for option in found if option['id'] == 'codex'), None)
    for provider, name, discover in local:
        downloaded, loaded = discover() if codex else ([], [])
        if downloaded:
            found.append(dict(codex, id='codex-' + provider, ad='Codex · yerel (' + name + ')', saglayici=provider,
                              args=['--oss', '--local-provider', provider], modeller=downloaded, yuklu=loaded))
        elif codex and any(which(tool) for tool in LOCAL_TOOLS.get(provider, ())):
            hints.append(name + ' kurulu ama sunucusu kapalı ya da indirilmiş modeli yok; '
                         'açıp bir model yükleyince menüde yerel seçenek belirir.')
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


def pick(found, answer, default):
    """Match a menu answer: empty (the default), a number, an id or the start of a name."""
    answer = (answer or '').strip().casefold()
    if not answer:
        return default
    if answer.isdigit() and 1 <= int(answer) <= len(found):
        return found[int(answer) - 1]
    for option in found:
        if answer == option['id']:
            return option
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
        return run([option['yol'], *option['args'], *extra], cwd=str(vault))
    finally:
        signal.signal(signal.SIGINT, previous)


def _ask(prompt, read=input):
    try:
        return read(prompt)
    except (EOFError, KeyboardInterrupt):
        return None


def menu_text(found, default, hints):
    lines = ['', '  🍍 Pyn: hangi istemciyle konuşalım?', '']
    for number, option in enumerate(found, 1):
        mark = '  (son kullanılan)' if option is default else ''
        lines.append(f"  {number}  {option.get('etiket', option['ad']):<40} {MEMORY_LABEL[option['hafiza']]}{mark}")
    for hint in hints:
        lines.append('     · ' + hint)
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


def _without_block(text):
    return re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', '', text, flags=re.S)


def install_shell(vault, paths=None, python=None, windows=None):
    block = shell_block(vault, python, windows)
    written = []
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


def uninstall_shell(paths=None):
    removed = []
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
    found, hints = options()
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
            name = option['ad'][len('Codex · yerel ('):-1]
            option['etiket'] = ('Codex · ' + option['model'] + ' (' + name + (', ' + why if why else '') + ')'
                                if option['model'] else 'Codex · yerel (' + name + ', model sorulacak)')
    default = next((o for o in found if o['id'] == last.get('secim')), found[0])
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
            print(menu_text(found, default, hints))
            while choice is None:
                answer = _ask('  Seçim [Enter = ' + default['ad'] + ', q = vazgeç]: ')
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
        choice = dict(choice, args=choice['args'] + ['-m', model])
        print('  Yerel model: ' + model)
    if ensure_context(vault, choice) == 'okunamadı':
        print('Uyarı: ' + choice['ayar'] + ' okunamadı; ' + choice['ad'] + ' AGENTS.md\'yi okumayabilir.', file=sys.stderr)
    _remember(state, choice, model)
    if choice['hafiza'] == 'talimat':
        print('  ' + choice['ad'] + ': Pyn hafızasını AGENTS.md talimatıyla dosyalardan okur '
              '(her mesajda otomatik bağlam yok).')
    return launch(vault, choice, extra)
