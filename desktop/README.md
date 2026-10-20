# Cortex masaüstü uygulaması

Cortex'in Windows masaüstü uygulaması. Terminal gerektirmeden kurulur ve gerekeni kendisi kurar: Python (yoksa), kasadaki Cortex hafıza motoru, yakala ve sesle yazma. İlk ekranı Pyn: kendi yapay zeka araçlarınla kasanın hafızası üzerinden konuştuğun sohbet. Yanında kasanı Obsidian'a gerek kalmadan okuyup yazan not ekranı, grafik ve Pyn'in ekibinin çalıştığı Beyin ekranı var; sağ alttaki simgeden Not al penceresi ve mikrofon yönetilir.

Uygulama motorun kodunu değiştirmez: kendi sürümündeki motor paketini kasaya kurar ve günceller, sohbetteki araç kasada başlatılır, hafızayı motorun oradaki hook'ları verir.

## Ne yapar

- **İlk kurulum ekranı:** önce "Sana nasıl hitap edeyim?" sorusu, sonra sırayla kasa (sistemin klasör seçme penceresiyle), Python (bilgisayarda yoksa; python.org'un imzalı 3.12.10 kurucusu uygulamayla gelir, yalnız o kullanıcı için kurulur, yönetici izni istemez), Pyn'in hafızası (Cortex kasaya kurulur), yapay zeka aracı (girişler) ve sesle yazma. Her adım ne yaptığını söyler; isteğe bağlı olanlar "Atla" ile geçilir ve sonra Ayarlar'dan yapılır. Uygulama sonraki açılışlarda aynı kasayla açılır.
- **Kurulum dosyası:** yönetici izni istemez, konum sormadan yalnız o kullanıcı için standart yere kurulur. Yeniden kurulumda notlara ve ayarlara dokunulmaz.
- **Dil:** Türkçe varsayılan. İngilizce üst çubuktan, ayarlardan ya da ilk ekrandan seçilir; seçim kalıcıdır.
- **Ayarlar:** üst çubuktaki dişli ya da Ctrl+, açar. Bölümler: Genel (dil, hitap, kasa, sağ altta çalışmaya devam et), Notlar (dosya ağacının görünüşü: bütün dosya türleri, adlardaki emojiler), Yapay zeka araçları (girişler, API anahtarları), Beyin (canlı konuşmalar), Cortex (kasadaki hafızanın kurulumu ve güncellenmesi), Sesle yazma (kurulum, sürekli dinleme, uyandırma sözü, sesli komutlar), Telegram (bot anahtarı, telefonla eşleşme, dinleyicinin durumu), İlk kurulum ekranı ve Hakkında. Seçimler ana süreçte `settings.json`'a o an yazılır ve "Kaydedildi" görünür; yazılan alanların (hitap, sesli komutlar) yanında Kaydet düğmesi vardır.
- **Sağ alttaki simge:** pencere kapanınca uygulama bildirim alanında kalır ve kurulu uygulama Windows'la (`--gizli`) başlar; ikisi de Ayarlar → Genel'den kapatılır. Menü: mikrofonun durumu ve uyandırma sözü, Sürekli dinle aç/kapat (dinlerken simgede kırmızı nokta), Not al, Cortex'i aç, Ayarlar, Çık.
- **Telegram:** kişinin kendi botuna telefondan gönderdiği yazı, bağlantı, fotoğraf ve sesli not kasanın gelen kutusuna düşer (`beyin.py telegram`, [docs/v3/TELEGRAM.md](../docs/v3/TELEGRAM.md)). Bot anahtarı `safeStorage` ile şifrelenip uygulamanın veri klasöründe (`telegram.json`) durur, dinleyiciye yalnız ortam değişkeni olarak verilir; dinleyici uygulama açıkken (sağ altta da) çalışır, durursa artan aralıkla yeniden başlar (`electron/services/telegram.ts`).
- **Not al ve ses:** Not al penceresini kasanın yakala dinleyicisi açar (`beyin.py yakala pencere`); Ctrl+Alt+C, simgenin menüsü ya da uyandırma sözü ("Hey Pyn", "Pyn, not al" ya da ikisi de). Sesle yazma ve sesli komutlar ("Pyn, kaydet", "panodaki resmi ekle", "son kelimeyi sil", "son cümleyi sil", "hepsini sil", "iptal") Ayarlar → Sesle yazma'dan kurulur ve değiştirilir; ses yerelde Whisper ile yazıya dökülür.
- **Cortex güncellemesi:** kasadaki Cortex uygulamanın taşıdığı sürümden eskiyse ana ekranda "Cortex güncellemesi hazır" bildirimi çıkar, ayar dişlisinde altın nokta yanar; Güncelle uygulamayla gelen paketten günceller (`beyin.py update --package`), notlara dokunmaz.
- **Pyn (ilk ekran):** Kişinin kendi yapay zeka aracıyla sohbet. Araç şunlardan biridir: **Claude Code**, kendi yapılandırılmış modunda (`claude -p --input-format stream-json --output-format stream-json`, Claude Agent SDK'nın onu sürdüğü gibi); **Codex**, kendi uygulama sunucusuyla (`codex app-server`, JSON-RPC); ya da Agent Client Protocol (ACP) konuşan **OpenCode** (`opencode acp`), **Gemini CLI** ve **Qwen Code** (`--acp`). Bilgisayarındaki yerel modeller için **LM Studio** ve **Ollama** da listede: Cortex onların kendi sunucusuyla doğrudan konuşur.
  - Claude Code'da her sohbet kendi `claude` sürecidir; sohbete devam edilirken oturumu `--resume` ile sürdürülür. Model listesi Claude Code'un kendisinden gelir; izin modu (Önce sor, Düzenlemeleri kabul et, Plan modu, Otomatik) ve efor çiplerle seçilir; "tüm izinleri atla" hiç sunulmaz. Bir ayar değişince süreç turlar arasında kapatılıp aynı oturumda yeni bayrakla açılır. "Her zaman izin ver", Claude Code'un önerdiği kuralı Claude Code'un kendi ayarına yazdırır.
  - Codex'te her kasa için tek sunucu, her sohbet için bir thread vardır; sohbete devam edilirken thread sürdürülür (`thread/resume`). Model listesi sunucudan gelir; sohbet, seçim yapılmamışsa sunucunun işaretlediği varsayılan modelle başlar (`config.toml`'daki model hesabın artık kullanamadığı bir model olabilir). Model, efor, onay politikası ve sandbox her mesajla gönderilir: ayar değişince yeniden başlatma gerekmez. İzin modu: Önce sor, Salt okunur, Kasada sormadan çalış; tam disk erişimi hiç sunulmaz. Komut ve dosya değişikliği onayları aynı kartla sorulur ("Bu sohbette hep izin ver" dahil).
  - araç kasada başlatılır; kasadaki Cortex hook'ları ona kasanın hafızasını verir
  - cevap akarak gelir: önce sözler; düşünme ve araç adımları ("Etkinlik · 2 adım") birer satıra katlanır
  - araç bir adım için izin isterse yazı kutusunun üstünde kart çıkar: bir kez, her zaman, reddet (Enter = bir kez)
  - yazı kutusunda aracın, oturumun modelinin, modunun ve düşünme düzeyinin çipleri; seçilen model o araç için hatırlanır
  - bağlamın doluluğu halka olarak görünür; cevap gelirken Gönder düğmesi Durdur olur
  - sohbetin sağında açılıp kapanan panel: bu sohbette okunan, değiştirilen ve bahsedilen notlar; cevaptaki `[[not]]` linki, bir adımın dokunduğu not ya da listedeki bir not sohbetten ayrılmadan panelde açılır (diskte değişince yeniden okunur); Ctrl+tıklama ya da paneldeki düğme onu Notlar'da açar
  - sohbetler kasaya göre listelenir (Bugün / Dün / Bu hafta / Daha eski); Ctrl+K yeni sohbet; hiçbir sohbet ilk mesajdan önce açılmaz
  - kota bitmesi, giriş yapılmamış araç, aracın kapanması kartta anlaşılır bir cümleyle söylenir
  - **Yerel modeller (LM Studio, Ollama):** Modeli kendi uygulamasında yüklersin; Cortex sunucunun OpenAI uyumlu adresiyle (`/v1/chat/completions`, akışlı) doğrudan konuşur, arada başka program yoktur.
    - Sunucular yalnız 127.0.0.1'e HTTP ile sorulur (`/api/v0/models`, `/api/tags`, `/api/ps`). Onları başlatabilecek hiçbir komut (`ollama list` gibi) çalıştırılmaz. Gömme (embedding) modelleri listelenmez.
    - Kuruluysa (`lms` ya da `ollama` PATH'te) ya da sunucusu açıksa araç çipinde görünür: yeşil nokta sunucu açık ve modeli var, kırmızı nokta kapalı. Kapalıyken yazılan mesaj "model sunucusu açık değil" kartıyla döner. Liste pencereye geri dönüldüğünde yeniden sorulur: LM Studio'da model yükleyip sunucuyu başlatman ve Cortex'e dönmen yeter.
    - Sohbet o an yüklü modelle başlar; yüklü model yoksa en son seçilenle, o da yoksa ilk modelle. Model çipinde sunucunun modelleri var, yüklüler önde; çipte seçilen model o sohbetindir.
    - **Hafıza:** Pyn'in hafızası, kasanın vault OpenCode eklentisinin yaptığı gibi kasanın kendi hook'undan (`.claude/scripts/beyin_v3_hook.py`, `py -3` ile) gelir. Sohbetin ilk mesajında `SessionStart` bağlamı sistem mesajı olur; sonraki her mesajda `UserPromptSubmit` bağlamı o mesajın yanında gider. Hook, yerel modellerin hafızayı önceden aldığı OpenCode adıyla (`--harness opencode`) sorulur. Kasada hook yoksa ya da Python cevap vermezse sohbet hafızasız sürer, bozulmaz.
    - Modelin tek aracı `save_to_inbox`: "bunu kaydet", "sonra bakacağım" denince bir notu ya da bağlantıyı kasanın gelen kutusuna (`📥 000-Inbox/Yakala`) ekler; işi kasanın kendi `beyin.py yakala ekle`'si yapar (`electron/services/inbox.ts`). Başka dosya okumaz, değiştirmez. Araç adımı sohbette görünür, kart oradan açılır. Sunucusu "bu model araç almaz" diyen model araçsız yeniden sorulur. Araç çağrısının kendisi konuşmada saklanmaz, yalnız ardından gelen cevap. Düşünen modellerin düşünmesi (`reasoning_content`, `reasoning`, `<think>`) ayrı katlanır.
  - **Gelen kutusuna at:** her mesajın altındaki düğme (fare üstüne gelince görünür) mesajı aynı yere kaydeder; hangi araç ya da model olursa olsun çalışır.
    - Konuşma uygulamanın veri klasöründe sohbetin kimliğiyle tutulur (`%APPDATA%\Cortex\chats\local`), uygulama kapanınca kaldığı yerden sürer, sohbet silinince o da silinir. Uzun sohbet modelin bağlamına sığacak kadar kısaltılır; hafıza bağlamı hep kalır.
    - "Girişleri yönet" penceresi sunucunun açık olup olmadığını, model sayısını ve yüklü modeli gösterir; model 8192 token'dan kısa bağlamla yüklüyse uyarır.
  - **Girişler:** araç çipindeki "Girişleri yönet…" ya da "giriş yok" kartındaki düğme, araçların penceresini açar. Her araç kendi komutuyla sorulur (`claude auth status`, `codex login status`, `opencode auth list`); "Giriş yap" aracın kendi girişini ayrı bir konsol penceresinde açar (Claude ve Codex tarayıcıyla, OpenCode sağlayıcı menüsüyle), pencere kapanınca durum yenilenir. API anahtarı: Codex'e doğrudan verilir (`codex login --with-api-key`, girdi üzerinden), Claude Code, Gemini CLI ve Qwen Code için Windows'un şifreli deposunda (DPAPI, `%APPDATA%\Cortex\keys.json`) saklanır ve yalnız o araç başlarken ortam değişkeni olarak verilir; pencere anahtarı bir daha görmez. Durum, aracın bu bilgisayarda kayıtlı girişidir (terminaldekiyle aynı); girişin hâlâ geçerli olduğunu göstermez. Bir araç "giriş yok" diye reddettiğinde, kendi durumu "giriş kayıtlı" dese bile pencere onu "Giriş geçersiz" diye gösterir ve yeniden giriş yapmayı söyler.
- **Notlar:** Krewgent'ta yazılıp test edilen not ekranı ([KAYNAK.md](KAYNAK.md)):
  - dosya ağacı (sürükle-bırakla taşıma), sekmeler, ileri/geri. Ağaç varsayılan olarak notları ve notların kullandığı resim, PDF, ses ve video dosyalarını listeler; betik, JSON ve metin dosyaları (Cortex'in `beyin.py`'si gibi) "Bütün dosya türlerini göster" açılınca görünür, yalnız gizli dosyalardan oluşan klasörler de onlarla gizlenir. Adların başındaki emojiler (`📥 000-Inbox`) yalnız görünüşte kaldırılır; diskteki adlar değişmez, notun başlığından yeniden adlandırırken emoji korunur.
  - okuma görünümü: wiki linkleri, gömmeler, callout'lar, özellikler, görevler; bir linkin üstüne gelince notu gösterir
  - CodeMirror düzenleyici: Obsidian'ın canlı önizlemesi, bir tuşla kaynak modu
  - geri bağlantılar, ana hat, arama, hızlı geçiş (Ctrl+O), grafik
  - şablonlar (`📋 Templates/Note.md`) ve Cortex'in gelen kutusuna hızlı not (Ctrl+Shift+N, `📥 000-Inbox/Dump`)
  - yeniden adlandırmada notun başlığı (`title:` ve ilk başlık) yeni adı izler
  - Markdown olmayan metin dosyaları (JSON, betik, ayar) satır numaralı ve salt okunur gösterilir; JSON renklidir
  - çöp kutusu: silinen not, dosya ve klasör kasanın `.trash/` klasörüne gider; bildirimdeki "Geri al" ya da sol sütundaki Çöp kutusu sekmesiyle geri gelir
- **Beyin:** dördüncü sekme (1.0.21'e kadar adı "Ofis"). Bir beynin içine çizilmiş, yaşayan bir piksel sanatı ofis; kıvrımlarında kıvılcımlar akar. Patron Pyn, ilk kurulumda yazılan adı taşıyan müdür ve onun odası, Cortex'i yazan geliştirici Tolga'nın masası, 12 kişilik ekip ve ofis kedisi Tekir dokuz odada çalışıyor. Çizimleri ve arayüzü Claude Design yaptı (brifler: `docs/ofis/claude-design-brifi.md`, `docs/ofis/beyin-cercevesi-brifi.md`); çizimler `src/office/office-art.js`, motor `src/office/ofis-engine.js`.
  - Karaktere tıklayınca kart (rol, ruh hali, ne yaptığı, Çay/Tokluk/Enerji, bugünkü sayaçlar), odaya tıklayınca oda paneli (canlı önizleme, içeridekiler) açılır. Tekerlek yakınlaştırır, sürükleme gezdirir; + − ⤢ Aa düğmeleri, kişi çipleri ve boyu değişen ofis günlüğü var.
  - Gerçek olanlar: sunucu odasındaki kabinlerin ışıkları araçların kendi giriş durumudur; odalar kasanın notlarını, bağlantılarını, makbuzlarını ve bugün değişen notları sayar; ışık gerçek saate uyar (gece lambalar yanar); oda adları pencerenin dilindedir.
  - Canlı konuşmalar: sekmenin kendi ayarlarından ya da Ayarlar → Beyin'den bir araç (LM Studio, Ollama ya da Claude Code) ve model seçilirse model son notların başlıklarına ve kısa parçalarına bakıp ekibe konuşma yazar; karakterler baloncukla söyler, konuşma günlüğe düşer. Varsayılan kapalıdır; sekme gizliyken hiçbir şey harcanmaz. Yerel sunucularda hiçbir şey bilgisayardan çıkmaz. Ajanların gün içindeki diğer davranışları Claude Design prototipinin betiğidir.
  - Sekme yalnız öndeyken çizilir; arkadayken motor durur. Yazı tipleri Pixelify Sans ve VT323 (OFL, `licenses/`), uygulamayla gelir.
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
- Sohbetteki araç kabuk olmadan, sabit argümanlarla, kasada başlatılır. Windows'ta npm'in `.cmd` kısayolu okunur, başlattığı `.exe` ya da betik doğrudan çalıştırılır. Pencere program adı vermez, yalnız ana sürecin verdiği listeden bir araç seçer. Aracın söylediği her şey pencereye gitmeden önce temizlenir: yollar kasaya göre göreli olur, kasa dışındaki bir yol yalnız dosya adıyla görünür, ev klasörü `~` olur, metinler bir uzunlukta kesilir. Uygulama araca dosya ya da terminal servis etmez; araç kendi araçlarıyla, kendi izinleriyle çalışır. Uygulama kapanınca ya da kasa değişince araç ve başlattığı her süreç kapatılır. Cortex bir Claude Code oturumunun içinden açılmışsa (geliştirirken olduğu gibi), o oturumun kendi değişkenleri (`CLAUDECODE`, `CLAUDE_CODE_*`, onun API adresi) araca geçmez; geçseydi araç o oturumun sunucusuna gidip reddedilirdi.
- Araçların giriş jetonları her aracın kendi dosyasında, senin kullanıcı klasöründe durur (Claude Code `~\.claude\.credentials.json`, Codex `~\.codex\auth.json`, OpenCode `~\.local\share\opencode\auth.json`). Uygulama bu dosyaları okumaz, yalnız araca durumunu sorar. Hiçbiri kasada ya da bu depoda değildir; her bilgisayarda ayrı giriş yapılır. Uygulamanın sakladığı tek sır, girilen API anahtarlarıdır (DPAPI, `%APPDATA%\Cortex\keys.json`).
- Sohbetlerin listesi ve ekranda gösterilenler uygulamanın veri klasöründe durur (`%APPDATA%\Cortex\chats`), kasada değil. Konuşmanın kendisi aracındır: devam edilen sohbet, araç destekliyorsa kendi oturumunu sürdürür (`session/resume`).
- Telemetri yok, hesap yok, sürekli açık sunucu yok. Ayarlar (`settings.json`: kasanın yolu, dil ve dosya ağacının görünüşü) uygulamanın kendi veri klasöründe durur (`%APPDATA%\Cortex`), kasada değil. Bu dosya okunamazsa üstüne yazılmaz; bozuksa yanına kopyalanır.

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
| `npm test` | `node:test`; testler esbuild ile gerçek kaynaktan paketlenir (176 test; bazıları yalnız Windows'ta çalışır, başka yerde atlanır) |
| `npm run e2e` | Derler ve gerçek Electron uygulamasını Playwright ile sürer. Pencere hiç gösterilmez: ekran dışında çizilir, `capturePage` ile fotoğraflanır (`e2e/screenshots/`). Linux'ta Xvfb altında çalışır. `CORTEX_SHOW=1` pencereyi gösterir. |
| `npm run vitrin` | README'nin görüntüleri (`docs/gorseller/`): uygulama Türkçe arayüzle, örnek bir lansman kasasıyla, aynı gizli pencerede ekran dışında çizilir; sohbetin ve Beyin'in cevaplarını LM Studio'nun yerine geçen bir test sunucusu yazar. |
| `npm run package` | Windows NSIS kurulum dosyası (`release/Cortex Setup X.Y.Z.exe`). Windows'ta çalıştır; Linux'ta son adım wine ister. |

CI: `.github/workflows/desktop.yml`. `desktop/`, `template/`, `scripts/`, `VERSION` ya da `tema/ananas/marka/` değiştiğinde Windows'ta çalışır: tip denetimi, testler, uçtan uca koşu, sonra kurulum dosyası. Kurulum dosyası bir hafta boyunca iş akışının çıktısı (`cortex-setup-windows`) olarak indirilebilir.

### Klasörler

```
core/       Obsidian'ın kuralları: ayrıştırma, link çözme, relink, arama, şablon (node yok, electron yok)
shared/     iki tarafın ortak tipleri: köprü (api.ts), notlar, dil
electron/   ana süreç: pencere, IPC kanalları, ayar dosyası, kasa seçimi, kasanın okuyucusu/yazıcısı; CLI bulucu (clis.ts), yerel model sunucuları ve onlarla sohbet (localModels.ts, localChat.ts), girişler ve anahtarlar (auth.ts, keys.ts), Telegram dinleyicisi (telegram.ts), sohbet (chat.ts) ve üç arka ucu: Claude Code (claudeChat.ts), Codex (codexChat.ts), ACP (acp.ts, acpChat.ts)
src/        pencere: React + Tailwind v4; sohbet src/chat/, not ekranı src/notes/
tests/      node:test, gerçek kaynak üzerinde
e2e/        Playwright _electron ile uçtan uca koşu
scripts/    derleme, geliştirme, test ve e2e betikleri
```

## Ne eksik

- **Sohbetin geri kalanı (Aşama 2):** her turdan önce anlık kopya ve geri alma; kasadan gelen öneriler; silinen sohbetlerin çöp kutusuna düşmesi.
- **Ananas görünümü:** Renkler Ananas'ın kâğıt ve mürekkebi. Fraunces henüz uygulamayla gelmiyor; sistem yazı tipleri kullanılıyor (Beyin'in piksel yazı tipleri geliyor).
- **Kurulum dosyasının yayımlanması:** release iş akışı yalnız motor paketini yayımlıyor; kurulum dosyası şimdilik desktop iş akışının çıktısı olarak ya da elle sürüme eklenerek dağıtılıyor.
- **İmza:** Kurulum dosyası imzasız; aşağıda **İmza** bölümü.
- **Otomatik güncelleme yok.** Yeni sürüm elle kurulur.
- **Ana süreç cümleleri:** kaydı ya da taşımayı reddeden cümleler ana süreçte İngilizce yazılır; Türkçe arayüzde pencere onları Türkçe gösterir (`shared/refusalsTr.ts`, eksik kalanı bir test yakalar). Bir aracın ya da modelin kendi hata metni olduğu gibi kalır.
- **Yazım denetimi:** Sözlükler Google'dan indirilmediği için Chromium'un Hunspell denetimi sözlüksüz kalır. Yazım yalnız platformun kendi denetleyicisinin kullanıldığı yerde denetlenir.
- **Linkler:** Obsidian'ın setext başlıkları, özellik değerindeki linkler ve aynı adlı iki notun Obsidian'ın kendi dizinine göre çözülmesi desteklenmiyor (`core/vaultNotes.ts` başında yazıyor).
- **macOS ve Linux:** Kod çalışır ama CI'da denenmiyor ve kurulum dosyası üretilmiyor.

## İmza

- **Neden uyarı çıkıyor:** kurulum dosyası şimdilik imzasız. İnternetten indirilen imzasız bir dosyayı Windows SmartScreen "Windows bilgisayarınızı korudu" diye durdurur: **Ek bilgi → Yine de çalıştır**.
- **Kendi bilgisayarında:** derlediğin dosyayı doğrudan `desktop\release\` klasöründen çalıştırırsan bu uyarı çıkmaz, çünkü dosya indirilmemiştir.
- **Herkes için kaldırmanın tek yolu**, güvenilir bir sertifika yetkilisinden alınan kod imzalama sertifikasıdır. Seçenekler ve koşullar değişebilir; almadan önce bakılmalı:
  - Azure Trusted Signing: en ucuzu ve SmartScreen güvenini hızlı kazanır, ama bireysel geliştiricileri yalnız bazı ülkelerde kabul ediyor.
  - OV sertifika (Certum gibi; açık kaynak geliştiricilere ucuz bir türü var): SmartScreen ilk zamanlarda yine uyarabilir, dosya indirildikçe güven oluşur.
  - EV sertifika: pahalı, donanım anahtarı ister.
- **Sertifika alınınca:** `.pfx` dosyasını base64 yapıp deponun Secrets'ına `WIN_CSC_LINK`, parolasını `WIN_CSC_KEY_PASSWORD` olarak koy. desktop iş akışı kurulum dosyasını kendiliğinden imzalar. Python kurucusu uygulamanın içinde `.paket` olarak durduğu için yeniden imzalanmaz, özeti bozulmaz.
- **Kendi kendine imzalı sertifika** yalnız onu güvenilir köklere eklediğin bilgisayarda işe yarar; başkalarına dağıtımda SmartScreen'i geçmez.

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
