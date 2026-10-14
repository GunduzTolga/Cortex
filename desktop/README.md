# Cortex masaüstü uygulaması

Cortex'in Windows masaüstü uygulaması. Kasanı Obsidian'a gerek kalmadan okur ve yazar. Sonraki aşamalarda Pyn'i kasada açacak ve Cortex'i kendisi kuracak.

Bu klasör **Aşama 1**: kasayı seçtiren ve notları Obsidian gibi okuyup yazan uygulama. Motor (`beyin.py`, `template/`, `scripts/`) bu iş için değişmedi. Uygulama motoru sonraki aşamalarda her istemci gibi komut satırından çağıracak.

## Ne yapar

- **İlk açılış:** Kasa seçilmemişse kasa seçme ekranıyla açılır. Klasör, sistemin kendi klasör seçme penceresiyle seçilir. Uygulama sonraki açılışlarda aynı kasayla açılır.
- **Dil:** Türkçe varsayılan. İngilizce üst çubuktan ya da ilk ekrandan seçilir; seçim kalıcıdır.
- **Notlar:** Krewgent'ta yazılıp test edilen not ekranı ([KAYNAK.md](KAYNAK.md)):
  - dosya ağacı (sürükle-bırakla taşıma), sekmeler, ileri/geri
  - okuma görünümü: wiki linkleri, gömmeler, callout'lar, özellikler, görevler; bir linkin üstüne gelince notu gösterir
  - CodeMirror düzenleyici: Obsidian'ın canlı önizlemesi, bir tuşla kaynak modu
  - geri bağlantılar, ana hat, arama, hızlı geçiş (Ctrl+O), grafik
  - şablonlar (`📋 Templates/Note.md`) ve Cortex'in gelen kutusuna hızlı not (Ctrl+Shift+N, `📥 000-Inbox/Dump`)
  - yeniden adlandırmada notun başlığı (`title:` ve ilk başlık) yeni adı izler
  - Markdown olmayan metin dosyaları (JSON, betik, ayar) satır numaralı ve salt okunur gösterilir; JSON renklidir
  - çöp kutusu: silinen not, dosya ve klasör kasanın `.trash/` klasörüne gider; bildirimdeki "Geri al" ya da sol sütundaki Çöp kutusu sekmesiyle geri gelir
- **Cortex'in tuttukları:** Makbuzlar (`receipts/`) dosya adındaki hash yerine içlerindeki `event_id` ile gösterilir; motor onları bu hash'le bulduğu için dosya adı değişmez. Makbuzlar ve motorun ürettiği sayfalar (`generated: true`: `daily/v3`, `knowledge/v3/outcomes`) salt okunurdur: kaydedilmez, taşınmaz, yeniden adlandırılmaz, çöpe atılmaz. Grafikte makbuzlar "Makbuzlar" düğmesiyle açılır.
- **Dosya biçimi değişmez:** Notlar düz Markdown kalır. Obsidian aynı kasada yanında açık durabilir. Diskte değişen not ekrana yeniden okunur.

### Kasaya nasıl dokunur

Bu kuralların her biri Krewgent'ta bir hatanın bedeli. Hepsi testlerle tutuluyor.

- Pencere hiçbir zaman mutlak yol söylemez ve duymaz: kasanın yalnız adını ve içindeki göreli yolları bilir. Kasa ana süreçte seçilir ve gerçek yoluyla saklanır.
- Her yol hem yazıldığı hâliyle hem çözülmüş (realpath) hâliyle kasanın içinde tutulur. Hiçbir link (symlink ya da junction) izlenmez.
- Gizli kısımlar (`.obsidian`, `.git`, `.claude`, nokta ile başlayan her şey) ne gösterilir ne okunur ne yazılır.
- Kayıt, okunan sürümün hash'ine göre yapılır. Not geçici bir dosyaya yazılır, sonra yerine taşınır. Arada diskte değişen not geri verilir ve ekran bunu söyler. Değişen notun üstüne asla yazılmaz; hangisinin kalacağını sen seçersin.
- Yeni not yalnız o adda dosya yoksa oluşturulur.
- Taşıma ve yeniden adlandırmada yalnız dosyasını kaybedecek linkler yeniden yazılır. Her bağlantılı not az önce okunan hâline göre tutulur. Yeniden yazılamayan link söylenir.
- Silmek taşımaktır: silinen her şey kasanın `.trash/` klasörüne gider (Obsidian'ın kendi çöp klasörü), `.trash/.cortex.json` nereden geldiğini ve ne zaman silindiğini tutar. Geri yüklenen şey eski yerine döner; orası dolmuşsa yanına boş bir adla gelir, hiçbir şeyin üstüne yazılmaz. "Kalıcı olarak sil" ve "Çöpü boşalt" bile Windows Geri Dönüşüm Kutusu'na gönderir: uygulama hiçbir şeyi gerçekten silmez. `.trash` uygulamanın yazdığı tek gizli klasördür; indeks, arama ve linkler onu görmez, motorun senkronu da gizli klasörleri okumaz.
- Bir dosya kendi programıyla açılmaz: klasöründe gösterilir ya da Obsidian'da açılır. Kasadaki bir betik çift tıklamayla çalışmaz.
- UTF-8 olmayan dosya gösterilir ama kaydedilmez.

### Güvenlik ve gizlilik

- Pencere yalıtılmıştır: `contextIsolation`, `sandbox`, `nodeIntegration` kapalı, webview yok. Pencere yalnız `window.cortex` köprüsündeki kanalları çağırabilir. Ana süreç her çağrının uygulamanın kendi sayfasından geldiğini denetler.
- Pencere ağa çıkmaz. Sıkı bir CSP var (`default-src 'none'`); ağdan resim yüklenmez. Oturum, uygulamanın kendi dosyaları dışındaki her isteği keser.
- Her izin isteği (kamera, mikrofon, bildirim, konum…) sorulmadan reddedilir. Yeni pencere ve sayfadan uzaklaşma engellidir.
- Notun içindeki `https://` bağlantısına tıklarsan bağlantı sistemin tarayıcısında açılır, uygulamanın içinde açılmaz.
- Yazım denetimi sözlükleri Google'dan indirilmez.
- Telemetri yok, hesap yok, sürekli açık sunucu yok. Ayarlar (`settings.json`: kasanın yolu ve dil) uygulamanın kendi veri klasöründe durur (`%APPDATA%\Cortex`), kasada değil. Bu dosya okunamazsa üstüne yazılmaz; bozuksa yanına kopyalanır.

## Nasıl çalıştırılır

Node.js 22 gerekir.

```sh
cd desktop
npm install
npm run dev          # Vite + Electron, değişiklikte yeniden başlar
```

| Komut | Ne yapar |
| --- | --- |
| `npm run typecheck` | Üç TypeScript projesi: pencere, ana süreç, çekirdek tek başına |
| `npm test` | `node:test`; testler esbuild ile gerçek kaynaktan paketlenir (96 test; biri yalnız Windows'ta çalışır, başka yerde atlanır) |
| `npm run e2e` | Derler ve gerçek Electron uygulamasını Playwright ile sürer. Pencere hiç gösterilmez: ekran dışında çizilir, `capturePage` ile fotoğraflanır (`e2e/screenshots/`). Linux'ta Xvfb altında çalışır. `CORTEX_SHOW=1` pencereyi gösterir. |
| `npm run package` | Windows NSIS kurulum dosyası (`release/Cortex Setup X.Y.Z.exe`). Windows'ta çalıştır; Linux'ta son adım wine ister. |

CI: `.github/workflows/desktop.yml`. `desktop/`, `template/` ya da `tema/ananas/marka/` değiştiğinde Windows'ta çalışır: tip denetimi, testler, uçtan uca koşu, sonra kurulum dosyası. Kurulum dosyası bir hafta boyunca iş akışının çıktısı (`cortex-setup-windows`) olarak indirilebilir.

### Klasörler

```
core/       Obsidian'ın kuralları: ayrıştırma, link çözme, relink, arama, şablon (node yok, electron yok)
shared/     iki tarafın ortak tipleri: köprü (api.ts), notlar, dil
electron/   ana süreç: pencere, IPC kanalları, ayar dosyası, kasa seçimi, kasanın okuyucusu/yazıcısı
src/        pencere: React + Tailwind v4; not ekranı src/notes/
tests/      node:test, gerçek kaynak üzerinde
e2e/        Playwright _electron ile uçtan uca koşu
scripts/    derleme, geliştirme, test ve e2e betikleri
```

## Ne eksik

- **Pyn'in terminali (Aşama 2):** Kişinin kendi CLI'ı (Claude Code, Codex, OpenCode…) kasada açılacak; node-pty + xterm.
- **Cortex'i kurma ve güncelleme (Aşama 3):** Cortex'in kendi kurulumcusuyla. Windows'ta Python uygulamayla gelecek (PSF'nin NuGet paketi).
- **Ananas görünümü (Aşama 4):** Renkler şimdiden Ananas'ın kâğıt ve mürekkebi. Fraunces ve diğer yazı tipleri henüz uygulamayla gelmiyor; sistem yazı tipleri kullanılıyor. Yakala entegrasyonu ve Windows kurulumu için release iş akışı da bu aşamada.
- **İmza:** Kurulum dosyası imzasız. Windows SmartScreen ilk çalıştırmada uyarır.
- **Otomatik güncelleme yok.** Yeni sürüm elle kurulur.
- **Ana süreç cümleleri İngilizce:** Kaydı ya da taşımayı reddeden cümleler (örn. "Not a name a note can have") Krewgent'taki gibi İngilizce gösterilir. Ekranın kendi metinleri Türkçe.
- **Yazım denetimi:** Sözlükler Google'dan indirilmediği için Chromium'un Hunspell denetimi sözlüksüz kalır. Yazım yalnız platformun kendi denetleyicisinin kullanıldığı yerde denetlenir.
- **Linkler:** Obsidian'ın setext başlıkları, özellik değerindeki linkler ve aynı adlı iki notun Obsidian'ın kendi dizinine göre çözülmesi desteklenmiyor (`core/vaultNotes.ts` başında yazıyor).
- **macOS ve Linux:** Kod çalışır ama CI'da denenmiyor ve kurulum dosyası üretilmiyor.

## Sahibine sorulanlar

| Soru | Durum |
| --- | --- |
| Uygulamanın adı ve simgesi | **Cortex**, simgesi **Pyn'in mührü** (`tema/ananas/marka/pyn.ico`). Kopyalanmadı; oradan okunuyor. |
| Kasa git'i: commit'i uygulama mı atsın, sen mi? | Açık. Uygulama şu an git'e dokunmuyor; Obsidian Git yanında çalışmaya devam edebilir. |
| Tarayıcıdan "Beyne at": Web Clipper şablonu Obsidian ister, yerine ne gelsin? | Açık. |
| Kod imzalama sertifikası alınacak mı? | Açık. Kurulum şimdilik imzasız. |
| Otomatik güncelleme GitHub Releases'tan mı, elle mi? | Açık. electron-builder'ın güncelleme ayarı (`publish`) kapalı; uygulama hiçbir yere sürüm sormuyor. |

## Lisans ve marka

Kod MIT ([LICENSE](../LICENSE)). **Cortex** ve **Pyn** adları, Pyn'in mührü ve yüzü lisansın dışındadır: [MARKA.md](../MARKA.md).
