# Eşitleme motora taşınır (`beyin.py esitle`) — tasarım
Tarih: 2026-11-03 · Dal: `faz1/esitle` · Kaynak: yol haritası Faz 1 ilk adımı (`2026-11-03-dort-yuzey-design.md`)

## Amaç
Kasanın git uzak deposuyla eşitlenmesi (ekle → sır taraması → commit → `pull --rebase` → push; çakışmada geri çekil)
bugün iki yerde ayrı yazılı: masaüstünde `desktop/electron/services/vaultSync.ts` + `desktop/shared/vaultSync.ts`,
geliştiricinin sunucusunda bir bash betiği. Kurallar motora, tek bir Python komutuna taşınır; masaüstü yalnız zamanlamayı,
ekranı ve (Faz 1'in sonraki adımında) kimlik bilgisini tutar. Faz 2'de sunucuya kurulan zamanlayıcı da aynı komutu çağırır,
eşitleme ikinci kez yazılmaz.

## Kararlar
- Komut `beyin.py esitle` (yalnız standart kütüphane, kendi küçük CLI'ı; `yakala`/`telegram` gibi `beyin_entry.py`'den
  yönlendirilir, indeks ya da sync motoru yüklemez). `--json` ile tek satır sonuç; insan için Türkçe tek satır.
- Davranış bugünkü `vaultSync.ts` ile birebir: aynı sıra, aynı durum adları (`synced`, `conflict`, `secret`, `offline`,
  `error`, ayrıca eksikler için `missing`), aynı commit mesajı (`senkron: <makine> GG.AA.YYYY SS:dd`), aynı git ayarları
  (istem yok, hook yok, fsmonitor yok, `core.quotepath=false`).
- Sır taraması tek liste: masaüstündeki desen listesi ve "değer rastgele görünüyorsa" (entropi ≥ 3,5) kuralı Python'a
  taşınır; `sir-tarama:izin` satırı geçer. Kişiye özel birebir değerler isteğe bağlı olarak state klasöründeki
  `secret-patterns.txt`'ten okunur (motorun var olan dosyası, `beyin_v3_secrets._custom_literals`). Sır bulunursa
  commit yok, dosyalar yerinde, rapor yalnız `dosya:satır tür`.
- Takip edilen dal `@{u}`'dan okunur (sunucu betiğindeki sabit `origin main` değil).
- Aynı anda tek eşitleme: state klasöründe süreçler arası kilit (`_portalock`); kilit tutuluyorsa `busy` döner, beklemez.
- Masaüstü TypeScript'te yalnız zamanlama (açılış, 5 dk, değişiklikten 30 sn sonra, kapanış), pencereye durum bildirimi
  ve uyarı kalır; git ve sır kodu oradan silinir (`shared/vaultSync.ts`'te yalnız tipler ve `remoteLabel`).
- Kullanıcıyla alınacak kararlar "Açık sorular"da.

## Kapsam dışı (Faz 1'in sonraki adımları)
- GitHub ile giriş (cihaz akışı), yedek repo açma, "var olan kasama bağlan", taşınabilir git indirme, `.gitignore` yazma.
- Sunucudaki betiğin bu komuta geçmesi (motor sürümü sunucu kasasına kurulunca, Tolga onayıyla).

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `template/.claude/scripts/beyin_v3_esitle.py` | Eşitleme kuralları, sır taraması, kilit, JSON sonuç | git (PATH), `_portalock`, `beyin_v3_secrets` (yalnız birebir değer okuma) |
| `scripts/beyin_entry.py` | `esitle` alt komutunu modüle yönlendirme | — |
| `tests/v3_esitle_test.py` | Geçici çıplak repolarla uçtan uca: eşit, sır, çakışma, ağ yok, kilit, dal yok | git |
| `desktop/electron/services/vaultSync.ts` | Zamanlama + `beyin.py esitle --json` çağrısı + durum | motorun Python'u (`python.ts`, `yakala` gibi) |
| `desktop/shared/vaultSync.ts` | Tipler, `remoteLabel` (sır kodu çıkar) | — |
| `docs/v3/MULTI-MACHINE.md` | "Beyin git kurmaz/senkron kodu yok" cümlesi güncellenir | — |

## Sözleşme (`beyin.py esitle --json`, stdout tek satır)
| Alan | Değer |
|---|---|
| `state` | `synced` · `nothing` (değişiklik yok, uzakta da yeni yok) · `conflict` · `secret` · `offline` · `error` · `missing` · `busy` |
| `missing` | `git` · `repo` · `remote` · null |
| `remote` | `github.com/sahip/repo` (ad/parola/token asla) · null |
| `detail` | çakışmada dosyalar, sırda `dosya:satır tür`, hatada git'in son satırı (≤10 öğe, ≤300 karakter) |
| `pulled`, `pushed` | gelen ve giden commit sayısı (pencerenin "Gelenler: 5 not" satırı için) |
Çıkış kodu: `--json` ile satır yazıldıysa her zaman 0, durum JSON'da (masaüstünün `runPython`'u sonucu yalnız 0 çıkışta alır). `--json` olmadan: `synced`/`nothing`/`busy` → 0; `missing` → 3; diğerleri 1. 2 hiç kullanılmaz (kanca çağıranlar onu "engelle" okur).

## Hata ve uç durumlar
- Yarım rebase duruyor (kişi elle çözüyor) → hiçbir şey yapma, `conflict` ["git: rebase"]. Görünen: "Eşitleme durdu: …".
- Çakışma → `rebase --abort`, `conflict` + dosyalar; hiçbir şeyin üstüne yazılmaz.
- Ağ yok / kimlik reddi → `offline`; notlar yerinde, sonraki turda gider.
- Sır → `git reset -q`, `secret`; "Sırrı nottan sil (örnekse satıra sir-tarama:izin yaz)".
- Uzak dal yok / kasa repo değil / git yok → `missing`.
- Windows: git yalnız PATH'te ve kasa klasörü dışında aranır (kasadaki bir `git.exe` çalışmaz; bugünkü `gitProgram`).
- Türkçe ve emoji yollar: `core.quotepath=false`, çıktı UTF-8.

## Test
- Birim + uçtan uca (geçici çıplak repo, iki klon, gerçek git; ağ yok): eşit → `synced`, ikinci tur `nothing`;
  sır satırı → `secret`, commit yok, dosya yerinde; `sir-tarama:izin` geçer; iki klonda aynı satır → `conflict`, iki
  taraf da değişmeden; erişilemeyen uzak → `offline`; dal takip etmiyor → `missing: remote`; kilit tutulurken → `busy`;
  emoji/Türkçe dosya adı. Masaüstündeki `tests/vaultSync.test.ts` beklentileri aynı durumlarla Python'a taşınır.
- Masaüstü: `vaultSync.test.ts` artık `beyin.py esitle` çıktısını okuyan zamanlayıcıyı sınar (sahte çıktıyla).
- Gerçek test (geliştiricinin kasası): yalnız Tolga onayıyla, Faz 0 sonrası.

## Aşamalar
1. Motor modülü + testler + entry yönlendirmesi (bu PR). Masaüstü dokunulmaz; iki uygulama bir süre yan yana.
2. Masaüstü `vaultSync.ts` motora geçer (aynı PR ya da hemen ardından; Windows CI'da denenir).
3. Sürüm notu ve `MULTI-MACHINE.md`; sunucu betiği Tolga onayıyla komuta geçer.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| Masaüstü geçişi (aşama 2) aynı PR'da mı ayrı mı? | Tolga | **karar (3 Kasım): ayrı PR**, motor önce tek başına doğrulansın |
| Sunucu betiği ne zaman geçsin? | Tolga | **karar (3 Kasım): sürüm yayınlanıp sunucu kasası güncellenince** |
