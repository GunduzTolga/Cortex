// ofis-engine.js — Cortex Ofis motoru. Claude Design'ın prototip motoru (teslim: 15 Ekim 2026),
// uygulamaya şu eklerle alındı: görünmeyen sekmede durur (setActive), sunucu kabinlerinin LED'leri
// araçların gerçek giriş durumundan gelir (setLeds). Ajanların davranışları hâlâ prototipin betikleri;
// kasadan gelen olaylar ve canlı konuşmalar sonraki adımda bağlanacak.

const LIGHT_TINT = { sabah: [222, 232, 255], ogle: null, aksam: [255, 196, 150], gece: [66, 80, 132] };
export const LIGHT_MODES = [['sabah', 'Sabah'], ['ogle', 'Öğle'], ['aksam', 'Akşam'], ['gece', 'Gece']];
export function lightForHour(h) { return h >= 6 && h < 10 ? 'sabah' : h >= 10 && h < 17 ? 'ogle' : h >= 17 && h < 20 ? 'aksam' : 'gece'; }
const pad = (n) => String(n).padStart(2, '0');
export const clockText = (d = new Date()) => pad(d.getHours()) + ':' + pad(d.getMinutes());
/** The frame an animation shows at time t: always one it has, even for a clock that is not yet running (t < 0, NaN). */
export function loopFrame(t, fps, frames, offset = 0) {
  const n = Math.floor(t * fps + offset);
  return Number.isFinite(n) ? ((n % frames) + frames) % frames : 0;
}

const TOOL_NAME = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen' };
export const TOOL_STATUS = { claude: 'ok', codex: 'ok', opencode: 'wait', gemini: 'ok', qwen: 'off' };
export const TOOL_LABEL = { ok: 'giriş yapıldı', wait: 'giriş bekliyor', off: 'kurulu değil' };

const CONVO_DB = [
  ['defne', '«Proje planı» notunu baştan okudum, üçüncü madde biraz havada kalmış.'],
  ['baran', 'Çalışıyorsa dokunmayalım bence.'],
  ['defne', 'Çalışıyor ama kimse neden çalıştığını bilmiyor, ondan korkuyorum.'],
  ['baran', 'Bir test yazarım, gönlün rahatlar.'],
  ['defne', 'Testin açıklamasını da ben yazayım o zaman, dipnotlu.'],
  ['baran', 'Dipnot istemez Defne. Gerçekten istemez.'],
];

// Davranış betikleri (döngü). sit: koltuk, go: nokta/koltuk/[x,y], act: poz, carry: eşya, meet: buluşma.
const SCRIPTS = {
  defne: [{ sit: 'defne', pose: 'type', dur: 16, act: '«Proje planı» notunu düzenliyor', notes: 1 }, { meet: 'db' }, { sit: 'defne', pose: 'type', dur: 40, act: 'dipnot ekliyor', notes: 1 }],
  baran: [{ sit: 'baran', pose: 'type', dur: 14, act: 'terminalde test çalıştırıyor' }, { meet: 'db' }, { sit: 'baran', pose: 'type', dur: 26, act: 'bir test yazıyor', notes: 1 }, { act: 'phone', dur: 6, label: 'telefonuna bakıyor' }, { sit: 'baran', pose: 'type', dur: 10, act: 'terminalde' }],
  ilgin: [{ sit: 'ilgin', pose: 'type', dur: 18, act: 'yeni bir modeli deniyor', notes: 1 }, { act: 'yawn', dur: 3, label: 'esniyor', mood: '🥱' }, { sit: 'ilgin', pose: 'type', dur: 14, act: 'açık kaynak alternatif arıyor' }, { act: 'phone', dur: 7, label: 'telefonuna bakıyor' }],
  toprak: [{ sit: 'toprak', pose: 'type', dur: 22, act: 'kırk sekme arasında kaynak arıyor', notes: 1 }, { go: 'map_table', label: 'Harita odasına gidiyor' }, { act: 'idle', dir: 'down', dur: 6, label: 'harita masasına bakıyor', icon: 'idea', mood: '🤔' }, { go: 'card_catalog', label: 'Arşive gidiyor' }, { act: 'idle', dir: 'up', dur: 5, label: 'bir kaynağa daha bakıyor', icon: 'question', mood: '🤔' }],
  asya: [{ sit: 'asya', pose: 'type', dur: 20, act: '«Çeviri notları»nı düzenliyor', notes: 1 }, { act: 'drink', dur: 6, label: 'çayını içiyor', icon: 'tea', hold: 'teaglass', tea: 40 }, { sit: 'asya', pose: 'type', dur: 18, act: 'çeviri yapıyor' }, { act: 'talk', dir: 'down', dur: 4, label: 'atasözü çeviriyor', say: 'Damlaya damlaya göl olur. Drop by drop, a lake.' }],
  berk: [{ sit: 'berk', pose: 'type', dur: 12, act: 'dağınık notları topluyor' }, { go: 'vending', label: 'Mutfağa gidiyor' }, { act: 'idle', dir: 'up', dur: 3, label: 'kahve alıyor' }, { carry: 'coffee_cup' }, { go: [6, 18], label: 'Defne\'ye kahve götürüyor' }, { act: 'carry', dir: 'down', dur: 4, label: 'Defne\'ye soru soruyor', say: 'Abi bunu ben yapabilir miyim?' }, { carry: null }, { sit: 'berk', pose: 'type', dur: 20, act: 'not başlıklarını yazıyor', notes: 1 }],
  sena: [{ sit: 'sena', pose: 'type', dur: 18, act: 'başlıkları düzeltiyor', notes: 1 }, { act: 'phone', dur: 5, label: 'telefonuna bakıyor' }, { sit: 'sena', pose: 'type', dur: 12, act: 'kırmızı kalemle okuyor' }, { act: 'talk', dir: 'down', dur: 3, label: 'başlığa itiraz ediyor', say: 'Bu başlık olmamış.', icon: 'anger' }],
  kaan: [{ sit: 'kaan', pose: 'type', dur: 18, act: 'makbuzları mühürlüyor' }, { go: 'filing', label: 'dosya dolabına gidiyor' }, { act: 'idle', dir: 'up', dur: 4, label: 'dosya dolabını karıştırıyor' }, { carry: 'folder' }, { go: [41, 6], label: 'dosya taşıyor', files: 1 }, { carry: null }, { log: ['🧾', 'Kaan makbuzu arşive kaldırdı: «Toplantı notları»', null] }, { sit: 'kaan', pose: 'type', dur: 16, act: 'arşiv defterini dolduruyor' }],
  elif: [{ sit: 'elif', pose: 'type', dur: 20, act: 'notlar arasında bağlantı kuruyor', notes: 1 }, { go: 'corkboard', label: 'mantar panoya gidiyor' }, { act: 'idle', dir: 'up', dur: 5, label: 'iplere yeni not bağlıyor', say: 'Bu not şununla bağlantılı!', icon: 'idea' }, { sit: 'elif', pose: 'type', dur: 18, act: 'grafiği düzenliyor' }],
  umut: [{ sit: 'umut', pose: 'idle', dur: 10, act: 'zarfları ayırıyor' }, { fn: 'elevatorOpen' }, { go: 'elevator', label: 'asansöre gidiyor' }, { act: 'idle', dir: 'up', dur: 2, label: 'yeni notu alıyor' }, { fn: 'elevatorClose' }, { log: ['📬', '{Kim} gelen kutusuna yeni not attı: «Toplantı notları»', '#F2C14E'] }, { carry: 'envelope' }, { go: [51, 10], label: 'Pyn\'e not götürüyor', files: 1 }, { act: 'carry', dir: 'up', dur: 3, label: 'Pyn\'e not veriyor', say: 'Patron, {kim} yeni not göndermiş!' }, { fn: 'pynApprove' }, { carry: null }, { act: 'idle', dir: 'up', dur: 2, label: 'onayı bekliyor' }, { sit: 'umut', pose: 'idle', dur: 18, act: 'kargo kolilerini sayıyor' }],
  melis: [{ sit: 'melis', pose: 'type', dur: 20, act: 'araçların kayıtlarına bakıyor' }, { go: 'rack_codex', label: 'Codex kabinine gidiyor' }, { fn: 'codexDown' }, { act: 'idle', dir: 'up', dur: 5, label: 'Codex sunucusunu yeniden başlatıyor', icon: 'alert' }, { fn: 'codexUp' }, { act: 'idle', dir: 'up', dur: 3, label: 'kabloları topluyor', say: 'Kim yine sunucuya çay döktü?' }, { sit: 'melis', pose: 'type', dur: 24, act: 'terminalde' }],
  husnu: [{ go: 'tea', label: 'çay köşesine gidiyor' }, { act: 'idle', dir: 'up', dur: 4, label: 'çay demliyor' }, { carry: 'tray' }, { log: ['☕', 'Hüsnü amca çay dağıtıyor', null] }, { go: [6, 24], label: 'çay dağıtıyor' }, { act: 'carry', dir: 'up', dur: 3, label: 'çay dağıtıyor', say: 'Çaylar taze!', serve: ['toprak', 'asya', 'berk'] }, { go: [17, 18], label: 'çay dağıtıyor' }, { go: [41, 21], label: 'çay dağıtıyor' }, { act: 'carry', dir: 'up', dur: 3, label: 'Sena\'ya çay veriyor', say: 'Buyur evladım.', serve: ['sena'] }, { go: [8, 18], label: 'çay dağıtıyor' }, { act: 'carry', dir: 'down', dur: 3, label: 'çay dağıtıyor', serve: ['defne', 'baran', 'ilgin'] }, { go: 'tea', label: 'mutfağa dönüyor' }, { carry: null }, { sit: 'husnu', pose: 'sleep', dur: 14, act: 'uyukluyor', icon: 'zzz', mood: '😴' }],
  pyn: [{ sit: 'pyn', pose: 'type', dur: 24, act: 'onay bekleyen notlara bakıyor' }, { sit: 'pyn', pose: 'sleep', dur: 9, act: 'gözlerini dinlendiriyor', icon: 'zzz', mood: '😴' }, { sit: 'pyn', pose: 'sit', dur: 6, act: 'düşünüyor', say: 'Hmm.' }],
  tekir: [{ place: [804, 553], pose: 'sleep', dir: 'down', dur: 40, act: 'kanepede uyuyor', mood: '😴' }, { place: [804, 553], pose: 'groom', dir: 'side', dur: 5, act: 'tüylerini temizliyor', mood: '😺' }],
};
const START = { husnu: 'husnu', tekir: null };

export class OfficeEngine {
  constructor(canvas, art, cb = {}) {
    this.cv = canvas; this.art = art; this.cb = cb; this.T = 16;
    this.W = art.MAP.w * 16; this.H = art.MAP.h * 16;
    this.world = this.mk(this.W, this.H); this.base = this.mk(this.W, this.H); this.lightCv = this.mk(this.W, this.H);
    this.cache = new Map(); this.col = art.buildCollision();
    this.zoom = 1; this.camX = this.W / 2; this.camY = this.H / 2; this.camTarget = null;
    this.t = 0; this.speed = 1; this.mode = 'ogle'; this.font = "'Pixelify Sans'"; this.lang = 'tr';
    this.selected = null; this.hover = null; this.room = null; this.preview = null;
    this.bubbles = []; this.meets = {}; this.led = { ...TOOL_STATUS }; this.userName = null;
    this.doorState = {}; this.elevator = { f: 0, open: false };
    this.objects = art.MAP.objects.map((o) => ({ ...o, s: art.SPRITES[o.sprite] }));
    this.seat = Object.fromEntries(art.MAP.seats.map((s) => [s.id, s]));
    this.spot = Object.fromEntries(art.MAP.spots.map((s) => [s.id, s]));
    this.bake(); this.collectLights(); this.initAgents(); this.bind();
    this.resize(true);
    this.last = performance.now(); this.snapT = 0; this.active = true;
    this.raf = requestAnimationFrame(this.loop);
  }
  /** Görünmeyen sekmede döngü durur; geri gelince kaldığı yerden sürer (aradaki süre atlanır). */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    cancelAnimationFrame(this.raf);
    if (on) { this.last = performance.now(); this.resize(); this.raf = requestAnimationFrame(this.loop); }
  }
  /** Kullanıcının hitabı ("Tolga Bey"): satırlardaki {kim} / {Kim} onunla dolar; yoksa "kasanın sahibi". */
  setUserName(name) { this.userName = name || null; }
  who(text) {
    const name = this.userName || (this.lang === 'en' ? 'the owner' : 'kasanın sahibi');
    const upper = name.charAt(0).toLocaleUpperCase(this.lang === 'en' ? 'en' : 'tr') + name.slice(1);
    return String(text).replace(/\{Kim\}/g, upper).replace(/\{kim\}/g, name);
  }
  /** Ofis açıldığında: günlükte bir satır, Pyn'den bir selam. */
  greet() {
    const en = this.lang === 'en';
    this.log('👋', en ? '{Kim} dropped by the office' : '{Kim} ofise uğradı', '#F2C14E');
    const pyn = this.byId && this.byId.pyn; if (pyn) this.say(pyn, en ? 'Welcome, {kim}.' : 'Hoş geldin, {kim}.', 4);
  }
  /** Sunucu kabinlerinin LED'leri: { claude: 'ok' | 'wait' | 'off', … }, araçların gerçek giriş durumundan. */
  setLeds(led) { this.led = { ...this.led, ...led }; }
  mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  frame(name, f, flip, pal) {
    const key = name + '|' + f + '|' + (flip ? 1 : 0) + '|' + (pal ? pal.led : '');
    let c = this.cache.get(key); if (c) return c;
    const s = this.art.SPRITES[name] || this.art.ITEMS[name] || this.art.ICONS[name];
    c = this.mk(s.w, s.h); const x = c.getContext('2d');
    if (flip) { x.translate(s.w, 0); x.scale(-1, 1); }
    s.paint(x, f, pal || {}); this.cache.set(key, c); return c;
  }
  charFrame(id, pose, dir, f) {
    const key = 'ch|' + id + '|' + pose + '|' + dir + '|' + f; let c = this.cache.get(key); if (c) return c;
    const cell = this.art.cellOf(id); c = this.mk(cell.w, cell.h); this.art.paintCharacter(c.getContext('2d'), id, pose, dir, f); this.cache.set(key, c); return c;
  }
  bake() {
    const x = this.base.getContext('2d'), A = this.art;
    x.fillStyle = '#0B0D11'; x.fillRect(0, 0, this.W, this.H);
    for (let ty = 0; ty < A.MAP.h; ty++) for (let tx = 0; tx < A.MAP.w; tx++) for (const n of A.tileSprites(tx, ty)) A.SPRITES[n].paint(x, 0, {}, tx * 16, ty * 16);
    for (const o of this.objects) if (o.s.layer === 'floor') x.drawImage(this.frame(o.sprite, 0, o.flip), o.left, o.top);
  }
  collectLights() {
    this.lights = [];
    for (const o of this.objects) { const l = o.s.light; if (!l) continue; const lx = o.flip ? o.s.w - 1 - l.x : l.x; this.lights.push({ x: o.left + lx, y: o.top + l.y, r: l.r, color: l.color, k: 1, tool: o.tool }); }
    for (const l of this.art.MAP.lights) this.lights.push({ ...l, k: 0.32 });
  }
  // ── Ajanlar
  initAgents() {
    const A = this.art; this.agents = [];
    const ids = Object.keys(A.CHARACTERS);
    ids.forEach((id, i) => {
      const ch = A.CHARACTERS[id], s = this.seat[START[id] === undefined ? id : START[id]] || null;
      const ag = { id, ch, x: 480, y: 330, dir: 'down', pose: 'idle', animT: i * 0.37, path: null, step: 0, wait: 0, carry: null, hold: null, act: '', mood: id === 'pyn' ? '😑' : '🙂',
        needs: { tea: 45 + ((i * 37) % 50), food: 40 + ((i * 53) % 55), energy: 50 + ((i * 29) % 45) }, cnt: { notes: (i * 3) % 7, talks: (i * 2) % 5, files: (i * 5) % 4 }, seatId: null };
      if (s) { ag.x = s.px; ag.y = s.py; ag.dir = s.dir; ag.pose = 'sit'; ag.seatId = s.id; }
      if (id === 'tekir') { ag.x = 804; ag.y = 553; ag.pose = 'sleep'; }
      ag.step = id === 'defne' || id === 'baran' ? 0 : (i % 2); ag.wait = 0; ag.started = false;
      this.agents.push(ag);
    });
    this.byId = Object.fromEntries(this.agents.map((a) => [a.id, a]));
  }
  tileOf(x, y) { return [Math.floor(x / 16), Math.floor((y - 2) / 16)]; }
  findPath(from, to) {
    const { w, isBlocked } = this.col, key = (x, y) => y * w + x, [fx, fy] = from, [tx, ty] = to;
    if (fx === tx && fy === ty) return [];
    const prev = new Map([[key(fx, fy), -1]]), q = [[fx, fy]];
    while (q.length) {
      const [x, y] = q.shift(); if (x === tx && y === ty) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, k = key(nx, ny); if (prev.has(k)) continue; if (isBlocked(nx, ny) && !(nx === tx && ny === ty)) continue; prev.set(k, key(x, y)); q.push([nx, ny]); }
    }
    if (!prev.has(key(tx, ty))) return null;
    const out = []; let k = key(tx, ty); while (k !== key(fx, fy)) { out.push([k % w, Math.floor(k / w)]); k = prev.get(k); }
    return out.reverse();
  }
  goTo(ag, tile, then) {
    let st = this.tileOf(ag.x, ag.y); if (this.col.isBlocked(st[0], st[1])) { const s = ag.seatId && this.seat[ag.seatId]; st = this.nearestFree(st); }
    const p = this.findPath(st, tile); ag.seatId = null;
    if (!p) { then && then(); return; }
    ag.path = p.map(([x, y]) => [x * 16 + 8, y * 16 + 12]); ag.onArrive = then; ag.pose = ag.carry ? 'carry' : 'walk';
  }
  nearestFree([x, y]) { for (let r = 1; r < 4; r++) for (const [dx, dy] of [[0, -r], [0, r], [-r, 0], [r, 0]]) if (!this.col.isBlocked(x + dx, y + dy)) return [x + dx, y + dy]; return [x, y]; }
  target(t) { if (Array.isArray(t)) return { tile: t, dir: null }; const s = this.seat[t] || this.spot[t]; return { tile: s.from || [s.x, s.y], dir: s.dir, seat: this.seat[t] }; }
  runStep(ag) {
    const sc = SCRIPTS[ag.id]; if (!sc) return; const st = sc[ag.step % sc.length]; ag.step++;
    const next = () => { ag.wait = 0; ag.busy = false; };
    ag.busy = true; ag.icon = null;
    if (st.place) { ag.x = st.place[0]; ag.y = st.place[1]; ag.pose = st.pose; ag.dir = st.dir; ag.wait = st.dur; ag.act = st.act; ag.mood = st.mood || ag.mood; ag.busy = false; return; }
    if (st.carry !== undefined) { ag.carry = st.carry; if (st.carry && st.carry !== 'coffee_cup') ag.cnt.files++; return next(); }
    if (st.log) { this.log(...st.log); return next(); }
    if (st.fn) { this[st.fn](ag); return next(); }
    if (st.meet) { this.joinMeet(st.meet, ag); return; }
    if (st.sit) {
      const s = this.seat[st.sit];
      const sitDown = () => { ag.x = s.px; ag.y = s.py; ag.dir = s.dir; ag.pose = st.pose; ag.seatId = s.id; ag.wait = st.dur; ag.act = st.act; ag.mood = st.mood || (ag.id === 'pyn' ? '😑' : '🙂'); if (st.icon) this.status(ag, st.icon, 3); if (st.say) this.say(ag, st.say); if (st.notes) ag.cnt.notes++; ag.busy = false; };
      if (ag.seatId === s.id) return sitDown();
      ag.act = 'yürüyor'; this.goTo(ag, s.from || [s.x, s.y], sitDown); return;
    }
    if (st.go) { const t = this.target(st.go); ag.act = st.label || 'yürüyor'; if (st.files) ag.cnt.files++; this.goTo(ag, t.tile, () => { if (t.dir) ag.dir = t.dir; ag.pose = ag.carry ? 'carry' : 'idle'; next(); }); return; }
    if (st.act) {
      ag.pose = st.act; if (st.dir) ag.dir = st.dir; ag.wait = st.dur; ag.act = st.label || ag.act; ag.mood = st.mood || (st.say ? '😄' : (ag.id === 'pyn' ? '😑' : '🙂'));
      if (st.icon) this.status(ag, st.icon, Math.min(4, st.dur)); if (st.say) this.say(ag, st.say); if (st.hold) ag.hold = st.hold; if (st.tea) ag.needs.tea = Math.min(100, ag.needs.tea + st.tea);
      if (st.serve) for (const id of st.serve) { const o = this.byId[id]; o.needs.tea = Math.min(100, o.needs.tea + 35); this.status(o, 'tea', 2.5); }
      ag.busy = false; ag.afterAct = () => { ag.hold = null; if (ag.seatId) ag.pose = 'type'; };
    }
  }
  joinMeet(id, ag) {
    const m = this.meets[id] || (this.meets[id] = { members: { defne: 'talk_a', baran: 'talk_b' }, arrived: new Set(), line: -1, t: 0 });
    const sp = this.spot[m.members[ag.id]]; ag.act = 'Baran ile buluşmaya gidiyor'.replace('Baran', ag.id === 'defne' ? 'Baran' : 'Defne');
    this.goTo(ag, [sp.x, sp.y], () => { ag.dir = sp.dir; ag.pose = 'idle'; m.arrived.add(ag.id); ag.act = 'bekliyor'; });
    ag.meeting = m;
  }
  updateMeets(dt) {
    for (const [id, m] of Object.entries(this.meets)) {
      if (m.arrived.size < 2) continue;
      if (m.line === -1) { m.line = 0; m.t = 0; this.log('💬', 'Defne ve Baran «Proje planı» üzerine konuşuyor', null); for (const a of ['defne', 'baran']) { this.byId[a].act = (a === 'defne' ? 'Baran' : 'Defne') + ' ile «Proje planı» üzerine konuşuyor'; this.byId[a].mood = '🙂'; this.byId[a].cnt.talks++; } this.speakLine(m); continue; }
      m.t += dt;
      if (m.t >= 3.5) { m.t = 0; m.line++; if (m.line >= CONVO_DB.length) { for (const a of ['defne', 'baran']) { const ag = this.byId[a]; ag.meeting = null; ag.busy = false; ag.wait = 0; ag.pose = 'idle'; } delete this.meets[id]; continue; } this.speakLine(m); }
    }
  }
  speakLine(m) {
    const [who, text] = CONVO_DB[m.line], other = who === 'defne' ? 'baran' : 'defne';
    this.byId[who].pose = 'talk'; this.byId[other].pose = 'idle';
    this.say(this.byId[who], text, 3.3); this.log(null, text, null, who);
  }
  triggerConvo() { for (const a of ['defne', 'baran']) { const ag = this.byId[a]; if (ag.meeting) return; } for (const a of ['defne', 'baran']) { const ag = this.byId[a]; ag.path = null; ag.step = SCRIPTS[a].findIndex((s) => s.meet); ag.wait = 0; ag.busy = false; } }
  elevatorOpen() { this.elevator.open = true; }
  elevatorClose() { this.elevator.open = false; }
  // Melis'in yeniden başlatması yalnız gerçekten hazır olan Codex'i bir an söndürür; gerçek durum hep geri gelir.
  codexDown() { if (this.led.codex === 'ok') { this.led.codex = 'wait'; this.codexBlink = true; } }
  codexUp() { if (!this.codexBlink) return; this.codexBlink = false; this.led.codex = 'ok'; this.log('🔌', 'Melis: Codex\'in sunucusu yeniden ayağa kalktı', null); }
  pynApprove() {
    const p = this.byId.pyn; this.say(p, 'Hmm.', 2.2);
    setTimeout(() => this.log('✅', 'Pyn onayladı: «Toplantı notları»', '#5BD77A'), 1200 / this.speed);
    setTimeout(() => this.log('📰', 'Yayında: «Toplantı notları»', '#5BD77A'), 9000 / this.speed);
  }
  say(ag, text, dur = 3.2) { this.bubbles = this.bubbles.filter((b) => b.ag !== ag); this.bubbles.push({ ag, text: this.who(text), t: 0, dur }); }
  status(ag, icon, dur = 3) { this.bubbles = this.bubbles.filter((b) => b.ag !== ag || b.text); this.bubbles.push({ ag, icon, t: 0, dur }); }
  log(icon, text, color, who) { this.cb.onLog && this.cb.onLog({ time: clockText(), icon, text: this.who(text), color, who }); }
  updateAgent(ag, dt) {
    ag.animT += dt;
    for (const k of ['tea', 'food', 'energy']) ag.needs[k] = Math.max(8, ag.needs[k] - dt * (k === 'tea' ? 0.35 : 0.18));
    if (ag.pose === 'sleep') ag.needs.energy = Math.min(100, ag.needs.energy + dt * 2);
    if (ag.path) {
      const [tx, ty] = ag.path[0], dx = tx - ag.x, dy = ty - ag.y, d = Math.hypot(dx, dy), v = (ag.id === 'umut' ? 52 : ag.id === 'tekir' ? 30 : 40) * dt;
      if (Math.abs(dx) > Math.abs(dy)) ag.dir = dx > 0 ? 'side' : 'left'; else if (d > 0.01) ag.dir = dy > 0 ? 'down' : 'up';
      if (d <= v) { ag.x = tx; ag.y = ty; ag.path.shift(); if (!ag.path.length) { ag.path = null; const f = ag.onArrive; ag.onArrive = null; ag.pose = ag.carry ? 'carry' : 'idle'; f && f(); } }
      else { ag.x += dx / d * v; ag.y += dy / d * v; }
      return;
    }
    if (ag.meeting) return;
    if (ag.busy) return;
    if (ag.wait > 0) { ag.wait -= dt; if (ag.wait <= 0 && ag.afterAct) { const f = ag.afterAct; ag.afterAct = null; f(); } return; }
    this.runStep(ag);
  }
  // ── Kamera / giriş
  minZoom() { const r = this.cv.getBoundingClientRect(); return Math.min(1, Math.min(r.width / this.W, r.height / this.H)); }
  fitZoom() { const r = this.cv.getBoundingClientRect(); return Math.min(r.width / this.W, r.height / this.H); }
  clampCam() {
    const r = this.cv.getBoundingClientRect(), hw = r.width / 2 / this.zoom, hh = r.height / 2 / this.zoom;
    this.camX = hw * 2 >= this.W ? this.W / 2 : Math.max(hw, Math.min(this.W - hw, this.camX));
    this.camY = hh * 2 >= this.H ? this.H / 2 : Math.max(hh, Math.min(this.H - hh, this.camY));
  }
  resize(fit) {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; this.rect = r;
    this.cv.width = Math.max(1, Math.round(r.width * dpr)); this.cv.height = Math.max(1, Math.round(r.height * dpr)); this.dpr = dpr;
    if (fit) { this.zoom = Math.max(this.minZoom(), Math.min(4, this.fitZoom())); }
    this.zoom = Math.max(this.minZoom(), this.zoom); this.clampCam();
  }
  toWorld(cx, cy) { const r = this.rect || this.cv.getBoundingClientRect(); return [(cx - r.left - r.width / 2) / this.zoom + this.camX, (cy - r.top - r.height / 2) / this.zoom + this.camY]; }
  toScreen(wx, wy) { const r = this.rect; return [(wx - this.camX) * this.zoom + r.width / 2, (wy - this.camY) * this.zoom + r.height / 2]; }
  zoomAt(f, cx, cy) {
    const r = this.cv.getBoundingClientRect(); if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const [wx, wy] = this.toWorld(cx, cy); this.zoom = Math.max(this.minZoom(), Math.min(4, this.zoom * f));
    this.camX = wx - (cx - r.left - r.width / 2) / this.zoom; this.camY = wy - (cy - r.top - r.height / 2) / this.zoom; this.camTarget = null; this.clampCam();
  }
  focus(id) { const a = this.byId[id]; if (!a) return; this.zoom = Math.max(this.zoom, 2.5); this.camTarget = id; this.select(id); }
  select(id) { this.selected = id; if (id) this.room = null; this.cb.onSelect && this.cb.onSelect(id); }
  hit(wx, wy) {
    let best = null;
    for (const a of this.agents) { const c = this.art.cellOf(a.id), top = a.id === 'tekir' ? 12 : 26; if (wx >= a.x - 7 && wx <= a.x + 7 && wy >= a.y - top && wy <= a.y + 2) if (!best || a.y > best.y) best = a; }
    return best;
  }
  bind() {
    const cv = this.cv; let down = null;
    this.onWheel = (e) => { e.preventDefault(); this.zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY); this.cb.onInteract && this.cb.onInteract(); };
    this.onDown = (e) => { down = { x: e.clientX, y: e.clientY, cx: this.camX, cy: this.camY, drag: false }; cv.setPointerCapture(e.pointerId); };
    this.onMove = (e) => {
      if (down) { const dx = e.clientX - down.x, dy = e.clientY - down.y; if (!down.drag && Math.hypot(dx, dy) > 4) { down.drag = true; this.camTarget = null; this.cb.onInteract && this.cb.onInteract(); } if (down.drag) { this.camX = down.cx - dx / this.zoom; this.camY = down.cy - dy / this.zoom; this.clampCam(); } return; }
      const [wx, wy] = this.toWorld(e.clientX, e.clientY), h = this.hit(wx, wy); const id = h ? h.id : null;
      if (id !== this.hover) { this.hover = id; this.cb.onHover && this.cb.onHover(id); }
    };
    this.onUp = (e) => {
      if (!down) return; const wasDrag = down.drag; down = null; if (wasDrag) return;
      this.cb.onInteract && this.cb.onInteract();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY), h = this.hit(wx, wy);
      if (h) { this.select(h.id); return; }
      const rid = this.art.roomAt(Math.floor(wx / 16), Math.floor(wy / 16));
      this.select(null); this.room = rid; this.cb.onRoom && this.cb.onRoom(rid);
    };
    this.onLeave = () => { if (this.hover) { this.hover = null; this.cb.onHover && this.cb.onHover(null); } };
    cv.addEventListener('wheel', this.onWheel, { passive: false }); cv.addEventListener('pointerdown', this.onDown); cv.addEventListener('pointermove', this.onMove); cv.addEventListener('pointerup', this.onUp); cv.addEventListener('pointerleave', this.onLeave);
  }
  destroy() { this.active = false; cancelAnimationFrame(this.raf); const cv = this.cv; cv.removeEventListener('wheel', this.onWheel); cv.removeEventListener('pointerdown', this.onDown); cv.removeEventListener('pointermove', this.onMove); cv.removeEventListener('pointerup', this.onUp); cv.removeEventListener('pointerleave', this.onLeave); }
  // ── Döngü
  loop = (now) => {
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000)) * this.speed; // a frame's time can come before the start's this.last = now; this.t += dt; this.rect = this.cv.getBoundingClientRect();
    for (const a of this.agents) this.updateAgent(a, dt);
    this.updateMeets(dt);
    for (const b of this.bubbles) b.t += dt; this.bubbles = this.bubbles.filter((b) => b.t < b.dur);
    this.updateDoors(dt);
    if (this.camTarget) { const a = this.byId[this.camTarget]; const k = 1 - Math.pow(0.002, dt / this.speed); this.camX += (a.x - this.camX) * k; this.camY += (a.y - 12 - this.camY) * k; this.clampCam(); if (Math.hypot(a.x - this.camX, a.y - 12 - this.camY) < 1) this.camTarget = null; }
    this.renderWorld(); this.renderScreen();
    if (this.preview) this.drawPreview();
    this.snapT += dt / this.speed; if (this.snapT > 0.3) { this.snapT = 0; this.cb.onSnapshot && this.cb.onSnapshot(this.snapshot()); }
    if (this.active) this.raf = requestAnimationFrame(this.loop);
  };
  updateDoors(dt) {
    for (const o of this.objects) {
      if (o.sprite !== 'door_glass') continue;
      const cx = o.left + 16, cy = o.top < 400 ? 15 * 16 : 30 * 16;
      const near = this.agents.some((a) => Math.abs(a.x - cx) < 20 && Math.abs(a.y - cy) < 40);
      const s = this.doorState[o.id] || 0; this.doorState[o.id] = Math.max(0, Math.min(3, s + (near ? 1 : -1) * dt * 10));
    }
    const e = this.elevator; e.f = Math.max(0, Math.min(4, e.f + (e.open ? 1 : -1) * dt * 6));
  }
  objFrame(o) {
    const s = o.s;
    if (o.sprite === 'door_glass') return Math.round(this.doorState[o.id] || 0);
    if (o.sprite === 'elevator') return Math.round(this.elevator.f);
    if (o.sprite === 'desk_lamp') return 0;
    if (s.frames > 1 && s.fps) return loopFrame(this.t, s.fps, s.frames, o.left * 0.013);
    return 0;
  }
  renderWorld() {
    const x = this.world.getContext('2d'), A = this.art;
    x.imageSmoothingEnabled = false; x.drawImage(this.base, 0, 0);
    const wallObjs = [], list = [], tops = [];
    for (const o of this.objects) { const L = o.s.layer; if (L === 'floor') continue; (L === 'wall' ? wallObjs : L === 'top' ? tops : list).push(o); }
    for (const o of wallObjs) x.drawImage(this.frame(o.sprite, this.objFrame(o), o.flip), o.left, o.top);
    this.drawClocks(x);
    const items = list.map((o) => ({ y: o.y + (o.z || 0), o }));
    for (const a of this.agents) items.push({ y: a.y, a });
    items.sort((p, q) => p.y - q.y);
    for (const it of items) {
      if (it.o) { const o = it.o, pal = o.tool && o.sprite.startsWith('rack_led_') ? { led: A.LED[this.led[o.tool]] } : null; x.drawImage(this.frame(o.sprite, this.objFrame(o), o.flip, pal), o.left, o.top); continue; }
      const a = it.a, P = (a.id === 'tekir' ? A.CAT_POSES : A.POSES)[a.pose] || A.POSES.idle, fps = a.pose === 'carry' && !a.path ? 0 : P.fps;
      const f = Math.floor(a.animT * fps) % P.frames, cell = A.cellOf(a.id), lx = Math.round(a.x) - cell.footX, ly = Math.round(a.y) - cell.footY;
      const item = a.carry || a.hold, an = item ? A.anchors(a.id, a.pose, a.dir, f) : null;
      const drawItem = () => { const s = A.ITEMS[item]; if (!s) return; x.drawImage(this.frame(item, 0, false), lx + an.hand[0] - s.ax, ly + an.hand[1] - s.ay); };
      if (item && a.dir === 'up') drawItem();
      x.drawImage(this.charFrame(a.id, a.pose, a.dir, f), lx, ly);
      if (item && a.dir !== 'up') drawItem();
    }
    for (const o of tops) x.drawImage(this.frame(o.sprite, this.objFrame(o), o.flip), o.left, o.top);
    this.renderLight(x);
  }
  drawClocks(x) {
    const d = new Date(), mi = d.getMinutes() + d.getSeconds() / 60, hr = (d.getHours() % 12) + mi / 60;
    for (const o of this.objects) {
      let cx, cy, rm, rh; if (o.sprite === 'wall_clock') { cx = o.left + 7.5; cy = o.top + 6.5; rm = 4; rh = 2.6; } else if (o.sprite === 'clock_big') { cx = o.left + 15.5; cy = o.top + 14.5; rm = 8; rh = 5; } else continue;
      x.fillStyle = '#25222b';
      for (const [ang, len] of [[mi / 60 * Math.PI * 2, rm], [hr / 12 * Math.PI * 2, rh]]) for (let i = 0; i <= len; i += 0.5) x.fillRect(Math.round(cx + Math.sin(ang) * i - 0.5), Math.round(cy - Math.cos(ang) * i - 0.5), 1, 1);
      if (o.sprite === 'clock_big') { x.fillStyle = '#a33f40'; const sa = d.getSeconds() / 60 * Math.PI * 2; for (let i = 0; i <= 8; i++) x.fillRect(Math.round(cx + Math.sin(sa) * i - 0.5), Math.round(cy - Math.cos(sa) * i - 0.5), 1, 1); }
    }
  }
  renderLight(x) {
    const tint = LIGHT_TINT[this.mode]; if (!tint) return;
    const L = this.lightCv.getContext('2d'), night = this.mode === 'gece', eve = this.mode === 'aksam';
    L.globalCompositeOperation = 'source-over'; L.globalAlpha = 1; L.fillStyle = `rgb(${tint.join(',')})`; L.fillRect(0, 0, this.W, this.H);
    if (night || eve) {
      L.globalCompositeOperation = 'lighter';
      for (const l of this.lights) {
        if (l.tool && this.led[l.tool] === 'off') continue;
        const base = (night ? 0.17 : 0.06) * l.k;
        for (const [k, a] of [[1, base * 0.55], [0.75, base * 0.8], [0.5, base], [0.28, base * 1.2]]) { L.globalAlpha = a; L.fillStyle = l.color; L.beginPath(); L.arc(Math.round(l.x), Math.round(l.y), Math.round(l.r * k), 0, Math.PI * 2); L.fill(); }
      }
      L.globalAlpha = 1;
    }
    x.globalCompositeOperation = 'multiply'; x.drawImage(this.lightCv, 0, 0);
    if (night) { x.globalCompositeOperation = 'lighter'; for (const l of this.lights) { if (l.k < 1 || (l.tool && this.led[l.tool] === 'off')) continue; x.globalAlpha = 0.07; x.fillStyle = l.color; x.beginPath(); x.arc(Math.round(l.x), Math.round(l.y), Math.round(l.r * 0.4), 0, Math.PI * 2); x.fill(); } x.globalAlpha = 1; }
    if (this.mode === 'sabah') { x.globalCompositeOperation = 'screen'; x.fillStyle = 'rgba(40,52,80,0.10)'; x.fillRect(0, 0, this.W, this.H); }
    x.globalCompositeOperation = 'source-over';
  }
  renderScreen() {
    const c = this.cv.getContext('2d'), dpr = this.dpr, r = this.cv.getBoundingClientRect();
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#0B0D11'; c.fillRect(0, 0, this.cv.width, this.cv.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.imageSmoothingEnabled = false;
    const [sx, sy] = this.toScreen(0, 0); c.drawImage(this.world, Math.round(sx * dpr) / dpr, Math.round(sy * dpr) / dpr, this.W * this.zoom, this.H * this.zoom);
    // oda adları (motor yazar)
    const fs = Math.max(8, Math.round(8.5 * this.zoom));
    c.font = `600 ${fs}px ${this.font}, monospace`; c.textBaseline = 'alphabetic';
    for (const rm of this.art.MAP.rooms) { const [lx, ly] = this.toScreen(rm.x * 16 + 5, (rm.y + rm.h) * 16 - 5); const name = this.lang === 'en' ? rm.en : rm.tr; c.fillStyle = 'rgba(10,12,18,0.30)'; c.fillText(name, lx + 1, ly + 1); c.fillStyle = 'rgba(255,255,255,0.30)'; c.fillText(name, lx, ly); }
    // seçim oku + isim etiketi
    const art = this.art;
    for (const a of this.agents) {
      const an = art.anchors(a.id, a.pose, a.dir, 0), cell = art.cellOf(a.id);
      const [hx, hy] = this.toScreen(a.x - cell.footX + an.head[0] + 0.5, a.y - cell.footY + an.head[1]);
      a._head = [hx, hy];
      if (a.id === this.selected) { const k = Math.max(2, Math.round(this.zoom)), s = art.ICONS.select, f = Math.floor(this.t * 3) % 2, bob = Math.round(Math.sin(this.t * 5) * 2); c.drawImage(this.frame('select', f), Math.round(hx - s.w * k / 2), Math.round(hy - s.h * k - 6 + bob), s.w * k, s.h * k); }
      else if (a.id === this.hover) this.nameTag(c, hx, hy - 6, a.ch.name, a.ch.color);
    }
    for (const b of this.bubbles) { const h = b.ag._head; if (!h) continue; const lift = b.ag.id === this.selected ? Math.max(2, Math.round(this.zoom)) * 9 + 6 : 4; if (b.text) this.speech(c, h[0], h[1] - lift, b.text, b.t, b.dur); else this.statusBubble(c, h[0], h[1] - lift, b.icon, b.t, b.dur); }
  }
  nameTag(c, x, y, name, color) {
    c.font = `600 12px ${this.font}, monospace`; const w = Math.ceil(c.measureText(name).width) + 10, h = 17, l = Math.round(x - w / 2), t = Math.round(y - h);
    c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(l + 2, t + 2, w, h); c.fillStyle = '#0E1116'; c.fillRect(l, t, w, h); c.fillStyle = '#262C36'; c.fillRect(l, t, w, 1); c.fillRect(l, t + h - 1, w, 1); c.fillRect(l, t, 1, h); c.fillRect(l + w - 1, t, 1, h);
    c.fillStyle = color; c.textBaseline = 'middle'; c.fillText(name, l + 5, t + h / 2 + 1); c.textBaseline = 'alphabetic';
  }
  wrap(c, text) {
    const words = text.split(' '), lines = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > 28) { lines.push(cur.trim()); cur = w; } else cur = (cur + ' ' + w).trim(); }
    if (cur) lines.push(cur); if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].replace(/.?$/, '…'); } return lines;
  }
  grow(t, dur) { if (t < 0.05) return 0.55; if (t < 0.1) return 0.82; return 1; }
  box(c, l, t, w, h, u) {
    c.fillStyle = 'rgba(0,0,0,0.42)'; c.fillRect(l + 2 * u, t + 2 * u, w, h);
    c.fillStyle = '#1a1620'; c.fillRect(l + u, t, w - 2 * u, h); c.fillRect(l, t + u, w, h - 2 * u);
    c.fillStyle = '#F7F5EF'; c.fillRect(l + u, t + u, w - 2 * u, h - 2 * u);
  }
  tail(c, x, y, u) { for (let i = 0; i < 3; i++) { const w = (3 - i) * 2 * u; c.fillStyle = '#1a1620'; c.fillRect(Math.round(x - w / 2) - u, y + i * u, w + 2 * u, u); c.fillStyle = '#F7F5EF'; c.fillRect(Math.round(x - w / 2), y + i * u - (i === 0 ? u : 0), w, u + (i === 0 ? u : 0)); } c.fillStyle = '#1a1620'; c.fillRect(Math.round(x) - u, y + 3 * u, 2 * u, u); }
  speech(c, x, y, text, t, dur) {
    const u = 2, s = this.grow(t, dur), fs = 13, lh = 16;
    c.font = `500 ${fs}px ${this.font}, monospace`;
    const lines = this.wrap(c, text), tw = Math.max(...lines.map((l) => c.measureText(l).width));
    const w = Math.round((tw + 14) * s), h = Math.round((lines.length * lh + 10) * s), l = Math.round(x - w / 2), top = Math.round(y - h - 4 * u);
    this.box(c, l, top, w, h, u); this.tail(c, x, top + h - u, u);
    if (s === 1) { c.fillStyle = '#1a1620'; c.textBaseline = 'top'; lines.forEach((ln, i) => c.fillText(ln, l + 7, top + 6 + i * lh)); c.textBaseline = 'alphabetic'; }
  }
  statusBubble(c, x, y, icon, t, dur) {
    const u = 2, s = this.grow(t, dur), k = 2, sz = Math.round((12 * k + 10) * s), l = Math.round(x - sz / 2), top = Math.round(y - sz - 4 * u);
    this.box(c, l, top, sz, sz, u); this.tail(c, x, top + sz - u, u);
    if (s === 1) c.drawImage(this.frame(icon, 0), l + 5, top + 5, 12 * k, 12 * k);
  }
  setPreview(canvas, roomId) { this.preview = canvas ? { canvas, roomId } : null; }
  drawPreview() {
    const { canvas, roomId } = this.preview, rm = this.art.MAP.rooms.find((r) => r.id === roomId); if (!rm || !canvas) return;
    const sx = (rm.x - 1) * 16, sy = (rm.faceY - 1) * 16, sw = (rm.w + 2) * 16, sh = (rm.y + rm.h - rm.faceY + 2) * 16;
    const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.fillStyle = '#0B0D11'; c.fillRect(0, 0, canvas.width, canvas.height);
    const k = Math.min(canvas.width / sw, canvas.height / sh), w = sw * k, h = sh * k; c.drawImage(this.world, sx, sy, sw, sh, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  snapshot() {
    return this.agents.map((a) => {
      const [tx, ty] = this.tileOf(a.x, a.y);
      return { id: a.id, act: a.act || (a.pose === 'sleep' ? 'uyuyor' : 'etrafa bakıyor'), mood: a.pose === 'sleep' ? '😴' : a.pose === 'yawn' ? '🥱' : a.mood, room: this.art.roomAt(tx, ty) || this.art.roomAt(tx, ty + 1) || this.art.roomAt(tx, ty - 1), needs: { tea: Math.round(a.needs.tea), food: Math.round(a.needs.food), energy: Math.round(a.needs.energy) }, cnt: { ...a.cnt }, walking: !!a.path };
    });
  }
}
