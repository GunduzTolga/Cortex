#!/usr/bin/env python3
"""Ananas Obsidian temasının veri modülünü kaynaktan üretir (geliştirici aracı).

Tasarım kaynağı `tema/ananas/`: `ananas.css` ve `fonts/*.woff2`. Bu betik yazı
tiplerini @font-face olarak CSS'e gömer ve sonucu motorun paketlenen bir modülüne,
`template/.claude/scripts/beyin_v3_tema_veri.py` dosyasına yazar. Kullanıcı temayı
vault'ta `beyin.py tema kur` ile kurar; o komut bu veriyi kullanır.

    py -3 scripts/ananas_tema.py uret      # kaynak değiştiyse veri modülünü yeniden yaz
    py -3 scripts/ananas_tema.py kontrol   # modül kaynakla aynı mı (CI ve testler)
"""
import argparse
import base64
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
TEMA = ROOT / 'tema' / 'ananas'
MODULE = ROOT / 'template' / '.claude' / 'scripts' / 'beyin_v3_tema_veri.py'
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


def css():
    """The snippet exactly as it lands in .obsidian/snippets/ananas.css."""
    source = (TEMA / 'ananas.css').read_text(encoding='utf-8')
    note = ('/* Yazı tipleri: Fraunces, JetBrains Mono, Schibsted Grotesk; SIL Open Font License 1.1.\n'
            '   Lisans metinleri Cortex deposunda: tema/ananas/fonts/*-OFL.txt */')
    return '\n\n'.join((MARKER, note, font_faces(), source)) + '\n'


def module_text():
    text = css()
    encoded = base64.b64encode(text.encode('utf-8')).decode('ascii')
    chunks = [encoded[i:i + CHUNK] for i in range(0, len(encoded), CHUNK)]
    lines = ['"""Ananas temasının CSS verisi. ÜRETİLMİŞ DOSYA, elle düzenleme.',
             '',
             'Kaynak: tema/ananas/ (ananas.css ve fonts/). Yeniden üretmek için:',
             '    py -3 scripts/ananas_tema.py uret',
             '"""',
             'MARKER = ' + repr(MARKER),
             "CSS_SHA256 = '" + hashlib.sha256(text.encode('utf-8')).hexdigest() + "'",
             'CHUNKS = (']
    lines += ["    '" + chunk + "'," for chunk in chunks]
    lines += [')', '']
    return '\n'.join(lines)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    parser = argparse.ArgumentParser(description='Ananas tema verisini üret veya kontrol et')
    parser.add_argument('islem', choices=('uret', 'kontrol'))
    args = parser.parse_args(argv)
    expected = module_text()
    current = MODULE.read_text(encoding='utf-8') if MODULE.exists() else None
    if args.islem == 'kontrol':
        if current != expected:
            print('beyin_v3_tema_veri.py kaynakla uyuşmuyor; çalıştır: py -3 scripts/ananas_tema.py uret', file=sys.stderr)
            return 1
        print('Tema verisi güncel.')
        return 0
    if current == expected:
        print('Tema verisi zaten güncel: ' + str(MODULE.relative_to(ROOT)))
        return 0
    MODULE.write_text(expected, encoding='utf-8', newline='\n')
    print('Tema verisi yazıldı: ' + str(MODULE.relative_to(ROOT)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
