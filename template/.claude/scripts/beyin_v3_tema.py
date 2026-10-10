"""Ananas: Cortex's optional Obsidian theme, installed into a vault on request.

Touches exactly two paths, both under the vault's .obsidian folder: it writes
snippets/ananas.css and adds "ananas" to enabledCssSnippets in appearance.json,
keeping every other key there. It never overwrites a snippet it did not write and
never rewrites an appearance.json it cannot parse. No network, no index, no state.

    beyin.py tema kur | kaldir | durum
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys

SNIPPET = 'ananas'
OURS = '/* ananas-tema:'  # every edition of the generated snippet opens with this


def css():
    import beyin_v3_tema_veri as veri
    text = base64.b64decode(''.join(veri.CHUNKS)).decode('utf-8')
    if hashlib.sha256(text.encode('utf-8')).hexdigest() != veri.CSS_SHA256:
        raise ValueError('Tema verisi bozuk (parmak izi tutmuyor); Cortex paketini yeniden kur.')
    return text


def _paths(vault):
    vault = Path(vault)
    if not vault.is_dir():
        raise ValueError('Vault bulunamadı: ' + str(vault))
    obsidian = vault / '.obsidian'
    return obsidian / 'snippets' / (SNIPPET + '.css'), obsidian / 'appearance.json'


def _is_ours(snippet):
    with open(snippet, encoding='utf-8', errors='replace') as handle:
        return handle.read(len(OURS)) == OURS


def _appearance(path):
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except ValueError:
        raise ValueError(str(path) + ' okunamadı (geçersiz JSON); dosyaya dokunulmadı. Düzeltip tekrar dene.') from None
    if not isinstance(data, dict):
        raise ValueError(str(path) + ' beklenen biçimde değil; dosyaya dokunulmadı.')
    return data


def _enabled(data):
    value = data.get('enabledCssSnippets')
    return list(value) if isinstance(value, list) else []


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def install(vault):
    snippet, appearance = _paths(vault)
    if snippet.exists() and not _is_ours(snippet):
        raise ValueError(str(snippet) + ' zaten var ve Cortex yazmamış; üzerine yazılmadı.')
    data = _appearance(appearance)  # read before writing anything: a bad file stops the whole step
    text = css()
    changed = not snippet.exists() or snippet.read_text(encoding='utf-8') != text
    if changed:
        snippet.parent.mkdir(parents=True, exist_ok=True)
        snippet.write_text(text, encoding='utf-8', newline='\n')
    enabled = _enabled(data)
    if SNIPPET not in enabled:
        data['enabledCssSnippets'] = enabled + [SNIPPET]
        _write_json(appearance, data)
        changed = True
    return {'status': 'kuruldu' if changed else 'guncel', 'snippet': str(snippet)}


def uninstall(vault):
    snippet, appearance = _paths(vault)
    removed = False
    if snippet.exists():
        if not _is_ours(snippet):
            raise ValueError(str(snippet) + ' Cortex yazmamış; silinmedi.')
        snippet.unlink()
        removed = True
    if appearance.exists():
        data = _appearance(appearance)
        enabled = _enabled(data)
        if SNIPPET in enabled:
            data['enabledCssSnippets'] = [name for name in enabled if name != SNIPPET]
            _write_json(appearance, data)
            removed = True
    return {'status': 'kaldirildi' if removed else 'kurulu_degil', 'snippet': str(snippet)}


def status(vault):
    snippet, appearance = _paths(vault)
    installed = snippet.exists() and _is_ours(snippet)
    current = installed and snippet.read_text(encoding='utf-8') == css()
    enabled = appearance.exists() and SNIPPET in _enabled(_appearance(appearance))
    return {'status': ('guncel' if current else 'eski') if installed else 'kurulu_degil',
            'enabled': enabled, 'snippet': str(snippet)}


MESSAGES = {
    'kuruldu': 'Ananas teması kuruldu. Obsidian açıksa: Ayarlar > Görünüm > CSS parçacıkları > yenile.',
    'guncel': 'Ananas teması zaten kurulu ve güncel.',
    'kaldirildi': 'Ananas teması kaldırıldı.',
    'kurulu_degil': 'Ananas teması kurulu değil.',
    'eski': 'Ananas temasının eski bir sürümü kurulu; güncellemek için: beyin.py tema kur',
}


def main(argv, vault):
    parser = argparse.ArgumentParser(prog='beyin.py tema', description='Ananas Obsidian teması')
    parser.add_argument('islem', choices=('kur', 'kaldir', 'durum'))
    parser.add_argument('--json', action='store_true', help='makine okunur çıktı')
    args = parser.parse_args(argv)
    try:
        result = {'kur': install, 'kaldir': uninstall, 'durum': status}[args.islem](vault)
    except ValueError as exc:
        print(json.dumps({'status': 'hata', 'message': str(exc)}, ensure_ascii=True) if args.json else str(exc),
              file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        line = MESSAGES[result['status']]
        if args.islem == 'durum' and result['status'] != 'kurulu_degil' and not result['enabled']:
            line += ' (Obsidian ayarlarında kapalı.)'
        print(line)
    return 0
