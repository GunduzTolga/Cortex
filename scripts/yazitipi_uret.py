#!/usr/bin/env python3
"""Ananas yazı tiplerinin yakala penceresi için TTF kopyalarını üretir (geliştirici aracı).

Windows (GDI, dolayısıyla Tk) WOFF2 okuyamaz. Bu betik `tema/ananas/fonts/` altındaki
WOFF2 parçalarını açar, gereken kalınlığı sabit (static) bir örneğe indirir ve Latin ile
Latin-genişletilmiş parçaları tek dosyada birleştirir; Türkçe harflerin tamamı tek fontta
olur. Çıktı `tema/ananas/fonts-ttf/` altına yazılır ve depoya girer; ardından
`py -3 scripts/ananas_tema.py uret` onları motorun marka modülüne gömer.

Gerekenler: fontTools (pip) ve Node.js. WOFF2'nin brotli sıkıştırmasını Node'un kendi
zlib'i açar; Python'a brotli kurmak gerekmez. Testler ve CI bu betiği çalıştırmaz.

Lisans: üç yazı tipi de SIL OFL 1.1 ve hiçbiri "Reserved Font Name" tanımlamaz; değiştirilmiş
(örneklenmiş, birleştirilmiş) kopyalar aynı adı taşıyabilir. Lisans metinleri fonts/ altında.
"""
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'tema' / 'ananas' / 'fonts'
OUT = ROOT / 'tema' / 'ananas' / 'fonts-ttf'

# (çıktı dosyası, kaynak öneki, kaynak eksen kümesi, eksen sabitleri, GDI ailesi, GDI stili, usWeightClass)
# Fraunces başlığı Ananas'ta 900 ağırlıktır; GDI'da "Bold" yüzü olarak kaydedilir ki Tk'nın
# ('Fraunces', boyut, 'bold') isteği sentetik kalınlaştırma yerine bu çizimi alsın.
STYLES = (
    ('Fraunces-Bold.ttf', 'fraunces', 'wght', {'wght': 900}, 'Fraunces', 'Bold', 700),
    ('SchibstedGrotesk-Regular.ttf', 'schibsted-grotesk', 'wght', {'wght': 400}, 'Schibsted Grotesk', 'Regular', 400),
    ('SchibstedGrotesk-Bold.ttf', 'schibsted-grotesk', 'wght', {'wght': 700}, 'Schibsted Grotesk', 'Bold', 700),
    ('JetBrainsMono-Regular.ttf', 'jetbrains-mono', 'wght', {'wght': 400}, 'JetBrains Mono', 'Regular', 400),
    ('JetBrainsMono-Bold.ttf', 'jetbrains-mono', 'wght', {'wght': 700}, 'JetBrains Mono', 'Bold', 700),
)


def _install_node_brotli():
    """fontTools imports `brotli` only to call decompress(); Node's zlib can do that."""
    def decompress(data):
        script = "process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync(0)))"
        return subprocess.run(['node', '-e', script], input=data, capture_output=True, check=True).stdout
    sys.modules.setdefault('brotli', types.SimpleNamespace(decompress=decompress, compress=None))


def _source(prefix, axes, subset):
    # The same files the Obsidian theme embeds, so the popup and the notes draw alike.
    return SOURCE / f'{prefix}-{subset}-{axes}-normal.woff2'


def build(out_name, prefix, axes, pins, family, style, weight):
    from fontTools.merge import Merger
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.woff2 import decompress
    from fontTools.varLib.instancer import instantiateVariableFont
    parts = []
    with tempfile.TemporaryDirectory() as tmp:
        for subset in ('latin', 'latin-ext'):
            raw = io.BytesIO()
            decompress(str(_source(prefix, axes, subset)), raw)
            raw.seek(0)
            font = TTFont(raw)
            if 'fvar' in font:
                present = {axis.axisTag for axis in font['fvar'].axes}
                font = instantiateVariableFont(font, {tag: value for tag, value in pins.items() if tag in present})
            path = Path(tmp) / f'{subset}.ttf'
            font.save(path)
            parts.append(str(path))
        merged = Merger().merge(parts)
    names = merged['name']
    for record in list(names.names):
        if record.nameID in (16, 17, 21, 22, 25):  # typographic and variation names: GDI uses 1/2
            names.removeNames(nameID=record.nameID)
    full = family if style == 'Regular' else f'{family} {style}'
    postscript = family.replace(' ', '') + '-' + style
    for name_id, value in ((1, family), (2, style), (4, full), (6, postscript)):
        names.setName(value, name_id, 3, 1, 0x409)
        names.setName(value, name_id, 1, 0, 0)
    os2, head = merged['OS/2'], merged['head']
    os2.usWeightClass = weight
    bold = style == 'Bold'
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if bold else 0b1000000)  # BOLD or REGULAR
    head.macStyle = 1 if bold else 0
    OUT.mkdir(parents=True, exist_ok=True)
    merged.save(OUT / out_name)
    glyphs = len(merged.getGlyphOrder())
    has_turkish = all(ord(c) in merged.getBestCmap() for c in 'ğĞıİşŞçÇöÖüÜ')
    print(f'{(OUT / out_name).stat().st_size:8d}  {out_name:30s} {glyphs:4d} glif  turkce={has_turkish}')


def main():
    _install_node_brotli()
    for spec in STYLES:
        build(*spec)


if __name__ == '__main__':
    main()
