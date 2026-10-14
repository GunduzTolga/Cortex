# Ofis sekmesi: tasarım

Tarih: 14 Ekim 2026 · Dal: `masaustu-pyn` · İlham: Kantan.Game (kantan.news/game)

## Amaç

Cortex masaüstü uygulamasına Pyn, Notlar ve Grafik'in yanında dördüncü bir sekme: **Ofis**. Piksel sanatıyla çizilmiş, yaşayan bir ofis. Adı ve huyu olan ajanlar çalışıyor, kendi aralarında kullanıcının notları hakkında konuşuyor, kasada olan bitene tepki veriyor. İşlevsel bir araç değil; güzel ve canlı olması için var.

## Kararlar (kullanıcıyla)

- **Çizimler özgün.** Kantan'ın çizimleri LimeZu'nun ticari paketinden; kopyalanmayacak. Çizimleri ve arayüzün görünüşünü kullanıcı **Claude Design**'a yaptıracak: brif `docs/ofis/claude-design-brifi.md`, çizimlerin veri biçimi o brifin 9. bölümünde. Motor, Claude Design'dan gelecek `office-art.js` dosyasını içeri alır.
- **Konuşmalar:** varsayılan olarak hazır kalıplarla, kasadan beslenen. Ofis ayarlarında **"Canlı konuşmalar"** anahtarı **başta kapalı**. Açılınca kullanıcı giriş yapılmış bir aracı, o aracın bir modelini ve sıklığı seçer. Durduk yere kota harcanmaz.
- **Kadro:** patron Pyn (ananas) ve insan adlı 12 ajan; artı ofis kedisi Tekir. Beşi araçlara karşılık gelir: Defne (Claude), Baran (Codex), Ilgın (OpenCode), Toprak (Gemini), Asya (Qwen). Ötekiler destek: Berk, Sena, Kaan, Elif, Umut, Melis, Hüsnü amca.
- **Kapsam dışı (şimdilik):** iş görüşmesi misafirleri ve ofis durumunun kaydedilmesi. Ofis her açılışta baştan kurulur.

## Mimari

Ofis tamamen pencerede (renderer) yaşar. Ana süreç yalnız iki iş için devreye girer: canlı konuşmaların yazdırılması ve ayarların saklanması.

### Pencere: `desktop/src/office/`

| Birim | Ne yapar | Neye dayanır |
|---|---|---|
| `art/` | Claude Design'ın `office-art.js` dosyası ve onu ekran dışı tuvallere pişiren `bake.ts`. Çizim gelene kadar aynı arayüzü sağlayan basit yer tutucu çizimler (`placeholder.ts`). | canvas |
| `world.ts` | `MAP`'ten yürünebilirlik ızgarası (duvarlar ve eşyaların `solid` alanları), odalar, koltuklar, noktalar. Bir pikselin hangi odaya düştüğü. | `art` (salt veri) |
| `path.ts` | Izgarada A* yol bulma; kapı geçişleri. | `world` |
| `cast.ts` | 14 karakterin kimliği: ad, rol, araç, renk, hakkında, huy kalıpları. Arayüz metinleri i18n'den. | — |
| `sim.ts` | Saf, sabit zaman adımlı simülasyon. Her ajanın ihtiyaçları (Çay, Tokluk, Enerji), durumu (masada, yürüyor, konuşuyor, toplantıda, taşıyor, mutfakta, uyukluyor), hedefi ve sayaçları. Zamanlayıcı: atışma, toplantı, çay turu, teftiş. Tohumlu rastgelelik; testte saat ve rastgelelik dışarıdan verilir. | `world`, `path`, `cast` |
| `banter.ts` | Atışma kuyruğu. Kalıp üreteci: not başlıkları, etiketler, klasörler, bağlantı sayıları ve son düzenlemeler, her ajanın kendi ağzıyla 6 satır olur; Türkçe ve İngilizce. Canlı konuşmalar açıksa ana süreçten gelen atışmalar öne alınır. | `cast`, kasa özeti |
| `events.ts` | Kasa ve sohbet olaylarını ofis olaylarına çevirir. Not dizinindeki farktan yeni not, düzenleme, makbuz, üretilmiş sayfa ve çöp; sohbet itmelerinden Pyn'in telefonu; araç durumundan sunucu LED'leri. | `notesStore`, `chatStore` |
| `render.ts` | Tuval çizimi: pişmiş zemin katmanı, y'ye göre sıralanan eşya ve karakterler, kapılar, balonlar, seçim oku, oda adları, ışık kaplaması (gerçek saate göre; gece lamba ve ekran parıltısı). Kamera: yakınlaşma ve kaydırma. Görünmeyen sekmede çizim durur. | `art`, `world`, `sim` |
| `officeStore.ts` | zustand: seçili karakter ya da oda, kamera, günlük (son 200 satır), yazı tipi tercihi, ayarlar. | — |
| `OfficeView.tsx` ve parçaları | Üst bilgi, yakınlaştırma düğmeleri, ipucu, karakter kartı, oda paneli (canlı önizleme), kişi çipleri, günlük, ayarlar kutusu. | yukarıdakiler |

Sekme `useView` deposuna `office` olarak eklenir. Öteki sekmeler gibi bir kez açıldıktan sonra arka planda bağlı kalır, ama görünmediği sürece simülasyon ve çizim durur.

### Ana süreç: `desktop/electron/services/banter.ts`

- **Ayarlar** `settings.json` içinde `office` alanında: `{ live: false, cli, model, every: 20, realLight: true }`. Pencere bunları `settings:get` ve `settings:set` ile okur ve yazar.
- **Canlı konuşmalar:** `live` açıksa ve seçilen araç giriş yapmışsa her `every` dakikada bir (ve "Şimdi bir tane yaz" ile) tek atımlık bir istek yapılır.
  - İstemi pencere kurar: kadro, not başlıkları ve son düzenlenen notlardan kısa parçalar.
  - Seçilen araç salt okunur bir oturumda, araç kullanmadan, yalnız JSON cevap vermesi istenerek çalıştırılır. Mevcut sohbet arka uçları (Claude Code, Codex, ACP) bunun için tek atımlık bir yolla kullanılır.
  - Cevap şemaya göre doğrulanır: atışma başlığı, iki konuşmacı (kadrodan), 4–8 satır, satır başına en çok 140 karakter. Geçersiz cevap atılır.
  - Kabul edilen atışma `chat:` itmeleri gibi bir itmeyle (`office:banter`) pencereye gider.
- **Hata halinde** ofis susmaz, kalıplar devam eder. Ayarlar kutusunun durum satırı "Son deneme yazılamadı · Codex" gibi bir şey der; günlüğe hata yazılmaz.
- **Gizlilik:** araca yalnız not başlıkları ve kısa parçalar gider, mutlak yol hiçbir zaman gitmez. Kapalıyken hiçbir şey gitmez.

### Kasadan ofise olaylar

| Kasada | Ofiste |
|---|---|
| Yeni not | 📬 Posta odasına düşer; Umut onu bir yazarın masasına taşır |
| Not düzenlendi | O nota yakın ajan masasında yazar (`type`); sayaç artar |
| Makbuz (`receipts/…`) | 🧾 Kaan arşive kaldırır |
| Üretilmiş sayfa | ✅ Pyn onaylar → 📰 "Yayında" |
| Not çöpe atıldı | 🗑️ Hüsnü amca çöpü boşaltır |
| Pyn sohbeti çalışıyor | Pyn masasında telefonla konuşur |
| Araç durumu | Sunucu odasındaki kabin LED'leri: yeşil, sarı ya da sönük |

Olaylar yığılırsa birleştirilir: aynı dakikada 30 yeni not tek bir "📬 30 yeni not" satırı olur.

## Arayüz

Ayrıntısı brifin 8. bölümünde. Kısaca:
- Üst bilgi (`● CANLI · OFİS AÇIK · saat`) ve ayarlar düğmesi.
- `+ − ⤢ Aa` düğmeleri ve ipucu.
- Karakter kartı (ihtiyaç çubukları, sayaçlar, aracın gerçek giriş durumu) ve oda paneli (canlı önizleme, içeridekiler).
- Kişi çipleri ve Ofis günlüğü.

Ofis paneli koyu, retro bir monitör gibi durur. Cortex'in açık renkli çerçevesi aynı kalır.

## Hata ve uç durumlar

- **Kasa yok:** ofis çalışır, kalıplar genel konularla konuşur, ince bir şerit durumu söyler.
- **Çizim dosyası eksik ya da bozuk:** yer tutucu çizimlerle çalışır.
- **Çok büyük kasa:** kalıp üreteci dizinin yalnız son 500 notunu ve en çok bağlanan 100 notunu kullanır.
- **Görünmeyen sekme:** zamanlayıcılar durur. Geri gelince simülasyon kaldığı yerden sürer; geçen sürenin olayları tek satırda özetlenir.
- **Hareketleri azalt** tercihi: boşta animasyonları yavaşlar, kamera kaymaları anlık olur.

## Test

- **Birim testleri (node:test):**
  - `world`: yürünebilirlik; her koltuğa ve noktaya kapılardan ulaşılıyor.
  - `path`: en kısa yol, engelden kaçınma.
  - `sim`: ihtiyaçların azalıp mutfağa gidilmesi; atışmada iki ajanın buluşup sırayla konuşması; toplantı; tohumla tekrar üretilebilirlik.
  - `banter`: kalıpların iki dilde ve kasa verisiyle dolması; boş kasa.
  - `events`: dizin farkından olay çıkarma ve birleştirme.
  - `banter.ts` (ana süreç): şema doğrulama, kapalıyken hiçbir istek yapılmaması.
- **Uçtan uca (Playwright):**
  - Ofis sekmesi açılıyor; karaktere tıklayınca kart, odaya tıklayınca panel açılıyor.
  - Çipten seçim yapılabiliyor; günlüğe satır düşüyor.
  - Canlı konuşmalar kapalı başlıyor.
  - Gizli ekran görüntüsü alınabiliyor.
- **Çizim kontrolü:** Claude Design'ın galerisi; ayrıca Cortex içinde gizli ekran görüntüleriyle.

## Aşamalar

1. **Motor ve yer tutucu çizimler:** dünya, yol bulma, simülasyon, olaylar, kalıplar, çizim, arayüz. Çizimler basit şekiller ama brifteki veri biçiminde.
2. **Claude Design çizimleri:** `office-art.js` takılır, harita ve kadro onunla çalışır, gece ışığı ve ayrıntılar incelenir.
3. **Canlı konuşmalar:** ana süreç servisi, ayarlar kutusu, tek atımlık araç çağrısı.
