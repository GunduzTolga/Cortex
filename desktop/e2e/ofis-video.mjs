// The office as a short film, frame by frame: for the README or a post.
//
//   node e2e/ofis-video.mjs [--sure 24] [--fps 30] [--boyut 1920x1080] [--cikti dosya.webm]
//
// The office runs outside the app (src/office/onizleme/index.html, served here from desktop/), its time moved by
// hand (engine.step): every frame is the same on any machine, however slow. A short tour: the whole brain at the
// end of the afternoon, closer to the newsroom following someone walking, a click (the one clicked turns, hops and
// says something), the pointer through the plants, and out again as night comes; the light follows the clock from
// 16:45 to 21:15 across the film, so the evening comes in slowly.
//
// README's animation (docs/gorseller/beyin.webp) came from --kareler --sure 18 --fps 12 --boyut 960x540, the frames
// put together as an animated WebP (800 wide, quality 55).
//
// Frames go as one JPEG stream into Playwright's own ffmpeg (VP9 WebM; LinkedIn and GitHub take WebM). That ffmpeg
// reads only files (no pipe protocol), so the stream is written first. Without it (or with --kareler) the frames
// are kept as files instead. Needs Playwright's Chromium: npx playwright install chromium.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const seconds = Number(arg('sure', '24'));
const fps = Number(arg('fps', '30'));
const [width, height] = arg('boyut', '1920x1080').split('x').map(Number);
const out = resolve(arg('cikti', join(here, 'screenshots', 'ofis.webm')));
const framesOnly = process.argv.includes('--kareler');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let path;
  try { path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))); } catch { res.writeHead(400).end(); return; }
  const inside = (p) => p === root || p.startsWith(root + sep);
  if (inside(path) && existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!inside(path) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/src/office/onizleme/`;

/** Playwright's ffmpeg (it records its videos with it): ffmpeg-<n>/ffmpeg-linux | ffmpeg-mac | ffmpeg-win64.exe. */
function findFfmpeg() {
  if (process.env.OFIS_FFMPEG) return process.env.OFIS_FFMPEG;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  if (!existsSync(cache)) return null;
  const build = (d) => Number(d.split('-')[1]) || 0;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith('ffmpeg')).sort((a, b) => build(b) - build(a)))
    for (const name of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe']) if (existsSync(join(cache, dir, name))) return join(cache, dir, name);
  return null;
}

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}?elle&saat=16.75`);
await page.waitForFunction(() => window.__ready, null, { timeout: 120_000 }).catch((e) => { throw new Error(`Ofis açılmadı: ${errors.join(' | ') || e.message}`); });
// Settle in: everyone at work for a few seconds before the film starts.
await page.evaluate(() => window.__ofis.step(4));

// The tour, as a function of the film's time: where the camera is, what happens.
await page.evaluate(([seconds, w, h]) => {
  const e = window.__ofis, ease = (k) => k * k * (3 - 2 * k), lerp = (a, b, k) => a + (b - a) * k;
  const full = { zoom: e.fitZoom(), x: e.camX, y: e.camY };
  const room = { zoom: Math.min(4, full.zoom * 2.6), x: 400, y: 400 };
  let fired = {};
  const once = (key, fn) => { if (!fired[key]) { fired[key] = true; fn(); } };
  const at = (k) => k * seconds; // the tour is laid out in shares of the film
  window.__tour = (t) => {
    e.hour = 16.75 + (t / seconds) * 4.5;
    let cam;
    if (t < at(0.12)) cam = full;
    else if (t < at(0.25)) { const k = ease((t - at(0.12)) / (at(0.25) - at(0.12))); cam = { zoom: lerp(full.zoom, room.zoom, k), x: lerp(full.x, room.x, k), y: lerp(full.y, room.y, k) }; }
    else if (t < at(0.8)) cam = room;
    else { const k = ease(Math.min(1, (t - at(0.8)) / (at(0.95) - at(0.8)))); cam = { zoom: lerp(room.zoom, full.zoom, k), x: lerp(room.x, full.x, k), y: lerp(room.y, full.y, k) }; }
    e.zoom = cam.zoom; e.camX = cam.x; e.camY = cam.y; e.clampCam();
    // A click on whoever is nearest the middle of the view, then on someone else.
    const nearest = (skip) => e.agents.filter((a) => a.id !== skip && a.id !== 'tekir').sort((a, b) => Math.hypot(a.x - e.camX, a.y - e.camY) - Math.hypot(b.x - e.camX, b.y - e.camY))[0];
    if (t > at(0.36)) once('poke1', () => { const a = nearest(); e.select(a.id); e.poke(a); fired.first = a.id; });
    if (t > at(0.5)) once('poke2', () => { const a = nearest(fired.first); e.select(a.id); e.poke(a); });
    if (t > at(0.6)) once('unselect', () => e.select(null));
    // The pointer through the plants along the newsroom: a sweep left to right and back.
    if (t > at(0.62) && t < at(0.76)) { const k = (t - at(0.62)) / (at(0.76) - at(0.62)), x = 200 + 760 * Math.sin(Math.PI * k), y = 420; e.wind(x, y); }
  };
}, [seconds, width, height]);

const total = Math.round(seconds * fps);
const ff = framesOnly ? null : findFfmpeg();
const frameDir = out.replace(/\.webm$/, '') + '-kareler', stream = out.replace(/\.webm$/, '') + '.mjpeg';
mkdirSync(dirname(out), { recursive: true });
if (ff) writeFileSync(stream, ''); else mkdirSync(frameDir, { recursive: true });

for (let i = 0; i < total; i++) {
  await page.evaluate(([t, fps]) => { window.__tour(t); window.__ofis.step(1 / fps, fps); }, [i / fps, fps]);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (ff) appendFileSync(stream, jpg); else writeFileSync(join(frameDir, `k${String(i).padStart(4, '0')}.jpg`), jpg);
  if (i % (fps * 2) === 0) process.stdout.write(`\r${Math.round((i / total) * 100)}%`);
}
await browser.close();
server.close();
process.stdout.write('\r100%\n');
if (ff) {
  const code = await new Promise((ok) => spawn(ff, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', stream,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', out], { stdio: 'inherit' }).on('close', ok));
  if (code !== 0) throw new Error(`ffmpeg ${code}; kareler: ${stream}`);
  rmSync(stream);
}
if (errors.length) { console.error('Sayfa hataları:\n' + errors.join('\n')); process.exitCode = 1; }
console.log(ff ? `Video: ${out}` : `Kareler: ${frameDir}${framesOnly ? '' : ' (ffmpeg bulunamadı)'}`);
