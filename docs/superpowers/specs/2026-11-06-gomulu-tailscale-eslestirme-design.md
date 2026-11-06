# Sunucuya kurulumsuz bağlanma: gömülü Tailscale + eşleştirme kodu — tasarım
Tarih: 2026-11-06 · Dal: `tasarim/gomulu-tailscale-20261106` · Kaynak: görev `cortex-uzak-pyn` (Faz 2'den sonra),
geliştiricinin isteği (uygulama 13076, 13079, 13082): "İnsanlar Tailscale yükle, aç, adres yaz ile uğraşmaz; daha pratik
olmalı. Tailscale'i Cortex'in içine gömebilir miyiz?"

## Amaç
Kendi sunucusunda Hermes çalıştıran biri, bilgisayarındaki Cortex'i o sunucudaki ajana **hiçbir şey kurmadan** bağlar.
Akış şöyledir:
1. Telefonda (ya da sunucuda) "Bilgisayar ekle" denir ve bir eşleştirme kodu çıkar.
2. Bilgisayarda Ayarlar › Sunucu › "Kodla bağlan"a bu kod girilir.
3. Bağlantı biter. Tailscale kurmak, yönetici izni vermek, adres ya da anahtar yazmak gerekmez.

Sunucu internete açılmaz. Cihazlar yalnız kullanıcının kendi tailnet'i üzerinden konuşur.

## Bugün (1.0.56)
- **Sohbet:** masaüstündeki "Sunucudaki Pyn" (`desktop/electron/services/hermesChat.ts`) Hermes'in API sunucusuna HTTP
  ile konuşur. Ayarlar adres, profil ve anahtardır (`desktop/shared/hermes.ts`; anahtar `keys.ts`'de şifreli). Bir
  oturumu seçip telefonda başlayan konuşmayı sürdürebilir.
- **Bağlantı için kullanıcının yapması gerekenler:**
  - bilgisayara Tailscale'i kendisi kurmak (Windows'ta yönetici izni);
  - aynı tailnet'e giriş yapmak;
  - adresi (`https://<sunucu>.<tailnet>.ts.net:8642`) ve `API_SERVER_KEY`'i elle yapıştırmak.
- Geliştiricinin kendi kurulumunda bile bu adımlar hiç tamamlanmadı (görev 8 gün bekledi).

## Kararlar
Kullanıcıyla alındı (2026-11-06):
- **Ağ:** gömülü Tailscale. Tailscale'in `tsnet` kütüphanesiyle yazılmış küçük bir yardımcı program kullanılır. Program
  Cortex'in içinde kendi başına bir tailnet cihazı olur. Yönetici izni ve sistem servisi gerekmez; ağ yığını kullanıcı
  alanında çalışır (gVisor). Lisans BSD-3-Clause, açık repoya uygun.
  - Kaynak: pkg.go.dev/tailscale.com/tsnet, 2026-11-06'da okundu: "No root privileges required", "No system daemons
    to install or manage".
- **Elenen seçenek:** herkese açık adres (Cloudflare Tunnel / Tailscale Funnel). Terminal komutu çalıştırabilen bir
  ajanın kapısı internete açılırdı; tek bir sızan anahtar uzaktan komut çalıştırma demekti.
- **Eşleştirme kodu:** kullanıcı adres ya da anahtar görmez. Kod, bağlanmak için gereken her şeyi taşır. Tek
  kullanımlıktır ve kısa sürede dolar.
- **Önce tasarım, sonra kod.**

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `tools/cortex-tailnet/` (yeni, Go) | tsnet düğümü + tek hedefli yerel vekil (aşağıda). Komutlar: `up` (kodla katıl ve vekili aç), `status`, `logout` | `tailscale.com/tsnet` (sürümü sabit) |
| `.github/workflows/tailnet-helper.yml` (yeni) | Yardımcıyı Windows x64/arm64, macOS ve Linux için derler; SHA-256'larıyla **prerelease** olarak yayımlar (`whisper-vulkan.yml` gibi, `--clobber` yok) | Go araç zinciri |
| `desktop/electron/services/toolPackages.ts` | Yardımcıyı ilk "Kodla bağlan"da indirir: sürüm + SHA-256 koda sabit, tutmayan indirme açılmadan silinir (MinGit'le aynı yol). Kurucuya **girmez** | `netFetch` |
| `desktop/electron/services/tailnet.ts` (yeni) | Yardımcıyı başlatır ve durdurur; yerel vekilin portunu ve jetonunu alır; durum (bağlı, bağlanıyor, kod geçersiz) | `tools/cortex-tailnet` |
| `desktop/shared/pairing.ts` (yeni) | Eşleştirme kodunun biçimi ve doğrulaması (saf fonksiyon, test edilir) | — |
| `hermesChat.ts` | Adres tailnet adresiyse istekleri yerel vekile yollar; geri kalan her şey aynı | `tailnet.ts` |
| `desktop/src/ui/ServerSection.tsx` | "Kodla bağlan" kutusu, durum satırı, "Bağlantıyı kaldır" | — |
| Kod üreticisi | Sunucuda tek kullanımlık Tailscale giriş anahtarı üretir ve kodu kurar. Açık repoda genel bir komut (`beyin.py eslestir` ya da `tools/cortex-tailnet pair`); geliştiricinin panelinde "Bilgisayar ekle" düğmesi (ayrı repo) | Tailscale API, OAuth istemcisi |

### Yerel vekil
- **Dinleme:** yardımcı yalnız `127.0.0.1:<rastgele port>` üzerinde dinler. Her açılışta rastgele bir jeton üretir;
  jetonu olmayan isteği reddeder (yerel başka bir programın vekili kullanması engellenir).
- **Hedef:** tek bir hedefe gider: koddaki sunucu adresi. Hedef değiştirilemez, açık bir HTTP vekili değildir.
- **Anahtar:** Hermes'in `Authorization` başlığı olduğu gibi geçer. Yardımcı Hermes anahtarını bilmez, saklamaz.
- **Neden vekil:** Electron'un `net`/`https` istemcisi tailnet adını çözemez. Vekil sayesinde `hermesChat.ts`'nin akış
  (SSE), durdurma ve onay kodu hiç değişmez.

## Eşleştirme kodu
```
cortex-pair-1:<base64url(JSON)>      JSON: {"v":1,"url":"https://host.tailnet.ts.net:8642","profile":"pyn",
                                             "authkey":"tskey-auth-…","hermesKey":"…","exp":"2026-11-06T13:00:00Z"}
```
- **Gösterim:** telefonda QR olarak, yanında "Kopyala" düğmesi. Bilgisayara yapıştırılır. QR okutmak için bilgisayarda
  kamera gerekmez, metin yeterli.
- **`authkey`:** Tailscale giriş anahtarı. Tek kullanımlık, ön onaylı, etiketli (`tag:cortex-desktop`), süresi en kısa
  değer olan 1 gün. Tailscale anahtarları 1 ile 90 gün arasında olabilir (kb/1085, 2026-11-06).
  - Kod bir kez kullanılınca anahtar yanar. Çalınan bir kod en çok bir gün içinde ve yalnız bir kez işe yarar.
  - Kodun içindeki `exp` daha kısadır (1 saat). Uygulama süresi geçmiş kodu hiç denemez.
- **`hermesKey`:** bugünkü `API_SERVER_KEY`. Kodla gelir ve `keys.ts`'de şifreli saklanır; kullanıcı onu hiç görmez.
- **Kod bir sırdır.** Sohbete, günlüğe ya da ekran görüntüsüne düşmemeli. Uygulama kodu hiçbir yere yazmaz; çözdüğü
  alanları saklar ve kodu atar.

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| IPC `tailnet:pair` | pencere → ana süreç | `code` | "Kodla bağlan" |
| yardımcı `up` | ana süreç → yardımcı (argv + stdin) | durum klasörü, makine adı (`cortex-<bilgisayar>`), `authkey` (stdin'den, argv'de değil) | eşleştirmede bir kez; sonra her açılışta anahtarsız |
| yardımcı stdout | yardımcı → ana süreç | tek satır JSON: `{"ready":true,"port":…,"token":…}` ya da `{"error":"<kod>"}` | açılışta |
| IPC `tailnet:status` | ana süreç → pencere | `bagli` / `baglaniyor` / `hata` + tek cümle | durum değişince |
| IPC `tailnet:forget` | pencere → ana süreç | — | "Bağlantıyı kaldır": yardımcı `logout`, durum klasörü silinir, Hermes ayarları unutulur |

## Durum ve sırlar
- **Durum klasörü:** düğümün durumu (`tailscaled.state`, düğüm anahtarı dahil) `%LOCALAPPDATA%\Cortex\tailnet`
  klasöründe tutulur (macOS ve Linux'ta karşılığı). Klasör yalnız kullanıcıya açıktır. Kasaya, yedeğe ya da GitHub'a
  girmez.
- **Kalıcılık:** düğüm *ephemeral değildir*; bilgisayar her açılışta aynı cihaz olarak geri gelir. Etiketli cihazlarda
  düğüm anahtarının süresi dolmaz. Bu, Tailscale'in belgelenmiş davranışı ama bu sürüm için ayrıca doğrulanacak.
- **Geri alma:** kullanıcı cihazı Tailscale panelinden tek tıkla çıkarır. Uygulamadaki "Bağlantıyı kaldır" da aynı işi
  yapar.

## Hata ve uç durumlar
Her hata kullanıcıya tek cümleyle gösterilir:
- **Kod bozuk ya da başka bir şey yapıştırıldı:** "Bu bir Cortex eşleştirme kodu değil. Telefondaki 'Bilgisayar ekle'den
  yeni kod al."
- **Kodun süresi geçmiş:** "Kodun süresi dolmuş. Yeni kod al."
- **Anahtar daha önce kullanılmış ya da reddedildi:** "Bu kod daha önce kullanılmış. Yeni kod al."
- **Yardımcı indirilemedi ya da özeti tutmadı:** "Bağlantı aracı indirilemedi. İnternet bağlantısını kontrol edip yeniden
  dene." İndirilen dosya silinir.
- **Antivirüs yardımcıyı engelledi:** "Bağlantı aracını antivirüs engelledi. Cortex klasörünü izinli listeye ekle."
  İmzasız Go programları Windows'ta bu riski taşır; bkz. açık sorular.
- **Sunucuya ulaşılamıyor** (sunucu kapalı, tailnet'ten çıkarılmış): "Sunucuya ulaşılamıyor. Sunucu açık mı? Bu
  bilgisayar Tailscale panelinden çıkarılmış olabilir."
- **Bilgisayarda zaten Tailscale kurulu ve aynı tailnet'te:** önce doğrudan adres denenir; ulaşılırsa yardımcı hiç
  başlamaz. Uygulama iki ayrı cihaz kaydı oluşturmaz.
- **Yardımcı çöktü:** ana süreç bir kez yeniden başlatır. Yine düşerse durum "hata" olur ve sohbet bunu tek cümleyle
  söyler.
- **ASCII olmayan kullanıcı ya da klasör adı:** durum klasörünün yolu argv ile değil ortam değişkeniyle verilir. Test
  `Ayşe’nin Kasası` gibi bir adla yapılır.

## Güvenlik
- **Ağ izni:** `tag:cortex-desktop` etiketli cihazlar tailnet ilkesinde yalnız sunucunun Hermes portuna ulaşabilmeli.
  Önerilen ACL satırı belgede yazılı olacak; kullanıcı kendi panelinde uygular. Uygulamamız ilkeyi değiştirmez.
- **Kod üreticisinin yetkisi:** yalnız giriş anahtarı üretebilen dar kapsamlı bir OAuth istemcisi kullanır
  (`auth_keys` yazma, `tag:cortex-desktop` ile sınırlı). İstemci sırrı sunucuda kalır, 600 izinli bir dosyadadır.
- **Hermes anahtarı:** bugün tek bir paylaşılan anahtar (`API_SERVER_KEY`) var. Cihaz başına anahtar Hermes'te yok.
  Geri almanın asıl yolu cihazı tailnet'ten çıkarmak. Tek başına anahtar, tailnet olmadan işe yaramaz.

## Test
- **Birim:**
  - `pairing.ts`: geçerli kod; bozuk base64; eksik alan; yanlış sürüm; süresi geçmiş kod; `url`'de kullanıcı adı ve
    parola; aşırı uzun kod.
  - Kodun hiçbir günlüğe yazılmadığını denetleyen kanarya testi.
- **Yardımcı (Go):**
  - `httptest` ile vekil: jetonsuz istek 403, yanlış hedef yok, SSE akışı parça parça geçiyor, istemci kopunca hedef
    bağlantısı kapanıyor.
  - tsnet'e sahte `Dial` verilerek ağsız test.
- **Uçtan uca (sahte):** sahte yardımcı (aynı stdout sözleşmesi) + sahte Hermes. "Kodla bağlan" → durum "bağlı" →
  sohbet bir tur → "Bağlantıyı kaldır".
- **Gerçek test (yalnız geliştirici onayıyla, elle):**
  1. Geliştiricinin tailnet'inde gerçek bir kodla, Tailscale kurulu olmayan bir Windows makinesinde eşleştirme yapılır.
  2. Pyn'le bir tur konuşulur.
  3. Bilgisayar yeniden başlatılınca bağlantının kendiliğinden geldiğine bakılır.
  4. Cihaz panelden çıkarılınca uygulamanın doğru cümleyi gösterdiğine bakılır.

## Aşamalar
1. **Yardımcı + CI:** `tools/cortex-tailnet` (`up`, `status`, `logout`, vekil), Go testleri, prerelease iş akışı.
   Çıktı: üç platform ikilisi ve SHA-256'ları.
2. **Kod üreticisi:** `pair` komutu (OAuth istemcisiyle anahtar üretir, kodu yazar) ve belgesi.
3. **Masaüstü:** `pairing.ts`, `tailnet.ts`, `toolPackages` girişi, `hermesChat` yönlendirmesi, Ayarlar ekranı, testler.
4. **Geliştiricinin paneli** (ayrı repo): telefonda "Bilgisayar ekle" → QR + kopyala.
5. **Gerçek deneme** (yukarıdaki elle test) ve sürüm notu.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| Windows'ta imzasız Go yardımcısı antivirüse takılır mı? Kurucu imzalanıyorsa yardımcı da aynı sertifikayla imzalanmalı mı? | geliştirici | açık: 1. aşamada bir makinede ölçülecek |
| Kod üreticisi için Tailscale OAuth istemcisi oluşturmak (bir kez, Tailscale panelinde) | geliştirici | açık: 2. aşamadan önce gerekli |
| Sunucusu olmayan, kendi tailnet'i olan başka kullanıcılar için kurulum belgesi bu sürümde mi? | geliştirici | önerilen: 1. sürüm geliştiricinin kurulumu için, belge sonra |
| Hermes'e cihaz başına anahtar eklemek (paylaşılan `API_SERVER_KEY` yerine) | geliştirici | önerilen: kapsam dışı; geri alma tailnet'ten |
| Yardımcının boyutu (tahmin: platform başına birkaç on MB, ölçülmedi). Kurucuya girmez, ilk bağlanmada iner | — | 1. aşamada ölçülecek |
| Kod sohbet geçmişinde görünmesin: telefon panelinde QR gösterilir ama mesaj olarak yazılmaz | geliştiricinin paneli | 4. aşamada |

## Kapsam dışı
- Sunucuyu internete açmak (Funnel, Tunnel).
- Sunucuyu uygulamadan kurmak.
- Tailscale dışı ağlar (Headscale bu tasarımla büyük olasılıkla çalışır ama denenmeyecek).
- Telefonun uygulamasının kendisine tsnet koymak: telefon bugün panel üzerinden bağlanıyor, değişmiyor.
