#!/usr/bin/env python3
"""Pyn marka görsellerinin küçük boyutlarını kaynak çizimlerden üretir (geliştirici aracı).

Pillow ister; yalnız tasarım değiştiğinde elle çalıştırılır, testler ve CI çalıştırmaz.
Çıktılar `tema/ananas/marka/` altına yazılır ve depoya girer:

- pyn-muhur-{28,42,56}.png : yakala penceresinin başlığı (ekran ölçeğine göre seçilir)
- pyn.ico                  : Windows kısayol ikonu (16-256 px)
- pyn-yuz/*.svg            : Pyn'in yüzü, vektör (sohbet, Obsidian'da boş sekme); `yuz` adımı
- pyn-yuz-256.png          : aynı yüzün PNG'si, SVG okumayan yerler için; `yuz` adımı

`kurulum` adımı masaüstü uygulamasının Windows kurulum sihirbazının görsellerini yazar
(`desktop/build/`, electron-builder'ın kaynak klasörü): kenar görseli (164x314) ve üst başlık
(150x57), Pyn'in yüzü ve mühürüyle, Ananas renklerinde.
- pyn-muhur.six            : `pyn` karşılama kutusundaki mühür (Sixel, terminalde gerçek resim)
- pyn-muhur-200.png        : Windows Terminal Pyn profilinin köşe filigranı

Ardından: py -3 scripts/ananas_tema.py uret

    py -3 scripts/marka_uret.py "C:\\...\\Pyn Tasarım\\docs\\design\\logo"
    py -3 scripts/marka_uret.py yuz "C:\\...\\Pyn'in Yüz Tasarımı\\pyn-yuz"
    py -3 scripts/marka_uret.py kurulum

`yuz`, Claude Design'ın teslim ettiği SVG'leri (docs/marka/pyn-yuz-brifi.md) alır; PNG'yi
Edge'in görünmez (headless) kipiyle çizer, pencere açmaz.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tema' / 'ananas' / 'marka'

# Sixel size of the seal in the `pyn` welcome box. Windows Terminal draws Sixel on a 10x20 px
# virtual cell, so 120 px is 12 columns by 6 rows.
SIXEL_SIZE = 120


def sixel(image, size=SIXEL_SIZE, colors=32):
    """The image as a Sixel string with a transparent background (1:1 pixels)."""
    image = image.convert('RGBA').resize((size, size), Image.LANCZOS)
    alpha = image.getchannel('A').load()
    flat = Image.new('RGB', image.size)
    flat.paste(image, mask=image.getchannel('A'))
    indexed = flat.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    palette, pixels = indexed.getpalette()[:colors * 3], indexed.load()
    out = ['\x1bP9;1;0q', f'"1;1;{size};{size}']
    for index in range(colors):
        r, g, b = palette[index * 3:index * 3 + 3]
        out.append(f'#{index};2;{r * 100 // 255};{g * 100 // 255};{b * 100 // 255}')
    for band in range(0, size, 6):
        rows = []
        for index in range(colors):
            line = ''.join(chr(63 + sum(1 << k for k in range(6) if band + k < size
                                        and alpha[x, band + k] >= 128 and pixels[x, band + k] == index))
                           for x in range(size)).rstrip('?')
            if line:
                rows.append(f'#{index}' + re.sub(r'(.)\1{3,}', lambda m: f'!{len(m.group())}{m.group(1)}', line))
        out.append('$'.join(rows) + '-')
    return ''.join(out) + '\x1b\\'


def main(source):
    source = Path(source)
    seal = Image.open(source / 'logo-muhur-1024.png').convert('RGBA')
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (28, 42, 56):
        seal.resize((size, size), Image.LANCZOS).save(OUT / f'pyn-muhur-{size}.png', optimize=True)
    seal.save(OUT / 'pyn.ico', sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 256)])
    (OUT / 'pyn-muhur.six').write_text(sixel(seal), encoding='ascii', newline='')
    seal.resize((200, 200), Image.LANCZOS).save(OUT / 'pyn-muhur-200.png', optimize=True)
    # The vector seal without its C2PA metadata block: that is provenance, not drawing.
    svg = without_provenance((source / 'logo-muhur.svg').read_text(encoding='utf-8'))
    (OUT / 'pyn-muhur.svg').write_text(svg.replace(' width="400" height="400"', ''), encoding='utf-8', newline='\n')
    for path in sorted(OUT.iterdir()):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


def without_provenance(svg):
    """The SVG without its C2PA metadata block: that is provenance, not drawing."""
    svg = re.sub(r'<metadata>.*?</metadata>', '', svg, flags=re.S)
    return svg.replace(' xmlns:c2pa="http://c2pa.org/manifest"', '')


EDGE = Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe'


def render_png(svg, target, size=256):
    """The SVG as a transparent PNG, drawn by Edge without a window."""
    with tempfile.TemporaryDirectory(prefix='pyn-yuz-') as tmp:
        page = Path(tmp) / 'yuz.html'
        page.write_text('<html><body style="margin:0"><img src="' + Path(svg).resolve().as_uri() +
                        f'" width="{size}" height="{size}" style="display:block"></body></html>', encoding='utf-8')
        subprocess.run([str(EDGE), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        '--user-data-dir=' + str(Path(tmp) / 'profil'), '--default-background-color=00000000',
                        f'--window-size={size},{size}', '--screenshot=' + str(Path(target).resolve()), page.as_uri()],
                       check=True, capture_output=True, timeout=120)


def face(source):
    """Pyn's face from Claude Design's delivery: the chosen SVGs (not the options), and its PNG."""
    source, folder = Path(source), OUT / 'pyn-yuz'
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    for svg in sorted(source.glob('pyn-yuz*.svg')):
        (folder / svg.name).write_text(without_provenance(svg.read_text(encoding='utf-8')), encoding='utf-8', newline='\n')
    render_png(folder / 'pyn-yuz.svg', OUT / 'pyn-yuz-256.png')
    for path in sorted(folder.iterdir()) + [OUT / 'pyn-yuz-256.png']:
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


PAPER, INK, GOLD, MUTED = '#f3efe4', '#1b1712', '#e8b23a', '#75716a'
FONTS = ROOT / 'tema' / 'ananas' / 'fonts-ttf'
DESKTOP_BUILD = ROOT / 'desktop' / 'build'


def installer_images():
    """The installer's sidebar (welcome and finish pages) and header, drawn at three times their
    size and brought down, saved as the 24-bit BMPs NSIS takes."""
    from PIL import ImageDraw, ImageFont
    k = 3
    DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)

    def font(name, size):
        return ImageFont.truetype(str(FONTS / name), size * k)

    # Sidebar, 164x314: Pyn's face, the name, what it is; a gold band at the foot; an ink edge.
    w, h = 164 * k, 314 * k
    side = Image.new('RGB', (w, h), PAPER)
    face = Image.open(OUT / 'pyn-yuz-256.png').convert('RGBA').resize((116 * k, 116 * k), Image.LANCZOS)
    side.paste(face, ((w - face.width) // 2, 52 * k), face)
    d = ImageDraw.Draw(side)
    d.text((w // 2, 198 * k), 'Cortex', fill=INK, font=font('Fraunces-Bold.ttf', 27), anchor='mm')
    for i, line in enumerate(('Notların ve yapay zekâ', 'araçların için ortak hafıza')):
        d.text((w // 2, (228 + i * 15) * k), line, fill=MUTED, font=font('SchibstedGrotesk-Regular.ttf', 11), anchor='mm')
    d.rectangle([0, 288 * k, w, h], fill=GOLD)
    d.rectangle([0, 288 * k, w, 288 * k + 2 * k], fill=INK)
    d.rectangle([w - 2 * k, 0, w, h], fill=INK)
    side = side.resize((164, 314), Image.LANCZOS)
    for name in ('installerSidebar.bmp', 'uninstallerSidebar.bmp'):
        side.save(DESKTOP_BUILD / name)

    # Header, 150x57: the seal at its right, on paper.
    w, h = 150 * k, 57 * k
    head = Image.new('RGB', (w, h), PAPER)
    seal = Image.open(OUT / 'pyn-muhur-200.png').convert('RGBA').resize((42 * k, 42 * k), Image.LANCZOS)
    head.paste(seal, (w - seal.width - 8 * k, (h - seal.height) // 2), seal)
    head.resize((150, 57), Image.LANCZOS).save(DESKTOP_BUILD / 'installerHeader.bmp')
    for path in sorted(DESKTOP_BUILD.glob('*.bmp')):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


if __name__ == '__main__':
    if sys.argv[1:2] == ['kurulum']:
        installer_images()
    elif sys.argv[1:2] == ['yuz']:
        face(sys.argv[2] if len(sys.argv) > 2 else '.')
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else '.')
