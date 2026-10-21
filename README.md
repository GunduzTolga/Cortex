<p align="center">
  <img src="tema/ananas/marka/pyn-muhur-200.png" width="132" alt="Pyn'in mührü: altın zemin üzerinde ananas">
</p>

<h1 align="center">Cortex</h1>

<p align="center">
  <b>Yapay zeka asistanların için yerel, kalıcı bir ikinci beyin.</b><br>
  Notların kendi bilgisayarında, düz Markdown dosyalarında kalır. Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Kiro ve yerel modeller aynı hafızayı paylaşır.<br>
  Düşünme ortağın ve maskotu: ananas <b>Pyn</b>.<br>
  <sub>SoleLuna Tech</sub>
</p>

<p align="center">
  <img alt="Sürüm 1.0.32" src="https://img.shields.io/badge/s%C3%BCr%C3%BCm-1.0.32-E8B23A">
  <img alt="Windows uygulaması" src="https://img.shields.io/badge/uygulama-Windows-1B1712">
  <img alt="Motor: Windows, macOS, Linux" src="https://img.shields.io/badge/motor-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1B1712">
  <img alt="Lisans MIT" src="https://img.shields.io/badge/lisans-MIT-1B1712">
  <img alt="Telemetri yok" src="https://img.shields.io/badge/telemetri-yok-1B1712">
</p>

<p align="center">
  <a href="https://github.com/GunduzTolga/Cortex/releases/latest"><b>Windows için indir</b></a> ·
  <a href="#hızlı-başlangıç-windows">Hızlı başlangıç</a> ·
  <a href="#terminalden-kurulum-macos-linux-geliştiriciler">macOS / Linux</a> ·
  <a href="#in-english">English</a>
</p>

<p align="center">
  <img src="docs/gorseller/pyn.png" width="880" alt="Cortex masaüstü uygulaması: Pyn'e lansman için neler kaldığı soruluyor, cevap ilgili notlara bağlantı veriyor">
</p>

---

## İçindekiler

- [Cortex nedir?](#cortex-nedir)
- [Nasıl çalışır?](#nasıl-çalışır)
- [Neler yapar?](#neler-yapar)
- [Görüntüler](#görüntüler)
- [Hızlı başlangıç (Windows)](#hızlı-başlangıç-windows)
- [Masaüstü uygulaması](#masaüstü-uygulaması)
- [Not al ve sesle yazma](#not-al-ve-sesle-yazma)
- [Yakala: tek tuşla beyne at](#yakala-tek-tuşla-beyne-at)
- [Telegram: telefondan gelen kutusuna](#telegram-telefondan-gelen-kutusuna)
- [Desteklenen istemciler](#desteklenen-istemciler)
- [Gizlilik ve güvenlik](#gizlilik-ve-güvenlik)
- [Terminalden kurulum (macOS, Linux, geliştiriciler)](#terminalden-kurulum-macos-linux-geliştiriciler)
- [Günlük kullanım ve komutlar](#günlük-kullanım-ve-komutlar)
- [Güncelleme](#güncelleme)
- [Sorun giderme](#sorun-giderme)
- [Sürüm geçmişi](#sürüm-geçmişi)
- [Geliştiriciler](#geliştiriciler)
- [In English](#in-english)
- [Lisans ve marka](#lisans-ve-marka)

---

## Cortex nedir?

Yapay zeka asistanları oturum kapanınca unutur; bir araçta anlattığını öbürü bilmez. Cortex bu boşluğu kapatır. Notlarının durduğu bir klasöre (bir Obsidian kasasına ya da sıradan bir klasöre) kurulur ve kullandığın araçlara ortak bir hafıza bağlar:

- **Hatırlar.** Her oturum açılışında ve her mesajda, konuyla ilgili notların asistanın bağlamına eklenir. Önceki oturumun devir kartı, açık konular ve senin düzeltmelerin hep el altındadır.
- **Düzeltmeni unutmaz.** "Bunu böyle yapma" dediğinde asistan bunu kural olarak yazar; bir sonraki oturum o kuralı bilerek başlar.
- **Kaynak gösterir.** Biten işler kısa, kaynak bağlantılı makbuzlarla kaydedilir; neyin nereden geldiği izlenebilir.
- **Araçtan bağımsızdır.** Claude Code'da kaydettiğini Codex'te, OpenCode'da ya da LM Studio'daki yerel bir modelde bulursun.
- **Senin dosyalarındır.** Her şey düz Markdown'dır; Obsidian'la, Cortex'in kendi not ekranıyla ya da herhangi bir editörle açarsın.
- **Yereldir.** Hafıza motoru hesap, API anahtarı ya da sürekli açık bir sunucu istemez; kendi başına hiçbir model çağırmaz ve telemetri toplamaz.

Cortex'in içinde bir düşünme ortağı da gelir: **Pyn**. Seni tanır, fikirlerine gerekçeli itiraz eder, işlerini takip eder ve öğrendiklerini düzenler. Kimliği ve hafızası kasandaki Markdown dosyalarındadır.

## Nasıl çalışır?

Cortex iki parçadır:

1. **Hafıza motoru (kasada).** Kasana kurulan küçük bir Python programı (`beyin.py` ve yanındaki dosyalar). Yalnız Python'un kendi kütüphanesini kullanır, ek paket istemez. Notlarını yerel bir arama indeksine alır; kullandığın yapay zeka aracına kurulan "hook"lar (oturum ve mesaj olaylarında çalışan küçük komutlar) sayesinde her oturum açılışında ve her mesajda ilgili notları asistanın bağlamına ekler, iş bitince kayıt tutar. Windows, macOS ve Linux'ta çalışır.
2. **Masaüstü uygulaması (Windows).** Motoru ve gerekenleri terminalsiz kurar; Pyn'le sohbet, notlar, grafik, Beyin ekranı, sesle yazma ve Telegram'ı tek pencerede toplar. Uygulama olmadan da motor terminalden kurulup kullanılabilir.

Kasadaki klasörler:

| Klasör | Ne durur |
| --- | --- |
| `📥 000-Inbox/` | Ham yakalamalar: `Dump/` hızlı notlar, `Yakala/` Not al, Yakala ve Telegram'dan gelenler |
| `🎯 100-Command-Center/` | Ana sayfa (`Dashboard.md`) |
| `🏰 300-Projects/` | Proje notları |
| `🧠 500-Knowledge/` | Senin yazdığın kalıcı bilgi |
| `🛠️ 600-Arsenal/` | Araçlar, kişiler, kaynaklar |
| `🔮 850-Companion/` | Pyn'in hafızası: kimliği (`Core.md`), son oturumlar (`Last-Session.md`), açık konular (`Threads.md`), kurallar (`Kurallar.md`), günlük (`Journal.md`) |
| `📦 900-Archive/` | Biten ve park edilen işler |
| `📋 Templates/` | Not şablonları |
| `knowledge/`, `daily/` | Asistanın derlediği bilgi tabanı ve oturum kayıtları (makbuzlar) |

## Neler yapar?

| | |
| --- | --- |
| **Ortak hafıza** | Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Kiro ve diğerleri aynı notları, kararları ve açık işleri görür. |
| **Masaüstü uygulaması** | Terminalsiz kurulum; Pyn'le sohbet, notlar, not grafiği ve Pyn'in ekibinin çalıştığı **Beyin** ekranı. |
| **Not al** | Her uygulamanın üstünde `Ctrl+Alt+C` ile açılan pencere; Windows'ta "Pyn, not al" ya da "Hey Pyn" deyince de açılır. Yaz ya da konuş, "Pyn, kaydet" de. Ses bilgisayardan çıkmaz. |
| **Yakala** | Tarayıcıdaki sayfa, video, makale, tweet, ekran görüntüsü ya da dosya tek tuşla kasaya; asistan metni çıkarıp derslerini notlara bağlar. |
| **Telegram** | Telefondan kendi botuna gönderdiğin yazı, bağlantı, fotoğraf, dosya ya da sesli not gelen kutusuna düşer. |
| **Gizlilik** | Notlar ve arama indeksi senin bilgisayarında. Özel işaretli notlar ve adında "Şifreler", "Özel" gibi sözcükler geçen klasörler otomatik bağlama girmez. |

## Görüntüler

<table>
  <tr>
    <td width="50%"><img src="docs/gorseller/beyin.png" alt="Beyin: bir beynin içine çizilmiş piksel sanatı ofis; ekip son notlar hakkında konuşuyor"><br><sub><b>Beyin:</b> Pyn'in ekibi bir beynin içindeki ofiste çalışır; istersen son notların hakkında konuşurlar.</sub></td>
    <td width="50%"><img src="docs/gorseller/notlar.png" alt="Notlar: lansman planı notu, görevler, uyarı kutusu ve geri bağlantılar"><br><sub><b>Notlar:</b> Obsidian'sız okuma ve yazma; wiki bağlantıları, görevler, geri bağlantılar.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/gorseller/grafik.png" alt="Grafik: lansman notları ve aralarındaki bağlantılar"><br><sub><b>Grafik:</b> notların ve aralarındaki bağlantılar.</sub></td>
    <td width="50%"><img src="docs/gorseller/ayarlar-ses.png" alt="Ayarlar, Sesle yazma: sürekli dinleme, uyandırma sözü İkisi de, sesli komutlar"><br><sub><b>Sesle yazma:</b> "Pyn, not al" ya da "Hey Pyn"; sesli komutların sözleri Ayarlar'dan değişir.</sub></td>
  </tr>
</table>

<sub>Görüntüler uygulamanın kendisinden, örnek bir kasayla alındı (`desktop/e2e/vitrin.mjs`). Sohbetteki cevabı ve Beyin'deki konuşmayı, LM Studio'nun yerine geçen bir test sunucusu yazdı.</sub>

## Hızlı başlangıç (Windows)

Terminal gerekmez; uygulama gerekeni kendisi kurar.

1. **İndir.** [Son sürüm sayfasından](https://github.com/GunduzTolga/Cortex/releases/latest) `Cortex Setup X.Y.Z.exe` dosyasını indir.
2. **Kur.** Kurulum yönetici izni istemez; yalnız senin kullanıcın için, Windows'un standart uygulama klasörüne kurulur. Kurulum sihirbazı Türkçedir.
   > **Kurulum dosyası henüz imzasız.** Windows bu yüzden mavi bir **"Windows bilgisayarınızı korudu"** ekranı gösterebilir. **Ek bilgi**'ye, ardından **Yine de çalıştır**'a bas. Kod imzalama sertifikası gelince bu ekran kalkacak.
3. **İlk kurulum ekranını izle.** Pyn sırayla şunları yapar:
   1. **Hitap:** sana nasıl seslenmesini istediğini sorar (atlanabilir).
   2. **Kasa:** notlarının duracağı klasörü seçersin; mevcut bir Obsidian kasası da olabilir. Zorunlu tek adım budur.
   3. **Python:** yalnız bilgisayarında Python yoksa görünür. Uygulamayla gelen Python 3.12, yalnız senin kullanıcın için kurulur.
   4. **Pyn'in hafızası:** hafıza motoru kasaya kurulur; notlarına dokunulmaz.
   5. **Yapay zeka aracın:** bilgisayarında kurulu araçları (Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code) listeler; her birinin yanında giriş düğmesi, ayrıca API anahtarı girme düğmesi vardır. Claude Code kurulu değilse **Claude Code'u kur ve giriş yap** düğmesi çıkar: Anthropic'in kendi kurucusu bir pencerede çalışır, bitince giriş penceresi kendiliğinden açılır. Claude Code, Claude Pro ya da Max aboneliği ister. Uygulamayı yeniden açman gerekmez; sonradan kurduğun bir araç da pencereye döndüğünde görünür.
   6. **Sesle yazma:** isteğe bağlıdır, tek düğmeyle kurulur (yaklaşık 2 GB indirme). Kurulunca **Sürekli dinle** ve **Pencere açılınca dinle** anahtarları görünür.

   Her adım ne yaptığını söyler; isteğe bağlı adımlar **Atla** ile geçilir ve sonra Ayarlar'dan yapılır. İlk kurulum ekranı Ayarlar'dan yeniden açılabilir.

   <img src="docs/gorseller/ilk-kurulum.png" width="640" alt="İlk kurulum ekranı: Memnun oldum, Tolga Bey. Notların nerede dursun?">
4. **Konuş.** Pyn ekranında aracını seç ve yaz. İstersen ilk mesajın şu olsun: *"Beni tanımak için kısa sorular sor; cevapları notlarıma kaydet."*

## Masaüstü uygulaması

Üst çubukta dört sekme vardır:

- **Pyn:** kasanın içinde, kendi yapay zeka aracınla sohbet. Araç kasada başladığı için hafıza tam gelir.
  - **Araçlar:** Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code; yerel modeller için LM Studio ve Ollama. Yerel modeli kendi uygulamasında yüklersin, Cortex onunla doğrudan konuşur; "bunu kaydet" dersen yerel model de gelen kutusuna ekler (7–8 milyar parametre ve üstü modeller bunu güvenilir yapar).
  - **Gelen kutusuna at** (`Ctrl+Enter`): gönder düğmesinin yanındadır; yazdığını yapay zekaya göndermeden `📥 000-Inbox/Yakala/`'ya kaydeder.
  - Model, mod ve düşünme düzeyi çiplerle seçilir; aracın izin istediği adımlar kartla sorulur; bağlamın ne kadar dolduğunu yazma kutusundaki halka gösterir.
  - Claude Code kasadaki notlara sormadan yazar; kasanın dışındaki dosyalar ve komutlar için izin kartı çıkar. Claude Code kendi ayar ve hook dosyalarını (`.claude/`) yine sorar.
  - Sohbetin okuduğu, değiştirdiği ya da andığı notlar yan panelde açılır.
- **Notlar:** Obsidian'a gerek kalmadan okuma ve yazma: wiki bağlantıları, canlı önizleme, geri bağlantılar, etiketler, üstüne gelince önizleme, arama (`tag:` ve `path:` ile), hızlı geçiş (`Ctrl+K`), şablonlar ve geri alınabilir çöp kutusu. Makbuzlar ve motorun ürettiği sayfalar salt okunurdur.
- **Grafik:** notların ve aralarındaki bağlantılar; bir notun çevresini gösteren yerel grafik, makbuzları göster/gizle.
- **Beyin:** bir beynin içine çizilmiş, yaşayan bir piksel sanatı ofis; kıvrımlarında kıvılcımlar akar.
  - Patron Pyn, ilk açılışta yazdığın adı taşıyan müdür, Cortex'i yazan geliştirici Tolga, 12 kişilik ekip ve kedi Tekir dokuz odada çalışır; karakterlere ve odalara tıklanır.
  - Sunucu odasının ışıkları araçlarının gerçek giriş durumunu, odalar kasanın sayılarını gösterir; ofisin ışığı günün saatine uyar.
  - İstersen ekip son notların hakkında konuşur: Ayarlar → Beyin'den (ya da Beyin ekranının kendi ayarlarından) bir araç (LM Studio, Ollama ya da Claude Code), model ve sıklık (10–60 dakika) seçersin. Varsayılan kapalıdır.

**Sağ alttaki simge.** Pencereyi kapatınca Cortex bildirim alanında kalır ve Windows'la birlikte açılır; Telegram dinleyicisi de orada çalışmaya devam eder. Simgenin menüsü: mikrofonun durumu, **Sürekli dinle** aç/kapat (sesle yazma kuruluysa), **Not al**, **Cortex'i aç**, **Ayarlar**, **Çık**. İstemezsen Ayarlar → Genel → *Sağ altta çalışmaya devam et*. Uygulama tek kopya çalışır; ikinci kez açınca mevcut pencere öne gelir.

**Ayarlar** (üst çubuktaki dişli ya da `Ctrl+,`):

| Bölüm | İçerik |
| --- | --- |
| Genel | Dil (Türkçe/İngilizce), hitap, sağ altta çalışma, kasa |
| Notlar | Tüm dosya türlerini göster, adlardaki emojileri göster |
| Yapay zeka araçları | Araçların giriş durumu, giriş düğmeleri, API anahtarları |
| Beyin | Canlı konuşmalar: araç, model, sıklık |
| Cortex | Kasadaki hafıza motorunun kurulumu ve güncellenmesi |
| Sesle yazma | Kurulum, sürekli dinleme, uyandırma sözü, sesli komutların sözleri, güncelleme |
| Telegram | Bot anahtarı, eşleştirme, durum |
| İlk kurulum ekranı, Hakkında | İlk kurulumu yeniden açma, sürüm bilgisi |

Her değişiklikten sonra kısa bir "Kaydedildi" görünür; yazılan alanlarda değişiklik yapınca yanında Kaydet düğmesi belirir.

**Girişler ve anahtarlar.** Her araç bu bilgisayarda kayıtlı kendi girişini kullanır, terminaldekiyle aynı giriş. Uygulama bu giriş dosyalarını okumaz; aracın kendi durum komutunu çalıştırır (örneğin `claude auth status`). Uygulamaya girdiğin API anahtarları Windows'un şifreli deposunda (DPAPI) durur ve hiçbiri kasaya girmez. Tek istisna Codex: onun API anahtarını Codex kendi girişi olarak saklar.

**Uygulamanın güncellenmesi.** Uygulama kendiliğinden güncellenmez; yeni sürümün kurulum dosyasını indirip üstüne kurarsın. Açınca, kasadaki hafıza motoru uygulamanınkinden eskiyse ana ekranda **"Cortex güncellemesi hazır"** bildirimi çıkar (dişlide altın bir nokta da belirir). **Güncelle**'ye basınca motor, uygulamanın içinden gelen paketle güncellenir; internete çıkmaz, notlarına dokunmaz.

Kendin derlemek ve ayrıntılar için: [desktop/README.md](desktop/README.md).

## Not al ve sesle yazma

**Not al** penceresi her uygulamanın üstünde açılır: `Ctrl+Alt+C` (macOS'ta `Control+Option+C`) ya da Windows'ta sağ alttaki simgenin menüsünden **Not al**. Yaz ya da konuş; `Enter` kaydeder, `Esc` vazgeçer. Not kasanın `📥 000-Inbox/Yakala/` klasörüne düşer. Kısayol `beyin.py yakala kisayol` ile değişir.

**Sesle yazma (yalnız Windows, isteğe bağlı).** İlk kurulum ekranından ya da Ayarlar → Sesle yazma'dan tek düğmeyle kurulur.

- **Yaz ve kaydet.** Pencere açılınca dinlemeye başlar (Ayarlar → *Pencere açılınca dinle*). Konuş, ara verebilirsin; cümleler alana yazılır. Bitince **"kaydet"** ya da **"Pyn, kaydet"** de. Pyn'in adından sonra **"gönder"**, **"tamam"**, **"bitti"** ve **"bitir"** de kaydeder. Klavyeden yazmaya başlarsan mikrofon kapanır; `Ctrl+Alt+C`'ye yeniden basmak dinlemeyi bitirir; uzun süre kimse konuşmazsa mikrofon kendiliğinden kapanır.
- **Sesle açma.** **Sürekli dinle** açıkken (varsayılan kapalı; sağ alttaki menüden ya da Ayarlar'dan açılır) uyandırma sözü pencereyi açar. Söz seçilebilir: **"Pyn, not al"** (varsayılan), **"Hey Pyn"** ya da **ikisi de** (Ayarlar → Sesle yazma → Uyandırma sözü). Sözü önce küçük bir yerel model (Vosk) yakalar, Pyn'in adını ardından yerel Whisper doğrular; sohbetteki bir "hey" ya da "not al" pencere açmaz.
- **Sesli komutlar** (sözleri Ayarlar → Sesle yazma → Sesli komutlar'dan değişir):

  | Komut | Varsayılan sözler |
  | --- | --- |
  | Kaydet | "kaydet"; Pyn'in adıyla "gönder", "tamam", "bitti", "bitir" |
  | Panodaki görüntüyü ekle | "panodaki resmi ekle", "resmi ekle", "görüntüyü ekle", "ekran görüntüsünü ekle" |
  | Son kelimeyi / son cümleyi sil | "son kelimeyi sil", "son cümleyi sil" |
  | Hepsini sil | "hepsini sil", "sil", "temizle" |
  | Vazgeç | "iptal", "vazgeç" |

- **Biraz farklı yazılan komutlar da tutar:** Whisper bir komutu boşlukları başka yerde yazarsa ("kayd et", "son cümle yi sil") ya da silme komutlarında bir eki yutarsa ("son kelime sil", "hepsi sil") komut yine çalışır. "notu kaydettim" ya da "son kelimeyi sildim" gibi cümleler komut sayılmaz, nota yazılır.
- **Ses bilgisayardan çıkmaz ve diske yazılmaz;** yerel Whisper yazıya döker. NVIDIA kartlarda CUDA, AMD Radeon ve Intel Arc kartlarda Vulkan (whisper.cpp) ile ekran kartında, yoksa işlemcide çalışır. Kablosuz kulaklık sonradan bağlansa ya da Windows'un varsayılan mikrofonu değişse de dinleyici yeni mikrofona kendiliğinden geçer.

[Ayrıntılar](docs/v3/YAKALA.md#sesle-yazma-windows-isteğe-bağlı)

## Yakala: tek tuşla beyne at

Gördüğün sayfayı, videoyu, tweet'i, makaleyi ya da dosyayı aynı `Ctrl+Alt+C` penceresiyle yakala. Kart `📥 000-Inbox/Yakala/`'ya düşer. Sonra asistanına **"yakalananları işle"** de: motor metni çıkarır, asistan derslerini `knowledge/` notlarına bağlar ve kartı kapatır. Aynı sayfayı ya da videoyu yeniden yakalarsan yeni kart açılmaz, eskisine eklenir.

- **Tarayıcıdaki sayfa:** Windows'ta Chrome, Edge, Brave, Vivaldi, Opera ya da Chromium; macOS'ta Chrome, Arc, Brave, Edge ya da Safari öndeyken kısayola basarsan açık sayfanın bağlantısı gelir. Pencerede **Bu sayfayı nota bağla** işaretlidir; `Alt+S` ile kaldırırsan not düz not olarak kaydedilir. Firefox'un adresi okunamaz.
- **Ekran görüntüsü (Windows):** `Win+Shift+S` ile alan seç, sonra kısayola bas; görüntü küçük resmiyle nota eklenir. Son 10 dakikada alınmışsa işaretli gelir, daha eskiyse `Tab` ile eklenir.
- **Pano:** yalnız son kayıttan sonra kopyaladığın metin nota işaretli gelir. Daha önce kopyalanmış metin (saatler önceki bir parola gibi) **Panodaki metni de ekle** seçeneği olarak durur, `Tab` ile eklenir.
- **YouTube:** döküm videoda konuşulan dilde alınır. Bunun için bilgisayarda `yt-dlp` olmalıdır; altyazı yoksa ses yalnız yerelde bir Whisper komutuyla yazıya dökülür. Bu araçlar yoksa kart başlık ve açıklamayla kalır. Hangi araçların kurulu olduğunu `beyin.py yakala durum` söyler.
- **Dosyalar:** Windows'ta dosyaya sağ tık → Gönder → **Beyne At**; macOS'ta Finder'da dosyayı seçip kısayola bas.
- **Tarayıcı eklentisi:** Obsidian Web Clipper'ın **"Beyne at"** şablonu; giriş isteyen sayfalar da yakalanır.
- Yakala'yı terminalden kurarsan `beyin.py yakala kur` (masaüstü uygulaması bunu sesle yazmayla birlikte kendisi kurar).

[Ayrıntılar](docs/v3/YAKALA.md)

## Telegram: telefondan gelen kutusuna

Telefondan kendi Telegram botuna gönderdiğin her şey kasanın gelen kutusuna (`📥 000-Inbox/Yakala/`) düşer; asistanın onları diğer yakaladıkların gibi işler.

1. Telegram'da [@BotFather](https://t.me/BotFather)'a `/newbot` yaz, bota bir ad ver.
2. Verdiği anahtarı masaüstü uygulamasında Ayarlar → **Telegram**'a yapıştır, **Bağla**'ya bas.
3. Çıkan **Telegram'da aç** bağlantısını telefonda aç (ya da gösterilen 8 karakterlik kodu bota yaz). Bot artık yalnız seni dinler; başka biri yazarsa cevap vermez.

Neler gelir:

- **Yazı** not olur, **bağlantı** kaynak kartı olur, **fotoğraf** ve **dosya** kartın eki olur (birlikte gönderilen fotoğraflar tek kart), **iletilen mesajın** kimden geldiği yazar. Konum ve kişi yazı olarak kaydedilir; çıkartma ve anket alınmaz. Telegram botların 20 MB'tan büyük dosya indirmesine izin vermez.
- **Sesli not** bu bilgisayardaki Whisper'la yazıya çevrilir (sesle yazma kurulu olmalı, Windows); ses kayıtla birlikte kasada ek olarak durur. Sesle yazma kurulu değilse ses yazıya çevrilmeden kaydedilir.
- Her mesaja bot sessizce "✓ Gelen kutusuna eklendi" diye cevap verir.
- **Bilgisayar kapalıyken** gönderdiklerin, Cortex açılınca gelir. Telegram okunmamış mesajları 24 saat bekletir; Cortex kaçırdığı daha eski mesajları da sohbetten geri almaya çalışır (bir seferde 500 mesaja kadar) ve alamadığını sana yazar, yeniden iletmeni ister.
- Dinleyici masaüstü uygulaması açıkken (sağ altta da) çalışır; terminalden `beyin.py telegram dinle` ile de çalıştırılabilir.

[Ayrıntılar](docs/v3/TELEGRAM.md)

## Desteklenen istemciler

Hafızayı model değil istemci taşır. Bu yüzden ücretsiz, uygun fiyatlı ya da yerel modellerin hepsi, tam hafızalı bir istemcinin içinden kullanılabilir.

| İstemci | Hafıza | Kurulumun yazdığı ve not |
| --- | --- | --- |
| **Claude Code** | Tam | `.claude/settings.local.json`; hook'lar her oturumda ve her mesajda bağlam ekler. |
| **Codex** | Tam | `.codex/hooks.json`; ilk açılışta `/hooks` ekranında hook'ları inceleyip güven. |
| **OpenCode** | Tam | `.opencode/plugins/beyin-v3.js`. z.ai GLM, OpenCode Go ve Zen, OpenRouter ve yerel modeller (LM Studio, Ollama). [Ayrıntılar](docs/v3/OPENCODE.md) |
| **Gemini CLI** | Tam | `.gemini/settings.json`. Google bireysel hesapla girişi kapattı; API anahtarıyla kullan. |
| **Qwen Code** | Tam | `.qwen/settings.json`. |
| **Kiro** (IDE 1.x, CLI) | Tam | `.kiro/hooks/beyin-v3.json` ve `.kiro/skills/`; IDE'de Agent Hooks panelinden, CLI'da `/hooks` ile incele. [Ayrıntılar](docs/v3/KIRO.md) |
| **Oh My Pi (OMP)** | Tam | `.omp/hooks/pre/beyin-v3.ts`. [Ayrıntılar](docs/v3/OMP.md) |
| **Hermes Agent** | Tam | Eklenti kasaya yazılır; bağlama ve etkinleştirme adımını sen yaparsın. [Ayrıntılar](docs/v3/HERMES.md) |
| **Google Antigravity** | Oturum başında | `.agents/hooks.json`. Hafıza ilk model çağrısında eklenir, tur sonları kaydedilir; mesaj başına bağlam yoktur. |
| **Cursor Agent** | Talimatla | `AGENTS.md`'yi okur ve hafıza dosyalarını kendisi yükler; otomatik bağlam yoktur. |

**Tam hafıza:** hook'lar Pyn'in hafızasını her oturum açılışında ve her mesajda bağlama ekler, dosya düzenlenen oturumun sonunda makbuz hatırlatır. Codex, Gemini CLI, Qwen Code ve Kiro'da hook'ları ilk açılışta inceleyip onayla. Kurulum bu dosyalardaki diğer ayarlarına dokunmaz.

## Gizlilik ve güvenlik

Cortex notlarını kendi başına hiçbir yere göndermez ve telemetri toplamaz.

**Ağ istekleri.** Kendiliğinden yapılan tek istek, oturum açılışında arka planda GitHub'a sorulan "yeni sürüm var mı?" sorusudur: başarılı olursa günde en çok bir kez, başarısız olursa 1 ve 6 saat sonra yeniden denenir. Not, prompt ya da hesap bilgisi taşımaz; `preferences --update-notifications off` kapatır. Bunun dışındaki her istek senin açtığın bir şeyden gelir: Yakala'nın sayfa getirmesi, sesle yazmanın kurulumu (modeller ve paketler, yaklaşık 2 GB), uygulamadan Claude Code kurulumu (Anthropic'in `claude.ai/install.ps1` kurucusu), güncelleme, Telegram'ı açtıysan Telegram'ın sunucularına sorulan yeni mesajlar, Beyin'in canlı konuşmalarını Claude Code'la açtıysan o araç.

**Asıl akış** şudur: yazdığın mesajla eşleşen notlar asistanının bağlamına eklenir ve böylece **kullandığın yapay zeka sağlayıcısına** (Anthropic, OpenAI, Google…) gider. Sistemin amacı budur; yerel bir model kullanırsan hiçbir şey bilgisayardan çıkmaz. Neyin gitmeyeceğini sen belirlersin:

- **Tek bir not:** notun en başına şu üç satırı koy; not otomatik bağlama hiç girmez, yalnız açıkça istediğinde okunur.

  ```
  ---
  visibility: private
  ---
  ```

- **Hassas klasörler:** adında `Kasa`, `Şifre`, `Parola`, `Kimlik`, `Finans`, `Müşteri`, `Vergi`, `Fatura`, `Maaş`, `Özel`, `Gizli`, `Gizlilik`, `Private`, `Secret`, `Password`, `Credential` sözcüklerinden biri (ekleriyle: "Şifreler", "Müşterilerim") ayrı bir kelime olarak geçen klasörler ve alt klasörleri indekse hiç girmez. Türkçe harf ve büyük/küçük harf fark etmez; Obsidian'da görünmeye devam ederler. Nokta ile başlayan klasörler (`.gizli/`) de indekslenmez. Asistanın böyle bir klasördeki notu görmesini istiyorsan klasörün adını değiştir.
- **Başka bir klasörü indeks dışı tutmak:** `preferences --index-exclude-dir <ad>`. Bu bir indeks ayarıdır; gizli kalması gerekenler için yukarıdaki iki yolu kullan.
- **Ayrı kasa:** sağlık ya da finans gibi notlar için Cortex'i kurmadığın ayrı bir kasa en temiz yoldur.
- **Sır süzgeci:** `preferences --secret-filter on`, asistanın yazdığı notlarda, makbuzlarda ve görevlerde API anahtarı ve parola gibi sırları maskeler. Varsayılan kapalıdır.
- **Beyin'in canlı konuşmaları:** Claude Code'la açarsan son notlarının başlıkları ve kısa parçaları ona gider; LM Studio ya da Ollama'da bilgisayardan çıkmaz. Varsayılan kapalıdır.
- **Yakalanan içerik:** dışarıdan gelen metin veri olarak, güvenilmeyen kaynak işaretiyle tutulur; yalnız herkese açık `http(s)` adresleri getirilir, yerel ve özel ağ adresleri reddedilir. Mail, pano ve dosya kartları `visibility: private` olarak yazılır. [Ayrıntılar](docs/v3/YAKALA.md#güvenlik)
- **Telegram:** isteğe bağlıdır. Bota gönderdiğin mesajlar Telegram'ın sunucularından geçer (bot sohbetleri uçtan uca şifreli değildir); Cortex kasandan hiçbir şeyi Telegram'a göndermez, sesli notları bu bilgisayarda yazıya çevirir. Uygulamada bot anahtarı Windows'un şifreli deposunda durur; terminalden `telegram kur --token` ile verilirse yalnız senin hesabının okuyabildiği bir dosyada, şifresiz durur. [Ayrıntılar](docs/v3/TELEGRAM.md#gizlilik)
- **Masaüstü uygulaması:** pencerenin istediği izinler (kamera, konum…) reddedilir, yazım denetimi sözlükleri indirilmez.

Arama indeksi kasanın dışında, yalnız senin hesabının okuyabildiği bir klasörde durur (Windows: `%LOCALAPPDATA%\beyin-v3\…`, macOS: `~/Library/Application Support/beyin-v3/…`, Linux: `~/.local/state/beyin-v3/…`) ve notlarının bir kopyasını içerir. Kasayı herkese açık bir git deposuna koyacaksan `.beyin-runtime.json` dosyasını dışarıda bırak: bu makinedeki tam yolu içerir ([birden çok makine](docs/v3/MULTI-MACHINE.md)).

## Terminalden kurulum (macOS, Linux, geliştiriciler)

Masaüstü uygulaması Windows içindir ve gerekeni kendisi kurar. macOS ve Linux'ta, ya da uygulamasız kullanmak istersen hafıza motoru terminalden kurulur. **Gereksinim:** Python 3.11 veya üzeri ve kullandığın yapay zeka istemcisi. İki yol da mevcut notlarına dokunmaz; Cortex zaten kuruluysa notlarını koruyarak günceller.

**Yol 1: Asistanına kurdur.** Kasa klasörünü Claude Code, Codex ya da Antigravity ile aç ve şunu yapıştır:

> https://raw.githubusercontent.com/GunduzTolga/Cortex/main/beyin.md adresini oku. Bu klasöre ikinci beynimi kur. Mevcut kurulum varsa notlarımı koruyarak güncelle. Gerekli indirme ve kurulum adımlarını sen yap. Sonunda örnek bir bilgiyi kaydedip yeni oturumda geri okuyarak birlikte doğrulayalım.

Asistan kararlı paketi bulur, checksum ile doğrular, kurar ve sağlık kontrolünü çalıştırır. Sana yalnız istemcinin gösterdiği klasör ya da hook güven onayını vermek kalır.

**Yol 2: Elle kur.** [Son sürüm sayfasından](https://github.com/GunduzTolga/Cortex/releases/latest) `beyin-v3-X.Y.Z.zip` paketini ve yanındaki `.sha256` dosyasını indir (GitHub'ın otomatik "Source code" arşivini değil), bir klasöre aç ve:

```sh
python3 scripts/install_v3.py --vault "/tam/yol/Beynim"      # macOS / Linux
py -3 scripts/install_v3.py --vault "C:\Notlar\Beynim"        # Windows
```

Kurucu istemci bağlantılarını, ortak motoru, üç başlangıç skill'ini (**beyin**, **beyin-doktor**, **beyin-guncelle**) ve güncelleme kısayolunu (Windows'ta `Beyni Guncelle.cmd`, macOS'ta `Beyni Güncelle.command`, Linux'ta `Beyni Güncelle.sh`) kurar. Arama indeksi kasanın dışında tutulur; başka bir yer için `--state "/ayri/klasor"`. [Güncelleme ve runtime rehberi](docs/v3/UPDATE.md)

**Kurulumdan sonra:** kasayı istemcinde aç, hook güvenini onayla (Codex'te `/hooks`) ve asistanına *"Beyin skill'ini kullan. Beni tanımak için kısa sorular sor; cevapları kaynak notlara kaydet."* de. Sağlık kontrolü: `python3 beyin.py doctor`.

**İsteğe bağlı:**

- **`pyn` komutu:** `python3 beyin.py pyn kur` sonrası her terminalde `pyn` yazınca Pyn'in mühürlü karşılama kutusu ve bu makinede kurulu istemcilerin menüsü açılır (yeşil hazır, kırmızı kapalı; yerel modeller dahil). `pyn claude`, `pyn codex` menüsüz açar; `pyn kontrol` eski istemcileri, `pyn guncelle` Cortex'i günceller; `pyn kaldir` her şeyi geri alır.
- **Yakala:** `python3 beyin.py yakala kur` (kısayol `Ctrl+Alt+C` / `Control+Option+C`; değiştirmek için `yakala kisayol`). Sesle yazma (Windows): `py -3 beyin.py ses kur`.
- **Telegram:** `python3 beyin.py telegram kur --token <anahtar>`, sonra `telegram dinle`. Durum: `telegram durum`; kaldırmak: `telegram kaldir`.
- **Ananas teması:** `python3 beyin.py tema kur`. Obsidian için fildişi kâğıt, mürekkep kontur, sert gölgeli kartlar, Fraunces başlıklar; yazı tipleri temanın içinde gelir. `.obsidian/snippets/ananas.css` dosyasını yazar ve Obsidian'ın görünüm ayarında etkinleştirir; kenar çubuğunda klasörler sade Türkçe etiketlerle görünür, diskteki adlar değişmez. `tema kaldir` geri alır.

## Günlük kullanım ve komutlar

Notunu yaz, asistanına ne istediğini söyle. Kaynaklar oturum açılışında ve konuşmanın uygun noktalarında yeniden indekslenir. Önemli iş sonuçları kısa, kaynak bağlantılı kayıtlarla tutulur. Sohbetin tamamı kendiliğinden kalıcı bilgiye dönüşmez; kalıcı olmasını istediğin karar ve bilgiyi nota yazdır. Bir şey ters giderse asistanına **"beyin-doktor ile kontrol et"** de.

Kasa klasöründe (Windows'ta `python3` yerine `py -3`):

| İstersen | Komut |
| --- | --- |
| Son 7 günde ne yapıldı? | `python3 beyin.py recap --days 7` |
| Belirli tarih aralığı | `python3 beyin.py recap --since 2026-10-01 --until 2026-10-15` |
| Bekleyenler, unutulan görevler, haftanın notları | `python3 beyin.py triage` |
| Sağlık kontrolü | `python3 beyin.py doctor` |
| Zamanlanmış sağlık kontrolü (Görev Zamanlayıcı için) | `python3 beyin.py scheduled-check --notify` |
| Taşınan ya da başka makineden gelen kasada hook yollarını onar | `python3 beyin.py hook-reconcile` |
| Tercihleri gör | `python3 beyin.py preferences` |

`recap` ve `triage` model çağırmaz. `recap`'teki sonuçlar asistanın yazdığı iddialardır, bağımsız doğrulanmış olgular değildir.

**Hafıza dosyalarının boyutu.** `Last-Session.md` son oturumların devir kartları, `Threads.md` açık konuların güncel durumudur; varsayılan sınırlar 3.000 ve 8.000 karakter. Sınır aşılınca oturum `Memory hygiene:` uyarısıyla açılır ve asistan `beyin.py companion-compact` çalıştırır: eski bölümler kelimesi kelimesine `🔮 850-Companion/Arşiv/` altına taşınır, kararlar `Kararlar.md`'ye de eklenir. Hiçbir metin silinmez ya da özetlenmez, model çağrılmaz. [Ayrıntılar](docs/v3/COMPANION-PARITY.md)

**Tüketim.** Asistanına "ekonomik moda geç", "otomatik kontrolleri kapat" ya da "kontrol aralığını 30 dakika yap" diyebilirsin.

| Mod | Yerel kontrol | Oturuma eklenen bağlam |
| --- | --- | --- |
| Normal (varsayılan) | Her ilgili istemci olayında | Oturum başında ve mesajlarda, en çok 5.000 karakter |
| Ekonomik | Yeni oturumda; sonra en az 15 dakika arayla | Yalnız oturum başında, en çok 2.000 karakter |
| Manuel | Otomatik kapalı | Otomatik kapalı |

İsteğe bağlı: `preferences --context-dedupe on` aynı oturumda değişmemiş notları yeniden göndermez; küçük bağlamlı yerel modellerde yer açar. [Tüm tercihler](docs/v3/PREFERENCES.md)

## Güncelleme

- **Masaüstü uygulamasıyla:** yeni sürümün kurulum dosyasını indirip kur, aç; ana ekrandaki **"Cortex güncellemesi hazır"** bildiriminde **Güncelle** (ya da Ayarlar → Cortex). Sesle yazmanın paketleri değiştiyse Ayarlar → Sesle yazma → **Sesle yazmayı güncelle** de görünür.
- **Terminalden:** `pyn guncelle`, ya da kasada `python3 beyin.py update` (yalnız bakmak için `update --check`). Asistanına "beynimi güncelle" demek ya da kasadaki güncelleme kısayolu da aynı işi yapar.

Terminalden güncelleme yalnız resmi kararlı sürüm paketinden yapılır. Paket önce doğrulanır (checksum, manifest, dosya hash'leri), notlarına dokunmadan ayrı bir deneme kasasında çalıştırılır ve ancak bundan sonra uygulanır. Bir kesintiden sonra `recover`, geri dönmek için `rollback`. İnternetsiz güncelleme: `update --package "/indirilen/beyin-v3-X.Y.Z.zip"`. Güncellemeden sonra Ctrl+Alt+C dinleyicisi kendiliğinden yeniden başlar. [Güncelleme rehberi](docs/v3/UPDATE.md)

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Kurulumda "Windows bilgisayarınızı korudu" | Kurulum dosyası henüz imzasız. **Ek bilgi** → **Yine de çalıştır**. |
| "Hey Pyn" pencereyi açmıyor | Ayarlar → Sesle yazma: **Sürekli dinle** açık mı? Uyandırma sözü "Hey Pyn" ya da "İkisi de" mi (varsayılan "Pyn, not al")? Sağ alttaki simgenin menüsü mikrofonun dinleyip dinlemediğini ve hangi sözü beklediğini söyler. Ne duyduğunu görmek için: `py -3 beyin.py ses dene --uyandirma`. |
| Not al'da "Mikrofondan ses gelmiyor" | Mikrofon kapalı ya da sessizde olabilir, ya da Windows başka bir mikrofonu dinliyor: Windows ses ayarlarından doğru mikrofonu varsayılan yap. |
| Asistan notları hatırlamıyor | İstemcide hook güvenini onayladığını kontrol et, sonra asistana "beyin-doktor ile kontrol et" de ya da `beyin.py doctor` çalıştır. |
| Bir not bağlama hiç girmiyor | Notta `visibility: private` var mı, klasörünün adında "Özel", "Şifreler" gibi bir sözcük geçiyor mu? `beyin.py doctor` indeks dışı tutulanları gösterir. |
| Oturum `Memory hygiene:` uyarısıyla açılıyor | `beyin.py companion-compact` eski kayıtları silmeden arşive taşır. |
| Telegram'dan gelen sesli not yazıya çevrilmemiş | Sesli notları çevirmek için sesle yazma kurulu olmalı (Windows). Ses dosyası kartın ekinde durur. |
| YouTube kartında döküm yok | `yt-dlp` kurulu mu? `beyin.py yakala durum` eksik araçları söyler. |
| Gemini CLI `IneligibleTierError` veriyor | Google bireysel hesapla girişi kapattı; API anahtarıyla giriş yap. |
| cmd'de `pyn` çalışmıyor | `pyn kur`u yeniden çalıştır, sonra **yeni** bir terminal aç. |

**Eski bir kurulumdan geliyorsan** (Cortex'in doğduğu açık kaynak projenin eski sürümleri): aynı kurucuyu mevcut kasa üzerinde bir kez çalıştır. Notlar, companion dosyaları, `daily/` ve `knowledge/` içerikleri korunur; tanınan eski yazıcılar geri alınabilir biçimde devreden çıkarılır. [Geçiş ayrıntıları](docs/v3/MIGRATION.md)

## Sürüm geçmişi

| Sürüm | Öne çıkan |
| --- | --- |
| [1.0.32](docs/v3/releases/1.0.32.md) | Pyn sohbetinde Claude Code kasadaki notlara (Core.md dahil) sormadan yazar; başka adımlar izin kartıyla sorulur, artık sessizce reddedilmez. İlk kurulumda Claude Code yoksa uygulamadan kurulup giriş yapılır; sonradan kurulan araç ya da yapılan giriş, uygulamayı yeniden açmadan görünür. |
| [1.0.31](docs/v3/releases/1.0.31.md) | Hafıza: "dün", "geçen cuma", "12 Ekim" diye sorunca o günün günlüğü gelir; hiçbir not cevap vermezse günlüklere bakılır; para/ücret, crash/çökme gibi eşanlamlılar tutar. Öncülün 3.12 Türkçe kök bulması (kurulmalı/kuruldu, şehri/şehir) ve açılışta kişi notları. Türkçe hafıza ölçümü eklendi. |
| [1.0.30](docs/v3/releases/1.0.30.md) | Türkçe sesli komutlar daha iyi tutuyor: AMD ve Intel kartlarda Whisper en iyi beş tahmini tartıyor (NVIDIA'daki gibi); "kayd et", "son kelime sil" gibi biraz farklı yazılan komutlar da tutuyor. |
| [1.0.29](docs/v3/releases/1.0.29.md) | "Hey Pyn" bilgisayar açılınca ya da güncellemeden sonra kendiliğinden dinliyor: ses yardımcısı mikrofonu açarken bir komut gelmesini beklemiyor, sürekli dinlemeyi kapatıp açmak gerekmiyor. |
| [1.0.28](docs/v3/releases/1.0.28.md) | "Hey Pyn" kurulumdan sonraki ilk açılışta da çalışıyor: Windows'un mikrofonu sonradan değişince (kablosuz kulaklık) dinleyici yeni mikrofona geçiyor. Sessiz bir kulaklık konuşurken "Mikrofondan ses gelmiyor" uyarısı vermiyor. |
| [1.0.27](docs/v3/releases/1.0.27.md) | Yazdığını yapay zekaya göndermeden gelen kutusuna at: gönderin yanındaki düğme ya da `Ctrl+Enter`. Yerel modeller (Ollama, LM Studio) "bunu kaydet" denince gelen kutusuna ekliyor, "aklımda tutarım" demiyor. Beyin ekranı da kâğıt renginde. |
| [1.0.26](docs/v3/releases/1.0.26.md) | Telegram: telefondan kendi botuna gönderdiğin yazı, bağlantı, fotoğraf ve sesli not gelen kutusuna düşer; bilgisayar kapalıyken gönderdiklerin açılınca gelir, 24 saatten eskiler de. |
| [1.0.25](docs/v3/releases/1.0.25.md) | Öncülün 3.10 ve 3.11 motoru: BOM ve hassas klasör gizliliği, uzun Kurallar.md, daha iyi arama, Kiro, `scheduled-check`, `triage`; Yakala'da açık sayfanın bağlantısı, pano tazeliği, videonun konuşulan dili. |
| [1.0.24](docs/v3/releases/1.0.24.md) | İlk açılışta sesli uyandırma çalışmıyordu (kulaklık hazır değilken mikrofon açılamayınca kapanıyordu): artık yeniden deniyor, sonradan bağlanan kulaklığı da buluyor. |
| [1.0.23](docs/v3/releases/1.0.23.md) | Uyandırma sözü "İkisi de" olabilir; "panodaki resmi ekle" son kopyalanan görüntüyü nota ekler. |
| [1.0.22](docs/v3/releases/1.0.22.md) | Uyandırma sözü seçilebilir: "Pyn, not al" ya da "Hey Pyn"; ikisi de Not al penceresini açar, Whisper Pyn'in adını doğrular. |
| [1.0.21](docs/v3/releases/1.0.21.md) | Canlı konuşmalar düşünen modellerle de yazılıyor (qwen3.5); "Ofis" sekmesi "Beyin" oldu; sağ alttaki menüde mikrofonun durumu, Not al ve Ayarlar, her satırda simge. |
| [1.0.20](docs/v3/releases/1.0.20.md) | Ayarlar her değişikliği kaydettiğini söylüyor ("Kaydedildi"), yazılan alanların yanında Kaydet düğmesi; kurulum konum sormadan standart yere kuruluyor. |
| [1.0.19](docs/v3/releases/1.0.19.md) | Beynin içindeki ofis: harita bir beynin içinde, kıvrımlarında kıvılcımlar akar; ofis ve müdür ilk açılışta yazılan adı taşır; Cortex'i yazan Tolga kendi masasında. |
| [1.0.18](docs/v3/releases/1.0.18.md) | Ofisin canlı konuşmaları Ayarlar → Ofis'ten de seçilir: araç (LM Studio, Ollama, Claude Code; hangisinin hazır olduğu yazar), model ve sıklık; ofisin kendi ayarlarıyla aynı seçim. |
| [1.0.17](docs/v3/releases/1.0.17.md) | Masaüstü sağ altta: simgenin menüsünden "Sürekli dinle" açılıp kapanır (açıkken simgede kırmızı nokta), pencere kapanınca Cortex orada kalır ve Windows'la başlar; ofisin kişi çipleri gerçekten küçüldü. |
| [1.0.16](docs/v3/releases/1.0.16.md) | Not al: uzun not alt satıra geçer, alan dört satıra kadar büyür; "son kelimeyi sil", "son cümleyi sil", "hepsini sil" komutları; komutların sözleri masaüstünde Ayarlar → Sesle yazma'dan değişir; "Py notal" gibi bitişik yazılan uyandırma sözü nota girmez; mikrofonun adı tam görünür. |
| [1.0.15](docs/v3/releases/1.0.15.md) | Sesli komutlar düzeldi: "Pyn, not al" gerçek bir sesle de açar (küçük model "not al"ı yakalar, Pyn'in adını Whisper doğrular); cümleler arasında mikrofon kapanmaz; "Pyn, kaydet" Whisper'ın uydurduğu satırların arkasında kalmaz; "Pyn, gönder/tamam/bitti" de kaydeder; `ses dene --uyandirma` ne duyduğunu gösterir. |
| [1.0.14](docs/v3/releases/1.0.14.md) | Ofisin canlı konuşmaları gerçek: ofis ayarlarında araç (LM Studio, Ollama, Claude Code) ve model seçilir, model son notlar hakkında ekibe konuşma yazar; kişi çipleri küçüldü, hepsi sığıyor. |
| [1.0.13](docs/v3/releases/1.0.13.md) | "Pyn, not al" "payn" diye söylenince de tutar (dar gramerli dinleme); ofisin hızlanması ve büyük yazıları düzeldi; ilk kurulumda "Sürekli dinle" anahtarı; beynin içindeki ofis için Claude Design brifi. |
| [1.0.12](docs/v3/releases/1.0.12.md) | Not al baştan tasarlandı (geniş, yumuşak kenarlı mikrofon, mikrofon adı ve ses düzeyi, "mikrofondan ses gelmiyor" uyarısı); "Pyn, kaydet" diyene kadar kesintisiz dikte, sürekli dinleme; kısayol Ctrl+Alt+C; ana ekranda Cortex güncelleme bildirimi; Türkçe arayüzde İngilizce cümle kalmadı. |
| [1.0.11](docs/v3/releases/1.0.11.md) | Ctrl+Alt+B penceresi yenilendi: "Not al", yazılı mikrofon düğmesi, pencere dinler halde açılır ve ne yapacağını söyler, Enter yazıp kaydeder. İlk kurulum ekranı kayıtlı girişleri "hazır" saymaz; kurulum sihirbazı Pyn'in görselleriyle. |
| [1.0.10](docs/v3/releases/1.0.10.md) | Masaüstü uygulaması her şeyi kendisi kurar: ilk kurulum ekranı (hitap, kasa, Python, Pyn'in hafızası, yapay zeka aracı, sesle yazma), kurulum dosyasıyla gelen Python, Ayarlar'da Cortex ve sesle yazma. Ofis kullanıcıya adıyla seslenir. |
| [1.0.9](docs/v3/releases/1.0.9.md) | Sesle yazma AMD Radeon ve Intel Arc kartlarda da ekran kartında (whisper.cpp, Vulkan); NVIDIA'da CUDA, olmazsa işlemci. Pyn'in yeni yüzü: Claude Design'ın vektör çizimi, sohbette ve Obsidian'da. |
| [1.0.8](docs/v3/releases/1.0.8.md) | Masaüstü uygulaması (önizleme): Pyn sohbeti (Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code; yerel modeller için LM Studio ve Ollama), Obsidian'sız notlar, grafik, araç girişleri ve API anahtarları, ayarlar. Yakala'da isteğe bağlı sesle yazma ve "Pyn, not al" (yerel Whisper). |
| [1.0.7](docs/v3/releases/1.0.7.md) | Yakala güvenliği (yalnız herkese açık adresler, Windows komut satırı koruması), Türkçe karakterli kısayollar, `Win+Shift+S` ekran görüntüsü; daha hızlı senkron; `pyn` yeni sürümü haber verir, `pyn guncelle`; marka kuralları. |
| [1.0.6](docs/v3/releases/1.0.6.md) | `pyn kur` Claude Code'a Pyn durum satırı, Windows Terminal'e Pyn profili ekler; menüde yeşil/kırmızı durum noktaları; `pyn kontrol` eski istemcileri bulur; OpenCode 2.x'te de önbellek korunur. |
| [1.0.5](docs/v3/releases/1.0.5.md) | `pyn` karşılama kutusu ve mühürle açılır, cmd'de de çalışır; OpenCode'da önbellek korunur, yerel modeller OpenCode'da açılır. |
| [1.0.4](docs/v3/releases/1.0.4.md) | Gemini CLI ve Qwen Code tam hafızalı. |
| [1.0.3](docs/v3/releases/1.0.3.md) | Yeni `pyn` komutu: Pyn'i her yerden, istediğin istemciyle aç. |
| [1.0.2](docs/v3/releases/1.0.2.md) | Windows'ta yakala penceresi anında açılır, Ananas yazı tipleriyle. |
| [1.0.1](docs/v3/releases/1.0.1.md) | Pyn görünür oldu: Obsidian'da klasör ikonları, mühür ve Pyn'in yüzü. |
| [1.0.0](docs/v3/releases/1.0.0.md) | Cortex: Ananas teması, maskot Pyn, güncellemeler Cortex'in kendi sürümlerinden. |

## Geliştiriciler

[Kaynak formatı](docs/v3/MARKDOWN.md) · [Runtime](docs/v3/RUNTIME.md) · [Semantik test sözleşmesi](docs/v3/SEMANTIC-TEST-CONTRACT.md) · [Sürüm paketi ve güncelleyici](docs/v3/UPDATE.md) · [Birden çok makine](docs/v3/MULTI-MACHINE.md) · [Tercihler](docs/v3/PREFERENCES.md) · [Yakala](docs/v3/YAKALA.md) · [Telegram](docs/v3/TELEGRAM.md) · [OpenCode](docs/v3/OPENCODE.md) · [Hermes](docs/v3/HERMES.md) · [OMP](docs/v3/OMP.md) · [Kiro](docs/v3/KIRO.md) · [Yakalama sunucusu](docs/v3/INGEST-SERVER.md) · [Masaüstü uygulaması](desktop/README.md)

- **Motor:** `template/.claude/scripts/` altında, yalnız Python standart kütüphanesiyle. Sesle yazma kendi sanal ortamında (`state/ses/venv`) çalışan ayrı bir yardımcıdır; motor onun paketlerini içe almaz.
- **Masaüstü uygulaması:** `desktop/` altında Electron, React ve TypeScript. Yalnız Windows için derlenir (NSIS kurulum dosyası); kod büyük ölçüde macOS ve Linux'ta da çalışır ama orada kurulum dosyası ve CI yoktur.
- **Testler:** motor her sürümde Windows, macOS ve Linux'ta, Python 3.11 ve 3.13 ile 1.700'ü aşkın otomatik testle ve anlamsal senaryolarla doğrulanır; masaüstü uygulamasının ayrıca birim ve uçtan uca testleri vardır. Gerçek istemci kontrolleri [ayrı raporlanır](docs/v3/README.md).

Arama yerel kelime eşleştirmesi kullanır; genel doğal dil anlama ya da her soruda doğru hatırlama sözü vermez.

## In English

**Cortex is a local, persistent second brain for AI assistants.** Your notes stay on your computer as plain Markdown files, and Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Kiro and local models (LM Studio, Ollama) share the same memory: relevant notes are added to the assistant's context at session start and with each message, finished work is recorded as short source-linked receipts, and corrections you make become rules the next session already knows. The engine is a standard-library Python program that calls no model on its own, needs no account or server, and collects no telemetry.

- **Windows desktop app:** a no-terminal setup (it brings Python if needed and installs everything from its first-run screen), chat with your own AI tool inside your notes, a note editor and graph, and *Beyin*, a living pixel-art office inside a brain.
- **Take a note anywhere:** `Ctrl+Alt+C` opens a small window over any app; on Windows, saying "Pyn, not al" or "Hey Pyn" opens it too (with always-listen on). Type or dictate, then say "Pyn, kaydet". Speech is transcribed locally by Whisper (CUDA, Vulkan or CPU) and never leaves the computer.
- **Capture:** save the open browser page, a screenshot, a video, an article or a file with one key; your assistant extracts the text and links the lessons into your notes.
- **From your phone:** send a text, a link, a photo, a file or a voice note to your own Telegram bot and it lands in the vault's inbox; voice notes are transcribed on your computer, and what you send while it is off arrives when it is on again.
- **Privacy:** notes marked `visibility: private` and folders named like "Private", "Secret" or "Passwords" never enter automatic context. The only automatic network request is an update check against GitHub, which can be turned off.

The interface and documentation are in Turkish (the desktop app also has an English interface). Download the Windows installer from the [latest release](https://github.com/GunduzTolga/Cortex/releases/latest); on macOS and Linux, install the engine with `python3 scripts/install_v3.py --vault <folder>` from the release package. The installer is not code-signed yet, so Windows SmartScreen may ask you to confirm (**More info → Run anyway**). The app does not update itself: install a new version over the old one, then press **Güncelle** to update the vault's engine.

## Lisans ve marka

Kod açık kaynaktır: [MIT lisansı](LICENSE). Kullanabilir, değiştirebilir ve dağıtabilirsin. **Cortex** ve **Pyn** adları, Pyn'in mührü ve logo dosyaları ise lisansın dışındadır: değiştirilmiş bir sürümü kendi adınla ve kendi görsellerinle yayınla. Neyin serbest olduğu: [MARKA.md](MARKA.md).

Bilgi derleme fikri için [Karpathy'nin bilgi tabanı desenine](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) teşekkürler.

---

<p align="center">
  <img src="tema/ananas/marka/pyn-muhur-56.png" width="28" alt=""><br>
  <b>Cortex</b>, <a href="https://solelunatech.com"><b>SoleLuna Tech</b></a> tarafından geliştirilir.
</p>
