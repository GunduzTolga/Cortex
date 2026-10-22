# Telegram: telefondan gelen kutusuna

Telefondan kendi Telegram botuna gönderdiğin yazı, bağlantı, fotoğraf, dosya ya da sesli not
kasanın gelen kutusuna (`📥 000-Inbox/Yakala/`) bir yakala kartı olarak düşer. Hiçbir şey taşınmaz
ya da düzenlenmez; asistanın kartları sonra okuyup işler, tıpkı `Ctrl+Alt+C` ile yakaladıkların gibi.
İsteğe bağlıdır; kurmazsan hiçbir şey değişmez.

## Kurulum (bir kez)

1. Telegram'da [@BotFather](https://t.me/BotFather) sohbetine `/newbot` yaz, bota istediğin bir ad ve
   sonu `bot` ile biten bir kullanıcı adı ver. BotFather sana `123456789:AA…` gibi bir **anahtar** verir.
2. **Masaüstünde:** Ayarlar → Telegram'a anahtarı yapıştır, **Bağla**'ya bas.
   **Terminalde:** kasada `py -3 beyin.py telegram kur --token <anahtar>` (macOS / Linux'ta `python3`).
3. Ekranda çıkan **Telegram'da aç** bağlantısını telefonda aç ve **Başlat**'a bas. Bağlantı açılmazsa
   bota ekrandaki 8 harflik kodu yaz.

Bot artık yalnız o sohbeti dinler. Botu bulan başka biri ona yazsa da cevap almaz ve yazdığı hiçbir
yere kaydedilmez. Kod 20 kez yanlış denenirse kullanılamaz olur; yenisi için `telegram kur --yeniden-esle`
(masaüstünde **Başka bir telefonla eşleştir**). Yalnız koda benzeyen denemeler sayılır (`/start …` ya da
kodun harflerinden tek bir sözcük): eşleşmeden önce bota yazdığın notlar kodu harcamaz, eşleşince
gelen kutusuna gelir ve bot "Eşleşmeden önce gönderdiğin N mesajı aldım ✓" der.

Masaüstünde **Başka bir telefonla eşleştir** dinleyiciyi durdurup yeni bağlantıyı verir, sonra yeniden
başlatır. Terminalden `kur --yeniden-esle` dinleyici çalışırken yapılmaz: dinleyici her turda okuduğu
eşleşmeyi geri yazar ve yeni bağlantıyı bozardı; önce dinleyiciyi kapat.

Telegram anahtarı geçersiz derse (BotFather'da `/revoke`) aynı botun yeni anahtarını Ayarlar → Telegram'a
yapıştırman yeter: eşleşme korunur, telefonu yeniden eşleştirmen gerekmez.

Cortex için ayrı bir bot aç. Başka bir yerde (webhook ile) kullanılan bir bot kabul edilmez, çünkü
Telegram bir botun mesajlarını tek bir alıcıya verir.

## Ne nasıl kaydedilir

| Gönderdiğin | Kart |
| --- | --- |
| Yazı | Not; ilk satırı başlık olur. |
| Bağlantı | Kaynak kartı (makale, YouTube, X…); yanındaki sözler **Neden** bölümüne. `yakala isle` sonra metnini çıkarır. |
| Fotoğraf, ekran görüntüsü | Kartın eki (`dosyalar/`); açıklaması **Neden**'e. Birlikte gönderilen fotoğraflar tek kart olur. |
| Sesli not, yuvarlak video | Bu bilgisayardaki Whisper yazıya çevirir; yazı kartın gövdesine, ses dosyası eke. 10 dakikaya kadar ses dosyaları da çevrilir. |
| Dosya | Kartın eki. Telegram botların 20 MB'tan büyük dosyaları indirmesine izin vermez; böyle bir dosya kartta adıyla anılır, Telegram'da kalır. |
| İletilen mesaj | Kimden ya da hangi kanaldan geldiği kartta yazar (`iletildi`); kanal gönderisinin bağlantısı da. |
| Konum, kişi | Yazı olarak (koordinat ve harita bağlantısı; ad ve telefon). |
| Çıkartma, anket | Kaydedilmez; bot bunu söyler. |

Her kartın frontmatter'ında `arac: telegram`, mesajın numarası (`telegram_mesaj`) ve gönderildiği an
(`gonderildi`) durur. Bot her mesaja sessiz bir cevapla "✓ Gelen kutusuna eklendi" der; sesli
notta yazıya çevrilen cümlenin başını da gösterir. Bir dosya gelmediyse (20 MB'tan büyük, ya da Telegram
vermedi) cevap bunu söyler: "✓ Gelen kutusuna eklendi, ama dosyayı alamadım: …"; kartta da yazar.

Telegram bir dosyayı o an veremezse (sunucusu meşgul ya da hata veriyor) mesaj kaydedilmiş sayılmaz:
dinleyici biraz bekleyip mesajı baştan yeniden alır. Telegram bir saat boyunca vermemeye devam ederse
mesaj dosyasız kaydedilir ve bot bunu söyler; sıradaki mesajlar beklemez.

Sesli notları yazıya çevirmek için sesle yazmanın kurulu olması gerekir (Ayarlar → Sesle yazma).
AMD ya da Intel ekran kartıyla (Vulkan) 1.0.26'dan önce kurduysan Ayarlar'da **Sesle yazmayı güncelle**
düğmesi çıkar: ses dosyasını açacak paketi ekler, modeller yerinde kalır. Sesle yazma kurulu değilse
sesli not yine kaydedilir, yalnız yazıya çevrilmez.

## Bilgisayar kapalıyken

Bilgisayar kapalıyken gönderdiklerin açılınca gelir. Telegram bir botun alınmamış mesajlarını yalnız
24 saat tutar; Cortex bu süreye bağlı kalmaz:

- Sohbetteki her mesajın sırayla artan bir numarası var. Cortex en son hangi numarayı gördüğünü bilir;
  arada boşluk kalırsa kaçan mesajlar onlardır.
- Kaçan her mesajı bot aynı sohbete sessizce iletir ve kopyayı hemen siler: iletmek mesajın kendisini
  bota verir, ne kadar eski olursa olsun. Silinmiş bir mesajın numarası atlanır.
- Bilgisayar bir günden uzun süre kapalı kaldıysa Cortex açılışta sohbete bakar; yeni bir mesaj
  göndermeni beklemez.
- Bu yolla alınamayan mesaj olursa (Telegram iletmeyi reddederse, ya da bir seferde 500'den fazla
  numara birikmişse) bot bir kez söyler: "… mesajı alamadım; onları seçip bana yeniden iletir misin?"
  Sohbette mesajları seçip bota iletmek yeterli.

Kaçan mesajlar alındıktan sonra bot "Bilgisayar kapalıyken gönderdiğin N mesajı aldım ✓" der. Telefonda
iletilen kopyalar bir an görünüp kaybolabilir.

Bu iş yarıda kalırsa (bağlantı koptu, uygulama kapandı, Telegram "biraz bekle" dedi) kaldığı yerden
sürer: alınan her mesaj hemen not edilir, boşluk ancak tamamı alınınca kapanmış sayılır. Aynı mesaj iki
kart olmaz; uygulama tam bot cevap verirken kapansa da.

## Nasıl çalışır

`beyin.py telegram dinle` Telegram'a sürekli "yeni mesaj var mı?" diye sorar (long polling).
Bilgisayarda hiçbir kapı açılmaz, modem ya da sunucu ayarı gerekmez. Masaüstü uygulaması açıkken
(sağ altta da) dinleyiciyi kendisi çalıştırır; durursa kendiliğinden, her seferinde biraz daha geç
yeniden başlatır. Anahtar geçersizse (çıkış kodu 2) ya da Telegram kurulmamışsa (`{"status": "kurulmamis"}`,
çıkış kodu 3) yeniden başlatmaz. Bir makinede tek dinleyici çalışır; masaüstü açıkken terminalde ayrıca
`telegram dinle` çalıştırma (ikisi aynı botu sorarsa Telegram "başka bir yerde de dinleniyor" der).

Botun durumu (eşleşme, son görülen mesaj numarası, dinleyicinin kilidi) terminalde kasanın
`state/telegram` klasöründe durur. Masaüstü uygulaması onu kendi veri klasöründe, anahtarın yanında
tutar ve motora `BEYIN_TELEGRAM_DIR` ile verir: bot bir kasaya değil sana aittir. Böylece başka bir
kasa seçince telefon eşleşmesi kopmaz, anahtar yeniden sorulmaz ve dinleyici yeni kasanın gelen
kutusuna yazmaya devam eder. Bu klasör ilk kullanıldığında açık kasanın `state/telegram` içeriği oraya
kopyalanır (kilit dosyası hariç); eşleşme korunur.

Uygulamasız kullanmak için dinleyiciyi terminalde çalıştır ya da oturum açılışına bağla:

```sh
python3 beyin.py telegram dinle
```

| Komut | Ne yapar |
| --- | --- |
| `telegram kur --token <anahtar>` | Anahtarı Telegram'a doğrulatır, eşleşme bağlantısı verir. Anahtar `state/telegram/token` dosyasına, yalnız senin okuyabileceğin şekilde yazılır. |
| `telegram kur --yeniden-esle` | Eşleşmeyi bırakır, yeni bağlantı verir. |
| `telegram durum` | Bot, eşleşme, dinleyici çalışıyor mu, son hata (`son_hata`, adıyla `son_hata_kod`: `anahtar_gecersiz`, `cakisma`, `baglanti`, `telegram`), gelen not sayısı. |
| `telegram dinle` | Gelen mesajları gelen kutusuna yazar; durdurulana kadar çalışır. |
| `telegram kaldir` | Anahtarı ve eşleşmeyi siler. Gelen kutusundaki kartlara dokunmaz. `BEYIN_TELEGRAM_DIR` ile kasanın kendi `state/telegram` kopyası da silinir; başka bir kasanın eski eşleşmesi sonradan geri gelmez. |

## Gizlilik

- **Anahtar kasaya yazılmaz.** Masaüstü uygulaması onu Windows'un şifreli deposunda tutar ve
  dinleyiciye yalnız ortam değişkeni olarak verir (`BEYIN_TELEGRAM_TOKEN`). Terminalden kurulumda
  kasanın dışındaki `state/telegram/token` dosyasında durur.
- **Bota giden mesajlar Telegram'ın sunucularından geçer.** Bot sohbetleri uçtan uca şifreli değildir;
  telefondan gönderdiğin bu yüzden Telegram'da da durur. Cortex kasandan hiçbir şeyi bota ya da
  Telegram'a göndermez; bot yalnız "eklendi" gibi kısa cevaplar yazar.
- **Sesli notlar bu bilgisayarda yazıya çevrilir.** Ses başka bir servise gitmez.
- **Kartlar güvenilmeyen kaynak sayılır.** Yazı, fotoğraf ve dosya kartları `visibility: private`
  olarak yazılır, otomatik bağlama girmez; bağlantı kartları diğer yakala kartları gibi
  (`internal`). Bağlantılar yalnız herkese açık `http(s)` adresleriyse kaynak sayılır; yerel ağ
  adresleri düz yazı olarak kalır ve hiç getirilmez ([Yakala güvenliği](YAKALA.md#güvenlik)).
