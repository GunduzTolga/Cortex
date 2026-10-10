#!/usr/bin/env python3
"""Ananas Obsidian temasını bir vault'a kurar veya kaldırır.

Yalnız iki şeye dokunur: `.obsidian/snippets/ananas.css` dosyasını yazar ve
`.obsidian/appearance.json` içindeki `enabledCssSnippets` listesine `ananas`
ekler. Beyin motoruna, hook'lara, notlara ve diğer Obsidian ayarlarına
dokunmaz; güncelleyicinin yönettiği hiçbir dosya değişmez.

    py -3 scripts/ananas_tema.py kur --vault "C:\\Notlar\\Beynim"
    py -3 scripts/ananas_tema.py kaldir --vault "C:\\Notlar\\Beynim"
"""
import argparse
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
TEMA = ROOT / 'tema' / 'ananas'
SNIPPET = 'ananas'
MARKER = '/* ananas-tema: scripts/ananas_tema.py tarafından üretildi */'

LATIN = ('U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, '
         'U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD')
LATIN_EXT = ('U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, '
             'U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, '
             'U+2C60-2C7F, U+A720-A7FF')
# (CSS ailesi, dosya öneki, ağırlık aralığı, stil)
FACES = (
    ('Fraunces', 'fraunces', '100 900', 'normal'),
    ('JetBrains Mono', 'jetbrains-mono', '100 800', 'normal'),
    ('Schibsted Grotesk', 'schibsted-grotesk', '400 900', 'normal'),
    ('Schibsted Grotesk', 'schibsted-grotesk', '400 900', 'italic'),
)


def font_faces():
    rules = []
    for family, prefix, weight, style in FACES:
        for subset, unicode_range in (('latin-ext', LATIN_EXT), ('latin', LATIN)):
            path = TEMA / 'fonts' / f'{prefix}-{subset}-wght-{style}.woff2'
            data = base64.b64encode(path.read_bytes()).decode('ascii')
            rules.append(f"@font-face {{\n  font-family: '{family}';\n  font-style: {style};\n"
                         f"  font-weight: {weight};\n  font-display: swap;\n"
                         f"  src: url(data:font/woff2;base64,{data}) format('woff2');\n"
                         f"  unicode-range: {unicode_range};\n}}")
    return '\n'.join(rules)


def build():
    source = (TEMA / 'ananas.css').read_text(encoding='utf-8')
    note = ('/* Yazı tipleri: Fraunces, JetBrains Mono, Schibsted Grotesk; SIL Open Font License 1.1.\n'
            '   Lisans metinleri: tema/ananas/fonts/*-OFL.txt */')
    return '\n\n'.join((MARKER, note, font_faces(), source))


def obsidian_dir(vault):
    vault = Path(vault).expanduser().resolve()
    if not vault.is_dir():
        raise SystemExit(f'Vault bulunamadı: {vault}')
    return vault / '.obsidian'


def read_appearance(path):
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except ValueError:
        raise SystemExit(f'{path} okunamadı (geçersiz JSON). Elle düzelt, sonra tekrar dene; dosyaya dokunulmadı.')
    if not isinstance(data, dict):
        raise SystemExit(f'{path} beklenen biçimde değil; dosyaya dokunulmadı.')
    return data


def write_appearance(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def install(vault):
    obsidian = obsidian_dir(vault)
    snippet = obsidian / 'snippets' / f'{SNIPPET}.css'
    if snippet.exists() and MARKER not in snippet.read_text(encoding='utf-8', errors='replace')[:200]:
        raise SystemExit(f'{snippet} zaten var ve bu betiğin yazdığı dosya değil; üzerine yazılmadı.')
    appearance = obsidian / 'appearance.json'
    data = read_appearance(appearance)
    snippet.parent.mkdir(parents=True, exist_ok=True)
    snippet.write_text(build(), encoding='utf-8', newline='\n')
    enabled = data.get('enabledCssSnippets')
    enabled = list(enabled) if isinstance(enabled, list) else []
    if SNIPPET not in enabled:
        data['enabledCssSnippets'] = enabled + [SNIPPET]
        write_appearance(appearance, data)
    return snippet


def uninstall(vault):
    obsidian = obsidian_dir(vault)
    snippet = obsidian / 'snippets' / f'{SNIPPET}.css'
    if snippet.exists():
        if MARKER not in snippet.read_text(encoding='utf-8', errors='replace')[:200]:
            raise SystemExit(f'{snippet} bu betiğin yazdığı dosya değil; silinmedi.')
        snippet.unlink()
    appearance = obsidian / 'appearance.json'
    data = read_appearance(appearance)
    enabled = data.get('enabledCssSnippets')
    if isinstance(enabled, list) and SNIPPET in enabled:
        data['enabledCssSnippets'] = [name for name in enabled if name != SNIPPET]
        write_appearance(appearance, data)
    return snippet


def main(argv=None):
    # A Windows console may be cp1252: an unencodable character prints as '?' instead of failing.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    parser = argparse.ArgumentParser(description='Ananas Obsidian teması')
    parser.add_argument('islem', choices=('kur', 'kaldir'))
    parser.add_argument('--vault', required=True, help='Obsidian vault klasörü')
    args = parser.parse_args(argv)
    if args.islem == 'kur':
        path = install(args.vault)
        print(f'Ananas teması kuruldu: {path}')
        print("Obsidian açıksa: Ayarlar > Görünüm > CSS parçacıkları > yenile.")
    else:
        path = uninstall(args.vault)
        print(f'Ananas teması kaldırıldı: {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
