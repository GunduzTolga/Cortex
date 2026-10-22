# Kurulum, güncelleme ve geri alma

Vault içindeki `beyin.py` tek giriş noktasıdır. Komutları vault klasöründe çalıştır. Aşağıdaki örneklerde macOS/Linux için `python3` kullanılır; Windows'ta bunun yerine `py -3` yazılır. Python 3.11+ gerekir.

## Git kullanmadan ilk kurulum

[Son kararlı release sayfasından](https://github.com/GunduzTolga/Cortex/releases/latest) `beyin-v3-X.Y.Z.zip` paketini indirip aç (`X.Y.Z` sayfadaki sürüm numarasıdır). Paket ve minimum gereksinimler sürüm sayfasında belirtilir. GitHub'ın otomatik kaynak arşivi ile ürün paketi farklıdır.

Bir vault klasörü seç veya oluştur. Açılan paketin içinde:

```sh
python3 scripts/install_v3.py --vault "/tam/yol/Beynim"
```

Windows örneği:

```powershell
py -3 scripts/install_v3.py --vault "C:\Notlar\Beynim"
```

Runtime varsayılan olarak işletim sisteminin yerel uygulama verisi alanına, vault dışında kurulur. İstersen kurulumda `--state "/ayri/yerel/dizin"` verebilirsin; yalnız bu uygulama için ayrılmış bir dizin seç. Kurulu giriş ve başlatıcılar bu seçimi hatırlar. Yeni hesap, Git, pip veya servis kurulmaz.

İlk bağlantı için AI istemcisinde vault'u açıp yeni oturum başlat. Hook tanımları değiştiğinde istemcinin gerekli güven incelemesini tamamla; updater güven kaydı üretmez.

## Kontrol ve güncelleme

```sh
python3 beyin.py doctor
python3 beyin.py update --check
python3 beyin.py update
```

`doctor` yerel kayıtları, bekleyen işleri ve sorunları gösterir. Bir metadata raporu gerçek istemci teslimi veya her notun doğru yorumlandığı kanıtı değildir.

`update --check` resmi stable release'i inceler ve paketi geçici alanda doğrular. Vault ve mevcut runtime dosyalarını değiştirmez. Paket verilmezse ağ erişimi gerekir. `update` aynı doğrulamadan sonra yeni sürümü uygular; sayısal sürüm sırası kullanılır.

Sonuçlar:

- `updated`: yeni sürüm yazıldı.
- `refreshed`: paket kurulu sürümle aynı numarayı taşıyor ama kodu farklı (aynı sürümün sonraki bir derlemesi); farklı dosyalar güncellemeyle aynı journal içinde yazıldı ve `rollback` ile geri alınabilir. Karşılaştırma kurucunun son yazdığı kayda (`v3-install.json` içindeki `installed_hash`) göre yapılır: elle değiştirdiğin bir motor dosyası tek başına yenileme sebebi sayılmaz. `--check` bu durumu `available` ve `refresh: true` olarak bildirir.
- `noop`: kurulu sürüm paketle aynı.
- `ahead`: kurulu sürüm yayımlanmış son sürümden ileride (örneğin masaüstü uygulamasıyla gelen sürüm henüz yayımlanmamış). Bu bir hata ya da geri alma önerisi değildir; paket indirilmez.

Eski bir paketi `--package` ile vererek downgrade yapılmaz; geri dönüş için `rollback` kullanılır.

Kurulu bir Ananas teması (`beyin.py tema kur`) her güncellemeden sonra yeni sürümün CSS'ine yenilenir; Obsidian'da temayı kapattıysan kapalı kalır, Cortex'in yazmadığı bir `ananas.css` dosyasına dokunulmaz. Elle yenilemek için: `beyin.py tema yenile`.

Varsayılan indirme kaynağı `GunduzTolga/Cortex` deposunun resmi GitHub stable release'idir. Preview, hareket eden geliştirme dalı veya üçüncü taraf paket kaynağı otomatik seçilmez. Stable release ya da beklenen ZIP yoksa bunu hata olarak bildirir; yayın varmış gibi sonuç vermez.

Yerel, önceden indirilmiş ZIP ile ağ gerekmez:

```sh
python3 beyin.py update --check --package "/indirilen/beyin-v3-X.Y.Z.zip"
python3 beyin.py update --package "/indirilen/beyin-v3-X.Y.Z.zip"
```

Yerel paketi yalnız güvendiğin kaynaktan al: checksum bütünlüğü kontrol eder; bağımsız bir imza veya kaynak güveninin yerine geçmez.

## Tıklanabilir başlatıcılar

Kurucu vault'a yalnız ilgili platformun başlatıcısını koyar:

| Platform | Başlatıcı |
| --- | --- |
| macOS | `Beyni Güncelle.command` |
| Windows | `Beyni Guncelle.cmd` |
| Linux | `Beyni Güncelle.desktop` ve `Beyni Güncelle.sh` |

Hepsi kurulu `beyin.py update` komutunu çağırır, ayrı güncelleme mantığı içermez. İşletim sistemi dosyanın açılması/çalıştırılması için izin isteyebilir. Özel Python/runtime yolu kurulumda kaydedilir; Python'u sonradan taşıdıysan kurulumu yeniden değerlendirmek gerekir.

## Kesinti veya sorun

```sh
python3 beyin.py recover
python3 beyin.py rollback
```

`recover`, yarım kalan işlemin journal'ını okuyup planlanan işlemi tamamlar. Bir hata mesajı işlemin iptal edildiği anlamına gelmez; bazı sistem dosyaları yazılmış, başarılı sürüm damgası henüz yazılmamış olabilir. Paketin `install_v3.py` komutunu aynı vault için yeniden çalıştırmak da bekleyen journal'ı tamamlar (`install_resumed: true`).

Kurtarma, kesintiden önceki ön koşulları olduğu gibi tekrar oynatmaz, bugünkü vault'a göre yeniden değerlendirir:

- V2 geçişinin kanıtı (notların ve eski V2 durumunun parmak izi) kurtarma başında, V2 yazıcı kilitleri tutulurken yeniden alınır. Kurulum sırasında ya da kesintiden sonra değişen bir not artık her denemeyi aynı hatayla durdurmaz. Kurulum sürerken bir not değişirse ilk deneme `migration_changed` koduyla durur; ikinci deneme tamamlar.
- Henüz yazılmamış bir dosyayı kesintiden sonra değiştirdiysen: ayar dosyalarında (`.claude/settings.local.json`, `.codex/hooks.json`, `.gemini/settings.json` ve benzerleri) eklediğin anahtar (ör. bir sohbette "Her zaman izin ver") yeni sürümün girdileriyle birleştirilir; `AGENTS.md` ve `CLAUDE.md` içinde yönetilen bloğun dışına yazdığın metin korunur, yalnız blok yenilenir. Kurulum kaydı birleşmiş içeriği yazar. Motor dosyalarındaki bir değişiklik ve yönetilen bölümün içindeki bir düzenleme hâlâ çakışmadır.

Giriş (`beyin.py`) her zaman motorun komut satırı modülünden (`beyin_v3_cli.py`) sonra yazılır. Yine de iki dosya farklı sürümlerden kalırsa `update`, `recover` ve `rollback` komut satırı modülü olmadan da çalışır.

`rollback`, son sistem işleminin yedeğini geri getirir. [Opsiyonel global köprüyü](GLOBAL-BRIDGE.md) kendin eklediysen, köprüyü içermeyen eski bir kuruluma (öncül projenin 3.1.0 ve öncesi sürümleri) `rollback` veya `uninstall` yapmadan önce global ayardaki köprü handler'larını kaldır; olmayan bir scripti global hook'ta bırakmak istemci hatası üretir. Eski 2.x kurulumundan ilk geçişte önceki sürüm ve tanınan eski runner'lar da geri yüklenir. Temiz Cortex kurulumunu geri almak `uninstalled` olarak raporlanır; olmayan bir eski sürüm uydurulmaz. Sonradan eklediğin kullanıcı notları silinmez. Bu komut bütün vault geçmişini geri alan bir işlem değildir.

Yönetilen dosyada araya giren kullanıcı değişikliği varsa işlem bunu ezmek yerine conflict ile durur. `rollback` kullanıcının payı olan dosyalarda yalnız yönetilen bölümü geri alır: `AGENTS.md` ve `CLAUDE.md` içinde blok dışına yazdığın metin, JSON ayarlarında (`.claude/settings.local.json`, `.claude/settings.json`, `.codex/hooks.json`, `.agents/hooks.json`, `.gemini/settings.json`, `.qwen/settings.json`) eklediğin anahtarlar ve güncellemenin değiştirmediği `CLAUDE.md` / `.codex/config.toml` dosyalarına sonradan eklediğin satırlar korunur. Yönetilen bölümün kendisi değiştiyse ya da bir motor dosyası elle düzenlendiyse veya silindiyse inceleme gerekir. Kilitli/aktif bir writer varsa tamamlanmasını bekleyip tekrar dene. Kaybolmuş bir işin kilit/sentinel dosyasını gelişigüzel silme.

Yalnız satır sonu farkı değişiklik sayılmaz: `core.autocrlf` ya da bir editör yönetilen dosyayı CRLF'e çevirmişse güncelleme, kaldırma ve rollback durmaz, dosya yeniden yazılırken stok LF biçimine döner. Kurulum, güncelleme ve rollback çakışmayı Türkçe ve dosyanın adıyla söyler (ör. `Cortex'in yönettiği .claude/scripts/beyin_v3.py dosyası elle değiştirilmiş` ya da `silinmiş`); kaldırma (`--uninstall`) mesajı `content differs` ya da `deleted` der.

### Hata kodları

`beyin.py` ve paketin `install_v3.py` komutu bir işlem başarısız olunca stderr'e tek satır JSON yazar: `{"error": "<tür>", "message": "<Türkçe cümle>", "code": "<kod>"}`. `code` yalnız masaüstü uygulamasının tanıdığı durumlarda vardır ve uygulama onu pencerenin dilinde, yapabildiği bir eylemle söyler:

| Kod | Ne oldu |
| --- | --- |
| `updater_busy` | Motor başka bir işi bitiriyor (bir sohbetin hafızası yazılıyor); birkaç saniye sonra yeniden dene. |
| `update_conflict` | Yönetilen bir dosya elle değiştirilmiş ya da kurucunun yazacağı adda başka bir dosya var. |
| `rollback_conflict` | Geri alınacak bir dosya güncellemeden sonra değiştirilmiş. |
| `pending_journal` | Yarım kalmış bir kurulum var; önce `recover` ya da `rollback`. |
| `migration_changed` | Notlar kurulum sürerken değişti; yeniden dene. |
| `python_too_old` | Python 3.11'den eski. |
| `legacy_review` | Eski V2 runner'ı elle değiştirilmiş ([MIGRATION](MIGRATION.md)). |
| `network` | GitHub'a ulaşılamadı. |
| `disk_full` | Diskte yer kalmadı. |
| `vault_moved` | Vault taşınmış ya da kopyalanmış; `beyin.py relocate` (aşağıda). |

## Vault'u taşımak ya da kopyalamak

Hook komutları, hafıza veritabanı (`vault_root`), güncelleme journal'ları, güncelleme başlatıcısı ve Hermes/OMP eklentileri vault'un kurulduğu klasörü adıyla taşır. Vault taşındığında (OneDrive'ın Belgeler klasörünü devralması, yeniden adlandırma) ya da kopyalandığında vault klasöründe şunu çalıştır:

```sh
python3 beyin.py relocate
```

- Eski klasör artık yoksa (ya da orada bu state'e bağlı kurulu bir vault kalmadıysa) vault taşınmıştır: hafıza yeni yere bağlanır, hook komutları `.bak` yedekleriyle yeniden yazılır, başlatıcı ve eklentiler yeni yolla yenilenir. Sonuç `relocated`.
- Eski klasör hâlâ aynı state'e bağlı kurulu bir vault ise bu klasör bir kopyadır: iki vault bir hafızayı paylaşmaz. Kopyaya bu makinenin kendi varsayılan state klasörü açılır, kurulum kaydı oraya taşınır, `.beyin-runtime.json` ve hook komutları yeni state'i gösterir. İndeks notlardan yeniden kurulur; state'teki ayarlar varsayılandan başlar. Özgün vault'a ve state'ine dokunulmaz. Sonuç `separated`.
- Zaten bu klasöre bağlıysa hiçbir şey yazılmaz: `unchanged`.

Masaüstü uygulaması bunu bir vault'u her açışında kendisi yapar. State'te kurulum kaydı yoksa (vault başka bir bilgisayardan geldiyse) `relocate` `vault_moved` koduyla durur ve yeniden kurmanı söyler; o zaman paketin `install_v3.py` komutu bu makine için yeni bir state sabitler ve diğer bilgisayarın yollarını taşıyan kurulum dosyalarını (başlatıcı, eklentiler, Kiro hook dosyası) bu makinenin sürümüyle değiştirir; bulduğu kopyalar kurulum kaydında `original` olarak kalır.

Hook komutları hiçbir zaman 2 çıkış koduyla bitmez: Claude Code, Codex ve Qwen 2'yi "engelle" diye okur ve taşınmış bir vault'ta her istem reddedilirdi. Python'un betiği bulamaması ya da bir argüman hatası 1 olarak döner; hata görünür, hiçbir şeyi engellemez.


## State dizinini taşımak

State dizini vault'un dışında, yerel hesap altındadır ve varsayılan yeri işletim
sisteminin uygulama verisi alanıdır (Windows'ta `%LOCALAPPDATA%`). Bazı durumlarda bu
varsayılanı bırakıp state'i başka bir yere almak gerekir:

- İstemci **MSIX paketi** olarak kuruluysa Windows `%LOCALAPPDATA%` yolunu paketin
  kapsayıcısına yönlendirir (`...\Packages\<paket-kimliği>\LocalCache\Local\...`).
  Paket içinden ve paket dışından çalışan süreçler aynı dizeyi okuyup farklı dizine
  gidebilir; o zaman hafızanın yarısı bir tarafta, yarısı diğerinde kalır.
- Kapsayıcı yolu paket kimliğini içerir. Uygulama farklı bir kimlikle yeniden kurulursa
  ya da kapsayıcı sıfırlanırsa sabitlenmiş yol geçersiz kalır.
- `%LOCALAPPDATA%` bulut ile eşitlenen bir klasöre yönlendirilmişse state eşitlenmemelidir.

Taşıma desteklenen bir işlemdir: `install_v3.py --state` yeni yolu sabitler. Veritabanı
**vault kök yoluna** bağlıdır, state yoluna değil; bu yüzden aynı vault için state'i taşımak
veritabanını geçersizleştirmez. Vault'u taşımak ayrı bir konudur: `beyin.py relocate`
veritabanını vault'un yeni köküne bağlar (yukarıda, "Vault'u taşımak ya da kopyalamak").

### Adımlar

1. **Ajan oturumlarını kapat.** Çalışan bir worker state'e yazıyor olabilir.

2. **Mevcut yolu oku.** Vault kökündeki `.beyin-runtime.json` dosyasındaki `state`
   alanı sabitlenmiş yoldur. Bu dosyayı elle değiştirme; kurucu yazar.

3. **Hedefi seç.** Vault'un dışında, yalnız bu uygulamaya ayrılmış, yerel sabit bir
   diskte ve bulut eşitlemesi olmayan bir dizin. Örnek: `F:\beyin-v3-state`.

4. **Dizini kopyala.** Tüm içerik taşınır: `memory.sqlite3`, `v3-install.json`,
   `hook-queue/`, `hook-done/`, `markdown-journal/`, tercih ve cache dosyaları.
   Kopya sonrası dosya hash'lerini karşılaştır.

5. **`update-journal.json` dosyasını kopyalama.** Yarıda kalmış bir güncellemeden
   kalan journal varsa yeni konuma taşınmamalıdır. `install_v3.py` hedef state'te
   bekleyen bir journal görürse taze kurulum yapmaz; `recover` çağırıp **eski işlemi
   sürdürür** ve eski sabitlemeyi hedefler. Sonuç `install_resumed: true` döner ve
   `.beyin-runtime.json` yeni yolu göstermez. Eski dizinde journal varsa önce orada
   `beyin.py recover` ile işlemi tamamla, sonra kopyala.

6. **Kurucuyu yeni yolla çalıştır.** Önce planı incele:

   ```powershell
   py -3 scripts/install_v3.py --vault "C:\Notlar\Beynim" --state "F:\beyin-v3-state" --plan
   ```

   Plan temizse aynı komutu `--plan` olmadan çalıştır. Kurucu dizini oluşturduktan
   **sonra** yeniden çözümleyip kanonik yolu sabitler.

7. **İki taraftan doğrula.** `py -3 beyin.py doctor --json` komutunu hem ajan kabuğundan
   (paket içi) hem de normal bir PowerShell penceresinden (paket dışı) çalıştır; aynı
   sonucu vermeli. `state_location` alanı `warnings` listesini boş, `sibling_state_roots`
   listesini de tek girdili (ya da boş) göstermeli. `--json` olmadan çalışan insan okunur
   çıktıda her uyarı `State konumu (bilgi):` ile başlayan bir satırdır; hiç olmamalı.

8. **Eski dizini ancak bundan sonra sil.** Doğrulama geçene kadar dur.


### Bölünmüş state'i tanımak

Bölünme kendini bozuk bir kurulum gibi göstermez: iki dizin de gerçekten vardır ve
ikisinde de `v3-install.json` bulunur, çünkü biri paket içinden biri paket dışından
kurulmuştur. Tek başına bakıldığında ikisi de sağlıklı görünür; fark, oturumun hangi
yarıyı okuduğunun sürecin paket içinde olup olmamasına bağlı olmasıdır.

`doctor` bunu `state_location` altında raporlar:

- `sibling_state_roots`: aynı vault anahtarı için kurulu bulunan bütün state kökleri,
  dizin kimliğine göre bir kez sayılır. Birden fazlaysa `state_split` uyarısı verilir.
  Paket içinde düz yazım da kapsayıcıya yönlendirildiği için gerçek bir bölünme en
  güvenilir biçimde **paket dışından** görünür.
- `pinned_in_package_container`: sabitlenmiş yol `Packages\...\LocalCache` içinden geçiyor.
- `pin_resolves_elsewhere`: bu süreç sabitlenmiş dizeyi başka bir dizine çözümlüyor. Alan
  her platformda doldurulur, uyarı yalnız Windows'ta verilir; macOS ve Linux'ta bir
  symlink her süreç için aynı yere gider, bölünme doğurmaz.
- `pinned_state_empty`: sabitlenmiş kökte kurulum bulunamadı.
- `effective_state_differs`: bu çalışma sabitlenmiş kök yerine başka bir state okuyor
  (örneğin kaynak CLI farklı bir `--state` ile çağrıldı).

Bunlar bilgi amaçlıdır; `doctor` durumunu yükseltmezler. Bölünme görürsen hangi yarının
güncel olduğuna karar ver (`memory.sqlite3` tarihleri ve makbuz sayısı yardımcı olur),
onu yukarıdaki adımlarla taşı; diğerini ancak adım 7 doğrulaması geçtikten sonra sil.

### Yönlendirme öncesi yolla sabitlenmiş eski kurulumlar

Cortex'ten önceki eski kurulumun (öncül projenin 3.4.0 ve öncesi sürümleri, #114 düzeltmesinden önce) yaptığı bir MSIX kurulumunda sabitlenmiş
yol yönlendirme uygulanmadan yazılmış olabilir. Bu kendiliğinden düzelmez. Düzeltmek için
#114'ü içeren kurucuyu **paket içinden** (ajan kabuğundan) mevcut `--state` değeriyle
yeniden çalıştır; sabitleme yönlendirilmiş kanonik yola döner. Bu durumda kopyalama
gerekmez, ama adım 5'teki kural geçerlidir: bekleyen bir `update-journal.json` varsa önce
`beyin.py recover` çalıştır, sonra adım 6'daki gibi önce `--plan` ile incele.

#### `update` ve `recover` ikisi de `transaction target escapes root` veriyorsa (#139)

Paket içinden bakıldığında state kökü eski yazımında kalıp içindeki dosyalar
`Packages\<paket>\LocalCache\...` altına çözümlenebilir. Bu, kökün kendisi paket dışında da
var olduğunda olur. Bu sürümden önceki güncelleyici iki yazımı farklı dizin sayıp işlemi
durduruyordu; `recover` ve bekleyen journal'ı `recover`'a devreden kurucu da aynı kontrolden
geçtiği için üçü de takılı kalıyordu. Artık hedef kökün altında adıyla duruyor ve arada kök
dışına götüren bir link (symlink, junction) yoksa yazılıyor; kök dışına çıkan link hala
reddedilir.

Takılı bir vault kendi kurulu `recover`'ıyla bu duvarı aşamaz, çünkü kurulu güncelleyici
eski kontrolü taşır. Düzeltmeyi içeren sürümün paketini indirip aç, sonra **paket içinden**
(ajan kabuğundan) `.beyin-runtime.json`'daki `state` değeriyle kurucuyu çalıştır:

```powershell
py -3 scripts/install_v3.py --vault "C:\Notlar\Beynim" --state "<.beyin-runtime.json'daki state>"
```

İlk çalıştırma bekleyen işlemi tamamlar (`install_resumed: true`). Aynı komutu bir kez daha
çalıştır; bu sefer yeni sürüm kurulur ve vault düzeltilmiş güncelleyiciyi alır. Sonra
`beyin.py doctor` ile doğrula. Sabitleme dosyasını elle değiştirme.

## Neler değişir?

Paket yalnız yönetilen motor dosyaları, kurulu giriş/başlatıcılar, üç çekirdek skill ve istemci bağlantılarını günceller. Aynı adlı özel skill veya değiştirilmiş yönetilen script sessizce ezilmez. İlgisiz kullanıcı ayarları desteklenen birleştirme kurallarıyla korunur. Markdown notlar, Companion metinleri ve eski günlük/bilgi kaynakları paket içeriğiyle değiştirilmez.

Eski 2.x kurulumundan geçişte hash ile tanınan stok writer'lar geri alınabilir, etkisiz girişlerle değiştirilir. Böylece önceden açılmış istemcide kalan eski komut da model derleyicisini yeniden başlatmaz. Özelleştirilmiş runner'lar ve proje dışındaki zamanlayıcılar ayrıca değerlendirilir. [Geçiş rehberi](MIGRATION.md).

## Uygulanan kontroller

Arşiv izin listesi, dosya SHA256, sürüm ve runtime şeması doğrulanır. Paket Python dosyaları derlenir; yeni kod ayrı sentetik vault'ta init, sync, kaynak arama ve receipt testinden geçer. Gerçek vault notları bu test için kullanılmaz. Uygulamada yerel kilit, önceki/yeni dosya içerikleri ve modlarıyla kalıcı journal, yönetilen dosya hash kontrolleri ve sürümden önce runtime veritabanı kontrolü vardır. Sürüm damgası en son yazılır.

Bu kontroller dağıtık cloud kilidi veya bütün harici uygulamalar için atomik transaction değildir. Başka bir editörün görülen değişiklikleri korunur; gerçek istemci davranışı ayrı doğrulanır. [Platform raporu](PLATFORM-TESTS.md).

## Bileşen hariç tutma ve güncellemeler

Kullanıcı gereksinim duymadığı bileşenleri (`skills/<ad>`, `adapters/<ad>`, `launchers`, `agents_block`, `harnesses/antigravity`) kurulumda `--exclude-component` ile veya çalışma zamanında `beyin.py preferences --exclude-component <ad>` ile hariç tutabilir (`--include-component` ile geri açabilir).

- `update` ve `install` sırasında hariç tutulan bileşenlere ait yönetilen ve değiştirilmemiş dosyalar diskten temizlenir ve manifestten düşürülür.
- Kullanıcı tarafından değiştirilmiş dosyalar asla silinmez, üzerine yazılmaz; korunur ve işlem özetinde bildirilir.
- Kullanıcı ortak dosyalardaki (`AGENTS.md` veya `.agents/hooks.json`) Cortex'in yönetilen bölgelerini elle kaldırmışsa çakışma üretilmez.
- Rollback yapıldığında önceki durum geri yüklenir; `.beyin-exclusions.json` dosyasındaki hariç tutma tercihleri korunur.

## Geliştiriciler için paket üretimi

Repo kökünde:

```sh
python3 scripts/build_v3_release.py --output "/tmp/beyin-v3-1.0.0.zip" --version 1.0.0
```

Bu komut yalnız yerel ZIP oluşturur, GitHub'a yayınlamaz. Paket `manifest.json`, izin verilen installer/giriş dosyaları, runtime modülleri ve üç skill'i içerir. Manifest sürüm, schema/runtime schema, minimum Python, dosya hashleri ve tanınan legacy hashlerini taşır. Release yayınlama ve final platform CI ayrı işlemlerdir.

## Sürüm bildirimleri

Cortex'ten önceki eski kurulumu (öncül projenin 3.x sürümleri) taşıyan bir vault'u Cortex'e bir kez elle kur (`install_v3.py --vault`); eski kurulumun bildirim kodu eski adrese baktığı için Cortex sürümlerini ancak bu ilk geçişten sonra görürsün. Windows'ta `py -3` kullan. Oturum açılışı ağ beklemez; kısa ömürlü worker yalnız resmi GitHub metadata'sını günde en fazla bir kez kontrol eder. İlk kontrolün sonucu sonraki oturum veya `doctor` çağrısında görünür. Aynı sürüm her prompt'ta tekrar gösterilmez. Notlar ve prompt'lar bu kontrol için gönderilmez, model çağrısı veya otomatik kurulum yapılmaz.

`update --check --metadata-only` yalnız sürüm bilgisini okur: ZIP indirmez, paket kodu çalıştırmaz ve vault/runtime/cache yazmaz. Tam `update --check` mevcut paket doğrulamasını ve geçici sentetik kurulumu çalıştırmaya devam eder. Metadata sonucu paketin kurulabilirlik kanıtı değildir. Ağ hatası “güncelsin” anlamına gelmez; doctor son başarılı kontrol tarihini ve durumu gösterir.

`preferences --update-notifications off/on` bildirimleri ve otomatik sürüm ağı erişimini yönetir; hafıza senkronizasyon tercihini değiştirmez. `BEYIN_UPDATES_OFF=1` bu tercihten önce gelir. `update --dismiss X.Y.Z` yalnız o sürümün oturum bildirimini susturur; doctor sürümü göstermeye devam eder. Tercih ve cache vault dışında state dizinindedir; eski preference şemasına alan eklenmediğinden eski sürüme rollback güvenlidir. İnternet erişimi kapalıyken `update --package /yol/paket.zip` kullanılabilir.

Online ZIP indirmesinde GitHub asset SHA-256 ve varsa resmi checksum dosyası, herhangi bir paket kodu çalıştırılmadan önce doğrulanır. Cache kurulacak paketin kaynağı değildir; kurulum yeniden resmi metadata okur. Checksum bağımsız yayımlayıcı imzası değildir. `context --no-sync` sürüm kontrolü, worker veya bildirim kaydı oluşturmaz.

## Bakımcı için yayın

`VERSION` ve `docs/v3/releases/X.Y.Z.md` aynı sürümü tanımlar. `Verified V3 release package` workflow'u ZIP'i bir kez build eder; altı OS/Python kombinasyonu bu aynı ZIP'i temiz kurulum, devralınan koddan geçiş (deponun ilk commit'i `7177077`'den `0.9.0` etiketiyle build edilir; bu commit yeniden yazılmamalı), no-op, rollback ve kesinti/recover ile doğrular. PR çalışmaları yayın yapmaz.

Main üzerinde manuel `workflow_dispatch` ve `publish=true`, testler yeşilse yayını üç adımda yapar. Önce doğrulanmış motor paketini (`beyin-v3-X.Y.Z.zip` ve `.sha256`) bir draft release'e yükler. Sonra Windows kurulum dosyasını aynı doğrulanmış paketle (ikinci bir derlemeyle değil) bir Windows makinesinde üretip `Cortex-Setup-X.Y.Z.exe` adıyla draft'a ekler; depoda kod imzalama sertifikası varsa dosya imzalanır. Ancak üç dosya da draft'tayken release stable/latest yapılır ve yayınlanmış asset'ler tekrar indirilip doğrulanır. Böylece README'nin gönderdiği "son sürüm" sayfasında kurulum dosyası hiç eksik kalmaz. Bir adım yarıda kalırsa iş akışını aynı commit'te yeniden çalıştır: yayımlanmamış draft bulunur ve aynı baytlarla doldurulur; yayımlanmış bir release'in üzerine hiçbir zaman yazılmaz, yeni sürüm numarası gerekir.

Derleme adımı iki sürüm kuralını da denetler: `desktop/package.json` sürümü `VERSION` ile aynı olmalıdır (kurulum dosyası birinin, kasadaki motor ötekinin adını taşır) ve motor dosyaları (`scripts/install_v3.py`, `scripts/beyin_v3.py`, `scripts/beyin_entry.py`, `template/.claude/scripts`, başlangıç skill'leri) son yayımlanmış etiketten beri değiştiyse `VERSION` o etiketten büyük olmalıdır. Aynı numarayla farklı motor dağıtılırsa ne güncelleyici ne uygulama onu yeni sayar. Opsiyonel global köprü (#41) pakettedir; kurulum ve güncelleme global ayarları değiştirmez ([GLOBAL-BRIDGE.md](GLOBAL-BRIDGE.md)).
