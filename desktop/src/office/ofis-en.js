// ofis-en.js — the office (BEYİN view) in English. ofis-engine.js and office-art.js write their
// scenes in Turkish: the scripts' activities and labels, the speech bubbles, the log lines, the
// Defne–Baran talk, the characters' names, roles and bios. When the engine runs with lang 'en' it
// looks each one up here: EN by the exact Turkish string, EN_PATTERNS for the sentences it builds
// at run time from parts, enOf() for both. BIO_EN is the characters' bios by id. No imports.

// The notes the scenes talk about, and the names that change in English.
const NOTE_EN = { 'Proje planı': 'Project plan', 'Toplantı notları': 'Meeting notes', 'Çeviri notları': 'Translation notes' };
const NAME_EN = { 'Hüsnü amca': 'Uncle Hüsnü', 'Müdür': 'Manager', 'kasanın sahibi': 'the owner', 'Kasanın sahibi': 'The owner' };
const nameEn = (name) => NAME_EN[name] || name;
// A note title as English quotes it (en.ts writes “…”).
const titled = (title) => '“' + (NOTE_EN[title] || title) + '”';

// office-art.js CHARACTERS[id].bio: [Turkish, English], by character id.
const BIOS = {
  pyn: ['Ofisin patronu, huysuz bakışlı bir ananas. Az konuşur, her şeyi bir "Hmm." ile onaylar; ekibiyle gizlice gurur duyar.',
    'The office boss, a grumpy-looking pineapple. Says little and approves everything with a "Hmm."; secretly proud of the team.'],
  mudur: ['Ofisin müdürü, bu beynin sahibi. Lacivert takımını hiç çıkarmaz; işler yolunda gidince kollarını kavuşturup gülümser.',
    'The office manager, the owner of this brain. Never out of the navy suit; when things go well, folds their arms and smiles.'],
  tolga: ['Cortex\'i yazan yazılımcı; bu ofisin her tuğlası onun klavyesinden çıktı. Hızlı karar verir, tek pikseli kaçırmaz, terminali sevmez: her şey uygulamanın içinden kurulsun. Gece ikide "yarın devam" der, sabah ilk o gelir.',
    'The developer who wrote Cortex; every brick of this office came off his keyboard. Decides fast, never misses a pixel, dislikes the terminal: everything should set itself up inside the app. Says "more tomorrow" at 2 a.m., and is still the first one in.'],
  defne: ['Uzun ve özenli cümleler kurar, dipnotsuz metin teslim etmez. Her karardan önce bir kez "emin misin?" diye sorar.',
    'Writes long, careful sentences and never hands in a text without footnotes. Before every decision she asks once: "are you sure?"'],
  baran: ['Kısa konuşur, terminalden çıkmaz. Çalışan bir şeye dokunulmasından hoşlanmaz: "çalışıyor, dokunma".',
    'Keeps it short and never leaves the terminal. Hates anyone touching something that works: "it works, don\'t touch it".'],
  ilgin: ['Çıkan her ücretsiz modeli dener, her şeyi kurcalar. En sevdiği cümle: "bunun açık kaynak bir alternatifi var".',
    'Tries every free model that comes out and tinkers with everything. Favorite line: "there\'s an open-source alternative to that".'],
  toprak: ['Meraklıdır, aynı anda kırk sekme açar. Bir cevabı kesinleştirmeden önce "bir kaynağa daha bakayım" der.',
    'Curious; keeps forty tabs open at once. Before settling on an answer, says "let me check one more source".'],
  asya: ['Cümlenin ortasında dil değiştirir. Atasözlerini harfi harfine çevirir, sonra herkesin yüzüne bakıp bekler.',
    'Switches languages mid-sentence. Translates proverbs word for word, then looks around at everyone and waits.'],
  berk: ['Fazla hevesli stajyer. Elinde hep birinin kahvesi, dilinde hep aynı soru: "abi bunu ben yapabilir miyim?"',
    'An over-eager intern. Always carrying someone\'s coffee, always asking the same thing: "hey, can I do this one?"'],
  sena: ['Yazım hatasından nefret eder, kırmızı kalemi elinden düşmez. Başlıkları düzeltir: "bu başlık olmamış".',
    'Hates typos and never puts down her red pen. Fixes titles: "this title won\'t do".'],
  kaan: ['Titiz arşivci, her şeyi mühürler. Ona göre makbuzu olmayan iş yapılmamış sayılır.',
    'A meticulous archivist who stamps everything. To him, work without a receipt never happened.'],
  elif: ['Notlar arasındaki ipleri o çeker. Her yerde bir bağlantı görür: "bu not şununla bağlantılı!"',
    'She pulls the strings between the notes and sees a link everywhere: "this note links to that one!"'],
  umut: ['Gelen her notu ilk o görür. Hızlıdır, meraklıdır; ofisin dedikodusu onun çantasında dolaşır.',
    'Sees every incoming note first. Quick and curious; the office gossip travels in his bag.'],
  melis: ['Araçları ayakta tutan sistemci. Kuru espri yapar: "kim yine sunucuya çay döktü?"',
    'The sysadmin who keeps the tools running. Dry humor: "who spilled tea on the server again?"'],
  husnu: ['Ofisin çaycısı, herkese "evladım" der. Tepsisiyle salona girdiğinde herkes bilir: "çaylar taze!"',
    'The office tea man; calls everyone "dear". When he walks into the newsroom with his tray, everyone knows: "fresh tea!"'],
  tekir: ['Ofisin gri tekiri. Gündüz kanepede uyur, akşamüstü masaların arasında devriye gezer.',
    'The office\'s gray tabby. Sleeps on the sofa by day, patrols between the desks in the late afternoon.'],
};

/** Each character's bio in English, by its id in office-art.js CHARACTERS. */
export const BIO_EN = Object.fromEntries(Object.entries(BIOS).map(([id, [, en]]) => [id, en]));

/** Every fixed Turkish string the office shows, exactly as the source has it → English. */
export const EN = {
  // ── ofis-engine.js CONVO_DB: Defne and Baran's meeting
  '«Proje planı» notunu baştan okudum, üçüncü madde biraz havada kalmış.': 'Reread the “Project plan” note. Point three is a bit up in the air.',
  'Çalışıyorsa dokunmayalım bence.': 'If it works, let\'s not touch it.',
  'Çalışıyor ama kimse neden çalıştığını bilmiyor, ondan korkuyorum.': 'It works, but nobody knows why. That\'s what scares me.',
  'Bir test yazarım, gönlün rahatlar.': 'I\'ll write a test. You\'ll sleep better.',
  'Testin açıklamasını da ben yazayım o zaman, dipnotlu.': 'Then I\'ll write the test\'s description. With footnotes.',
  'Dipnot istemez Defne. Gerçekten istemez.': 'It needs no footnotes, Defne. It really doesn\'t.',

  // ── ofis-engine.js SCRIPTS: activities (act), labels, bubbles (say), log lines
  // defne
  '«Proje planı» notunu düzenliyor': 'editing the “Project plan” note',
  'dipnot ekliyor': 'adding footnotes',
  // baran
  'terminalde test çalıştırıyor': 'running tests in the terminal',
  'bir test yazıyor': 'writing a test',
  'telefonuna bakıyor': 'checking their phone',
  'terminalde': 'in the terminal',
  // ilgin
  'yeni bir modeli deniyor': 'trying out a new model',
  'esniyor': 'yawning',
  'açık kaynak alternatif arıyor': 'looking for an open-source alternative',
  // toprak
  'kırk sekme arasında kaynak arıyor': 'hunting sources across forty tabs',
  'Harita odasına gidiyor': 'heading to the map room',
  'harita masasına bakıyor': 'studying the map table',
  'Arşive gidiyor': 'heading to the archive',
  'bir kaynağa daha bakıyor': 'checking one more source',
  // asya
  '«Çeviri notları»nı düzenliyor': 'editing “Translation notes”',
  'çayını içiyor': 'sipping her tea',
  'çeviri yapıyor': 'translating',
  'atasözü çeviriyor': 'translating a proverb',
  // The joke is the Turkish proverb and its word-for-word English: it stays as it is.
  'Damlaya damlaya göl olur. Drop by drop, a lake.': 'Damlaya damlaya göl olur. Drop by drop, a lake.',
  // berk
  'dağınık notları topluyor': 'gathering stray notes',
  'Mutfağa gidiyor': 'heading to the kitchen',
  'kahve alıyor': 'getting a coffee',
  'Defne\'ye kahve götürüyor': 'taking Defne a coffee',
  'Defne\'ye soru soruyor': 'asking Defne a question',
  'Abi bunu ben yapabilir miyim?': 'Hey, can I do this one?',
  'not başlıklarını yazıyor': 'writing note titles',
  // sena
  'başlıkları düzeltiyor': 'fixing titles',
  'kırmızı kalemle okuyor': 'reading with a red pen',
  'başlığa itiraz ediyor': 'objecting to a title',
  'Bu başlık olmamış.': 'This title won\'t do.',
  // kaan
  'makbuzları mühürlüyor': 'stamping receipts',
  'dosya dolabına gidiyor': 'heading to the filing cabinet',
  'dosya dolabını karıştırıyor': 'digging through the filing cabinet',
  'dosya taşıyor': 'carrying a file',
  'Kaan makbuzu arşive kaldırdı: «Toplantı notları»': 'Kaan filed the receipt in the archive: “Meeting notes”',
  'arşiv defterini dolduruyor': 'filling in the archive ledger',
  // elif
  'notlar arasında bağlantı kuruyor': 'linking notes together',
  'mantar panoya gidiyor': 'heading to the corkboard',
  'iplere yeni not bağlıyor': 'pinning a new note to the strings',
  'Bu not şununla bağlantılı!': 'This note links to that one!',
  'grafiği düzenliyor': 'tidying the graph',
  // umut ({Kim} / {kim}: the engine's who() puts the user's name in, after this lookup)
  'zarfları ayırıyor': 'sorting envelopes',
  'asansöre gidiyor': 'heading to the elevator',
  'yeni notu alıyor': 'picking up the new note',
  '{Kim} gelen kutusuna yeni not attı: «Toplantı notları»': '{Kim} dropped a new note in the inbox: “Meeting notes”',
  'Pyn\'e not götürüyor': 'taking the note to Pyn',
  'Pyn\'e not veriyor': 'handing Pyn the note',
  'Patron, {kim} yeni not göndermiş!': 'Boss, {kim} sent a new note!',
  'onayı bekliyor': 'waiting for approval',
  'kargo kolilerini sayıyor': 'counting parcels',
  // melis
  'araçların kayıtlarına bakıyor': 'checking the tools\' logs',
  'Codex kabinine gidiyor': 'heading to the Codex rack',
  'Codex sunucusunu yeniden başlatıyor': 'restarting the Codex server',
  'kabloları topluyor': 'tidying the cables',
  'Kim yine sunucuya çay döktü?': 'Who spilled tea on the server again?',
  // husnu
  'çay köşesine gidiyor': 'heading to the tea corner',
  'çay demliyor': 'brewing tea',
  'Hüsnü amca çay dağıtıyor': 'Uncle Hüsnü is handing out tea',
  'çay dağıtıyor': 'handing out tea',
  'Çaylar taze!': 'Fresh tea!',
  'Sena\'ya çay veriyor': 'bringing Sena her tea',
  'Buyur evladım.': 'Here you go, dear.',
  'mutfağa dönüyor': 'heading back to the kitchen',
  'uyukluyor': 'dozing',
  // pyn ('Hmm.' is the same in English)
  'onay bekleyen notlara bakıyor': 'reviewing notes awaiting approval',
  'gözlerini dinlendiriyor': 'resting their eyes',
  'düşünüyor': 'thinking',
  // mudur
  'haftanın notlarını okuyor': 'reading the week\'s notes',
  'akvaryuma gidiyor': 'heading to the aquarium',
  'balıklara bakıyor': 'watching the fish',
  'Pyn\'in odasına gidiyor': 'heading to Pyn\'s office',
  'Pyn ile konuşuyor': 'talking with Pyn',
  'Bu haftaki notlar çok iyi.': 'This week\'s notes are great.',
  'yeni bir not yazıyor': 'writing a new note',
  // tolga
  'Cortex\'e yeni özellik yazıyor': 'building a new feature for Cortex',
  'sunucu odasına gidiyor': 'heading to the server room',
  'sunucunun kayıtlarını okuyor': 'reading the server\'s logs',
  'Bir hata daha yakaladım.': 'Caught another bug.',
  'testleri çalıştırıyor': 'running the tests',
  'çay almaya gidiyor': 'going for tea',
  'çay dolduruyor': 'pouring tea',
  'kodu gözden geçiriyor': 'reviewing the code',
  'Testler yeşil.': 'Tests are green.',
  // tekir
  'kanepede uyuyor': 'asleep on the sofa',
  'tüylerini temizliyor': 'grooming',

  // ── ofis-engine.js: what the engine itself writes
  'yürüyor': 'walking',
  'yerine dönüyor': 'heading back to the seat',
  'Baran ile buluşmaya gidiyor': 'going to meet Baran',
  'bekliyor': 'waiting',
  'Defne ve Baran «Proje planı» üzerine konuşuyor': 'Defne and Baran are talking about “Project plan”',
  'Melis: Codex\'in sunucusu yeniden ayağa kalktı': 'Melis: Codex\'s server is back up',
  'Pyn onayladı: «Toplantı notları»': 'Pyn approved: “Meeting notes”',
  'Yayında: «Toplantı notları»': 'Published: “Meeting notes”',
  'uyuyor': 'sleeping',
  'etrafa bakıyor': 'looking around',
  // already chosen by language in the engine (greet, who, nameTheManager): here for completeness
  '{Kim} ofise uğradı': '{Kim} dropped by the office',
  '{Kim} beynine göz attı': '{Kim} looked into the brain',
  'Hoş geldin, {kim}.': 'Welcome, {kim}.',
  'kasanın sahibi': 'the owner',
  // LIGHT_MODES and TOOL_LABEL (exported; the window uses its own i18n keys for these today)
  'Sabah': 'Morning',
  'Öğle': 'Noon',
  'Akşam': 'Evening',
  'Gece': 'Night',
  'giriş yapıldı': 'signed in',
  'giriş bekliyor': 'awaiting sign-in',
  'kurulu değil': 'not installed',

  // ── office-art.js CHARACTERS: names that change, roles (as roleEn), card labels
  'Hüsnü amca': 'Uncle Hüsnü',
  'Müdür': 'Manager',
  'Patron': 'Boss',
  'Yazılımcı': 'Developer',
  'Kıdemli yazar': 'Senior writer',
  'Mühendis': 'Engineer',
  'Açık kaynakçı': 'Open-source tinkerer',
  'Araştırmacı': 'Researcher',
  'Çevirmen': 'Translator',
  'Stajyer': 'Intern',
  'Editör': 'Editor',
  'Arşivci': 'Archivist',
  'Haritacı': 'Cartographer',
  'Kurye': 'Courier',
  'Sistemci': 'Sysadmin',
  'Çaycı': 'Tea man',
  'Ofis kedisi': 'Office cat',
  'CORTEX · PATRON': 'CORTEX · BOSS',
  'CORTEX · MÜDÜR': 'CORTEX · MANAGER',
  'CORTEX · YAZILIMCI': 'CORTEX · DEVELOPER',
  'CORTEX · OFİS KEDİSİ': 'CORTEX · OFFICE CAT',
  'CORTEX · AJAN': 'CORTEX · AGENT',
  // office-art.js ROOM_DEFS (tr → their own en)
  'PYN\'İN ODASI': 'PYN\'S OFFICE',
  'HARİTA ODASI': 'MAP ROOM',
  'ARŞİV': 'ARCHIVE',
  'MÜDÜR ODASI': 'MANAGER\'S OFFICE',
  'YAZI İŞLERİ': 'NEWSROOM',
  'ÇAY OCAĞI': 'TEA ROOM',
  'TOPLANTI': 'MEETING ROOM',
  'SUNUCU ODASI': 'SERVER ROOM',
  'DİNLENME': 'LOUNGE',

  // ── office-art.js CHARACTERS[id].bio (the same text as BIO_EN, so enOf(card.bio) works too)
  ...Object.fromEntries(Object.values(BIOS)),
};

/**
 * The sentences ofis-engine.js builds at run time, as [Turkish regex, (match) => English]:
 * a name or a note title put into a fixed frame. Tried in order, after EN.
 */
export const EN_PATTERNS = [
  // updateMeets (log): 'Defne ve Baran «…» üzerine konuşuyor', with any two names and title.
  [/^(.+) ve (.+) «(.+)» üzerine konuşuyor$/u, (m) => `${nameEn(m[1])} and ${nameEn(m[2])} are talking about ${titled(m[3])}`],
  // updateMeets (act): (a === 'defne' ? 'Baran' : 'Defne') + ' ile «Proje planı» üzerine konuşuyor'.
  [/^(.+) ile «(.+)» üzerine konuşuyor$/u, (m) => `talking with ${nameEn(m[1])} about ${titled(m[2])}`],
  // joinMeet (act): 'Baran ile buluşmaya gidiyor'.replace('Baran', …) → 'Defne ile buluşmaya gidiyor'.
  [/^(.+) ile buluşmaya gidiyor$/u, (m) => `going to meet ${nameEn(m[1])}`],
  // who() has put the name in ({Kim} / {kim}): Umut's log line and bubble.
  [/^(.+) gelen kutusuna yeni not attı: «(.+)»$/u, (m) => `${nameEn(m[1])} dropped a new note in the inbox: ${titled(m[2])}`],
  [/^Patron, (.+) yeni not göndermiş!$/u, (m) => `Boss, ${nameEn(m[1])} sent a new note!`],
  // greet(), after who() (the engine already writes these in English when lang is 'en').
  [/^(.+) ofise uğradı$/u, (m) => `${nameEn(m[1])} dropped by the office`],
  [/^(.+) beynine göz attı$/u, (m) => `${nameEn(m[1])} looked into the brain`],
  [/^Hoş geldin, (.+)\.$/u, (m) => `Welcome, ${nameEn(m[1])}.`],
  // Log lines that carry a note title, with any title in «…».
  [/^Pyn onayladı: «(.+)»$/u, (m) => `Pyn approved: ${titled(m[1])}`],
  [/^Yayında: «(.+)»$/u, (m) => `Published: ${titled(m[1])}`],
  [/^Kaan makbuzu arşive kaldırdı: «(.+)»$/u, (m) => `Kaan filed the receipt in the archive: ${titled(m[1])}`],
  // nameTheManager: possessive(name, 'tr').toLocaleUpperCase('tr') + ' ODASI' ("AYŞE'NİN ODASI").
  // The room's own .en (built beside it) is the better source; this is for a Turkish name that got through.
  [/^(.+)'N?[IİUÜ]N ODASI$/u, (m) => m[1] + (/S$/i.test(m[1]) ? '\'' : '\'S') + ' OFFICE'],
];

/** The office's Turkish text in English: the exact string, else a built sentence, else the text as it came. */
export function enOf(text) {
  if (typeof text !== 'string' || !text) return text;
  if (Object.prototype.hasOwnProperty.call(EN, text)) return EN[text];
  for (const [pattern, english] of EN_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return english(m);
  }
  return text;
}
