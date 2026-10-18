// office-art.js — Cortex Ofis çizimleri
// Bağımlılıksız ES modülü. DOM'a dokunmaz; yalnız verilen 2D bağlama
// ctx.fillStyle + ctx.fillRect (tam sayı koordinat) ile çizer. Rastgelelik sabit tohumlu.
// Her sprite paint(ctx, frame, pal, ox=0, oy=0) ile (ox,oy)'dan başlayarak çizilir.
//
// Brif §9'a ek alanlar (motor için):
//  MAP.objects[i]: { id, sprite, x, y (çapa), left, top (çizim sol üstü), flip?, z? (sıralama düzeltmesi: y+z), solid? (sprite solid'ini ezer), tool? }
//  MAP.seats[i]:   { id, x, y (kare), px, py (oturan karakterin ayak pikseli), dir: 'down'|'up'|'side'|'left', object?, from? ([x,y] yaklaşma karesi) }
//  tileSprites(x,y) → o kareye sırayla çizilecek sprite adları (zemin/duvar/gölge, otomatik kenar ve varyant seçimi)
//  buildCollision() → yürünebilirlik ızgarası; checkReachability() → ulaşılamayan koltuk/nokta listesi (boş olmalı)
//  paintCharacter(..., dir) 'left' de kabul eder (side'ı aynalar). anchors(): 'up' yönünde taşınan eşya karakterden önce çizilir.
//  rack_led_<araç>.paint(ctx, f, { led: LED.ok | LED.wait | LED.off }) — LED rengi gerçek veriden.
//  light: { x, y, r, color } sprite'ın sol üstüne göre. Duvar saatlerinin akrep/yelkovanı motorda (kadran merkezi: wall_clock 7.5,6.5 · clock_big 15.5,14.5).

export const TILE = 16;

export const RAMPS = {
  k: ['#16141b', '#25222b', '#39353f', '#57525c', '#7c7780', '#a6a2a6', '#d3d0cc', '#f4f1ea'],
  s: ['#1b2130', '#2b3446', '#40506a', '#5e7090', '#8797b2', '#bcc6d6'],
  w: ['#2d1a13', '#4a2b1e', '#6c412a', '#915c38', '#b77d4c', '#d6a46e', '#ebcc98'],
  r: ['#2e1219', '#521e28', '#7b2d36', '#a33f40', '#c95f4f', '#e8907a'],
  o: ['#5a3415', '#8d5a1f', '#c4832c', '#e6a83d', '#f2c85a', '#f8e4a0'],
  g: ['#15281e', '#21402e', '#30603d', '#4a854e', '#79b265'],
  b: ['#172041', '#253764', '#37549a', '#557dc4', '#8fb5e6'],
  c: ['#12343b', '#1f5a63', '#2f8088', '#4fb0b4', '#9fe3dc'],
  p: ['#2a1c42', '#46316c', '#6a4f9c', '#9a82c9'],
  sk1: ['#dba98b', '#f4d3bb'], sk2: ['#c48e69', '#e6b88f'], sk3: ['#a87b54', '#cfa274'],
  sk4: ['#8a5a3c', '#b07850'], sk5: ['#5b3826', '#80513a'],
};
const K = RAMPS.k, S = RAMPS.s, W = RAMPS.w, R = RAMPS.r, O = RAMPS.o, G = RAMPS.g, B = RAMPS.b, C = RAMPS.c, P = RAMPS.p;

/** 62 renk, tek karakter anahtar. '.' her zaman saydam (palette'te yok). */
export const PALETTE = {};
{
  const keys = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let i = 0;
  for (const n of ['k', 's', 'w', 'r', 'o', 'g', 'b', 'c', 'p', 'sk1', 'sk2', 'sk3', 'sk4', 'sk5'])
    for (const c of RAMPS[n]) PALETTE[keys[i++]] = c;
}
/** Yarı saydam gölgeler (palet dışı, yalnız gölge için). */
export const SHADOW = 'rgba(12,10,22,0.32)';
const SH = SHADOW, SH2 = 'rgba(12,10,22,0.18)';

const RAMP_OF = {};
for (const [n, r] of Object.entries(RAMPS)) r.forEach((c, i) => { RAMP_OF[c] = [n, i]; });
function ol(c) {
  const m = RAMP_OF[c]; if (!m) return K[1];
  if (m[0].startsWith('sk')) return m[0] === 'sk5' || m[0] === 'sk4' ? W[0] : W[1];
  return m[0] === 'k' ? K[1] : RAMPS[m[0]][0];
}
function dk(c, n = 1) {
  const m = RAMP_OF[c]; if (!m) return c;
  if (m[0].startsWith('sk')) return m[1] === 1 ? RAMPS[m[0]][0] : ol(c);
  return RAMPS[m[0]][Math.max(0, m[1] - n)];
}
function lt(c, n = 1) {
  const m = RAMP_OF[c]; if (!m) return c; const r = RAMPS[m[0]];
  return r[Math.min(r.length - 1, m[1] + n)];
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── Piksel tamponu: bellekte çizilir, sonra satır satır fillRect ile basılır.
class Buf {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
  p(x, y, c) { x = Math.floor(x); y = Math.floor(y); if (c !== undefined && x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
  g(x, y) { return (x < 0 || y < 0 || x >= this.w || y >= this.h) ? null : this.d[y * this.w + x]; }
  r(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.p(x + i, y + j, c); }
  hl(x, y, w, c) { this.r(x, y, w, 1, c); }
  vl(x, y, h, c) { this.r(x, y, 1, h, c); }
  // yalnız boş piksellere
  under(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (!this.g(x + i, y + j)) this.p(x + i, y + j, c); }
  shadow(x, y, w, h, c = SH) { this.under(x, y, w, h, c); }
  // dış kontur: dolu piksele komşu boş piksel, komşunun koyu tonunu alır
  outline(skip) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const cur = this.g(x, y); if (cur && cur !== SH && cur !== SH2) continue;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const c = this.g(nx, ny);
        if (c && c !== SH && c !== SH2 && !(skip && skip.has(c))) { add.push([x, y, ol(c)]); break; }
      }
    }
    for (const [x, y, c] of add) this.p(x, y, c);
  }
  flipX() { for (let y = 0; y < this.h; y++) { const row = this.d.slice(y * this.w, y * this.w + this.w).reverse(); for (let x = 0; x < this.w; x++) this.d[y * this.w + x] = row[x]; } }
  flush(ctx, ox = 0, oy = 0) {
    const { w, h, d } = this;
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        const c = d[y * w + x]; if (!c) { x++; continue; }
        let e = x + 1; while (e < w && d[y * w + e] === c) e++;
        ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, e - x, 1); x = e;
      }
    }
  }
}

// ── Çizim yardımcıları
// 3/4 kutu: üst yüz (t satır) + ön yüz. i: ramp içindeki ön yüz rengi indeksi.
function box(b, x, y, w, h, t, ramp, i = 3, round = true) {
  const n = ramp.length - 1;
  const L = ramp[0], F = ramp[i], T = ramp[Math.min(n, i + 1)], H = ramp[Math.min(n, i + 2)], D = ramp[Math.max(1, i - 1)];
  b.r(x, y, w, h, L);
  b.r(x + 1, y + 1, w - 2, t - 1, T); b.hl(x + 1, y + 1, w - 2, H);
  if (h - t - 1 > 0) { b.r(x + 1, y + t, w - 2, h - t - 1, F); b.vl(x + w - 2, y + t, h - t - 1, D); b.hl(x + 1, y + h - 2, w - 2, D); b.hl(x + 1, y + t, w - 2, D); }
  if (round) { b.p(x, y, null); b.p(x + w - 1, y, null); }
}
// düz çerçeveli dikdörtgen
function frame(b, x, y, w, h, line, fill) { b.r(x, y, w, h, line); if (fill) b.r(x + 1, y + 1, w - 2, h - 2, fill); }
function oval(b, x, y, w, h, c) {
  const cx = x + (w - 1) / 2, cy = y + (h - 1) / 2, rx = w / 2, ry = h / 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const dx = (x + i - cx) / rx, dy = (y + j - cy) / ry; if (dx * dx + dy * dy <= 1.08) b.p(x + i, y + j, c); }
}
function line(b, x0, y0, x1, y1, c) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, e = dx + dy;
  for (let k = 0; k < 400; k++) { b.p(x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
}
function speck(b, x, y, w, h, c, dens, rnd) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (rnd() < dens) b.p(x + i, y + j, c); }
function rows(b, x, y, list, map) { list.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch === '.' || ch === ' ') continue; b.p(x + i, y + j, map && map[ch] !== undefined ? map[ch] : PALETTE[ch]); } }); }

/** Bütün sprite'lar. Biçim brif §9 ile aynı; ek olarak paint(ctx, frame, pal, ox, oy). */
export const SPRITES = {};
function def(name, w, h, o, fn) {
  const s = {
    name, w, h, ax: o.ax ?? (w >> 1), ay: o.ay ?? (h - 1), layer: o.layer || 'sorted', solid: o.solid ?? null,
    frames: o.frames || 1, fps: o.fps || 0, light: o.light || null, group: o.group || 'eşya',
    paint(ctx, frame = 0, pal = {}, ox = 0, oy = 0) { const b = new Buf(w, h); fn(b, (frame | 0) % (o.frames || 1), pal || {}); b.flush(ctx, ox, oy); },
  };
  if (o.tags) s.tags = o.tags;
  (o.into || SPRITES)[name] = s;
  return s;
}
function defRows(name, list, o = {}) {
  const fr = Array.isArray(list[0]) ? list : [list];
  const s = def(name, fr[0][0].length, fr[0].length, { ...o, frames: fr.length }, (b, f) => rows(b, 0, 0, fr[f]));
  s.rows = fr.length === 1 ? fr[0] : fr;
  return s;
}

// ═════════════ ZEMİNLER (16×16, layer 'floor') ═════════════
function floor(name, n, fn, group = 'zemin') {
  for (let v = 0; v < n; v++) def(`${name}_${v}`, 16, 16, { layer: 'floor', ax: 0, ay: 0, group }, (b) => fn(b, v, rng(1000 + v * 97 + name.length * 13)));
}
// Müdür odası: sıcak ahşap parke
floor('floor_wood', 4, (b, v, rnd) => {
  for (let p = 0; p < 4; p++) {
    const y = p * 4, light = rnd() < 0.3;
    b.r(0, y, 16, 4, light ? W[4] : W[3]); b.hl(0, y, 16, light ? W[5] : W[4]); b.hl(0, y + 3, 16, W[2]);
    const j = (p * 7 + v * 5 + 3) % 16; b.vl(j, y, 3, W[2]); b.p((j + 1) % 16, y + 1, light ? W[5] : W[4]);
    for (let k = 0; k < 2; k++) b.p(rnd() * 16, y + 1 + (rnd() * 2 | 0), light ? W[3] : W[2]);
  }
});
// Harita: gri-mavi halı
floor('floor_carpet', 2, (b, v, rnd) => {
  b.r(0, 0, 16, 16, S[3]);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x + y * 2 + v) % 4 === 0 && (y % 2 === 0)) b.p(x, y, S[2]);
  speck(b, 0, 0, 16, 16, S[4], 0.035, rnd);
});
// Arşiv: açık balıksırtı
floor('floor_herring', 2, (b, v) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const col = x >> 2, k = x & 3, yy = (y + (col % 2 ? k : 3 - k) + v * 2 + col * 2 + 32) % 32, pl = yy >> 3;
    const edge = (yy & 7) === 7;
    b.p(x, y, edge ? W[4] : ((pl + col) % 2 ? W[5] : W[6]));
  }
  for (let y = 0; y < 16; y++) for (let x = 3; x < 16; x += 4) if (b.g(x, y) !== W[4]) b.p(x, y, W[5]);
});
// Pyn: koyu kırmızı halı, kenarı desenli (mask: 1 K, 2 D, 4 G, 8 B → o yönde kenar)
for (let m = 0; m < 16; m++) def(`floor_rug_${m}`, 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'zemin' }, (b) => {
  b.r(0, 0, 16, 16, R[2]);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const a = (x + y) % 8, c = (x - y + 16) % 8;
    if (a === 0 || c === 0) b.p(x, y, R[1]);
    if (x % 8 === 4 && y % 8 === 4) b.p(x, y, R[3]);
  }
  const band = (set) => { // set(k, c) k: dıştan içe 0..4
    set(0, R[1]); set(1, O[1]); set(2, R[1]); set(3, R[1]); set(4, O[1]);
  };
  if (m & 1) band((k, c) => { b.hl(0, k, 16, c); if (k === 2) for (let x = 1; x < 16; x += 3) b.p(x, 2, O[2]); });
  if (m & 4) band((k, c) => { b.hl(0, 15 - k, 16, c); if (k === 2) for (let x = 1; x < 16; x += 3) b.p(x, 13, O[2]); });
  if (m & 8) band((k, c) => { b.vl(k, 0, 16, c); if (k === 2) for (let y = 1; y < 16; y += 3) b.p(2, y, O[2]); });
  if (m & 2) band((k, c) => { b.vl(15 - k, 0, 16, c); if (k === 2) for (let y = 1; y < 16; y += 3) b.p(13, y, O[2]); });
});
// Salon: açık gri cilalı karo
floor('floor_tile', 4, (b, v, rnd) => {
  b.r(0, 0, 16, 16, K[6]);
  if (v === 1) speck(b, 1, 1, 14, 14, S[5], 0.08, rnd);
  if (v === 2) for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) if ((x + y) % 2 === 0 && (y % 2 === 0)) b.p(x, y, S[5]);
  b.hl(0, 0, 15, K[7]); b.vl(0, 0, 15, K[7]);
  b.hl(0, 15, 16, K[5]); b.vl(15, 0, 16, K[5]);
  if (v === 3) { b.p(3, 3, K[7]); b.p(4, 2, K[7]); b.p(2, 4, K[7]); b.p(5, 3, K[7]); }
  else { b.p(3, 2, K[7]); b.p(2, 3, K[7]); }
});
// Mutfak: dama
floor('floor_checker', 2, (b, v) => {
  for (let q = 0; q < 4; q++) {
    const x = (q % 2) * 8, y = (q >> 1) * 8, dark = (q === 1 || q === 2) !== (v === 1 && false);
    b.r(x, y, 8, 8, dark ? K[3] : K[5]); b.hl(x, y, 8, dark ? K[4] : K[6]); b.vl(x, y, 8, dark ? K[4] : K[6]);
    b.p(x + 7, y + 7, dark ? K[2] : K[4]);
  }
  if (v === 1) { b.p(10, 4, K[4]); b.p(3, 12, K[6]); }
});
// Toplantı: bordo halı
floor('floor_bordo', 2, (b, v, rnd) => {
  b.r(0, 0, 16, 16, R[1]);
  for (let y = 0; y < 16; y += 2) for (let x = (y / 2 + v) % 4; x < 16; x += 4) b.p(x, y, R[2]);
  speck(b, 0, 0, 16, 16, R[0], 0.04, rnd);
});
// Sunucu: delikli yükseltilmiş döşeme
floor('floor_raised', 2, (b, v) => {
  b.r(0, 0, 16, 16, S[1]); b.hl(0, 0, 16, S[2]); b.vl(0, 0, 16, S[2]); b.hl(0, 15, 16, S[0]); b.vl(15, 0, 16, S[0]);
  if (v === 0) { for (let y = 3; y < 14; y += 3) for (let x = 3; x < 14; x += 3) b.p(x, y, S[0]); }
  else { b.r(3, 3, 10, 10, S[0]); for (let y = 4; y < 13; y += 2) b.hl(4, y, 8, S[2]); }
});
// Dinlenme: yumuşak deniz mavisi halı
floor('floor_sea', 2, (b, v, rnd) => {
  b.r(0, 0, 16, 16, C[2]);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x * 3 + y * 5 + v * 7) % 11 === 0) b.p(x, y, C[1]);
  speck(b, 0, 0, 16, 16, C[3], 0.03, rnd);
});
// Kapı eşiği
def('floor_threshold', 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'zemin' }, (b) => {
  b.r(0, 0, 16, 16, S[3]); b.hl(0, 0, 16, S[4]);
  for (let y = 3; y < 16; y += 3) b.hl(0, y, 16, S[2]);
  b.hl(0, 15, 16, S[1]);
});
// Duvar dibi gölgeleri (zemin üstüne bindirilir)
def('shade_n', 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'zemin' }, (b) => { b.hl(0, 0, 16, 'rgba(12,10,22,0.30)'); b.hl(0, 1, 16, 'rgba(12,10,22,0.20)'); b.hl(0, 2, 16, 'rgba(12,10,22,0.10)'); });
def('shade_w', 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'zemin' }, (b) => { b.vl(0, 0, 16, 'rgba(12,10,22,0.26)'); b.vl(1, 0, 16, 'rgba(12,10,22,0.12)'); });

// ═════════════ DUVARLAR ═════════════
// Duvar başlığı: 4 komşu maskesi (1 K, 2 D, 4 G, 8 B; bit = o yönde de başlık var)
for (let m = 0; m < 16; m++) def(`wall_head_${m}`, 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'duvar' }, (b) => {
  b.r(0, 0, 16, 16, S[2]);
  for (let y = 2; y < 16; y += 4) for (let x = (y % 8 === 2 ? 2 : 6); x < 16; x += 8) b.p(x, y, S[3]);
  if (!(m & 1)) { b.hl(0, 0, 16, S[0]); b.hl(0, 1, 16, S[4]); }
  if (!(m & 8)) { b.vl(0, 0, 16, S[0]); b.vl(1, 1, 15, S[3]); }
  if (!(m & 2)) { b.vl(15, 0, 16, S[0]); b.vl(14, 1, 15, S[1]); }
  if (!(m & 4)) { b.hl(0, 15, 16, S[0]); b.hl(0, 14, 16, S[1]); }
  if (!(m & 1) && !(m & 8)) b.p(0, 0, S[0]);
});
// Duvar yüzleri: her stil için 3 satır (0 üst, 1 orta, 2 süpürgelik), 2 varyant
const FACE = {};
function face(style, fn) {
  FACE[style] = [];
  for (let r = 0; r < 3; r++) { const set = []; for (let v = 0; v < 2; v++) { const n = `wall_${style}_${r}_${v}`; def(n, 16, 16, { layer: 'floor', ax: 0, ay: 0, group: 'duvar' }, (b) => { fn(b, r, v); if (r === 0) { b.hl(0, 0, 16, 'rgba(12,10,22,0.35)'); b.hl(0, 1, 16, 'rgba(12,10,22,0.15)'); } }); set.push(n); } FACE[style].push(set); }
}
face('plaster', (b, r, v) => { // müdür odası: sıcak sıva + ahşap lambri altı
  b.r(0, 0, 16, 16, K[6]); if (v) { b.p(5, 6, K[5]); b.p(11, 10, K[7]); }
  if (r === 0) b.hl(0, 3, 16, K[7]);
  if (r === 2) { b.r(0, 4, 16, 12, W[3]); b.hl(0, 4, 16, W[5]); b.hl(0, 5, 16, W[4]); b.vl(v ? 0 : 8, 6, 7, W[2]); b.r(0, 13, 16, 3, W[1]); b.hl(0, 13, 16, W[2]); }
});
face('paint', (b, r, v) => { // harita: gri-mavi boya
  b.r(0, 0, 16, 16, S[4]); if (v) b.p(9, 7, S[3]);
  if (r === 2) { b.r(0, 12, 16, 4, S[1]); b.hl(0, 12, 16, S[2]); b.hl(0, 11, 16, S[3]); }
});
face('library', (b, r, v) => {
  b.r(0, 0, 16, 16, W[4]); for (let x = v * 4; x < 16; x += 8) b.vl(x, 0, 16, W[3]);
  if (r === 2) { b.r(0, 12, 16, 4, W[1]); b.hl(0, 12, 16, W[2]); }
});
face('lambri', (b, r, v) => { // pyn: koyu ahşap lambri
  b.r(0, 0, 16, 16, W[2]);
  if (r === 0) { b.r(0, 2, 16, 3, W[3]); b.hl(0, 2, 16, W[4]); b.hl(0, 5, 16, W[1]); }
  b.vl(0, r === 0 ? 6 : 0, 16, W[1]); b.vl(1, r === 0 ? 6 : 0, 16, W[3]);
  if (r === 1) { b.r(4, 2, 9, 12, W[1]); b.r(5, 3, 7, 10, W[2]); b.hl(5, 3, 7, W[3]); b.p(8 + v, 7, W[3]); }
  if (r === 2) { b.r(4, 0, 9, 7, W[1]); b.r(5, 0, 7, 6, W[2]); b.r(0, 11, 16, 5, W[0]); b.hl(0, 11, 16, W[3]); b.hl(0, 12, 16, W[1]); }
});
face('salon', (b, r, v) => {
  b.r(0, 0, 16, 16, K[7]); if (v) { b.p(4, 9, K[6]); b.p(12, 4, K[6]); }
  if (r === 1) { b.hl(0, 13, 16, S[5]); b.hl(0, 14, 16, S[4]); }
  if (r === 2) { b.r(0, 0, 16, 11, K[6]); b.hl(0, 0, 16, K[7]); b.r(0, 11, 16, 5, S[2]); b.hl(0, 11, 16, S[4]); b.hl(0, 12, 16, S[3]); }
});
face('tile', (b, r, v) => { // mutfak: beyaz fayans
  if (r === 0) { b.r(0, 0, 16, 16, G[3]); b.hl(0, 15, 16, K[6]); b.p(6 + v * 4, 7, G[2]); return; }
  b.r(0, 0, 16, 16, K[7]);
  for (let y = 3; y < 16; y += 4) b.hl(0, y, 16, K[6]);
  for (let y = 0; y < 16; y++) b.p(((y >> 2) % 2 ? 2 : 6) + (v ? 8 : 0), y, K[6]);
  for (let y = 0; y < 16; y++) b.p(((y >> 2) % 2 ? 10 : 14) - (v ? 8 : 0), y, K[6]);
  if (r === 2) { b.r(0, 12, 16, 4, K[3]); b.hl(0, 12, 16, K[5]); }
});
face('meeting', (b, r, v) => {
  b.r(0, 0, 16, 16, K[3]); for (let x = v * 2; x < 16; x += 4) b.vl(x, 0, 16, K[2]);
  if (r === 2) { b.r(0, 2, 16, 14, W[2]); b.hl(0, 2, 16, W[4]); b.hl(0, 3, 16, W[3]); b.vl(v ? 0 : 8, 4, 8, W[1]); b.r(0, 13, 16, 3, W[0]); }
});
face('server', (b, r, v) => {
  b.r(0, 0, 16, 16, S[1]); b.vl(0, 0, 16, S[0]); b.vl(1, 0, 16, S[2]);
  if (r === 1 && v) { for (let y = 4; y < 12; y += 2) b.hl(5, y, 6, S[0]); }
  if (r === 2) { b.r(0, 12, 16, 4, S[0]); b.hl(0, 12, 16, S[2]); }
});
face('lounge', (b, r, v) => { // dinlenme: krem duvar kâğıdı, yaprak deseni
  b.r(0, 0, 16, 16, W[6]);
  for (let y = 2; y < 16; y += 6) for (let x = (y % 12 === 2 ? 3 : 10) + v; x < 16; x += 14) { b.p(x, y, G[4]); b.p(x + 1, y + 1, G[3]); }
  if (r === 2) { b.r(0, 6, 16, 10, W[3]); b.hl(0, 6, 16, W[5]); b.hl(0, 7, 16, W[4]); b.vl(v ? 4 : 12, 8, 5, W[2]); b.r(0, 13, 16, 3, W[1]); }
});

// ═════════════ SİMGELER (12×12 durum balonu) + seçim oku ═════════════
export const ICONS = {};
const IC = (n, list) => defRows(n, list, { into: ICONS, layer: 'top', group: 'simge' });
IC('tea', ['............', '...aaaaaa...', '...ahhhha...', '...ayzzya...', '....ayya....', '....axya....', '...ayzzya...', '...axyyxa...', '....aaaa....', '.aaaaaaaaaa.', '.affffffffa.', '..aaaaaaaa..']);
IC('zzz', ['............', '......NNNNN.', '.........N..', '........N...', '.......N....', '......NNNNN.', '.NNNN.......', '....N.......', '...N........', '..N.........', '.NNNN.......', '............']);
IC('file', ['............', '.aaaa.......', '.aEEaaaaaa..', '.aEEEEEEEEa.', '.aDDDDDDDDa.', '.aEhhhhhhEa.', '.aEhfffffEa.', '.aEhhhhhhEa.', '.aEhfffEEEa.', '.aEEEEEEEEa.', '.aaaaaaaaaa.', '............']);
IC('phone', ['............', '....aaaa....', '...akkkka...', '...aUVUUa...', '...aUUUUa...', '...aTTTTa...', '...aTTTTa...', '...aTTTTa...', '...akkkka...', '...akhkka...', '....aaaa....', '............']);
IC('alert', ['............', '.....aa.....', '....ayya....', '....ayya....', '....ayya....', '....ayya....', '.....yy.....', '.....aa.....', '............', '.....yy.....', '.....yy.....', '............']);
IC('idea', ['............', '....aaaa....', '...aGGFFa...', '..aGGFFFEa..', '..aGFFFEEa..', '..aFFFEEDa..', '...aFEEDa...', '....aDDa....', '....affa....', '....aeea....', '.....aa.....', '............']);
IC('heart', ['............', '............', '..aaa..aaa..', '.azAza.aya..', '.aAzyyayyxa.', '.azyyyyyyxa.', '..ayyyyyxa..', '...ayyyxa...', '....ayxa....', '.....aa.....', '............', '............']);
IC('anger', ['............', '.y..yy..y...', '..y.yy.y....', '...y..y.....', 'yy......yy..', 'yy......yy..', '...y..y.....', '..y.yy.y....', '.y..yy..y...', '............', '............', '............']);
IC('question', ['............', '....aaaa....', '...aPPPPa...', '..aPa..aPa..', '.......aPa..', '......aPa...', '.....aPa....', '.....aPa....', '......a.....', '.....aPa....', '.....aPa....', '............']);
IC('check', ['............', '............', '.........aa.', '........aKa.', '.......aKa..', '.aa...aKa...', '.aKa.aKa....', '..aKaKa.....', '...aKa......', '....a.......', '............', '............']);
IC('music', ['............', '.....aaaaa..', '.....aYYYa..', '.....aaaaa..', '.....a...a..', '.....a...a..', '.....a...a..', '..aaaa.aaaa.', '.aYYYaaYYYa.', '.aYYYa.aYYa.', '..aaa...aa..', '............']);
IC('coffee', ['............', '....f.f.....', '.....f.f....', '..aaaaaaa...', '..ahhhhhaaa.', '..ahqqqhaha.', '..ahhhhhaha.', '..ahhhhhaa..', '..ahhhhha...', '...aaaaa....', '............', '............']);
IC('note', ['............', '..aaaaaaa...', '..ahhhhhaa..', '..ahfffhaha.', '..ahhhhhhha.', '..ahffffhha.', '..ahhhhhhha.', '..ahfffhhha.', '..ahhhhhhha.', '..aaaaaaaaa.', '............', '............']);
IC('speech', ['............', '.aaaaaaaaaa.', '.ahhhhhhhha.', '.ahfffffhha.', '.ahhhhhhhha.', '.ahffffhhha.', '.ahhhhhhhha.', '.aaahaaaaaa.', '...aha......', '...aa.......', '............', '............']);
// seçim oku: altın, 2 kare (zıplama motor tarafından da eklenebilir)
defRows('select', [
  ['.aaaaaaa.', '.aFFFFEa.', '.aFFFFEa.', 'aaFFFFEaa', 'aFFFFFEDa', '.aFFFEDa.', '..aFEDa..', '...aDa...', '....a....'],
  ['.........', '.aaaaaaa.', '.aGGFFEa.', 'aaGFFFEaa', 'aGFFFFEDa', '.aFFFEDa.', '..aFEDa..', '...aDa...', '....a....'],
], { into: ICONS, layer: 'top', group: 'simge', fps: 3 });

// ═════════════ TAŞINABİLİR EŞYALAR (el noktasına çizilir, ax/ay = tutma noktası) ═════════════
export const ITEMS = {};
const IT = (n, w, h, fn, o = {}) => def(n, w, h, { into: ITEMS, layer: 'sorted', group: 'taşınır', ax: o.ax ?? (w >> 1), ay: o.ay ?? (h >> 1), ...o }, fn);
IT('folder', 12, 9, (b) => { b.r(0, 0, 5, 2, O[1]); b.r(0, 1, 12, 8, O[1]); b.r(1, 2, 10, 6, O[3]); b.hl(1, 2, 10, O[4]); b.r(2, 1, 8, 1, K[7]); b.hl(1, 7, 10, O[2]); });
IT('envelope', 10, 7, (b) => { frame(b, 0, 0, 10, 7, K[4], K[7]); line(b, 1, 1, 4, 4, K[5]); line(b, 8, 1, 5, 4, K[5]); b.p(5, 3, R[3]); b.p(4, 3, R[3]); });
IT('parcel', 12, 11, (b) => { box(b, 0, 0, 12, 11, 4, W, 4); b.vl(6, 1, 9, O[4]); b.hl(1, 6, 3, K[7]); });
IT('teaglass', 5, 8, (b) => { b.hl(0, 0, 5, K[6]); b.r(0, 1, 5, 2, R[3]); b.r(1, 3, 3, 1, R[2]); b.r(0, 4, 5, 2, R[3]); b.p(0, 1, K[7]); b.p(0, 4, K[7]); b.hl(0, 6, 5, R[2]); b.hl(0, 7, 5, K[5]); }, { ay: 6 });
IT('tray', 16, 10, (b) => {
  oval(b, 0, 3, 16, 7, K[4]); oval(b, 1, 3, 14, 6, K[6]); oval(b, 2, 4, 12, 4, K[5]);
  for (const x of [3, 7, 11]) { b.hl(x - 1, 0, 3, K[7]); b.r(x - 1, 1, 3, 2, R[3]); b.p(x, 3, R[2]); b.r(x - 1, 4, 3, 1, R[3]); b.p(x - 1, 1, K[7]); }
}, { ay: 6 });
IT('phone_item', 5, 8, (b) => { frame(b, 0, 0, 5, 8, K[1], C[3]); b.r(1, 1, 3, 2, C[4]); b.hl(1, 6, 3, K[2]); });
IT('tablet', 10, 8, (b) => { frame(b, 0, 0, 10, 8, K[1], B[2]); b.r(1, 1, 8, 6, B[3]); b.hl(2, 2, 5, B[4]); b.hl(2, 4, 4, B[4]); });
IT('book', 8, 10, (b) => { b.r(0, 0, 8, 10, B[0]); b.r(1, 0, 7, 9, B[2]); b.vl(1, 0, 9, B[1]); b.hl(2, 2, 5, O[3]); b.r(1, 9, 7, 1, K[7]); });
IT('coffee_cup', 6, 8, (b) => { b.hl(0, 0, 6, K[1]); b.r(0, 1, 6, 2, K[7]); b.r(0, 3, 6, 4, W[4]); b.hl(1, 4, 4, K[7]); b.r(1, 7, 4, 1, W[2]); }, { ay: 6 });
IT('red_pen', 3, 8, (b) => { b.r(0, 0, 3, 6, R[3]); b.vl(0, 0, 6, R[4]); b.p(1, 6, K[6]); b.p(1, 7, K[2]); });


// ═════════════ GENEL EŞYALAR ═════════════
const wall = (n, w, h, o, fn) => def(n, w, h, { layer: 'wall', ax: 0, ay: 0, ...o }, fn);
const BOOKC = [R[3], B[3], G[3], O[3], P[2], C[2], W[3], R[2], B[2], O[2], K[5]];
function potClay(b, x, y, w, h) { box(b, x, y, w, h, 2, R, 4); b.hl(x + 2, y + 1, w - 4, W[1]); b.hl(x + 1, y + h - 3, w - 2, R[3]); }
function potWhite(b, x, y, w, h) { box(b, x, y, w, h, 2, K, 6); b.hl(x + 2, y + 1, w - 4, W[1]); b.hl(x + 1, y + h - 3, w - 2, K[5]); }
function books(b, x, y, n, rnd, wmax = 7) { // yatay yığın, alttan yukarı
  for (let i = 0; i < n; i++) { const w = wmax - 2 + (rnd() * 3 | 0), c = BOOKC[(rnd() * BOOKC.length) | 0], yy = y - i * 2, xx = x + (rnd() * 2 | 0); b.r(xx, yy, w, 2, c); b.hl(xx, yy, w, lt(c)); b.p(xx + w - 1, yy + 1, K[7]); }
}
function bookRow(b, x, y, w, h, rnd) { // dik kitap sırası (raf içinde)
  let i = x; while (i < x + w) { const bw = 1 + (rnd() * 2 | 0), bh = h - (rnd() * 3 | 0), c = BOOKC[(rnd() * BOOKC.length) | 0]; if (i + bw > x + w) break; if (rnd() < 0.12) { i += 1; continue; } b.r(i, y + h - bh, bw, bh, c); b.p(i, y + h - bh, lt(c)); if (bh > 4 && rnd() < 0.5) b.p(i, y + h - bh + 2, K[7]); i += bw; }
}
function mug(b, x, y, c) { b.r(x, y, 3, 4, c); b.hl(x, y, 3, lt(c)); b.p(x + 3, y + 1, c); b.p(x + 3, y + 2, dk(c)); b.p(x, y + 3, dk(c)); }
function paper(b, x, y, w, h, lines = true) { b.r(x, y, w, h, K[7]); b.vl(x + w - 1, y, h, K[6]); if (lines) for (let j = y + 1; j < y + h - 1; j += 2) b.hl(x + 1, j, w - 3, K[5]); }
function succulent(b, x, y) { b.r(x, y + 3, 4, 3, R[4]); b.hl(x, y + 3, 4, R[5]); b.p(x + 1, y + 1, G[4]); b.p(x + 2, y, G[3]); b.r(x, y + 1, 4, 2, G[3]); b.p(x + 1, y + 2, G[4]); b.p(x + 3, y + 1, G[2]); }

// Bitkiler (2 kare hafif sallanma)
const PLANT_S = ['.....K.L....', '...LKJ.KL...', '..KLKJJKLK..', '.JKLKJKLKKJ.', 'JJKKJJKJKJJI', '.IJJKJIJJJI.', '..IJJIJIJI..', '...IIJJII...'];
def('plant_small', 16, 16, { frames: 2, fps: 1, solid: [3, 8, 10, 7] }, (b, f) => {
  PLANT_S.forEach((r, j) => rows(b, 2 + (f && j < 3 ? 1 : 0), 1 + j, [r])); b.outline();
  potClay(b, 4, 8, 8, 7); b.shadow(4, 15, 9, 1);
});
function fronds(b, list, f) {
  for (const [x0, y0, x1, y1] of list) {
    const sx = f && y1 < 10 ? 1 : 0, mx = Math.round((x0 + x1 + sx) / 2), my = Math.round((y0 + y1) / 2);
    line(b, x0, y0, x1 + sx, y1, G[2]); oval(b, mx - 1, my - 2, 3, 4, G[3]); line(b, x0, y0, mx, my, G[2]); b.p(x1 + sx, y1, G[4]); b.p(mx, my - 1, G[4]);
  }
}
def('plant_tall', 16, 32, { frames: 2, fps: 1, solid: [3, 22, 10, 9] }, (b, f) => {
  const s = f ? 1 : 0;
  b.vl(7, 12, 11, W[2]); line(b, 7, 18, 4, 13, W[2]); line(b, 8, 16, 11, 11, W[2]);
  for (const [x, y, w, h, c] of [[2 + s, 3, 6, 5, G[2]], [8 + s, 1, 6, 5, G[3]], [5 + s, 6, 7, 6, G[3]], [1, 9, 6, 5, G[3]], [9, 8, 6, 5, G[2]], [4, 12, 8, 6, G[2]], [1, 15, 5, 4, G[3]], [10, 14, 5, 4, G[3]], [6, 17, 4, 4, G[3]]]) { oval(b, x, y, w, h, c); b.p(x + 1, y + 1, G[4]); b.p(x + (w >> 1), y + (h >> 1), dk(c)); }
  b.p(5 + s, 4, G[4]); b.p(11 + s, 2, G[4]); b.p(8, 8, G[4]);
  b.outline(); potWhite(b, 3, 22, 10, 9); b.shadow(3, 31, 11, 1);
});
def('plant_bush', 16, 24, { frames: 2, fps: 1, solid: [2, 14, 12, 9] }, (b, f) => {
  const s = f ? 1 : 0;
  oval(b, 1, 3, 14, 13, G[2]); oval(b, 2 + s, 1, 9, 8, G[3]); oval(b, 7, 5, 8, 8, G[3]); oval(b, 3 + s, 2, 5, 4, G[4]);
  const rnd = rng(77); speck(b, 2, 3, 12, 11, G[4], 0.12, rnd); speck(b, 2, 8, 12, 7, G[1], 0.15, rnd);
  b.outline(); box(b, 2, 14, 12, 9, 2, W, 2); b.hl(4, 15, 8, W[1]); b.hl(3, 18, 10, W[3]); b.shadow(2, 23, 13, 1);
});
def('pineapple_plant', 16, 24, { frames: 2, fps: 1, solid: [3, 15, 10, 8] }, (b, f) => {
  const s = f ? 1 : 0;
  for (const [x1, y1] of [[1, 9], [14, 8], [3, 4], [12, 3], [0, 13], [15, 12]]) { line(b, 7, 15, x1 + (y1 < 6 ? s : 0), y1, G[3]); line(b, 8, 15, x1 + 1, y1 + 1, G[2]); }
  oval(b, 5, 6, 6, 8, O[3]); for (let y = 7; y < 13; y += 2) for (let x = 5 + (y % 4 === 1 ? 1 : 0); x < 11; x += 2) b.p(x, y, O[2]);
  b.p(6, 7, O[4]); rows(b, 5 + s, 2, ['.L.K', 'KLKJ', '.KJ.']);
  b.outline(); potClay(b, 3, 15, 10, 8); b.shadow(3, 23, 11, 1);
});
def('trash_bin', 16, 16, { solid: [3, 6, 10, 9] }, (b) => {
  b.shadow(4, 14, 10, 2); box(b, 3, 3, 10, 12, 3, K, 4); b.hl(4, 4, 8, K[2]); for (let x = 5; x < 12; x += 2) b.vl(x, 7, 6, K[3]);
  b.p(6, 3, K[7]); b.p(7, 2, K[7]); b.p(8, 3, K[6]);
});
def('recycle_bin', 16, 16, { solid: [3, 6, 10, 9] }, (b) => {
  b.shadow(4, 14, 10, 2); box(b, 3, 3, 10, 12, 3, G, 3); b.hl(4, 4, 8, G[1]);
  rows(b, 5, 7, ['.LL..', 'L..L.', '.L.LL', 'LL.L.', '..LL.'].map(r => r.replace(/L/g, 'h')));
});
def('water_cooler', 16, 32, { frames: 3, fps: 3, solid: [3, 18, 10, 12], light: null }, (b, f) => {
  b.shadow(3, 30, 12, 2);
  box(b, 3, 13, 10, 18, 3, K, 6);                 // gövde
  b.r(5, 18, 6, 4, K[3]); b.p(6, 19, R[4]); b.p(9, 19, B[3]); b.hl(6, 21, 4, K[5]);   // musluk yuvası
  b.r(5, 26, 6, 3, K[5]); b.hl(5, 26, 6, K[6]);
  frame(b, 4, 1, 8, 13, B[1], C[3]); b.r(5, 2, 6, 11, C[3]); b.vl(5, 2, 10, C[4]); b.r(6, 0, 4, 2, B[1]); b.hl(7, 0, 2, B[2]);
  b.hl(5, 4, 6, C[2]); // su seviyesi
  const bub = [[[7, 11], [9, 8]], [[8, 9], [7, 6]], [[9, 11], [7, 7], [8, 5]]][f];
  for (const [x, y] of bub) b.p(x, y, K[7]);
});
def('coat_rack', 16, 32, { solid: [5, 26, 6, 4] }, (b) => {
  b.shadow(3, 30, 11, 2); b.vl(7, 3, 26, W[1]); b.vl(8, 3, 26, W[3]); b.hl(4, 29, 8, W[1]); b.hl(5, 28, 6, W[2]);
  b.r(6, 2, 4, 2, W[2]); b.p(4, 4, W[2]); b.p(11, 4, W[2]);
  b.r(2, 5, 6, 13, B[2]); b.vl(2, 5, 13, B[1]); b.r(3, 6, 2, 10, B[3]); b.hl(2, 5, 6, B[3]);   // mont
  b.r(10, 5, 2, 15, R[2]); b.vl(11, 5, 15, R[3]); b.r(9, 20, 3, 2, R[1]);   // şemsiye
});
def('coat_rack_bag', 16, 32, { solid: [5, 26, 6, 4] }, (b) => {
  b.shadow(3, 30, 11, 2); b.vl(7, 3, 26, W[1]); b.vl(8, 3, 26, W[3]); b.hl(4, 29, 8, W[1]); b.hl(5, 28, 6, W[2]);
  b.r(6, 2, 4, 2, W[2]); line(b, 4, 4, 9, 12, W[1]); line(b, 11, 4, 6, 12, W[1]);  // askı kayışları
  box(b, 3, 11, 10, 9, 3, O, 2); b.r(5, 15, 6, 2, O[1]); b.p(7, 15, K[6]); b.p(8, 15, K[6]);  // kurye çantası
  b.r(10, 4, 3, 4, R[3]); b.hl(10, 4, 3, R[4]); // kask/şapka
});
function dial(b, x, y, d, rim, face) { oval(b, x, y, d, d, rim); oval(b, x + 1, y + 1, d - 2, d - 2, face); const c = x + (d >> 1), m = y + (d >> 1); for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { const r = (d >> 1) - 2; b.p(c + dx * r - (dx > 0 ? 1 : 0), m + dy * r - (dy > 0 ? 1 : 0), K[3]); } b.p(c, m, K[2]); b.p(c - 1, m - 1, K[2]); }
wall('wall_clock', 16, 16, {}, (b) => { dial(b, 2, 1, 12, K[2], K[7]); b.shadow(4, 13, 10, 1, SH2); b.p(4, 3, K[6]); });
wall('clock_big', 32, 32, {}, (b) => {
  oval(b, 2, 1, 28, 28, W[1]); oval(b, 3, 2, 26, 26, W[3]); oval(b, 5, 4, 22, 22, K[7]);
  const c = 15.5, m = 14.5; for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6, r = k % 3 ? 9 : 8.5; b.p(Math.round(c + Math.sin(a) * r), Math.round(m - Math.cos(a) * r), k % 3 ? K[4] : K[2]); if (k % 3 === 0) b.p(Math.round(c + Math.sin(a) * (r - 1)), Math.round(m - Math.cos(a) * (r - 1)), K[2]); }
  b.r(15, 14, 2, 2, K[1]); b.p(8, 7, K[6]); b.shadow(5, 29, 22, 1, SH2);
});
wall('fire_ext', 16, 16, {}, (b) => {
  b.r(5, 1, 6, 2, K[3]); b.r(9, 0, 4, 2, K[2]); b.p(12, 2, K[2]);
  b.r(5, 3, 6, 12, R[0]); b.r(6, 3, 4, 11, R[3]); b.vl(6, 3, 11, R[4]); b.vl(9, 4, 10, R[2]); b.r(6, 7, 4, 3, K[7]); b.hl(6, 8, 4, R[3]);
  b.shadow(6, 15, 6, 1, SH2);
});
wall('ac_unit', 32, 16, {}, (b) => {
  frame(b, 0, 1, 32, 12, K[3], K[7]); b.hl(1, 2, 30, K[7]); b.r(1, 9, 30, 3, K[6]); for (let x = 3; x < 29; x += 2) b.p(x, 10, K[5]);
  b.p(27, 4, G[4]); b.hl(2, 6, 10, K[6]); b.shadow(1, 13, 31, 2, SH2);
});
wall('window_blinds', 32, 32, {}, (b) => {
  frame(b, 0, 0, 32, 30, S[1], S[3]); b.r(2, 2, 28, 26, S[4]);
  for (let y = 3; y < 20; y += 2) { b.hl(2, y, 28, K[6]); b.hl(2, y + 1, 28, K[5]); }
  b.r(2, 20, 28, 8, B[4]); b.r(2, 24, 28, 4, S[4]); b.p(8, 22, K[7]); b.p(22, 21, K[7]); // aralıktan ışık
  b.vl(26, 3, 18, K[4]); b.r(25, 20, 3, 2, K[3]);
  b.hl(0, 29, 32, S[2]); b.hl(1, 30, 30, S[0]); b.shadow(1, 31, 31, 1, SH2);
});
// Ekranlar: kayan satır / grafik / liste
function screenArt(b, x, y, w, h, kind, f) {
  const bg = kind === 'term' ? K[0] : kind === 'off' ? K[2] : B[0];
  b.r(x, y, w, h, bg);
  if (kind === 'off') { b.p(x + 1, y + 1, K[3]); b.hl(x + 1, y + 1, Math.min(4, w - 2), K[3]); return; }
  if (kind === 'text' || kind === 'term') {
    const fg = kind === 'term' ? G[4] : C[4], fg2 = kind === 'term' ? G[3] : C[3], rnd = rng(9);
    const L = []; for (let i = 0; i < 12; i++) L.push(2 + (rnd() * (w - 5) | 0));
    for (let j = 0; j * 2 + 1 < h - 1; j++) { const len = Math.min(w - 3, L[(j + f) % L.length]); b.hl(x + 1 + (j % 3 === 1 ? 1 : 0), y + 1 + j * 2, len, j % 4 === 0 ? fg : fg2); }
    const cy = y + 1 + Math.min(((h - 2) >> 1) - 1, 3) * 2; if (f !== 1) b.p(x + w - 3, cy, K[7]);
  }
  if (kind === 'chart') {
    b.hl(x + 1, y + h - 2, w - 2, B[2]); b.vl(x + 1, y + 1, h - 2, B[2]);
    let py = y + h - 3; const rnd = rng(31 + f * 5);
    for (let i = x + 2; i < x + w - 1; i++) { const ny = Math.max(y + 1, Math.min(y + h - 3, py + (rnd() < 0.5 ? -1 : 1) - (i % 5 === 0 ? 1 : 0))); b.p(i, ny, C[4]); b.p(i, ny + 1, C[2]); py = ny; }
  }
  if (kind === 'bars') { for (let i = 0; i < (w - 3) / 3; i++) { const bh = 2 + ((i * 5 + f * 3) % (h - 3)); b.r(x + 2 + i * 3, y + h - 1 - bh, 2, bh, i % 2 ? O[4] : C[3]); } }
  if (kind === 'list') { for (let j = 0; j * 3 + 2 < h; j++) { const yy = y + 1 + j * 3; if (j === f % Math.max(1, Math.floor((h - 1) / 3))) b.r(x + 1, yy - 1 + 1, w - 2, 2, B[2]); b.p(x + 2, yy + 1, j % 2 ? O[4] : C[4]); b.hl(x + 4, yy + 1, w - 7 - (j * 3) % 5, K[6]); } }
  if (kind === 'nodes') {
    const pts = [[2, 2], [7, 4], [4, 7], [10, 2], [11, 7], [8, 9]].map(([a, c]) => [x + Math.round(a * (w - 2) / 12), y + Math.round(c * (h - 2) / 10) + 1]);
    for (const [i, j] of [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [2, 5]]) line(b, pts[i][0], pts[i][1], pts[j][0], pts[j][1], B[2]);
    pts.forEach(([px, py], i) => { b.p(px, py, i === (f * 2) % 6 ? O[4] : C[4]); });
  }
}
function wallScreen(n, w, h, kind, fr = 3) {
  wall(n, w, h, { frames: fr, fps: 1, light: { x: w >> 1, y: h >> 1, r: Math.max(w, h), color: '#5fd0e0' } }, (b, f) => {
    frame(b, 0, 0, w, h - 2, K[0], K[1]); screenArt(b, 2, 2, w - 4, h - 6, kind, f); b.p(w - 4, h - 4, G[4]); b.shadow(1, h - 2, w - 1, 2, SH2);
  });
}
wallScreen('screen_list_s', 32, 24, 'list'); wallScreen('screen_chart_s', 32, 24, 'chart');
wallScreen('tv_dash', 48, 32, 'chart'); wallScreen('tv_list', 48, 32, 'list');
function framed(b, x, y, w, h, frameC) { b.r(x, y, w, h, dk(frameC, 2)); b.r(x + 1, y + 1, w - 2, h - 2, frameC); b.hl(x + 1, y + 1, w - 2, lt(frameC)); b.shadow(x + 1, y + h, w, 1, SH2); }
wall('poster_cortex', 24, 32, {}, (b) => {
  framed(b, 0, 0, 24, 31, K[2]); b.r(2, 2, 20, 27, O[5]); b.r(2, 22, 20, 7, B[1]);
  oval(b, 8, 9, 8, 11, O[3]); for (let y = 10; y < 19; y += 2) for (let x = 9 + (y % 4 === 2 ? 1 : 0); x < 16; x += 2) b.p(x, y, O[1]);
  b.p(10, 13, K[1]); b.p(13, 13, K[1]); b.hl(10, 16, 4, O[1]); rows(b, 8, 3, ['..K.L..', '.LKJK.K', 'KJLKJL.', '..JKJ..', '...K...']);
  b.hl(5, 24, 14, O[4]); b.hl(7, 26, 10, K[6]);
});
wall('poster_wave', 24, 32, {}, (b) => {
  framed(b, 0, 0, 24, 31, W[2]); b.r(2, 2, 20, 27, B[4]); oval(b, 13, 5, 6, 6, O[4]);
  for (let x = 2; x < 22; x++) { const h1 = 14 + Math.round(Math.sin(x / 3) * 2); b.r(x, h1, 1, 29 - h1, C[2]); const h2 = 20 + Math.round(Math.cos(x / 2.5) * 2); b.r(x, h2, 1, 29 - h2, B[2]); b.p(x, h1, C[3]); }
});
wall('painting_a', 16, 20, {}, (b) => { framed(b, 0, 0, 16, 19, O[1]); b.r(2, 2, 12, 15, K[7]); b.r(3, 9, 10, 7, G[3]); b.r(3, 12, 10, 4, G[2]); oval(b, 9, 3, 4, 4, R[4]); b.vl(5, 6, 4, W[2]); oval(b, 3, 4, 5, 4, G[4]); });
wall('painting_b', 16, 20, {}, (b) => { framed(b, 0, 0, 16, 19, K[1]); b.r(2, 2, 12, 15, P[3]); b.r(2, 10, 12, 7, P[1]); b.r(4, 4, 4, 9, O[4]); b.r(9, 6, 3, 7, R[4]); b.hl(2, 12, 12, P[0]); });
wall('sticky_board', 32, 24, {}, (b) => {
  frame(b, 0, 0, 32, 22, W[1], W[4]); speck(b, 1, 1, 30, 20, W[3], 0.25, rng(5)); const cs = [O[4], A_PINK(), C[4], L_GRN(), O[4], B[4]], rnd = rng(8);
  for (let i = 0; i < 7; i++) { const x = 2 + (i % 4) * 7 + (rnd() * 2 | 0), y = 2 + (i >> 2) * 9 + (rnd() * 2 | 0), c = cs[i % cs.length]; b.r(x, y, 6, 6, c); b.hl(x, y, 6, lt(c)); b.p(x + 2, y, R[3]); b.hl(x + 1, y + 3, 4, dk(c)); }
  b.shadow(1, 22, 31, 1, SH2);
});
function A_PINK() { return R[5]; } function L_GRN() { return G[4]; }
wall('room_sign', 14, 8, {}, (b) => { frame(b, 0, 0, 14, 7, S[0], S[2]); b.hl(1, 1, 12, S[3]); b.hl(3, 3, 8, S[4]); b.p(2, 3, O[4]); b.shadow(1, 7, 13, 1, SH2); });
def('stool', 16, 16, {}, (b) => { b.shadow(3, 14, 11, 2); b.vl(4, 7, 7, K[2]); b.vl(11, 7, 7, K[2]); b.hl(4, 11, 8, K[3]); oval(b, 2, 3, 12, 6, W[1]); oval(b, 3, 3, 10, 5, W[4]); b.hl(5, 4, 5, W[5]); });
def('stool_high', 16, 24, {}, (b) => { b.shadow(3, 22, 11, 2); b.vl(4, 7, 15, K[2]); b.vl(11, 7, 15, K[2]); b.hl(4, 16, 8, K[3]); oval(b, 2, 2, 12, 7, K[1]); oval(b, 3, 2, 10, 6, K[3]); b.hl(5, 3, 5, K[4]); });

// Sandalyeler: renk × yön (down: kişi aşağı bakar, sırtlık arkada | up: sırtlık önde | side: sağa bakar)
const CH = { orange: [O, 2], grey: [K, 3], teal: [C, 2], green: [G, 2], red: [R, 3], blue: [B, 2], purple: [P, 2], mustard: [O, 3], navy: [B, 1], black: [K, 2], tan: [W, 3] };
function chairBase(b, cx = 8) { b.shadow(cx - 6, 21, 13, 2); b.hl(cx - 6, 20, 12, K[2]); for (const x of [cx - 6, cx - 1, cx, cx + 5]) b.p(x, 21, K[1]); b.r(cx - 1, 14, 2, 6, K[3]); b.vl(cx - 1, 14, 6, K[4]); }
for (const [cn, [ramp, i]] of Object.entries(CH)) {
  def(`chair_${cn}_down`, 16, 24, { group: 'sandalye' }, (b) => { chairBase(b); box(b, 3, 0, 10, 11, 3, ramp, Math.max(1, i - 1)); b.hl(5, 5, 6, ramp[Math.max(1, i - 1)]); box(b, 2, 9, 12, 6, 3, ramp, i); b.r(1, 9, 2, 5, K[2]); b.r(13, 9, 2, 5, K[2]); b.p(1, 9, K[3]); b.p(13, 9, K[3]); });
  def(`chair_${cn}_up`, 16, 24, { group: 'sandalye' }, (b) => { chairBase(b); b.r(1, 9, 2, 5, K[2]); b.r(13, 9, 2, 5, K[2]); box(b, 2, 0, 12, 14, 2, ramp, i); b.hl(4, 7, 8, ramp[Math.max(1, i - 1)]); b.vl(7, 3, 9, lt(ramp[i])); });
  def(`chair_${cn}_side`, 16, 24, { group: 'sandalye' }, (b) => { b.shadow(2, 21, 13, 2); b.hl(3, 20, 10, K[2]); b.p(3, 21, K[1]); b.p(12, 21, K[1]); b.r(7, 14, 2, 6, K[3]); box(b, 3, 10, 10, 5, 3, ramp, i); b.r(5, 8, 7, 2, K[2]); box(b, 1, 0, 5, 15, 2, ramp, Math.max(1, i - 1)); });
}
// Ahşap sandalye (mutfak, arşiv)
for (const dir of ['down', 'up', 'side']) def(`chair_wood_${dir}`, 16, 24, { group: 'sandalye' }, (b) => {
  b.shadow(3, 22, 11, 2);
  if (dir === 'side') { b.vl(3, 13, 9, W[1]); b.vl(11, 13, 9, W[1]); box(b, 2, 11, 11, 4, 3, W, 3); b.r(2, 1, 3, 11, W[1]); b.vl(3, 2, 9, W[4]); return; }
  b.vl(3, 14, 8, W[1]); b.vl(12, 14, 8, W[1]); b.vl(5, 15, 6, W[2]); b.vl(10, 15, 6, W[2]);
  if (dir === 'down') { b.r(3, 1, 10, 3, W[1]); b.r(4, 1, 8, 2, W[4]); b.vl(4, 3, 8, W[1]); b.vl(11, 3, 8, W[1]); b.vl(7, 3, 8, W[2]); b.vl(8, 3, 8, W[3]); box(b, 2, 10, 12, 5, 3, W, 3); }
  else { box(b, 2, 10, 12, 5, 3, W, 3); b.r(3, 1, 10, 3, W[1]); b.r(4, 1, 8, 2, W[4]); b.vl(3, 3, 12, W[1]); b.vl(12, 3, 12, W[1]); b.vl(4, 3, 11, W[3]); b.vl(11, 3, 11, W[3]); b.r(6, 4, 4, 8, W[2]); b.vl(6, 4, 8, W[3]); }
});
def('chair_plastic', 16, 20, { group: 'sandalye' }, (b) => { b.shadow(3, 18, 11, 2); b.vl(3, 11, 7, K[2]); b.vl(12, 11, 7, K[2]); box(b, 3, 0, 10, 9, 2, B, 2); box(b, 2, 8, 12, 5, 3, B, 3); });
def('desk_lamp', 12, 16, { frames: 2, fps: 0, light: { x: 6, y: 9, r: 26, color: '#ffc46b' } }, (b, f) => {
  b.r(3, 13, 6, 2, K[1]); b.hl(4, 13, 4, K[3]); line(b, 5, 12, 3, 7, K[2]); line(b, 3, 7, 7, 3, K[2]);
  b.r(5, 1, 6, 4, f ? O[1] : O[3]); b.hl(6, 1, 4, f ? O[2] : O[4]); b.r(5, 4, 6, 1, K[1]); if (!f) { b.hl(6, 5, 4, O[5]); b.p(8, 6, O[5]); }
});
def('floor_lamp', 16, 32, { light: { x: 8, y: 6, r: 44, color: '#ffc46b' }, solid: [4, 26, 8, 5] }, (b) => {
  b.shadow(3, 30, 11, 2); oval(b, 4, 27, 8, 4, K[1]); oval(b, 5, 27, 6, 3, K[3]); b.vl(7, 9, 19, K[1]); b.vl(8, 9, 19, K[3]);
  b.r(3, 1, 10, 9, O[1]); b.r(4, 1, 8, 8, O[4]); b.vl(4, 1, 8, O[5]); b.vl(11, 2, 7, O[3]); b.hl(3, 0, 10, O[1]); b.hl(4, 9, 8, O[5]);
});
function bookshelf(n, ramp, i, seed, o = {}) {
  def(n, 32, 48, { solid: [0, 38, 32, 9], ...o }, (b) => {
    const rnd = rng(seed); b.shadow(1, 46, 31, 2);
    box(b, 0, 0, 32, 47, 3, ramp, i, false);
    for (let s = 0; s < 4; s++) { const y = 4 + s * 10; b.r(2, y, 28, 8, ramp[Math.max(0, i - 2)]); bookRow(b, 2, y + 1, 28, 7, rnd); b.hl(2, y + 8, 28, ramp[i + 1] || ramp[i]); b.hl(1, y + 9, 30, ramp[Math.max(1, i - 1)]); }
  });
}
bookshelf('bookshelf', W, 4, 21); bookshelf('bookshelf_dark', W, 2, 22, { layer: 'wall', ax: 0, ay: 0 });
def('door_glass', 32, 48, { layer: 'wall', ax: 0, ay: 0, frames: 4, fps: 8 }, (b, f) => {
  const open = [0, 5, 10, 14][f];
  b.r(0, 0, 32, 48, S[1]); b.r(1, 0, 30, 3, S[3]); b.hl(1, 0, 30, S[4]);
  b.r(2, 3, 28, 45, null);
  for (const side of [0, 1]) {
    const w = 14 - open; if (w <= 0) continue; const x = side ? 30 - w : 2;
    b.r(x, 3, w, 45, S[2]); b.r(x + 1, 4, w - 2, 43, C[3]); b.r(x + 1, 4, w - 2, 43, 'rgba(159,227,220,0.55)');
    if (w > 3) { line(b, x + 2, 10, x + Math.min(w - 2, 6), 6, K[7]); b.p(x + 2, 12, K[7]); }
    b.vl(side ? x : x + w - 1, 3, 45, S[4]); b.r(side ? x + 1 : x + w - 3, 24, 2, 6, S[0]);
  }
  b.vl(0, 0, 48, S[0]); b.vl(31, 0, 48, S[0]); b.vl(1, 3, 45, S[2]); b.vl(30, 3, 45, S[2]);
});

// ═════════════ ASANSÖR VE POSTA EŞYALARI ═════════════
wall('elevator', 40, 48, { frames: 5, fps: 6, light: { x: 16, y: 4, r: 10, color: '#ffb347' } }, (b, f) => {
  b.r(0, 0, 32, 48, S[2]); b.r(1, 1, 30, 47, S[3]); b.hl(1, 1, 30, S[4]);
  b.r(9, 2, 14, 6, K[0]); b.r(10, 3, 12, 4, K[1]); rows(b, 14, 3, ['DED', '..E', '.DD', '..E'].map(r => r.replace(/[DE]/g, 'E'))); b.p(11, 4, O[3]); b.p(11, 5, O[2]); // kat göstergesi
  const gap = [0, 4, 10, 16, 22][f], cx = 16;
  b.r(3, 9, 26, 39, K[2]); b.r(4, 10, 24, 38, K[3]); b.r(4, 40, 24, 8, K[4]); b.hl(4, 10, 24, K[2]);
  const dw = 12 - (gap >> 1);
  if (dw > 0) {
    for (const s of [0, 1]) { const x = s ? cx + (gap >> 1) : cx - (gap >> 1) - dw; b.r(x, 9, dw, 39, S[4]); b.vl(x, 9, 39, S[5]); b.vl(x + dw - 1, 9, 39, S[3]); b.hl(x, 9, dw, S[5]); for (let y = 16; y < 46; y += 10) b.hl(x + 1, y, dw - 2, S[3]); }
    if (gap === 0) b.vl(cx, 9, 39, S[2]);
  }
  b.vl(2, 8, 40, S[1]); b.vl(29, 8, 40, S[1]); b.hl(2, 8, 28, S[1]);
  frame(b, 34, 18, 5, 10, S[1], S[3]); b.p(36, 20, O[4]); b.p(36, 24, K[6]);
});
wall('mail_slots', 48, 32, {}, (b) => {
  const rnd = rng(41); box(b, 0, 0, 48, 31, 3, W, 3, false);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
    const x = 2 + c * 7 + (c > 2 ? 2 : 0), y = 4 + r * 8; b.r(x, y, 6, 7, W[1]); b.hl(x, y + 6, 6, W[4]);
    const k = rnd(); if (k < 0.75) { const col = [K[7], K[7], O[5], R[5], B[4], C[4]][(rnd() * 6) | 0]; const h = 2 + (rnd() * 3 | 0); b.r(x + 1, y + 6 - h, 4, h, col); b.hl(x + 1, y + 6 - h, 4, K[7]); if (k < 0.3) b.r(x + 2, y + 6 - h - 1, 4, 1, O[4]); }
  }
  b.r(2, 28, 44, 2, W[2]); for (let c = 0; c < 6; c++) b.p(4 + c * 7 + (c > 2 ? 2 : 0), 29, O[4]); b.shadow(1, 31, 47, 1, SH2);
});
def('sorting_table', 48, 32, { solid: [0, 14, 48, 15] }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 0, 8, 48, 22, 14, W, 4);
  b.r(2, 23, 2, 6, W[2]); b.r(44, 23, 2, 6, W[2]); b.r(5, 23, 38, 4, W[2]); for (let x = 7; x < 42; x += 6) { b.r(x, 24, 4, 2, K[7]); b.p(x + 1, 24, R[3]); } // alt raf zarfları
  for (let i = 0; i < 5; i++) { b.r(4, 16 - i * 2, 9, 2, i % 2 ? K[6] : K[7]); b.p(8, 16 - i * 2, R[3]); }        // zarf yığını
  for (let i = 0; i < 3; i++) { b.r(15, 16 - i * 2, 8, 2, i % 2 ? O[5] : K[7]); }
  b.r(26, 13, 4, 3, W[1]); b.r(27, 10, 2, 3, W[2]); b.p(27, 10, W[4]); b.r(26, 16, 4, 1, R[3]);  // damga
  oval(b, 33, 12, 6, 5, O[2]); oval(b, 35, 13, 2, 3, W[4]); b.hl(38, 15, 4, O[4]);                // koli bandı
  b.r(41, 11, 5, 5, W[4]); b.hl(41, 11, 5, W[5]); b.vl(43, 11, 5, O[4]);                         // küçük koli
});
def('reception', 48, 32, { frames: 3, fps: 1, solid: [0, 12, 48, 18], light: { x: 24, y: 6, r: 30, color: '#5fd0e0' } }, (b, f) => {
  b.shadow(1, 30, 47, 2);
  for (const mx of [7, 26]) { frame(b, mx, 0, 15, 11, K[0], K[1]); screenArt(b, mx + 1, 1, 13, 8, mx < 20 ? 'list' : 'text', f); b.r(mx + 6, 11, 3, 2, K[2]); }
  box(b, 0, 12, 48, 18, 6, K, 6); b.r(1, 18, 46, 11, W[3]); b.hl(1, 18, 46, W[5]); b.vl(46, 18, 11, W[2]); b.hl(1, 28, 46, W[2]);
  for (let x = 6; x < 44; x += 12) b.vl(x, 20, 7, W[2]);
  succulent(b, 42, 10); b.r(3, 13, 3, 2, K[3]); b.hl(17, 14, 6, K[2]);
});
def('scanner', 16, 24, { frames: 3, fps: 2, solid: [1, 12, 14, 10] }, (b, f) => {
  b.shadow(1, 22, 15, 2); box(b, 1, 12, 14, 11, 3, K, 3); b.r(3, 16, 10, 2, K[2]); b.hl(4, 19, 8, K[4]);
  box(b, 2, 3, 12, 10, 4, K, 5); b.r(4, 4, 8, 2, K[2]); b.p(12, 9, G[4]);
  const out = [0, 2, 4][f]; if (out) { b.r(4, 9 - 0, 8, 1, K[1]); paper(b, 4, 9, 8, out, false); }
});
def('boxes_stack', 16, 24, { solid: [1, 12, 14, 10] }, (b) => {
  b.shadow(1, 22, 15, 2); box(b, 1, 10, 14, 13, 4, W, 4); b.vl(8, 11, 3, O[4]); b.r(3, 16, 4, 3, K[7]); b.hl(3, 17, 4, K[5]);
  box(b, 3, 1, 11, 10, 4, W, 4); b.vl(8, 2, 3, O[4]); b.p(5, 7, R[3]); b.p(6, 7, R[3]);
});
def('box_single', 16, 16, { solid: [2, 6, 12, 8] }, (b) => { b.shadow(2, 14, 13, 2); box(b, 2, 3, 12, 12, 4, W, 4); b.vl(8, 4, 3, O[4]); b.r(4, 9, 5, 3, K[7]); });
def('mail_cart', 16, 16, { solid: [1, 4, 14, 10] }, (b) => {
  b.shadow(1, 14, 15, 2); b.p(3, 14, K[1]); b.p(12, 14, K[1]); b.vl(14, 1, 9, K[3]); b.hl(13, 1, 3, K[3]);
  box(b, 1, 4, 13, 10, 3, S, 3); for (let x = 3; x < 12; x += 3) { b.r(x, 3, 2, 3, K[7]); b.p(x, 3, x % 2 ? O[5] : R[5]); }
});

// ═════════════ HARİTA ODASI ═════════════
wall('corkboard', 192, 40, {}, (b) => {
  const rnd = rng(1234);
  frame(b, 0, 2, 192, 36, W[1], W[3]); b.hl(1, 3, 190, W[4]); b.r(2, 4, 188, 32, O[2]); speck(b, 2, 4, 188, 32, O[1], 0.18, rnd); speck(b, 2, 4, 188, 32, O[3], 0.1, rnd);
  const notes = [], cols = [O[5], K[7], C[4], R[5], G[4], B[4], O[4]];
  for (let i = 0; i < 18; i++) { const x = 5 + i * 10 + (rnd() * 4 | 0), y = 6 + ((i * 7) % 3) * 9 + (rnd() * 4 | 0); notes.push([x, y, cols[(rnd() * cols.length) | 0]]); }
  const links = [[0, 1], [1, 3], [2, 3], [3, 6], [4, 5], [5, 8], [6, 7], [7, 10], [8, 9], [9, 12], [10, 11], [11, 14], [12, 13], [13, 16], [14, 15], [15, 17], [2, 6], [9, 13], [1, 4]];
  for (const [a, c] of links) line(b, notes[a][0] + 3, notes[a][1] + 1, notes[c][0] + 3, notes[c][1] + 1, R[3]);
  for (const [x, y, c] of notes) { b.shadow(x + 1, y + 1, 7, 7, SH2); b.r(x, y, 7, 6, c); b.hl(x, y, 7, lt(c)); b.hl(x + 1, y + 3, 5, dk(c)); b.hl(x + 1, y + 4, 3, dk(c)); b.p(x + 3, y + 1, R[3]); b.p(x + 3, y, R[4]); }
  b.shadow(1, 38, 191, 2, SH2);
});
def('map_table', 48, 32, { solid: [0, 12, 48, 18] }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 0, 8, 48, 22, 14, W, 3); b.r(3, 22, 3, 7, W[1]); b.r(42, 22, 3, 7, W[1]);
  b.r(4, 10, 34, 11, B[4]); b.r(5, 11, 32, 9, K[7]);   // açık plan
  for (let x = 7; x < 37; x += 4) b.vl(x, 11, 9, B[4]); for (let y = 13; y < 20; y += 3) b.hl(5, y, 32, B[4]);
  b.r(9, 12, 7, 4, B[3]); b.r(19, 15, 9, 3, C[3]); line(b, 14, 16, 22, 15, R[3]); b.r(30, 12, 4, 6, G[4]); b.p(31, 13, R[3]);
  b.hl(3, 20, 18, O[3]); for (let x = 4; x < 20; x += 2) b.p(x, 19, O[1]);  // cetvel
  line(b, 40, 11, 44, 15, R[3]); line(b, 41, 11, 45, 15, B[2]); b.p(41, 17, K[2]); b.hl(40, 18, 4, K[2]);
});
def('whiteboard_wheels', 32, 40, { solid: [2, 32, 28, 6] }, (b) => {
  b.shadow(2, 38, 29, 2); b.vl(3, 26, 11, K[2]); b.vl(28, 26, 11, K[2]); b.hl(2, 36, 6, K[2]); b.hl(24, 36, 6, K[2]); b.p(2, 37, K[1]); b.p(7, 37, K[1]); b.p(24, 37, K[1]); b.p(29, 37, K[1]);
  frame(b, 0, 0, 32, 28, K[3], K[7]); b.hl(1, 1, 30, K[6]); b.vl(30, 1, 26, K[6]);
  frame(b, 3, 4, 8, 6, B[2], K[7]); frame(b, 18, 3, 10, 6, R[3], K[7]); frame(b, 9, 16, 10, 6, G[3], K[7]);
  line(b, 11, 7, 17, 6, B[2]); b.p(16, 5, B[2]); b.p(16, 7, B[2]); line(b, 22, 9, 16, 15, K[3]); b.p(16, 14, K[3]); b.p(17, 15, K[3]);
  b.hl(4, 24, 12, K[5]); b.r(20, 25, 6, 2, K[3]); b.hl(20, 25, 2, R[3]); b.hl(23, 25, 2, B[2]);
});
def('paper_basket', 16, 24, { solid: [2, 12, 12, 10] }, (b) => {
  for (const [x, c, h] of [[4, K[7], 13], [7, B[4], 15], [9, K[6], 12], [11, O[5], 14]]) { b.r(x, 22 - h, 2, h, c); b.hl(x, 22 - h, 2, K[5]); }
  b.shadow(2, 22, 13, 2); box(b, 2, 12, 12, 11, 2, W, 4); for (let y = 14; y < 21; y += 2) b.hl(3, y, 10, W[3]); for (let x = 4; x < 13; x += 3) b.vl(x, 13, 9, W[3]);
});
def('flat_files', 32, 24, { solid: [0, 8, 32, 14] }, (b) => {
  b.shadow(1, 22, 31, 2); box(b, 0, 2, 32, 21, 6, S, 3); for (let y = 9; y < 21; y += 3) { b.hl(1, y, 30, S[2]); b.r(13, y + 1, 6, 1, S[5]); }
  paper(b, 3, 3, 12, 3, false); b.r(18, 4, 8, 2, B[4]);
});

// ═════════════ ARŞİV ═════════════
function shelfFiles(n, seed) {
  wall(n, 32, 48, { solid: [0, 44, 32, 4] }, (b) => {
    const rnd = rng(seed); box(b, 0, 0, 32, 48, 3, W, 3, false);
    for (let s = 0; s < 4; s++) {
      const y = 4 + s * 11; b.r(2, y, 28, 9, W[1]);
      let x = 2; while (x < 29) {
        const t = rnd();
        if (t < 0.18 && x < 23) { b.r(x, y + 3, 7, 6, W[5]); b.hl(x, y + 3, 7, W[6]); b.r(x + 2, y + 5, 3, 2, K[7]); x += 8; continue; }   // arşiv kutusu
        const c = [R[3], B[3], G[3], O[3], P[2], K[4], C[2]][(rnd() * 7) | 0], bw = 2, bh = 7 + (rnd() < 0.3 ? 1 : 0);
        b.r(x, y + 9 - bh, bw, bh, c); b.vl(x, y + 9 - bh, bh, lt(c)); b.r(x, y + 9 - bh + 3, 2, 2, K[7]); x += bw + (rnd() < 0.15 ? 1 : 0);
      }
      b.hl(1, y + 9, 30, W[4]); b.hl(1, y + 10, 30, W[2]);
    }
  });
}
shelfFiles('shelf_files_0', 51); shelfFiles('shelf_files_1', 52); shelfFiles('shelf_files_2', 53);
function cabinet(b, open) {
  b.shadow(1, 30, 15, 2); box(b, 1, 2, 14, 29, 3, S, 3);
  for (let d = 0; d < 4; d++) { const y = 6 + d * 6; b.hl(2, y + 5, 12, S[1]); b.r(5, y + 1, 6, 2, K[7]); b.hl(6, y + 1, 4, K[6]); b.r(6, y + 3, 4, 1, S[5]); }
  if (open) { box(b, 0, 20, 16, 8, 3, S, 4); for (let x = 2; x < 14; x += 2) { b.r(x, 18, 2, 3, x % 4 ? O[4] : K[7]); b.p(x, 18, lt(x % 4 ? O[4] : K[6])); } b.r(5, 24, 6, 1, S[5]); }
}
def('filing_cabinet', 16, 32, { solid: [1, 18, 14, 12] }, (b) => cabinet(b, false));
def('filing_cabinet_open', 16, 32, { solid: [0, 18, 16, 12] }, (b) => cabinet(b, true));
def('library_ladder', 16, 48, { solid: null }, (b) => {
  b.shadow(1, 46, 14, 2); line(b, 4, 0, 1, 46, W[1]); line(b, 5, 0, 2, 46, W[4]); line(b, 12, 0, 9, 46, W[1]); line(b, 13, 0, 10, 46, W[4]);
  for (let y = 5; y < 46; y += 7) { const o = Math.round(y * 3 / 46); b.hl(5 - o, y, 7, W[2]); b.hl(5 - o, y - 1, 7, W[5]); }
});
def('file_boxes', 16, 24, { solid: [1, 12, 14, 10] }, (b) => {
  b.shadow(1, 22, 15, 2);
  for (const [y, h] of [[13, 10], [5, 9]]) { box(b, 1 + (y < 10 ? 1 : 0), y, 13, h, 3, W, 5); b.r(5, y + 4, 6, 3, K[7]); b.hl(6, y + 5, 4, K[5]); b.r(2 + (y < 10 ? 1 : 0), y + 4, 2, 1, W[3]); }
});
def('hand_truck', 16, 24, { solid: null }, (b) => {
  b.shadow(2, 22, 13, 2); b.vl(3, 1, 20, K[2]); b.vl(12, 1, 20, K[2]); b.hl(3, 1, 10, K[2]); b.hl(3, 8, 10, K[3]); b.hl(2, 20, 12, K[3]);
  oval(b, 1, 18, 5, 5, K[1]); oval(b, 10, 18, 5, 5, K[1]); b.p(3, 20, K[4]); b.p(12, 20, K[4]);
  box(b, 4, 10, 8, 9, 3, W, 4); b.vl(8, 11, 3, O[4]);
});
def('card_catalog', 32, 24, { solid: [0, 8, 32, 14] }, (b) => {
  b.shadow(1, 22, 31, 2); box(b, 0, 2, 32, 21, 4, W, 3);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) { const x = 2 + c * 5, y = 7 + r * 4; b.r(x, y, 4, 3, W[4]); b.hl(x, y, 4, W[5]); b.p(x + 1, y + 1, K[7]); b.p(x + 2, y + 1, K[7]); b.p(x + 1, y + 2, O[2]); }
});
wall('sign_quiet', 16, 16, {}, (b) => {
  frame(b, 1, 1, 14, 13, K[2], K[7]); b.r(4, 6, 2, 3, K[2]); b.r(6, 5, 1, 5, K[2]); b.r(7, 4, 1, 7, K[2]);
  line(b, 9, 5, 12, 9, R[3]); line(b, 12, 5, 9, 9, R[3]); b.shadow(2, 14, 13, 1, SH2);
});
def('reading_desk', 48, 32, { solid: [0, 15, 48, 15], light: { x: 10, y: 8, r: 30, color: '#ffcf7a' } }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 0, 8, 48, 22, 14, W, 2); b.r(2, 22, 4, 7, W[1]); b.r(42, 22, 4, 7, W[1]); b.r(18, 23, 12, 3, W[3]); b.p(23, 24, O[3]); b.p(24, 24, O[3]);
  b.r(4, 10, 40, 10, G[1]); b.hl(4, 10, 40, G[2]);                               // yeşil deri kaplama
  b.r(9, 12, 2, 6, O[1]); b.r(7, 17, 6, 2, O[2]); b.hl(7, 17, 6, O[4]);              // banker lambası ayağı
  b.r(4, 4, 12, 4, G[2]); b.hl(4, 4, 12, G[4]); b.hl(5, 3, 10, G[3]); b.hl(4, 7, 12, G[0]); b.hl(6, 8, 8, O[5]);
  for (let i = 0; i < 4; i++) paper(b, 20 + (i % 2), 17 - i * 2, 9, 2, false); b.hl(21, 12, 6, K[5]); b.p(28, 11, R[3]);   // makbuz yığını
  b.r(33, 14, 6, 3, K[1]); b.r(34, 15, 4, 1, R[2]);                             // ıstampa
  b.r(40, 12, 3, 4, W[1]); b.r(41, 9, 1, 3, W[3]); b.p(41, 8, W[5]); b.hl(40, 16, 3, R[3]);  // mühür
  b.r(14, 13, 4, 3, K[7]); b.p(14, 13, K[5]);
});

// ═════════════ PYN'İN ODASI ═════════════
wall('diploma_0', 16, 16, {}, (b) => { framed(b, 1, 1, 14, 12, O[2]); b.r(3, 3, 10, 8, K[7]); b.hl(5, 4, 6, K[4]); b.hl(4, 6, 8, K[5]); b.hl(5, 8, 4, K[5]); b.p(11, 9, R[3]); b.p(10, 9, O[3]); });
wall('diploma_1', 16, 16, {}, (b) => { framed(b, 1, 1, 14, 12, K[2]); b.r(3, 3, 10, 8, O[5]); b.hl(4, 4, 8, W[3]); b.hl(5, 6, 6, K[4]); b.hl(4, 8, 5, K[4]); oval(b, 9, 7, 3, 3, B[2]); });
wall('portrait_pineapple', 24, 32, {}, (b) => {
  b.r(0, 0, 24, 31, O[1]); b.r(1, 1, 22, 29, O[3]); b.hl(1, 1, 22, O[4]); b.r(3, 3, 18, 25, W[1]); b.r(4, 4, 16, 23, B[1]);
  oval(b, 7, 12, 10, 14, O[3]); for (let y = 13; y < 25; y += 2) for (let x = 8 + (y % 4 === 1 ? 1 : 0); x < 17; x += 2) b.p(x, y, O[1]);
  b.hl(8, 17, 3, O[0]); b.hl(13, 17, 3, O[0]); b.p(9, 18, K[0]); b.p(14, 18, K[0]); b.r(11, 19, 2, 2, O[1]); b.hl(10, 22, 4, O[0]);
  rows(b, 7, 5, ['..K..L....', '.LKJ.KL.K.', 'KJJLKJJLJ.', '.KJJJJKJ..', '...JKJ....']);
  b.r(10, 25, 4, 2, B[0]); b.p(11, 24, B[0]); b.shadow(1, 31, 23, 1, SH2);
});
wall('trophy_shelf', 32, 16, {}, (b) => {
  b.hl(0, 12, 32, W[1]); b.hl(0, 11, 32, W[4]); b.hl(1, 13, 30, W[2]); b.shadow(1, 14, 31, 1, SH2);
  for (const [x, h, c] of [[3, 8, O[3]], [11, 10, O[4]], [20, 7, K[6]], [27, 6, W[4]]]) { const y = 11 - h; b.r(x - 1, y, 5, 3, c); b.hl(x - 1, y, 5, lt(c)); b.p(x - 2, y + 1, c); b.p(x + 4, y + 1, c); b.vl(x + 1, y + 3, h - 5, dk(c)); b.r(x, 9, 3, 2, W[1]); }
});
function execDesk(b, plate) {
  b.shadow(1, 38, 63, 2); b.shadow(47, 46, 17, 2);
  box(b, 46, 18, 18, 28, 4, W, 2);                       // L dönüşü
  box(b, 0, 14, 64, 26, 14, W, 2); b.r(3, 30, 58, 8, W[1]); b.r(4, 31, 56, 6, W[2]); b.hl(4, 31, 56, W[3]);
  frame(b, 10, 2, 18, 13, K[0], K[2]); b.r(11, 3, 16, 10, K[3]); b.hl(11, 3, 16, K[4]); b.r(18, 15, 3, 2, K[2]); b.hl(15, 17, 9, K[2]);  // monitör (arka)
  b.r(33, 18, 9, 5, K[1]); b.hl(34, 18, 7, K[3]); b.r(34, 16, 7, 2, K[2]); b.p(36, 20, G[4]);       // masa telefonu
  b.r(46, 16, 12, 6, W[4]); b.r(47, 17, 10, 4, W[1]); paper(b, 48, 15, 8, 4, false);             // evrak sepeti
  b.r(4, 18, 3, 4, R[2]); b.r(5, 15, 1, 3, W[3]); b.p(5, 14, W[5]); b.hl(3, 22, 5, K[7]);          // onay mührü
  b.r(12, 21, 14, 3, K[2]); b.hl(13, 22, 12, K[4]);                                            // klavye
  if (plate === 'mudur') {                                                                     // müdürün isimliği: adı kasanın sahibinin, yazısız
    b.r(20, 32, 24, 7, O[1]); b.r(21, 33, 22, 5, O[3]); b.hl(21, 33, 22, O[4]); b.hl(24, 35, 16, O[2]);
  } else {                                                                                       // "PYN" isimlik
    b.r(22, 32, 20, 7, O[1]); b.r(23, 33, 18, 5, O[3]); b.hl(23, 33, 18, O[4]);
    rows(b, 25, 34, ['aa.a.a.a..a', 'aa..a..aa.a', 'a...a..a.aa'].map(r => r));
  }
  b.r(50, 26, 10, 6, W[1]); b.r(51, 27, 8, 4, B[2]); b.hl(51, 27, 8, B[3]);                   // dosya
}
const EXEC = { solid: [0, 18, 64, 18], light: { x: 18, y: 8, r: 24, color: '#5fd0e0' } };
def('exec_desk', 64, 48, EXEC, (b) => execDesk(b, 'pyn'));
def('exec_desk_mudur', 64, 48, EXEC, (b) => execDesk(b, 'mudur'));
def('exec_chair', 20, 30, { group: 'sandalye' }, (b) => {
  b.shadow(3, 27, 15, 2); b.hl(3, 26, 14, K[2]); for (const x of [3, 9, 10, 16]) b.p(x, 27, K[1]); b.r(9, 19, 2, 7, K[3]);
  box(b, 2, 0, 16, 16, 3, R, 2); for (let y = 5; y < 15; y += 3) for (let x = 5; x < 15; x += 3) b.p(x, y, R[1]); b.hl(4, 2, 12, R[4]);
  box(b, 2, 13, 16, 7, 3, R, 2); b.r(0, 12, 3, 6, R[1]); b.r(17, 12, 3, 6, R[1]); b.hl(0, 12, 3, R[3]); b.hl(17, 12, 3, R[3]);
});
def('guest_chair', 16, 24, { group: 'sandalye' }, (b) => {
  b.shadow(2, 22, 13, 2); b.vl(3, 15, 7, W[1]); b.vl(12, 15, 7, W[1]); box(b, 2, 11, 12, 5, 2, R, 2);
  box(b, 2, 0, 12, 14, 2, R, 2); b.vl(4, 3, 9, R[3]); b.vl(11, 3, 9, R[1]); b.r(0, 8, 2, 7, W[2]); b.r(14, 8, 2, 7, W[2]);
});
def('aquarium', 32, 40, { frames: 4, fps: 3, solid: [0, 20, 32, 18], light: { x: 16, y: 12, r: 30, color: '#5fd0e0' } }, (b, f) => {
  b.shadow(1, 38, 31, 2); box(b, 0, 20, 32, 19, 3, W, 2); b.r(3, 25, 12, 10, W[1]); b.r(17, 25, 12, 10, W[1]); b.p(13, 30, O[3]); b.p(18, 30, O[3]);
  b.r(0, 0, 32, 22, S[0]); b.r(1, 1, 30, 20, C[2]); b.r(1, 1, 30, 3, C[3]); b.hl(1, 1, 30, C[4]); b.r(1, 17, 30, 4, O[3]); speck(b, 1, 17, 30, 4, W[4], 0.3, rng(4));
  for (const x of [5, 7, 25]) { const h = x === 7 ? 9 : 7; for (let j = 0; j < h; j++) b.p(x + ((j + f) % 4 < 2 ? 0 : 1), 17 - j, G[3]); }
  b.r(19, 13, 4, 4, K[4]); b.p(20, 13, K[5]);
  const fish = [[8, 7, O[4], 1], [20, 10, R[4], -1], [14, 5, K[7], 1]];
  for (const [fx, fy, c, d] of fish) { const x = fx + (d > 0 ? f * 2 : -f * 2), y = fy + (f % 2); b.r(x, y, 3, 2, c); b.p(d > 0 ? x - 1 : x + 3, y, dk(c)); b.p(d > 0 ? x - 1 : x + 3, y + 1, dk(c)); b.p(d > 0 ? x + 2 : x, y, K[0]); }
  b.p(10 + f, 3 - (f % 2), K[7]); b.p(23, 12 - f * 2, K[7]); b.vl(1, 4, 13, C[4]);
});
def('sofa_leather', 32, 24, { solid: [0, 8, 32, 14] }, (b) => {
  b.shadow(1, 22, 31, 2); box(b, 2, 0, 28, 10, 2, W, 2); box(b, 0, 8, 32, 14, 4, W, 2); b.vl(16, 9, 4, W[1]);
  box(b, 0, 4, 5, 18, 2, W, 2); box(b, 27, 4, 5, 18, 2, W, 2); b.hl(4, 2, 24, W[3]);
});
def('coffee_table_small', 32, 16, { solid: [1, 2, 30, 12] }, (b) => {
  b.shadow(2, 14, 29, 2); box(b, 1, 2, 30, 12, 7, W, 2); b.r(3, 9, 2, 4, W[1]); b.r(27, 9, 2, 4, W[1]);
  b.r(6, 4, 7, 4, B[3]); b.hl(6, 4, 7, B[4]); mug(b, 22, 3, K[7]);
});


// ═════════════ MASALAR ═════════════
// 'down' masa: kişi kuzeyde oturur, aşağı bakar. Sprite sol üstü = (cx-16, sy-14); ay=29.
// 'up' masa: kişi güneyde oturur, yukarı bakar. Sprite sol üstü = (cx-16, sy-30); ay=28.
// (cx, sy) = oturan karakterin ayak çapası. MAP.seats bu noktaları px/py olarak verir.
function deskBase(b, w, ramp, i) {
  b.shadow(1, 30, w - 1, 2); box(b, 0, 8, w, 22, 14, ramp, i, true);
  const d = ramp[Math.max(1, i - 2)], m = ramp[Math.max(1, i - 1)];
  b.r(1, 22, 3, 7, d); b.r(w - 4, 22, 3, 7, d); b.r(6, 23, w - 12, 4, m); b.hl(6, 23, w - 12, ramp[i]);
}
function monBack(b, x, y, w, h) { frame(b, x, y, w, h, K[0], K[3]); b.hl(x + 1, y + 1, w - 2, K[4]); b.vl(x + w - 2, y + 2, h - 3, K[2]); b.p(x + (w >> 1), y + (h >> 1), K[5]); b.r(x + (w >> 1) - 1, y + h, 2, 2, K[2]); b.hl(x + (w >> 1) - 3, y + h + 2, 6, K[2]); }
function monFront(b, x, y, w, h, kind, f) { frame(b, x, y, w, h, K[0], K[1]); screenArt(b, x + 1, y + 1, w - 2, h - 3, kind, f); b.hl(x + 1, y + h - 2, w - 2, K[2]); b.p(x + w - 3, y + h - 2, kind === 'off' ? K[3] : G[4]); b.r(x + (w >> 1) - 1, y + h, 2, 2, K[2]); b.hl(x + (w >> 1) - 3, y + h + 2, 6, K[3]); }
function kb(b, x, y, w, keys) { b.r(x, y, w, 3, K[1]); b.hl(x, y, w, K[3]); for (let i = x + 1; i < x + w - 1; i += 2) b.p(i, y + 1, keys ? keys[(i >> 1) % keys.length] : K[4]); }
function mouse(b, x, y) { b.r(x, y, 2, 3, K[3]); b.p(x, y, K[5]); }
const MON_LIGHT_UP = { x: 16, y: 6, r: 30, color: '#5fd0e0' }, MON_LIGHT_DOWN = { x: 16, y: 10, r: 22, color: '#5fd0e0' };
const deskDown = (n, o, fn) => def(n, o.w || 32, o.h || 32, { ax: (o.w || 32) >> 1, ay: 29, solid: [0, 15, o.w || 32, 15], light: o.light === undefined ? MON_LIGHT_DOWN : o.light, frames: o.frames, fps: o.fps, group: 'masa' }, fn);
const deskUp = (n, o, fn) => def(n, o.w || 32, o.h || 32, { ax: (o.w || 32) >> 1, ay: 28, solid: [0, 6, o.w || 32, 14], light: o.light === undefined ? MON_LIGHT_UP : o.light, frames: o.frames || 3, fps: o.fps || 2, group: 'masa' }, fn);

deskDown('desk_defne', {}, (b) => {
  const rnd = rng(301); deskBase(b, 32, W, 4); kb(b, 10, 10, 12); mouse(b, 23, 10);
  books(b, 2, 18, 4, rnd, 7); paper(b, 2, 10, 6, 4); b.p(6, 11, R[3]);
  monBack(b, 9, 4, 14, 12);
  mug(b, 24, 14, R[4]); b.p(24, 12, B[2]); b.p(25, 11, R[3]); b.p(26, 12, K[1]); b.p(25, 13, O[3]);   // kalemlik
  succulent(b, 28, 14);
});
deskDown('desk_baran', {}, (b) => {
  deskBase(b, 32, W, 4); kb(b, 4, 10, 22, [R[4], O[4], C[3], K[6], G[4], P[3]]); mouse(b, 27, 11);
  monBack(b, 8, 4, 14, 12); frame(b, 24, 0, 6, 17, K[0], K[3]); b.vl(25, 1, 15, K[4]); b.r(26, 17, 2, 2, K[2]);   // dikey monitör
  b.r(3, 14, 3, 6, G[2]); b.vl(3, 14, 6, G[4]); b.hl(3, 14, 3, K[5]); b.p(4, 16, K[0]); b.p(4, 17, C[4]);           // enerji içeceği
  b.r(2, 21, 4, 1, K[3]);
});
deskDown('desk_ilgin', {}, (b) => {
  deskBase(b, 32, W, 4); kb(b, 13, 10, 10); mouse(b, 24, 10);
  monBack(b, 13, 4, 12, 11);
  frame(b, 1, 8, 11, 9, K[1], K[4]); b.r(1, 17, 11, 2, K[3]); // dizüstü kapağı (arka)
  for (const [x, y, c] of [[3, 10, R[4]], [6, 10, O[4]], [8, 12, C[3]], [3, 13, P[3]], [5, 14, G[4]], [9, 15, K[7]], [7, 13, B[4]]]) { b.p(x, y, c); b.p(x + 1, y, c); b.p(x, y + 1, c); }
  b.r(27, 11, 4, 4, K[5]); b.r(26, 15, 6, 4, K[4]); b.hl(26, 15, 6, K[5]); b.p(28, 9, K[3]); b.p(28, 10, R[4]); b.p(26, 16, K[3]); b.p(31, 16, K[3]); b.r(27, 19, 4, 1, K[2]);  // robot figür
});
deskUp('desk_toprak', {}, (b, f) => {
  const rnd = rng(302); deskBase(b, 32, W, 4); monFront(b, 9, 0, 14, 12, 'text', f); kb(b, 10, 17, 12); mouse(b, 23, 17);
  books(b, 24, 19, 5, rnd, 6);
  oval(b, 2, 9, 7, 7, B[3]); b.r(3, 11, 2, 2, G[3]); b.p(6, 13, G[3]); b.p(5, 10, G[4]); b.p(3, 10, B[4]); b.vl(9, 11, 5, O[2]); b.r(3, 17, 5, 2, O[1]);   // mini küre
});
deskUp('desk_asya', {}, (b, f) => {
  deskBase(b, 32, W, 4); monFront(b, 10, 0, 14, 12, 'list', f); kb(b, 11, 17, 12);
  for (const [x, c] of [[2, R[2]], [5, B[1]], [7, G[2]]]) { b.r(x, 8, 3, 11, c); b.vl(x, 8, 11, lt(c)); b.hl(x, 10, 3, O[4]); b.hl(x, 15, 3, O[4]); }  // sözlükler
  oval(b, 24, 18, 7, 3, K[6]); b.r(25, 15, 5, 3, K[7]); b.hl(25, 15, 5, W[3]); b.p(30, 16, K[7]);   // çay fincanı
  b.r(27, 11, 4, 3, W[2]); for (const [x, h, c] of [[27, 5, R[4]], [29, 6, B[4]], [30, 4, O[4]]]) { b.vl(x, 11 - h, h, K[6]); b.r(x + 1, 11 - h, 2, 2, c); }
});
deskUp('desk_berk', {}, (b, f) => {
  deskBase(b, 32, W, 4); monFront(b, 9, 0, 14, 12, 'text', f); kb(b, 10, 17, 12);
  b.r(9, 1, 2, 2, O[4]); b.r(21, 0, 3, 3, R[5]); b.r(22, 8, 2, 2, C[4]);          // monitörde yapışkan notlar
  paper(b, 1, 11, 7, 5); paper(b, 3, 15, 7, 5); b.r(4, 10, 4, 3, O[4]); b.r(1, 18, 3, 3, R[5]);   // dağınık kâğıtlar
  for (const x of [24, 28]) { b.r(x, 13, 3, 5, K[7]); b.hl(x, 13, 3, W[1]); b.r(x, 15, 3, 2, W[4]); b.p(x + 1, 12, K[6]); }
});
deskUp('desk_elif', {}, (b, f) => {
  deskBase(b, 32, W, 4); monFront(b, 1, 0, 15, 12, 'nodes', f); monFront(b, 16, 0, 15, 12, 'nodes', (f + 1) % 3);
  kb(b, 10, 17, 12); mouse(b, 23, 17); b.r(2, 16, 5, 4, O[5]); line(b, 3, 17, 6, 19, R[3]); b.r(27, 17, 3, 3, C[3]);
});
deskUp('desk_terminal', {}, (b, f) => {
  deskBase(b, 32, S, 2); monFront(b, 7, 0, 18, 12, 'term', f); kb(b, 9, 17, 14); mouse(b, 24, 17);
  b.r(1, 10, 6, 8, K[1]); b.hl(1, 10, 6, K[3]); for (let y = 12; y < 18; y += 2) { b.hl(2, y, 4, K[2]); b.p(5, y, f === (y >> 1) % 3 ? G[4] : K[3]); }  // mini sunucu
  b.hl(26, 11, 4, K[6]); b.r(26, 12, 4, 2, R[3]); b.r(27, 14, 2, 1, R[2]); b.r(26, 15, 4, 2, R[3]); b.hl(25, 17, 6, K[5]); // çay bardağı
});
deskDown('desk_shared_down', { light: null }, (b) => { deskBase(b, 32, K, 5); kb(b, 10, 10, 12); monBack(b, 9, 4, 14, 12); });
// Tolga'nın masası: Cortex'i yazan yazılımcı. İki ekran, renkli tuşlu klavye, ananaslı kupa, önünde "TOLGA" isimliği.
deskDown('desk_tolga', {}, (b) => {
  deskBase(b, 32, W, 4); kb(b, 10, 10, 12, [R[4], O[4], G[4], C[4], B[4], P[4]]); mouse(b, 24, 11);
  monBack(b, 2, 3, 13, 11); monBack(b, 17, 3, 13, 11); mug(b, 27, 12, O[3]);
  b.r(5, 22, 22, 7, O[1]); b.r(6, 23, 20, 5, O[3]); b.hl(6, 23, 20, O[4]);
  rows(b, 7, 24, ['aaa.aaa.a...aa...a.', '.a..a.a.a...a.a.aaa', '.a..aaa.aaa.aaa.a.a']);
});
deskUp('desk_shared_up', { light: null, frames: 1 }, (b) => { deskBase(b, 32, K, 5); monFront(b, 9, 0, 14, 12, 'off', 0); kb(b, 10, 17, 12); });
deskUp('desk_shared_up_reserved', { light: null, frames: 1 }, (b) => {
  deskBase(b, 32, K, 5); monFront(b, 9, 0, 14, 12, 'off', 0); kb(b, 10, 17, 12);
  b.r(22, 14, 8, 5, K[7]); b.hl(22, 14, 8, K[6]); b.hl(23, 16, 6, R[3]); b.hl(22, 19, 8, K[4]);   // rezerve kartı
});
def('desk_sena', 48, 40, { ax: 24, ay: 29, solid: [0, 15, 48, 15], light: MON_LIGHT_DOWN, group: 'masa' }, (b) => {
  b.shadow(33, 38, 15, 2); box(b, 33, 20, 15, 19, 4, W, 2);                               // L dönüşü
  deskBase(b, 48, W, 2); kb(b, 18, 10, 12); monBack(b, 17, 4, 14, 12);
  for (let i = 0; i < 3; i++) { paper(b, 2 + i * 2, 11 + i, 9, 7); line(b, 3 + i * 2, 13 + i, 8 + i * 2, 13 + i, R[3]); b.p(9 + i * 2, 15 + i, R[3]); }  // düzeltmeli kâğıtlar
  for (const x of [34, 36, 38]) { b.vl(x, 11, 6, R[3]); b.p(x, 10, R[4]); b.p(x, 17, K[6]); }    // kırmızı kalemler
  paper(b, 36, 23, 9, 7); line(b, 37, 25, 43, 25, R[3]); b.p(41, 27, R[3]); b.p(42, 26, R[3]);
  mug(b, 42, 13, K[1]);
});

// ═════════════ SALON ═════════════
def('copier', 32, 32, { frames: 3, fps: 2, solid: [0, 10, 32, 20], light: { x: 26, y: 8, r: 8, color: '#79b265' } }, (b, f) => {
  b.shadow(1, 30, 31, 2); box(b, 0, 10, 28, 21, 6, K, 5); for (let y = 18; y < 29; y += 4) { b.hl(2, y, 24, K[4]); b.r(11, y + 1, 6, 1, K[3]); }
  box(b, 1, 2, 26, 10, 5, K, 6); b.r(20, 4, 6, 3, K[2]); b.p(21, 5, G[4]); b.p(23, 5, O[4]); b.hl(3, 4, 14, K[5]);
  b.r(27, 14, 5, 2, K[3]); const out = [1, 3, 5][f]; paper(b, 27, 14 - out + 1, 5, out, false);
});
def('paper_stack', 16, 16, { solid: [2, 6, 12, 8] }, (b) => { b.shadow(2, 14, 13, 2); for (let i = 0; i < 4; i++) { const y = 11 - i * 2; b.r(2, y, 12, 3, i % 2 ? B[3] : K[7]); b.hl(2, y, 12, i % 2 ? B[4] : K[7]); b.vl(13, y, 3, K[5]); b.p(7, y + 1, i % 2 ? K[7] : B[3]); } b.r(2, 14, 12, 1, K[4]); });
def('shredder', 16, 24, { solid: [2, 10, 12, 12] }, (b) => {
  b.shadow(2, 22, 13, 2); box(b, 2, 8, 12, 15, 2, K, 3); b.r(4, 11, 8, 8, K[1]); for (let x = 4; x < 12; x++) b.vl(x, 13 + (x % 3), 6 - (x % 3), x % 2 ? K[7] : K[6]);
  box(b, 1, 2, 14, 8, 4, K, 2); b.hl(4, 4, 8, K[0]); b.p(12, 7, G[4]);
});
def('standing_table', 32, 32, { solid: [6, 22, 20, 8] }, (b) => {
  b.shadow(6, 30, 21, 2); b.r(14, 13, 4, 16, K[2]); b.vl(14, 13, 16, K[3]); oval(b, 8, 26, 16, 5, K[1]); oval(b, 9, 26, 14, 4, K[3]);
  box(b, 0, 4, 32, 12, 8, W, 4); b.r(4, 5, 10, 5, K[2]); b.r(5, 6, 8, 3, B[3]); b.hl(4, 10, 10, K[3]); mug(b, 21, 6, R[4]); paper(b, 24, 7, 6, 4);
});
def('planter_long', 48, 24, { frames: 2, fps: 1, solid: [0, 14, 48, 8] }, (b, f) => {
  for (let k = 0; k < 4; k++) { const x = 2 + k * 11, s = f && k % 2 ? 1 : 0; oval(b, x + s, 1 + (k % 2) * 2, 10, 12, G[2]); oval(b, x + 2 + s, 2 + (k % 2) * 2, 6, 6, G[3]); b.p(x + 3 + s, 3 + (k % 2) * 2, G[4]); b.p(x + 6, 8, G[1]); }
  b.outline(); box(b, 0, 13, 48, 10, 3, K, 3); b.hl(2, 14, 44, W[1]); b.hl(1, 18, 46, K[4]); b.shadow(1, 23, 47, 1);
});
def('tea_cart', 32, 24, { solid: [1, 8, 30, 14] }, (b) => {
  b.shadow(1, 22, 31, 2); for (const x of [2, 28]) { b.vl(x, 4, 17, K[3]); b.vl(x + 1, 4, 17, K[5]); } b.p(2, 21, K[1]); b.p(29, 21, K[1]);
  box(b, 1, 14, 30, 4, 2, W, 3); box(b, 1, 6, 30, 5, 3, W, 4); line(b, 30, 4, 31, 0, K[3]);
  for (const x of [5, 9, 13]) { b.hl(x, 2, 3, K[6]); b.r(x, 3, 3, 2, R[3]); b.p(x + 1, 5, R[2]); b.r(x, 6, 3, 1, R[3]); }
  b.r(19, 1, 7, 6, S[4]); b.hl(19, 1, 7, S[5]); b.r(20, 0, 5, 1, S[3]); b.p(26, 3, S[3]); b.p(27, 2, S[3]);
  oval(b, 8, 12, 6, 3, K[7]); b.r(18, 12, 6, 3, W[2]);
});

// ═════════════ MUTFAK ═════════════
wall('upper_cabinets', 48, 16, {}, (b) => {
  box(b, 0, 0, 48, 15, 2, W, 5, false); for (let x = 1; x < 47; x += 12) { b.vl(x + 11, 2, 12, W[3]); b.r(x + (x % 24 === 1 ? 9 : 1), 7, 1, 3, K[4]); }
  b.shadow(1, 15, 47, 1);
});
wall('mug_shelf', 32, 12, {}, (b) => {
  b.hl(0, 9, 32, W[1]); b.hl(0, 8, 32, W[4]); b.shadow(1, 10, 31, 1, SH2);
  [R[4], C[3], O[4], K[7], P[3], G[4]].forEach((c, i) => { const x = 2 + i * 5; b.r(x, 4, 3, 4, c); b.hl(x, 4, 3, lt(c)); b.p(x + 3, 5, c); b.p(x + 3, 6, dk(c)); });
});
def('counter_sink', 48, 32, { solid: [0, 16, 48, 14] }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 0, 12, 48, 19, 5, K, 5); b.r(1, 17, 46, 13, W[4]); b.hl(1, 17, 46, W[5]);
  for (let x = 1; x < 46; x += 12) { b.vl(x + 11, 18, 11, W[2]); b.r(x + 5, 21, 2, 1, K[3]); } b.hl(1, 29, 46, W[2]);
  b.r(4, 13, 14, 4, S[2]); b.r(5, 14, 12, 2, S[3]); b.hl(5, 14, 12, S[1]); b.p(10, 15, S[0]);               // evye
  b.r(10, 8, 2, 5, S[4]); b.r(10, 8, 5, 1, S[4]); b.p(14, 9, S[3]); b.p(8, 11, S[4]);                          // musluk
  b.r(20, 11, 6, 3, G[3]); b.hl(20, 11, 6, G[4]);                                                         // sünger
  box(b, 31, 3, 16, 11, 2, K, 6); b.r(33, 5, 9, 6, K[1]); b.r(34, 6, 7, 4, K[2]); b.p(35, 7, O[4]); b.vl(44, 5, 6, K[4]); b.p(44, 6, G[4]);  // mikrodalga
});
def('tea_counter', 32, 32, { solid: [0, 16, 32, 14] }, (b) => {
  b.shadow(1, 30, 31, 2); box(b, 0, 12, 32, 19, 5, K, 5); b.r(1, 17, 30, 13, W[4]); b.hl(1, 17, 30, W[5]); b.vl(16, 18, 11, W[2]); b.r(8, 21, 2, 1, K[3]); b.r(22, 21, 2, 1, K[3]);
  b.r(1, 12, 15, 5, K[1]); oval(b, 3, 13, 5, 3, K[3]); oval(b, 9, 13, 5, 3, K[3]); b.p(5, 14, R[3]);             // ocak
  oval(b, 17, 11, 13, 6, K[4]); oval(b, 18, 11, 11, 5, K[6]);                                              // tepsi
  for (const x of [19, 23]) { b.hl(x, 9, 3, K[7]); b.r(x, 10, 3, 2, R[3]); b.p(x + 1, 12, R[2]); b.r(x, 13, 3, 1, R[3]); b.hl(x - 1, 14, 5, K[5]); }
  b.r(27, 10, 3, 4, K[7]); b.hl(27, 10, 3, R[4]); b.p(28, 9, K[6]);                                         // şekerlik
});
def('caydanlik', 16, 32, { frames: 4, fps: 4, ay: 31, light: { x: 8, y: 26, r: 10, color: '#ff8a4a' } }, (b, f) => {
  const st = [[[7, 7], [8, 5], [7, 3]], [[8, 6], [7, 4], [8, 2], [9, 1]], [[7, 6], [9, 4], [8, 2]], [[8, 7], [7, 5], [9, 3], [8, 1]]][f];
  for (const [x, y] of st) { b.p(x, y + 1, 'rgba(244,241,234,0.75)'); b.p(x + 1, y, 'rgba(244,241,234,0.5)'); }
  oval(b, 5, 9, 6, 3, R[3]); b.r(5, 11, 6, 5, R[3]); b.vl(5, 11, 5, R[4]); b.hl(6, 10, 4, R[4]); b.p(8, 8, R[2]); b.vl(11, 12, 3, R[2]); b.p(12, 11, R[2]); b.r(6, 13, 4, 1, K[7]);  // demlik (üst)
  b.r(3, 16, 10, 10, S[4]); b.vl(3, 16, 10, S[5]); b.vl(12, 17, 9, S[3]); b.hl(3, 16, 10, S[5]); b.hl(3, 25, 10, S[2]); b.hl(4, 15, 8, S[3]);  // çaydanlık (alt)
  b.p(13, 18, S[3]); b.p(14, 17, S[3]); b.p(15, 16, S[3]); b.vl(1, 18, 5, K[1]); b.p(2, 18, K[1]); b.p(2, 22, K[1]);
  b.hl(4, 27, 8, 'rgba(255,138,74,0.6)');
});
def('fridge', 24, 40, { solid: [1, 26, 22, 12] }, (b) => {
  b.shadow(1, 38, 23, 2); box(b, 1, 0, 22, 39, 3, K, 6); b.hl(2, 15, 20, K[4]); b.vl(19, 5, 8, K[4]); b.vl(19, 18, 10, K[4]);
  for (const [x, y, c] of [[5, 6, R[4]], [9, 8, O[4]], [6, 11, C[3]], [12, 5, G[4]], [7, 21, B[4]], [11, 23, P[3]]]) { b.r(x, y, 2, 2, c); b.p(x, y, lt(c)); }
  paper(b, 9, 19, 5, 6); b.p(11, 18, R[3]);
});
def('vending', 32, 48, { solid: [1, 32, 30, 14], light: { x: 13, y: 20, r: 28, color: '#cfe8ff' } }, (b) => {
  b.shadow(1, 46, 31, 2); box(b, 1, 0, 30, 47, 3, B, 1); b.r(3, 4, 20, 32, K[0]); b.r(4, 5, 18, 30, B[0]);
  const cs = [R[4], O[4], G[4], C[3], P[3], K[7], R[3], O[3]];
  for (let r = 0; r < 5; r++) { b.hl(4, 10 + r * 6, 18, S[2]); for (let c = 0; c < 4; c++) { const col = cs[(r * 3 + c) % cs.length]; b.r(5 + c * 4, 6 + r * 6, 3, 4, col); b.hl(5 + c * 4, 6 + r * 6, 3, lt(col)); } }
  b.r(4, 5, 2, 30, 'rgba(244,241,234,0.12)'); b.r(24, 6, 5, 4, K[1]); b.p(25, 7, C[4]); b.p(26, 7, C[4]); for (let y = 12; y < 22; y += 2) b.hl(25, y, 3, K[5]);
  b.r(5, 38, 16, 5, K[0]); b.hl(6, 39, 14, K[2]); b.r(25, 38, 3, 3, K[1]);
});
def('dining_table', 48, 32, { solid: [0, 10, 48, 18] }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 0, 6, 48, 22, 14, W, 4); b.r(3, 20, 3, 9, W[2]); b.r(42, 20, 3, 9, W[2]);
  oval(b, 16, 8, 16, 9, K[7]); oval(b, 17, 9, 14, 7, K[6]);                                               // tabak
  for (const [x, y] of [[18, 9], [24, 9], [21, 12]]) { oval(b, x, y, 7, 5, W[4]); oval(b, x + 2, y + 1, 3, 3, K[6]); b.p(x + 1, y + 1, W[5]); b.p(x + 4, y, K[7]); b.p(x + 1, y + 3, K[7]); b.p(x + 5, y + 3, K[7]); b.p(x + 6, y + 2, W[2]); }  // simitler
  for (const x of [5, 39]) { b.hl(x, 9, 3, K[7]); b.r(x, 10, 3, 2, R[3]); b.p(x + 1, 12, R[2]); b.r(x, 13, 3, 1, R[3]); b.hl(x - 1, 14, 5, K[5]); }
});

// ═════════════ TOPLANTI ═════════════
wall('meeting_screen', 64, 36, { frames: 4, fps: 0.25, light: { x: 32, y: 16, r: 50, color: '#a8d8ff' } }, (b, f) => {
  frame(b, 0, 0, 64, 34, K[0], K[1]); b.r(2, 2, 60, 29, K[7]); b.hl(2, 2, 60, B[2]); b.hl(2, 3, 60, B[2]);
  if (f === 0) { b.hl(6, 28, 52, K[4]); [8, 14, 11, 19, 16, 22].forEach((h, i) => { b.r(9 + i * 8, 28 - h, 5, h, i === 5 ? O[3] : B[3]); b.hl(9 + i * 8, 28 - h, 5, i === 5 ? O[4] : B[4]); }); }
  if (f === 1) { b.hl(6, 7, 30, K[2]); for (let j = 0; j < 5; j++) { b.r(7, 12 + j * 4, 2, 2, O[3]); b.hl(11, 12 + j * 4, 24 + (j * 7) % 20, K[4]); } }
  if (f === 2) { oval(b, 26, 11, 12, 16, O[3]); for (let y = 12; y < 26; y += 2) for (let x = 27 + (y % 4 === 0 ? 1 : 0); x < 37; x += 2) b.p(x, y, O[1]); rows(b, 25, 5, ['...K..L...', '..LKJ.KL..', '.KJJLKJJL.', '...JKJ....']); b.hl(22, 28, 20, K[2]); }
  if (f === 3) { b.r(4, 5, 56, 24, C[4]); b.r(8, 8, 18, 10, G[4]); b.r(30, 14, 22, 12, G[4]); b.r(12, 20, 10, 6, G[3]); line(b, 16, 12, 40, 20, R[3]); line(b, 40, 20, 18, 23, R[3]); for (const [x, y] of [[16, 12], [40, 20], [18, 23]]) b.r(x - 1, y - 1, 3, 3, R[2]); }
  b.shadow(1, 34, 63, 2, SH2);
});
wall('whiteboard_wall', 40, 24, {}, (b) => {
  frame(b, 0, 0, 40, 21, K[4], K[7]); b.hl(1, 1, 38, K[6]); b.hl(4, 4, 14, B[2]); b.hl(4, 7, 20, K[4]); b.hl(4, 10, 16, K[4]); frame(b, 26, 4, 10, 9, R[3], K[7]); line(b, 27, 11, 34, 6, R[3]); b.hl(4, 14, 10, G[3]);
  b.hl(2, 21, 36, K[3]); b.r(10, 20, 4, 1, B[2]); b.r(16, 20, 4, 1, R[3]); b.shadow(1, 22, 39, 2, SH2);
});
def('meeting_table', 96, 40, { ax: 48, ay: 37, solid: [0, 6, 96, 30] }, (b) => {
  b.shadow(2, 38, 94, 2); box(b, 0, 2, 96, 34, 24, W, 3); b.r(4, 26, 4, 10, W[1]); b.r(88, 26, 4, 10, W[1]); b.r(44, 27, 8, 7, W[1]);
  for (let x = 8; x < 90; x += 16) b.hl(x, 9, 8, W[5]);
  oval(b, 42, 11, 12, 7, K[1]); oval(b, 43, 11, 10, 6, K[2]); b.r(47, 13, 2, 2, G[4]);            // konferans hoparlörü
  for (const [x, y] of [[14, 6], [32, 6], [62, 6], [80, 6], [14, 18], [32, 18], [62, 18], [80, 18]]) { b.r(x, y, 2, 4, C[3]); b.p(x, y - 1, K[6]); b.p(x, y, C[4]); }   // su şişeleri
  for (const [x, y, c] of [[18, 6, K[7]], [66, 6, B[3]], [36, 19, K[7]], [84, 19, R[4]], [6, 12, O[5]]]) { b.r(x, y, 7, 4, c); b.vl(x, y, 4, dk(c)); b.hl(x + 2, y + 1, 4, K[5]); }   // defterler
});
def('credenza', 48, 24, { solid: [0, 8, 48, 14] }, (b) => {
  b.shadow(1, 22, 47, 2); box(b, 0, 6, 48, 17, 4, W, 2); for (let x = 1; x < 46; x += 16) { b.vl(x + 15, 10, 11, W[1]); b.r(x + 7, 14, 2, 1, O[3]); }
  b.r(6, 2, 4, 6, R[4]); b.hl(6, 2, 4, R[5]); b.p(7, 1, G[4]); b.p(8, 0, G[3]); b.r(30, 4, 10, 3, K[7]); b.hl(30, 4, 10, B[2]);
});

// ═════════════ SUNUCU ODASI ═════════════
export const TOOL_COLORS = { claude: '#c97b5a', codex: '#9aa4b4', opencode: '#5fbfa8', gemini: '#6f8fe0', qwen: '#9b7be0' };
/** LED durum renkleri: pal.led olarak verilir. */
export const LED = { ok: '#6fe08a', wait: '#f2c85a', off: '#39353f' };
for (const [tool, col] of Object.entries(TOOL_COLORS)) {
  def(`rack_${tool}`, 26, 52, { ax: 13, ay: 51, solid: [0, 40, 26, 11], group: 'sunucu' }, (b) => {
    b.shadow(1, 50, 25, 2); box(b, 0, 0, 26, 51, 3, K, 1, false); b.r(1, 1, 24, 2, col); b.hl(1, 3, 24, K[0]);
    b.r(2, 5, 22, 43, K[0]);
    for (let u = 0; u < 8; u++) { const y = 6 + u * 5; b.r(3, y, 20, 4, K[2]); b.hl(3, y, 20, K[3]); for (let x = 12; x < 22; x += 2) b.p(x, y + 2, K[1]); }
    b.vl(2, 5, 43, K[3]); b.r(10, 47, 6, 2, K[3]);
  });
  def(`rack_led_${tool}`, 26, 52, { ax: 13, ay: 51, frames: 4, fps: 4, group: 'sunucu', light: { x: 7, y: 26, r: 18, color: '#6fe08a' } }, (b, f, pal) => {
    const on = pal.led === undefined ? LED.ok : pal.led, rnd = rng(tool.length * 17 + 3);
    const pat = []; for (let u = 0; u < 8; u++) pat.push([rnd(), rnd(), rnd()]);
    for (let u = 0; u < 8; u++) { const y = 8 + u * 5; for (let k = 0; k < 3; k++) { const lit = on !== LED.off && ((pat[u][k] * 4 + f) % 4) < (k === 0 ? 3.4 : 2); b.p(4 + k * 2, y, lit ? on : LED.off); } }
    if (on !== LED.off) b.p(23, 4, on);
  });
}
def('cable_tray', 48, 8, { layer: 'floor', ax: 0, ay: 0 }, (b) => { b.r(0, 1, 48, 6, S[2]); b.hl(0, 1, 48, S[3]); b.hl(0, 6, 48, S[0]); [B[3], R[3], O[3], G[3], K[6]].forEach((c, i) => b.hl(0, 2 + (i % 4), 48, i % 2 ? c : dk(c))); for (let x = 3; x < 48; x += 8) b.vl(x, 1, 6, S[1]); });
def('cooling_unit', 32, 48, { solid: [0, 34, 32, 12], light: { x: 22, y: 10, r: 10, color: '#5fd0e0' } }, (b) => {
  b.shadow(1, 46, 31, 2); box(b, 0, 0, 32, 47, 3, S, 4, false); for (let y = 18; y < 44; y += 2) b.hl(3, y, 26, S[2]);
  b.r(4, 5, 24, 10, S[2]); b.r(18, 7, 8, 5, K[0]); b.hl(19, 9, 5, C[4]); b.p(6, 8, G[4]); b.p(8, 8, G[4]); b.p(10, 8, O[4]); b.hl(5, 12, 10, S[3]);
});
def('ups', 16, 24, { solid: [1, 10, 14, 12], light: { x: 8, y: 6, r: 6, color: '#6fe08a' } }, (b) => { b.shadow(1, 22, 15, 2); box(b, 1, 2, 14, 21, 3, K, 2); b.r(4, 6, 8, 3, K[0]); b.hl(5, 7, 5, G[4]); for (let y = 12; y < 21; y += 2) b.hl(3, y, 10, K[1]); b.p(11, 11, R[4]); });
def('toolbox', 16, 16, { solid: [1, 7, 14, 7] }, (b) => { b.shadow(1, 14, 15, 2); b.r(5, 3, 6, 1, K[2]); b.vl(5, 3, 3, K[2]); b.vl(10, 3, 3, K[2]); box(b, 1, 6, 14, 9, 3, R, 3); b.hl(2, 10, 12, R[1]); b.r(7, 9, 2, 2, K[5]); });
wall('warning_sign', 12, 12, {}, (b) => { for (let j = 0; j < 10; j++) { const w = 2 + j; b.hl(6 - (w >> 1), 1 + j, w, j === 9 ? K[1] : O[4]); b.p(6 - (w >> 1), 1 + j, K[1]); b.p(6 - (w >> 1) + w - 1, 1 + j, K[1]); } b.vl(5, 4, 3, K[1]); b.p(5, 8, K[1]); b.shadow(1, 11, 11, 1, SH2); });
def('cable_spool', 16, 16, { solid: [1, 6, 14, 8] }, (b) => { b.shadow(1, 14, 15, 2); oval(b, 1, 3, 14, 12, W[2]); oval(b, 2, 4, 12, 10, W[4]); oval(b, 4, 5, 8, 8, B[2]); for (let y = 6; y < 12; y += 2) b.hl(5, y, 6, B[3]); oval(b, 6, 7, 4, 4, W[3]); b.p(7, 8, W[1]); });
def('server_cart', 16, 24, { solid: [1, 10, 14, 12] }, (b) => {
  b.shadow(1, 22, 15, 2); b.vl(2, 4, 17, K[3]); b.vl(13, 4, 17, K[3]); b.hl(1, 4, 14, K[4]); b.hl(1, 13, 14, K[4]); b.hl(1, 20, 14, K[4]); b.p(2, 21, K[1]); b.p(13, 21, K[1]);
  b.r(3, 8, 10, 5, K[1]); b.hl(3, 8, 10, K[3]); b.p(4, 10, G[4]); b.p(6, 10, G[4]); b.r(4, 16, 8, 4, W[4]); b.vl(8, 16, 4, O[4]);
});
def('parts_shelf', 32, 32, { solid: [0, 18, 32, 12] }, (b) => {
  b.shadow(1, 30, 31, 2); for (const x of [1, 29]) b.vl(x, 1, 29, K[3]);
  for (let s = 0; s < 3; s++) { const y = 9 + s * 10; b.hl(1, y, 30, K[4]); b.hl(1, y + 1, 30, K[2]); }
  for (const [x, y, w, c] of [[3, 4, 6, K[2]], [10, 5, 5, K[1]], [17, 3, 9, W[4]], [3, 14, 10, B[2]], [15, 15, 5, K[2]], [22, 13, 6, W[4]], [3, 24, 8, K[1]], [13, 23, 12, G[2]]]) { b.r(x, y, w, (s => 5)(), c); b.hl(x, y, w, lt(c)); }
});

// ═════════════ DİNLENME ═════════════
wall('window_view', 48, 32, {}, (b) => {
  frame(b, 0, 0, 48, 30, W[1], W[4]); b.r(2, 2, 44, 26, B[4]); b.r(2, 2, 44, 6, B[3]);
  oval(b, 8, 5, 10, 4, K[7]); oval(b, 30, 9, 8, 3, K[7]);
  const bh = [10, 14, 8, 17, 12, 9, 15, 11, 13, 7]; let x = 2;
  bh.forEach((h, i) => { const w = 4 + (i % 3); if (x >= 46) return; const ww = Math.min(w, 46 - x); b.r(x, 28 - h, ww, h, i % 2 ? S[2] : S[3]); for (let yy = 30 - h; yy < 27; yy += 3) for (let xx = x + 1; xx < x + ww - 1; xx += 2) if ((xx + yy + i) % 3) b.p(xx, yy, i % 2 ? S[4] : O[5]); x += ww; });
  b.vl(23, 1, 28, W[2]); b.vl(24, 1, 28, W[4]); b.hl(1, 14, 46, W[3]); b.hl(0, 29, 48, W[3]); b.shadow(1, 30, 47, 2, SH2);
});
def('record_cabinet', 32, 32, { solid: [0, 16, 32, 14] }, (b) => {
  b.shadow(1, 30, 31, 2); box(b, 0, 10, 32, 21, 5, W, 3); b.r(2, 16, 28, 12, W[1]); for (let x = 3; x < 29; x += 2) b.vl(x, 17, 10, [R[3], K[2], B[3], O[3], K[6], G[3]][(x >> 1) % 6]);
  b.r(3, 4, 18, 8, K[1]); b.hl(3, 4, 18, K[3]); oval(b, 5, 5, 11, 6, K[0]); oval(b, 9, 7, 3, 2, R[4]); line(b, 19, 5, 15, 9, K[5]); b.p(19, 5, K[6]);  // pikap
  b.r(23, 6, 7, 6, W[2]); b.r(24, 7, 5, 4, K[2]); b.p(26, 9, K[5]);   // hoparlör
});
def('sofa_big', 48, 32, { solid: [0, 10, 48, 18] }, (b) => {
  b.shadow(1, 30, 47, 2); box(b, 3, 0, 42, 14, 3, O, 2); b.hl(5, 2, 38, O[3]);
  box(b, 0, 11, 48, 19, 6, O, 2); b.vl(16, 12, 6, O[1]); b.vl(32, 12, 6, O[1]); b.hl(2, 17, 44, O[1]);
  box(b, 0, 6, 6, 24, 3, O, 1); box(b, 42, 6, 6, 24, 3, O, 1); b.r(9, 4, 7, 6, R[4]); b.hl(9, 4, 7, R[5]); b.r(33, 4, 6, 6, C[3]); b.hl(33, 4, 6, C[4]);
  b.r(2, 28, 2, 2, W[1]); b.r(44, 28, 2, 2, W[1]);
});
def('armchair', 24, 24, { solid: [0, 8, 24, 14], group: 'sandalye' }, (b) => {
  b.shadow(1, 22, 23, 2); box(b, 0, 0, 7, 22, 2, R, 3); box(b, 4, 9, 18, 13, 5, R, 3); box(b, 4, 4, 18, 7, 2, R, 2); box(b, 4, 15, 18, 7, 2, R, 2);
  b.r(1, 22, 2, 2, W[1]); b.r(20, 22, 2, 2, W[1]);
});
def('pouf_a', 16, 12, { solid: [1, 2, 14, 8] }, (b) => { b.shadow(2, 10, 13, 2); oval(b, 1, 1, 14, 10, O[1]); oval(b, 1, 0, 14, 8, O[3]); oval(b, 3, 1, 10, 5, O[4]); b.p(7, 3, O[2]); });
def('pouf_b', 16, 12, { solid: [1, 2, 14, 8] }, (b) => { b.shadow(2, 10, 13, 2); oval(b, 1, 1, 14, 10, P[0]); oval(b, 1, 0, 14, 8, P[2]); oval(b, 3, 1, 10, 5, P[3]); b.p(7, 3, P[1]); });
def('lounge_table', 40, 24, { solid: [1, 6, 38, 14] }, (b) => {
  b.shadow(2, 22, 37, 2); box(b, 1, 4, 38, 17, 11, W, 3); b.r(4, 15, 2, 6, W[1]); b.r(34, 15, 2, 6, W[1]);
  b.r(4, 6, 6, 8, R[4]); b.hl(4, 6, 6, R[5]); b.r(6, 7, 6, 8, B[3]); b.hl(6, 7, 6, B[4]); b.hl(7, 9, 4, K[7]);     // dergiler
  b.r(16, 6, 18, 9, W[1]); b.r(17, 7, 16, 7, W[5]); b.vl(25, 7, 7, W[1]);                                      // tavla
  for (let i = 0; i < 4; i++) { b.p(18 + i * 2, 7, i % 2 ? R[3] : K[1]); b.p(18 + i * 2, 13, i % 2 ? K[1] : R[3]); b.p(27 + i * 2, 7, i % 2 ? R[3] : K[1]); b.p(27 + i * 2, 13, i % 2 ? K[1] : R[3]); }
  for (const [x, y, c] of [[18, 8, K[7]], [18, 9, K[7]], [28, 12, R[2]], [30, 12, R[2]], [22, 12, K[7]], [31, 8, R[2]]]) b.p(x, y, c);
  b.p(25, 9, K[7]); b.p(26, 11, K[7]);
});
def('cat_bed', 16, 16, { solid: null }, (b) => { b.shadow(1, 13, 15, 2); oval(b, 0, 3, 16, 11, R[1]); oval(b, 1, 3, 14, 9, R[3]); oval(b, 3, 5, 10, 6, K[6]); oval(b, 4, 6, 8, 4, K[7]); b.hl(3, 3, 10, R[4]); });
def('rug_round', 64, 32, { layer: 'floor', ax: 0, ay: 0 }, (b) => {
  oval(b, 0, 0, 64, 32, W[2]); oval(b, 2, 1, 60, 30, O[3]); oval(b, 5, 3, 54, 26, R[3]); oval(b, 9, 5, 46, 22, O[4]); oval(b, 13, 7, 38, 18, W[5]); oval(b, 20, 10, 24, 12, R[3]); oval(b, 25, 12, 14, 8, O[4]);
});


// ═════════════ KARAKTERLER ═════════════
// Hücre 16×32; ayak çapası (8, 30). 'side' sağa bakar; sol için motor yatay çevirir.
export const POSES = {
  idle: { frames: 2, fps: 2, dirs: ['down', 'up', 'side'] },
  walk: { frames: 4, fps: 8, dirs: ['down', 'up', 'side'] },
  carry: { frames: 4, fps: 8, dirs: ['down', 'up', 'side'] },
  sit: { frames: 1, fps: 1, dirs: ['down', 'up', 'side'] },
  type: { frames: 2, fps: 6, dirs: ['down', 'up'] },
  phone: { frames: 2, fps: 1.5, dirs: ['down'] },
  yawn: { frames: 3, fps: 2, dirs: ['down'] },
  drink: { frames: 2, fps: 1, dirs: ['down'] },
  talk: { frames: 2, fps: 3, dirs: ['down', 'side'] },
  sleep: { frames: 2, fps: 1, dirs: ['down'], only: ['pyn', 'husnu'] },
};
export const CAT_POSES = {
  walk: { frames: 4, fps: 8, dirs: ['down', 'up', 'side'] },
  sit: { frames: 1, fps: 1, dirs: ['down'] },
  sleep: { frames: 2, fps: 1, dirs: ['down'] },
  stretch: { frames: 3, fps: 3, dirs: ['side'] },
  groom: { frames: 2, fps: 2, dirs: ['side'] },
};

// Saç maskeleri: x2..13 (12 sütun). İlk eleman başlangıç y'si.
// H saç, h parlak, d gölge, S ten, s ten gölgesi/kulak, A B C aksesuar renkleri.
const HEAD = {
  defne: {
    down: [5, '...hhhHH....', '..hHHHHHHd..', '.hHHHHHHHHd.', 'hHHHHHHHHHHd', 'HHHhHHHHHHHd', 'HHSSSdHHHHHd', 'HHSSSSSSdHHd', 'HdSSSSSSSSHd', 'HdSSSSSSSSdH', 'HdSSSSSSSSdH', 'dHdSSSSSSdHd', 'dHd......dHd', '.dHd....dHd.', '.dHH....HHd.', '..dH....Hd..', '...d....d...'],
    up: [5, '...hhhHH....', '..hHHHHHHd..', '.hHHHHHHHHd.', 'hHHHHhHHHHHd', 'HHHHhHHHHHHd', 'HHHhHHHHHHHd', 'HHHHHHHdHHHd', 'HHHHHHHHdHHd', 'HdHHHHHHHHdH', 'HdHHHdHHHHdH', 'dHHHHHdHHHHd', 'dHHHHHHdHHHd', '.dHHHHHHHHd.', '.dHHdHHHHHd.', '..dHHHdHHd..', '...d.dd.d...'],
    side: [5, '...hhhH.....', '..hHHHHHd...', '.hHHHHHHHd..', 'hHHHHHHHHHd.', 'HHHHHHHHHHHd', 'HHHHHHHdSSd.', 'HHHHHHSSSSS.', 'HHHdHHSSSSS.', 'HHHdHsSSSSSS', 'HHdHHHSSSSS.', 'dHHdHHHSSS..', 'dHHdHd......', 'dHHHd.......', '.dHHd.......', '.dHd........', '..d.........'],
  },
  baran: {
    down: [5, '...hhHHh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHhHHHHHH.', '.HHHHHHHHHd.', '.dSSSSSSSSd.', '.SSSSSSSSSS.', 'sSSSSSSSSSSs', 'sSSSSSSSSSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [5, '...hhHHh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHHHHHHHH.', '.HHHHHHHHHd.', '.HHHHHHHHHd.', '.dHHHHHHHdd.', 'sSdHHHHHdSSs', 'sSSddddddSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    side: [5, '...hhHHh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHHHHHHHHd', '.HHHHHHHHHd.', '.HHHHHHdSSS.', '.dHHHSSSSSS.', '.ddHSSSSSSS.', '.SdHsSSSSSSS', '.SSSSSSSSSS.', '..SSSSSSSS..'],
  },
  ilgin: {
    down: [5, '..hhhHH.....', '.hHHHHHHHd..', 'hHHHHHHHHHd.', 'HHHhHHHHHHd.', 'HHHHHHHHHdd.', 'HHHHHHdSSSd.', 'HHHHdSSSSSS.', 'HHdSSSSSSSSs', 'HHdSSSSSSSSs', 'HdSSSSSSSSS.', 'd.SSSSSSSS..'],
    up: [5, '..hhhHH.....', '.hHHHHHHHd..', 'hHHHHHHHHHd.', 'HHHHHhHHHHd.', 'HHHHHHHHHHd.', 'HHHHHHHHHdd.', 'HHHHHHHHddS.', 'HHHHHHHdSSSs', 'dHHHHHdSSSSs', '.dHHHdSSSSS.', '..dddSSSSS..'],
    side: [5, '..hhhHH.....', '.hHHHHHHHd..', 'hHHHHHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHHHHd.', 'dHHHHHHHHSd.', '.dHHHHSHSSS.', '.ddHHSSSSSS.', '.ddHsSSSSSSS', '..dHSSSSSSS.', '...dSSSSSS..'],
  },
  toprak: {
    down: [3, '...hHHHHh...', '.hHHhHHHHHd.', 'hHHHHHHhHHHd', 'HHhHHHHHHHHd', 'HHHHHHHHhHHd', 'HHHHhHHHHHHd', 'HHHHHHHHHHdd', 'dHSSSSSSSSHd', 'dHSSSSSSSSHd', 'dSSSSSSSSSSd', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [3, '...hHHHHh...', '.hHHhHHHHHd.', 'hHHHHHHhHHHd', 'HHhHHHHHHHHd', 'HHHHHHHHhHHd', 'HHHHhHHHHHHd', 'HHHHHHHHHHHd', 'HHhHHHHHHhHd', 'dHHHHHhHHHHd', 'dHHHHHHHHHdd', '.dHHHHHHHHd.', '.SddddddddS.', '..SSSSSSSS..'],
    side: [3, '..hHHHHHh...', '.hHHhHHHHHd.', 'hHHHHHHhHHHd', 'HHhHHHHHHHHd', 'HHHHHHHHhHHd', 'HHHHhHHHHHHd', 'HHHHHHHHHHHd', 'HHHhHHHSSSd.', 'HHHHHHSSSSS.', 'dHHHHsSSSSS.', 'dHHHHsSSSSSS', '.dHHdSSSSSS.', '..ddSSSSSS..'],
  },
  asya: {
    down: [2, '.....hH.....', '....hHHd....', '.....Hd.....', '....AAA.....', '..hhHHHHd...', '.hHHHHHHHHd.', '.HHHHhHHHHd.', '.HHHHHHHHHH.', '.HSSSSSSSSH.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.SSSSSSSSSSd', '..SSSSSSSSHd', '.........dHd', '..........Hd', '.........dH.', '..........d.'],
    up: [2, '.....hH.....', '....hHHd....', '.....HH.....', '....AAA.....', '..hhHHHHd...', '.hHHHHHHHHd.', '.HHHHhHHHHd.', '.HHHHHHHHHH.', '.HHHHHhHHHH.', '.HHHHHHHHHd.', '.dHHHHHHHdd.', '.SdHHhHHdSS.', '.SSdHHHdSSS.', '..SSdHdSSS..', '.....HH.....', '.....Hd.....', '.....dH.....', '......d.....'],
    side: [2, '..hHH.......', '.hHHHd......', '.HHd.A......', 'dHd.AAhH....', 'Hd.hHHHHHd..', 'H.hHHHHHHHd.', 'HdHHHHHHHHHd', 'dHHHHHHHHHd.', '.HHHHHHSSSS.', '.dHHHSSSSSS.', '..dHSSSSSSS.', '..dHsSSSSSSS', '...dSSSSSSS.', '....SSSSSS..'],
  },
  berk: {
    down: [3, '...h.hh.h...', '..hHhHHhHd..', '.hHHHHHHHHd.', 'hHHHhHHHHHHd', 'HHHHHHHhHHHd', 'HHhHHHHHHHHd', 'dHHHHHHHHHHd', '.HSdSSHSSdH.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [3, '...h.hh.h...', '..hHhHHhHd..', '.hHHHHHHHHd.', 'hHHHhHHHHHHd', 'HHHHHHHhHHHd', 'HHhHHHHHHHHd', 'HHHHHHhHHHHd', 'dHHHHHHHHHd.', '.HHHhHHHHHd.', '.dHHHHHHHdd.', '.SdHdHHdHdS.', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    side: [3, '...h.hh.....', '..hHhHHhH...', '.hHHHHHHHHd.', 'hHHHhHHHHHHd', 'HHHHHHHhHHHH', 'HHhHHHHHHHHd', 'dHHHHHHHHHHd', '.HHHHHHHSdH.', '.dHHHSSSSSS.', '.dHHsSSSSSS.', '..dHsSSSSSSS', '..dSSSSSSSS.', '...SSSSSSS..'],
  },
  sena: {
    down: [5, '...hhhhh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHHHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHHHHHd', 'HdddddddddHd', 'HHSSSSSSSSHd', 'HHSSSSSSSSHd', 'HHSSSSSSSSHd', 'dHdSSSSSSdHd', '.dd......dd.'],
    up: [5, '...hhhhh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHHHHHHHHd', 'HHHHhHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHhHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHHHHHd', 'dHHHHHHHHHHd', '.dddddddddd.'],
    side: [5, '...hhhhh....', '..hHHHHHHd..', '.hHHHHHHHHd.', '.HHHHHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHHHHHd', 'HHHHHHHdddd.', 'HHHHHHSSSSS.', 'HHHHHHSSSSSS', 'HHHHHHSSSSS.', 'dHHHHdSSSS..', '.ddddd......'],
  },
  kaan: {
    down: [6, '...hhHHH....', '..hHHHHHHd..', '.HHHhHHHHHd.', '.HHdSSSSHHd.', '.HSSSSSSSSH.', '.SSSSSSSSSS.', 'sSSSSSSSSSSs', 'sSSSSSSSSSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [6, '...hhHHH....', '..hHHHHHHd..', '.HHHHHhHHHd.', '.HHHHHHHHHd.', '.HHHHHHHHHH.', '.HHHHHHHHHd.', 'sdHHHHHHHdds', 'sSddddddddSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    side: [6, '...hhHHH....', '..hHHHHHHd..', '.HHHHHHHHHd.', '.HHHHHHSSSS.', '.HHHHSSSSSS.', '.HHHSSSSSSS.', '.dHdsSSSSSS.', '.dHdsSSSSSSS', '.SdSSSSSSSS.', '..SSSSSSSS..'],
  },
  elif: {
    down: [2, '.....C......', '....hHCH....', '...hHHHCd...', '....dHHd....', '..hHHHHHHd..', '.hHhHHHhHHd.', 'hHHHHhHHHHHd', 'HHhHHHHHhHHd', 'dHSSSSSSSShd', 'dHSSSSSSSSHd', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [2, '.....C......', '....hHCH....', '...hHHHCd...', '....dHHd....', '..hHHHHHHd..', '.hHhHHHhHHd.', 'hHHHHhHHHHHd', 'HHhHHHHHhHHd', 'dHHHHhHHHHHd', 'dHHHHHHHHHHd', '.dHHhHHHHHd.', '.SdHHHHHHdS.', '.SSddddddSS.', '..SSSSSSSS..'],
    side: [2, '....C.......', '..hHHC......', '.hHHHHC.....', '..dHHd......', '..hHHHHHHd..', '.hHhHHHhHHd.', 'hHHHHhHHHHHd', 'HHhHHHHHhHd.', 'dHHHHHHSSSd.', 'dHHHHSSSSSS.', '.dHHsSSSSSS.', '..dHsSSSSSSS', '..dSSSSSSSS.', '...SSSSSSS..'],
  },
  umut: {
    down: [4, '....BBBB....', '...AAAAAA...', '..AAAAAAAA..', '.AAAAAAAAAA.', '.AAAAHHAAAA.', 'hBBBBBBBBBBh', 'HHSHSSSHSSHH', '.SSSSSSSSSS.', 'sSSSSSSSSSSs', 'sSSSSSSSSSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [5, '...AAAAAA...', '..AAAAAAAA..', '.AAAAAAAAAA.', '.AAAAAAAAAA.', 'hBBBBBBBBBBh', 'HBBBBBBBBBBH', '.HBBBBBBBBH.', 'sHHHHHHHHHHs', 'sSHHdHHdHHSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    side: [5, '...AAAAAA...', '..AAAAAAAA..', '.AAAAAAAAAA.', 'BAAAAAAAAAA.', 'BBBBBBBBBBh.', 'BBHHHHHSHSH.', '.HHHHSSSSSS.', '.dHHsSSSSSS.', '.dHHsSSSSSSS', '..dSSSSSSSS.', '...SSSSSSS..'],
  },
  melis: {
    down: [5, '...hHHHh....', '..AAAAAAAA..', '.hHdHdHdHHd.', '.HdHdHdHdHd.', '.HHdHdHdHHd.', '.HSSSSSSSSH.', '.SSSSSSSSSS.', 'BSSSSSSSSSSB', 'BSSSSSSSSSSB', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [5, '...hHHHh....', '..AAAAAAAA..', '.hHdHdHdHHd.', '.HdHdHdHdHd.', '.HHdHdHdHHd.', '.HdHdHdHdHd.', '.dHHhHHhHHd.', 'BdHHHHHHHHdB', 'BSdHdHHdHdSB', '.SSSHdHdSSS.', '..SSHdHdSS..', '....HdHd....', '....dHdH....', '.....dd.....'],
    side: [5, '...hHHHh....', '..hAAAAAAd..', '.hHdHdHdHHd.', 'hHdHdHdHdHd.', 'HdHdHdHdHHd.', 'dHdHdHHSSSS.', 'HdHdHBSSSSS.', 'dHdHHBSSSSS.', 'HdHdHBSSSSSS', 'dHd.SSSSSSS.', '.d...SSSSSS.', 'Hd..........', 'dH..........', '.d..........'],
  },
  tolga: {
    down: [4, '....hhhhh...', '..hhHHHHHh..', '.hHHHHHHHHd.', '.HHHhHHHHHHd', '.HHHHHHHHHd.', '.dHSSSSSSHd.', '.SSSSSSSSSS.', '.SSSSSSSSSS.', 'sSSSSSSSSSSs', 'sSSSSSSSSSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [4, '....hhhhh...', '..hhHHHHHh..', '.hHHHHHHHHd.', '.HHHHhHHHHHd', '.HHHHHHHHHd.', '.HHHHHHHHHd.', '.HHHHHHHHHd.', '.dHHHHHHHdd.', 'sSdHHHHHdSSs', 'sSSddddddSSs', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    side: [4, '.....hhhh...', '...hhHHHHhh.', '..hHHHHHHHHd', '.HHHHHHHHHHd', '.HHHHHHHHHd.', '.HHHHHHHdSS.', '.dHHHHSSSSS.', '.dHHHSSSSSS.', '.ddHSSSSSSS.', '.SdHsSSSSSSS', '.SSSSSSSSSS.', '..SSSSSSSS..'],
  },
  husnu: {
    down: [6, '...SSSSSS...', '..SSSSSSSS..', '.SSSSSSSSSS.', '.hSSSSSSSSh.', '.HSSSSSSSSH.', 'HHSSSSSSSSHH', 'sHSSSSSSSSHs', 'sdSSSSSSSSds', '.SSSSSSSSSS.', '..SSSSSSSS..'],
    up: [6, '...SSSSSS...', '..SSSSSSSS..', '.SSSSSSSSSS.', '.SSSSSSSSSS.', '.HSSSSSSSSH.', 'HHHSSSSSSHHH', 'sHHHHHHHHHHs', 'sdHHHHHHHHds', '.SdddddddSS.', '..SSSSSSSS..'],
    side: [6, '...SSSSSS...', '..SSSSSSSS..', '.SSSSSSSSSS.', '.hSSSSSSSSS.', '.HHSSSSSSSS.', '.HHHSSSSSSS.', '.HHsSSSSSSS.', '.dHsSSSSSSSS', '.SdSSSSSSSS.', '..SSSSSSSS..'],
  },
};

const RS = RAMPS;
/** 12 ajan + Pyn + müdür + Tolga + Tekir. look: üretecin kullandığı parçalar (renkler palet içinden).
 *  Müdürün adı kasanın sahibinin adıdır (ilk açılışta sorulan hitap; ofis-engine.js nameTheManager). */
export const CHARACTERS = {
  pyn: { name: 'Pyn', role: 'Patron', roleEn: 'Boss', tool: null, color: '#F2C14E', kind: 'pyn', label: 'CORTEX · PATRON', home: 'pyn',
    bio: 'Ofisin patronu, huysuz bakışlı bir ananas. Az konuşur, her şeyi bir "Hmm." ile onaylar; ekibiyle gizlice gurur duyar.', look: { body: [O[1], O[3], O[4]], leaf: [G[1], G[2], G[3], G[4]], tie: [B[0], B[1]] } },
  mudur: { name: 'Müdür', role: 'Müdür', roleEn: 'Manager', tool: null, color: '#F5F0E6', kind: 'mudur', label: 'CORTEX · MÜDÜR', home: 'mudur',
    bio: 'Ofisin müdürü, bu beynin sahibi. Lacivert takımını hiç çıkarmaz; işler yolunda gidince kollarını kavuşturup gülümser.',
    look: { skin: 'sk1', hair: 'tolga', hc: [W[2], W[3], W[4]], top: { kind: 'blazer', c: [B[0], B[1], B[2]], inner: [B[3], B[4], K[7]] }, bottom: { kind: 'pants', c: [B[0], B[1], B[2]] }, shoes: { kind: 'shoe', c: [K[0], K[1], K[2]] }, tie: [S[3], S[4]], stubble: true, smile: true } },
  tolga: { name: 'Tolga', role: 'Yazılımcı', roleEn: 'Developer', tool: null, color: '#7C9CF0', kind: 'dev', label: 'CORTEX · YAZILIMCI', home: 'tolga', hardy: true,
    bio: 'Cortex\'i yazan yazılımcı; bu ofisin her tuğlası onun klavyesinden çıktı. Hızlı karar verir, tek pikseli kaçırmaz, terminali sevmez: her şey uygulamanın içinden kurulsun. Gece ikide "yarın devam" der, sabah ilk o gelir.',
    look: { skin: 'sk1', hair: 'tolga', hc: [W[2], W[3], W[4]], top: { kind: 'hoodie', c: [B[0], B[1], B[2]], mark: O[4] }, bottom: { kind: 'pants', c: [K[1], K[2], K[3]] }, shoes: { kind: 'sneaker', c: [K[4], K[6], K[7]] }, stubble: true, smile: true, neckphones: true } },
  defne: { name: 'Defne', role: 'Kıdemli yazar', roleEn: 'Senior writer', tool: 'claude', color: '#E07A5F', home: 'defne',
    bio: 'Uzun ve özenli cümleler kurar, dipnotsuz metin teslim etmez. Her karardan önce bir kez "emin misin?" diye sorar.',
    look: { skin: 'sk2', hair: 'defne', hc: [W[2], W[3], W[4]], top: { kind: 'cardigan', c: [R[3], R[4], R[5]], inner: [W[5], W[6], K[7]] }, bottom: { kind: 'pants', c: [K[0], K[1], K[2]] }, shoes: { kind: 'shoe', c: [W[0], W[1], W[2]] }, glasses: K[1], blush: true } },
  baran: { name: 'Baran', role: 'Mühendis', roleEn: 'Engineer', tool: 'codex', color: '#5BD77A', home: 'baran',
    bio: 'Kısa konuşur, terminalden çıkmaz. Çalışan bir şeye dokunulmasından hoşlanmaz: "çalışıyor, dokunma".',
    look: { skin: 'sk2', hair: 'baran', hc: [K[0], K[1], K[2]], top: { kind: 'hoodie', c: [K[0], K[1], K[2]], mark: G[4] }, bottom: { kind: 'pants', c: [B[0], B[1], B[2]] }, shoes: { kind: 'sneaker', c: [K[4], K[6], K[7]] }, beard: true, neckphones: true } },
  ilgin: { name: 'Ilgın', role: 'Açık kaynakçı', roleEn: 'Open-source tinkerer', tool: 'opencode', color: '#6FDCB8', home: 'ilgin',
    bio: 'Çıkan her ücretsiz modeli dener, her şeyi kurcalar. En sevdiği cümle: "bunun açık kaynak bir alternatifi var".',
    look: { skin: 'sk1', hair: 'ilgin', hc: [C[2], C[3], C[4]], top: { kind: 'plaid', c: [S[2], S[3], S[4]] }, bottom: { kind: 'cargo', c: [G[0], G[1], G[2]] }, shoes: { kind: 'boot', c: [K[0], W[1], W[2]] } } },
  toprak: { name: 'Toprak', role: 'Araştırmacı', roleEn: 'Researcher', tool: 'gemini', color: '#6FA8DC', home: 'toprak',
    bio: 'Meraklıdır, aynı anda kırk sekme açar. Bir cevabı kesinleştirmeden önce "bir kaynağa daha bakayım" der.',
    look: { skin: 'sk5', hair: 'toprak', hc: [K[0], W[0], W[1]], top: { kind: 'vest', c: [B[3], B[4], K[7]], vest: [B[0], B[1], B[2]] }, bottom: { kind: 'pants', c: [W[4], W[5], W[6]] }, shoes: { kind: 'shoe', c: [W[0], W[1], W[2]] }, hold: 'book' } },
  asya: { name: 'Asya', role: 'Çevirmen', roleEn: 'Translator', tool: 'qwen', color: '#A98BE0', home: 'asya',
    bio: 'Cümlenin ortasında dil değiştirir. Atasözlerini harfi harfine çevirir, sonra herkesin yüzüne bakıp bekler.',
    look: { skin: 'sk1', hair: 'asya', hc: [K[0], K[1], B[1]], acc: [P[3], P[1], P[3]], top: { kind: 'blazer', c: [P[1], P[2], P[3]], inner: [K[6], K[7], K[7]] }, bottom: { kind: 'pants', c: [K[0], K[1], K[2]] }, shoes: { kind: 'shoe', c: [K[0], K[1], K[2]] }, blush: true } },
  berk: { name: 'Berk', role: 'Stajyer', roleEn: 'Intern', tool: null, color: '#D46FB0', home: 'berk',
    bio: 'Fazla hevesli stajyer. Elinde hep birinin kahvesi, dilinde hep aynı soru: "abi bunu ben yapabilir miyim?"',
    look: { skin: 'sk1', hair: 'berk', hc: [O[2], O[4], O[5]], top: { kind: 'varsity', c: [R[1], R[2], R[3]] }, bottom: { kind: 'pants', c: [B[1], B[2], B[3]] }, shoes: { kind: 'sneaker', c: [K[4], K[6], K[7]] }, lanyard: true, blush: true, hold: 'coffee' } },
  sena: { name: 'Sena', role: 'Editör', roleEn: 'Editor', tool: null, color: '#E8506A', home: 'sena',
    bio: 'Yazım hatasından nefret eder, kırmızı kalemi elinden düşmez. Başlıkları düzeltir: "bu başlık olmamış".',
    look: { skin: 'sk3', hair: 'sena', hc: [K[0], K[1], K[2]], top: { kind: 'turtleneck', c: [K[3], K[4], K[5]], inner: [K[0], K[1], K[2]] }, bottom: { kind: 'pants', c: [K[1], K[2], K[3]] }, shoes: { kind: 'shoe', c: [K[0], K[1], R[2]] }, lips: R[3], hold: 'pen' } },
  kaan: { name: 'Kaan', role: 'Arşivci', roleEn: 'Archivist', tool: null, color: '#C9A27A', home: 'kaan',
    bio: 'Titiz arşivci, her şeyi mühürler. Ona göre makbuzu olmayan iş yapılmamış sayılır.',
    look: { skin: 'sk1', hair: 'kaan', hc: [K[3], K[5], K[6]], top: { kind: 'shirtvest', c: [K[5], K[6], K[7]], vest: [W[1], W[2], W[3]] }, bottom: { kind: 'pants', c: [W[1], W[2], W[3]] }, shoes: { kind: 'shoe', c: [W[0], W[1], W[2]] }, glasses: O[2], chain: O[3], mustache: 'bushy', bowtie: R[2] } },
  elif: { name: 'Elif', role: 'Haritacı', roleEn: 'Cartographer', tool: null, color: '#B9D95A', home: 'elif',
    bio: 'Notlar arasındaki ipleri o çeker. Her yerde bir bağlantı görür: "bu not şununla bağlantılı!"',
    look: { skin: 'sk2', hair: 'elif', hc: [W[0], W[1], W[2]], acc: [O[4], O[4], O[4]], top: { kind: 'overalls', c: [O[2], O[4], O[5]], vest: [G[1], G[2], G[3]] }, bottom: { kind: 'pants', c: [G[1], G[2], G[3]] }, shoes: { kind: 'sneaker', c: [R[2], R[3], R[4]] }, blush: true } },
  umut: { name: 'Umut', role: 'Kurye', roleEn: 'Courier', tool: null, color: '#F0973A', home: 'umut',
    bio: 'Gelen her notu ilk o görür. Hızlıdır, meraklıdır; ofisin dedikodusu onun çantasında dolaşır.',
    look: { skin: 'sk4', hair: 'umut', hc: [W[1], W[2], W[3]], acc: [R[3], R[2], R[4]], top: { kind: 'jacket', c: [O[1], O[3], O[4]] }, bottom: { kind: 'shorts', c: [K[1], K[2], K[3]] }, shoes: { kind: 'sneaker', c: [K[4], K[6], K[7]] }, bag: [W[1], W[2], W[3]] } },
  melis: { name: 'Melis', role: 'Sistemci', roleEn: 'Sysadmin', tool: null, color: '#4FC3D9', home: 'melis',
    bio: 'Araçları ayakta tutan sistemci. Kuru espri yapar: "kim yine sunucuya çay döktü?"',
    look: { skin: 'sk5', hair: 'melis', hc: [K[0], K[1], K[2]], acc: [K[4], K[1], K[2]], top: { kind: 'tee', c: [K[0], K[1], K[2]] }, bottom: { kind: 'cargo', c: [K[2], K[3], K[4]] }, shoes: { kind: 'boot', c: [K[0], K[1], K[2]] }, headset: true, toolbelt: true } },
  husnu: { name: 'Hüsnü amca', role: 'Çaycı', roleEn: 'Tea man', tool: null, color: '#E6D3AE', home: 'husnu',
    bio: 'Ofisin çaycısı, herkese "evladım" der. Tepsisiyle salona girdiğinde herkes bilir: "çaylar taze!"',
    look: { skin: 'sk1', hair: 'husnu', hc: [K[5], K[6], K[7]], top: { kind: 'shirtvest', c: [K[5], K[6], K[7]], vest: [K[0], K[1], K[2]] }, bottom: { kind: 'pants', c: [K[0], K[1], K[2]] }, shoes: { kind: 'shoe', c: [K[0], K[1], K[2]] }, mustache: 'white', bald: true } },
  tekir: { name: 'Tekir', role: 'Ofis kedisi', roleEn: 'Office cat', tool: null, color: '#A7AFBB', kind: 'cat', label: 'CORTEX · OFİS KEDİSİ', home: 'catbed',
    bio: 'Ofisin gri tekiri. Gündüz kanepede uyur, akşamüstü masaların arasında devriye gezer.', look: { fur: [K[2], K[3], K[4], K[5]], belly: K[6], eye: O[4] } },
};
for (const c of Object.values(CHARACTERS)) if (!c.label) c.label = 'CORTEX · AJAN';

function rig(pose, dir, f) {
  const r = { by: 0, hy: 0, seat: false, lift: [0, 0], spread: 0, swap: false, swing: 0, arms: ['side', 'side'], eyes: 'open', mouth: 0, t: 0 };
  switch (pose) {
    case 'idle': r.by = f ? 1 : 0; break;
    case 'walk': case 'carry':
      r.by = f % 2 ? -1 : 0;
      if (dir === 'side') { r.spread = f % 2 ? 0 : 2; r.swap = f === 2; r.swing = [1, 0, -1, 0][f]; }
      else { r.lift = [[0, 0], [0, 1], [0, 0], [1, 0]][f]; r.swing = [0, 1, 0, -1][f]; }
      if (pose === 'carry') r.arms = ['fwd', 'fwd'];
      break;
    case 'sit': r.seat = true; r.by = 2; r.arms = ['lap', 'lap']; break;
    case 'type': r.seat = true; r.by = 2; r.arms = ['type', 'type']; r.t = f; break;
    case 'phone': r.arms = ['phone', 'phone']; r.eyes = 'down'; r.t = f; break;
    case 'yawn': r.eyes = f === 0 ? 'half' : 'closed'; r.mouth = [1, 3, 2][f]; if (f === 1) { r.arms = ['side', 'up']; r.hy = -1; } break;
    case 'drink': r.arms = ['side', f ? 'mouth' : 'chest']; r.eyes = f ? 'closed' : 'open'; break;
    case 'talk': r.arms = ['side', f ? 'gesture2' : 'gesture']; r.mouth = f ? 1 : 2; break;
    case 'sleep': r.seat = true; r.by = 2 + (f ? 1 : 0); r.hy = 1; r.eyes = 'closed'; r.arms = ['lap', 'lap']; break;
  }
  return r;
}

function drawMask(b, rowsArr, ox, oy, map) {
  const y0 = rowsArr[0];
  for (let j = 1; j < rowsArr.length; j++) { const row = rowsArr[j]; for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch === '.') continue; const c = map[ch]; if (c) b.p(2 + i + ox, y0 + j - 1 + oy, c); } }
}

function legsFront(b, r, L, back) {
  const P = L.bottom.c, Sh = L.shoes, by = r.by, shorts = L.bottom.kind === 'shorts', sk = RAMPS[L.skin];
  if (r.seat) {
    b.r(5, 24 + by, 6, 28 - (24 + by), P[1]); if (!back) b.hl(5, 26, 6, P[2]);
    if (!back) { for (const x of [4, 9]) { b.r(x, 28, 3, 2, Sh.c[1]); b.hl(x, 29, 3, Sh.c[0]); b.p(x, 28, Sh.c[2]); } }
    return;
  }
  const hip = 24 + by; b.r(5, hip, 6, 26 - hip, P[1]); b.hl(5, hip, 6, back ? P[1] : P[1]);
  [5, 9].forEach((x, i) => {
    const lift = r.lift[i], bot = 27 - lift;
    const legC = shorts ? sk[1] : P[1], legD = shorts ? sk[0] : P[0];
    for (let y = 26; y <= bot; y++) { b.p(x, y, legC); b.p(x + 1, y, legD); }
    if (L.bottom.kind === 'cargo' && !back) b.p(x + (i ? 1 : 0), 26, P[0]);
    const sx = i ? 9 : 4, sy = 28 - lift, boot = Sh.kind === 'boot';
    if (boot) b.r(x, sy - 1, 2, 1, Sh.c[1]);
    b.r(sx, sy, 3, 2, Sh.c[1]); b.hl(sx, sy + 1, 3, Sh.c[0]); if (!back) b.p(i ? sx + 2 : sx, sy, Sh.c[2]);
    if (Sh.kind === 'sneaker') b.hl(sx, sy + 1, 3, K[4]);
  });
}
function torsoFront(b, r, L, back) {
  const T = L.top, c = T.c, y0 = 17 + r.by, k = T.kind;
  b.r(5, y0, 6, 7, c[1]); b.hl(4, y0, 8, c[1]); b.p(4, y0, null); b.p(11, y0, null);
  b.hl(5, y0, 6, c[2]); b.vl(5, y0 + 2, 4, c[0]); b.vl(10, y0 + 2, 4, c[0]); b.hl(5, y0 + 6, 6, c[0]);
  const inn = T.inner, v = T.vest;
  if (k === 'plaid') { for (let y = y0; y < y0 + 8; y++) for (let x = 5; x < 11; x++) { if (x % 3 === 1) b.p(x, y, c[0]); else if ((y - y0) % 3 === 2) b.p(x, y, c[2]); } b.hl(5, y0 + 7, 6, c[0]); b.p(4, y0 + 6, c[1]); b.p(11, y0 + 6, c[1]); }
  if (back) {
    if (k === 'hoodie' || k === 'varsity') { b.r(6, y0, 4, 2, c[2]); b.hl(6, y0 + 2, 4, c[0]); }
    if (k === 'vest' || k === 'shirtvest' || k === 'overalls') { b.r(6, y0 + 1, 4, 5, v[1]); b.hl(6, y0 + 1, 4, v[2]); if (k === 'overalls') { b.vl(6, y0, 1, v[1]); b.vl(9, y0, 1, v[1]); line(b, 6, y0 + 1, 9, y0 + 3, v[0]); line(b, 9, y0 + 1, 6, y0 + 3, v[0]); } }
    if (k === 'blazer' || k === 'turtleneck') { b.vl(8, y0 + 3, 3, c[0]); if (k === 'turtleneck') b.hl(6, y0, 4, inn[1]); }
    if (k === 'jacket') { b.hl(5, y0 + 4, 6, K[6]); b.r(6, y0, 4, 1, c[0]); }
    return;
  }
  switch (k) {
    case 'cardigan': b.r(7, y0, 2, 6, inn[1]); b.p(7, y0, inn[2]); b.p(8, y0 + 2, inn[0]); b.p(8, y0 + 4, inn[0]); b.p(6, y0 + 4, c[0]); break;
    case 'hoodie': b.p(6, y0, c[2]); b.p(9, y0, c[2]); b.p(6, y0 + 1, K[5]); b.p(9, y0 + 1, K[5]); b.p(6, y0 + 2, K[4]); b.p(9, y0 + 2, K[4]); b.p(7, y0 + 2, T.mark); b.p(8, y0 + 3, T.mark); b.p(7, y0 + 4, T.mark); b.hl(6, y0 + 5, 4, c[0]); break;
    case 'vest': b.r(5, y0 + 1, 6, 5, v[1]); b.vl(5, y0 + 2, 4, v[0]); b.vl(10, y0 + 2, 4, v[0]); b.p(7, y0 + 1, c[1]); b.p(8, y0 + 1, c[1]); b.p(7, y0 + 2, c[1]); b.p(6, y0, K[7]); b.p(9, y0, K[7]); b.hl(5, y0 + 6, 6, v[0]); for (let x = 6; x < 10; x += 2) b.p(x, y0 + 4, v[2]); break;
    case 'blazer': b.r(7, y0, 2, 5, inn[1]); b.p(6, y0 + 1, c[2]); b.p(9, y0 + 1, c[2]); b.p(6, y0 + 2, c[2]); b.p(9, y0 + 2, c[2]); b.p(9, y0 + 4, K[5]);
      if (L.tie) { b.p(6, y0, inn[1]); b.p(9, y0, inn[1]); b.hl(7, y0, 2, L.tie[0]); for (let y = y0 + 1; y < y0 + 4; y++) { b.p(7, y, L.tie[1]); b.p(8, y, L.tie[0]); } b.p(7, y0 + 4, L.tie[0]); } break;
    case 'varsity': b.hl(5, y0 + 6, 6, K[6]); b.p(9, y0 + 2, K[7]); b.p(9, y0 + 3, K[7]); b.p(6, y0, c[2]); b.p(9, y0, c[2]); break;
    case 'turtleneck': b.r(7, y0, 2, 6, inn[1]); b.hl(6, y0, 4, inn[2]); b.p(6, y0 + 1, c[2]); b.p(9, y0 + 1, c[2]); break;
    case 'shirtvest': b.r(5, y0 + 1, 6, 5, v[1]); b.vl(5, y0 + 2, 4, v[0]); b.vl(10, y0 + 2, 4, v[0]); b.r(7, y0, 2, 3, c[2]); b.p(7, y0 + 3, c[1]); b.p(8, y0 + 4, v[2]); b.p(8, y0 + 5, v[2]); b.hl(5, y0 + 6, 6, v[0]); b.hl(6, y0, 4, c[2]); break;
    case 'overalls': b.r(6, y0 + 3, 4, 4, v[1]); b.hl(6, y0 + 3, 4, v[2]); b.vl(6, y0, 3, v[1]); b.vl(9, y0, 3, v[1]); b.p(6, y0 + 3, O[4]); b.p(9, y0 + 3, O[4]); b.hl(5, y0 + 6, 6, v[0]); b.p(7, y0 + 5, v[0]); b.p(8, y0 + 5, v[0]); break;
    case 'jacket': b.vl(8, y0 + 1, 6, c[0]); b.hl(5, y0 + 4, 6, K[6]); b.p(8, y0 + 4, c[0]); b.p(6, y0, c[2]); b.p(9, y0, c[2]); b.p(5, y0 + 1, c[0]); b.p(10, y0 + 1, c[0]); break;
    case 'tee': b.p(7, y0 + 2, K[3]); b.p(8, y0 + 2, K[3]); b.p(7, y0 + 3, K[3]); break;
  }
}
function armsFront(b, r, L, back, phase) { // phase 0: kafadan önce, 1: kafadan sonra
  const T = L.top, s = (T.kind === 'vest' || T.kind === 'shirtvest') ? T.c : (T.kind === 'overalls' ? T.c : T.c), y0 = 17 + r.by, sk = RAMPS[L.skin];
  const short = T.kind === 'tee' || T.kind === 'overalls', sl = (i) => (short && i >= 2 ? sk[1] : s[1]);
  [0, 1].forEach((side) => {
    const mode = r.arms[side], late = mode === 'up' || mode === 'mouth';
    if ((phase === 1) !== late) return;
    const x = side ? 11 : 4, inw = side ? -1 : 1, out = -inw;
    const P = (px, py, c) => b.p(px, py, c);
    const hand = (px, py) => { P(px, py, sk[1]); if (side === 1) b.hand = [px, py]; if (side === 0 && mode !== 'side') b.handL = [px, py]; };
    switch (mode) {
      case 'side': { const dy = side ? -r.swing : r.swing; for (let i = 0; i < 5; i++) P(x, y0 + 1 + i, sl(i)); if (dy > 0) P(x, y0 + 6, sl(5)); hand(x, y0 + 6 + dy); if (side === 0) b.handL = [x, y0 + 6 + dy]; break; }
      case 'fwd': P(x, y0 + 1, sl(0)); P(x, y0 + 2, sl(1)); P(x + inw, y0 + 3, sl(2)); if (!back) { P(x + inw, y0 + 4, sl(3)); hand(x + 2 * inw, y0 + 4); } b.hand = [8, y0 + 4]; break;
      case 'type': if (back) { P(x, y0 + 1, sl(0)); P(x, y0 + 2, sl(1)); P(x + out, y0 + 3 - (side ? 1 - r.t : r.t), sl(2)); b.hand = [8, y0 + 5]; } else { for (let i = 0; i < 3; i++) P(x, y0 + 1 + i, sl(i)); P(x + inw, y0 + 4, sl(3)); hand(x + 2 * inw, y0 + 5 - (side ? 1 - r.t : r.t)); b.hand = [8, y0 + 5]; } break;
      case 'phone': P(x, y0 + 1, sl(0)); P(x, y0 + 2, sl(1)); P(x + inw, y0 + 3, sl(2)); hand(x + 2 * inw, y0 + 3); if (side) { b.r(7, y0 + 1, 2, 3, K[1]); b.p(7, y0 + 1, r.t ? C[4] : C[3]); b.p(8, y0 + 2, r.t ? C[3] : C[4]); b.hand = [8, y0 + 2]; } break;
      case 'chest': P(x, y0 + 1, sl(0)); P(x + inw, y0 + 2, sl(1)); hand(x + 2 * inw, y0 + 3); break;
      case 'mouth': P(x, y0, sl(0)); P(x + inw, y0 - 1, sl(1)); hand(x + 2 * inw, y0 - 2); break;
      case 'gesture': P(x, y0 + 1, sl(0)); P(x + out, y0 + 2, sl(1)); hand(x + out * 2, y0 + 1); break;
      case 'gesture2': P(x, y0 + 1, sl(0)); P(x, y0 + 2, sl(1)); P(x + out, y0 + 3, sl(2)); hand(x + out, y0 + 4); break;
      case 'up': P(x, y0, sl(0)); for (let i = 1; i < 8; i++) P(x + out * 2, y0 - i, sl(i > 4 ? 4 : 1)); P(x + out, y0 - 1, sl(0)); hand(x + out * 2, y0 - 8); break;
      case 'lap': for (let i = 0; i < 4; i++) P(x, y0 + 1 + i, sl(i)); P(x + inw, y0 + 5, sl(4)); hand(x + 2 * inw, y0 + 6); break;
    }
    if (mode === 'side' && L.hold && !back) holdItem(b, L.hold, side, x, y0 + 6 + (side ? -r.swing : r.swing));
  });
}
function holdItem(b, kind, side, hx, hy) {
  if (kind === 'book' && side === 0) { b.r(hx - 1, hy - 3, 3, 5, B[2]); b.vl(hx - 1, hy - 3, 5, B[1]); b.p(hx + 1, hy - 3, K[7]); b.p(hx, hy - 1, O[3]); }
  if (kind === 'coffee' && side === 1) { b.r(hx, hy - 2, 2, 3, K[7]); b.hl(hx, hy - 2, 2, W[1]); b.p(hx + 1, hy, W[4]); }
  if (kind === 'pen' && side === 1) { b.vl(hx + 1, hy - 3, 3, R[3]); b.p(hx + 1, hy - 3, R[4]); }
}
function faceDown(b, r, L, oy) {
  const sk = RAMPS[L.skin], E = K[0], lid = ol(sk[1]);
  const eyes = r.eyes;
  for (const x of [6, 9]) {
    if (eyes === 'open') { b.p(x, 12 + oy, E); b.p(x, 13 + oy, E); }
    else if (eyes === 'closed') { b.p(x - (x === 6 ? 1 : 0), 13 + oy, lid); b.p(x + (x === 9 ? 1 : 0), 13 + oy, lid); }
    else { b.p(x, 13 + oy, E); b.p(x, 12 + oy, sk[0]); }
  }
  if (L.blush) { b.p(4, 14 + oy, R[5]); b.p(11, 14 + oy, R[5]); }
  if (L.lips) { b.p(7, 14 + oy, L.lips); b.p(8, 14 + oy, L.lips); }
  if (r.mouth === 1) { b.p(7, 14 + oy, R[2]); }
  if (r.mouth === 2) { b.p(7, 14 + oy, R[1]); b.p(8, 14 + oy, R[1]); }
  if (r.mouth === 3) { b.r(7, 14 + oy, 2, 2, K[0]); b.p(7, 15 + oy, R[3]); }
  if (L.stubble) { for (const [x, y] of [[3, 14], [12, 14], [4, 15], [5, 15], [6, 15], [9, 15], [10, 15], [11, 15]]) b.p(x, y + oy, sk[0]); }
  if (L.smile && !r.mouth) { b.p(6, 14 + oy, lid); b.p(9, 14 + oy, lid); b.hl(7, 15 + oy, 2, lid); }
  if (L.beard) { const h = L.hc[2]; b.p(3, 13 + oy, h); b.p(12, 13 + oy, h); b.p(3, 14 + oy, h); b.p(12, 14 + oy, h); b.p(4, 15 + oy, h); b.p(11, 15 + oy, h); b.hl(5, 15 + oy, 6, sk[0]); b.p(6, 15 + oy, h); b.p(9, 15 + oy, h); b.p(7, 15 + oy, h); b.p(8, 15 + oy, h); }
  if (L.mustache === 'bushy') { b.hl(5, 14 + oy, 6, L.hc[1]); b.p(5, 15 + oy, L.hc[1]); b.p(10, 15 + oy, L.hc[1]); b.p(6, 14 + oy, L.hc[2]); }
  if (L.mustache === 'white') { b.hl(6, 14 + oy, 4, K[7]); b.p(5, 15 + oy, K[6]); b.p(10, 15 + oy, K[6]); }
  if (L.bald) b.p(5, 7 + oy, K[7]);
  if (L.glasses) { const g = L.glasses; b.hl(5, 11 + oy, 2, g); b.hl(9, 11 + oy, 2, g); b.p(7, 12 + oy, g); b.p(8, 12 + oy, g); b.p(4, 12 + oy, g); b.p(11, 12 + oy, g); b.p(5, 12 + oy, K[7]); b.p(10, 12 + oy, K[7]); b.p(5, 14 + oy, g); b.p(6, 14 + oy, g); b.p(9, 14 + oy, g); b.p(10, 14 + oy, g); if (L.chain) { b.p(4, 13 + oy, L.chain); b.p(4, 15 + oy, L.chain); b.p(11, 13 + oy, L.chain); b.p(11, 15 + oy, L.chain); } }
  if (L.headset) { b.p(4, 14 + oy, K[2]); b.p(5, 15 + oy, K[2]); b.p(6, 15 + oy, K[1]); }
}
function neckFront(b, r, L, back) {
  const y0 = 17 + r.by;
  if (L.neckphones) { b.hl(5, y0, 6, K[2]); b.r(4, y0 - 1, 1, 2, K[1]); b.r(11, y0 - 1, 1, 2, K[1]); if (!back) { b.p(4, y0 - 1, G[4]); b.p(11, y0 - 1, G[4]); } }
  if (L.bowtie && !back) { b.p(6, y0, L.bowtie); b.p(9, y0, L.bowtie); b.p(7, y0, dk(L.bowtie)); b.p(8, y0, dk(L.bowtie)); b.p(6, y0 + 1, L.bowtie); b.p(9, y0 + 1, L.bowtie); }
  if (L.lanyard && !back) { b.p(6, y0 + 1, B[4]); b.p(9, y0 + 1, B[4]); b.p(7, y0 + 2, B[4]); b.p(8, y0 + 2, B[4]); b.r(7, y0 + 3, 2, 2, K[7]); b.p(7, y0 + 3, B[3]); }
  if (L.bag) { const g = L.bag; if (!back) line(b, 10, y0, 5, y0 + 5, g[0]); else line(b, 5, y0, 10, y0 + 5, g[0]); b.r(2, y0 + 5, 3, 3, g[1]); b.hl(2, y0 + 5, 3, g[2]); }
  if (L.toolbelt) { b.hl(5, y0 + 6, 6, W[1]); if (!back) { b.p(5, y0 + 7, K[5]); b.p(10, y0 + 7, O[3]); b.p(10, y0 + 8, O[2]); } }
}

function legsSide(b, r, L) {
  const P = L.bottom.c, Sh = L.shoes, by = r.by, shorts = L.bottom.kind === 'shorts', sk = RAMPS[L.skin];
  const legC = shorts ? sk[1] : P[1], legD = shorts ? sk[0] : P[0];
  if (r.seat) { b.r(6, 25, 7, 2, P[1]); b.hl(6, 25, 7, P[2]); b.r(11, 27, 2, 2, legC); b.r(11, 29, 3, 1, Sh.c[1]); b.p(13, 29, Sh.c[0]); b.r(10, 28, 4, 2, Sh.c[1]); b.hl(10, 29, 4, Sh.c[0]); return; }
  const hip = 24 + by; b.r(6, hip, 5, 26 - hip, P[1]);
  const s = r.spread;
  const leg = (front) => {
    const c1 = front ? legC : legD, c2 = front ? legD : dk(legD);
    if (s === 0) { b.r(7, 26, 2, 2, c1); b.p(8, 27, c2); b.r(7, 28, 3, 2, Sh.c[1]); b.hl(7, 29, 3, Sh.c[0]); b.p(9, 28, Sh.c[2]); return; }
    if (front) { b.r(8, 26, 2, 1, c1); b.r(9, 27, 2, 1, c1); b.r(9, 28, 3, 2, Sh.c[1]); b.hl(9, 29, 3, Sh.c[0]); b.p(11, 28, Sh.c[2]); }
    else { b.r(6, 26, 2, 1, c1); b.r(5, 27, 2, 1, c1); b.r(4, 28, 3, 2, dk(Sh.c[1])); b.hl(4, 29, 3, Sh.c[0]); }
    if (Sh.kind === 'boot') b.p(front ? 9 : 5, 27, Sh.c[1]);
  };
  leg(r.swap); leg(!r.swap);
}
function torsoSide(b, r, L) {
  const T = L.top, c = T.c, y0 = 17 + r.by, k = T.kind, v = T.vest, inn = T.inner;
  b.r(6, y0, 5, 7, c[1]); b.hl(6, y0, 5, c[2]); b.vl(10, y0 + 1, 6, c[0]); b.hl(6, y0 + 6, 5, c[0]); b.p(6, y0, null);
  if (k === 'plaid') { for (let y = y0; y < y0 + 8; y++) for (let x = 6; x < 11; x++) { if (x % 3 === 1) b.p(x, y, c[0]); else if ((y - y0) % 3 === 2) b.p(x, y, c[2]); } b.p(5, y0 + 6, c[1]); }
  if (k === 'cardigan' || k === 'blazer' || k === 'turtleneck') { b.vl(10, y0, 6, inn[1]); if (k === 'turtleneck') b.r(8, y0, 3, 1, inn[1]); if (L.tie) b.vl(10, y0 + 1, 4, L.tie[1]); }
  if (k === 'hoodie' || k === 'varsity') { b.r(5, y0, 2, 2, c[2]); b.p(10, y0 + 1, K[5]); b.p(10, y0 + 2, K[4]); if (k === 'varsity') b.hl(6, y0 + 6, 5, K[6]); }
  if (k === 'vest' || k === 'shirtvest') { b.r(6, y0 + 1, 4, 5, v[1]); b.vl(6, y0 + 1, 5, v[2]); b.p(10, y0, K[7]); b.p(9, y0 + 3, v[2]); }
  if (k === 'overalls') { b.r(8, y0 + 3, 3, 4, v[1]); b.vl(8, y0, 3, v[1]); b.p(8, y0 + 3, O[4]); }
  if (k === 'jacket') { b.vl(10, y0 + 1, 6, c[0]); b.hl(6, y0 + 4, 5, K[6]); }
  if (L.bag) { line(b, 10, y0, 6, y0 + 5, L.bag[0]); b.r(4, y0 + 3, 2, 4, L.bag[1]); b.p(4, y0 + 3, L.bag[2]); }
  if (L.toolbelt) { b.hl(6, y0 + 6, 5, W[1]); b.p(9, y0 + 7, K[5]); }
  if (L.neckphones) { b.r(7, y0 - 1, 2, 2, K[1]); b.p(8, y0 - 1, G[4]); }
  if (L.bowtie) { b.p(10, y0, L.bowtie); b.p(11, y0, dk(L.bowtie)); }
  if (L.lanyard) { b.vl(10, y0 + 1, 2, B[4]); b.r(10, y0 + 3, 2, 2, K[7]); }
}
function armSide(b, r, L) {
  const T = L.top, s = T.c, y0 = 17 + r.by, sk = RAMPS[L.skin], short = T.kind === 'tee' || T.kind === 'overalls';
  const A = (x, y, i) => { b.p(x, y, short && i >= 2 ? sk[1] : s[1]); b.p(x + 1, y, short && i >= 2 ? sk[0] : s[0]); };
  const hand = (x, y) => { b.p(x, y, sk[1]); b.hand = [x, y]; };
  const mode = r.seat ? 'seat' : r.arms[1];
  if (mode === 'fwd') { A(7, y0 + 1, 0); A(7, y0 + 2, 1); A(9, y0 + 3, 2); hand(11, y0 + 3); b.hand = [12, y0 + 3]; return; }
  if (mode === 'gesture') { A(7, y0 + 1, 0); A(8, y0 + 2, 1); b.p(10, y0 + 1, s[1]); hand(11, y0); return; }
  if (mode === 'gesture2') { A(7, y0 + 1, 0); A(7, y0 + 2, 1); A(8, y0 + 3, 2); hand(10, y0 + 4); return; }
  if (mode === 'seat' || mode === 'lap') { A(7, y0 + 1, 0); A(7, y0 + 2, 1); A(8, y0 + 3, 2); hand(10, y0 + 4); return; }
  const sw = r.swing;
  A(7, y0 + 1, 0); A(7, y0 + 2, 1);
  if (sw > 0) { A(8, y0 + 3, 2); A(8, y0 + 4, 3); hand(9, y0 + 5); }
  else if (sw < 0) { A(6, y0 + 3, 2); A(6, y0 + 4, 3); hand(6, y0 + 5); }
  else { A(7, y0 + 3, 2); A(7, y0 + 4, 3); hand(8, y0 + 5); }
  if (L.hold === 'pen') { b.vl(b.hand[0] + 1, b.hand[1] - 2, 3, R[3]); }
  if (L.hold === 'coffee') { b.r(b.hand[0], b.hand[1] - 2, 2, 3, K[7]); b.hl(b.hand[0], b.hand[1] - 2, 2, W[1]); }
}
function faceSide(b, r, L, oy) {
  const sk = RAMPS[L.skin], lid = ol(sk[1]);
  if (r.eyes === 'open') { b.p(10, 12 + oy, K[0]); b.p(10, 13 + oy, K[0]); } else if (r.eyes === 'closed') { b.p(10, 13 + oy, lid); b.p(11, 13 + oy, lid); } else { b.p(10, 13 + oy, K[0]); b.p(10, 12 + oy, sk[0]); }
  if (L.blush) b.p(10, 14 + oy, R[5]);
  if (L.lips) b.p(12, 14 + oy, L.lips);
  if (r.mouth >= 2) b.p(12, 14 + oy, R[1]);
  if (L.stubble) b.hl(8, 15 + oy, 3, sk[0]);
  if (L.smile && !r.mouth) { b.p(11, 15 + oy, lid); b.p(12, 14 + oy, lid); }
  if (L.beard) { const h = L.hc[1]; b.hl(7, 14 + oy, 3, h); b.hl(7, 15 + oy, 5, h); b.p(12, 15 + oy, h); }
  if (L.mustache === 'bushy') { b.r(11, 14 + oy, 3, 1, L.hc[1]); b.p(11, 15 + oy, L.hc[1]); }
  if (L.mustache === 'white') { b.r(11, 14 + oy, 3, 1, K[7]); }
  if (L.bald) b.p(6, 7 + oy, K[7]);
  if (L.glasses) { const g = L.glasses; b.p(11, 12 + oy, g); b.hl(10, 11 + oy, 2, g); b.p(10, 14 + oy, g); b.p(11, 14 + oy, g); b.p(9, 12 + oy, g); b.hl(6, 12 + oy, 3, g); b.p(11, 13 + oy, K[7]); if (L.chain) { b.p(8, 14 + oy, L.chain); b.p(8, 15 + oy, L.chain); } }
  if (L.headset) { b.p(8, 14 + oy, K[2]); b.p(9, 15 + oy, K[2]); b.p(10, 15 + oy, K[1]); }
}

function drawHuman(b, L, pose, dir, f) {
  const r = rig(pose, dir, f), sk = RAMPS[L.skin], hc = L.hc, acc = L.acc || [R[3], R[2], O[4]];
  const map = { H: hc[1], h: hc[2], d: hc[0], S: sk[1], s: sk[0], A: acc[0], B: acc[1], C: acc[2] };
  if (L.hair === 'umut') { map.A = acc[0]; map.B = acc[1]; }
  if (L.hair === 'melis') { map.A = K[4]; map.B = K[1]; }
  const oy = r.by + r.hy, mask = HEAD[L.hair][dir];
  b.hand = [11, 23 + r.by]; b.handL = [4, 23 + r.by];
  if (dir === 'side') {
    legsSide(b, r, L); torsoSide(b, r, L);
    drawMask(b, mask, 0, oy, map); faceSide(b, r, L, oy); armSide(b, r, L);
  } else {
    const back = dir === 'up';
    legsFront(b, r, L, back); torsoFront(b, r, L, back); armsFront(b, r, L, back, 0); neckFront(b, r, L, back);
    drawMask(b, mask, 0, oy, map); if (!back) faceDown(b, r, L, oy); armsFront(b, r, L, back, 1);
  }
  b.outline();
  return r;
}

// ── Pyn: ananas patron
function drawPyn(b, L, pose, dir, f) {
  const r = rig(pose, dir, f), by = r.by, oy = by + r.hy, [Bd, Bm, Bl] = L.body, [L0, L1, L2, L3] = L.leaf;
  const walking = pose === 'walk' || pose === 'carry';
  const sway = walking ? [0, 1, 0, -1][f] : (pose === 'idle' ? f : 0);
  // yapraklar
  const crown = dir === 'side'
    ? ['.....K......', '...L.KL.....', '...KLJK..L..', '.KL.JKJ.KJ..', '..KJJLJJK...', '...JJJKJJ...', '....IJJJI...']
    : ['......K.....', '...L..KL..K.', '...KL.KJ.KL.', '....KLJKJK..', '.KL.JKJJKJKJ', '..KJJLJJKJJ.', '...JJJKJJJ..', '....IJJJJI..'];
  const cy = dir === 'side' ? 3 : 2;
  crown.forEach((row, j) => { const sx = j < 3 ? sway : 0; for (let i = 0; i < 12; i++) { const ch = row[i]; if (ch === '.') continue; b.p(2 + i + sx, cy + j + oy, { I: L0, J: L1, K: L2, L: L3 }[ch]); } });
  // gövde
  const bx = dir === 'side' ? 4 : 3, bw = dir === 'side' ? 9 : 10, top = 9 + oy, bh = r.seat ? 16 : 17;
  oval(b, bx, top, bw, bh, Bm);
  for (let y = top; y < top + bh; y++) for (let x = bx; x < bx + bw; x++) { if (!b.g(x, y) || b.g(x, y) !== Bm) continue; const a = (x + y) % 4, c = (x - y + 40) % 4; if (a === 0 || c === 0) b.p(x, y, Bd); else if (a === 2 && c === 2) b.p(x, y, Bl); }
  b.p(bx + 2, top + 2, O[5]); b.p(bx + 1, top + 4, O[5]);
  // yüz
  if (dir === 'down') {
    const ey = 15 + oy;
    b.r(4, ey - 2, 8, 9, Bm); for (let y = ey - 2; y < ey + 7; y++) for (let x = 4; x < 12; x++) if ((x + y) % 4 === 0 && (x === 4 || x === 11 || y === ey - 2)) b.p(x, y, Bd);   // sade yüz alanı
    if (r.eyes === 'closed') { b.hl(5, ey + 1, 2, O[0]); b.hl(9, ey + 1, 2, O[0]); }
    else { b.hl(5, ey, 2, O[0]); b.hl(9, ey, 2, O[0]); b.p(5, ey + 1, K[7]); b.p(6, ey + 1, K[0]); b.p(9, ey + 1, K[0]); b.p(10, ey + 1, K[7]); }
    b.p(4, ey - 2, O[0]); b.p(5, ey - 2, O[0]); b.p(6, ey - 1, O[0]); b.p(9, ey - 1, O[0]); b.p(10, ey - 2, O[0]); b.p(11, ey - 2, O[0]);   // huysuz kaşlar
    b.r(7, ey + 2, 2, 2, O[1]); b.p(6, ey + 3, O[1]); b.p(9, ey + 3, O[1]); b.p(7, ey + 2, O[2]); b.hl(7, ey + 4, 2, O[0]);   // büyük burun
    if (r.mouth >= 2) b.r(7, ey + 5, 2, r.mouth === 3 ? 2 : 1, K[0]); else b.hl(6, ey + 6, 4, O[0]);
    b.r(7, 21 + by, 2, 1, L.tie[0]); b.r(7, 22 + by, 2, 2, L.tie[1]); b.p(7, 24 + by, L.tie[1]); b.p(8, 24 + by, L.tie[0]);  // kravat
  } else if (dir === 'side') {
    const ey = 15 + oy;
    if (r.eyes === 'closed') b.hl(10, ey + 1, 2, O[0]); else { b.hl(10, ey, 2, O[1]); b.p(11, ey + 1, K[0]); b.p(10, ey + 1, K[0]); }
    b.p(10, ey - 2, O[0]); b.p(11, ey - 1, O[0]);
    b.r(13, ey + 2, 2, 2, O[2]); b.p(13, ey + 2, O[3]); b.p(14, ey + 3, O[1]); b.p(12, ey + 2, O[1]);  // burun dışarı taşar
    b.hl(11, ey + 5, 2, O[0]); b.r(11, 21 + by, 2, 3, L.tie[1]); b.p(12, 21 + by, L.tie[0]);
  }
  // kollar
  const ay = 18 + by, arm = (x, y) => b.p(x, y, Bd);
  if (dir === 'side') {
    if (r.arms[1] === 'fwd') { arm(9, ay); arm(10, ay + 1); arm(11, ay + 1); b.hand = [12, ay + 1]; }
    else if (r.arms[1] === 'gesture') { arm(10, ay); arm(11, ay - 1); b.hand = [12, ay - 2]; }
    else { const sw = r.swing; arm(8, ay); arm(8 + sw, ay + 1); arm(8 + sw, ay + 2); b.hand = [8 + sw, ay + 3]; }
  } else {
    const m = r.arms;
    [0, 1].forEach((side) => {
      const x = side ? 13 : 2, inw = side ? -1 : 1, mode = m[side];
      if (mode === 'side') { const dy = side ? -r.swing : r.swing; arm(x, ay); arm(x, ay + 1); arm(x, ay + 2 + dy); if (side) b.hand = [x, ay + 3 + dy]; }
      else if (mode === 'fwd' || mode === 'type' || mode === 'phone' || mode === 'lap') { arm(x, ay); arm(x + inw, ay + 1); arm(x + inw * 2, ay + 2 - (mode === 'type' ? (side ? r.t : 1 - r.t) : 0)); b.hand = [8, ay + 2]; if (mode === 'phone' && side) { b.r(7, ay, 2, 3, K[1]); b.p(7, ay, r.t ? C[4] : C[3]); } }
      else if (mode === 'chest') { arm(x, ay); arm(x + inw, ay + 1); b.hand = [x + inw * 2, ay + 1]; }
      else if (mode === 'mouth') { arm(x, ay); arm(x + inw, ay - 1); b.hand = [x + inw * 2, ay - 2]; }
      else if (mode === 'gesture') { arm(x, ay); arm(x + 1, ay - 1); b.hand = [x + 2, ay - 2]; }
      else if (mode === 'gesture2') { arm(x, ay); arm(x, ay + 1); b.hand = [x, ay + 2]; }
      else if (mode === 'up') { arm(x, ay); arm(x, ay - 1); arm(x, ay - 2); arm(x - 1, ay - 3); b.hand = [x - 1, ay - 4]; }
    });
  }
  // bacaklar
  if (r.seat) { b.r(5, 26, 2, 1, Bd); b.r(9, 26, 2, 1, Bd); b.r(4, 27, 3, 2, W[1]); b.r(9, 27, 3, 2, W[1]); }
  else if (dir === 'side') { const s = r.spread; b.r(7 - (s >> 1), 26, 1, 2, Bd); b.r(8 + (s >> 1), 26, 1, 2, Bd); b.r(6 - (s >> 1), 28, 3, 1, W[1]); b.r(8 + (s >> 1), 28, 3, 1, W[2]); }
  else { [5, 9].forEach((x, i) => { const l = r.lift[i]; b.r(x + (i ? 0 : 1), 26, 1, 2 - l, Bd); b.r(x, 28 - l, 3, 1, W[1]); b.hl(x, 28 - l, 3, i ? W[2] : W[1]); }); }
  b.outline();
  return r;
}

// ── Tekir: 16×16 kedi (ayak 14, gölge 15)
function drawCat(b, L, pose, dir, f) {
  const [c0, c1, c2, c3] = L.fur, bel = L.belly, eye = L.eye, nose = R[5];
  const stripe = (x, y, w) => b.hl(x, y, w, c0);
  if (pose === 'sleep') {
    const h = f ? 1 : 0;
    oval(b, 2, 6 - h, 12, 8 + h, c2); oval(b, 3, 6 - h, 7, 4, c3); stripe(4, 8, 3); stripe(9, 7 - h, 3); stripe(6, 11, 4);
    oval(b, 9, 9 - h, 5, 4, c2); b.p(10, 9 - h, c1); b.p(13, 9 - h, c1); b.hl(10, 11 - h, 2, c0); b.p(12, 12 - h, nose);  // kafa (sağda, kıvrık)
    line(b, 3, 13, 9, 13, c1); b.p(2, 12, c1); b.p(9, 12, c3);  // kuyruk
    b.outline(); b.hand = [8, 10]; return;
  }
  if (pose === 'sit') {
    oval(b, 4, 7, 8, 8, c2); oval(b, 6, 9, 4, 5, bel); oval(b, 3, 2, 10, 7, c2); b.p(3, 1, c2); b.p(4, 1, c1); b.p(12, 1, c2); b.p(11, 1, c1); b.p(4, 2, c2); b.p(11, 2, c2);
    stripe(6, 3, 4); b.p(7, 2, c0); b.p(8, 2, c0); b.p(5, 5, eye); b.p(10, 5, eye); b.p(5, 4, c1); b.p(10, 4, c1); b.r(7, 6, 2, 1, nose); b.p(7, 7, bel); b.p(8, 7, bel);
    stripe(4, 10, 2); stripe(10, 10, 2); b.r(5, 13, 2, 2, bel); b.r(9, 13, 2, 2, bel); line(b, 11, 14, 14, 12, c1); b.p(14, 11, c1);
    b.outline(); b.hand = [8, 12]; return;
  }
  if (dir === 'side' || pose === 'stretch' || pose === 'groom') {
    let headX = 10, headY = 3, bodyY = 7, rear = 0, front = 0, legs = [[4, 0], [6, 0], [9, 0], [11, 0]];
    if (pose === 'walk') { const p = [[3, 5, 10, 12], [4, 5, 9, 11], [5, 4, 9, 12], [4, 6, 10, 11]][f]; legs = p.map((x, i) => [x, (i + f) % 2]); bodyY = 7 - (f % 2 ? 1 : 0); headY = 3 - (f % 2 ? 1 : 0); }
    if (pose === 'stretch') { if (f >= 1) { front = 2; headX = 11; headY = 5 + f; bodyY = 7; } if (f === 2) { rear = -1; legs = [[3, 0], [5, 0], [11, 0], [13, 0]]; } }
    if (pose === 'groom') {
      oval(b, 4, 6, 8, 8, c2); oval(b, 7, 9, 4, 4, bel); oval(b, 7, 1 + f, 7, 6, c2); b.p(8, f, c2); b.p(12, f, c2); b.p(12, 3 + f, eye); b.r(13, 5 + f, 1, 1, nose); stripe(8, 2 + f, 3);
      b.r(11, 7 - f, 2, 5, c3); b.p(12, 6 - f, bel); b.r(5, 13, 2, 1, c1); b.r(9, 13, 2, 1, c1); line(b, 3, 13, 1, 9, c1); b.p(1, 8, c1);
      b.outline(); b.hand = [11, 8]; return;
    }
    oval(b, 2, bodyY + rear, 11, 6 - (front ? 1 : 0), c2); b.hl(4, bodyY + rear + 1, 6, c3); stripe(5, bodyY + rear, 1); stripe(7, bodyY + rear, 1); stripe(9, bodyY + rear + 1, 1);
    for (const [x, up] of legs) b.r(x, bodyY + 4 + rear, 1, 4 - up - (bodyY + 4 + rear - 10 > 0 ? 1 : 0), x > 8 ? c2 : c1);
    oval(b, headX - 1, headY + 1, 6, 5, c2); b.p(headX - 1, headY, c2); b.p(headX + 3, headY, c2); b.p(headX + 3, headY + 1, c1); b.p(headX + 3, headY + 3, eye); b.p(headX + 5, headY + 4, nose); b.p(headX + 4, headY + 5, bel); stripe(headX, headY + 1, 2);
    const tw = pose === 'walk' ? [0, 1, 0, -1][f] : 0; line(b, 2, bodyY + rear + 2, 0, bodyY - 3 + tw, c1); b.p(0, bodyY - 4 + tw, c0);
    b.outline(); b.hand = [headX + 4, headY + 5]; return;
  }
  // walk down / up
  const bob = f % 2 ? 1 : 0, back = dir === 'up';
  oval(b, 4, 7 - bob, 8, 7, c2); if (!back) oval(b, 6, 8 - bob, 4, 5, bel); else { stripe(6, 8 - bob, 4); stripe(6, 10 - bob, 4); stripe(7, 12 - bob, 2); }
  const lp = [[4, 11, 0], [10, 11, 0]]; const step = [0, 1, 0, -1][f];
  b.r(5, 12 + (step > 0 ? 0 : 1), 2, 2 - (step > 0 ? 0 : 1) + 1, c1); b.r(9, 12 + (step < 0 ? 0 : 1), 2, 2 - (step < 0 ? 0 : 1) + 1, c1);
  if (!back) { oval(b, 3, 2 - bob, 10, 7, c2); b.p(4, 1 - bob, c2); b.p(11, 1 - bob, c2); b.p(4, 2 - bob, c1); b.p(11, 2 - bob, c1); stripe(6, 3 - bob, 4); b.p(7, 2 - bob, c0); b.p(5, 5 - bob, eye); b.p(10, 5 - bob, eye); b.r(7, 6 - bob, 2, 1, nose); b.p(7, 7 - bob, bel); b.p(8, 7 - bob, bel); }
  else { line(b, 8, 12, 8 + step, 15, c1); oval(b, 3, 1 - bob, 10, 7, c2); b.p(4, 0, c2); b.p(11, 0, c2); stripe(5, 2 - bob, 6); stripe(5, 4 - bob, 6); stripe(6, 6 - bob, 4); }
  if (!back) { line(b, 12, 10 - bob, 14, 6 + step, c1); }
  b.outline(); b.hand = [8, 9];
}

const CHAR_CACHE = new Map();
function charBuf(id, pose, dir, frame) {
  const key = `${id}|${pose}|${dir}|${frame}`; if (CHAR_CACHE.has(key)) return CHAR_CACHE.get(key);
  const ch = CHARACTERS[id]; if (!ch) throw new Error('bilinmeyen karakter: ' + id);
  const flip = dir === 'left'; const d = flip ? 'side' : dir;
  const cat = ch.kind === 'cat', b = new Buf(16, cat ? 16 : 32);
  const P = (cat ? CAT_POSES : POSES)[pose] || (cat ? CAT_POSES.walk : POSES.idle), fr = (frame | 0) % P.frames;
  let dd = d; if (!P.dirs.includes(dd)) dd = P.dirs.includes('down') ? 'down' : P.dirs[0];
  let rr;
  if (cat) drawCat(b, ch.look, pose, dd, fr);
  else if (ch.kind === 'pyn') rr = drawPyn(b, ch.look, pose, dd, fr);
  else rr = drawHuman(b, ch.look, pose, dd, fr);
  const seat = rr && rr.seat;
  if (!seat) { if (cat) { b.under(4, 14, 9, 1, SH); b.under(3, 15, 11, 1, SH2); } else { b.under(4, 29, 8, 1, SH); b.under(3, 30, 10, 1, SH); b.under(5, 31, 6, 1, SH2); } }
  let top = 31; for (let y = 0; y < b.h && top === 31; y++) for (let x = 3; x < 13; x++) { const c = b.g(x, y); if (c && c !== SH && c !== SH2) { top = y; break; } }
  const res = { b, hand: b.hand.slice(), head: [8, top], flip };
  if (flip) { b.flipX(); res.hand = [15 - res.hand[0], res.hand[1]]; res.head = [15 - res.head[0], res.head[1]]; }
  CHAR_CACHE.set(key, res); return res;
}
/** Bir karakteri 16×32 (Tekir 16×16) hücreye (ox,oy)'dan çizer. dir: 'down'|'up'|'side' (+ kolaylık için 'left'). */
export function paintCharacter(ctx, id, pose, dir, frame, ox = 0, oy = 0) { charBuf(id, pose, dir, frame).b.flush(ctx, ox, oy); }
/** El ve kafa noktaları (hücre içinde piksel). 'up' yönünde taşınan eşya karakterden ÖNCE (arkada) çizilmeli. */
export function anchors(id, pose, dir, frame) { const r = charBuf(id, pose, dir, frame); return { hand: r.hand, head: r.head }; }
/** Hücre boyutu ve ayak çapası. */
export function cellOf(id) { return CHARACTERS[id].kind === 'cat' ? { w: 16, h: 16, footX: 8, footY: 14 } : { w: 16, h: 32, footX: 8, footY: 30 }; }


// ═════════════ HARİTA ═════════════
const MW = 61, MH = 42;
const ROOM_DEFS = [
  { id: 'pyn', tr: "PYN'İN ODASI", en: "PYN'S OFFICE", x: 1, y: 4, w: 14, h: 9, floor: 'r', face: 'lambri', faceY: 1 },
  { id: 'harita', tr: 'HARİTA ODASI', en: 'MAP ROOM', x: 16, y: 4, w: 14, h: 9, floor: 'c', face: 'paint', faceY: 1 },
  { id: 'arsiv', tr: 'ARŞİV', en: 'ARCHIVE', x: 31, y: 4, w: 14, h: 9, floor: 'h', face: 'library', faceY: 1 },
  { id: 'mudur', tr: 'MÜDÜR ODASI', en: "MANAGER'S OFFICE", x: 46, y: 4, w: 14, h: 9, floor: 'w', face: 'plaster', faceY: 1 },
  { id: 'salon', tr: 'YAZI İŞLERİ', en: 'NEWSROOM', x: 1, y: 17, w: 59, h: 11, floor: 't', face: 'salon', faceY: 14 },
  { id: 'mutfak', tr: 'MUTFAK', en: 'KITCHEN', x: 1, y: 32, w: 14, h: 9, floor: 'k', face: 'tile', faceY: 29 },
  { id: 'toplanti', tr: 'TOPLANTI', en: 'MEETING ROOM', x: 16, y: 32, w: 14, h: 9, floor: 'b', face: 'meeting', faceY: 29 },
  { id: 'sunucu', tr: 'SUNUCU ODASI', en: 'SERVER ROOM', x: 31, y: 32, w: 14, h: 9, floor: 'p', face: 'server', faceY: 29 },
  { id: 'dinlenme', tr: 'DİNLENME', en: 'LOUNGE', x: 46, y: 32, w: 14, h: 9, floor: 's', face: 'lounge', faceY: 29 },
];
const DOOR_COLS = [[7, 8], [22, 23], [37, 38], [52, 53]];

function buildGrids() {
  const walls = [], floor = [];
  for (let y = 0; y < MH; y++) { walls.push(new Array(MW).fill(' ')); floor.push(new Array(MW).fill(' ')); }
  for (const y of [0, 13, 28, 41]) for (let x = 0; x < MW; x++) walls[y][x] = '#';
  for (const x of [0, 15, 30, 45, 60]) { for (let y = 0; y <= 13; y++) walls[y][x] = '#'; for (let y = 28; y <= 41; y++) walls[y][x] = '#'; }
  for (const x of [0, 60]) for (let y = 13; y <= 28; y++) walls[y][x] = '#';
  for (const r of ROOM_DEFS) {
    for (let y = r.faceY; y < r.faceY + 3; y++) for (let x = r.x; x < r.x + r.w; x++) walls[y][x] = 'F';
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) floor[y][x] = r.floor;
  }
  for (const [a, b] of DOOR_COLS) for (const x of [a, b]) for (const ys of [[13, 16], [28, 31]]) for (let y = ys[0]; y <= ys[1]; y++) { walls[y][x] = 'D'; floor[y][x] = 'd'; }
  return { walls: walls.map(r => r.join('')), floor: floor.map(r => r.join('')) };
}
const GRIDS = buildGrids();
const hash2 = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0);

const OBJECTS = [], SEATS = [], SPOTS = [];
function put(sprite, left, top, o = {}) {
  const s = SPRITES[sprite]; if (!s) throw new Error('sprite yok: ' + sprite);
  const ax = o.flip ? s.w - 1 - s.ax : s.ax;
  const ob = { id: o.id || `${sprite}@${left},${top}`, sprite, x: left + ax, y: top + s.ay, left, top };
  if (o.flip) ob.flip = true; if (o.z) ob.z = o.z; if (o.solid !== undefined) ob.solid = o.solid; if (o.pal) ob.pal = o.pal; if (o.tool) ob.tool = o.tool;
  OBJECTS.push(ob); return ob;
}
const seat = (id, px, py, dir, object, from) => { const s = { id, x: Math.floor(px / 16), y: Math.floor(py / 16), dir, px, py }; if (object) s.object = object; if (from) s.from = from; SEATS.push(s); return s; };
const spot = (id, x, y, dir, room) => SPOTS.push({ id, x, y, dir, room });
// masa + sandalye + koltuk tek seferde. cx: masanın orta pikseli, ty: oturma satırı.
function deskSet(id, desk, chair, cx, ty, dir, o = {}) {
  const sy = ty * 16 + 14, w = SPRITES[desk].w;
  if (dir === 'down') { put(chair, cx - 8, sy - 22 + (o.push || 0), { z: -14 }); put(desk, cx - (w >> 1), sy - 14, { id: 'desk_' + id }); }
  else { put(desk, cx - (w >> 1), sy - 30, { id: 'desk_' + id }); put(chair, cx - 8, sy - 14 - (o.push || 0)); }
  return seat(id, cx, sy, dir, 'desk_' + id);
}

// ── PYN'İN ODASI (eski posta odası): notlar asansörle buraya gelir, Umut ayırıp Pyn'e verir
put('elevator', 20, 16, { id: 'elevator' }); put('diploma_0', 60, 26); put('diploma_1', 78, 26); put('portrait_pineapple', 108, 20); put('trophy_shelf', 142, 30); put('wall_clock', 182, 24); put('bookshelf_dark', 204, 16);
put('exec_chair', 118, 84, { z: -14 }); put('exec_desk', 96, 90, { id: 'desk_pyn' }); seat('pyn', 128, 110, 'down', 'desk_pyn');
put('guest_chair', 100, 144); put('guest_chair', 140, 144); seat('guest_1', 108, 158, 'up'); seat('guest_2', 148, 158, 'up');
put('sorting_table', 176, 96, { id: 'desk_umut' }); put('desk_lamp', 210, 94, { z: 24 }); seat('umut', 200, 110, 'down', 'desk_umut');
put('floor_lamp', 56, 66); put('coat_rack', 216, 160); put('pineapple_plant', 180, 172);
put('sofa_leather', 24, 104); put('coffee_table_small', 26, 134); put('plant_tall', 220, 122);

// ── HARİTA ODASI
put('corkboard', 272, 18, { id: 'corkboard' });
put('whiteboard_wheels', 262, 72); put('plant_small', 300, 66); put('flat_files', 264, 122);
put('map_table', 336, 112, { id: 'map_table', solid: [0, 6, 48, 24] }); put('stool', 388, 122);
deskSet('elif', 'desk_elif', 'chair_teal_up', 432, 7, 'up');
put('plant_tall', 456, 64); put('trash_bin', 456, 104); put('paper_basket', 300, 168); put('floor_lamp', 344, 160);
put('bookshelf', 440, 150, { solid: [0, 24, 32, 24] }); put('plant_bush', 404, 176);

// ── ARŞİV
['shelf_files_0', 'shelf_files_1', 'shelf_files_2', 'shelf_files_0', 'shelf_files_1'].forEach((n, i) => put(n, 496 + i * 32, 16));
put('shelf_files_2', 688, 16); put('sign_quiet', 662, 20); put('wall_clock', 664, 42);
put('library_ladder', 600, 30, { z: 4 });
[504, 520, 536, 552].forEach((x, i) => { put(i === 2 ? 'filing_cabinet_open' : 'filing_cabinet', x, 88, i === 0 ? { id: 'filing' } : {}); put('filing_cabinet', x, 140); });
put('card_catalog', 584, 96); put('chair_wood_down', 664, 88, { z: -14 });
put('reading_desk', 648, 96, { id: 'desk_kaan' }); seat('kaan', 672, 110, 'down', 'desk_kaan');
put('plant_tall', 700, 64); put('trash_bin', 700, 112); put('file_boxes', 650, 176); put('file_boxes', 668, 176); put('hand_truck', 690, 176); put('plant_small', 584, 176);

// ── MÜDÜR ODASI (eski Pyn odası): müdürün masası, arkasında şehre bakan pencere
put('bookshelf_dark', 740, 16); put('diploma_0', 780, 26); put('diploma_1', 798, 26); put('window_view', 816, 20); put('trophy_shelf', 868, 30); put('wall_clock', 904, 24); put('bookshelf_dark', 924, 16);
put('exec_chair', 838, 84, { z: -14 }); put('exec_desk_mudur', 816, 90, { id: 'desk_mudur' }); seat('mudur', 848, 110, 'down', 'desk_mudur');
put('guest_chair', 820, 144); put('guest_chair', 860, 144); seat('guest_3', 828, 158, 'up'); seat('guest_4', 868, 158, 'up');
put('aquarium', 920, 76, { id: 'aquarium' }); put('floor_lamp', 776, 66); put('coat_rack', 936, 160); put('plant_bush', 900, 172);
put('sofa_leather', 744, 104); put('coffee_table_small', 746, 134); put('plant_tall', 940, 122);

// ── YAZI İŞLERİ (salon) — kuzey yüzü
put('window_blinds', 22, 230); put('fire_ext', 60, 240); put('poster_wave', 80, 228);
for (const [x, id] of [[147, 'pyn'], [387, 'harita'], [627, 'arsiv'], [867, 'mudur']]) put('room_sign', x, 232, { id: 'sign_' + id });
put('tv_dash', 168, 228); put('poster_cortex', 226, 228); put('window_blinds', 260, 230); put('ac_unit', 304, 226);
put('tv_list', 404, 228); put('clock_big', 470, 226, { id: 'clock_salon' }); put('sticky_board', 514, 232); put('window_blinds', 556, 230);
put('window_blinds', 648, 230); put('ac_unit', 690, 226); put('painting_a', 732, 234); put('window_blinds', 760, 230); put('fire_ext', 800, 240);
put('ac_unit', 884, 226); put('painting_b', 928, 234);
// Kapılar (cam, sürgülü)
for (const [a] of DOOR_COLS) { put('door_glass', a * 16, 14 * 16, { id: `door_${a}_up` }); put('door_glass', a * 16, 29 * 16, { id: `door_${a}_down` }); }
// Masa grubu A (sırt sırta)
deskSet('defne', 'desk_defne', 'chair_red_down', 80, 19, 'down');
deskSet('baran', 'desk_baran', 'chair_black_down', 112, 19, 'down');
deskSet('ilgin', 'desk_ilgin', 'chair_teal_down', 144, 19, 'down');
deskSet('toprak', 'desk_toprak', 'chair_mustard_up', 80, 22, 'up');
deskSet('asya', 'desk_asya', 'chair_purple_up', 112, 22, 'up');
deskSet('berk', 'desk_berk', 'chair_blue_up', 144, 22, 'up');
// Masa grubu B (boş ortak masalar)
deskSet('tolga', 'desk_tolga', 'chair_black_down', 256, 19, 'down');  // Tolga, ortak masaların başında
deskSet('shared_2', 'desk_shared_down', 'chair_grey_down', 288, 19, 'down', { push: 5 });
deskSet('shared_3', 'desk_shared_up', 'chair_grey_up', 256, 22, 'up', { push: 5 });
deskSet('shared_4', 'desk_shared_up_reserved', 'chair_grey_up', 288, 22, 'up', { push: 5 });
put('plant_tall', 196, 276); put('trash_bin', 196, 312); put('recycle_bin', 212, 312); put('plant_tall', 324, 276);
// Sağ taraf
put('chair_grey_down', 696, 296, { z: -14 }); put('desk_sena', 680, 304, { id: 'desk_sena' }); seat('sena', 704, 318, 'down', 'desk_sena');
put('shredder', 752, 282); put('copier', 776, 276, { id: 'copier' }); put('paper_stack', 812, 290);
put('standing_table', 560, 330, { id: 'standing_table' }); put('stool_high', 540, 340); put('stool_high', 596, 340);
put('water_cooler', 900, 274, { id: 'cooler_salon' }); put('coat_rack', 924, 274); put('plant_tall', 942, 276);
put('planter_long', 400, 420); put('planter_long', 448, 420); put('plant_bush', 530, 420); put('plant_bush', 942, 414);
put('tea_cart', 168, 412, { id: 'tea_cart' }); put('whiteboard_wheels', 410, 296); put('credenza', 232, 420); put('file_boxes', 288, 420); put('plant_bush', 312, 420);
put('armchair', 640, 404, { solid: [0, 8, 8, 14], z: -14 }); put('coffee_table_small', 670, 414); put('armchair', 700, 404, { flip: true, solid: [16, 8, 8, 14], z: -14 }); seat('salon_arm_1', 656, 424, 'side'); seat('salon_arm_2', 712, 424, 'left');
put('bookshelf', 780, 392, { solid: [0, 26, 32, 22] }); put('plant_tall', 816, 410); put('plant_bush', 650, 278); put('stool', 520, 360); put('trash_bin', 860, 420); put('recycle_bin', 876, 420); put('paper_stack', 740, 360);

// ── MUTFAK
put('upper_cabinets', 20, 466); put('mug_shelf', 72, 470); put('wall_clock', 150, 470);
put('counter_sink', 20, 494); put('tea_counter', 68, 494, { id: 'tea_counter' }); put('caydanlik', 68, 480, { id: 'caydanlik', z: 30 });
put('fridge', 148, 486, { id: 'fridge' }); put('vending', 174, 478, { id: 'vending' }); put('water_cooler', 212, 494, { id: 'cooler_kitchen' });
put('dining_table', 88, 562, { id: 'dining_table' });
for (const cx of [100, 124]) { put('chair_wood_down', cx - 8, 552, { z: -14 }); put('chair_wood_up', cx - 8, 592); }
seat('din_1', 100, 574, 'down'); seat('din_2', 124, 574, 'down'); seat('din_3', 100, 606, 'up'); seat('din_4', 124, 606, 'up');
put('chair_wood_down', 48, 552, { z: -14 }); seat('husnu', 56, 574, 'down');
put('trash_bin', 204, 600); put('recycle_bin', 220, 600); put('plant_tall', 222, 534); put('plant_small', 180, 628);

// ── TOPLANTI
put('meeting_screen', 272, 468, { id: 'meeting_screen' }); put('wall_clock', 336, 472); put('whiteboard_wall', 392, 474); put('painting_a', 440, 472); put('painting_b', 458, 472);
put('meeting_table', 320, 550, { id: 'meeting_table' });
[336, 368, 400].forEach((cx, i) => { put('chair_navy_down', cx - 8, 536, { z: -14 }); seat(`meet_${i + 1}`, cx, 558, 'down', 'meeting_table'); put('chair_navy_up', cx - 8, 592); seat(`meet_${i + 4}`, cx, 606, 'up', 'meeting_table'); });
put('chair_navy_side', 304, 552, { z: -14 }); seat('meet_7', 312, 574, 'side', 'meeting_table');
put('chair_navy_side', 416, 552, { z: -14, flip: true }); seat('meet_8', 424, 574, 'left', 'meeting_table');
put('plant_tall', 262, 518); put('plant_tall', 458, 518); put('plant_bush', 458, 620); put('credenza', 392, 500); put('trash_bin', 436, 632); put('plant_small', 262, 628);

// ── SUNUCU ODASI
[['claude', 498], ['codex', 524], ['opencode', 550], ['gemini', 626], ['qwen', 654]].forEach(([t, x]) => { put(`rack_${t}`, x, 476, { id: `rack_${t}`, tool: t }); put(`rack_led_${t}`, x, 476, { id: `rack_led_${t}`, z: 1, tool: t }); });
put('warning_sign', 578, 480); put('cooling_unit', 684, 478);
put('cable_tray', 500, 530); put('cable_tray', 548, 530); put('cable_tray', 628, 530);
deskSet('melis', 'desk_terminal', 'chair_black_up', 656, 38, 'up');
put('ups', 500, 560); put('parts_shelf', 518, 552); put('cable_spool', 556, 568); put('server_cart', 680, 560); put('toolbox', 520, 620); put('fire_ext', 500, 600); put('trash_bin', 696, 632);

// ── DİNLENME
put('window_view', 746, 470); put('wall_clock', 804, 474); put('record_cabinet', 872, 494, { id: 'record_cabinet' }); put('bookshelf', 912, 478, { solid: [0, 30, 32, 18] });
put('rug_round', 758, 560); put('sofa_big', 768, 528, { id: 'sofa', z: -12, solid: [0, 0, 48, 12] });
seat('sofa_1', 780, 558, 'down', 'sofa'); seat('sofa_2', 804, 558, 'down', 'sofa');
put('lounge_table', 772, 572); put('armchair', 744, 568, { solid: [0, 8, 8, 14], z: -14 }); seat('arm_1', 760, 588, 'side');
put('armchair', 816, 568, { flip: true, solid: [16, 8, 8, 14], z: -14 }); seat('arm_2', 828, 588, 'left');
put('pouf_a', 784, 604); put('pouf_b', 806, 604); put('floor_lamp', 744, 520); put('plant_tall', 944, 528); put('plant_bush', 940, 612); put('plant_tall', 870, 610);
put('cat_bed', 896, 612, { id: 'catbed' }); seat('catbed', 904, 624, 'down', 'catbed');

// Etkileşim noktaları (kare, bakış yönü)
spot('elevator', 2, 4, 'up', 'pyn'); spot('pyn_door', 7, 12, 'up', 'pyn');
spot('corkboard', 22, 4, 'up', 'harita'); spot('map_table', 22, 6, 'down', 'harita'); spot('whiteboard', 17, 7, 'up', 'harita');
spot('filing', 33, 8, 'up', 'arsiv'); spot('card_catalog', 37, 8, 'up', 'arsiv'); spot('shelves', 40, 4, 'up', 'arsiv');
spot('aquarium', 58, 7, 'up', 'mudur'); spot('mudur_door', 52, 12, 'up', 'mudur');
spot('printer', 49, 19, 'up', 'salon'); spot('cooler_salon', 56, 19, 'up', 'salon'); spot('tea_cart', 11, 25, 'down', 'salon');
spot('talk_a', 23, 24, 'side', 'salon'); spot('talk_b', 25, 24, 'left', 'salon'); spot('standing', 35, 23, 'up', 'salon');
spot('tea', 5, 33, 'up', 'mutfak'); spot('fridge', 9, 33, 'up', 'mutfak'); spot('vending', 11, 33, 'up', 'mutfak'); spot('cooler_kitchen', 13, 33, 'up', 'mutfak');
spot('meeting_screen', 19, 33, 'up', 'toplanti');
spot('rack_claude', 31, 33, 'up', 'sunucu'); spot('rack_codex', 33, 33, 'up', 'sunucu'); spot('rack_opencode', 35, 33, 'up', 'sunucu'); spot('rack_gemini', 39, 33, 'up', 'sunucu'); spot('rack_qwen', 41, 33, 'up', 'sunucu');
spot('record_player', 55, 33, 'up', 'dinlenme'); spot('catbed', 56, 38, 'down', 'dinlenme');

const ROOM_STYLE = {}; for (const r of ROOM_DEFS) ROOM_STYLE[r.id] = r.face;
export const MAP = {
  w: MW, h: MH, tile: 16,
  floor: GRIDS.floor, walls: GRIDS.walls,
  floorTiles: {
    w: [0, 1, 2, 3].map(v => `floor_wood_${v}`), c: ['floor_carpet_0', 'floor_carpet_1'], h: ['floor_herring_0', 'floor_herring_1'],
    r: ['floor_rug_0'], t: [0, 1, 2, 3].map(v => `floor_tile_${v}`), k: ['floor_checker_0', 'floor_checker_1'],
    b: ['floor_bordo_0', 'floor_bordo_1'], p: ['floor_raised_0', 'floor_raised_0', 'floor_raised_0', 'floor_raised_1'], s: ['floor_sea_0', 'floor_sea_1'], d: ['floor_threshold'],
  },
  wallFaces: Object.fromEntries(ROOM_DEFS.map(r => [r.id, FACE[r.face]])),
  rooms: ROOM_DEFS.map(r => ({ id: r.id, tr: r.tr, en: r.en, x: r.x, y: r.y, w: r.w, h: r.h, face: r.face, faceY: r.faceY,
    doors: DOOR_COLS.filter(([a]) => a >= r.x && a < r.x + r.w).flatMap(([a, b]) => r.id === 'salon' ? [[a, 13], [b, 13], [a, 28], [b, 28]] : r.y < 17 ? [[a, 13], [b, 13]] : [[a, 28], [b, 28]]) })),
  objects: OBJECTS, seats: SEATS, spots: SPOTS,
  lights: [
    ...[[128, 140], [368, 140], [608, 140], [848, 140], [128, 590], [368, 590], [608, 590], [848, 590]].map(([x, y]) => ({ x, y, r: 64, color: '#ffd9a0', kind: 'ceiling' })),
    ...[120, 330, 540, 750, 900].map(x => ({ x, y: 350, r: 72, color: '#ffe2b0', kind: 'ceiling' })),
  ],
};

/** Bir karede (x,y) çizilecek sprite adları, sırasıyla (zemin → duvar → gölge). */
export function tileSprites(x, y) {
  const W_ = MAP.walls, F_ = MAP.floor, wc = W_[y][x], fc = F_[y][x], out = [];
  const isW = (xx, yy) => yy >= 0 && yy < MH && xx >= 0 && xx < MW && W_[yy][xx] === '#';
  if (wc === '#') { const m = (isW(x, y - 1) ? 1 : 0) | (isW(x + 1, y) ? 2 : 0) | (isW(x, y + 1) ? 4 : 0) | (isW(x - 1, y) ? 8 : 0); return [`wall_head_${m}`]; }
  if (wc === 'F') { const r = ROOM_DEFS.find(rr => x >= rr.x && x < rr.x + rr.w && y >= rr.faceY && y < rr.faceY + 3); return [FACE[r.face][y - r.faceY][hash2(x, y) % 2]]; }
  if (fc === ' ') return out;
  if (fc === 'r') { const n = (xx, yy) => F_[yy] && F_[yy][xx] === 'r'; const m = (n(x, y - 1) ? 0 : 1) | (n(x + 1, y) ? 0 : 2) | (n(x, y + 1) ? 0 : 4) | (n(x - 1, y) ? 0 : 8); out.push(`floor_rug_${m}`); }
  else { const list = MAP.floorTiles[fc]; out.push(list[hash2(x, y) % list.length]); }
  const up = y > 0 ? W_[y - 1][x] : '#';
  if ((up === 'F' || up === '#') && fc !== 'd') out.push('shade_n');
  if (x > 0 && W_[y][x - 1] === '#') out.push('shade_w');
  return out;
}
/** Kare koordinatından oda kimliği (kapı eşiğinde null). */
export function roomAt(tx, ty) { for (const r of ROOM_DEFS) if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return r.id; return null; }
/** Yürünebilirlik ızgarası: duvarlar + eşyaların solid alanları (karenin orta 8×8'i ile kesişen her solid kareyi kapatır). */
export function buildCollision() {
  const blocked = new Uint8Array(MW * MH);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) { const w = MAP.walls[y][x]; if (w === '#' || w === 'F' || MAP.floor[y][x] === ' ') blocked[y * MW + x] = 1; }
  for (const o of OBJECTS) {
    const s = SPRITES[o.sprite]; let so = o.solid !== undefined ? o.solid : s.solid; if (!so) continue;
    if (o.flip && o.solid === undefined) so = [s.w - so[0] - so[2], so[1], so[2], so[3]];
    const x0 = o.left + so[0], y0 = o.top + so[1], x1 = x0 + so[2], y1 = y0 + so[3];
    for (let ty = Math.floor(y0 / 16); ty <= Math.floor((y1 - 1) / 16); ty++) for (let tx = Math.floor(x0 / 16); tx <= Math.floor((x1 - 1) / 16); tx++) {
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) continue;
      const cx0 = tx * 16 + 4, cy0 = ty * 16 + 4; if (x0 < cx0 + 8 && x1 > cx0 && y0 < cy0 + 8 && y1 > cy0) blocked[ty * MW + tx] = 1;
    }
  }
  return { w: MW, h: MH, blocked, isBlocked: (x, y) => x < 0 || y < 0 || x >= MW || y >= MH || blocked[y * MW + x] === 1 };
}
/** Salon ortasından her koltuk ve noktaya yürünerek ulaşılabiliyor mu? Ulaşılamayanların listesi. */
export function checkReachability() {
  const col = buildCollision(), dist = new Int32Array(MW * MH).fill(-1), q = [30 + 25 * MW]; dist[q[0]] = 0;
  while (q.length) { const i = q.shift(), x = i % MW, y = (i / MW) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (col.isBlocked(nx, ny)) continue; const j = ny * MW + nx; if (dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j); } } }
  const bad = [];
  for (const s of SEATS) { const [fx, fy] = s.from || [s.x, s.y]; if (dist[fy * MW + fx] < 0) bad.push('seat:' + s.id); }
  for (const s of SPOTS) if (dist[s.y * MW + s.x] < 0) bad.push('spot:' + s.id);
  return bad;
}


// ═════════════ BEYİN ÇERÇEVESİ (ek brif: ofis, kullanıcının beyninin içinde) ═════════════
// Haritanın çevresi bir beyin: iki yarıküre, üstte ortada yarık, yanlarda Sylvius yarığıyla ayrılan şakak lobu,
// altta yarıkürelerin altından taşan tek parça, geniş beyincik (sap onun arkasında kalır, görünmez). Kıvrımlar kıvrıla kıvrıla akan tüpler: oluklar dallanır,
// bazıları kör biter, dış kenar her olukta içeri kıvrılır. Harita dikdörtgeni hiç boyanmaz. Haritaya yaklaştıkça kıvrımlar
// incelir ve doku bir pervazla duvara iner: ofis beynin içine oyulmuş, bir pencereden görülüyor gibi.
// Doku 2×2'lik iri piksellerle çizilir (yalnız fillRect, tam sayı): motor bütün beyni ~0,45× sığdırınca da kıvrımlar okunsun.
// Desen sabit tohumlu; her çağrı aynı pikselleri verir.
//
//  BRAIN.margin  üst 48, sağ 96, alt 112, sol 96 (16'nın katları). Alt brifteki gibi 112: beyincik sığsın.
//                Üst 48 (64 yerine): Ofis sekmesinde darboğaz yükseklik, harita en küçük pencerede biraz daha büyük kalır.
//  BRAIN.w, h    çerçeveli dünya: 1168 × 832. BRAIN.map: haritanın bu dünyadaki dikdörtgeni.
//  BRAIN.anchors oda → [x, y]: o odanın dış duvarının yanında, bir kıvrımın ortasında. Her biri NEURON_PATHS'teki bir yolun ilk noktası.
//  NEURON_PATHS  kıvrımların orta çizgisi boyunca yollar (kıvrım bitince bir oluğun üstünden sonrakine atlar), çerçeve koordinatında, 4–12 nokta. Noktalar arası düz gidilir;
//                kıvılcımın 7×7'si yolun her yerinde dokunun içinde, haritadan en az 6 piksel uzakta kalır.
//  paintBrain(ctx, mode)  çerçeveyi (0,0)'dan çizer. mode: 'sabah' | 'ogle' | 'aksam' | 'gece' (BRAIN_PALETTES).
//  SPRITES.kivilcim     7×7, çapa ortada, 6 kare: 0 doğarken ve sönerken, 1–5 akarken döngü.
//                       pal: { renk: 'altin' | 'turkuaz', gece: true }; gecede çevresinde bir halka daha parlar.
//  SPRITES.kivilcim_iz  3×3, 2 kare: kıvılcımın 5 ve 10 piksel gerisine.

const BR_M = { top: 48, right: 96, bottom: 112, left: 96 };
const BR_W = MW * 16 + BR_M.left + BR_M.right, BR_H = MH * 16 + BR_M.top + BR_M.bottom;
const BR_X0 = BR_M.left, BR_Y0 = BR_M.top, BR_X1 = BR_X0 + MW * 16, BR_Y1 = BR_Y0 + MH * 16;
// İri piksel ızgarası (1 = 2×2 piksel).
const GW = BR_W / 2, GH = BR_H / 2, GX0 = BR_X0 / 2, GY0 = BR_Y0 / 2, GX1 = BR_X1 / 2, GY1 = BR_Y1 / 2, GCX = GW / 2;
const brStep = (a, b, t) => { const k = Math.min(1, Math.max(0, (t - a) / (b - a))); return k * k * (3 - 2 * k); };
function brHash(a, b, seed) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function brNoise(x, y, p, seed) {
  const fx = x / p, fy = y / p, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = brHash(ix, iy, seed), b = brHash(ix + 1, iy, seed), c = brHash(ix, iy + 1, seed), d = brHash(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
function brRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Haritanın duvarından kaç iri piksel dışarıda (0: duvara bitişik halka). */
const brRing = (x, y) => Math.max(GX0 - 1 - x, x - GX1, GY0 - 1 - y, y - GY1, 0);
// Yarıküre: köşeleri ayrı ayrı yuvarlak bir kutu; ortaya bakan köşeler üstte yarığı, altta beyinciğin göründüğü oyuğu açar.
const HB = { x0: 2, x1: GCX, y0: 2, y1: GH - 32, ot: 72, it: 20, ib: 22, ob: 76 };
function brHemi(x, y, side) {
  const m = side ? GW - x : x, cx = (HB.x0 + HB.x1) / 2, cy = (HB.y0 + HB.y1) / 2;
  const r = y < cy ? (m < cx ? HB.ot : HB.it) : (m < cx ? HB.ob : HB.ib);
  const qx = Math.abs(m - cx) - ((HB.x1 - HB.x0) / 2 - r), qy = Math.abs(y - cy) - ((HB.y1 - HB.y0) / 2 - r);
  const s = Math.abs(x - GCX) / GCX, inset = brStep(0.62, 1, s) * (5 * (1 - brStep(150, 236, y)) + 2.5 * brStep(318, 384, y));
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r + inset;
}
// Kenar tümsekleri: her yarıkürenin çevresi 17–37 iri piksellik loblara bölünür; lobların arası bir çentik, her çentikten bir oluk girer.
const BR_HEM = [0, 1].map((side) => {
  const cx = side ? GW - 147 : 147, cy = (HB.y0 + HB.y1) / 2, N = 1440, r = new Float32Array(N + 1), S = new Float32Array(N + 1);
  for (let j = 0; j <= N; j++) { const t = j / N * 2 * Math.PI, ca = Math.cos(t), sa = Math.sin(t); let rr = 0; while (rr < 440 && brHemi(cx + ca * rr, cy + sa * rr, side) <= 0) rr += 0.5; r[j] = rr; }
  for (let j = 1; j <= N; j++) S[j] = S[j - 1] + Math.hypot(r[j] - r[j - 1], (r[j] + r[j - 1]) / 2 * 2 * Math.PI / N);
  const rnd = brRng(101 + side), raw = [], deep = []; let s = 0; while (s < S[N]) { raw.push(s); deep.push(3.5 + rnd() * 3); s += 17 + rnd() * 20; }
  const notch = raw.map((v) => v * S[N] / s); notch.push(S[N]);
  return { cx, cy, N, r, S, notch, deep };
});
function brLobeF(x, y, side) {
  const H = BR_HEM[side]; let t = Math.atan2(y - H.cy, x - H.cx); if (t < 0) t += 2 * Math.PI;
  const u = t / (2 * Math.PI) * H.N, j = Math.min(H.N - 1, Math.floor(u)), s = H.S[j] + (H.S[j + 1] - H.S[j]) * (u - j), n = H.notch;
  let lo = 0, hi = n.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (n[m] <= s) lo = m; else hi = m; }
  return [(s - n[lo]) / (n[hi] - n[lo]), H.deep[lo % H.deep.length]];
}
// Sylvius yarığı: iki yanda, dış kenardan haritaya doğru yukarı kıvrılan uzun oluk (sağdaki biraz farklı).
const BR_SYL = [[[-2, 252], [20, 240], [41, 204]], [[GW + 2, 244], [GW - 22, 233], [GW - 41, 198]]].map(([a, b, c]) => {
  const pts = []; for (let i = 0; i <= 48; i++) { const t = i / 48, u = 1 - t; pts.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]); } return pts;
});
function brSylvian(x, y) {
  let best = 99;
  for (const pts of BR_SYL) {
    if (Math.abs(x - pts[24][0]) > 40 || Math.abs(y - pts[24][1]) > 40) continue;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
  }
  return best;
}
// Beyincik: yarıkürelerin altından taşan tek, geniş, yassı bir yay; ortada hafif bir çentik ve iki ince oluk (vermis)
// iki yarısını belli eder. Yapraklar kavisli, birbirine paralel.
const BR_CBL = { cx: GCX, cy: HB.y1 - 18, rx: 132, ry: 44 };
/** Beyincik yaprağının sırası (0: dışarıda). */
function brCerebellum(x, y) {
  const dx = x - BR_CBL.cx, dy = y - BR_CBL.cy;
  const e = Math.hypot(dx / BR_CBL.rx, dy / BR_CBL.ry) + (dy > 0 ? 0.06 * Math.max(0, 1 - Math.abs(dx) / 22) : 0);
  return e > 1 ? 0 : 1 + Math.floor(e * 11 + 0.4 * brNoise(x, y, 14, 3) + 0.5);
}
function brChamfer(D) {
  for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) { const i = y * GW + x; if (D[i]) D[i] = Math.min(D[i], D[i - 1] + 3, D[i - GW] + 3, D[i - GW - 1] + 4, D[i - GW + 1] + 4); }
  for (let y = GH - 2; y > 0; y--) for (let x = GW - 2; x > 0; x--) { const i = y * GW + x; if (D[i]) D[i] = Math.min(D[i], D[i + 1] + 3, D[i + GW] + 3, D[i + GW + 1] + 4, D[i + GW - 1] + 4); }
  return D;
}

// kind: 0 boş, 1 beyin, 2 beyincik, 9 harita. sul: 1 oluk, 2 orta yarık.
// Oluklar çizgi olarak büyütülür: çentiklerden içeri, sonra boş kalan yerlere serbest kıvrımlar. Her oluk çevresinde 5 iri piksel
// (haritaya yakın 4) yer tutar; başka bir oluğa yaklaşan ya kör biter ya da ona T diye bağlanır. Kıvrımlar 4–10 iri piksel kalınlıkta,
// duvara yaklaştıkça incelir; oluklar duvara kadar iner, harita kıvrımları kesen bir pencere gibi durur.
// Renk sırası: 1 kontur, 2 oluk, 3 derin gölge, 4 gölge, 5 gövde, 6 ışık, 7 parlak, 8 beyincik.
function brainBuild() {
  const N = GW * GH, kind = new Uint8Array(N), sul = new Uint8Array(N), band = new Int8Array(N), claim = new Int16Array(N);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, cx = x + 0.5, cy = y + 0.5;
    if (x >= GX0 && x < GX1 && y >= GY0 && y < GY1) { kind[i] = 9; continue; }
    let inside = brRing(x, y) <= 3;
    if (!inside) {
      const side = cx < GCX ? 0 : 1; let sd = brHemi(cx, cy, side);
      if (sd < 2 && sd > -14) {
        const [f, dep] = brLobeF(cx, cy, side);
        sd += dep * (1 - Math.sqrt(Math.max(0, 1 - (2 * f - 1) ** 2))) * brStep(5, 16, Math.abs(cx - GCX)) + 4.5 * Math.max(0, 1 - brSylvian(cx, cy) / 3.5);
      }
      inside = sd <= 0;
    }
    if (inside) { kind[i] = 1; continue; }
    const c = brCerebellum(cx, cy); if (c) { kind[i] = 2; band[i] = c; }
  }
  const E = new Uint16Array(N); for (let i = 0; i < N; i++) E[i] = kind[i] === 1 || kind[i] === 9 ? 9999 : 0; brChamfer(E);
  const at = (x, y) => (x < 0 || y < 0 || x >= GW || y >= GH ? -1 : (y | 0) * GW + (x | 0));
  const stake = (x, y, id, r = brRing(x | 0, y | 0) < 12 ? 4 : 5) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const j = at(x + dx, y + dy); if (j >= 0 && !claim[j]) claim[j] = id; }
  };
  const fis = (x, y) => (x === GCX - 1 || x === GCX) && (y < GY0 || y >= GY1);
  for (let y = 0; y < GH; y++) for (let x = GCX - 1; x <= GCX; x++) { const i = y * GW + x; if (kind[i] === 1 && fis(x, y)) { sul[i] = 2; stake(x, y, 1); } }
  let id = 3;
  for (const pts of BR_SYL) {
    for (const [px, py] of pts) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.floor(px) + dx, y = Math.floor(py) + dy, j = at(x, y);
      if (j >= 0 && kind[j] === 1 && brRing(x, y) >= 3 && Math.hypot(x + 0.5 - px, y + 0.5 - py) < 0.8) sul[j] = 1;
    }
    for (const [px, py] of pts) stake(px, py, id); id++;
  }
  const rnd = brRng(7);
  const ok = (x, y, cid, edge) => { const j = at(x, y); return j >= 0 && kind[j] === 1 && brRing(x | 0, y | 0) >= 3 && (!edge || E[j] >= 6) && (!claim[j] || claim[j] === cid); };
  function grow(x, y, th, cid, steps, fromEdge, avoid) {
    const pts = []; let k = (rnd() - 0.5) * 0.16;
    for (let t = 0; t < steps; t++) {
      const j = at(x, y);
      if (!ok(x, y, cid, !(fromEdge && t < 14))) {
        if (j >= 0 && claim[j] && claim[j] !== cid && kind[j] === 1 && rnd() < 0.7) {
          const ext = []; let ex = x, ey = y;
          for (let e = 0; e < 16; e++) { const q = at(ex, ey); if (q < 0 || kind[q] !== 1) break; if (sul[q]) { pts.push(...ext); break; } ext.push([ex, ey]); ex += Math.cos(th) * 0.5; ey += Math.sin(th) * 0.5; }
        }
        break;
      }
      const near = (list, minIdx) => list.some(([qx, qy], n) => n < minIdx && Math.abs(qx - x) < 5 && Math.abs(qy - y) < 5 && Math.hypot(qx - x, qy - y) < 5);
      if (near(pts, t - 14) || (avoid && near(avoid.slice(16), avoid.length))) break;
      pts.push([x, y]);
      th += k; k = Math.max(-0.2, Math.min(0.2, k + (rnd() - 0.5) * 0.05));
      x += Math.cos(th) * 0.5; y += Math.sin(th) * 0.5;
    }
    return pts;
  }
  function lay(pts, cid) {
    for (const [px, py] of pts) { const j = at(px, py); if (j >= 0 && kind[j] === 1 && brRing(px | 0, py | 0) >= 2) sul[j] = 1; }
    for (let n = 0; n < pts.length; n += 2) stake(pts[n][0], pts[n][1], cid);
  }
  for (const [side, H] of BR_HEM.entries()) {
    for (let n = 0; n < H.notch.length - 1; n++) {
      let jj = 0; while (jj < H.N && H.S[jj] < H.notch[n]) jj++;
      const t = jj / H.N * 2 * Math.PI, rr = H.r[jj] - H.deep[n] - 0.5, x = H.cx + Math.cos(t) * rr, y = H.cy + Math.sin(t) * rr;
      if (Math.abs(x - GCX) < 14 || at(x, y) < 0 || kind[at(x, y)] !== 1) continue;
      const pts = grow(x, y, t + Math.PI + (rnd() - 0.5) * 0.6, id, 14 + Math.floor(rnd() * 70), true);
      if (pts.length >= 4) lay(pts, id); id++;
    }
  }
  for (let attempt = 0; attempt < 5000; attempt++) {
    const x = 1 + rnd() * (GW - 2), y = 1 + rnd() * (GH - 2), j = at(x, y);
    if (kind[j] !== 1 || claim[j] || E[j] < 9 || brRing(x | 0, y | 0) < 6) continue;
    const th = rnd() * 2 * Math.PI, fwd = grow(x, y, th, id, 24 + Math.floor(rnd() * 100), false);
    const back = grow(x - Math.cos(th) * 0.5, y - Math.sin(th) * 0.5, th + Math.PI, id, 10 + Math.floor(rnd() * 60), false, fwd);
    const pts = [...back.reverse(), ...fwd];
    if (pts.length >= 10) lay(pts, id); id++;
  }
  // Oluklara (ve beynin kenarına) uzaklık, 3 = bir iri piksel.
  const D = new Uint16Array(N); for (let i = 0; i < N; i++) D[i] = kind[i] === 1 && !sul[i] ? 9999 : 0; brChamfer(D);
  const out = new Uint8Array(N), k = (x, y) => (x < 0 || y < 0 || x >= GW || y >= GH ? 0 : kind[y * GW + x]);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, v = kind[i]; if (v === 9) continue;
    const kl = k(x - 1, y), kr = k(x + 1, y), ku = k(x, y - 1), kb = k(x, y + 1);
    if (v === 0) { if ((kl && kl !== 9) || (kr && kr !== 9) || (ku && ku !== 9) || (kb && kb !== 9)) out[i] = 1; continue; }
    if (v === 1) {
      const ring = brRing(x, y), dxp = Math.max(GX0 - 1 - x, x - GX1, 0), dyp = Math.max(GY0 - 1 - y, y - GY1, 0), back = (y < GY0 && dyp >= dxp) || (x < GX0 && dxp >= dyp);
      let c;
      if (ring === 0) c = 1;
      else if (sul[i] === 2) c = x === GCX - 1 ? 1 : 2;
      else if (kl === 0 || ku === 0) c = 7;
      else if ((kr !== 1 && kr !== 9) || (kb !== 1 && kb !== 9)) c = 4;
      else if (ring === 1) c = back ? 3 : 6;
      else if (sul[i]) c = 2;
      else if (fis(x + 1, y)) c = 3;
      else if (fis(x - 1, y)) c = 6;
      else {
        const d = D[i], gx = D[i + 1] - D[i - 1], gy = D[i + GW] - D[i - GW], g = gx + gy;
        if (g < 0) c = d <= 3 ? 3 : d <= 8 ? 4 : 5;
        else if (g > 0) c = d <= 4 ? 6 : d <= 7 ? (gx > 0 && gy > 0 ? 7 : 6) : 5;
        else c = 5;
      }
      out[i] = c;
    } else if (v === 2) {
      const b = band[i], other = (xx, yy) => k(xx, yy) === 2 && band[yy * GW + xx] !== b;
      const vx = Math.abs(x + 0.5 - GCX) - 11 - 0.04 * (y - HB.y1) ** 2 / 4;
      out[i] = ku === 1 || k(x, y - 2) === 1 ? 3 : vx >= -0.5 && vx < 0.5 ? 3 : vx >= 0.5 && vx < 1.5 ? 6 : other(x, y - 1) ? 3 : other(x, y + 1) ? 4 : other(x, y - 2) ? 6 : kr === 0 || kb === 0 ? 4 : kl === 0 || ku === 0 ? 6 : 8;
    }
  }
  return { kind, sul, D, out };
}
const BR_G = brainBuild();

/** Işık modlarına göre beynin tonları: öğle esas; sabah biraz sıcak, akşam turuncuya çalar, gece koyulaşır. */
export const BRAIN_PALETTES = {};
{
  const NOON = ['#2a1b22', '#5a3a47', '#7c5663', '#9c7380', '#bf939d', '#d9b1b6', '#f0d3cf', '#ad838d'];
  const LIGHT = { sabah: [[1.03, 1, 0.95], [10, 6, 0]], ogle: [[1, 1, 1], [0, 0, 0]], aksam: [[1, 0.84, 0.72], [4, 0, 0]], gece: [[0.4, 0.42, 0.6], [0, 0, 6]] };
  const hex = (c) => c.toString(16).padStart(2, '0');
  for (const [mode, [mul, add]] of Object.entries(LIGHT))
    BRAIN_PALETTES[mode] = NOON.map((h) => { const n = parseInt(h.slice(1), 16); return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c, j) => hex(Math.max(0, Math.min(255, Math.round(c * mul[j] + add[j]))))).join(''); });
}
/** Çerçeveyi (0,0)'dan BRAIN.w × BRAIN.h olarak çizer; haritanın dikdörtgenine dokunmaz. */
export function paintBrain(ctx, mode = 'ogle') {
  const g = BR_G.out, pal = BRAIN_PALETTES[mode] || BRAIN_PALETTES.ogle;
  for (let y = 0; y < GH; y++) {
    const row = y * GW; let x = 0;
    while (x < GW) { const c = g[row + x]; if (!c) { x++; continue; } let e = x + 1; while (e < GW && g[row + e] === c) e++; ctx.fillStyle = pal[c - 1]; ctx.fillRect(x * 2, y * 2, (e - x) * 2, 2); x = e; }
  }
}

// Sinyal kıvılcımı: altın (ofisin vurgusu) ya da turkuaz (ekranların ışığı). Sıra: merkez, çekirdek, hale, gece halkası.
const BR_SPARK = { altin: [O[5], O[4], O[3], O[1]], turkuaz: [K[7], C[4], C[3], C[1]] };
def('kivilcim', 7, 7, { ax: 3, ay: 3, layer: 'top', frames: 6, fps: 10, group: 'beyin' }, (b, f, pal) => {
  const [hi, core, halo, ring] = BR_SPARK[pal.renk] || BR_SPARK.altin, size = [0, 1, 2, 3, 2, 1][f];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const dx = Math.abs(x - 3), dy = Math.abs(y - 3), m = dx + dy, c = Math.max(dx, dy);
    let col = null;
    if (size === 0) col = m === 0 ? core : m === 1 ? halo : null;
    else if (size === 1) col = m === 0 ? hi : m === 1 ? core : m === 2 ? halo : null;
    else if (c <= 1) col = m === 0 || (size === 3 && m === 1) ? hi : core;
    else if (c === 2 && m <= 3) col = halo;
    if (!col && pal.gece && (size >= 2 ? (c === 3 && m <= 3) || (c === 2 && m === 4) : size === 1 && m === 3 && c <= 2)) col = ring;
    if (col) b.p(x, y, col);
  }
});
def('kivilcim_iz', 3, 3, { ax: 1, ay: 1, layer: 'top', frames: 2, group: 'beyin' }, (b, f, pal) => {
  const [, core, halo] = BR_SPARK[pal.renk] || BR_SPARK.altin;
  if (f === 0) { b.p(1, 1, core); b.p(0, 1, halo); b.p(2, 1, halo); b.p(1, 0, halo); b.p(1, 2, halo); } else b.p(1, 1, halo);
});

// Kıvılcım yolları: bir kıvrımın orta çizgisinde (oluklara en uzak yer) yürünür, sonra 4–12 noktaya indirilir.
function brWalkD(x, y) {
  const gx = Math.floor(x), gy = Math.floor(y); if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return 0;
  const i = gy * GW + gx; if (BR_G.kind[i] !== 1 || BR_G.sul[i] || brRing(gx, gy) < 4 || (Math.abs(gx + 0.5 - GCX) < 5 && (gy < GY0 || gy >= GY1))) return 0;
  return BR_G.D[i];
}
function brCellOK(wx, wy) {
  const gx = Math.floor(wx / 2), gy = Math.floor(wy / 2);
  if (brRing(gx, gy) < 3) return false;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= GW || y >= GH || BR_G.kind[y * GW + x] !== 1) return false; }
  return true;
}
function brWalk(sx, sy, heading, maxLen) {
  const gx = sx / 2, gy = sy / 2; let best = null;
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const v = brWalkD(gx + dx, gy + dy); if (v < 6) continue;
    const s = v - 0.6 * Math.hypot(dx, dy); if (!best || s > best[2]) best = [Math.floor(gx + dx) + 0.5, Math.floor(gy + dy) + 0.5, s];
  }
  if (!best) return null;
  let [x, y] = best, th = heading, len = 0, step = 0, hops = 0; const pts = [[x, y]], seen = new Map();
  while (len < maxLen / 2) {
    let pick = null;
    for (const reach of [1.5, 3, 4.5]) {
      if (reach > 1.5 && hops >= 3) break;
      for (let q = -4; q <= 4; q++) {
        const a = th + q * (reach > 1.5 ? 0.12 : 0.24), nx = x + reach * Math.cos(a), ny = y + reach * Math.sin(a), v = brWalkD(nx, ny); if (v < 5) continue;
        const cell = Math.floor(ny) * GW + Math.floor(nx), was = seen.get(cell); if (was !== undefined && step - was > 3) continue;
        const s = v - 0.9 * Math.abs(q); if (!pick || s > pick[3]) pick = [nx, ny, a, s, cell, reach];
      }
      if (pick) break;
    }
    if (!pick) break;
    [x, y, th] = pick; len += pick[5]; step++; if (pick[5] > 1.5) hops++; seen.set(pick[4], step); pts.push([x, y]);
  }
  const L = len * 2; if (L < 72) return null;
  const n = Math.max(4, Math.min(12, Math.round(L / 30) + 1)), out = [], cum = [0];
  for (let q = 1; q < pts.length; q++) cum.push(cum[q - 1] + Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]));
  for (let q = 0, j = 0; q < n; q++) { const t = cum[cum.length - 1] * q / (n - 1); while (j < pts.length - 1 && cum[j] < t) j++; out.push([Math.round(pts[j][0] * 2), Math.round(pts[j][1] * 2)]); }
  for (let q = 1; q < out.length; q++) {
    const [ax, ay] = out[q - 1], [bx, by] = out[q], m = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let s = 0; s <= m; s++) if (!brCellOK(ax + (bx - ax) * s / m, ay + (by - ay) * s / m)) return q >= 4 ? out.slice(0, q) : null;
  }
  return out;
}
function brPath(x, y, heading, maxLen) {
  const vert = Math.abs(Math.sin(heading)) > 0.5;
  for (const o of [0, 12, -12, 24, -24, 40, -40, 56, -56]) for (const a of [heading, heading + Math.PI]) { const p = vert ? brWalk(x, y + o, a, maxLen) : brWalk(x + o, y, a, maxLen); if (p) return p; }
  return null;
}

/** Kıvılcımların izlediği yollar (çerçeve koordinatı). İlk dokuzu odaların çapalarından çıkar. */
export const NEURON_PATHS = [];
const BR_ANCHORS = {};
{
  const T = BR_Y0 - 22, Bt = BR_Y1 + 24, Lx = BR_X0 - 46, Rx = BR_X1 + 46, col = (tx) => BR_X0 + tx * 16, W = Math.PI, E = 0, S = Math.PI / 2, Nn = -Math.PI / 2;
  const rooms = [['pyn', col(7.5), T, W], ['harita', col(22.5), T, W], ['arsiv', col(37.5), T, E], ['mudur', col(52.5), T, E], ['salon', Lx, BR_Y0 + 21 * 16, S],
    ['mutfak', col(7.5), Bt, E], ['toplanti', col(22.5), Bt, E], ['sunucu', col(37.5), Bt, W], ['dinlenme', col(52.5), Bt, W]];
  for (const [id, x, y, a] of rooms) { const p = brPath(x, y, a, 240); if (p) { NEURON_PATHS.push(p); BR_ANCHORS[id] = [p[0][0], p[0][1]]; } }
  for (const [x, y, a] of [[Lx, 200, Nn], [Lx, 560, S], [Rx, 200, Nn], [Rx, 560, S], [col(13), T, E], [col(47), T, W], [col(14), Bt, W], [col(46), Bt, E], [Lx - 16, 420, Nn], [Rx + 16, 420, S]]) {
    const p = brPath(x, y, a, 320); if (p) NEURON_PATHS.push(p);
  }
}
/** Çerçeveli dünya: motor dünyayı w × h kurar, haritayı margin kadar kaydırır. */
export const BRAIN = { margin: { ...BR_M }, w: BR_W, h: BR_H, map: { x: BR_X0, y: BR_Y0, w: MW * 16, h: MH * 16 }, anchors: BR_ANCHORS };
