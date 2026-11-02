# Telefon, masaüstü, sunucu, tarayıcı: tek Cortex — yol haritası

Tarih: 3 Kasım 2026 · Durum: taslak, geliştiriciyle konuşulacak · Bu belge yol haritasıdır; her faz başlarken kendi
tasarım belgesini (`docs/superpowers/specs/`) ve planını alır.

## Kısaca

**Üç parça:**
- **Kasa:** notlar (Markdown). Tek gerçek; merkezi GitHub'da özel bir repo.
- **Motor:** `beyin.py`. Kasayı okuyan ve yazan tek program; kasanın her kopyasının yanında durur.
- **Kapı:** telefonun (ve uzaktaki her pencerenin) sunucuya girdiği tek adres.

**İki yol:** kasa kopyaları arasında *git*, telefondan sunucuya *kapı*. Üçüncüsü yok.

**Kim ne tutar:**
- PC ve laptop: kasa kopyası + motor + Cortex uygulaması. Cortex Browser aynı bilgisayardaki motoru kullanır.
- Sunucu: kasa kopyası + motor + ajanlar + kapı.
- Telefon: kopya tutmaz, kapıdan bakar.

Aşağıdaki kurallar bu resmi korumak için var. Geliştiricinin kendi sistemi için yapılacak tek iş Faz 0'dır; Faz 1–6,
aynı düzeni başkalarının terminale dokunmadan kurabilmesi için ürün işidir.

## Kullanıcı: önce geliştirici, sonra herkes

İlk kullanıcı Claude Code, Codex gibi araçları kullanan geliştiricidir: git ve GitHub hesabı zaten vardır, bu yüzden
merkez GitHub'dır. Teknik olmayan kullanıcı sonra gelir. Bu sıranın iki sonucu her fazda geçerlidir:
- **Kasada yalnız metin eşitlenir.** Ses kaydı, PDF, resim gibi büyük ekler git'e girmez (`.gitignore`'da kalır ya da
  ayrı bir yerde durur); yoksa geçmişi hiç küçülmeyen repo kısa sürede şişer. Eklerin cihazlar arasında nasıl taşınacağı
  Faz 2'nin tasarımında karar verilir.
- **GitHub değiştirilebilir bir parçadır.** Eşitleme motorda (`beyin.py esitle`) tek bir arayüzün arkasında yazılır;
  ileride GitHub hesabı istemeyen bir merkez eklemek o arayüze yeni bir uygulama eklemekle olur, uygulamalar değişmez.

## Amaç

Cortex'in dört yüzü var: masaüstü uygulaması, telefon uygulaması, sunucu ve ileride Cortex Browser. Dördü aynı beyni
kullanmalı; ama her biri temiz kalmalı: her bilginin tek yeri, cihazlar arasında az ve belli yollar, her şey uygulamadan
kurulur, terminal yok.

Bir kişi için akış: Cortex'i kurar, kasası `Documents\Cortex`'te oluşur ve tek başına çalışır. İsterse GitHub'ı bağlar
(bulut yedeği ve öbür cihazlar). İsterse sunucusunu ekler (hep açık bir makine: gece işleri, telefondan erişim).

## Bugün (3 Kasım)

| Yüz | Ne | Bağ |
|---|---|---|
| Masaüstü | Bu repo (Electron). Sohbet (Claude, Codex, OpenCode, yerel modeller, sunucudaki Pyn), notlar, ses, ofis | Kasa eşitlemesi 1.0.40'tan beri var ama yalnız elle kurulmuş bir git kasasında açılabiliyor; sunucudaki Pyn için Hermes API'si |
| Sunucu | Geliştiricinin kendi makinesi: kasanın canlı kopyası, Hermes ve Pyn, gece damıtma, yedek, bekçi | Kasa 2 dakikada bir GitHub'la eşitleniyor (kişisel bash betiği) |
| Telefon | Sunucudaki panelin Android penceresi; bu repoda değil, yalnız geliştiricinin sunucusuyla çalışıyor | Panelin kendi HTTP ucu (ayrı adres, ayrı anahtar) |
| Tarayıcı | Yok, planlı | — |

Sorunlar:
- Eşitleme kuralları iki yerde yazılı: `desktop/electron/services/vaultSync.ts` ve sunucudaki betik. Sır taraması da iki kopya.
- Sunucuya iki kapı var: telefon panelin ucuna, masaüstü Hermes API'sine gidiyor; iki adres, iki anahtar.
- Yeni bir kullanıcı eşitlemeyi açamaz: kasanın elle git deposu yapılması ve git'in kurulu olması gerekiyor.
- Beceriler ve öğrenme döngüsü yalnız sunucuda ve terminalden kurulmuş Claude Code'da var; masaüstünde görünmüyor.

## Kurallar (her faz bunlara uyar)

1. **Bilgi kasada.** Kalıcı her şey kasadaki Markdown'dır. Bir uygulamanın kendi önbelleği silinse bir şey kaybolmaz.
2. **Cihazlar arasında yalnız iki yol:**
   - *Kasa eşitlemesi:* git, merkez GitHub özel reposu. Kopya tutan her cihaz kendi kopyasına yazar, sonra eşitler.
     Kimse başka bir cihazın kasasına doğrudan yazmaz.
   - *Sunucu kapısı:* canlı işler için tek adres, tek anahtar (sohbet, görev, yakala, onay, bildirim).
   Üçüncü köprü kurulmaz.
3. **Tek motor, tek eşitleme kuralı.** Kopya tutan her cihazda aynı motor (`beyin.py`); eşitleme de motorda bir kez yazılır.
4. **Pencereler ince.** Telefon ve tarayıcı kopya tutmaz, iş yapmaz. Telefon sunucu kapısına, tarayıcı aynı
   bilgisayardaki motora bağlanır.
5. **Ürün ve atölye ayrı.** Bu repoya yalnız herkese yarayan girer. Geliştiriciye özel zamanlanmış işler, akışlar ve
   beceriler onun özel kasasında ya da sunucusunda kalır.
6. **Uygulamadan kurulur.** GitHub girişi, sunucu ekleme, beceriler: hepsi düğmeyle.
7. **Tek araç sözleşmesi, iki taşıma.** Kasaya dışarıdan erişen her yüz aynı araçları kullanır (Cortex Browser
   ADR-0006: `search`, `context`, `capture`, `note_create`; gerisi reddedilir; `private` notlar hiç dönmez; web'den
   gelen içerik güvenilmez işaretlenir). Aynı bilgisayarda stdio MCP (`beyin.py mcp`), uzaktan sunucu kapısı (HTTP +
   anahtar). Kurallar motorda bir kez yazılır; iki ayrı API olmaz.

## Hedef

```mermaid
flowchart TB
  T["Telefon Cortex<br/>pencere"] -->|sunucu kapısı| S["Sunucu<br/>kasa kopyası + motor + ajanlar + kapı"]
  B["Cortex Browser<br/>pencere"] -->|stdio MCP: beyin.py mcp| M["Masaüstü Cortex<br/>kasa kopyası + motor + ajanlar"]
  M -->|sunucu kapısı: canlı sohbet| S
  S <-->|git eşitlemesi| G[("GitHub özel repo<br/>merkez ve yedek")]
  M <-->|git eşitlemesi| G
```

- GitHub'sız kullanıcı: yalnız masaüstü, her şey yerelde.
- Sunucusuz kullanıcı: masaüstü + GitHub; telefon şimdilik yok (telefonun kopyası olmadığı için bir kapıya ihtiyacı var).
- İkinci bilgisayar: aynı GitHub reposuna "var olan kasama bağlan".

## Geliştiricinin sistemi

### Faz 0 — Geliştiricinin bilgisayarını tek beyne bağla (kod yok, ~1 saat)
Bugün masaüstü uygulaması eşitlenmeyen ayrı bir kasada; asıl kasanın klonu günlerdir geride.
- Klonu güncelle; bu arada ayrı kasada yazılan notları klona taşı. Kasa `.gitignore`'una motorun yeni
  `beyin-yakala` beceri klasörleri eklendi (3 Kasım; yoksa eşitleme onları commit'lerdi).
- Uygulamada: Ayarlar › Kasa → klon; Ayarlar › Sunucu → Eşitle açık; sunucudaki Pyn anahtarı.
- Bitti: telefonda yazılan not birkaç dakikada masaüstünde, masaüstündeki sunucuda.
- Kazanç: 1.0.40 eşitlemesi ilk kez gerçek kullanımda sınanır; Faz 2 bu temelin üstüne kurulacak.

## Ürün için (Faz 1–6)

Her faz başlarken kendi tasarım belgesini alır.

### Faz 1 — Her AI aracına hafıza: `beyin.py mcp` (küçük, önce gelir)
- Araç sözleşmesi motorda (kural 7): `beyin.py mcp` (stdio MCP, yalnız standart kütüphane) Cortex Browser ADR-0006'daki
  araçları sunar: `search`, `context`, `capture`, `note_create`; gerisi reddedilir.
- `private` notların bu yoldan hiç dönmediği testle sabitlenir; araç şemaları sürümlenir ("MCP sözleşmesi değişti"
  satırı sürüm notunda zorunlu); `capture` hazır metin alır, URL çekmez.
- Uygulama, kurulu MCP istemcilerine (Claude Code, Claude Desktop, Codex, Cursor…) "Cortex'i ekle" düğmesiyle tanıtır.
- Neden önce: küçük ve standart bir iş; çıktığı gün her AI aracı aynı hafızayı kullanır ve gösterilebilir bir sonuç
  verir. Faz 5'teki kapı ve Faz 6'daki Browser aynı araçları kullanır.
- Bitti: Claude Desktop'tan "hafızamda X'i ara" kasadan cevap veriyor; gizli not hiç görünmüyor.

### Faz 2 — GitHub ile yedek ve eşitleme
- **İlk adım: eşitleme motora taşınır** (`beyin.py esitle`). Commit, `pull --rebase`, push, sır taraması, çakışmada geri
  çekilme ve ilk gönderim/birleşme kuralları bir kez Python'da yazılır; `vaultSync.ts` yalnız zamanlamayı, ekranı ve
  kimlik bilgisini vermeyi tutar. Böylece fazın yeni davranışları TypeScript'te yazılıp Faz 3'te yeniden yazılmaz.
  Geliştiricinin sunucusundaki betik de bu komuta geçer.
- **Giriş:** "GitHub ile bağlan" → tarayıcıda cihaz kodu onayı (OAuth cihaz akışı). MCP değil: eşitleme modelsiz,
  arka planda çalışır. Anahtar diğer araçlarınki gibi şifreli saklanır (`keys.ts`), git'e yalnız ortam değişkeniyle
  verilir, diske ya da komut satırına yazılmaz.
- **Repo:** "Yeni yedek oluştur" (özel repo açar, kasayı ilk kez gönderir) ya da "Var olan kasama bağlan" (repoyu seçtirir,
  yereldeki notları içeri alır; aynı adlı not iki tarafta farklıysa ikisi de kalır, hiçbir şey silinmez).
- **Git:** bilgisayarda yoksa uygulama taşınabilir git'i indirir (`%LOCALAPPDATA%\Cortex\tools`, OpenCode gibi).
- **`.gitignore`:** motorun önerdiği liste (`docs/v3/MULTI-MACHINE.md`) uygulama tarafından yazılır. Listeye ve şablon
  `.gitignore`'a `beyin-yakala` beceri klasörleri de eklenir (bugün ikisinde de yok).
- **Bildirim:** sorunsuz eşitleme sessiz; pencere açılınca tek satır "Gelenler: 5 not, 2 görev". Uyarı yalnız çakışma ve
  sırda (bugünkü gibi).
- Geliştiricinin tek seferlik işi: GitHub'da Cortex için bir uygulama kaydı (istemci kimliği açık repoda durabilir).
  Klasik OAuth App'in `repo` izni kullanıcının bütün özel repolarına erişim verir; GitHub App yalnız seçilen kasa
  reposuna izin alır (Contents: okuma/yazma), token süreli ve yenilenebilir olur; cihaz kodu akışı onda da var. Tercih
  GitHub App; fazın tasarımında kesinleşir.
- Bitti: temiz bir Windows'ta, terminale dokunmadan, iki bilgisayar arasında not gidip geliyor.

### Faz 3 — Sunucu ekle
- Ayarlar › Sunucu › "Sunucu ekle": adres ve kullanıcı adı, şifre bir kez. Uygulama SSH anahtarı üretip yükler; sonra
  şifre bir daha sorulmaz.
- Uygulama sunucuya motoru kurar, kasayı GitHub'dan klonlar, eşitleme zamanlayıcısını kurar: Faz 2'deki
  `beyin.py esitle`'yi `systemd --user` zamanlayıcısıyla çağırır (sudo'suz). Zamanlayıcının oturum kapalıyken de
  çalışması için `loginctl enable-linger` gerekir; bu sudo isteyebilir, ekranda açıkça söylenir.
- Bitti: boş bir Linux makinesi uygulamadan kuruluyor ve eşitleniyor.

### Faz 4 — Beceriler ve öğrenme masaüstünde
- **Beceriler kasanın içinde** (`plugins/` + `.claude-plugin/marketplace.json`). Eşitleme onları da her cihaza taşır;
  ayrı bir dağıtım yok.
- Uygulama kasayı Claude Code'a beceri kaynağı olarak kendisi tanıtır (bugün terminal betiğinin yaptığı iş), otomatik
  güncelleme açık.
- Sohbette **"Öğrendiklerini kaydet"** düğmesi: genel contribute becerisini o sohbette çalıştırır.
- **Onay kartı:** önerilen beceri değişikliği, Onayla / Reddet. Telefondaki öğrenme onayının masaüstü karşılığı.
- Gece hasadı: sunucu varsa sunucuda (bugünkü gibi); yoksa isteğe bağlı, uygulama açıkken günde bir (model maliyeti var).
- Genel contribute becerisi Cortex'le gelir; geliştiricinin kişisel becerileri onun özel kasasında kalır.
- Açık karar (fazın tasarımında): onay GitHub varken PR mı, her durumda yerel mi; tek yol seçilecek.

### Faz 5 — Telefon ve tek sunucu kapısı (en büyük faz, kendi tasarım oturumu)
- Panelin herkese yarayan kısmı motorla gelen **Cortex sunucu kapısına** dönüşür: tek adres, tek anahtar; aynı araçları
  HTTP'den sunar. Motorun bugünkü `ingest-server`'ı (yakala ucu) bu kapının çekirdeği olabilir.
- Hermes API'si dışarı açılmaz, kapının arkasında kalır; masaüstündeki sunucudaki Pyn de aynı kapıdan konuşur
  (`hermesChat.ts` için yalnız adres değişir).
- Telefon uygulaması bu repoya girer, genel olur. Geliştiriciye özel akışlar atölye eklentisi olarak kalır.

### Faz 6 — Cortex Browser
- Kendi kasası ve eşitlemesi yok. Cortex Browser ADR-0006'ya göre aynı bilgisayardaki kasanın motorunu
  (`<python> <kasa>\beyin.py mcp`) alt süreç olarak başlatır, stdio üzerinden MCP konuşur: port açılmaz, masaüstü
  uygulamasının açık olması gerekmez.
- İlk işler: sayfayı kasaya at (yakala), yan panelde Pyn ile sayfa hakkında konuşmak. Ayrıntı kendi tasarımında,
  Faz 1–4 oturduktan sonra.

## Sıra

0 hemen değer verir ve temeli sınar. 1 küçük, kimseye dayanmaz ve hemen gösterilebilir. 2 eşitlemenin altıdır.
3 ve 4 yalnız 2'ye dayanır, birbirinden bağımsızdır. 5, 3'ün kurduğu sunucuyu ve 1'in araçlarını ister. 6 en son;
1'i ister, kapıyı istemez.

## Kapsam dışı

- Telefona kasa kopyası (Android'de git): telefon pencere kalır.
- GitHub dışında bir merkez (ör. sunucunun kendisi). İhtiyaç çıkarsa Faz 3'ten sonra.
- Geliştiricinin kişisel zamanlanmış işlerinin ürüne taşınması.
