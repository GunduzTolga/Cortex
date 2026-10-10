#!/usr/bin/env python3
"""Pyn marka görsellerinin küçük boyutlarını kaynak çizimlerden üretir (geliştirici aracı).

Pillow ister; yalnız tasarım değiştiğinde elle çalıştırılır, testler ve CI çalıştırmaz.
Çıktılar `tema/ananas/marka/` altına yazılır ve depoya girer:

- pyn-muhur-{28,42,56}.png : yakala penceresinin başlığı (ekran ölçeğine göre seçilir)
- pyn.ico                  : Windows kısayol ikonu (16-256 px)
- pyn-yuz-256.png          : Obsidian'da boş sekmedeki Pyn yüzü

Ardından: py -3 scripts/ananas_tema.py uret

    py -3 scripts/marka_uret.py "C:\\...\\Pyn Tasarım\\docs\\design\\logo"
"""
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tema' / 'ananas' / 'marka'


def main(source):
    source = Path(source)
    seal = Image.open(source / 'logo-muhur-1024.png').convert('RGBA')
    face = Image.open(source / 'logo-defter-1024.png').convert('RGBA')
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (28, 42, 56):
        seal.resize((size, size), Image.LANCZOS).save(OUT / f'pyn-muhur-{size}.png', optimize=True)
    seal.save(OUT / 'pyn.ico', sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 256)])
    face.resize((256, 256), Image.LANCZOS).save(OUT / 'pyn-yuz-256.png', optimize=True)
    # The vector seal without its C2PA metadata block: that is provenance, not drawing.
    svg = (source / 'logo-muhur.svg').read_text(encoding='utf-8')
    svg = re.sub(r'<metadata>.*?</metadata>', '', svg, flags=re.S)
    svg = svg.replace(' xmlns:c2pa="http://c2pa.org/manifest"', '').replace(' width="400" height="400"', '')
    (OUT / 'pyn-muhur.svg').write_text(svg, encoding='utf-8', newline='\n')
    for path in sorted(OUT.iterdir()):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
