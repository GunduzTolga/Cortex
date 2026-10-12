"""Claude Code durum satırı: Pyn'in adı, model ve son oturum.

`pyn kur` bunu vault'un `.claude/settings.local.json` dosyasına `statusLine` olarak yazar; yalnız
vault'ta açılan Claude oturumlarında görünür. Claude Code oturum durumunu JSON olarak stdin'den
verir, bu betik tek satır yazar. Ağ yok, model çağrısı yok, yalnız standart kütüphane.

    python beyin_v3_statusline.py --vault <vault>
"""
import json
import re
import sys
from pathlib import Path

GOLD, BOLD, DIM, RESET = '\x1b[38;2;232;178;58m', '\x1b[1m', '\x1b[2m', '\x1b[0m'
LAST_WIDTH = 48


def last_session(vault):
    """The label of the latest session card, without its date and session id."""
    try:
        path = next(Path(vault).glob('*/Last-Session.md'), None)
        text = path.read_text(encoding='utf-8') if path else ''
    except (OSError, UnicodeDecodeError):
        return None
    heading = next((line[3:].strip() for line in text.splitlines() if line.startswith('## ')), None)
    if not heading:
        return None
    heading = re.sub(r'\s*·\s*[0-9a-f]{8}$', '', heading)
    return re.sub(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*·\s*', '', heading)


def line(data, vault):
    model = (data.get('model') or {}).get('display_name') or ''
    parts = [GOLD + BOLD + 'Pyn' + RESET + DIM + ' · ikinci beyin' + RESET]
    if model:
        parts.append(model)
    last = last_session(vault)
    if last:
        parts.append(DIM + 'son: ' + (last if len(last) <= LAST_WIDTH else last[:LAST_WIDTH - 1] + '…') + RESET)
    return (GOLD + ' · ' + RESET).join(parts)


def main(argv=None, stdin=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout.buffer if stdout is None else stdout
    try:
        data = json.loads(stdin.read().decode('utf-8') or '{}')
    except (ValueError, UnicodeDecodeError):
        data = {}
    data = data if isinstance(data, dict) else {}
    vault = argv[argv.index('--vault') + 1] if '--vault' in argv[:-1] else (
        (data.get('workspace') or {}).get('project_dir') or data.get('cwd') or '.')
    stdout.write(line(data, vault).encode('utf-8'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
