# Faz 1: GitHub ile yedek ve eşitleme — tasarım
Tarih: 2026-11-04 · Dal: `faz1/github-tasarim` · Kaynak: yol haritası Faz 1 (`2026-11-03-dort-yuzey-design.md`),
yol haritası incelemesi (kasa `projects/Cortex/yol-haritasi-inceleme-2026-11-03.md` §3-4), görev `cok-cihazli-kasa`

## Amaç
Git'i ve GitHub'ı hiç bilmeyen biri kasasını birkaç tıkla GitHub'daki özel bir repoya yedekler, ikinci bir bilgisayarda
aynı kasaya bağlanır. Eşitleme bugünkü gibi arka planda, modelsiz çalışır. Bugün eşitleme ancak kasa zaten bir git
deposuysa ve bir uzak depo izliyorsa açılabiliyor (Ayarlar › Sunucu: "Bu kasa bir git deposu değil").

## Zaten yapılan (1.0.53)
- Eşitleme kuralları motorda: `beyin.py esitle` (commit, `pull --rebase`, push, sır taraması, çakışmada geri çekilme,
  kilit). Masaüstü yalnız zamanlar ve gösterir; geliştiricinin sunucusu da aynı komutu çağırıyor (2026-11-04).

## Kararlar
Kullanıcıyla alındı (2026-11-04, dördü de önerilen seçenek):
- **İzin:** GitHub App (OAuth App değil). Yalnız uygulamanın açtığı ya da seçilen repoya erişir: Contents okuma/yazma,
  Metadata okuma, Repository creation. Kullanıcı jetonu 8 saatte dolar, yenileme jetonuyla uygulama kendisi yeniler.
  OAuth App'in `repo` izni kullanıcının **bütün** özel repolarına yazma verirdi.
- **Giriş:** cihaz kodu akışı. Uygulama kodu gösterir, tarayıcıda `github.com/login/device` açılır, kullanıcı kodu
  onaylar. İstemci kimliği açık repoda durabilir; istemci sırrı gerekmez.
- **Yer:** Ayarlar › Sunucu (bugünkü bölüm) + ilk kurulumda isteğe bağlı "Yedekle" adımı (atlanabilir).
- **Git yoksa:** Windows'ta uygulama MinGit'i indirir (Git for Windows'un küçük paketi, 2.56.0.4'te 38 MB):
  `%LOCALAPPDATA%\Cortex\tools\git`, sürüm ve SHA-256 koda sabitli. macOS/Linux'ta "Git'i kur" bağlantısı.
- **Var olan kasaya bağlanma:** hiçbir şey silinmez. İki tarafta aynı adlı ama farklı bir not varsa ikisi de kalır;
  buradaki `<ad> (bu bilgisayar).md` olur ve pencere bunu tek satırda söyler.

## Kapsam dışı
- GitHub dışı uzak depolar için giriş akışı (bugünkü "kasa zaten git deposu" yolu açık kalır, onlar için çalışmaya devam eder).
- Sunucuyu uygulamadan kurmak (Faz 2).
- Ekleri kasaya yazmak (yol haritası kararı: ekler cihazda kalır).
- Birden çok kasa / birden çok GitHub hesabı.

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `template/.claude/scripts/beyin_v3_esitle.py` | `baslat` (git init, `.gitignore` + `.gitattributes`, ilk commit, boş repoya ilk gönderim) ve `baglan` (uzaktakini al, yereldekini üstüne koy, aynı adlı farklı notu "(bu bilgisayar)" ile ayır, gönder); kimlik bilgisi yalnız ortamdan | git |
| `docs/v3/MULTI-MACHINE.md` + şablon `.gitignore` | önerilen liste tek kaynak (motor buradan yazar); `beyin-yakala` beceri klasörleri eklenir | — |
| `desktop/electron/services/github.ts` | cihaz kodu akışı, jeton yenileme (istemci sırrı yok: cihaz akışının jetonu sırsız yenilenir), çıkış; jetonlar `safeStorage` ile şifreli `github.json`'da; "yeni özel repo aç" (`POST /user/repos`), uygulamanın kurulu olduğu repolar (`/user/installations/*/repositories`), kurulu değilse kurulum sayfası; kasayı repoya bağlama | GitHub OAuth + REST |
| `desktop/src/ui/GithubConnect.tsx` | "GitHub ile bağlan" → kod → izin → "Yeni yedek oluştur" / "Var olan kasama bağlan" → sonuç; bağlıyken hesap · repo, "Bağlantıyı kes" | — |
| `desktop/electron/services/gitTool.ts` | yoksa (Windows) MinGit 2.56.0.4'ü indir (x64 / arm64; boyut ve SHA-256 sabit, 64 bit'inki ayrıca indirilip hesaplandı), paketi Python `zipfile` ile klasör dışına çıkmadan aç, yerine bütün koy; motora `CORTEX_GIT` ile verilir, PATH'teki git hep önce gelir. Ayarlar › Sunucu'da "Git'i indir"; "GitHub ile bağlan" git yoksa önce bunu yapar | setup.ts `UNPACK` |
| `desktop/electron/services/vaultSync.ts` | motoru çağırırken jetonu ortamla verir (`setVaultSyncCredentials`, yalnız `github.com/…` uzağına); ilk bağlanma `joinVault` (`--baslat` / `--baglan`, motor kilidi meşgulse bekler) | github.ts |
| `desktop/src/ui/ServerSection.tsx` | `GithubConnect`'i gösterir; GitHub sunuluyorsa "bu kasa git deposu değil" notu yerine o | — |
| `desktop/src/onboarding/Onboarding.tsx` | isteğe bağlı "Yedekle" adımı (aynı bileşen) | — |

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| `github:start` | pencere → ana | — → `{ userCode, verifyUrl, expiresIn }` | "GitHub ile bağlan" |
| `github:status` (çağrı ve yayın) | ana → pencere | `{ offered, state: 'off' \| 'waiting' \| 'connected' \| 'expired' \| 'denied' \| 'error', login, repo, detail }` | açılışta, onay beklenirken, bitince |
| `github:openVerify` / `github:openInstall` | pencere → ana | — | kodu girme / uygulamayı kurma sayfası tarayıcıda (adresler sabit, cevaptan gelen adres açılmaz) |
| `github:repos` | pencere → ana | — → `{ repos: Array<{ fullName, private, empty }>, installUrl: null }` ya da `{ repos: [], installUrl }` | giriş bitince |
| `github:create` | pencere → ana | `name` → `{ fullName, private, empty: true }` | "Yeni yedek oluştur" |
| `github:connect` | pencere → ana | `fullName` → `{ state, repo, kept, detail }` | repo seçilince / açılınca; yön (`baslat`/`baglan`) GitHub'ın boyutuna göre seçilir, motor `not_empty`/`empty` derse öbürüne geçilir |
| `github:disconnect` | pencere → ana | — → durum | "Bağlantıyı kes": jetonlar silinir, eşitleme kapanır; repo ve notlar yerinde |
| `beyin.py esitle --baslat <url> --json` / `--baglan <url> --json` | ana → motor | sonuç: `{ state, kept: [{ file, as }], pushed, pulled }` | bağlanırken bir kez |
| Ortam `GIT_CONFIG_COUNT/KEY/VALUE` (`http.https://github.com/.extraheader`) | ana → git (motor üzerinden) | `Authorization: Basic …` | her eşitleme; jeton diske ve komut satırına yazılmaz |

## Hata ve uç durumlar
- Kod süresi doldu → "Kodun süresi doldu. Yeniden dene." · Kullanıcı reddetti → "GitHub bağlantısı onaylanmadı."
- Ağ yok → "GitHub'a ulaşılamadı; internet bağlantını kontrol et."
- Uygulama hesaba kurulu değil (GitHub App kurulumu) → tarayıcıda kurulum sayfası açılır: "GitHub'da Cortex'e izin ver, sonra buraya dön."
- Seçilen repo dolu ve kasa da dolu → `baglan`; repo boş → `baslat`. Kasa zaten başka bir uzağa bağlı → "Bu kasa zaten
  <uzak> ile eşitleniyor. Önce bağlantıyı kes."
- Yenileme jetonu da dolmuş (6 ay) → eşitleme durur: "GitHub bağlantısının süresi doldu. Yeniden bağlan."
- MinGit indirmesi yarıda / özet tutmuyor → dosya silinir: "Git indirilemedi; yeniden dene." Hiçbir şey çalıştırılmaz.
- İlk gönderimde sır bulunursa → bugünkü sır durumu; repo boş kalır.
- Bağlanırken aynı adlı farklı notlar → "3 not iki yerde farklıydı; buradakiler '(bu bilgisayar)' adıyla kaldı."

## Test
- Motor (birim, geçici git depolarıyla, ağ yok): `baslat` boş uzağa gönderir ve `.gitignore`'u yazar; `baglan` aynı adlı
  farklı notu ayırır, aynı içerikli notu tek bırakır, hiçbir dosyayı silmez; jeton ortamdan gelir, `git config`'e ve
  komut satırına girmez (süreç listesinde aranır); sır olan kasada ilk gönderim olmaz.
- Masaüstü (birim): cihaz akışı sahte GitHub sunucusuna karşı (`slow_down`, `expired_token`, `access_denied`);
  jeton yenileme; MinGit özet doğrulaması (bozuk zip reddedilir).
- Uçtan uca (sahte GitHub + yerel çıplak git deposu): ilk kurulumda "Yedekle" → yeni repo → ikinci "bilgisayar"
  (ayrı kullanıcı klasörü) "Var olan kasama bağlan" → iki yönde not gidip geliyor.
- Gerçek test (geliştiricinin PC'si ve laptopu, gerçek GitHub App ile): yalnız elle, geliştiricinin onayıyla.

## Aşamalar
1. GitHub App kaydı (geliştirici, bir kerelik; ayarlar aşağıda) ve uygulamanın açtığı repoya erişiminin denenmesi.
2. Motor: `baslat` / `baglan`, ortamdan kimlik bilgisi, `.gitignore` listesi. Kendi sürümü.
3. Masaüstü: `github.ts`, `GithubConnect`, Ayarlar › Sunucu akışı (dal `faz1/github-baglan`, 2026-11-04; sahte GitHub'la `tests/github.test.ts`). 1.0.54 ile birlikte yayımlanır (Tolga, 2026-11-04); Client ID girilmeden düğme görünmez.
4. `gitTool` (MinGit) ve ilk kurulum adımı (Onboarding `backup`: araçlardan sonra, isteğe bağlı, yalnız GitHub sunuluyorsa) — 2026-11-04, `tests/gitTool.test.ts`.
   Not: MinGit'in kendi ayarı `core.autocrlf=true` (Git for Windows'unki gibi); Windows'ta notlar CRLF açılır, depoda LF durur.
5. Sürüm notu, `MULTI-MACHINE.md`, gerçek test (PC + laptop).

### GitHub App kaydı (aşama 1, geliştiricinin yapacağı)
github.com › Settings › Developer settings › GitHub Apps › New: ad "Cortex"; Homepage repo adresi; Callback boş;
"Enable Device Flow" açık; Webhook kapalı; izinler: Repository › Contents: Read and write, Metadata: Read-only;
Account › (yok); "Repository creation" (varsa) açık; "Any account" kurulabilir. Çıkan **Client ID** koda girer
(gizli değil); istemci sırrı ve özel anahtar üretilmez.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| GitHub App mı OAuth App mı | Geliştirici | GitHub App (2026-11-04) |
| Uygulamanın kullanıcı jetonuyla açtığı repoya kurulumun erişimi kendiliğinden gelir mi | Ölçüm (aşama 1) | GitHub belgesi "uygulama açtığı repolara erişir" diyor; kullanıcı jetonuyla denenmedi |
| İlk kurulumda "Yedekle" adımı olsun mu | Geliştirici | Evet, isteğe bağlı (2026-11-04) |
| Git yoksa MinGit indirilsin mi | Geliştirici | Evet, Windows'ta (2026-11-04) |
| Aynı adlı farklı notta hangisi ad değiştirir | Geliştirici | Bu bilgisayardaki (2026-11-04) |
