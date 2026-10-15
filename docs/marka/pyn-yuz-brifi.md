# Pyn'in yüzü: Claude Design brifi

> **Teslim alındı (1.0.9):** çizimler `tema/ananas/marka/pyn-yuz/` içinde; PNG'yi `py -3 scripts/marka_uret.py yuz <teslim>/pyn-yuz` üretir.

Bu brifi Claude Design'a ver. Ek olarak iki dosyayı yükle:
- **`tema/ananas/marka/pyn-muhur-200.png` (mühür):** çizgi kalınlığı ve renkler için **örnek alınacak** görsel.
- **`tema/ananas/marka/pyn-yuz-256.png` (bugünkü yüz):** **bırakılacak** olanın örneği. Karakter aynı kalıyor, çizim baştan yapılıyor.

---

## 1. Ne yapıyoruz

**Pyn**, Cortex'in maskotu ve kullanıcının düşünme ortağı: huysuz bakışlı bir **ananas**. Mührü (altın zemin üzerinde siyah ananas) uygulamanın işareti; **yüzü** ise Pyn'in kendisi, yani konuşan karakter.

Bugünkü yüz kötü:
- Raster bir çizim; kâğıt dokusu ve benekler küçük boyutta kire dönüşüyor.
- Çizgiler ince ve titrek; 28 pikselde göz, burun ve ağız seçilmiyor.
- Bej daire zemin mühürle ve uygulamanın kâğıt rengiyle uyuşmuyor.

Yeni yüz **temiz bir vektör çizim** olacak: mühürle aynı aileden, kalın mürekkep konturlu, az ama doğru çizgili, 24 pikselde de Pyn olduğu belli olan bir yüz.

### Nerede kullanılacak
| Yer | Boyut |
|---|---|
| Masaüstü uygulamasında sohbet, her cevabın yanında | **28 px** |
| Sohbetin karşılama ekranı | **56 px** |
| Obsidian temasında boş sekmenin ortası | **128–256 px** |
| İleride ofis sekmesinin koyu paneli ve uygulama içi kartlar | 32–128 px, koyu zemin |

---

## 2. Karakter: değişmeyecek olanlar

Pyn'in tarifi baştan beri bu; yeni çizim bu tarife sadık kalacak:

- **Gövde:** dik, uzunca bir **ananas**, hardal altını (`#E8B23A`).
- **Kabuk:** açık okunan bir **baklava (eşkenar dörtgen) kafes**; ananasın küçük meyvecikleri.
- **Taç:** sert, sivri, **zeytin yeşili yapraklar**; biraz dağınık ve **hafifçe bir yana eğik**.
- **Yüz:**
  - **Büyük, uzun bir burun**: karakterin imzası.
  - **Ağır kapaklı, yarı kapalı, ifadesiz gözler**: "hiçbir şeyden etkilenmiyorum" bakışı.
  - **Küçük, düz, kayıtsız bir ağız.**
- **Huy:** huysuz ama sevimli; az konuşur, her şeye "Hmm." der.
- Ofis sekmesindeki piksel Pyn (patron) da aynı karakter. Onunla yan yana durduğunda aynı ananas olduğu anlaşılmalı.

**Asla:**
- Sevimli chibi oranlar, kocaman parlak anime gözleri, açık gülen ağız.
- Gerçekçi meyve fotoğrafı, parlak 3B render, gradyanlar.
- Güneş gözlüğü, yazı, filigran.
- Başka bir markanın maskotuna benzeyen bir tasarım.

---

## 3. Tarz: mühürle aynı aile

Mührün SVG'si aşağıda; yeni yüz bu çizgi diliyle konuşmalı.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" stroke-linecap="round" stroke-linejoin="round"><circle cx="100" cy="100" r="94" fill="#e8b23a" stroke="#1b1712" stroke-width="7"/><circle cx="100" cy="100" r="82" fill="none" stroke="#1b1712" stroke-width="2.4"/><!-- ortada: siyah ananas silueti, taç beş sivri yaprak, kabukta altın baklava kafes --></svg>
```

- **Kontur:** kalın mürekkep (`#1B1712`), uçlar ve köşeler yuvarlak. 256'lık çizimde yaklaşık 6–8 birim.
- **Renkler (Ananas paleti):**

  | Ad | Renk |
  |---|---|
  | kâğıt | `#F3EFE4` |
  | mürekkep | `#1B1712` |
  | altın | `#E8B23A` |
  | parlak sarı | `#FFD23E` (vurgu, ışık) |
  | koyu altın | `#C98A2E` (gölge) |
  | yosun yeşili | `#5C6B4A` (yaprak) |
  | açık yosun | `#A3B48A` (yaprak ışığı) |
  | kum | `#CDBFA3` |

- **Gölgelendirme:** düz renk alanları. En fazla bir gölge tonu (koyu altın) ve bir ışık tonu (parlak sarı).
- **Doku:** benek, gürültü ya da kâğıt dokusu yok. Bir yarım ton (halftone) dokunuşu istersen yalnız büyük boyutta kalsın ve 64 pikselin altında hiç görünmesin.
- **Oran:** yüz tanınır olsun diye kafa ve burun biraz büyük tutulabilir, ama çizim sevimli değil, karakterli kalmalı.

---

## 4. Teslim edilecekler

1. **`pyn-yuz.svg`: ana avatar.**
   - Kâğıt rengi (`#F3EFE4`) bir dairenin içinde Pyn'in yüzü ve tacı; dairenin kenarında mühürdeki gibi kalın bir mürekkep halka.
   - Taç dairenin dışına biraz taşabilir, bu karakter katar; ama 256×256 viewBox'ın içinde kalsın.
2. **`pyn-yuz-kucuk.svg`: 32 piksel ve altı için sadeleştirilmiş sürüm.**
   - Daha az kafes çizgisi (en fazla 3×3), daha kalın kontur.
   - Gözler, burun ve ağız biraz büyük; ayrıntı yok.
   - 24 ve 28 pikselde net okunmalı.
3. **`pyn-yuz-saydam.svg`:** dairesiz, saydam zeminli yüz; başlıklar ve kartlar için.
4. **`pyn-yuz-koyu.svg`:** koyu zemin (`#0E1116`) üzerinde kullanılacak sürüm.
   - Halka ve konturlar koyu zeminde kaybolmasın: dış hat için açık bir kontur ya da parlak altın halka.
5. **`pyn-yuz-tek-renk.svg`:** yalnız mürekkep rengiyle tek renk sürüm (baskı, tek renk ikon).
6. **İfade varyantları** (isteğe bağlı ama iyi olur), aynı yüzün küçük oynamaları; yeni bir karakter değil:
   - `dusunuyor`: gözler yukarı-yana, ağız hafif büzük
   - `uyuyor`: gözler kapalı, küçük "z"siz
   - `hmm`: bir kaş hafif kalkık
7. **Önizleme sayfası:**
   - Ana avatar ve küçük sürüm, 24, 28, 32, 56, 128 ve 256 pikselde.
   - Hem kâğıt (`#F3EFE4`) hem koyu (`#0E1116`) zeminde.
   - Mühürle yan yana.
   - Bir sohbet satırının yanında 28 pikselde nasıl durduğunu gösteren bir örnek: avatar, ardından "Merhaba, notlarına baktım." gibi bir cümle.

### SVG kuralları
- Saf vektör: içine gömülü raster, dış dosya ya da yazı (`<text>`) yok.
- `viewBox="0 0 256 256"`. Gruplar adlı olsun: `halka`, `govde`, `kafes`, `tac`, `yuz` (`goz-sol`, `goz-sag`, `burun`, `agiz`).
- Gereksiz dönüşüm ve düzinelerce ondalık basamak yok; kod okunur ve küçük olsun. Gradyan, filtre, maske yok; kırpma (`clipPath`) yalnız kafes için.
- PNG'leri ben SVG'den üreteceğim; senin SVG'lerin yeter.

---

## 5. Bitirmeden önce kontrol et

- [ ] 24 pikselde gözler, burun ve ağız seçiliyor; Pyn olduğu anlaşılıyor.
- [ ] Mühürle yan yana aynı aileden görünüyor: aynı mürekkep, aynı altın, aynı kalın çizgi.
- [ ] Bakış ifadesiz ve huysuz; gülümseme ya da anime göz yok.
- [ ] Taç yeşil, sivri ve hafif eğik; kabukta baklava kafes okunuyor.
- [ ] Koyu zeminde de net.
- [ ] SVG'lerde raster, yazı ve gradyan yok.
