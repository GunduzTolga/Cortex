# Cortex kullanım rehberi

Cortex'in her parçasının ayrıntılı anlatımı: masaüstü uygulaması, Not al ve sesle yazma, Yakala, Telegram, günlük komutlar, gizlilik, terminalden kurulum, güncelleme ve sorun giderme. Kısa tanıtım ve hızlı başlangıç için [README](../README.md).

## İçindekiler

- [Kurulum ekranı](#kurulum-ekranı)
- [Masaüstü uygulaması](#masaüstü-uygulaması)
- [Not al ve sesle yazma](#not-al-ve-sesle-yazma)
- [Yakala: tek tuşla beyne at](#yakala-tek-tuşla-beyne-at)
- [Telegram: telefondan gelen kutusuna](#telegram-telefondan-gelen-kutusuna)
- [Sunucu: kasayı eşitlemek](#sunucu-kasayı-eşitlemek)
- [Günlük kullanım ve komutlar](#günlük-kullanım-ve-komutlar)
- [Gizlilik ve güvenlik](#gizlilik-ve-güvenlik)
- [Terminalden kurulum (macOS, Linux, geliştiriciler)](#terminalden-kurulum-macos-linux-geliştiriciler)
- [Güncelleme](#güncelleme)
- [Sorun giderme](#sorun-giderme)

---

## Kurulum ekranı

Masaüstü uygulaması ilk açılışta Pyn'in ilk kurulum ekranıyla açılır. Adımlar sırayla:

1. **Hitap:** sana nasıl seslenmesini istediğini sorar (atlanabilir).
2. **Kasa:** notlarının duracağı klasörü seçersin; mevcut bir Obsidian kasası da olabilir. Zorunlu tek adım budur.
3. **Python:** yalnız bilgisayarında Python yoksa görünür. Uygulamayla gelen Python 3.12, yalnız senin kullanıcın için kurulur.
4. **Pyn'in hafızası:** hafıza motoru kasaya kurulur; notlarına dokunulmaz.
5. **Yapay zeka aracın:** bilgisayarında kurulu araçları (Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code) listeler; her birinin yanında giriş düğmesi, ayrıca API anahtarı girme düğmesi vardır. Claude Code'u Anthropic'in kendi kurucusu bir pencerede kurar. OpenCode, Codex, Gemini CLI ve Qwen Code'u Cortex kendisi kurar: aracı yapanın paketini indirir, denetler ve kendi klasörüne açar. Node.js, npm ya da yönetici izni gerekmez. Sohbette yalnız burada eklediğin araçlar görünür. **Yapay zeka araçları** penceresinde eklenmemiş her aracın yanında **Ekle** düğmesi var: araç kurulu değilse Cortex indirip kurar, sonra girişi açılır (Gemini CLI ve Qwen Code'da API anahtarı istenir). Eklenen araç girişliyse yeşil **Giriş yapıldı** der; yanında her zaman **Giriş yap** / **Yeniden giriş yap** ve **Sil** düğmeleri durur. **Sil**, aracın girişini bu bilgisayardan siler (aracın kendi çıkış komutuyla), aracı sohbetten kaldırır ve Cortex'in indirdiği programı siler. Claude Code ya da kendi kurduğun bir araç bilgisayarda kalır. Terminalde de kullandığın bir aracı silersen orada da yeniden giriş yapman gerekir. Bir araç sorun çıkarırsa **Sil**, sonra **Ekle** ile sıfırdan kurulur. Claude Code, Claude Pro ya da Max aboneliği ister. Uygulamayı yeniden açman gerekmez; sonradan kurduğun bir araç da pencereye döndüğünde görünür.
6. **Sesle yazma:** isteğe bağlıdır, tek düğmeyle kurulur (bilgisayara göre yaklaşık 1–3 GB indirme). Kurulumdan önce mikrofon izni sorulur. Kurulunca **Sürekli dinle** ve **Pencere açılınca dinle** anahtarları görünür; **Sürekli dinle** açılırken izin ayrıca sorulur.

Her adım ne yaptığını söyler; isteğe bağlı adımlar **Atla** ile geçilir ve sonra Ayarlar'dan yapılır. İlk kurulum ekranı Ayarlar'dan yeniden açılabilir.

## Masaüstü uygulaması

Üst çubukta dört sekme vardır:

- **Pyn:** kasanın içinde, kendi yapay zeka aracınla sohbet. Araç kasada başladığı için hafıza tam gelir. Yeni sohbette aracı seçince model, mod ve efor düğmeleri ilk mesajdan önce gelir; burada seçtiğin model ilk mesajda kullanılır.
  - **Araçlar:** Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code; yerel modeller için LM Studio ve Ollama; bir de başka bir bilgisayarda (örneğin evdeki sunucuda) çalışan **Sunucudaki Pyn**: telefonda başlayan bir konuşma masaüstünden sürdürülür (Ayarlar → Yapay zeka araçları). Yerel modeli kendi uygulamasında yüklersin, Cortex onunla doğrudan konuşur; "bunu kaydet" dersen yerel model de gelen kutusuna ekler (7–8 milyar parametre ve üstü modeller bunu güvenilir yapar).
  - **Gelen kutusuna at** (`Ctrl+Enter`): gönder düğmesinin yanındadır; yazdığını yapay zekaya göndermeden `📥 000-Inbox/Yakala/`'ya kaydeder.
  - Model, mod ve düşünme düzeyi çiplerle seçilir; aracın izin istediği adımlar kartla sorulur; bağlamın ne kadar dolduğunu yazma kutusundaki halka gösterir.
  - Claude Code kasadaki notlara sormadan yazar; kasanın dışındaki dosyalar ve komutlar için izin kartı çıkar. Claude Code kendi ayar ve hook dosyalarını (`.claude/`) yine sorar.
  - Sohbetin okuduğu, değiştirdiği ya da andığı notlar yan panelde açılır.
- **Notlar:** Obsidian'a gerek kalmadan okuma ve yazma: wiki bağlantıları, canlı önizleme, geri bağlantılar, etiketler, üstüne gelince önizleme, arama (`tag:` ve `path:` ile), hızlı geçiş (`Ctrl+K`), şablonlar ve geri alınabilir çöp kutusu. Makbuzlar ve motorun ürettiği sayfalar salt okunurdur.
- **Grafik:** notların ve aralarındaki bağlantılar; bir notun çevresini gösteren yerel grafik, makbuzları göster/gizle.
  - Yanındaki **rehber** haritanın ne gösterdiğini anlatır ve sayıları verir: not, bağlantı, bağlantısız, yazılmamış.
  - Bir klasörün rengine tıklayınca yalnız o klasörün notları öne çıkar.
  - **Bağlantı bekleyenler** hiçbir notla bağı olmayan notlardır. **Pyn'e bağlat**, sohbetin yazma kutusuna onları bağlaması için bir istek yazar; isteği okuyup sen gönderirsin.
  - **Yazılmayı bekleyenler** notlarda adı geçen ama henüz yazılmamış notlardır; tıklayınca not oluşur. Haritada yazılmamış bir noktaya tıklamak da aynısını yapar.
  - **En çok bağlananlar** kasanın ana konularıdır.
- **Beyin:** bir beynin içine çizilmiş, yaşayan bir piksel sanatı ofis; kıvrımlarında kıvılcımlar akar.
  - Patron Pyn, ilk açılışta yazdığın adı taşıyan müdür, Cortex'i yazan geliştirici Tolga, 12 kişilik ekip ve kedi Tekir dokuz odada çalışır; karakterlere ve odalara tıklanır.
  - Sunucu odasının ışıkları araçlarının gerçek giriş durumunu, odalar kasanın sayılarını gösterir; ofisin ışığı günün saatine uyar.
  - İstersen ekip son notların hakkında konuşur: Ayarlar → Beyin'den (ya da Beyin ekranının kendi ayarlarından) bir araç (LM Studio, Ollama ya da Claude Code), model ve sıklık (10–60 dakika) seçersin. Varsayılan kapalıdır.

**Sağ alttaki simge.** Pencereyi kapatınca Cortex bildirim alanında kalır ve Windows'la birlikte açılır; Telegram dinleyicisi de orada çalışmaya devam eder. Simgenin menüsü: mikrofonun durumu, **Sürekli dinle** aç/kapat (sesle yazma kuruluysa), **Not al**, **Cortex'i aç**, **Ayarlar**, **Çık**. **Sürekli dinle** yalnız Cortex çalışırken dinler: **Çık**'a basınca mikrofon birkaç saniye içinde kapanır. Mikrofon dinlerken pencereyi kapatırsan Cortex bunu her seferinde söyler. İstemezsen Ayarlar → Genel → *Sağ altta çalışmaya devam et*. Uygulama tek kopya çalışır; ikinci kez açınca mevcut pencere öne gelir.

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

**Uygulamanın güncellenmesi.** Kurulu uygulama kendini günceller: yeni sürümü arka planda indirir, **"Cortex X hazır"** der ve **Yeniden başlat**'a basınca ya da bir sonraki kapanışta kurar; **Ayarlar › Hakkında › Güncellemeleri kendiliğinden indir** ile kapatılır (ayrıntı: [Güncelleme](#güncelleme)). Yeni uygulama açılınca kasadaki hafıza motoru uygulamanınkinden eskiyse onu da sormadan, uygulamanın içinden gelen paketle günceller; internete çıkmaz, notlarına dokunmaz. Motor güncellemesi olmazsa **"Kasadaki Cortex … güncellenemedi"** bildirimi ve **Güncelle** düğmesi çıkar (dişlide altın bir nokta da belirir). Cortex'ten önceki bir kurulumu Cortex'e geçirmek ise sorulur.

Kendin derlemek ve ayrıntılar için: [desktop/README.md](../desktop/README.md).

## Not al ve sesle yazma

**Not al** penceresi her uygulamanın üstünde açılır: `Ctrl+Alt+C` (macOS'ta `Control+Option+C`) ya da Windows'ta sağ alttaki simgenin menüsünden **Not al**. Yaz ya da konuş; `Enter` kaydeder, `Esc` vazgeçer. Not kasanın `📥 000-Inbox/Yakala/` klasörüne düşer. Kısayol `beyin.py yakala kisayol` ile değişir.

**Sesle yazma (yalnız Windows, isteğe bağlı).** İlk kurulum ekranından ya da Ayarlar → Sesle yazma'dan tek düğmeyle kurulur.

- **Yaz ve kaydet.** Pencere açılınca dinlemeye başlar (Ayarlar → *Pencere açılınca dinle*). Konuş, ara verebilirsin; cümleler alana yazılır. Bitince **"kaydet"** ya da **"Pyn, kaydet"** de. Pyn'in adından sonra **"gönder"**, **"tamam"**, **"bitti"** ve **"bitir"** de kaydeder. Klavyeden yazmaya başlarsan mikrofon kapanır; `Ctrl+Alt+C`'ye yeniden basmak dinlemeyi bitirir; uzun süre kimse konuşmazsa mikrofon kendiliğinden kapanır.
- **Sesle açma.** **Sürekli dinle** açıkken (varsayılan kapalı; sağ alttaki menüden ya da Ayarlar'dan açılır, açarken mikrofon izni sorulur; yalnız Cortex çalışırken dinler) uyandırma sözü pencereyi açar. Söz seçilebilir: **"Pyn, not al"**, **"Hey Pyn"** ya da **ikisi de** (varsayılan; Ayarlar → Sesle yazma → Uyandırma sözü). Whisper "Hey Pyn"i "Heypin", "Hey pin" gibi bitişik ya da farklı yazsa da söz tutar. Sözü önce küçük bir yerel model (Vosk) yakalar, Pyn'in adını ardından yerel Whisper doğrular; sohbetteki bir "hey" ya da "not al" pencere açmaz.
- **Sesli komutlar** (sözleri Ayarlar → Sesle yazma → Sesli komutlar'dan değişir):

  | Komut | Varsayılan sözler |
  | --- | --- |
  | Kaydet | "kaydet"; Pyn'in adıyla "gönder", "tamam", "bitti", "bitir" |
  | Panodaki görüntüyü ekle | "panodaki resmi ekle", "resmi ekle", "görüntüyü ekle", "ekran görüntüsünü ekle" |
  | Son kelimeyi / son cümleyi sil | "son kelimeyi sil", "son cümleyi sil" |
  | Hepsini sil | "hepsini sil", "tümünü sil", "hepsini temizle", "sil", "temizle" |
  | Vazgeç | "iptal", "vazgeç" |

- **Biraz farklı yazılan komutlar da tutar:** Whisper bir komutu boşlukları başka yerde yazarsa ("kayd et", "son cümle yi sil") ya da silme komutlarında bir eki yutarsa ("son kelime sil", "hepsi sil") komut yine çalışır. "notu kaydettim" ya da "son kelimeyi sildim" gibi cümleler komut sayılmaz, nota yazılır.
- **Ses bilgisayardan çıkmaz ve diske yazılmaz;** yerel Whisper yazıya döker.
  - NVIDIA kartlarda CUDA, AMD Radeon ve Intel Arc kartlarda Vulkan (whisper.cpp) ile ekran kartında çalışır; ikisi de yoksa işlemcide çalışır. Vulkan'da model, large-v3-turbo'nun 8 bitlik yarı boyutlu sürümüdür (yaklaşık 870 MB; 1.0.39'dan beri).
  - İşlemcide hızlı `small` modeli yazar; "Hey Pyn"i küçük ayrı bir model doğrular. Dinleyici başladıktan sonraki ilk kullanımda modellerin belleğe yüklenmesi zaman alır; yüklendikten sonra pencere çabuk açılır.
  - Daha doğru ama işlemcide yavaş modeli Ayarlar → Sesle yazma → **Yazı modeli**'nden seçebilirsin.
  - Uygulama hemen açılır, ses arka planda hazırlanır. Ayarlar → Sesle yazma'daki çubuk modelin ne kadarının indiğini ya da yüklendiğini gösterir. Sağ alttaki simge de "Ses hazırlanıyor…" der. Hazırlık uzun sürerse bildirim gelir; hazır olunca "Pyn hazır" der. Kablosuz kulaklık sonradan bağlansa ya da Windows'un varsayılan mikrofonu değişse de dinleyici yeni mikrofona kendiliğinden geçer.
- **Bir kez kurulur.** Paketler ve modeller kullanıcının tek ses klasöründe durur (`%LOCALAPPDATA%\beyin-v3\ses`); bütün kasalar onu kullanır, başka bir kasaya geçince ses yeniden inmez. Kurulum olmazsa nedeni tek cümleyle söylenir (internet yok, disk dolu); ayrıntısı aynı klasördeki `kurulum.log` dosyasında.

[Ayrıntılar](v3/YAKALA.md#sesle-yazma-windows-isteğe-bağlı)

## Yakala: tek tuşla beyne at

Gördüğün sayfayı, videoyu, tweet'i, makaleyi ya da dosyayı aynı `Ctrl+Alt+C` penceresiyle yakala. Kart `📥 000-Inbox/Yakala/`'ya düşer. Sonra asistanına **"yakalananları işle"** de: motor metni çıkarır, asistan derslerini `knowledge/` notlarına bağlar ve kartı kapatır. Aynı sayfayı ya da videoyu yeniden yakalarsan yeni kart açılmaz, eskisine eklenir; kart daha önce işlendiyse yeni isteğin için yeniden sıraya girer.

- **Tarayıcıdaki sayfa:** Windows'ta Chrome, Edge, Brave, Vivaldi, Opera ya da Chromium; macOS'ta Chrome, Arc, Brave, Edge ya da Safari öndeyken kısayola basarsan açık sayfanın bağlantısı gelir. Pencerede **Bu sayfayı nota bağla** işaretlidir; `Alt+S` ile kaldırırsan not düz not olarak kaydedilir. Firefox'un adresi okunamaz.
- **Ekran görüntüsü (Windows):** `Win+Shift+S` ile alan seç, sonra kısayola bas; görüntü küçük resmiyle nota eklenir. Son 10 dakikada alınmışsa işaretli gelir, daha eskiyse `Tab` ile eklenir.
- **Pano (Windows):** son beş dakikada kopyaladığın ve henüz kaydetmediğin metin ya da bağlantı nota işaretli gelir. Daha eski bir kopya (saatler önceki bir parola gibi) pencerede görünür ama `Tab` ile eklemeden nota girmez. "Pyn, not al" ile açılan pencere panodan hiçbir şeyi kendiliğinden almaz.
- **YouTube:** döküm videoda konuşulan dilde alınır. Bunun için bilgisayarda `yt-dlp` olmalıdır; altyazı yoksa ses yalnız yerelde bir Whisper komutuyla yazıya dökülür. Bu araçlar yoksa kart başlık ve açıklamayla kalır. Hangi araçların kurulu olduğunu `beyin.py yakala durum` söyler.
- **Dosyalar:** Windows'ta dosyaya sağ tık → Gönder → **Beyne At**; macOS'ta Finder'da dosyayı seçip kısayola bas.
- **Tarayıcı eklentisi:** Obsidian Web Clipper'ın **"Beyne at"** şablonu; giriş isteyen sayfalar da yakalanır.
- Yakala'yı terminalden kurarsan `beyin.py yakala kur` (masaüstü uygulaması bunu sesle yazmayla birlikte kendisi kurar).

[Ayrıntılar](v3/YAKALA.md)

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

[Ayrıntılar](v3/TELEGRAM.md)

## Sunucu: kasayı eşitlemek

Aynı kasayı birkaç bilgisayarda ve bir sunucuda kullanıyorsan, masaüstü uygulaması onu bağlı olduğu git deposuyla (örneğin GitHub'daki özel bir depo) eşitleyebilir. Kasa bunun için o deponun bir kopyası olmalı ve Git gerekir. Windows'ta Git kurulu değilse Cortex kendi küçük Git'ini (MinGit, yaklaşık 40 MB; yalnız Cortex kullanır) indirir: **GitHub ile bağlan** bunu kendisi yapar, kendi bağladığın bir depoda **Ayarlar › Sunucu**'daki **Git'i indir** düğmesine basarsın. macOS ve Linux'ta Git'i kendin kurarsın. O zaman **Ayarlar › Sunucu**'da **Kasayı eşitle** anahtarı çıkar; varsayılan kapalıdır ve kapalıyken hiçbir şey bilgisayardan çıkmaz.

- **Ne zaman:** uygulama açılınca, beş dakikada bir, kasada bir dosya değişince (yarım dakika sonra) ve uygulama kapanırken. **Şimdi eşitle** hemen yapar.
- **Nasıl:** yeni satırlarda sır taraması, sonra commit, `pull --rebase`, push. Token, API anahtarı ya da parola bulunursa hiçbir şey gönderilmez; hangi dosyanın hangi satırı olduğu söylenir (sırrın kendisi değil). Bilerek yazılmış bir örnekse satıra `sir-tarama:izin` yaz.
- **Çakışma:** iki yerde aynı notun aynı yeri değiştiyse eşitleme geri çekilir; hiçbir şeyin üstüne yazılmaz ve bildirim gelir. Pyn'e "kasa çakışmasını çöz" demek yeter.
- **İnternet yokken** notlar burada kalır, bağlanınca gider.
- Hangi dosyaların eşitlenip hangilerinin her makinede ayrı kaldığı: [Birden çok makine](v3/MULTI-MACHINE.md).

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

**Hafıza dosyalarının boyutu.** `Last-Session.md` son oturumların devir kartları, `Threads.md` açık konuların güncel durumudur; varsayılan sınırlar 3.000 ve 8.000 karakter. Sınır aşılınca oturum `Memory hygiene:` uyarısıyla açılır ve asistan `beyin.py companion-compact` çalıştırır: eski bölümler kelimesi kelimesine `🔮 850-Companion/Arşiv/` altına taşınır, kararlar `Kararlar.md`'ye de eklenir. Hiçbir metin silinmez ya da özetlenmez, model çağrılmaz. [Ayrıntılar](v3/COMPANION-PARITY.md)

**Tüketim.** Asistanına "ekonomik moda geç", "otomatik kontrolleri kapat" ya da "kontrol aralığını 30 dakika yap" diyebilirsin.

| Mod | Yerel kontrol | Oturuma eklenen bağlam |
| --- | --- | --- |
| Normal (varsayılan) | Her ilgili istemci olayında | Oturum başında ve mesajlarda, en çok 5.000 karakter |
| Ekonomik | Yeni oturumda; sonra en az 15 dakika arayla | Yalnız oturum başında, en çok 2.000 karakter |
| Manuel | Otomatik kapalı | Otomatik kapalı |

İsteğe bağlı: `preferences --context-dedupe on` aynı oturumda değişmemiş notları yeniden göndermez; küçük bağlamlı yerel modellerde yer açar. [Tüm tercihler](v3/PREFERENCES.md)

## Gizlilik ve güvenlik

Cortex notlarını kendi başına hiçbir yere göndermez ve telemetri toplamaz.

**Ağ istekleri.** Kendiliğinden yapılan istekler yalnız güncelleme içindir ve ikisi de GitHub'a gider; not, prompt ya da hesap bilgisi taşımazlar:

- **Hafıza motoru:** oturum açılışında arka planda "yeni sürüm var mı?" diye sorar: başarılı olursa günde en çok bir kez, başarısız olursa 1 ve 6 saat sonra yeniden denenir. Bir şey indirmez; `preferences --update-notifications off` kapatır.
- **Windows masaüstü uygulaması (kurulu sürüm):** açıldıktan yarım dakika sonra ve çalıştığı sürece 6 saatte bir sorar. Yeni sürüm varsa kurulum dosyasını (yaklaşık 160 MB) sormadan arka planda indirir ve SHA-512 özetini denetler; ne zaman kurulacağı [Güncelleme](#güncelleme) bölümünde. **Ayarlar › Hakkında › Güncellemeleri kendiliğinden indir** kapalıyken ne sorar ne indirir (ortam değişkeni `CORTEX_NO_UPDATE` de aynı işi görür).

Bunun dışındaki her istek senin açtığın bir şeyden gelir: Yakala'nın sayfa getirmesi, sesle yazmanın kurulumu (modeller ve paketler, bilgisayara göre yaklaşık 1–3 GB), uygulamadan Claude Code kurulumu (Anthropic'in `claude.ai/install.ps1` kurucusu), güncelleme, Telegram'ı açtıysan Telegram'ın sunucularına sorulan yeni mesajlar, Beyin'in canlı konuşmalarını Claude Code'la açtıysan o araç.

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
- **Yakalanan içerik:** dışarıdan gelen metin veri olarak, güvenilmeyen kaynak işaretiyle tutulur; yalnız herkese açık `http(s)` adresleri getirilir, yerel ve özel ağ adresleri reddedilir. Mail, pano ve dosya kartları `visibility: private` olarak yazılır. [Ayrıntılar](v3/YAKALA.md#güvenlik)
- **Telegram:** isteğe bağlıdır. Bota gönderdiğin mesajlar Telegram'ın sunucularından geçer (bot sohbetleri uçtan uca şifreli değildir); Cortex kasandan hiçbir şeyi Telegram'a göndermez, sesli notları bu bilgisayarda yazıya çevirir. Uygulamada bot anahtarı Windows'un şifreli deposunda durur; terminalden `telegram kur --token` ile verilirse yalnız senin hesabının okuyabildiği bir dosyada, şifresiz durur. [Ayrıntılar](v3/TELEGRAM.md#gizlilik)
- **Masaüstü uygulaması:** pencerenin istediği izinler (kamera, konum…) reddedilir, yazım denetimi sözlükleri indirilmez.

Arama indeksi kasanın dışında, yalnız senin hesabının okuyabildiği bir klasörde durur (Windows: `%LOCALAPPDATA%\beyin-v3\…`, macOS: `~/Library/Application Support/beyin-v3/…`, Linux: `~/.local/state/beyin-v3/…`) ve notlarının bir kopyasını içerir. Kasayı herkese açık bir git deposuna koyacaksan `.beyin-runtime.json` dosyasını dışarıda bırak: bu makinedeki tam yolu içerir ([birden çok makine](v3/MULTI-MACHINE.md)).

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

Kurucu istemci bağlantılarını, ortak motoru, üç başlangıç skill'ini (**beyin**, **beyin-doktor**, **beyin-guncelle**) ve güncelleme kısayolunu (Windows'ta `Beyni Guncelle.cmd`, macOS'ta `Beyni Güncelle.command`, Linux'ta `Beyni Güncelle.sh`) kurar. Arama indeksi kasanın dışında tutulur; başka bir yer için `--state "/ayri/klasor"`. [Güncelleme ve runtime rehberi](v3/UPDATE.md)

**Kurulumdan sonra:** kasayı istemcinde aç, hook güvenini onayla (Codex'te `/hooks`) ve asistanına *"Beyin skill'ini kullan. Beni tanımak için kısa sorular sor; cevapları kaynak notlara kaydet."* de. Sağlık kontrolü: `python3 beyin.py doctor`.

**İsteğe bağlı:**

- **`pyn` komutu:** `python3 beyin.py pyn kur` sonrası her terminalde `pyn` yazınca Pyn'in mühürlü karşılama kutusu ve bu makinede kurulu istemcilerin menüsü açılır (yeşil hazır, kırmızı kapalı; yerel modeller dahil). `pyn claude`, `pyn codex` menüsüz açar; `pyn kontrol` eski istemcileri, `pyn guncelle` Cortex'i günceller; `pyn kaldir` her şeyi geri alır.
- **Yakala:** `python3 beyin.py yakala kur` (kısayol `Ctrl+Alt+C` / `Control+Option+C`; değiştirmek için `yakala kisayol`). Sesle yazma (Windows): `py -3 beyin.py ses kur`.
- **Telegram:** `python3 beyin.py telegram kur --token <anahtar>`, sonra `telegram dinle`. Durum: `telegram durum`; kaldırmak: `telegram kaldir`.
- **Ananas teması:** `python3 beyin.py tema kur`. Obsidian için fildişi kâğıt, mürekkep kontur, sert gölgeli kartlar, Fraunces başlıklar; yazı tipleri temanın içinde gelir. `.obsidian/snippets/ananas.css` dosyasını yazar ve Obsidian'ın görünüm ayarında etkinleştirir; kenar çubuğunda klasörler sade Türkçe etiketlerle görünür, diskteki adlar değişmez. Her güncellemeden sonra kendiliğinden yeni sürüme yenilenir (elle: `tema yenile`); Obsidian'da kapattıysan kapalı kalır. `tema kaldir` geri alır. Yazı tiplerinin lisansı (SIL Open Font License 1.1) CSS'in başında yazılıdır.

## Güncelleme

- **Masaüstü uygulaması kendini günceller** (1.0.43'ten beri): açıldıktan yarım dakika sonra ve 6 saatte bir GitHub'a sorar; yeni bir sürüm yayımlandıysa kurulum dosyası (yaklaşık 160 MB) sormadan arka planda iner, pencerede **"Cortex X hazır"** çıkar; **Yeniden başlat**'a basınca kurulup yeniden açılır, basılmazsa Cortex kapanırken ya da bilgisayarın bir sonraki açılışında, sen Cortex'i açmadan önce kendiliğinden kurulur (1.0.61'den beri). Yalnız yayımlanmış sürümler gelir.
  - **Kapatmak için:** Ayarlar › Hakkında › **Güncellemeleri kendiliğinden indir**. Kapalıyken Cortex GitHub'a hiç sormaz; yeni sürümü aynı yerdeki **Sürümler sayfası** bağlantısından indirip üstüne kurarsın (notlara ve ayarlara dokunulmaz).
  - **İnmezse:** bulunan bir sürüm inmezse Cortex 10 dakika sonra bir kez daha dener; art arda iki denemede indirilemezse **"Cortex X indirilemedi"** bildirimi çıkar: bağlantını kontrol et ya da kurulum dosyasını sürümler sayfasından elle indir.
- **Kasadaki motor:** yeni uygulama açılınca kendiliğinden güncellenir; olmazsa çıkan bildirimde **Güncelle** (ya da Ayarlar → Cortex). Sesle yazmanın paketleri değiştiyse Ayarlar → Sesle yazma → **Sesle yazmayı güncelle** de görünür; AMD / Intel ekran kartında eski 1,6 GB'lık ses modeli kullanılıyorsa aynı yerde **Daha hafif ses modelini al** çıkar.
- **Terminalden:** `pyn guncelle`, ya da kasada `python3 beyin.py update` (yalnız bakmak için `update --check`). Asistanına "beynimi güncelle" demek ya da kasadaki güncelleme kısayolu da aynı işi yapar.

Terminalden güncelleme yalnız resmi kararlı sürüm paketinden yapılır. Paket önce doğrulanır (checksum, manifest, dosya hash'leri), notlarına dokunmadan ayrı bir deneme kasasında çalıştırılır ve ancak bundan sonra uygulanır. Bir kesintiden sonra `recover`, geri dönmek için `rollback`; kesintiden sonra bir notu ya da bir izin ayarını değiştirmiş olman kurtarmayı durdurmaz. Kurulu sürüm yayımlanmış son sürümden ileride olabilir (uygulamayla gelen sürüm henüz yayımlanmamışsa); `update` bunu `ahead` diye söyler, geri almak gerekmez. İnternetsiz güncelleme: `update --package "/indirilen/beyin-v3-X.Y.Z.zip"`. Güncellemeden sonra Ctrl+Alt+C dinleyicisi kendiliğinden yeniden başlar. [Güncelleme rehberi](v3/UPDATE.md)

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Kurulumda "Windows bilgisayarınızı korudu" | Kurulum dosyası henüz imzasız. **Ek bilgi** → **Yine de çalıştır**. |
| "Hey Pyn" pencereyi geç açıyor ya da yazı geç geliyor | Bilgisayarda NVIDIA, AMD ya da Intel Arc kartı yoksa ses işlemcide yazıya çevrilir. Ayarlar → Sesle yazma → **Yazı modeli**: **Hızlı** seçili olsun (1.0.32'den beri varsayılan). Açılıştan hemen sonra model yükleniyor olabilir: sağ alttaki simge "Ses hazırlanıyor…" diyorsa "Pyn hazır" bildirimini bekle. Süreler `%LOCALAPPDATA%\beyin-v3\ses\isci.log` dosyasında. |
| AMD / Intel ekran kartında ses geç hazır oluyor | Ayarlar → Sesle yazma'da **Daha hafif ses modelini al** görünüyorsa bas: model 1,6 GB yerine yaklaşık 870 MB olur ve ekran kartına daha çabuk yüklenir. |
| "Hey Pyn" pencereyi açmıyor | Cortex çalışıyor mu? **Sürekli dinle** yalnız Cortex açıkken (sağ altta simgesi varken) dinler. Ayarlar → Sesle yazma: **Sürekli dinle** açık mı, izin verildi mi? Uyandırma sözü "Hey Pyn" ya da "İkisi de" mi (varsayılan "İkisi de"; önceden "Pyn, not al" seçildiyse yalnız o tutar)? Sağ alttaki simgenin menüsü mikrofonun dinleyip dinlemediğini ve hangi sözü beklediğini söyler; dinleyemiyorsa nedenini de (yalnız sessizlik geliyorsa Windows Ayarlar → Gizlilik ve güvenlik → Mikrofon → masaüstü uygulamalarının erişimi açık olmalı). Ne duyduğunu görmek için: `py -3 beyin.py ses dene --uyandirma`. |
| Not al'da "Mikrofondan ses gelmiyor" | Dinlemeye başladıktan sonra sekiz saniye boyunca mikrofondan hiç ses gelmemiş demektir; konuşma gelince uyarı kendiliğinden kalkar. Kalkmıyorsa: kulaklığın mikrofonu kapalı olabilir (sessiz düğmesi ya da kalkık mikrofon kolu); Windows başka bir mikrofonu dinliyor olabilir (uyarının yanındaki ad dinlenen mikrofondur; Windows ses ayarlarından doğru mikrofonu varsayılan yap); ya da masaüstü uygulamalarının mikrofona erişimi kapalı olabilir (Windows Ayarlar → Gizlilik ve güvenlik → Mikrofon). |
| Asistan notları hatırlamıyor | İstemcide hook güvenini onayladığını kontrol et, sonra asistana "beyin-doktor ile kontrol et" de ya da `beyin.py doctor` çalıştır. |
| Bir not bağlama hiç girmiyor | Notta `visibility: private` var mı, klasörünün adında "Özel", "Şifreler" gibi bir sözcük geçiyor mu? `beyin.py doctor` indeks dışı tutulanları gösterir. |
| Oturum `Memory hygiene:` uyarısıyla açılıyor | `beyin.py companion-compact` eski kayıtları silmeden arşive taşır. |
| Telegram'dan gelen sesli not yazıya çevrilmemiş | Sesli notları çevirmek için sesle yazma kurulu olmalı (Windows). Ses dosyası kartın ekinde durur. |
| YouTube kartında döküm yok | `yt-dlp` kurulu mu? `beyin.py yakala durum` eksik araçları söyler. |
| Gemini CLI `IneligibleTierError` veriyor | Google bireysel hesapla girişi kapattı; API anahtarıyla giriş yap. |
| cmd'de `pyn` çalışmıyor | `pyn kur`u yeniden çalıştır, sonra **yeni** bir terminal aç. |
| Kasayı taşıdım ya da kopyaladım (OneDrive Belgeler'i devraldı, klasörü yeniden adlandırdım), hafıza çalışmıyor | Masaüstü uygulaması kasayı açınca bunu kendisi düzeltir. Terminalden: kasada `python3 beyin.py relocate`. Taşınan kasa yeni yerine bağlanır; kopyaya kendi hafıza klasörü açılır, özgün kasaya dokunulmaz. |

**Eski bir kurulumdan geliyorsan** (Cortex'in doğduğu açık kaynak projenin eski sürümleri, `.beyin-version` 2.x ya da 3.x): masaüstü uygulaması kasayı açınca bunu "Cortex'e geçiş" olarak kendisi yapar; terminalde aynı kurucuyu mevcut kasa üzerinde bir kez çalıştır (eski kurulumun `update` komutu Cortex paketini eski sürüm sanar). Notlar, companion dosyaları, `daily/` ve `knowledge/` içerikleri korunur; tanınan eski yazıcılar geri alınabilir biçimde devreden çıkarılır. [Geçiş ayrıntıları](v3/MIGRATION.md)
