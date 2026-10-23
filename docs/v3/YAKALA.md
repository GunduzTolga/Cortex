# Yakala: tek tuşla beyne at

Video, tweet, makale, mail, PDF ya da aklına gelen bir cümle: gördüğün yerde tek tuşla yakala,
ajanın sonra okuyup dersleri ikinci beynine bağlasın. İsteğe bağlıdır; kurmazsan hiçbir şey değişmez.

## Kurulum (bir kez)

Vault klasöründe:

```sh
python3 beyin.py yakala kur
```

Windows'ta `py -3 beyin.py yakala kur`. Ya da ajanına "yakala aracını kur" de.

Kurulum şunları yapar:

| | Mac | Windows |
|---|---|---|
| Her uygulamada kısayol | `Control+Option+C` | `Ctrl+Alt+C` |
| Dosya gönderme | Finder'da dosyayı seç, kısayola bas | Sağ tık > Gönder > Beyne At |
| Tarayıcı | Obsidian Web Clipper şablonu | Obsidian Web Clipper şablonu |
| Ajan | `beyin-yakala` skill'i | `beyin-yakala` skill'i |

Kısayol ek paket istemez; Python'un kendisiyle çalışır. Mac'te bir oturum açılış servisi
(LaunchAgent) tuşu dinler.

Windows'ta küçük bir **dinleyici** tuşu tutar ve pencereyi önceden hazır bekletir; tuşa basınca
pencere anında açılır. Boştayken saniyede on kez bakar (önceden kırk kez bakıyor, dizüstünün
işlemcisini gün boyu uyandırıyordu); bir pencere açıkken ya da bir şey olduktan sonraki iki saniye
saniyede kırk kez. Dinleyici Windows açılırken Başlangıç klasöründeki
"Pyn Yakala" kısayoluyla başlar, kullanıcı başına bir tanedir ve yaklaşık 40-45 MB bellek kullanır.
Cortex güncellenince kendini yeni kodla yeniden başlatır. `yakala kaldir` onu durdurur ve
Başlangıç kısayolunu siler.

Tuşu başka bir uygulama tutuyorsa dinleyici yine çalışır: ses, "Pyn, not al" ve masaüstü
uygulamasının "Not al"ı tuşa bağlı değildir. Tuşu yarım dakikada bir yeniden ister, o uygulama
bırakınca alır. `yakala kur` bunu söyler, dinleyici de `dinleyici.json` dosyasına
`kisayol: "mesgul"` yazar (masaüstü uygulaması "kısayolu değiştir" der); başka bir tuş için
`beyin.py yakala kisayol ctrl+alt+x`. Önceden dinleyici çekiliyordu ve sesle "Pyn, not al" da
onunla birlikte, bir sonraki oturuma kadar hiçbir şey söylemeden gidiyordu. Başlat menüsü
kısayolu tuş almaz: başka bir uygulamanın tuttuğu tuşu Explorer da alamaz, alırsa dinleyiciye
hiç bırakmaz.

Dinleyicinin kendi hataları state klasöründeki `yakala/dinleyici.log` dosyasına yazılır (aynı
hata dakikada en çok bir kez). Bir pencere açılırken bir hata olursa (panoda bozuk bir bağlantı
gibi) yarım kalan pencere kapatılır ve dinleyici bir sonraki basışı dinlemeyi sürdürür; önceden
böyle bir hata dinleyiciyi sessizce durduruyordu: tuş bir şey açmıyor, `kur` onu durduramıyor,
mikrofon uygulama kapandıktan sonra da açık kalıyordu.

İlk açılışı yavaşsa (yeni bir bilgisayarda virüs tarayıcısı her dosyayı okurken) `yakala kur` onu
durdurmaz, Başlangıç kısayolunu da silmez: dinleyici açılmayı sürdürür ve Windows açılışında da
başlar (`"dinleyici": null`, "Dinleyici açılıyor"). Önceden sekiz saniye içinde haber vermeyen
dinleyici durduruluyordu; sonra hiçbir şey dinlemiyor, bunu da hiçbir şey söylemiyordu.

Pencere Ananas yazı tipleriyle çizilir: Fraunces başlık, Schibsted Grotesk metin, JetBrains Mono
etiketler. Fontlar Windows'a kurulmaz; yakala onları bu makinenin state klasörüne yazar ve
yalnız kendi sürecine yükler. Başka programlar etkilenmez.

Yalnız şablon ve skill istiyorsan: `python3 beyin.py yakala kur --kisayol-yok`.

### Kasa değiştirince (Windows)

Kısayol, dinleyici ve Başlat menüsü, Gönder ve Başlangıç kısayolları kişinindir: bütün kasalar
için bir tane. Hangi kasaya yazdıklarını `%LOCALAPPDATA%\beyin-v3\yakala-sahip.json` söyler
(`vault`, `state`, `tus`); `yakala kur` yazar.

- Başka bir kasada `yakala kur` çalışınca kısayol oraya taşınır; eski kasanın dinleyicisi iki
  saniye içinde kendiliğinden çekilir. Masaüstü uygulaması kasa değiştirince bunu kendisi yapar.
- Masaüstü uygulamasının "Not al"ı (`yakala pencere`) çalışan dinleyiciye yalnız o dinleyici bu
  kasanınsa gider; değilse pencere bu kasada kendisi açılır. Önceden notlar eski kasaya gidiyordu.
- Eski bir kasada `yakala kaldir` kısayola, dinleyiciye ve kısayol dosyalarına dokunmaz; yalnız
  o kasanın kendi parçalarını kaldırır ve tuşun hangi kasada olduğunu söyler. `yakala durum` da
  dinleyiciyi yalnız kendi kasası için "çalışıyor" gösterir.
- Kasa klasörü taşındıysa ya da silindiyse yakalama "Kasa bulunamadi" der; gelen kutusunu eski
  yolda yeniden açmaz.
- 1.0.33'ten önce kurulmuş bir dinleyici ilk açılışında bu kaydı kendi kasası için yazar.

### Kısayolu değiştir

```sh
python3 beyin.py yakala kisayol 'cmd+"'
```

Tuşu yazdığın gibi tarif et: `cmd`, `ctrl`, `alt` (ya da `option`), `shift` ve en sonda tuş.
Örnekler: `ctrl+alt+c` (varsayılan), `cmd+shift+space`, `alt+f5`, `⌘⇧K`. Mac'te karakter etkin klavye
düzeninden bulunur; Türkçe Q'da `"` 1'in solundaki tuştur. Windows'ta Başlat menüsü kısayolu
yalnız Ctrl/Alt/Shift ile harf, rakam ya da F tuşunu kabul eder. Argümansız `kisayol` mevcut tuşu
gösterir. Seçtiğin tuşu başka bir uygulama zaten kullanıyorsa komut uyarır; başka bir tuş dene.

### Tarayıcı: Obsidian Web Clipper

1. [Obsidian Web Clipper](https://obsidian.md/clipper) eklentisini kur (Chrome, Firefox, Safari, Edge, Arc, Brave).
2. Eklentinin ayarlarında **Şablonlar > İçe aktar** ile kurulumun yazdığı
   `📥 000-Inbox/Yakala/beyne-at-web-clipper.json` dosyasını seç.
3. Bir sayfada eklentiye bas, "Beyne at" şablonunu seç, istersen **Neden** bölümüne bir satır yaz, ekle.

Web Clipper sayfayı tarayıcının içinden okur; giriş isteyen sayfalar (Gmail, ücretli makale) da böylece yakalanır.
Kart adları kısayolla yakalananlarla aynı biçimde, boşluksuz ve kesme işaretsiz yazılır
(`2026-10-17-1430-sayfa-basligi`). Cortex 1.0.25'ten önce içe aktardıysan `yakala kur`dan sonra şablonu bir kez daha içe aktar.

## Kullanım

1. **Yakala.** Kısayola bas. Pencere neyin kaydedileceğini gösterir: tarayıcıdaki sayfa
   (Mac'te Chrome, Arc, Brave, Edge, Safari), Finder'da seçili dosya ya da panodaki metin.
   İstersen tek satır "neden" yaz, Enter. Esc vazgeçer.
2. **İşlet.** Ajanına "yakalananları işle" de. Oturum başında bekleyen kaynak sayısı da görünür.

Her yakalama `📥 000-Inbox/Yakala/` içinde bir kart olur. Aynı videoyu ya da sayfayı ikinci kez
yakalarsan yeni kart açılmaz; yeni notun aynı karta eklenir. Kart daha önce işlendiyse (ya da
hata aldıysa) yeniden kuyruğa girer (`durum: bekliyor`, `yeniden_yakalandi`): oturum bildirimi onu
sayar, `isle` metni yeniden indirmez (yöntem `onceki`), ajan yalnız yeni isteği işler. Önceden yeni
not işlenmiş kartın sonunda kalıyor, kimse görmüyordu.

Kartlara Obsidian'da etiket, takma ad ya da başka bir özellik ekleyebilirsin: `isle`, `bitti` ve
yeniden yakalama yalnız kendi alanlarını değiştirir, seninkileri yazdığın gibi bırakır (listeler,
`true`, sayılar, çok satırlı değerler). Önceden her yeniden yazışta listeler siliniyordu.

**Gönder > Beyne At (Windows):** dosya kaydedilince ekranın sağ altında kısa bir "Beyne atıldı"
notu çıkar ve kendiliğinden kaybolur; kaydedilemezse (dosyayı Outlook gibi başka bir program
kullanıyorsa) nedenini söyleyen bir uyarı açılır. Klasör gönderilemez; içindeki dosyaları seç.

**Ekran görüntüsü (Windows):** `Win+Shift+S` ile alan seç, sonra kısayola bas. Pencere görüntüyü
küçük resmiyle bir **GÖRSEL** kartı olarak gösterir ve Enter onu kartın dosyası olarak kaydeder.
Son 10 dakikada alınmış görüntü ekli gelir; daha eski ya da kaynağı bilinmeyen bir görüntü
pencerede görünür ama `Tab` ile eklemeden karta girmez. "Pyn, not al" ile açılan pencerede
görüntü de işaretsiz gelir. Panoda metin ya da bağlantı varsa pencere görüntüyü değil onu
gösterir (aşağıda).

**Açık sayfa (Windows):** Chrome, Edge, Brave, Vivaldi ya da Opera öndeyken kısayola basarsan
açık sayfanın bağlantısı da gelir; tarayıcının adres çubuğundan okunur, yazıp Enter'a basmadığın
taslak adres sayılmaz. Pencerede **Bu sayfayı nota bağla** işaretli gelir: tıklarsan ya da `Alt+S`
ile kaldırırsan not, sayfa olmadan düz not olarak kaydedilir; panodaki bir bağlantı onun yerine
geçmez (önceden pencerede görünmeyen pano bağlantısı sessizce sayfanın yerini alıyordu), o
**Panodaki metni de ekle** seçeneği olarak görünür. "Pyn, not al" ile açılan pencere
sayfayı okumaz, hemen açılır. Okuma en çok bir saniye sürer; tarayıcı cevap vermezse pencere
sayfasız açılır.

**Panodaki metin ve bağlantı (Windows):** son beş dakikada kopyaladığın metin nota işaretli gelir;
altındaki kutu ya da `Tab` onu çıkarır. Daha eski bir kopya, dinleyici açılmadan önce kopyalanmış
olan ya da bir pencerede görünüp eklenmeden kaydedilmiş olan **Panodaki metni de ekle** seçeneği
olarak görünür, `Tab` ya da tıklamayla eklenir. "Pyn, not al" ile açılan pencere panodan hiçbir şeyi kendiliğinden almaz:
karşıdan konuşurken pencereye kimse bakmaz. Saatler önce kopyaladığın bir parola, Enter'a bastın ya
da "Pyn, kaydet" dedin diye nota girmez; önceden dinleyici açıldıktan sonra kopyalanan her metin,
saatler önce kopyalanmış olsa da giriyordu, kartın başlığı ve dosya adı da oluyordu.
- Panodaki bir bağlantı kendi satırında **Panodaki bağlantıyı nota bağla** kutusuyla görünür;
  kopyalanmasının üstünden beş dakika geçtiyse işaretsiz gelir. Önceden her pencere onu sormadan
  alıyor, not o bağlantının eski kartına ekleniyordu.
- Yerel ya da bozuk bir bağlantı (`http://localhost:3000`, `http://192.168.1.1`, `http://intranet`)
  sayfa sayılmaz, düz metin olarak eklenir. Önceden pencere ondan hiçbir notu kaydedemiyordu.
- Panodaki metni eklediğin bir notta kartın başlığı ve dosya adı senin yazdığın ya da söylediğin
  cümleden gelir, kopyaladığın metinden gelmez.
- Kopyalamanın zamanını dinleyici panonun değiştiğini görerek bilir; aynı metni yeniden yazan bir
  pano yöneticisi onu yeni bir kopya gibi gösterebilir.

**Pencere:** boş bir yerinden tutup sürükleyebilirsin. Kısayola hangi ekrandaki pencerede
bastıysan o ekranda açılır. Kaydedip hemen yeniden kısayola basarsan kapanmakta olan pencere değil
yeni bir pencere açılır. Masaüstü uygulaması İngilizceye ayarlıysa (`masaustu.json`'da `dil: "en"`)
pencere İngilizce açılır; sesli komutlar Türkçe kalır ve pencerede söylenecekleri gibi yazılır.

## Sesle yazma (Windows, isteğe bağlı)

Pencereye konuşarak yazarsın; ses bilgisayardan çıkmaz, çeviriyi yerelde Whisper yapar.

**Kurulum (bir kez):** `py -3 beyin.py ses kur`
- Bilgisayardaki en hızlı yolu kendisi seçer (aşağıda **Hız**), kendi sanal ortamını kurar, paketleri yükler ve modelleri indirir: yaklaşık 2 GB, NVIDIA kart varsa onun kütüphaneleriyle daha fazla.
- Hepsi senin kullanıcı klasöründe tek bir ses klasöründe durur (`%LOCALAPPDATA%\beyin-v3\ses`; macOS ve Linux'ta durum klasörlerinin yanındaki `ses`), kasaya ve senkrona girmez. Bütün kasalar aynı kurulumu kullanır: başka bir kasaya geçince ses yeniden inmez. Başka bir klasör için `BEYIN_SES_DIR` ortam değişkeni.
- 1.0.33'ten önce her kasa sesini kendi durum klasöründe (`state/ses/`) tutuyordu. İlk kullanımda o kurulum tek ses klasörüne taşınır (aynı diskte bir taşıma, yeniden indirme yok); taşınamıyorsa (başka disk, ses yardımcısı o an çalışıyor) olduğu yerde kullanılır.
- Motorun kendisi yine yalnız Python'un standart kütüphanesini kullanır; ses ayrı bir süreçte çalışır.
- Kurulum sürerken yakala dinleyicisi durur (bir model aynı anda iki kez yüklenmesin, pip'in değiştireceği dosyalar kullanımda olmasın), kurulum bitince ya da yarım kalınca yeniden başlar. `ses kur` sonucu dinleyicinin sonra gerçekten çalışıp çalışmadığını söyler (`"dinleyici": true|false`); çalışmıyorsa `beyin.py yakala kur`.
- Paketler inerken her paket adım olarak görünür ("İniyor: … (679.1 MB)"); NVIDIA kütüphaneleri yaklaşık 1,1 GB.
- Yarım kalmış ya da bozuk bir sanal ortam (pip'i yok, ana Python'u kaldırılmış) yeniden kullanılmaz, baştan kurulur.
- 1,6 GB'lık whisper.cpp modelinin inişi bağlantı koparsa kaldığı yerden sürer; birkaç kez yeniden denenir, sonraki `ses kur` da yarım kalan parçadan devam eder. Yarım inmiş bir Whisper modeli (`model.bin`'i yok) diskte sayılmaz: sonraki `ses kur` ya da yardımcının açılışı onu tamamlar.
- **Kurulum olmazsa** hata tek bir Türkçe cümleyle söylenir ve masaüstü uygulaması onu tanır: internet yok ya da bağlantı koptu (`voice_network`), diskte yer kalmadı (`voice_disk_full`), başka bir sorun (`voice_failed`). Ayrıntının tamamı ses klasöründeki `kurulum.log` dosyasındadır.
- Kullanıcı adında Türkçe harf olan bir hesapta da kurulur (`C:\Users\Şule\…`): Python'un yolu UTF-8 okunur, modeller ses klasörüne göre açılır.

**Kullanım:**
1. Ctrl+Alt+C ile **Not al** penceresini aç. Pencere dinler halde açılır ("● Dinliyorum" ve dinlenen mikrofonun adı); konuş.
2. Ara verebilirsin: her cümle kutuya eklenir. Mikrofon cümleler arasında kapanmaz; bir cümle yazılırken sonrakini söyleyebilirsin.
3. Bitirmek için:
   - **"Pyn, kaydet"** de (ya da yalnız "kaydet"): yazılır ve kaydedilir, hiç tuşa basmadan. **"Pyn, gönder"**, **"Pyn, tamam"** ve **"Pyn, bitti"** de kaydeder; bunlar yalnız Pyn'in adından sonra sayılır, "Raporu Ali'ye gönder" nottur.
   - **Enter**'a bas: dinleme biter, söylediğin yazılır ve kaydedilir.
   - **Ctrl+Alt+C**'ye yeniden bas: dinleme biter, söylediğin yazılır; Enter ile kaydedersin.
4. Düzeltmek için:
   - **"Son kelimeyi sil"**: son kelimeyi geri alır. **"Son cümleyi sil"**: son cümleyi geri alır. İkisi de tek başına ya da cümlenin sonunda söylenebilir ("Saat beş, son kelimeyi sil").
   - **"Hepsini sil"** (ya da tek başına "sil", "temizle"): kutuyu boşaltır.
   - **"Panodaki resmi ekle"** (ya da "resmi ekle", "ekran görüntüsünü ekle"): son kopyalanan görüntüyü nota ekler; sonra notu söyleyip "Pyn, kaydet" dersin. Pencere panodaki görüntüyü açılırken bulduysa onu ekler, bulmadıysa panoyu o an okur.
   - Tek başına **"iptal"** ya da **"vazgeç"** pencereyi kaydetmeden kapatır. **Esc**, duyduğunu bırakır ve pencereyi kapatır.
   - Her komutun önüne Pyn'in adı gelebilir: "Pyn, son cümleyi sil".
5. Klavyeyle yazmaya başlarsan mikrofon kapanır; yeniden konuşmak için mikrofona tıkla. Bir süre hiç ses gelmezse dinleme kendiliğinden biter, mikrofon açık kalmaz.

Uzun bir not alt satıra geçer; alan dört satıra kadar büyür, sonrası kayar. Pencere alanın hemen altında o an ne yapacağını, en altta da söyleyebileceğin komutları yazar. Birkaç saniye mikrofondan ses gelmezse bunu söyler: mikrofon kapalı ya da sessizde olabilir, ya da Windows başka bir mikrofonu dinletiyordur. Kendiliğinden dinlemeyi kapatmak için: masaüstü uygulamasında Ayarlar → Sesle yazma → "Pencere açılınca dinle" ya da `beyin.py ses ayar --otomatik kapat`.

**Komutların sözlerini değiştirmek:** masaüstü uygulamasında Ayarlar → Sesle yazma → Sesli komutlar. Her komut için birden çok söz virgülle yazılır; "İlk hallerine döndür" varsayılanlara döner. Değişiklik bir sonraki cümleden geçerlidir, dinleyici yeniden başlamaz. Terminalden: `beyin.py ses ayar --komutlar '{"kaydet": ["kaydet", "tamamdır"]}'`; bir söz iki komutta birden olamaz.

Komut kelimeleri yalnız sonda ya da tek başına sayılır: "notu kaydettim" ya da "bu satırı sil" olduğu gibi yazılır. Whisper'ın sessizliğe uydurduğu "Altyazı M.K." gibi satırlar not olmaz; bir cümlenin sonuna uydurulduklarında kesilir, sondaki "kaydet" yine sayılır. Her cümle konuşmanın biraz öncesinden biraz sonrasına kesilip yazıya çevrilir, uzun sessizlik Whisper'a verilmez.

**Sürekli dinle ("Pyn, not al" ya da "Hey Pyn"):** masaüstü uygulamasında Ayarlar → Sesle yazma → "Sürekli dinle", ya da `py -3 beyin.py ses ayar --uyandirma ac`. Masaüstünün sağ alttaki simgesinden de açılıp kapanır.
- **İzin ve kapanış:** masaüstü uygulaması "Sürekli dinle"yi açmadan önce mikrofon iznini sorar. Uygulama bu bilgisayarda bir kez çalıştıysa mikrofon yalnız uygulama çalışırken (pencere kapalı, simge sağ alttayken de) ve izin verildiyse dinler: uygulama çalıştığını birkaç saniyede bir `%LOCALAPPDATA%\beyin-v3\masaustu.json` dosyasına yazar, dinleyici buna iki saniyede bir bakar. Çık'a basınca ya da uygulama kapanınca mikrofon en geç birkaç saniye içinde kapanır. Masaüstü uygulaması hiç çalışmamış bir bilgisayarda (yalnız terminal) ayar tek başına yeter.
- **Uyandırma sözü:** Ayarlar → Sesle yazma → Uyandırma sözü: "Pyn, not al", "Hey Pyn" ya da **İkisi de**. Terminalden: `beyin.py ses ayar --uyandirma-sozu "hey pyn"` (ya da `"pyn not al"`, `ikisi`). "Pyn, not al" ne istediğini de söyler ve konuşmada nadiren geçer. "Hey Pyn" daha kısa ve daha kolay tutar, ama konuşmada geçen her "hey"i Whisper bir an dinleyip eler: sesli sohbette mikrofonu kapatmak iyi olur.
- "Pyn, not al" deyince pencere Ctrl+Alt+C'ye basmışsın gibi açılır ve dinlemeye başlar. Bitince "Pyn, kaydet" de: tuşsuz not.
- Başta kapalıdır, çünkü açıkken mikrofon sürekli dinler.
- Sözü küçük bir Türkçe Vosk modeli yakalar, böylece kimse konuşmazken Whisper çalışmaz ve işlemci boşuna yorulmaz.
- Küçük model "Pyn"i bilmez: gerçek bir sesle çoğu zaman yalnız "not al"ı duyar, önündeki kelimeyi tanımaz ("[unk] not al"); başka bir konuşmayı da sözün kendisi sanabilir. Bu yüzden ne duyarsa duysun son birkaç saniyeyi Whisper dinler; Pyn'in adını ("Pyn", "Payn", "Pain"…) duyarsa pencere açılır. "Bunu not al", tek başına "not al" ya da oyunda konuşurken söylenenler açmaz. Ad yalnız Pyn'e benzeyen kısa bir kelimeyse sayılır: "Hey aynen", "Hey Aynur", "Hey plan" açmaz.
- Whisper bakarken kayıt başlamıştır, ve sözü dinleyen akış ancak kayıt açıldıktan sonra bırakılır; sözden hemen sonra, tek nefeste söylediğin ("Pyn, not al yarın saat üçte dişçi") notun başı olur, kaybolmaz.
- Notun başındaki söz kalıntısı ("al.", "Pyn,") yazılmaz; ama Pyn'e yalnız benzeyen bir kelime notun kendi kelimesidir: "Bin beş yüz lira market", "Bayan Ayşe aradı", "Pin kodunu değiştir" olduğu gibi yazılır.
- Oyun oynarken ya da uzun konuşmalarda mikrofonun dinlemesini istemezsen masaüstü uygulamasının sağ alttaki simgesinden "Sürekli dinle"yi kapat.
- **Tutmuyorsa:** `py -3 beyin.py ses dene --uyandirma` 20 saniye dinler; her denemede küçük modelin ne duyduğunu, Whisper'ın ne yazdığını ve pencerenin açılıp açılmayacağını söyler. Ses klasöründeki `isci.log` her uyandırma kararını yazar (söylediklerini değil).
- **Gerçekten dinliyor mu:** dinleyici `%LOCALAPPDATA%\beyin-v3\dinleyici.json` dosyasına `uyandirma: true` yazdığında mikrofon sözü gerçekten dinliyor demektir (mikrofondan ses geldi). Dinleyemiyorsa nedenini yazar (`uyandirma_sorun`): `mikrofon` (açılamadı ya da hiç ses gelmiyor), `sessiz` (yalnız sessizlik geliyor: Windows Ayarlar → Gizlilik ve güvenlik → Mikrofon → "Masaüstü uygulamalarının mikrofona erişmesine izin ver" kapalı olabilir), `model` (uyandırma modeli açılamadı; "Sürekli dinle" kapatılıp açılınca yeniden denenir). Masaüstü simgesi ve Ayarlar bunu gösterir. Kısayol dinleyicininse `kisayol: "tamam"`, başka bir uygulamadaysa `kisayol: "mesgul"` yazar (dinleyici açılırken, tuş kaydedilene kadar bu alan yoktur).
- Bluetooth kulaklıkta mikrofon açıkken müzik ve video sesi kötüleşir; bu özelliği USB ya da dahili mikrofonla kullan.
- Mikrofon açılamazsa (Windows açılırken kablosuz kulaklık henüz hazır değilse) dinleyici birkaç saniye sonra yeniden dener, ses aygıtlarını yeniden tarar; mikrofondan uzun süre hiç ses gelmezse akışı yeniden açar. Ne olduğunu ses klasöründeki `isci.log` yazar.

**Kısayol:** 1.0.12'den beri Ctrl+Alt+C. Eskiden varsayılan olan Ctrl+Alt+B kendiliğinden Ctrl+Alt+C olur; kendin seçtiğin bir tuş değişmez. Değiştirmek için: `beyin.py yakala kisayol ctrl+alt+x`.

**Hız:** `ses kur` bilgisayardaki ekran kartına bakıp yazan motoru seçer.

| Kart | Motor | Cümle başına |
|---|---|---|
| NVIDIA | faster-whisper, CUDA ile | bir saniyenin altında |
| AMD Radeon, Intel Arc | whisper.cpp, Vulkan ile | bir saniyenin altında (RX 7800 XT'de 11 saniyelik kayıt 0,3 saniyede); işlemcinin içindeki zayıf bir Radeon'da (Vega, 610M) kurulum işlemciyi seçer |
| Hiçbiri (Intel'in dahili grafiği de) | faster-whisper, işlemcide, `small` | birkaç saniye |

- **NVIDIA:** CUDA'nın kütüphaneleri pip'ten gelir; ayrıca CUDA kurman gerekmez. Kart float16 hesaplayamıyorsa (GTX 9xx/10xx, MX150-MX350) int8 ya da float32 ile kartta yazar. Kart açılamazsa işlemciye geçilir ve nedeni ses klasöründeki `isci.log` dosyasına yazılır.
- **Kart yavaşsa:** `ses kur` modeli yükledikten sonra kartın bir saniyelik sesi ne kadar sürede yazdığını ölçer. 2 saniyeden uzunsa ya da kart hiç açılamadıysa işlemciyi (hızlı model ve küçük doğrulayıcı) kurar ve bunu söyler. İşlemcinin modelleri o an inemezse çalışan yavaş kart kalır. Motoru elle seçtiysen (`ses ayar --motor`) seçimine dokunmaz.
- **AMD ve Intel Arc:**
  - whisper.cpp Windows için Vulkan sürümü yayımlamıyor; Cortex onu kendi GitHub iş akışında (`whisper-vulkan`) derler. `ses kur` derlemeyi bu ön sürümden indirir ve SHA-256'sıyla doğrular. Yayımlanmış bir derleme hiçbir zaman değiştirilmez (yenisi kendi etiketiyle yayımlanır), yoksa önceki sürümler onu reddedip işlemciye düşerdi.
  - Model (yaklaşık 1,6 GB) ekran kartında hazır tutulur; ilk cümle de beklemesin diye açılışta bir kez ısıtılır.
  - whisper.cpp yalnız bu bilgisayardan erişilen bir adreste (127.0.0.1) çalışır ve yakala kapanınca onunla kapanır.
  - Kart açılamazsa işlemcide hızlı model (`small`) yazar; whisper.cpp'nin büyük modeli işlemcide cümle başına 15-30 saniye sürüyordu. 1.0.33'ten önce kurulmuş bir ortamda (faster-whisper yok) whisper.cpp işlemcide yazar; `ses kur` yeniden çalıştırılınca faster-whisper da gelir.
- **İşlemcide:**
  - Whisper her sesi 30 saniyelik bir pencere olarak okur; bu yüzden modelin büyüklüğü her cümlenin süresini belirler. `large-v3-turbo` bir laptop işlemcisinde cümle başına 15-30 saniye sürdü, "Hey Pyn" de pencereyi o kadar geç açtı.
  - Bu yüzden işlemcide varsayılan model `small`. Eski sürümlerin ayar dosyasına yazdığı `large-v3-turbo` bir kez `small`'a döner; ayar dosyası artık yalnız varsayılandan farklı olanları tutar, sonradan seçtiğin model kalır.
  - İş parçacığı sayısı çekirdek sayısıdır (en çok 8): 2 çekirdekli bir Celeron artık tek iş parçacığıyla yazmaz.
  - Seçtiğin model inemiyorsa (internet yokken seçildiyse) diskte olan öbür model yazar ve hangisinin yazdığı söylenir.
  - Uyandırma sözünü ayrı, küçük bir `base` modeli doğrular: söz duyulduktan kısa süre sonra pencere açılır.
  - Daha doğru ama işlemcide yavaş modeli seçmek için: Ayarlar → Sesle yazma → Yazı modeli → **En doğru**, ya da `beyin.py ses ayar --islemci-modeli large-v3-turbo`.
- **Hazırlık süresi:**
  - Model, yakala dinleyicisi başlarken yüklenir. İşlemcide bu birkaç saniyeden yarım dakikaya kadar sürebilir.
  - Masaüstü uygulaması bu sırada Ayarlar → Sesle yazma'da bir çubuk gösterir (model iniyorsa ne kadarının indiği). Sağ alttaki simgede "Ses hazırlanıyor…" der. Hazırlık uzarsa bildirim gönderir, hazır olunca "Pyn hazır" der.
  - Yazı modeli yüklenince ses hazırdır; uyandırma sözünün küçük doğrulayıcısı ondan sonra yüklenir, o gelene kadar sözü yazı modeli doğrular.
  - `ses kur` Whisper modelinin inişini yüzdeyle söyler.
  - Dinleyici durumunu `%LOCALAPPDATA%\beyin-v3\dinleyici.json` dosyasına yazar.
  - Model yüklenemezse (ilk inişte internet yoksa gibi) ses yardımcısı 10 saniye sonra yeniden denenir; bekleme her seferinde iki katına çıkar, en çok beş dakika olur.
  - Yükleme ve yazma süreleri ses klasöründeki `isci.log` dosyasına yazılır (söylenenler yazılmaz).
- **Motoru elle seçmek:** `beyin.py ses ayar --motor islemci` (ya da `cuda`, `vulkan`, `otomatik`), ardından `beyin.py ses kur`.
- Daha hızlı ama daha az doğru bir model için (CUDA): `beyin.py ses ayar --model small`.

**Diğer komutlar:**
| Komut | Ne yapar |
|---|---|
| `ses durum` | Kurulu mu, hangi model ve motor, uyandırma açık mı |
| `ses dene --sn 5` | Beş saniye kaydedip yazıya çevirir |
| `ses dene --uyandirma` | 20 saniye "Pyn, not al"ı dinler; ne duyduğunu ve pencerenin açılıp açılmayacağını söyler |
| `ses ayar --ses kapat` | Sesi kapatır |
| `ses ayar --komutlar '{"kelime_sil": ["geri al"]}'` | Bir komutun sözlerini değiştirir (`kaydet`, `adla_kaydet`, `kelime_sil`, `cumle_sil`, `sil`, `iptal`) |
| `ses ayar --varsayilan-komutlar` | Komutları ilk hallerine döndürür |
| `ses kaldir` | Ortamı ve modelleri siler (bütün kasalar için); önce dinleyiciyi durdurur, silinemeyen bir dosya kalırsa söyler |

Ayarlar ses klasöründeki `ayar.json` içinde; sorun olursa aynı klasördeki `isci.log` (çalışırken) ve `kurulum.log` (kurulum) dosyalarına bak.

## İşleme nasıl çalışır

`python3 beyin.py yakala isle` bekleyen kartların metnini çıkarır, sonra ajan dersleri
`knowledge/` notlarına bağlar ve kartı `bitti` ile kapatır.

| Kaynak | Yol |
|---|---|
| Web Clipper ile gelen sayfa | Yakalanan metin kullanılır, ağa çıkılmaz |
| YouTube | Videoda konuşulan dil `yt-dlp`'den öğrenilir; [Defuddle](https://github.com/kepano/defuddle) o dilde bölümlü transkript için sorulur; olmazsa o dildeki `yt-dlp` altyazısı (tek tek istenir, YouTube'un HTTP 429'una takılmaz); o da yoksa yalnız ses indirilir, yerel Whisper konuşulan dille yazıya döker, ses silinir. Kart transkriptin dilini (`dil`) ve kullanılan altyazıyı (`altyazi`) yazar; dublajlı bir videoda dil belirlenemezse ya da transkript başka dildeyse `uyari` ekler |
| X, Reddit, GitHub, makale | Defuddle; yoksa düz HTTP ile metin |
| Mail | Seçili metin; tamamı için ajanın Gmail/Outlook bağlantısı |
| PDF, metin dosyası | `pdftotext` ya da doğrudan okuma; görselleri ajan açar |

Ham metin `📥 000-Inbox/Yakala/.ham/` altında durur. Nokta ile başlayan klasör olduğu için
aramaya ve Obsidian'a karışmaz, `.gitignore` ile depoya da girmez.

### İsteğe bağlı araçlar

Hiçbiri zorunlu değil; varsa işleme genişler, yoksa elde olanla devam edilir.
`python3 beyin.py yakala durum` hangilerinin bulunduğunu söyler.

- **Node.js** (`npx`): Defuddle için. Sabit sürüm (`defuddle@0.19.4`) çalıştırılır.
- **yt-dlp**: video altyazısı ve ses.
- **Whisper**: Mac'te `mlx_whisper`, diğerlerinde `whisper` ya da `whisper-ctranslate2`. Ses indirmeyi istemezsen `isle --ses-yok`.
  Modeli `BEYIN_WHISPER_MODEL` ortam değişkeniyle seçersin (ör. `large-v3-turbo`; `whisper-ctranslate2`'nin
  varsayılanı `small`, Türkçede çok kelime karıştırır). NVIDIA kartta CUDA kütüphanesi yüklenemezse
  (ör. `cublas64_12.dll`) ses bir kez işlemciyle yeniden yazıya dökülür; kart Whisper'ın kendi hata satırını yazar.
  Bu, sesle yazmanın Whisper'ından ayrıdır; o kendi motorunu kullanır.
- **pdftotext** (Poppler): PDF metni.

## Gizlilik

- Yakalama ağa çıkmaz; yalnız vault'a bir dosya yazar.
- Ağ yalnız `isle` adımında ve yalnız yakaladığın kaynaklar için kullanılır. Defuddle,
  X gönderisi sayfada yoksa gönderi adresini FxTwitter API'sine sorar.
- Mail, pano metni ve dosya kartları `visibility: private` ile yazılır. Pano metni, görüntüsü ya da
  dosyası eklenen sayfa kartı da (daha önce yakalanmış bir sayfanınki dahil) private olur; 1.0.33'ten
  önce bu yalnız Windows'taydı. Ajanların otomatik bağlamı private kayıtları almaz.
- Sesle yazmada ses yalnız bellekte tutulur, yazıya çevrilince atılır; hiçbir yere gönderilmez ve diske yazılmaz.
- Kaldırmak için `python3 beyin.py yakala kaldir`: kısayol, skill ve bildirim gider, kartların kalır.
  Windows'ta kısayol ve dinleyici yalnız onların ait olduğu kasada kaldırılır (yukarıda **Kasa değiştirince**).

## Güvenlik

Yakalanan içerik dışarıdan gelir; Cortex onu veri olarak tutar, talimat olarak değil.

- **Yalnız herkese açık web adresleri.** Yakala yalnız `http` ve `https` adreslerini kaynak sayar.
  `localhost`, yerel ağ adları (`.local`, `.lan`, `.internal`), özel ve yerel IP'ler, sayısal ya da
  yüzde kodlu sunucu yazımları ve kullanıcı adı/parola içeren adresler reddedilir. Yerel bir bağlantı
  kopyaladıysan kart düz metin olarak kaydedilir, hiçbir zaman getirilmez.
- **Getirmeden önce DNS kontrolü.** `isle` bir sayfayı ya da videoyu almadan önce adresin herkese
  açık bir IP'ye çözüldüğünü kontrol eder; yönlendirmelerde de aynı kontrol yapılır. Bilinen sınır:
  kontrol ile bağlantı arasında DNS cevabı değişebilir ve Defuddle/yt-dlp'nin kendi yönlendirmeleri
  bu kontrolü atlayabilir; bunlar için ayrı ağ yalıtımı gerekir.
- **Dosya bağlantıları yalnız vault içinde.** Kartın dosya bağlantısında sürücü harfi, ağ paylaşımı
  (UNC), `..` ya da Windows aygıt adı (`CON`, `NUL`…) varsa dosya hiç açılmadan reddedilir.
- **Windows'ta komut satırı.** Yardımcı araçlara giden adresler `cmd.exe`'den geçmez: `npx` doğrudan
  `node.exe` ile çalıştırılır. `&` içeren YouTube bağlantıları artık kesilmez ve komut olarak yorumlanamaz.
  Süresi dolan bir yardımcı aracın açtığı bütün alt süreçler de (Defuddle'ın `node`'u, `yt-dlp`'nin `ffmpeg`'i)
  kapatılır; `isle` asılı kalmaz. Obsidian, OneDrive ya da bir virüs taraması kilitlediği için yazılamayan
  bir kart yalnız kendi hatası olur, kuyruğun kalanı işlenir.
- **Tarayıcı adresi ayrı süreçte.** Adres çubuğu kısa ömürlü ayrı bir süreçte, bir saniyelik süreyle
  okunur; donan bir tarayıcı dinleyiciyi ve sesle yazmayı durduramaz. Yerel ya da özel bir sayfanın
  adresi kaynak sayılmaz.
- **Ham metin sınırlı.** `.ham/` kayıtları `kaynak_guveni: guvenilmeyen` taşır ve kaynak metni her dosyaya
  özgü rastgele bir başlangıç/bitiş işaretiyle çevrilir. Kaynağın kendi yazdığı "kaynak bitti" ya da
  "kullanıcı talimatı" başlıkları bu sınırı kapatmaz. Bu işaretler prompt injection'a karşı tek başına
  güvence değildir; `beyin-yakala` skill'i ajana bu içeriği yalnız veri olarak okumasını söyler.

**Güncellemeden sonra bir kez:** Cortex güncellemesi yakala betiğini yeniler, ama `yakala kur`un yazdığı
`beyin-yakala` skill'i ve Windows kısayolları kendiliğinden yenilenmez. Yeni güvenlik kurallarını ve
Türkçe karakterli kısayolları almak için vault klasöründe bir kez `py -3 beyin.py yakala kur` çalıştır
(macOS / Linux'ta `python3`). Kayıtlı tuşun korunur.

## Komutlar

```text
beyin.py yakala              yakalama penceresi
beyin.py yakala ekle URL|DOSYA|METIN [--neden "..."]
beyin.py yakala liste [--durum bekliyor|cikarildi|islendi|hata]
beyin.py yakala isle [ID ...] [--ses-yok] [--tekrar]
beyin.py yakala bitti ID --bilgi knowledge/concepts/x.md [--ozet "..."]
beyin.py yakala kur [--kisayol-yok] [--tus 'ctrl+alt+c']
beyin.py yakala kisayol ['cmd+"']
beyin.py yakala kaldir | durum | sablon
```
