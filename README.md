<p align="center">
  <img src="tema/ananas/marka/pyn-muhur-200.png" width="132" alt="Pyn'in mührü: altın zemin üzerinde ananas">
</p>

<h1 align="center">Cortex</h1>

<p align="center">
  <b>Yapay zekâ asistanların için yerel, kalıcı bir ikinci beyin.</b><br>
  Notların senin Markdown dosyalarında kalır; Claude Code, Codex, OpenCode ve diğerleri aynı hafızayı paylaşır.<br>
  Maskotu ve düşünme ortağın: ananas <b>Pyn</b>.<br>
  <sub>SoleLuna Tech</sub>
</p>

<p align="center">
  <img alt="Sürüm 1.0.9" src="https://img.shields.io/badge/s%C3%BCr%C3%BCm-1.0.9-E8B23A">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-1B1712">
  <img alt="Lisans MIT" src="https://img.shields.io/badge/lisans-MIT-1B1712">
  <img alt="Telemetri yok" src="https://img.shields.io/badge/telemetri-yok-1B1712">
</p>

---

## İçindekiler

- [Cortex nedir?](#cortex-nedir)
- [Desteklenen istemciler](#desteklenen-istemciler)
- [Kurulum](#kurulum)
- [Kurulumdan sonra: beş adımda hazır](#kurulumdan-sonra-beş-adımda-hazır)
- [`pyn`: Pyn'i her yerden aç](#pyn-pyni-her-yerden-aç)
- [Masaüstü uygulaması](#masaüstü-uygulaması)
- [Günlük kullanım](#günlük-kullanım)
- [Gizlilik: notların nereye gider?](#gizlilik-notların-nereye-gider)
- [İsteğe bağlı eklentiler](#isteğe-bağlı-eklentiler)
- [Tüketim ve kontrol sıklığı](#tüketim-ve-kontrol-sıklığı)
- [Güncelleme](#güncelleme)
- [Sorun giderme](#sorun-giderme)
- [Eski bir kurulumdan geliyorsan](#eski-bir-kurulumdan-geliyorsan)
- [Sürüm geçmişi](#sürüm-geçmişi)
- [Geliştiriciler](#geliştiriciler)
- [Lisans ve marka](#lisans-ve-marka)

---

## Cortex nedir?

Her yapay zekâ asistanı oturum kapanınca unutur; bir istemcide anlattığını diğeri bilmez. Cortex bu boşluğu kapatır. Bir Obsidian vault'una (ya da sıradan bir klasöre) kurulur ve kullandığın istemcilere ortak bir hafıza bağlar:

- **Hatırlar.** Her oturum açılışında ve her mesajda, konuyla ilgili notların asistanın bağlamına eklenir. Önceki oturumun devir kartı, açık konular ve senin düzeltmelerin hep el altındadır.
- **Kaynak gösterir.** Biten işler kısa, kaynak bağlantılı makbuzlarla kaydedilir. Neyin nereden geldiği her zaman izlenebilir.
- **İstemciden bağımsızdır.** Claude Code'da kaydettiğini Codex'te, OpenCode'da ya da yerel bir modelde bulursun.
- **Senin dosyalarındır.** Her şey düz Markdown'dır; Obsidian'la ya da herhangi bir editörle açar, düzenlersin.
- **Hafif ve yereldir.** Git, pip, API anahtarı, hesap ya da sürekli açık bir sunucu gerekmez. Motor kendi başına hiçbir model çağırmaz ve telemetri toplamaz.

Cortex'in içinde bir düşünme ortağı da gelir: **Pyn**. Seni tanır, fikirlerine gerekçeli itiraz eder, işlerini takip eder ve öğrendiklerini düzenler. Kimliği ve hafızası vault'undaki Markdown dosyalarındadır.

## Desteklenen istemciler

Hafızayı model değil istemci taşır. Bu yüzden ücretsiz, uygun fiyatlı ya da yerel modellerin hepsi, tam hafızalı bir istemcinin içinden kullanılabilir.

| İstemci | Hafıza | Not |
| --- | --- | --- |
| **Claude Code** | Tam | Hook'lar her oturumda ve her mesajda bağlam ekler. |
| **Codex** | Tam | İlk açılışta `/hooks` ekranında hook'ları inceleyip güven. |
| **OpenCode** | Tam | z.ai GLM, OpenCode Go ve Zen aboneliği, OpenRouter ve yerel modeller (LM Studio, Ollama) burada. Eklenti kurulumla gelir, ek adım yok. |
| **Qwen Code** | Tam | Hook'lar kurulumda `.qwen/settings.json` dosyasına yazılır. |
| **Gemini CLI** | Tam | Hook'lar kurulumda `.gemini/settings.json` dosyasına yazılır. Google, bireysel Google hesabıyla girişi kapattı; Gemini CLI'yi API anahtarıyla kullan. |
| **Oh My Pi (OMP)** | Tam | Kurulum `.omp/hooks/pre/beyin-v3.ts` dosyasını yazar. [Ayrıntılar](docs/v3/OMP.md) |
| **Google Antigravity** | Oturum başında | Kurulum `.agents/hooks.json` dosyasını yazar. Hafıza ilk model çağrısında eklenir, tur sonları kaydedilir; mesaj başına bağlam yoktur. |
| **Hermes Agent** | Tam | Eklenti vault'a yazılır; etkinleştirme adımını sen yaparsın. [Ayrıntılar](docs/v3/HERMES.md) |
| **Cursor Agent** | Talimatla | `AGENTS.md`'yi okur ve hafıza dosyalarını kendisi yükler; otomatik bağlam ve makbuz hatırlatması yoktur. |

**Tam hafıza:** Hook'lar Pyn'in hafızasını her oturum açılışında ve her mesajda bağlama ekler, dosya düzenlenen oturumun sonunda makbuz hatırlatır. Gemini ve Qwen ilk açılışta bu hook'lara güvenip güvenmediğini sorar: kabul et. O dosyalardaki diğer ayarların korunur.

## Kurulum

**Gereksinimler:** Python **3.11 veya üzeri** ve kullanmak istediğin yapay zekâ istemcisi (kendi kurulumu ve hesabıyla). Windows, macOS ve Linux desteklenir.

İki yol var. İkisi de mevcut notlarına dokunmaz; Cortex'i zaten kurduysan aynı yol, notlarını koruyarak günceller.

### Yol 1: Asistanına kurdur (en kolayı)

1. Obsidian'da yeni bir vault oluştur ya da mevcut vault klasörünü seç.
2. Bu klasörü Claude Code, Codex ya da Antigravity ile aç.
3. Aşağıdaki mesajı yapıştır:

> https://raw.githubusercontent.com/GunduzTolga/Cortex/main/beyin.md adresini oku. Bu klasöre ikinci beynimi kur. Mevcut kurulum varsa notlarımı koruyarak güncelle. Gerekli indirme ve kurulum adımlarını sen yap. Sonunda örnek bir bilgiyi kaydedip yeni oturumda geri okuyarak birlikte doğrulayalım.

Asistan resmi kararlı paketi bulur, checksum ile doğrular, geçici bir alanda açar, kurar ve sağlık kontrolünü çalıştırır. Sana yalnız istemcinin gösterdiği klasör ya da hook güven onayını vermek kalır.

### Yol 2: Elle kur

1. [Son kararlı sürüm sayfasından](https://github.com/GunduzTolga/Cortex/releases/latest) **`beyin-v3-X.Y.Z.zip`** paketini ve yanındaki **`.sha256`** dosyasını indir. GitHub'ın otomatik "Source code" arşivini değil, bu paketi seç.
2. Paketi bir klasöre aç ve o klasörde terminal aç.
3. Kurucuyu vault klasörünü göstererek çalıştır:

**Windows (PowerShell ya da cmd):**

```powershell
py -3 scripts/install_v3.py --vault "C:\Notlar\Beynim"
```

**macOS / Linux:**

```sh
python3 scripts/install_v3.py --vault "/tam/yol/Beynim"
```

Kurucu istemci bağlantılarını, ortak motoru, üç başlangıç skill'ini ve güncelleme kısayolunu kurar. Bundan sonra paket klasörüne ihtiyacın kalmaz, silebilirsin.

> **Not:** Arama indeksi ve çalışma dosyaları vault'un dışında, yalnız senin hesabının okuyabildiği bir klasörde tutulur. Başka bir yer istersen kurulumda `--state "/ayri/klasor"` ver. Ayrıntılar: [güncelleme ve runtime rehberi](docs/v3/UPDATE.md).

## Kurulumdan sonra: beş adımda hazır

**1. Vault'u istemcinde aç ve yeni bir oturum başlat.** Codex'te `/hooks` ekranında yeni hook'ları incele ve güven. Diğer istemcilerde klasör ya da workspace güvenini onayla. Kurucu bu güveni senin yerine vermez.

**2. Pyn'le tanış.** Asistanına şunu yaz:

> Beyin skill'ini kullan. Beni tanımak için kısa sorular sor; cevapları kaynak notlara kaydet. Sonra birlikte bir görev oluşturup tekrar okuyalım.

Pyn hitap şeklini, çalışma alanını ve beklentilerini öğrenip `Core.md`'ye yazar. Kurulu üç skill:

| Skill | Ne zaman? |
| --- | --- |
| **beyin** | Not bulmak, bilgi kaydetmek, görev güncellemek, iş sonucu ve ders çıkarmak |
| **beyin-doktor** | Bir not bulunamıyorsa, bağlantı ya da kayıt sorunu varsa |
| **beyin-guncelle** | Kurulu sistemi kontrol etmek, güncellemek ya da geri almak |

**3. `pyn` komutunu kur.** Vault klasöründe bir kez:

```sh
py -3 beyin.py pyn kur        # Windows
python3 beyin.py pyn kur      # macOS / Linux
```

Yeni bir terminal aç ve nerede olursan ol `pyn` yaz. Ayrıntılar [aşağıda](#pyn-pyni-her-yerden-aç).

**4. Doğrula.** Asistanına bir bilgi söyleyip kaydettir, yeni bir oturumda sor. Terminalden sağlık kontrolü:

```sh
py -3 beyin.py doctor         # Windows
python3 beyin.py doctor       # macOS / Linux
```

**5. İsteğe bağlı:** Obsidian için [Ananas teması](#ananas-teması) ve tek tuşla kaynak yakalamak için [yakala](#tek-tuşla-beyne-at-yakala).

## `pyn`: Pyn'i her yerden aç

`pyn`, hangi klasörde olursan ol Pyn'i istediğin istemciyle vault'unda açar. Önce altın çerçeveli bir karşılama kutusu gösterir: solda Pyn'in mührü, sağda son oturumun ve ipuçları. Ardından bu makinede kurulu istemcileri listeler:

```
  Hangi istemciyle konuşalım?

   1  ● Claude Code                                    tam hafıza   ← son kullanılan
   2  ● Codex                                          tam hafıza
   3  ● OpenCode                                       tam hafıza
   4  ● Qwen Code                                      tam hafıza
   5  ● OpenCode · qwen3-coder-30b (LM Studio, yüklü)  tam hafıza
   6  ● Ollama                                         kapalı · açıp bir model yükle

  Dikkat
   ·  Codex   0.122.0 kurulu, 0.162.1 çıktı; güncelle: npm i -g @openai/codex@latest

  Seçimin [1-6, Enter = Claude Code, q = çık]:
```

Her satırın başındaki nokta durumu gösterir: **yeşil** hazır, **kırmızı** kapalı. Ollama ya da LM Studio kuruluysa ama sunucusu kapalıysa ya da yüklü modeli yoksa kırmızı görünür; seçersen ne yapman gerektiğini söyler. Uygulamayı açıp bir model yüklediğinde satır yeşile döner ve o modelle açılır. "Dikkat" bölümü, `pyn kontrol`ün bulduğu eski istemcileri güncelleme komutlarıyla gösterir.

Enter son seçimini açar. Kutuda kimsenin adı yazmaz; aynı vault'u kim açarsa aynı karşılamayı görür.

### Komutlar

| Komut | Ne yapar? |
| --- | --- |
| `pyn` | Karşılama kutusu ve istemci menüsü |
| `pyn 2`, `pyn claude`, `pyn codex` | Menüsüz, doğrudan o istemciyle açar |
| `pyn claude --continue` | Sonraki argümanlar istemciye aynen gider |
| `pyn liste` | Bulunan istemcileri JSON olarak listeler |
| `pyn kontrol` | Kurulu istemcilerin sürümlerini npm'deki son sürümle karşılaştırır |
| `pyn guncelle` | Cortex'i en son sürüme günceller (`beyin.py update` ile aynı; `pyn guncelle --check` yalnız bakar) |
| `pyn kur` | Komutu ve görünümü kurar (aşağıda) |
| `pyn kaldir` | `pyn kur`un eklediği her şeyi geri alır |

### `pyn kur` neleri kurar?

| Ne | Nerede | Not |
| --- | --- | --- |
| `pyn` komutu | PowerShell profili, `.bashrc` / `.zshrc` | Profilde yalnız kendi işaretli bölümü durur. |
| cmd desteği | `%LOCALAPPDATA%\Microsoft\WindowsApps\pyn.cmd` | cmd profil okumaz. Bu klasör her Windows kullanıcısında zaten PATH'tedir, PATH'ine dokunulmaz. |
| Claude Code durum satırı | Vault'taki `.claude/settings.local.json` | Claude'un yazma kutusunun altında `Pyn · ikinci beyin · Sonnet 5.5 · son: …` satırı. Yalnız bu vault'ta açılan Claude oturumlarında görünür. Kendi durum satırın varsa dokunulmaz. |
| Windows Terminal profili | Windows Terminal ayarları | Sekme menüsünde **Pyn**: ananas ikonu, altın sekme, sağ alt köşede soluk mühür. Açılınca `pyn` başlar. Varsayılan profilin değişmez; ilk kurulumdan önce ayarların `settings.pyn-yedek.json` olarak yedeklenir. |

Her şey `pyn kaldir` ile geri alınır. Başka bir programa ait aynı adlı dosyalar ne değiştirilir ne silinir.

### Mühür hangi terminalde görünür?

Mühür terminalin içinde gerçek bir resim olarak çizilir (Sixel): Windows Terminal 1.22 ve sonrası, WezTerm ve iTerm2. `pyn` açılışta terminale resim çizip çizemediğini sorar; çizemeyen terminalde kutu resimsiz gelir, ekrana bozuk karakter dökülmez.

- `PYN_LOGO=0`: resmi kapatır.
- `PYN_LOGO=1`: sormadan çizer.
- `NO_COLOR`: kutuyu tümden kapatır.

### Yerel modeller

Ollama ya da LM Studio açıksa ve indirilmiş bir sohbet modeli varsa, menüde o model için bir satır çıkar. OpenCode kuruluysa model onunla, değilse Codex'le (`--oss`) açılır; ikisinde de hafıza tam çalışır.

- **Hangi model?** Sorulmaz, makine söyler: şu an yüklü olan; yoksa bu makinede son kullandığın; o da yoksa tek indirilmiş model. Birden fazla model indirilmiş ve hiçbiri yüklü değilse bir kez sorar. "Son kullanılan" vault'ta değil, makinenin kendi klasöründe durur: masaüstü ve laptop kendi modellerini ayrı hatırlar.
- **Listede olmayan model de çalışır.** `pyn` modeli yalnız o açılış için OpenCode'a tanıtır (`OPENCODE_CONFIG_CONTENT`), hiçbir ayar dosyasına yazmaz.
- **Bağlam uzunluğu:** OpenCode'un ilk isteği Pyn'in hafızasıyla birlikte yaklaşık 10 bin token. LM Studio modeli 32K'nın altında bir bağlamla yüklemişse `pyn` uyarır; modeli yüklerken Context Length'i artır.
- `pyn` bu sunuculara yalnız zaten açıklarsa sorar, kendisi hiçbir şey başlatmaz. Embedding modelleri listelenmez.

### Sağlayıcılar ve abonelikler

Sağlayıcı girişlerini OpenCode'da bir kez sen yaparsın: `opencode auth login`. Cortex anahtarlarını hiç görmez. OpenCode içinde modeli `/models` ile değiştirirsin. OpenCode'da her turun notları o turun kendi mesajına eklenir ve sistem metni oturum boyunca değişmez. Böylece sağlayıcının önbelleği korunur ve abonelik kotası çok daha geç dolar.

## Masaüstü uygulaması

`desktop/` klasöründe Cortex'in Windows uygulaması var. Önizleme aşamasında; kurulum dosyası henüz imzasız. Açınca kasanı seçersin, sonra dört ekran:

- **Pyn (ilk ekran):** kasanın içinde, kendi aracınla sohbet. Araç kasada başladığı için hafızayı hook'lar tam olarak verir. Araçlar: Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code ve yerel modeller için LM Studio ile Ollama: modeli kendi uygulamasında yüklersin, Cortex onunla doğrudan konuşur ve Pyn'in hafızasını kasanın hook'undan verir. Aracın izin istediği adımlar kartla sorulur. Model, mod ve efor çiplerle seçilir. Sohbetin okuduğu ve değiştirdiği notlar yan panelde açılır.
- **Notlar:** Obsidian'a gerek kalmadan okuma ve yazma: wiki linkleri, canlı önizleme, geri bağlantılar, arama, şablonlar, çöp kutusu. Makbuzlar ve motorun ürettiği sayfalar salt okunurdur.
- **Grafik:** notlar ve aralarındaki linkler.
- **Ofis:** piksel sanatıyla çizilmiş, yaşayan bir ofis. Patron Pyn, 12 ajan ve ofis kedisi Tekir dokuz odada çalışır; karakterlere ve odalara tıklanır. Sunucu odasının ışıkları araçlarının gerçek giriş durumunu, odalar kasanın sayılarını gösterir.

Dil, kasa, dosya ağacının görünüşü ve araçların girişleri **Ayarlar**'da: üst çubuktaki dişli ya da Ctrl+, açar.

**Girişler ve anahtarlar:**
- Her araç bu bilgisayarda kayıtlı kendi girişini kullanır; terminaldekiyle aynı giriş. Uygulama bu giriş dosyalarını okumaz, yalnız araca durumunu sorar.
- Uygulamaya girdiğin API anahtarları Windows'un şifreli deposunda durur.
- Hiçbiri kasaya ya da bu depoya girmez; her bilgisayarda ayrı giriş yapılır.

**Kurulum:** GitHub Actions her değişiklikte bir Windows kurulum dosyası üretir (desktop iş akışı, `cortex-setup-windows`). Kendin derlemek ve ayrıntılar için: [desktop/README.md](desktop/README.md).

## Günlük kullanım

Notunu yaz, asistanına ne istediğini söyle. Kaynaklar oturum açılışında ve konuşmanın uygun noktalarında yeniden indekslenir; istemciler kapalıyken arka planda çalışan bir servis yoktur. Önemli iş sonuçları kısa, kaynak bağlantılı kayıtlarla tutulur. Sohbetin tamamı kendiliğinden doğru bilgiye dönüşmez; kalıcı olmasını istediğin karar ve bilgiyi nota yazdır.

| İstersen | Komut (vault klasöründe; Windows'ta `py -3`) |
| --- | --- |
| Son 7 günde ne yapıldı? | `python3 beyin.py recap --days 7` |
| Sağlık kontrolü | `python3 beyin.py doctor` |
| Tercihleri gör | `python3 beyin.py preferences` |

`recap` son günlerin kaynak bağlantılı iş sonuçlarını en yeniden eskiye listeler ve model çağırmaz. Bunlar asistanın yazdığı sonuç iddialarıdır, bağımsız doğrulanmış olgular değildir. `--days` (1-366) ve `--limit` (1-100) ile aralığı ve uzunluğu değiştirebilirsin.

Bir şey ters giderse asistanına **"beyin-doktor ile kontrol et"** de.

Claude Code yerel sohbet kayıtlarını (`~/.claude/projects/`) varsayılan olarak 30 gün sonra siler. Süreyi uzatmak için `~/.claude/settings.json` içine örneğin `"cleanupPeriodDays": 365` ekle ([Claude Code belgesi](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)).

### Hafıza dosyalarının boyutu

`Last-Session.md` son oturumların devir kartlarıdır: her oturum `## YYYY-MM-DD HH:MM · <etiket> · <session_id[:8]>` başlığıyla kendi kartını açar ve yalnız onu düzenler. `Threads.md` açık konuların güncel durumudur. İkisi de yerinde güncellenir.

Varsayılan sınırlar 3.000 ve 8.000 karakterdir. Sınır aşılınca oturum `Memory hygiene:` uyarısıyla açılır ve asistan `python3 beyin.py companion-compact` çalıştırır: eski bölümler kelimesi kelimesine companion klasöründeki `Arşiv/` altına taşınır. Hiçbir metin silinmez ya da özetlenmez, model çağrılmaz. Planı önce görmek için `--dry-run`; sınırları değiştirmek için `preferences --last-session-chars 4000 --threads-chars 12000` (`0` kapatır). [Ayrıntılar](docs/v3/COMPANION-PARITY.md)

## Gizlilik: notların nereye gider?

Cortex notlarını kendi başına hiçbir yere göndermez ve telemetri toplamaz. Tek otomatik ağ isteği, günde en çok bir kez GitHub'a sorulan "yeni sürüm var mı?" sorusudur; not, prompt ya da hesap bilgisi taşımaz (`preferences --update-notifications off` kapatır). `pyn kontrol` npm'e yalnız sen çalıştırdığında sorar.

Asıl akış şudur: yazdığın mesajla eşleşen notlar asistanının bağlamına eklenir ve böylece **kullandığın yapay zekâ sağlayıcısına** (Anthropic, OpenAI, Google…) gider. Sistemin amacı budur; ama varsayılan olarak vault'taki her not adaydır. Kendini korumak için:

- **Tek bir notu dışarıda tut.** Notun en başına şu üç satırı koy; not otomatik bağlama hiç girmez, yalnız açıkça istediğinde okunur:

  ```
  ---
  visibility: private
  ---
  ```

- **Hassas notları ayrı tut.** Sağlık, finans gibi notlar için Cortex'i kurmadığın ayrı bir vault en temiz yoldur. Nokta ile başlayan klasörler (`.gizli/`) hiç indekslenmez, ama Obsidian bunları kenar çubuğunda göstermez.
- **Sır süzgeci.** `preferences --secret-filter on`, asistanın yazdığı notlarda, makbuzlarda ve görevlerde API anahtarı ve parola gibi sırları maskeler. Varsayılan kapalıdır.

Arama indeksi vault'un dışında, yalnız senin hesabının okuyabildiği bir klasörde durur (Windows: `%LOCALAPPDATA%\beyin-v3\…`, macOS: `~/Library/Application Support/beyin-v3/…`, Linux: `~/.local/state/beyin-v3/…`) ve notlarının bir kopyasını içerir. Vault'u herkese açık bir git deposuna koyacaksan `.beyin-runtime.json` dosyasını dışarıda bırak: bu makinedeki tam yolu, dolayısıyla kullanıcı adını içerir ([birden çok makine](docs/v3/MULTI-MACHINE.md)).

## İsteğe bağlı eklentiler

### Tek tuşla beyne at: yakala

Video, tweet, makale, mail ya da dosyayı gördüğün yerde yakala; asistan metni çıkarıp dersleri `knowledge/` notlarına bağlasın.

1. Bir kez kur: `python3 beyin.py yakala kur` (Windows'ta `py -3`).
2. Her uygulamada Windows'ta `Ctrl+Alt+B`, Mac'te `Control+Option+B`. Tarayıcıda Obsidian Web Clipper'ın "Beyne at" şablonu.
3. Asistanına "yakalananları işle" de.

YouTube'da önce altyazı kullanılır, yoksa ses yalnız yerelde yazıya dökülür. Tuşu değiştirmek için `beyin.py yakala kisayol 'cmd+"'`. [Ayrıntılar](docs/v3/YAKALA.md)

**Sesle yazma (Windows, isteğe bağlı):** `py -3 beyin.py ses kur` ile pencereye konuşarak yazarsın.
- Mikrofona tıkla ya da Ctrl+Alt+B'ye yeniden bas; sonda "kaydet" dersen kart kaydedilir.
- `beyin.py ses ayar --uyandirma ac` ile "Pyn, not al" demek pencereyi açar.
- Ses bilgisayardan çıkmaz; çeviriyi yerelde Whisper yapar, NVIDIA, AMD Radeon ve Intel Arc kartlarda ekran kartında. [Ayrıntılar](docs/v3/YAKALA.md#sesle-yazma-windows-isteğe-bağlı)

### Ananas teması

Obsidian için isteğe bağlı görünüm: fildişi kâğıt, mürekkep kontur, sert gölgeli kartlar, Fraunces başlıklar. Yazı tipleri temanın içinde gelir, internet gerekmez.

```sh
python3 beyin.py tema kur     # Windows'ta: py -3 beyin.py tema kur
```

Obsidian açıksa Ayarlar > Görünüm > CSS parçacıkları > yenile. `tema durum` kurulu ve güncel olup olmadığını söyler; `tema kaldir` geri alır.

Tema yalnız `.obsidian/snippets/ananas.css` dosyasını yazar ve onu `.obsidian/appearance.json` içinde etkinleştirir. Notlara, motora ve diğer Obsidian ayarlarına dokunmaz; senin yazdığın bir `ananas.css` dosyasının üzerine yazmaz. Kenar çubuğunda klasörler sade Türkçe etiketlerle görünür (`🔮 850-Companion` → Pyn, `receipts` → Makbuzlar, `📥 000-Inbox/Yakala` → Yakalananlar); diskteki adlar değişmez.

## Tüketim ve kontrol sıklığı

Asistanına **"ekonomik moda geç"**, **"otomatik kontrolleri kapat"** ya da **"kontrol aralığını 30 dakika yap"** diyebilirsin. Bütün istemciler aynı vault tercihini kullanır; güncellemeler tercihini korur.

| Mod | Yerel kontrol | Oturuma eklenen bağlam |
| --- | --- | --- |
| Normal (varsayılan) | Her ilgili istemci olayında | Oturum başında ve mesajlarda, en çok 5.000 karakter |
| Ekonomik | Yeni oturumda; sonra en az 15 dakika arayla | Yalnız oturum başında, en çok 2.000 karakter |
| Manuel | Otomatik kapalı | Otomatik kapalı |

Süre dolunca kendi başına çalışan bir zamanlayıcı kurulmaz; bir sonraki istemci olayı kontrolü başlatır. Yerel Python kontrolleri **model çağırmaz**. Asistana yaptırdığın işler ve eklenen bağlam, istemcinin normal kullanımına girer.

Tercih komutları: `preferences --profile economical`, `preferences --profile manual`, `preferences --interval-minutes 30`, `preferences --secret-filter on`. [Ayrıntılar](docs/v3/PREFERENCES.md)

İsteğe bağlı Jev danışmanı bundan ayrıdır: varsayılan kapalıdır ve yalnız kendi TypeSafe API anahtarı olanlar içindir; kurucu onu ne sorar ne kurar. Anahtar istemeyen yerel seçenek olarak ayrı kurulan Laya sunucusu yalnız gölge modda çalışır. [Ayrıntılar ve sınırlar](docs/v3/JEV.md)

## Güncelleme

Yeni bir Cortex sürümü çıktığında `pyn` bunu sana söyler: karşılama kutusunun en üstünde **"Yeni sürüm: Cortex X.Y.Z hazır"** satırı ve menünün "Dikkat" bölümünde bir uyarı çıkar. Güncellemek için tek komut:

```sh
pyn guncelle
```

Ya da asistanına **"beynimi güncelle"** de, veya vault'taki kısayolu aç: Windows'ta `Beyni Guncelle.cmd`, macOS'ta `Beyni Güncelle.command`, Linux'ta `Beyni Güncelle.desktop` ya da `Beyni Güncelle.sh`. Terminalden:

```sh
python3 beyin.py update --check   # yeni sürüm var mı?
python3 beyin.py update           # kur
```

Güncelleme yalnız resmi GitHub **stable release** paketinden yapılır; geliştirme dalından kendiliğinden kod çekmez. Paket önce doğrulanır (checksum, manifest, dosya hash'leri), ardından notlarına dokunmadan ayrı bir deneme vault'unda çalıştırılır ve ancak bundan sonra uygulanır. Bir kesintiden sonra `recover`, geri dönmek için `rollback` kullanılır.

Yeni sürüm kontrolü oturum başında günde en çok bir kez yapılır; otomatik kurulum yapılmaz.

- Bildirimi kapat / aç: `preferences --update-notifications off` / `on`
- Bir sürümü sustur: `update --dismiss X.Y.Z`
- İnternetsiz güncelleme: `update --package "/indirilen/beyin-v3-X.Y.Z.zip"`

[Güncelleme rehberi](docs/v3/UPDATE.md)

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| cmd'de `pyn` yazınca bir şey olmuyor | Vault'ta `pyn kur`u yeniden çalıştır, sonra **yeni** bir terminal aç. |
| Karşılama kutusunda mühür yok | Terminal resim çizmiyordur (Sixel). Windows Terminal'i güncelle ya da `PYN_LOGO=1` ile dene. |
| Windows Terminal'de Pyn profili yok | Ayar dosyanda yorum satırı varsa `pyn kur` onu bilerek değiştirmez. Profili Windows Terminal ayarlarından elle ekleyebilirsin. |
| Bir istemci açılmıyor ya da "yeni sürüm gerekli" diyor | `pyn kontrol` eski istemcileri ve güncelleme komutlarını gösterir. Menü de son kontrolden kalan uyarıları "Dikkat" altında listeler. |
| Menüde Ollama ya da LM Studio kırmızı | Sunucu kapalı ya da yüklü model yok. Uygulamayı açıp bir model yükle, `pyn`'i yeniden çalıştır. |
| Gemini CLI `IneligibleTierError` veriyor | Google bireysel Google hesabıyla girişi kapattı. Gemini CLI'de API anahtarıyla giriş yap ya da başka bir istemci kullan. |
| Asistan notları hatırlamıyor | İstemcide hook güvenini onayladığını kontrol et, sonra `beyin.py doctor` çalıştır ya da asistana "beyin-doktor ile kontrol et" de. |
| Oturum `Memory hygiene:` uyarısıyla açılıyor | `beyin.py companion-compact` eski kayıtları silmeden arşive taşır. |

## Eski bir kurulumdan geliyorsan

Cortex'ten önceki bir ikinci beyin kurulumun varsa (Cortex'in doğduğu açık kaynak projenin eski sürümleri), aynı kurucuyu mevcut vault üzerinde bir kez çalıştır ([Yol 2](#yol-2-elle-kur)). Notlar, companion dosyaları, `daily/` ve `knowledge/` içerikleri korunur. Tanınan eski yazıcılar geri alınabilir biçimde devreden çıkarılır; özelleştirilmiş bir sistem dosyası ya da çalışan eski bir arka plan işi varsa işlem durur ve ne yapılacağını söyler. Sonraki güncellemeler Cortex'ten gelir.

Eski sürümlerdeki, arka planda model çağıran günlük özetleyici Cortex'te yoktur; onun yerine asistan bilinçli olarak iş sonucu ve bilgi notu yazar. Eski günlükler yeniden özetlenmez. [Geçiş ayrıntıları](docs/v3/MIGRATION.md)

### Ne korunur, ne ölçülür?

Kullanıcı notları, güncelleyicinin değiştireceği sistem dosyaları değildir. Yönetilen bir dosyada farklı bir değişiklik görülürse çakışma bildirilir; ilgisiz desteklenen ayar değişiklikleri birleştirilir. Yedek ve journal vault'un dışında, yereldedir.

Arama yerel kelime eşleştirmesi kullanır; genel doğal dil anlama ya da her soruda doğru hatırlama sözü vermez. Otomatik doğrulamalar ve gerçek istemci kontrolleri [ayrı raporlanır](docs/v3/README.md).

## Sürüm geçmişi

| Sürüm | Öne çıkan |
| --- | --- |
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

[Kaynak formatı](docs/v3/MARKDOWN.md) · [Runtime](docs/v3/RUNTIME.md) · [Semantik test sözleşmesi](docs/v3/SEMANTIC-TEST-CONTRACT.md) · [Sürüm paketi ve güncelleyici](docs/v3/UPDATE.md) · [Birden çok makine](docs/v3/MULTI-MACHINE.md) · [OpenCode](docs/v3/OPENCODE.md) · [Hermes](docs/v3/HERMES.md) · [OMP](docs/v3/OMP.md)

## Lisans ve marka

Kod açık kaynaktır: [MIT lisansı](LICENSE). Kullanabilir, değiştirebilir ve dağıtabilirsin. **Cortex** ve **Pyn** adları, Pyn'in mührü ve logo dosyaları ise lisansın dışındadır: değiştirilmiş bir sürümü kendi adınla ve kendi görsellerinle yayınla. Neyin serbest olduğu: [MARKA.md](MARKA.md).

Bilgi derleme fikri için [Karpathy'nin bilgi tabanı desenine](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) teşekkürler.

---

<p align="center">
  <img src="tema/ananas/marka/pyn-muhur-56.png" width="28" alt=""><br>
  <b>Cortex</b>, <a href="https://solelunatech.com"><b>SoleLuna Tech</b></a> tarafından geliştirilir.
</p>
