# Kaynak: Krewgent'tan taşınanlar

Not ekranı GunduzTolga/Krewgent'ta yazıldı ve test edildi; bu klasördeki kopyası oradan taşındı. Bu dosya, iki taraf sonra karşılaştırılabilsin diye her dosyanın nereden geldiğini söyler.

- **Depo:** `GunduzTolga/Krewgent`
- **Dal:** `claude/knkam-openhuman-review-cpb16v`
- **Commit:** `472d328c5a78d0b90edcb5e65be1d5ba2dc9a030` (14 Ekim 2026)
- **Blob:** Krewgent'taki dosyanın o commit'teki git blob kimliği (ilk 12 hane). Krewgent'ta `git rev-parse 472d328:<yol>` aynı değeri verir; dosya orada değiştiyse kimlik de değişir.

Bir kural iki tarafta da yaşıyor: burada bir kural değişirse Krewgent'ta da değişmesi gerekir, ya da tersi. En çok `core/vaultNotes.ts` ve `electron/services/vaultNotes.ts` için geçerli; ikisinin kodu Krewgent'takiyle aynı tutuldu.

## Karşılaştırma

Çekirdek dosyayı Krewgent'takiyle karşılaştırmak için (iki depo yan yana klonlanmışsa):

```sh
diff <(sed -n '/^export function splitProperties/,$p' ../Krewgent/core/vaultNotes.ts) \
     <(sed -n '/^export function splitProperties/,$p' desktop/core/vaultNotes.ts)
```

Not ekranı dosyalarında **Y** şu standart yeniden adlandırmalar demek, başka bir şey değil:

- İçe aktarma yolları: `src/cortex/notes/` → `src/notes/`, `src/library/components/ui` → `src/ui/ui`, `src/shell/useEscapeLayer` → `src/ui/useEscapeLayer`, `src/library/store/app` → `src/store/app`
- Pencere köprüsü: `window.krewgent` → `window.cortex`
- Mağaza: `useLibrary` → `useApp`
- Pencere deposu anahtarları: `krewgent.` öneki → `cortex.` (sekmeler, kıvrımlar, grafik ayarları; Krewgent'ta açık kalan sekmeler buraya taşınmaz)

## Dosyalar

| Burada (`desktop/`) | Krewgent'ta | Blob | Ne değişti |
| --- | --- | --- | --- |
| `core/vaultNotes.ts` | `core/vaultNotes.ts` | `209db54c91ee` | Kod aynen; yalnız dosya başı yorumu bu uygulamaya göre. |
| `core/titles.ts` | `core/titles.ts` | `8263ed90018e` | Kod aynen; dosya başı yorumu kısaltıldı (Krewgent'ın ekip/günlük örnekleri çıktı). |
| `shared/notes.ts` | `shared/notes.ts` | `3a310d2582bf` | `NoteRead.readOnly` içinden `'hermes'` çıktı; `VaultIndex.readOnly` duruyor, burada hep `null`. |
| `shared/ipcError.ts` | `shared/ipcError.ts` | `255d06917f24` | `plainIpcMessage`, `messageOf`, `rejectionText` aynen; kullanılmayan `plainReason` alınmadı. |
| `shared/language.ts` | `shared/language.ts` | `a1b161522c0b` | Kod aynen, yorum kısaltıldı. |
| `shared/api.ts` | `shared/api.ts` | `2ec7c60ff66d` | Sadeleştirilerek yeniden yazıldı: `KrewgentApi` yerine `CortexApi`; `notes` (12 çağrı) aynı imzayla, `on.notesChanged`, yanında `bootstrap`, `settings.set` (yalnız dil), `vault.status/choose`. |
| `electron/services/vaultNotes.ts` | `electron/services/vaultNotes.ts` | `436bf0728dbb` | Kasa yolu `readState().cortexVault` yerine uygulamanın ayar dosyasından (`readSettings().vault`). Hermes yazma reddi (`hermesRoots`, `writeRefusal`) çıktı. Hata cümlelerinde kasanın tam yolu yerine adı. Geri kalanı (yol kuralları, hash'e göre kayıt, geçici dosya, exclusive oluşturma, `relink`, `retitle`, çöp kutusu, izleyici) aynen. |
| `electron/ipc.ts` | `electron/ipc.ts` | `4c16218f97d1` | Yalnız 12 `notes:*` kanalı ve kasa seçimi alındı (gövdeler aynı). Her kanal `handle()` ile sarılı: yalnız uygulamanın kendi sayfası, ana çerçevesinden çağırabilir. `cortex:chooseVault` → `vault:choose`. |
| `electron/preload.ts` | `electron/preload.ts` | `bbaa43da56c2` | `notes` köprüsü aynen; `window.krewgent` → `window.cortex`. Preload artık sandbox içinde çalışıyor (Krewgent'ta `sandbox: false`). |
| `electron/main.ts` | `electron/main.ts` | `a419ac816c23` | Yeniden yazıldı; korunanlar: tek örnek kilidi, gizli/offscreen çizim (`KREWGENT_HIDDEN` → `CORTEX_HIDDEN`), `will-navigate` köken karşılaştırması, yeni pencere reddi. Eklenenler: `sandbox: true`, izin istekleri reddi, ağ isteklerinin oturumda kesilmesi, webview reddi. |
| `electron/services/vault.ts` | `electron/services/cortex.ts` | `bfd2cfdc9c39` | `setCortexVault` ve `ownDataTouchedBy` (`electron/services/ownData.ts`) sadeleştirildi; Krewgent'ın üç kod klasörü alınmadı. Pencereye kasanın yalnız adı gider (Krewgent yolu da gönderiyordu). |
| `electron/services/settings.ts` | `electron/services/store.ts` | `028f28c51b59` | Krewgent durum dosyasının yerine uygulamanın kendi `settings.json`'ı; kuralları (yalnız eksik dosya ilk açılış, bozuk dosya `.corrupt-<zaman>` olarak kenara, okunamayan dosyanın üstüne yazılmaz, geçici + yeniden adlandırma, Windows'ta meşgul dosyada yeniden deneme) aynen. |
| `src/notes/GraphView.tsx` | `src/cortex/notes/GraphView.tsx` | `2f6e626bf6e5` | Y. |
| `src/notes/NoteEditor.tsx` | `src/cortex/notes/NoteEditor.tsx` | `43f0bcc880e9` | Yalnız içe aktarma yolları. |
| `src/notes/NoteMarkdown.tsx` | `src/cortex/notes/NoteMarkdown.tsx` | `801c7acae1f4` | Y. |
| `src/notes/NotePane.tsx` | `src/cortex/notes/NotePane.tsx` | `226eabcfc731` | Y; Hermes salt-okunur cümlesi yerine `notes.readOnly.vault`. |
| `src/notes/NoteSidebar.tsx` | `src/cortex/notes/NoteSidebar.tsx` | `290bc07b0d38` | Y. |
| `src/notes/NotesMenus.tsx` | `src/cortex/notes/NotesMenus.tsx` | `643717780de0` | Yalnız içe aktarma yolları. |
| `src/notes/NotesNav.tsx` | `src/cortex/notes/NotesNav.tsx` | `3165255d798f` | Y. |
| `src/notes/NotesView.tsx` | `src/cortex/notes/NotesView.tsx` | `b67dd23bc587` | Y. |
| `src/notes/QuickSwitcher.tsx` | `src/cortex/notes/QuickSwitcher.tsx` | `7f6e94c22746` | Y. |
| `src/notes/livePreview.ts` | `src/cortex/notes/livePreview.ts` | `1866ce2e6c75` | Yalnız içe aktarma yolları. |
| `src/notes/notes.css` | `src/cortex/notes/notes.css` | `f35ecf78b5f4` | Aynen. |
| `src/notes/notesStore.ts` | `src/cortex/notes/notesStore.ts` | `c7863976663b` | Y. |
| `src/notes/peek.tsx` | `src/cortex/notes/peek.tsx` | `9bb55eb2aac6` | Yalnız içe aktarma yolları. |
| `src/notes/remarkObsidian.ts` | `src/cortex/notes/remarkObsidian.ts` | `70c0cbb3dffb` | Yalnız içe aktarma yolları. |
| `src/notes/templates.tsx` | `src/cortex/notes/templates.tsx` | `11fcff5193ef` | Y. |
| `src/notes/vaultCache.ts` | `src/cortex/notes/vaultCache.ts` | `9faea64e4ac8` | Y. |
| `src/i18n/en.ts` | `src/i18n/en.ts` | `6b2c66dc24be` | Yalnız `notes.*` anahtarları (143), değerleri aynen; `notes.readOnly.hermes` yerine `notes.readOnly.vault`; uygulamanın kendi `app.*`/`welcome.*` anahtarları eklendi. |
| `src/i18n/tr.ts` | `src/i18n/tr.ts` | `676097403391` | `en.ts` ile aynı. |
| `src/i18n/index.ts` | `src/i18n/index.ts` | `59ae139eb9d3` | Sadeleştirildi: `translate`, `LANGUAGES`, `DEFAULT_LANGUAGE`. |
| `src/i18n/useT.ts` | `src/i18n/useT.ts` | `bb8529ba45c4` | Sadeleştirildi: dil, Krewgent kitaplık mağazası yerine uygulamanın mağazasından (`useApp`). |
| `src/ui/ui.tsx` | `src/library/components/ui.tsx` | `9baf43ca260b` | Not ekranının kullandığı dördü (`Button`, `Modal`, `inputClass`, `Spinner`) alındı. |
| `src/ui/Toasts.tsx` | `src/library/components/Toasts.tsx` | `75cc6fb8450e` | Eylem düğmesi çıktı (not ekranı kullanmıyor). |
| `src/ui/escapeLayers.ts` | `src/shell/escapeLayers.ts` | `95d9ae874757` | Kod aynen; dosya başı yorumu kısaltıldı. |
| `src/ui/useEscapeLayer.ts` | `src/shell/useEscapeLayer.ts` | `e964fce3eca2` | Aynen. |
| `src/store/app.ts` | `src/library/store/app.ts` | `514d35d4890e` | Yeniden yazıldı: yalnız hazır olma, dil, kasa adı ve bildirimler (`toast`). |
| `src/App.tsx` | `src/cortex/CortexSide.tsx` | `c14950fc9c25` | Notlar ve Grafik görünümü aynı düzenle; Pyn terminali ve Cortex kurulum geçişi alınmadı (Aşama 2 ve 3). İlk açılış ekranı yeni. |
| `src/index.css` | `src/index.css` | `9a3d2c8f8ce4` | Renk paleti (Ananas'ın kâğıt ve mürekkebi), `below-titlebar`, `animate-rise`, `kg-press`, `kg-sheet`, `kg-layer` alındı; yazı tipleri henüz gelmiyor (Aşama 4). |
| `index.html` | `index.html` | `701b19fa6647` | CSP daha sıkı: `default-src 'none'`, `connect-src 'self'`, `img-src 'self' data:`. |
| `vite.config.ts` | `vite.config.ts` | `69513da4e370` | Geliştirme portu 5274 (Krewgent 5273). |
| `tests/vaultNotes.test.ts` | `tests/vaultNotes.test.ts` | `508e833903ee` | Aynen. |
| `tests/vaultNotesService.test.ts` | `tests/vaultNotesService.test.ts` | `ef2f1e7203b8` | Kasa, durum dosyası yerine ayar dosyasıyla veriliyor; Hermes testi alınmadı. |
| `tests/vaultNotesBoundary.test.ts` | `tests/vaultNotesBoundary.test.ts` | `64b8c59bec69` | Sınır aynı (yalnız `electron/ipc.ts`); ajan/işçi klasörleri olmadığından üçüncü test yerine pencerenin node/electron içe aktarmadığı denetleniyor. |
| `tests/escapeLayers.test.ts` | `tests/escapeLayers.test.ts` | `cc946051848d` | Yol `src/ui/`; Krewgent'ın açılış filmi istisnası çıktı. |
| `tests/ipcError.test.ts` | `tests/ipcError.test.ts` | `e8c1bd5e319e` | Aynen. |
| `tests/titles.test.ts` | `tests/titles.test.ts` | `fc57c7e72e8c` | Günlük (journal) testleri alınmadı. |
| `tests/electron-stub.mjs` | `tests/electron-stub.mjs` | `9285ffc46e7d` | Sadeleştirildi; kanal işleyicileri ve klasör seçme penceresinin cevabı testlere açık. |
| `e2e/smoke.mjs` | `e2e/smoke.mjs` | `9edf998f8a52` | Notlar bölümü aynı adımlarla; kasa bu reponun `template/` klasöründen kuruluyor. İlk açılış, dil, pencere güvenliği ve yeniden açılış bölümleri yeni. |
| `scripts/build-main.mjs` | `scripts/build-main.mjs` | `78874d5ecd42` | `pdfjs-dist` ve `node-pty` dışarıda bırakılmıyor (yoklar). |
| `scripts/build.mjs` | `scripts/build.mjs` | `38f09c8f179e` | Aynen. |
| `scripts/dev.mjs` | `scripts/dev.mjs` | `29425e21df10` | Port Vite yapılandırmasından okunuyor. |
| `scripts/test.mjs` | `scripts/test.mjs` | `d78fc8c9eccb` | Yalnız `@shared/` takma adı. |
| `scripts/e2e.mjs` | `scripts/e2e.mjs` | `356f35f9fa66` | `KREWGENT_HIDDEN/SHOW` → `CORTEX_HIDDEN/SHOW`. |

## Alınmayanlar

- **Hermes:** `electron/services/hermesRoots.ts` ve ona bağlı yazma reddi. Bu uygulamada Hermes yok.
- **Krewgent durum dosyası** (`electron/services/store.ts` ve `readState`): yerine uygulamanın kendi `settings.json`'ı (`electron/services/settings.ts`).
- **Ekip, CLI, ajan ve kod tarafı:** `core/agents/`, `electron/agents/`, `electron/workers/`, `src/krewgent/`, `src/agentLab/`, Krewgent'ın üç Cortex Code klasörü.
- **Pyn terminali ve Cortex kurulumu:** Aşama 2 ve 3'te gelecek (`desktop/README.md`).
- **Krewgent'ın görünüm katmanı:** The Delegation'dan gelen ekranlar, açılış filmi, kilit ekranı; Fraunces ve diğer yazı tipleri (Aşama 4).
