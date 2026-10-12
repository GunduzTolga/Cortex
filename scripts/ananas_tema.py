#!/usr/bin/env python3
"""Ananas temasının ve Pyn marka görsellerinin veri modüllerini kaynaktan üretir (geliştirici aracı).

Tasarım kaynağı `tema/ananas/`: `ananas.css`, `fonts/*.woff2`, `ikonlar/*.svg` ve
`marka/` (Pyn mührü ve yüzü). Bu betik iki paketlenen motor modülü yazar:

- `template/.claude/scripts/beyin_v3_tema_veri.py`: Obsidian CSS'i; yazı tipleri,
  ikonlar ve logolar içine gömülü. Kullanıcı `beyin.py tema kur` ile kurar.
- `template/.claude/scripts/beyin_v3_marka.py`: yakala penceresinin başlığındaki
  mühür ve Windows kısayol ikonu.

Marka görsellerinin küçük boyutları ayrıca `scripts/marka_uret.py` ile (Pillow) üretilir.

    py -3 scripts/ananas_tema.py uret      # kaynak değiştiyse modülleri yeniden yaz
    py -3 scripts/ananas_tema.py kontrol   # modüller kaynakla aynı mı (CI ve testler)
"""
import argparse
import base64
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
TEMA = ROOT / 'tema' / 'ananas'
MARKA = TEMA / 'marka'
MODULE = ROOT / 'template' / '.claude' / 'scripts' / 'beyin_v3_tema_veri.py'
BRAND_MODULE = ROOT / 'template' / '.claude' / 'scripts' / 'beyin_v3_marka.py'
FONT_MODULE = ROOT / 'template' / '.claude' / 'scripts' / 'beyin_v3_yazitipi.py'
TTF = TEMA / 'fonts-ttf'
MARKER = '/* ananas-tema: Cortex tarafından üretildi; elle düzenleme, beyin.py tema kur yeniden yazar */'
CHUNK = 96

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


def _data_uri(path, mime):
    return 'url("data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii') + '")'


def asset_vars():
    """Icons and Pyn's marks as custom properties; ananas.css refers to them by name."""
    lines = ['body {']
    for icon in sorted((TEMA / 'ikonlar').glob('*.svg')):
        lines.append(f'  --ananas-ikon-{icon.stem}: ' + _data_uri(icon, 'image/svg+xml') + ';')
    lines.append('  --ananas-logo: ' + _data_uri(MARKA / 'pyn-muhur.svg', 'image/svg+xml') + ';')
    lines.append('  --ananas-pyn-yuz: ' + _data_uri(MARKA / 'pyn-yuz-256.png', 'image/png') + ';')
    lines.append('}')
    return '\n'.join(lines)


def css():
    """The snippet exactly as it lands in .obsidian/snippets/ananas.css."""
    source = (TEMA / 'ananas.css').read_text(encoding='utf-8')
    note = ('/* Yazı tipleri: Fraunces, JetBrains Mono, Schibsted Grotesk; SIL Open Font License 1.1.\n'
            '   Lisans metinleri Cortex deposunda: tema/ananas/fonts/*-OFL.txt */')
    return '\n\n'.join((MARKER, note, font_faces(), asset_vars(), source)) + '\n'


def _chunked(data):
    encoded = base64.b64encode(data).decode('ascii')
    return ["    '" + encoded[i:i + CHUNK] + "'," for i in range(0, len(encoded), CHUNK)]


def module_text():
    text = css()
    lines = ['"""Ananas temasının CSS verisi. ÜRETİLMİŞ DOSYA, elle düzenleme.',
             '',
             'Kaynak: tema/ananas/ (ananas.css, fonts/, ikonlar/, marka/). Yeniden üretmek için:',
             '    py -3 scripts/ananas_tema.py uret',
             '"""',
             'MARKER = ' + repr(MARKER),
             "CSS_SHA256 = '" + hashlib.sha256(text.encode('utf-8')).hexdigest() + "'",
             'CHUNKS = (',
             *_chunked(text.encode('utf-8')),
             ')',
             '']
    return '\n'.join(lines)


def brand_text():
    """Pyn's marks for the runtime: the yakala header, the Windows shortcut icon and the seal
    `pyn` draws in its welcome box (Sixel)."""
    lines = ['"""Pyn marka görselleri. ÜRETİLMİŞ DOSYA, elle düzenleme.',
             '',
             'Kaynak: tema/ananas/marka/. Yeniden üretmek için:',
             '    py -3 scripts/ananas_tema.py uret',
             '"""']
    for size in (28, 42, 56):
        lines += [f'MUHUR_{size} = (', *_chunked((MARKA / f'pyn-muhur-{size}.png').read_bytes()), ')']
    lines += ['ICO = (', *_chunked((MARKA / 'pyn.ico').read_bytes()), ')']
    lines += ['SIXEL = (', *_chunked((MARKA / 'pyn-muhur.six').read_bytes()), ')']
    # Only names and sizes here: the font bytes live in beyin_v3_yazitipi.py, which the popup
    # imports just once per machine to write them into the state folder.
    sizes = {path.name: path.stat().st_size for path in sorted(TTF.glob('*.ttf'))}
    lines += ['FONT_SIZES = ' + repr(sizes), '']
    return '\n'.join(lines)


def font_text():
    """The yakala popup's Ananas faces as TTF (Windows GDI cannot read WOFF2)."""
    lines = ['"""Ananas yazı tiplerinin TTF kopyaları (yakala penceresi). ÜRETİLMİŞ DOSYA, elle düzenleme.',
             '',
             'Kaynak: tema/ananas/fonts-ttf/ (scripts/yazitipi_uret.py). Yeniden üretmek için:',
             '    py -3 scripts/ananas_tema.py uret',
             'Lisans: SIL Open Font License 1.1; metinler Cortex deposunda tema/ananas/fonts/*-OFL.txt',
             '"""',
             'FONTS = {']
    for path in sorted(TTF.glob('*.ttf')):
        lines += ['    ' + repr(path.name) + ': (', *['    ' + line for line in _chunked(path.read_bytes())], '    ),']
    lines += ['}', '']
    return '\n'.join(lines)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    parser = argparse.ArgumentParser(description='Ananas tema ve Pyn marka verisini üret veya kontrol et')
    parser.add_argument('islem', choices=('uret', 'kontrol'))
    args = parser.parse_args(argv)
    targets = ((MODULE, module_text()), (BRAND_MODULE, brand_text()), (FONT_MODULE, font_text()))
    stale = [path for path, text in targets if not path.exists() or path.read_text(encoding='utf-8') != text]
    if args.islem == 'kontrol':
        if stale:
            names = ', '.join(path.name for path in stale)
            print(names + ' kaynakla uyuşmuyor; çalıştır: py -3 scripts/ananas_tema.py uret', file=sys.stderr)
            return 1
        print('Tema ve marka verisi güncel.')
        return 0
    for path, text in targets:
        if path in stale:
            path.write_text(text, encoding='utf-8', newline='\n')
            print('Yazıldı: ' + str(path.relative_to(ROOT)))
    if not stale:
        print('Tema ve marka verisi zaten güncel.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
