#!/usr/bin/env python3
"""Pyn marka görsellerini kaynak çizimlerden üretir (geliştirici aracı).

Pillow ve numpy ister; yalnız tasarım değiştiğinde elle çalıştırılır, testler ve CI çalıştırmaz.
Çıktılar `tema/ananas/marka/` altına yazılır ve depoya girer. Varsayılan adım (`logo`)
`kaynak/` altındaki dört çizimin zeminini kaldırır (kenarlarda zemin rengi ayıklanır, kağıt
zemindeki benekler atılır) ve şunları yazar:

- pyn-logo-{512,96}.png         : logo, tek başına (karşılama; köşe ve sohbetteki Pyn)
- pyn-muhur-{28,42,56,200}.png  : logo krem dairede, ince mürekkep halkayla: uygulamanın mührü
                                  (bildirim alanı, terminaldeki Pyn sekmesi, kurulum başlığı)
- pyn.ico                       : aynı mühür, Windows uygulama ve kısayol ikonu (16-256 px)
- pyn-yakala-{28,42,56}.png     : not alan Pyn, telefondaki Not al düğmesi: yakala penceresinin
                                  başlığı (ekran ölçeğine göre seçilir)
- pyn-oturan-512.png            : oturan Pyn (ilk açılış ekranı, kurulum sihirbazı)
- pyn-ananas-512.png            : ananas Pyn (ilk açılışın son adımı)
- pyn-yuz/*.svg            : Pyn'in yüzü, vektör (sohbet, Obsidian'da boş sekme); `yuz` adımı
- pyn-yuz-256.png          : aynı yüzün PNG'si, SVG okumayan yerler için; `yuz` adımı

`yakala` adımı Not al penceresinin mikrofon düğmesini çizer (`tema/ananas/marka/yakala/`):
yuvarlak, sert gölgeli, kenarları yumuşatılmış; boşta, dinlerken, yazarken ve hazırlanırken,
üç ekran ölçeğinde. Tk tuvali Windows'ta şekilleri yumuşatmadan çizdiği için düğme resimdir.

`kurulum` adımı masaüstü uygulamasının Windows kurulum sihirbazının görsellerini yazar
(`desktop/build/`, electron-builder'ın kaynak klasörü): kenar görseli (164x314) ve üst başlık
(150x57), oturan Pyn ve mühürle, Ananas renklerinde. `tepsi` adımı bildirim alanının ikonlarını
mühürden çizer; ikisi de `logo` adımından sonra çalıştırılır.
- pyn-muhur.six            : `pyn` karşılama kutusundaki mühür (Sixel, terminalde gerçek resim)
- pyn-muhur-200.png        : Windows Terminal Pyn profilinin köşe filigranı

Ardından: py -3 scripts/ananas_tema.py uret

    py -3 scripts/marka_uret.py
    py -3 scripts/marka_uret.py kurulum
    py -3 scripts/marka_uret.py tepsi
    py -3 scripts/marka_uret.py yuz "C:\\...\\Pyn'in Yüz Tasarımı\\pyn-yuz"
    py -3 scripts/marka_uret.py yakala

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


SOURCES = OUT / 'kaynak'
SENTINEL = (255, 0, 255)


def _box_sum(mask, k):
    """How many of `mask` are in the k x k square around each pixel (k odd)."""
    import numpy as np
    r = k // 2
    s = np.pad(mask.astype(np.int32), ((r + 1, r), (r + 1, r))).cumsum(0).cumsum(1)
    return s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]


def cutout(path, despeckle=False):
    """A drawing on a plain or paper ground, the ground taken off: a square RGBA with a margin.

    The ground is what is near the border's colour and joined to the border, so the white of a face
    inside its outline stays. The ground's edge is softened by how far each pixel is from the
    ground's colour, and that colour is taken out of it: no light fringe on a dark taskbar. On a
    paper ground the paper's specks go: a dot with few others near it is the paper's, a halftone's
    dots stand together."""
    import numpy as np
    from PIL import ImageDraw
    rgb = Image.open(path).convert('RGB')
    w, h = rgb.size
    filled = rgb.copy()
    border = [(x, y) for x in range(0, w, 8) for y in (0, h - 1)] + [(x, y) for y in range(0, h, 8) for x in (0, w - 1)]
    for seed in border:
        if filled.getpixel(seed) != SENTINEL:
            ImageDraw.floodfill(filled, seed, SENTINEL, thresh=40)
    marked = np.asarray(filled)
    ground = (marked[..., 0] == 255) & (marked[..., 1] == 0) & (marked[..., 2] == 255)
    px = np.asarray(rgb).astype(np.float32)
    paper = np.median(px[ground], axis=0)
    alpha = np.where(ground, 0.0, 1.0)
    if despeckle:
        solid = alpha > 0
        alpha[solid & (_box_sum(solid, 31) < 40)] = 0
        ground = alpha == 0
    # The drawing's pixels beside the ground are partly ground: as opaque as they are far from it.
    edge = (alpha > 0) & (_box_sum(ground, 5) > 0)
    far = np.abs(px - paper).max(axis=2)
    alpha[edge] = np.clip(far[edge] / 90.0, 0, 1)
    # Paper's faint blotches left beside the ground, all but clear: gone, or they stretch the crop to the corners.
    alpha[alpha < 0.15] = 0
    if despeckle:
        solid = alpha > 0
        alpha[solid & (_box_sum(solid, 31) < 40)] = 0
    a = np.maximum(alpha, 1e-3)[..., None]
    colour = np.clip((px - paper * (1 - a)) / a, 0, 255)
    drawn = Image.fromarray(np.dstack([colour, alpha[..., None] * 255]).round().astype(np.uint8), 'RGBA')
    drawn = drawn.crop(drawn.getchannel('A').getbbox())
    side = round(max(drawn.size) * 1.08)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.alpha_composite(drawn, ((side - drawn.width) // 2, (side - drawn.height) // 2))
    return square


def badge(logo, size=1024):
    """The round mark: the logo on paper in an ink ring. Black on a dark taskbar is lost; on its
    paper it reads in both. Drawn four times larger, brought down: a smooth ring."""
    from PIL import ImageDraw
    n = size * 4
    big = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    ring = n // 40
    d.ellipse((0, 0, n - 1, n - 1), fill=INK)
    d.ellipse((ring, ring, n - 1 - ring, n - 1 - ring), fill=PAPER)
    inner = logo.resize((round(n * 0.8), round(n * 0.8)), Image.LANCZOS)
    big.alpha_composite(inner, ((n - inner.width) // 2, (n - inner.height) // 2 + n // 60))
    return big.resize((size, size), Image.LANCZOS)


ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 256)


def logo():
    """Pyn's marks from the drawings in `kaynak/`:

    - pyn-logo.webp: the logo, alone (pyn-logo-{512,96}.png: the welcome, the corner, the chat) and on its
      round mark (pyn-muhur-{28,42,56,200}.png, pyn.ico, pyn-muhur.six: the app's and its
      shortcuts' icon, the notification area, the terminal's tab and welcome)
    - pyn-yakala.webp: Pyn taking a note, the phone's Not al button; Not al's title here too
      (pyn-yakala-{28,42,56}.png)
    - pyn-oturan.webp: Pyn sitting, whole (pyn-oturan-512.png: the first-run screen, the installer)
    - pyn-ananas.webp: Pyn as a pineapple, small (pyn-ananas-512.png: the first run's last step)"""
    OUT.mkdir(parents=True, exist_ok=True)
    alone = cutout(SOURCES / 'pyn-logo.webp')
    # 512 for the welcome; 96 for what is drawn at 24-36 px (the corner, the chat's face), which a browser shrinking 512 blurs.
    for size in (512, 96):
        alone.resize((size, size), Image.LANCZOS).save(OUT / f'pyn-logo-{size}.png', optimize=True)
    mark = badge(alone)
    for size in (28, 42, 56, 200):
        mark.resize((size, size), Image.LANCZOS).save(OUT / f'pyn-muhur-{size}.png', optimize=True)
    frames = [mark.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    frames[-1].save(OUT / 'pyn.ico', sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
    (OUT / 'pyn-muhur.six').write_text(sixel(mark), encoding='ascii', newline='')
    note = cutout(SOURCES / 'pyn-yakala.webp')
    for size in (28, 42, 56):
        note.resize((size, size), Image.LANCZOS).save(OUT / f'pyn-yakala-{size}.png', optimize=True)
    cutout(SOURCES / 'pyn-oturan.webp', despeckle=True).resize((512, 512), Image.LANCZOS).save(OUT / 'pyn-oturan-512.png', optimize=True)
    cutout(SOURCES / 'pyn-ananas.webp', despeckle=True).resize((512, 512), Image.LANCZOS).save(OUT / 'pyn-ananas-512.png', optimize=True)
    for path in sorted(OUT.glob('pyn-*')):
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

    # Sidebar, 164x314: Pyn sitting, the name, what it is; a gold band at the foot; an ink edge.
    w, h = 164 * k, 314 * k
    side = Image.new('RGB', (w, h), PAPER)
    pyn = Image.open(OUT / 'pyn-oturan-512.png').convert('RGBA').resize((132 * k, 132 * k), Image.LANCZOS)
    side.paste(pyn, ((w - pyn.width) // 2, 44 * k), pyn)
    d = ImageDraw.Draw(side)
    d.text((w // 2, 198 * k), 'Cortex', fill=INK, font=font('Fraunces-Bold.ttf', 27), anchor='mm')
    for i, line in enumerate(('Notların ve yapay zeka', 'araçların için ortak hafıza')):
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


MIC_STATES = ('bos', 'dinliyor', 'yaziyor', 'kapali')
MIC_SIZES = (44, 66, 88)  # 1x, 1.5x and 2x of a 44 px button


def mic_buttons():
    """Not al's microphone button, every state at every scale, as PNGs (yakala/mikrofon-<state>-<size>.png)."""
    from PIL import ImageDraw
    folder = OUT / 'yakala'
    folder.mkdir(parents=True, exist_ok=True)
    colours = {
        'bos': ('#fffaf0', INK, INK, True),
        'dinliyor': (GOLD, INK, INK, True),
        'yaziyor': ('#fffaf0', INK, INK, True),
        'kapali': ('#f3efe4', '#c9c3b6', '#a5a198', False),
    }
    for state in MIC_STATES:
        fill, ring, glyph, shadow = colours[state]
        for size in MIC_SIZES:
            k = 8  # drawn eight times larger, brought down: smooth edges
            u = size / 44 * k  # one point of the 44 px design, in drawing pixels
            side = round((size + 3 * size / 44) * k)
            img = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            r = 20 * u  # the button's radius: 40 of the 44, the rest for the ring and the shadow
            cx = cy = 22 * u
            if shadow:
                d.ellipse([cx - r + 3 * u, cy - r + 3 * u, cx + r + 3 * u, cy + r + 3 * u], fill=INK)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=ring, width=round(2 * u))
            if state == 'yaziyor':
                for dx in (-7, 0, 7):
                    d.ellipse([cx + (dx - 2.2) * u, cy - 2.2 * u, cx + (dx + 2.2) * u, cy + 2.2 * u], fill=glyph)
            else:
                w = 2.4 * u  # the glyph's stroke
                d.rounded_rectangle([cx - 4.6 * u, cy - 11 * u, cx + 4.6 * u, cy + 3 * u], radius=4.6 * u, fill=glyph)
                d.arc([cx - 8.6 * u, cy - 8.5 * u, cx + 8.6 * u, cy + 7 * u], 0, 180, fill=glyph, width=round(w))
                d.line([cx, cy + 7 * u, cx, cy + 10.5 * u], fill=glyph, width=round(w))
                d.rounded_rectangle([cx - 5.5 * u, cy + 10 * u, cx + 5.5 * u, cy + 10 * u + w], radius=w / 2, fill=glyph)
            out = img.resize((round(side / k), round(side / k)), Image.LANCZOS)
            out.save(folder / f'mikrofon-{state}-{size}.png', optimize=True)
    for path in sorted(folder.iterdir()):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


TRAY_SIZES = (16, 24, 32)  # 1x, 1.5x and 2x of the notification area's icon
LISTENING = '#d9412b'  # the red of Windows' own "the microphone is in use" mark


def tray_icons():
    """The desktop app's notification-area icon: Pyn's seal, and with a red dot when the
    microphone listens all the time ("Sürekli dinle"), at each scale (tepsi/pyn-<state>-<size>.png)."""
    from PIL import ImageDraw
    folder = OUT / 'tepsi'
    folder.mkdir(parents=True, exist_ok=True)
    seal = Image.open(OUT / 'pyn-muhur-200.png').convert('RGBA')
    for size in TRAY_SIZES:
        k = 8
        big = seal.resize((size * k, size * k), Image.LANCZOS)
        big.resize((size, size), Image.LANCZOS).save(folder / f'pyn-kapali-{size}.png', optimize=True)
        d = ImageDraw.Draw(big)
        r, ring = size * k * 0.22, size * k * 0.06  # the dot, and a paper ring that keeps it off the seal
        cx = cy = size * k - r - ring
        d.ellipse([cx - r - ring, cy - r - ring, cx + r + ring, cy + r + ring], fill=PAPER)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LISTENING)
        big.resize((size, size), Image.LANCZOS).save(folder / f'pyn-dinliyor-{size}.png', optimize=True)
    for path in sorted(folder.iterdir()):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


MENU_GLYPHS = ('mikrofon-acik', 'mikrofon-kapali', 'not', 'ayarlar', 'cik')


def menu_icons():
    """The notification-area menu's icons (tepsi/menu-<name>-<16|32>.png): the microphone listening
    (red) or off (grey, struck through), a note, a gear, the power sign. Gold and mid-tones, so they
    read on Windows' light menus and dark ones alike; drawn eight times larger and brought down."""
    from PIL import ImageDraw
    folder = OUT / 'tepsi'
    folder.mkdir(parents=True, exist_ok=True)
    for name in MENU_GLYPHS:
        for size in (16, 32):
            k = 8
            u = size * k / 16  # one point of the 16 px design, in drawing pixels
            img = Image.new('RGBA', (size * k, size * k), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            w = round(1.6 * u)
            if name.startswith('mikrofon'):
                c = LISTENING if name == 'mikrofon-acik' else '#8f8a80'
                d.rounded_rectangle([5.2 * u, 1.2 * u, 10.8 * u, 9.6 * u], radius=2.8 * u, fill=c)
                d.arc([3 * u, 4 * u, 13 * u, 12.2 * u], 0, 180, fill=c, width=w)
                d.line([8 * u, 12.2 * u, 8 * u, 14.2 * u], fill=c, width=w)
                d.line([5.4 * u, 14.6 * u, 10.6 * u, 14.6 * u], fill=c, width=w)
                if name == 'mikrofon-kapali':
                    d.line([2.4 * u, 2.4 * u, 13.6 * u, 13.6 * u], fill=c, width=round(1.8 * u))
            elif name == 'not':
                d.rounded_rectangle([3 * u, 1.5 * u, 13 * u, 14.5 * u], radius=1.2 * u, outline=GOLD, width=w)
                for y in (5.2, 8, 10.8):
                    d.line([5.4 * u, y * u, 10.6 * u, y * u], fill=GOLD, width=round(1.2 * u))
            elif name == 'ayarlar':
                import math
                cx = cy = 8 * u
                for i in range(8):
                    a = i * math.pi / 4
                    d.line([cx + math.cos(a) * 4 * u, cy + math.sin(a) * 4 * u, cx + math.cos(a) * 6.8 * u, cy + math.sin(a) * 6.8 * u], fill=GOLD, width=round(2.2 * u))
                d.ellipse([cx - 4.8 * u, cy - 4.8 * u, cx + 4.8 * u, cy + 4.8 * u], outline=GOLD, width=round(2.2 * u))
            elif name == 'cik':
                d.arc([2.6 * u, 3 * u, 13.4 * u, 13.8 * u], -60, 240, fill=GOLD, width=w)
                d.line([8 * u, 1.4 * u, 8 * u, 8 * u], fill=GOLD, width=w)
            img.resize((size, size), Image.LANCZOS).save(folder / f'menu-{name}-{size}.png', optimize=True)
    for path in sorted(folder.glob('menu-*')):
        print(f'{path.stat().st_size:8d}  {path.relative_to(ROOT)}')


if __name__ == '__main__':
    if sys.argv[1:2] == ['tepsi']:
        tray_icons()
        menu_icons()
    elif sys.argv[1:2] == ['yakala']:
        mic_buttons()
    elif sys.argv[1:2] == ['kurulum']:
        installer_images()
    elif sys.argv[1:2] == ['yuz']:
        face(sys.argv[2] if len(sys.argv) > 2 else '.')
    else:
        logo()
