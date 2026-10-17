# Cortex Ofisi: beynin içindeki ofis (Claude Design brifi, ek)

Bu brifi Claude Design'a ver, yanına ofisin şu anki dosyalarını ekle: `desktop/src/office/office-art.js` (çizimler) ve ilk brif [claude-design-brifi.md](claude-design-brifi.md). Bu, o işin devamı; aynı dosya, aynı tarz, aynı kurallar.

---

## 1. Fikir

Ofis, kullanıcının beyni: notlarını taşıyan, bağlantı kuran, arşivleyen ekip onun kafasının içinde çalışıyor. Bugün haritanın çevresi düz, koyu bir zemin (`#0B0D11`). Bu çevre bir **beyne** dönüşsün: ofis, beynin içine oyulmuş bir ortam gibi görünsün. Sekmeyi açan kişi ilk bakışta "beynimin içindeki ofis" demeli.

## 2. Teslim edilecekler

`office-art.js` içine, bugünkü dışa aktarımların yanına:

1. **`export const BRAIN`**
   - `margin: { top, right, bottom, left }`: haritanın çevresine eklenen beyin kenarı, piksel, 16'nın katları.
   - `w`, `h`: çerçeveli dünyanın tamamı (harita + kenarlar).
2. **`export function paintBrain(ctx, mode)`**
   - Çerçeveyi bir kez çizer; motor onu sabit bir katmana alır.
   - Haritanın dikdörtgenine dokunmaz: orası harita için boş kalır.
   - `mode`: `'sabah' | 'ogle' | 'aksam' | 'gece'`. Işığa uyar: gece koyulaşır, sabah biraz sıcaklaşır.
3. **Sinyal kıvılcımı:** `SPRITES['kivilcim']`.
   - Kıvrımlar boyunca akan küçük bir ışık, 4–6 kare.
   - **`export const NEURON_PATHS`:** kıvılcımların izleyeceği yollar, çerçevenin koordinatlarında nokta listeleri (her yol 4–12 nokta).
4. **`BRAIN.anchors`** (isteğe bağlı ama iyi olur): odaların dışına yakın, kıvılcımın çıkacağı yerler, oda adıyla: `{ posta: [x, y], harita: [...], arsiv: [...], pyn: [...], salon: [...], mutfak: [...], toplanti: [...], sunucu: [...], dinlenme: [...] }`. Ofiste bir olay olunca (not geldi, makbuz arşive kalktı) o odanın kenarından bir kıvılcım çıkar.
5. **Önizleme sayfası:** haritayla birlikte, dört ışık modunda, kıvılcımlar akarken.

## 3. Görünüm

- **Biçim:** haritayı içine alan iki yarıküre, yukarıdan bakılmış gibi.
  - Kenarlarda kıvrımlar (girus) ve aralarında oluklar (sulkus).
  - Üstte ortada yarıküreleri ayıran yarık.
  - Altta ortada beyin sapı ve iki yanında beyincik; alt kenar biraz daha geniş olabilir.
- **Ofisle birleşme:** harita dikdörtgen kalır, ama beyin dokusu haritanın dış duvarına doğru incelerek yaslanır. Ofis beynin içine oyulmuş, bir pencereden içi görülüyor gibi; çerçeve yapıştırılmış bir resim gibi durmamalı.
- **Palet:** ofisin paletiyle aynı aile.
  - Soğuk, koyu zeminin üstünde sıcak gri-pembe bir beyin: temiz, sevimli, "piksel oyun" havasında.
  - Kanlı ya da tıbbi değil; kırmızıya kaçmayan, birkaç tonlu düz pembe-gri.
  - Oluklar bir ton koyu, kıvrımların tepeleri bir ton açık.
- **Işık:** ofisle aynı yönden (sol üst). Gece modunda doku koyulaşır, kıvılcımlar daha belirgin parlar.
- **Kıvılcımlar:**
  - Küçük (2–3 piksel çekirdek, çevresinde bir piksel hale).
  - Altın ya da turkuaz; ofisteki LED ve vurgu renklerinden.
  - Ekranı yormamalı: aynı anda en fazla 3–4 tane.

## 4. Ölçüler

- **Harita:** 61 × 42 kare = **976 × 672 piksel** (1× ölçekte).
- **Önerilen kenarlar:** üst 64, sağ 96, sol 96, alt 112 (beyin sapı için). Böylece dünya **1168 × 848** olur. Gerekirse değiştir, `BRAIN.margin`'de söyle.
- **Görünüm:** motor varsayılan görünümde bütün beyni ekrana sığdırır. En küçük pencere yaklaşık 1000 × 640; orada da ofisin odaları okunur kalmalı, bu yüzden kenarlar çok kalın olmasın.

## 5. Kurallar (ilk brifteki gibi)

- 1× ölçekte tam piksel, yalnız dikdörtgen (`fillRect`); kenar yumuşatma, gradyan, saydam bulanıklık yok.
- `office-art.js`'in testleri (her nesne çizilir, yalnız dikdörtgen, tam piksel) çerçeve ve kıvılcım için de geçerli.
- Haritanın üstüne binen hiçbir doku yok.

## 6. Motorla bağlantı (bunu Cortex tarafı yapacak)

- Motor dünyayı `BRAIN.w × BRAIN.h` kurar ve haritayı `margin` kadar kaydırır.
- Çerçeveyi ışık modu değiştiğinde yeniden çizer, kıvılcımları `NEURON_PATHS` boyunca canlandırır.
- Ofis olaylarını `BRAIN.anchors`'a bağlar.
- Tıklama, yakınlaştırma ve oda seçimi haritada aynen çalışır; çerçeve yalnız görüntü.

## 7. Asla

- Gerçekçi anatomi, kan, damar ağı, korkutucu ya da tıbbi görüntü.
- Beynin üstünde göz, yüz, yazı ya da logo.
- Haritayı küçülten, odaları okunmaz yapan kalın bir çerçeve.
