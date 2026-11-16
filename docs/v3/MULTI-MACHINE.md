# Birden çok makinede kullanım

Beyin yerel önceliklidir: makineler arasında senkron kodu yoktur ve Beyin git kurmaz
([UPDATE](UPDATE.md)). Aynı vault'u iki bilgisayarda (ör. iş ve ev) git gibi bir araçla
eşitliyorsan bu belge hangi dosyaların eşitleneceğini ve iki makinenin aynı gün nasıl
çalışacağını anlatır (upstream #112).

Her makine Beyin'i kendisi kurar ve günceller. Runtime (SQLite veritabanı) vault dışında,
makineye özeldir ve eşitlenmez; her makine onu vault'taki Markdown'dan kendisi kurar.

## Ne eşitlenir

| Yol | Git'e girer mi | Neden |
|---|---|---|
| Notlar ve companion dosyaları | evet | Markdown kaynak gerçektir. |
| `🔮 850-Companion/Arşiv/` | evet | `companion-compact` metni canlı dosyadan çıkarıp arşive taşır ve yerine tek bir işaret satırı bırakır. Arşiv tek makinede kalırsa öbür makine içi boş bir işaret görür. Arşivdeki `visibility: private` otomatik bağlama girmez demektir, git dışı demek değildir. |
| `receipts/` | evet | Receipt dosyası yazıldıktan sonra değişmez ve adı `event_id` özetidir (`beyin_v3_sync.py` `receipt()`). Öbür makine yeni receipt'i bir sonraki `sync`'te kendi veritabanına alır (`_scan_receipts()`). |
| `daily/v3/`, `knowledge/v3/` | hayır | Bu görünümler yerel veritabanındaki receipt'lerden üretilir (`beyin_v3_projections.py` `project_receipts()`). Receipt'ler eşitlendiyse aynı saat dilimindeki iki makinede aynı çıkar; dosya adı makinenin yerel günüdür, farklı saat dilimindeki makineler aynı receipt'i farklı güne koyabilir. Git'e alınırlarsa öbür makineden gelen dosya elle düzenlenmiş sayılır (`manual receipt view edit preserved`) ve o görünüm artık güncellenmez. |
| `AGENTS.md`, `CLAUDE.md` | evet | Kullanıcının kendi talimatları da bu dosyalardadır. Beyin bloğu makine yolu taşımaz (`python3 beyin.py sync`), aynı sürümü kuran her makinede aynıdır. Önce güncelleyen makinenin bloğu git'le öbürüne gelirse öbür makinenin güncellemesi onu kendi bloğu sayar ve çakışma vermez. |
| Kurulum dosyaları | hayır | Bir kısmı bu makinenin yollarını taşır (`.beyin-runtime.json`, hook dosyaları, Hermes ve OMP eklentileri); geri kalanı bu makinede kurulu sürüme aittir. Güncellemeyi önce yapan makinenin dosyaları git'le öbürüne geçerse o makinenin kurulum kaydıyla uyuşmaz; yeniden kurulum `Cortex'in yönettiği <dosya> dosyası elle değiştirilmiş` hatasıyla (`update_conflict`) durur. |

## Önerilen `.gitignore`

Cortex masaüstünde "Yeni yedek oluştur" ya da "Var olan kasama bağlan" (`beyin.py esitle --baslat/--baglan`) bu listeyi
`.gitignore`'a kendisi ekler; dosyada zaten olan satırlara dokunmaz.

```gitignore
# Beyin kurulumu: her makine Beyin'i kendisi kurar ve günceller
.beyin-runtime.json
.beyin-version
beyin.py
Beyni Guncelle.cmd
Beyni Güncelle.sh
Beyni Güncelle.desktop
.claude/settings.local.json
.claude/scripts/
.claude/hermes-plugin/
.claude/skills/beyin/
.claude/skills/beyin-doktor/
.claude/skills/beyin-guncelle/
.claude/skills/beyin-yakala/
.agents/hooks.json
.agents/skills/beyin/
.agents/skills/beyin-doktor/
.agents/skills/beyin-guncelle/
.agents/skills/beyin-yakala/
.codex/config.toml
.codex/hooks.json
.gemini/settings.json
.qwen/settings.json
.kiro/hooks/beyin-v3.json
.kiro/skills/beyin/
.kiro/skills/beyin-doktor/
.kiro/skills/beyin-guncelle/
.opencode/plugins/beyin-v3.js
.omp/hooks/pre/beyin-v3.ts
# companion-compact süreçler arası kilidi; kalıcıdır ama kullanıcı verisi değildir
**/.beyin-compact.lock
# note-edit'in bu makineye ait yazma kilidi ve notların eski hâllerinin yedekleri
.beyin-note-write/
# Yerel veritabanından üretilen görünümler: her makine kendisininkini üretir
daily/v3/
knowledge/v3/
# Yakala: ham metinler ve yakalanan dosyalar bu bilgisayarda kalır
📥 000-Inbox/Yakala/.ham/
📥 000-Inbox/Yakala/dosyalar/
# Gizli değerler ve makineye özel çalışma alanı
.env
.obsidian/workspace*.json
```

Kontrol: kurulumdan ya da güncellemeden hemen sonra `git status --short` boş olmalıdır.

`.beyin-runtime.json` yine de başka bir işletim sisteminden geldiyse (Windows'ta `C:\...`,
macOS ya da Linux'ta `/...` yolu) bu makinede mutlak bir yol değildir. `beyin.py` o zaman bu
makinenin varsayılan state dizinini kullanır; her komut bunu stderr'e tek satırla söyler
(stdout ve `--json` çıktısı değişmez) ve `doctor` `pinned_state_not_absolute` olarak gösterir.
Böyle bir vault'un hook dosyaları da öbür makinenin yollarını taşır; `doctor` onları `hook_paths`
altında listeler, bu makinede kurulum ikisini birlikte düzeltir. Kurucu da böyle bir yolu değişmiş dosya saymaz, bu makinenin yoluyla yeniden
yazar (upstream #249). Cortex'ten önceki eski kurulumun (öncül projenin 3.8.1 ve öncesi
sürümleri) `beyin.py`'si bu yolu okuyamadığı için `beyin.py update` çalışmaz; bir kez yeni paketin
kurucusunu çalıştır (`python3 scripts/install_v3.py --vault "<vault>"`; bu makinede özel
state kullandıysan `--state` ile onu ver), sonra dosyayı `.gitignore`'a ekle.

Aynı veya farklı işletim sisteminden (Windows, Linux, macOS) ya da başka bir kullanıcı hesabından
gelen varsayılan state yolları (`AppData/Local/beyin-v3/<vault-hash>`, `.local/state/beyin-v3/<vault-hash>`
veya `Library/Application Support/beyin-v3/<vault-hash>`) yabancı pin sayılır; CLI ve lifecycle hook bu
makinenin ve kullanıcının yerel varsayılan state dizinine geri döner. Özel `--state` dizinleri bu
sezgisel eşlemeden etkilenmez; taşınan vault'ta `doctor` ile pin ve etkin state'i ayrıca doğrula.

`companion-compact` kilit dosyasını companion klasöründe kalıcı bırakır. Dosyanın
silinmemesi, POSIX üzerinde kilit tutulurken aynı yolda yeni bir inode açılmasını önler.
Kilit yalnız aynı paylaşılan dosya sistemini gören süreçleri koordine eder; senkronizasyon
araçlarıyla çoğaltılmış ayrı çalışma kopyaları ve kilit semantiği sunmayan NFS/SMB
kurulumları bu garantinin dışındadır.

- **Cortex'ten önceki eski kurulum (öncül projenin 3.6.0 ve öncesi sürümleri):** O sürümlerde
  blok bu makinenin mutlak komut yolunu taşıyordu. İki makine de Cortex'e geçene kadar `AGENTS.md`'yi (bloğu kendisi taşıyorsa `CLAUDE.md`'yi de) `.gitignore`'da
  tut; ikisi de güncellenince satırı kaldırabilirsin.
- Kendi skill'lerin, `.claude/settings.json` veya başka istemci ayarların bu listede yoktur;
  onları eşitleyip eşitlememek senin kararın.

## Önerilen `.gitattributes`

```gitattributes
# Receipt dosyaları bayt bayt karşılaştırılır: satır sonu dönüştürülmez
receipts/** -text
# Kart ve kayıt düzenindeki companion dosyaları: iki makinenin eklemeleri birlikte kalır
**/Last-Session.md merge=union
**/Journal.md merge=union
**/Arşiv/*.md merge=union
```

**`receipts/** -text`:** Git for Windows kurulumunun varsayılanı `core.autocrlf=true`, eşitlenen
receipt dosyalarını CRLF'ye çevirebilir. Güncel motor yalnız satır sonu farkını aynı receipt
sayar; eski sürümler bayt karşılaştırdığı için `event id collision` bildirebilir. Bu satır
gereksiz bayt değişikliklerini ve eski sürümlerle sorunu önler; `eol=lf` de kullanılabilir.

**`merge=union`:** Git iki tarafın satırlarını da tutar, çakışma çıkarmaz. Satır silmez ama
çift bırakabilir. Bu yüzden yalnız yeni kaydın eklendiği dosyalar için uygundur:
oturum başına kartlı `Last-Session.md`, `Journal.md` ve arşiv. `Threads.md`, `Kurallar.md`
ve `Core.md` bilerek listede değil. Bu dosyalarda bir bilginin tek güncel hali vardır;
iki makine aynı satırı değiştirirse görünür bir çakışma, sessizce yan yana kalan iki
çelişkili satırdan iyidir.

Union ile birleşen kartların sırası zamana göre olmayabilir ve iki kart arasındaki boş satır
tekilleşebilir. `companion-compact` kartları konumlarına değil başlıktaki tarih ve saate
göre sıralar, en yenisini korur.

## Aynı gün iki makinede çalışmak

- **Last-Session:** her oturum kendi kartını açar ve yalnız onu düzenler
  ([companion protokolü](COMPANION-PARITY.md)). İki makinenin kartları union ile birleşir.
- **Threads, Kurallar, Core:** ilgili bölüm yerinde düzenlenir. Git çakışma verirse güncel
  olanı elle seç.
- **Git adımları:** çalışmaya başlamadan önce `pull`; bitince `commit`, `pull --rebase`,
  `push`. Aynı vault'ta birden çok oturum açıksa git komutlarını aynı anda birden çok
  oturumdan çalıştırma; bir oturumdan ya da günün sonunda tek seferde gönder.
- **Paralel oturumlar ve çapraz cihaz farkındalığı:** `preferences --parallel-sessions on` açıkken ajan,
  aynı vault'ta son 45 dakikada etkin başka bir oturum varsa ilk isteminde tek satırlık bir
  uyarı alır ([PREFERENCES.md](PREFERENCES.md#paralel-oturum-bildirimi)). Oturumlar vault kökündeki
  hafif `.presence/<session_id[:24]>.json` dosyaları ve makine-yerel runtime işaretleri ile
  senkronize edilir; oturum kapandığında (`SessionEnd`) dosya temizce silinir, 45 dakikadan eski
  işaretler otomatik elenir (upstream #205).
- **Çakışma çözülmeden oturum açma:** `pull --rebase` çakışmada durduğunda dosyada
  `<<<<<<<`, `=======`, `>>>>>>>` işaretleri kalır. `sync` bu üç işareti sırayla taşıyan
  dosyayı (receipt dahil) indekslemez ve `unresolved git conflict markers` uyarısıyla `degraded`
  döner; dosya çözülene kadar bağlamdan çıkar (upstream #205).
  Kod bloğundaki işaretler de sayılır: notta alıntılanmış bir çakışma örneği de uyarı verir. Önce çakışmayı çöz (`git status` temiz olmalı), sonra
  oturum aç.
- **Dosya senkron servisinin çakışma kopyaları:** iCloud, Dropbox, Syncthing, Google Drive gibi
  servisler çakışmada iki tarafı iki dosya olarak bırakır (upstream #205).
  `sync` hiçbir dosyayı taşımaz, silmez ya da yeniden adlandırmaz; hangi tarafın doğru olduğuna
  sen karar verirsin.
  - Servisin kendi damgasını taşıyan kopya (`Not (… conflicted copy …).md`, `Not (Case Conflict).md`,
    `Not.sync-conflict-20261006-120000-ABCDEF7.md`) indekse alınmaz; `file sync conflict copy`
    uyarısıyla `degraded` döner. Asıl not normal indekslenir.
  - Numaralı ad (`Not 2.md`, `Not (1).md`) aynı klasörde `Not.md` varken yalnız listelenir:
    `sync_copy_candidates` alanında iki dosya ve içeriklerinin aynı olup olmadığı (`same_content`)
    görünür, ikisi de indekste kalır ve sync durumu değişmez. Böyle adlandırılmış gerçek bir not
    (`Sezon 2.md`) düşmez; listeden çıkarmak için adını değiştir. Kopya notun `id`'sini de taşıyorsa
    iki dosya ayrıca `duplicate source id` çakışmasıyla bağlamdan çıkar.
  - `receipts/` altında `<özet>.md` adına eklenmiş her şey (`<özet> 2.md`, `<özet> (conflicted copy).md`)
    receipt kopyasıdır: indekslenmez, `file sync copy of a receipt` uyarısıyla görünür. Receipt'ler
    yalnız eklenir; kopyayı asılla karşılaştırıp sil.
- **Receipt `event_id`'sini makineler arasında tekil tut:** `event_id`'yi ajan seçer ve dosya
  adı onun özetidir. İki makine aynı gün aynı konuya aynı adı verirse (`ortak-konu-2026-09-27`)
  iki farklı receipt aynı dosyaya düşer ve `pull --rebase` `CONFLICT (add/add)` ile durur.
  Çakışma bir tarafın dosyası seçilerek çözülürse öbür makinenin veritabanında kendi özeti
  kalır; `sync` uyarı vermez ve iki makinenin görünümleri sessizce ayrışır. Bunu önlemek için
  `event_id`'nin sonuna kart başlığındaki gibi `Receipt session=` değerinin ilk 8 karakterini
  ekle: `ortak-konu-2026-09-27-3f9a1c2b`.

## Vault'u başka klasöre ya da hesaba taşımak

Hook dosyaları kurulumun mutlak yollarını taşır (Python, `beyin_v3_hook.py`, `--vault`,
`--state`). Kurulu bir vault başka bir klasöre ya da başka bir Windows hesabına taşınınca
(`C:\Users\<eski>\...`) her yaşam döngüsü hook'u genel bir hatayla düşer. `doctor` bunu
`hook_paths: stale` ve `needs_attention` olarak gösterir; her satır dosyayı, olayı ve eski
yolu (`hook_script_missing`, `other_vault`, `python_missing`) verir (upstream #204).

Çözüm, kurucuyu bu makinede yeni vault yoluyla yeniden çalıştırmaktır. Eski state klasörünü
(ya da kopyasını) `--state` ile ver; kurulum kaydı oradadır ve kurucu yolları taşıyan bütün
dosyaları yeniden üretir. State'teki indeks (`memory.sqlite3`) de kurulduğu vault yoluna bağlıdır;
bu bağı `--rebind-state` açıkça yeni yola çeker:

```text
py -3 scripts/install_v3.py --vault "C:\Users\<yeni>\Beynim" --state "<eski state klasörü ya da kopyası>" --rebind-state
```

Bayrak verilmezse ve indeks başka bir yola bağlıysa kurucu hiçbir dosyayı değiştirmeden durur
(`vault_moved`), eski ve yeni yolu gösterip bayrağı önerir. Bayrakla kurucu şu kuralları uygular:

- Kayıtlı eski yol artık yoksa ya da aynı klasörün başka bir adıysa (eski yolda bırakılmış bir
  bağlantı gibi) bağ yeni yola çekilir.
- Eski yolda hâlâ bir klasör varsa ve onun `.beyin-runtime.json` dosyası bu state'i gösteriyorsa,
  okunamıyorsa ya da yoksa kurucu reddeder: bu taşıma değil kopya olabilir ve iki vault aynı
  state'i paylaşırdı. İkisini de tutacaksan yenisini state klasörünün bir **kopyasıyla** kur.
- Vault'taki `.beyin-runtime.json` bu state'in kurulum kaydının yazdığı dosya olmalıdır; başka bir
  vault'un state'i bu yolla bağlanamaz. Kayıtlı yol bu makinede mutlak bir yol değilse de reddeder.

Eski yolun yok görünmesi taşımayı tek başına kanıtlamaz (çıkarılmış disk, bağlı olmayan ağ
klasörü); bayrağı yalnız vault'u gerçekten taşıdıysan ver. Kurucu bütün çakışma kontrollerini
bitirdikten sonra indeksin tam kopyasını state klasörüne `memory-before-rebind.sqlite3` adıyla
yazar (sonrakiler `.1`, `.2`; eskisi silinmez) ve bağı tek bir SQLite işleminde değiştirir.
Kayıtlar ve olay geçmişi korunur; sonuç `rebound` alanında (`from`, `to`, `backup`) görünür.
`--plan --rebind-state` aynı kontrolleri yapar, değişecek bağı `rebind` alanında gösterir, hiçbir
şey yazmaz. Yedek hassas not metni taşıyabilir: eşitleme ve Git dışında kalsın, `doctor` ve
`sync` sağlıklıysa silebilirsin.

Aynı makinede vault yalnız başka bir klasöre taşındıysa kurucuya gerek yoktur: vault klasöründe
`beyin.py relocate` çalıştır ([UPDATE](UPDATE.md#vaultu-taşımak-ya-da-kopyalamak)); masaüstü
uygulaması bunu vault'u açınca kendisi yapar.

Eski state yoksa (vault başka bir bilgisayardan geldiyse) `relocate` `vault_moved` koduyla durur
ve yeniden kurmanı söyler. Kurucu o zaman `.beyin-runtime.json` başka bir bilgisayarın, bu makinede
kurulum kaydı olmayan state'ini gösteriyorsa onu bu makinenin state'iyle değiştirir; başlatıcı,
Hermes/OMP/OpenCode eklentileri ve Kiro hook dosyası gibi kurucunun bütünüyle ürettiği dosyaları
üreticisinin işaretinden tanıyıp bu makinenin sürümüyle yazar; bulduğu kopyalar kurulum kaydında
`original` olarak kalır. Kayıtsız bulduğu başka bir dosyayı ise (`update_conflict`) korur ve durur. Hook dosyaları başka makineden git'le geldiyse
içlerindeki eski Beyin girdileri, Windows'un PowerShell `-EncodedCommand` biçiminde olsalar da
kurulumda Beyin'in kendi girdisi olarak tanınır ve yenileriyle değiştirilir; yanlarında
çalışmayan bir kopya kalmaz.

## Nasıl doğrulandı

Windows 11, Git 2.55 (`core.autocrlf=true`), Python 3.13, `main` @ db1f23d. Yerel bir çıplak
depo ve iki vault; Beyin her birine ayrı `--state` ile kuruldu.

- Yukarıdaki `.gitignore` ile ikinci makinede kurulumdan sonra `git status` boş kaldı
  (`AGENTS.md` geçici nottaki gibi `.gitignore`'daydı; `CLAUDE.md` git'teydi ve değişmedi).
- Yönetilen bir betik başka sürümden gelmiş gibi değiştirilince o makinede yeniden kurulum
  yönetilen dosya çakışmasıyla (o sürümde `Reinstall conflict: managed file changed`) durdu.
- A'nın receipt'i B'de `sync` sonrası veritabanına ve günlük görünüme girdi. B'nin receipt'i
  A'ya geçti. `daily/v3/<gün>.md` ve `knowledge/v3/outcomes.md` iki makinede bayt bayt aynı çıktı.
- `receipts/** -text` kaldırılınca: B'deki receipt CRLF'ye döndü, görünümler farklılaştı,
  aynı receipt'in yeniden gönderilmesi `event id collision` verdi.
- İki makine aynı anda Last-Session'a kart, Journal'a kayıt ekleyip aynı Threads satırını
  değiştirdi: `pull --rebase` Last-Session ve Journal'ı iki kaydı da koruyarak birleştirdi,
  Threads'te çakışmayla durdu.
- Threads çakışma işaretleriyle dururken: ilk SessionStart dosyayı değişmiş kaynak diye dışarıda
  bıraktı; `sync`'ten sonraki SessionStart bağlamında işaretler vardı. `sync` `warnings: []`
  döndü, `doctor` bir şey göstermedi.
- İki vault aynı `event_id` ile farklı özetli receipt yazdı: ikisi de aynı `receipts/<özet>.md`,
  `pull --rebase` add/add çakışmasıyla durdu. A'nın dosyası seçilip devam edilince B'de `sync`
  `conflicts: []` döndü; B'nin `recap` ve `daily/v3` çıktısı B'nin özetini göstermeye devam etti.

## Satır sonu: `core.autocrlf=true` ve receipt'ler

Bu kontrol upstream #205 için eklendi. Git for Windows varsayılanı `core.autocrlf=true`,
`.gitattributes` ile sabitlenmemiş receipt ve görünüm dosyalarını CRLF olarak çıkarabilir.
Güncel motor yeni özetleri LF ile yazar, CRLF/CR/LF farkını aynı receipt sayar (yeniden
gönderim çakışmaz, `sync` `receipt_divergence` bildirmez, günlük görünümler durmaz) ve eski
receipt kaynaklarını yeniden yazmaz. Gerçek özet, refs ya da links değişikliği yine
çakışmadır. Eski sürümlerde satır sonu farkı `event id collision` hatasına yol açabilir.

`doctor`, vault bir git deposuysa ve `core.autocrlf=true` iken `receipts/` için `-text` ya da
`eol=lf` yoksa `receipt_line_endings` alanında `warning` bildirir (insan çıktısında bir "Receipt satir
sonu (bilgi)" satırı). Bu yalnız bilgidir, `doctor` durumunu değiştirmez ve hiçbir şeyi düzeltmez.
Bayt değişikliklerini ve eski sürümlerle sorunu önlemek için `.gitattributes` dosyasına
`receipts/** -text` ya da `receipts/** eol=lf` ekleyebilirsin. Kontrol:
`git check-attr text eol -- receipts/x.md`.

Satır sonu değişmiş eski kaynaklar için yerel veritabanını silmek gerekmez;
`python3 beyin.py sync --full` karşılaştırmayı yeniler. Eski bir görünümün ham hash'i
receipt'lerden yeniden üretilemezse dosya korunur; o zaman
[arşivleyerek görünüm kurtarma](RUNTIME.md) komutunu (`sync --recover-views`) kullan,
receipt kaynaklarını silme.

Presence eşitlemesi varsayılan olarak kapalıdır. Her cihazda `preferences --parallel-sessions on`
ile açılır. Yerel `<state>/parallel-presence-device.json` dosyası rastgele bir cihaz kimliği
tutar; iki cihaz aynı kullanıcı ve state yolunu kullansa da diğerinin açık kaydını silmez.
Bu kimlik dosyasını vault ile eşitleme. `doctor` kimlik veya presence dosyası oluşturmaz.
