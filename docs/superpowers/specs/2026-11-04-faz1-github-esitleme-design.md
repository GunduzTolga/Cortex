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
Kullanıcıyla alınacak (2026-11-04 kartı). Önerilenler:
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
| `desktop/electron/services/githubAuth.ts` | cihaz kodu akışı, jeton yenileme, çıkış; jetonlar `keys.ts` ile şifreli | GitHub OAuth uçları |
| `desktop/electron/services/githubRepos.ts` | "yeni özel repo aç" (`POST /user/repos`), "kasalarım" listesi (uygulamanın eriştiği repolar) | GitHub REST |
| `desktop/electron/services/gitTool.ts` | git'i bul; yoksa (Windows) MinGit'i indir, özetini doğrula, aç (`toolPackages.ts` kalıbı) | — |
| `desktop/electron/services/vaultSync.ts` | motoru çağırırken jetonu ortamla verir; jeton dolmuşsa önce yeniler | githubAuth |
| `desktop/src/ui/ServerSection.tsx` | "GitHub ile bağlan" → kod → "Yeni yedek oluştur" / "Var olan kasama bağlan"; bağlıyken hesap, repo, "Bağlantıyı kes" | — |
| `desktop/src/onboarding/Onboarding.tsx` | isteğe bağlı "Yedekle" adımı (aynı bileşen) | — |

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| `github:start` | pencere → ana | — → `{ userCode, verifyUrl, expiresIn }` | "GitHub ile bağlan" |
| `github:state` | ana → pencere | `{ state: 'waiting' \| 'connected' \| 'expired' \| 'denied' \| 'error', login? }` | onay beklenirken, bitince |
| `github:repos` | pencere → ana | — → `Array<{ fullName, private, empty }>` | "Var olan kasama bağlan" |
| `github:create` | pencere → ana | `{ name }` → `{ fullName }` | "Yeni yedek oluştur" |
| `vault:connect` | pencere → ana | `{ fullName, mode: 'baslat' \| 'baglan' }` → motorun JSON sonucu | repo seçilince |
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
3. Masaüstü: `githubAuth`, `githubRepos`, Ayarlar › Sunucu akışı. Kendi sürümü.
4. `gitTool` (MinGit) ve ilk kurulum adımı.
5. Sürüm notu, `MULTI-MACHINE.md`, gerçek test (PC + laptop).

### GitHub App kaydı (aşama 1, geliştiricinin yapacağı)
github.com › Settings › Developer settings › GitHub Apps › New: ad "Cortex"; Homepage repo adresi; Callback boş;
"Enable Device Flow" açık; Webhook kapalı; izinler: Repository › Contents: Read and write, Metadata: Read-only;
Account › (yok); "Repository creation" (varsa) açık; "Any account" kurulabilir. Çıkan **Client ID** koda girer
(gizli değil); istemci sırrı ve özel anahtar üretilmez.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| GitHub App mı OAuth App mı | Geliştirici | Kartta (önerilen GitHub App) |
| Uygulamanın kullanıcı jetonuyla açtığı repoya kurulumun erişimi kendiliğinden gelir mi | Ölçüm (aşama 1) | GitHub belgesi "uygulama açtığı repolara erişir" diyor; kullanıcı jetonuyla denenmedi |
| İlk kurulumda "Yedekle" adımı olsun mu | Geliştirici | Kartta |
| Git yoksa MinGit indirilsin mi | Geliştirici | Kartta |
| Aynı adlı farklı notta hangisi ad değiştirir | Geliştirici | Kartta (önerilen: bu bilgisayardaki) |
