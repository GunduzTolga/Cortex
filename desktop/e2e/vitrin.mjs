import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * The README's pictures (docs/gorseller/), taken from the real app as the smoke run takes its own
 * (e2e/smoke.mjs): the built app in a real Electron process, the window never shown (CORTEX_HIDDEN=1),
 * drawn offscreen and photographed with `capturePage`. Nothing appears on the screen of whoever runs it.
 *
 * What differs is what it shows: the Turkish interface, a vault with a small product launch in it
 * written in Turkish, and none of the test's own words. The chat and Beyin's live talk are answered by
 * a stand-in for LM Studio's server with a written answer, as the smoke run's are; the rest is the app.
 *
 *   npm run build && node e2e/vitrin.mjs
 */
const out = path.resolve('..', 'docs', 'gorseller');
fs.mkdirSync(out, { recursive: true });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-vitrin-'));
const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-vitrin-kasa-')));
const vaultDir = path.join(parent, 'Beynim');
const enginePackages = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-vitrin-paket-'));
fs.writeFileSync(path.join(enginePackages, 'beyin-v3-1.0.25.zip'), '');
const vaultNote = (relative) => path.join(vaultDir, ...relative.split('/'));
const write = (relative, text) => {
  fs.mkdirSync(path.dirname(vaultNote(relative)), { recursive: true });
  fs.writeFileSync(vaultNote(relative), text);
};

/* The vault: Cortex's template, and a week of a small product launch in it. */
fs.cpSync(path.resolve('..', 'template'), vaultDir, { recursive: true });
const project = '🏰 300-Projects/Cortex lansmanı';
const knowledge = '🧠 500-Knowledge';
write(`${project}/Lansman planı.md`, `---
tags: [proje, lansman]
durum: sürüyor
hedef: 2026-10-24
---
# Lansman planı

Cortex 1.0.25'in herkese açık duyurusu. Hedef: yöneticilerin indirip on dakikada kurabilmesi.

## Bu hafta

- [x] README'yi baştan yaz
- [x] [[Fiyatlandırma kararı]]: ilk sürüm ücretsiz
- [ ] [[LinkedIn duyurusu]]: [[Ayşe Yılmaz]] onaylayacak
- [ ] [[Demo videosu]]: 90 saniye, cuma
- [ ] [[Ekran görüntüleri]]: Türkçe arayüzden dört görüntü

## Riskler

> [!warning] Kurulum dosyası imzasız
> Sertifika gelene kadar SmartScreen uyarısı çıkacak; duyuruda nasıl geçileceği yazılı olmalı.

Toplantı: [[Toplantı 2026-10-16]] · Rakipler: [[Rakip analizi]]
`);
write(`${project}/LinkedIn duyurusu.md`, `---
tags: [lansman, metin]
---
# LinkedIn duyurusu

Yapay zeka asistanları oturum kapanınca unutuyor. Cortex, notlarınızı kendi bilgisayarınızda tutup Claude Code, Codex ve yerel modellere ortak bir hafıza veriyor.

- Terminal gerektirmeden kurulum
- "Hey Pyn" ile not
- Telemetri yok

Görseller: [[Ekran görüntüleri]] · Video: [[Demo videosu]]
`);
write(`${project}/Demo videosu.md`, `# Demo videosu

90 saniye: kurulum, ilk sohbet, "Hey Pyn" ile not, Beyin ekranı.

Senaryo [[Mert Demir]]'de. Plan: [[Lansman planı]]
`);
write(`${project}/Ekran görüntüleri.md`, `# Ekran görüntüleri

Pyn sohbeti, notlar, grafik ve Beyin. Duyuru: [[LinkedIn duyurusu]]
`);
write(`${project}/Toplantı 2026-10-16.md`, `---
tags: [toplantı]
---
# Toplantı 2026-10-16

Katılanlar: [[Ayşe Yılmaz]], [[Mert Demir]]

- [[Fiyatlandırma kararı]] verildi.
- [[Demo videosu]] cumaya.
- [[Yerel modeller]] bölümü README'de öne çıkacak.
`);
write(`${knowledge}/Ürün/Fiyatlandırma kararı.md`, `---
tags: [karar]
tarih: 2026-10-16
---
# Fiyatlandırma kararı

**Karar:** ilk sürüm ücretsiz ve açık kaynak (MIT). Gerekçe: güven ve yayılma önce gelir. Bkz. [[Rakip analizi]].
`);
write(`${knowledge}/Ürün/Rakip analizi.md`, `# Rakip analizi

Bulut tabanlı hafıza ürünleri notları sunucuda tutuyor. Cortex'in farkı: yerel, Markdown, araçtan bağımsız. [[Yerel modeller]]
`);
write(`${knowledge}/Yapay zeka/Yerel modeller.md`, `---
tags: [yapay-zeka]
---
# Yerel modeller

[[LM Studio]] ve [[Ollama]] ile model bilgisayarda çalışır; Cortex hafızayı kasanın hook'undan verir.
`);
write(`${knowledge}/Yapay zeka/LM Studio.md`, `# LM Studio

Modeli yükle, sunucuyu başlat; Cortex doğrudan konuşur. [[Yerel modeller]]
`);
write(`${knowledge}/Yapay zeka/Ollama.md`, `# Ollama

Komut satırından model; Cortex 127.0.0.1 üzerinden sorar. [[Yerel modeller]]
`);
write('notes/kisiler/Ayşe Yılmaz.md', `---
kind: person
aliases: [Ayşe]
---
# Ayşe Yılmaz

Pazarlama direktörü. [[LinkedIn duyurusu]] onayı onda.
`);
write('notes/kisiler/Mert Demir.md', `---
kind: person
---
# Mert Demir

Video ve tasarım. [[Demo videosu]]
`);
write('📥 000-Inbox/Yakala/2026-10-17-yerel-modellerle-calismak.md', `---
tur: yakala
durum: bekliyor
kaynak_turu: youtube
---
# Yerel modellerle çalışmak

## Neden

[[Yerel modeller]] bölümü için örnek.
`);

/* LM Studio's server, stood in for: its model list, the chat's answer and Beyin's live talk. */
const answer = [
  'Lansman planına ve dünkü toplantı notuna baktım. Bu hafta üç iş kaldı:\n\n',
  '1. **LinkedIn duyurusu**: taslak hazır, Ayşe\'nin onayı bekleniyor ([[LinkedIn duyurusu]]).\n',
  '2. **Demo videosu**: 90 saniyelik kurgu cumaya ([[Demo videosu]]).\n',
  '3. **Ekran görüntüleri**: README için Türkçe arayüzden dört görüntü ([[Ekran görüntüleri]]).\n\n',
  'Fiyatlandırma kararı 16 Ekim\'de verildi: ilk sürüm ücretsiz ([[Fiyatlandırma kararı]]). ',
  'İstersen duyuru metnini birlikte son haline getirelim.',
];
const scene = { lines: [
  { who: 'Defne', text: 'Lansman planında üç iş kaldı, en acili LinkedIn duyurusu.' },
  { who: 'Baran', text: 'Demo videosunun senaryosu Mert\'te, cuma yetişir.' },
  { who: 'Pyn', text: 'Ayşe onaylarsa pazartesi yayındayız.' },
] };
const model = 'qwen3.5-9b';
const lmStudio = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    if (request.url === '/api/v0/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: model, type: 'llm', state: 'loaded', loaded_context_length: 32768 }] }));
    } else if (request.url === '/v1/chat/completions' && JSON.parse(body).stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scene) } }] }));
    } else if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const content of answer) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
});
await new Promise((done) => lmStudio.listen(0, '127.0.0.1', done));

/* The vault's engine, stood in for in the settings: voice typing installed, its commands and wake phrase. */
const voiceStandIn = String.raw`
import json, sys
args = sys.argv[1:]
commands = {'kaydet': ['kaydet'], 'resim_ekle': ['resmi ekle', 'panodaki resmi ekle'], 'sil': ['sil', 'temizle', 'hepsini sil'],
            'kelime_sil': ['son kelimeyi sil'], 'cumle_sil': ['son cümleyi sil'], 'iptal': ['iptal', 'vazgeç']}
if args[:2] == ['yakala', 'durum']:
    print(json.dumps({'status': 'tamam', 'kurulu': True}))
elif args[:1] == ['ses']:
    print(json.dumps({'kurulu': True, 'acik': True, 'uyandirma': True, 'otomatik_dinle': True, 'motor': 'vulkan',
                      'model': 'large-v3-turbo (ekran kartı, Vulkan)', 'komutlar': commands, 'adla_kaydet': ['gönder', 'tamam'],
                      'uyandirma_sozu': 'ikisi'}, ensure_ascii=False))
else:
    sys.exit(2)
`;

const software = process.platform === 'linux' || process.env.CORTEX_SOFTWARE === '1';
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(software ? ['--disable-gpu'] : [])],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_ENV: 'production',
    CORTEX_HIDDEN: '1',
    CORTEX_TEST_LMSTUDIO: `http://127.0.0.1:${lmStudio.address().port}`,
    CORTEX_TEST_OLLAMA: 'http://127.0.0.1:9',
    CORTEX_ENGINE_PACKAGES: enginePackages,
  },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
// A late morning on a weekday: Beyin's light and clock follow the hour, and a night shift is dark.
await page.clock.setFixedTime(new Date('2026-10-16T11:20:00'));
// No browser is opened from a run.
await app.evaluate(({ shell }) => {
  shell.openExternal = async () => {};
});
const wait = (locator, timeout = 15_000) => locator.first().waitFor({ timeout });
const taken = [];
async function shoot(name) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(out, name), Buffer.from(png, 'base64'));
  taken.push(name);
  console.log('  ' + name);
}

try {
  // The first-run screen, in Turkish: the name, then the vault.
  await wait(page.locator('[data-onboarding-step="name"]'), 30_000);
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, vaultDir);
  await page.locator('[data-onboarding-name]').fill('Tolga');
  await page.locator('[data-onboarding-name-chip="Tolga Bey"]').click();
  await page.locator('[data-onboarding-next]').click();
  await wait(page.locator('[data-onboarding-step="vault"]'));
  await page.locator('[data-welcome-choose]').click();
  await wait(page.locator('[data-onboarding-ready]'));
  await page.waitForTimeout(300);
  await shoot('ilk-kurulum.png');
  await page.locator('[data-onboarding-next]').click();
  for (let step = 0; step < 6 && !(await page.locator('[data-onboarding-step="done"]').count()); step += 1) {
    const skip = page.locator('[data-onboarding-skip]');
    await ((await skip.count()) ? skip : page.locator('[data-onboarding-next]')).first().click();
    await page.waitForTimeout(400);
  }
  await wait(page.locator('[data-onboarding-finish]'));
  await page.locator('[data-onboarding-finish]').click();
  await wait(page.locator('[data-chat-view]'));
  // This engine listens all the time, set up before Cortex asked: the app asks first, and is allowed, as a person would.
  const allow = page.locator('[data-consent="wakeFound"]');
  if (await allow.waitFor({ timeout: 8_000 }).then(() => true, () => false)) await page.locator('[data-consent-yes]').click();

  // Pyn: a question to the model loaded in LM Studio, the notes it names as links.
  await page.locator('[data-chat-chip="cli"]').click();
  await page.locator('[data-chat-choice="lmstudio"]').click();
  await page.locator('[data-chat-input]').fill('Lansman için bu hafta neler kaldı?');
  await page.keyboard.press('Enter');
  await wait(page.locator('[data-chat-text]', { hasText: 'son haline getirelim' }));
  await page.waitForTimeout(600);
  await shoot('pyn.png');

  // Notes: the launch plan, read, with what links to it.
  await page.locator('[data-app-view="notes"]').click();
  const notes = page.locator('[data-notes-view]');
  await wait(notes.locator('[data-tree-path="🏰 300-Projects"]'));
  await notes.locator('[data-tree-path="🏰 300-Projects"]').click();
  await notes.locator(`[data-tree-path="${project}"]`).click();
  await notes.locator(`[data-tree-path="${project}/Lansman planı.md"]`).click();
  await wait(notes.locator('[data-note-reader] [data-callout="warning"]'));
  await page.mouse.move(2, 400);
  await page.waitForTimeout(500);
  await shoot('notlar.png');

  // The graph of the vault's notes.
  await page.locator('[data-app-view="graph"]').click();
  await page.waitForTimeout(800);
  // The template's starter files link nowhere yet: the launch's notes alone.
  await page.locator('[data-notes-graph="vault"] [data-graph-toggle="orphans"]').click();
  await page.waitForTimeout(3_000);
  await shoot('grafik.png');

  // Beyin: the office inside the brain, the team talking about the notes.
  await page.locator('[data-app-view="office"]').click();
  await wait(page.locator('[data-office-view] [data-ofis-canvas]'));
  await page.locator('[data-ofis-gear]').click();
  await page.locator('[data-ofis-live]').click();
  await page.locator('[data-ofis-tool="lmstudio"]').click();
  await wait(page.locator(`[data-ofis-model="${model}"]`));
  await page.locator(`[data-ofis-model="${model}"]`).click();
  await page.locator('[data-ofis-talk]').click();
  await wait(page.locator('[data-ofis-line]', { hasText: 'LinkedIn duyurusu' }), 20_000);
  await page.locator('[data-ofis-gear]').click();
  await page.waitForTimeout(1_800);
  await shoot('beyin.png');

  // Settings → voice typing: the wake phrase and the spoken commands.
  if (process.platform === 'win32' && (await page.evaluate(() => window.cortex.setup.status())).python) {
    fs.writeFileSync(vaultNote('beyin.py'), voiceStandIn);
    fs.writeFileSync(vaultNote('.beyin-version'), '1.0.25\n');
    await page.keyboard.press('Control+,');
    const phrase = page.locator('[data-setup-voice-phrase="ikisi"]');
    await wait(phrase, 20_000);
    await phrase.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot('ayarlar-ses.png');
    await page.keyboard.press('Escape');
  }
} finally {
  await app.close();
  lmStudio.close();
  for (const folder of [userData, parent, enginePackages]) fs.rmSync(folder, { recursive: true, force: true });
}
console.log(`${taken.length} pictures in ${path.relative(process.cwd(), out)}`);
