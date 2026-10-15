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
| Her uygulamada kısayol | `Control+Option+B` | `Ctrl+Alt+B` |
| Dosya gönderme | Finder'da dosyayı seç, kısayola bas | Sağ tık > Gönder > Beyne At |
| Tarayıcı | Obsidian Web Clipper şablonu | Obsidian Web Clipper şablonu |
| Ajan | `beyin-yakala` skill'i | `beyin-yakala` skill'i |

Kısayol ek paket istemez; Python'un kendisiyle çalışır. Mac'te bir oturum açılış servisi
(LaunchAgent) tuşu dinler.

Windows'ta küçük bir **dinleyici** tuşu tutar ve pencereyi önceden hazır bekletir; tuşa basınca
pencere anında (yaklaşık 50 ms) açılır. Dinleyici Windows açılırken Başlangıç klasöründeki
"Pyn Yakala" kısayoluyla başlar, kullanıcı başına bir tanedir ve yaklaşık 40-45 MB bellek kullanır.
Cortex güncellenince kendini yeni kodla yeniden başlatır. `yakala kaldir` onu durdurur ve
Başlangıç kısayolunu siler. Tuşu başka bir uygulama tutuyorsa dinleyici çekilir ve eski yönteme,
Başlat menüsü kısayolunun tuşuna dönülür (o yol her basışta Python'u yeniden açtığı için daha yavaştır).

Pencere Ananas yazı tipleriyle çizilir: Fraunces başlık, Schibsted Grotesk metin, JetBrains Mono
etiketler. Fontlar Windows'a kurulmaz; yakala onları bu makinenin state klasörüne yazar ve
yalnız kendi sürecine yükler. Başka programlar etkilenmez.

Yalnız şablon ve skill istiyorsan: `python3 beyin.py yakala kur --kisayol-yok`.

### Kısayolu değiştir

```sh
python3 beyin.py yakala kisayol 'cmd+"'
```

Tuşu yazdığın gibi tarif et: `cmd`, `ctrl`, `alt` (ya da `option`), `shift` ve en sonda tuş.
Örnekler: `ctrl+alt+b` (varsayılan), `cmd+shift+space`, `alt+f5`, `⌘⇧K`. Mac'te karakter etkin klavye
düzeninden bulunur; Türkçe Q'da `"` 1'in solundaki tuştur. Windows'ta Başlat menüsü kısayolu
yalnız Ctrl/Alt/Shift ile harf, rakam ya da F tuşunu kabul eder. Argümansız `kisayol` mevcut tuşu
gösterir. Seçtiğin tuşu başka bir uygulama zaten kullanıyorsa komut uyarır; başka bir tuş dene.

### Tarayıcı: Obsidian Web Clipper

1. [Obsidian Web Clipper](https://obsidian.md/clipper) eklentisini kur (Chrome, Firefox, Safari, Edge, Arc, Brave).
2. Eklentinin ayarlarında **Şablonlar > İçe aktar** ile kurulumun yazdığı
   `📥 000-Inbox/Yakala/beyne-at-web-clipper.json` dosyasını seç.
3. Bir sayfada eklentiye bas, "Beyne at" şablonunu seç, istersen **Neden** bölümüne bir satır yaz, ekle.

Web Clipper sayfayı tarayıcının içinden okur; giriş isteyen sayfalar (Gmail, ücretli makale) da böylece yakalanır.

## Kullanım

1. **Yakala.** Kısayola bas. Pencere neyin kaydedileceğini gösterir: tarayıcıdaki sayfa
   (Mac'te Chrome, Arc, Brave, Edge, Safari), Finder'da seçili dosya ya da panodaki metin.
   İstersen tek satır "neden" yaz, Enter. Esc vazgeçer.
2. **İşlet.** Ajanına "yakalananları işle" de. Oturum başında bekleyen kaynak sayısı da görünür.

Her yakalama `📥 000-Inbox/Yakala/` içinde bir kart olur. Aynı videoyu ya da sayfayı ikinci kez
yakalarsan yeni kart açılmaz; yeni notun aynı karta eklenir.

**Ekran görüntüsü (Windows):** `Win+Shift+S` ile alan seç, sonra kısayola bas. Pencere görüntüyü
küçük resmiyle bir **GÖRSEL** kartı olarak gösterir ve Enter onu kartın dosyası olarak kaydeder.
Son 10 dakikada alınmış görüntü ekli gelir; daha eski ya da kaynağı bilinmeyen bir görüntü
pencerede görünür ama `Tab` ile eklemeden karta girmez. Panoda metin ya da bağlantı varsa
pencere eskisi gibi onu yakalar.

## Sesle yazma (Windows, isteğe bağlı)

Pencereye konuşarak yazarsın; ses bilgisayardan çıkmaz, çeviriyi yerelde Whisper yapar.

**Kurulum (bir kez):** `py -3 beyin.py ses kur`
- Kendi sanal ortamını kurar, paketleri yükler ve iki modeli indirir. İşlemci için yaklaşık 2 GB; NVIDIA kart varsa onun kütüphaneleriyle daha fazla.
- Hepsi durum klasöründe (`state/ses/`) durur, kasaya ve senkrona girmez.
- Motorun kendisi yine yalnız Python'un standart kütüphanesini kullanır; ses ayrı bir süreçte çalışır.
- Kurulum bitince yakala dinleyicisi yeniden başlar.

**Kullanım:**
1. Ctrl+Alt+B ile pencereyi aç.
2. Metin kutusunun sağındaki **mikrofona** tıkla ya da **Ctrl+Alt+B'ye yeniden bas**, konuş.
3. Susunca (1,4 saniye) söylediğin kutuya yazılır. Sonda **"kaydet"** dersen yazılır ve kart kaydedilir.
4. Tek başına **"sil"** kutuyu temizler; tek başına **"iptal"** ya da **"vazgeç"** pencereyi kapatır.

Komut kelimeleri yalnız sonda ya da tek başına sayılır: "notu kaydettim" ya da "bu satırı sil" olduğu gibi yazılır.

**"Pyn, not al" ile açma:** `py -3 beyin.py ses ayar --uyandirma ac`
- Bu sözü duyunca pencere açılır ve dinlemeye başlar.
- Başta kapalıdır, çünkü açıkken mikrofon sürekli dinler.
- Sözü küçük bir Türkçe Vosk modeli yakalar; Whisper yalnız asıl yazmada çalışır, böylece işlemci boşuna yorulmaz.
- Bluetooth kulaklıkta mikrofon açıkken müzik ve video sesi kötüleşir; bu özelliği USB ya da dahili mikrofonla kullan.

**Hız:**
- NVIDIA kartta cümle başına bir saniyenin altında.
- İşlemcide birkaç saniye. Daha hızlı ama daha az doğru bir model için: `beyin.py ses ayar --model small`.
- AMD kartlar için Whisper'ın hazır bir Windows sürümü yok; çeviri işlemcide yapılır.

**Diğer komutlar:**
| Komut | Ne yapar |
|---|---|
| `ses durum` | Kurulu mu, hangi model, uyandırma açık mı |
| `ses dene --sn 5` | Beş saniye kaydedip yazıya çevirir |
| `ses ayar --ses kapat` | Sesi kapatır |
| `ses kaldir` | Ortamı ve modelleri siler |

Ayarlar `state/ses/ayar.json` içinde; sorun olursa `state/ses/isci.log` dosyasına bak.

## İşleme nasıl çalışır

`python3 beyin.py yakala isle` bekleyen kartların metnini çıkarır, sonra ajan dersleri
`knowledge/` notlarına bağlar ve kartı `bitti` ile kapatır.

| Kaynak | Yol |
|---|---|
| Web Clipper ile gelen sayfa | Yakalanan metin kullanılır, ağa çıkılmaz |
| YouTube | [Defuddle](https://github.com/kepano/defuddle) ile bölümlü transkript; olmazsa `yt-dlp` altyazısı; o da yoksa yalnız ses indirilir, yerel Whisper ile yazıya dökülür, ses silinir |
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
- **pdftotext** (Poppler): PDF metni.

## Gizlilik

- Yakalama ağa çıkmaz; yalnız vault'a bir dosya yazar.
- Ağ yalnız `isle` adımında ve yalnız yakaladığın kaynaklar için kullanılır. Defuddle,
  X gönderisi sayfada yoksa gönderi adresini FxTwitter API'sine sorar.
- Mail, pano metni ve dosya kartları `visibility: private` ile yazılır.
- Sesle yazmada ses yalnız bellekte tutulur, yazıya çevrilince atılır; hiçbir yere gönderilmez ve diske yazılmaz.
- Kaldırmak için `python3 beyin.py yakala kaldir`: kısayol, skill ve bildirim gider, kartların kalır.

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
beyin.py yakala kur [--kisayol-yok] [--tus 'ctrl+alt+b']
beyin.py yakala kisayol ['cmd+"']
beyin.py yakala kaldir | durum | sablon
```
