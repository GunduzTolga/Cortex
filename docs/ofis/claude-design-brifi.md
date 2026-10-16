# Cortex Ofisi: Claude Design brifi

Bu brifi Claude Design'a ver. Ekli ekran görüntüleri (Kantan.Game) **yalnız referans**: havası, yoğunluğu, ölçeği, kamera açısı ve arayüz düzeni için. Çizimlerin tamamı **özgün** olmalı; görüntülerdeki piksellerin, eşyaların ya da karakterlerin kopyası değil. O görüntülerdeki çizimler LimeZu adlı sanatçının ticari paketinden; aynı kalite ve aynı tarz ailesinde, ama kendi çizimlerimizi istiyoruz.

---

## 1. Ne yapıyoruz

**Cortex** bir masaüstü not uygulaması (Electron + React). Üstte dört sekme olacak: **Pyn** (yapay zekâ sohbeti), **Notlar**, **Grafik** ve yeni sekme **Ofis**.

**Ofis**, piksel sanatıyla çizilmiş, yaşayan bir ofis. İçinde adı, yüzü, masası ve huyu olan yapay zekâ ajanları çalışıyor. Kendi aralarında kullanıcının notları ve projeleri hakkında konuşuyorlar, çay içiyorlar, toplantıya giriyorlar, dosya taşıyorlar. İşlevsel bir araç değil; **güzel ve canlı** olması için var. Kullanıcı karakterlere ve odalara tıklayıp onların ne yaptığına bakıyor.

Patron **Pyn**: uygulamanın maskotu, huysuz bakışlı bir **ananas** (sarı-turuncu, baklava desenli kabuk, tepesinde yeşil yapraklar, yarı kapalı gözler, büyük burun, düz ağız).

### Senden istenen
1. **Bütün çizimler**: zeminler, duvarlar, eşyalar, karakterler ve animasyonları.
2. Haritanın etrafındaki **arayüzün görünüşü**: üst bilgi, düğmeler, konuşma balonları, karakter kartı, oda paneli, kişi çipleri, günlük, ayarlar.
3. İkisini birlikte gösteren **çalışan bir prototip**.

Gerçek simülasyonu, yol bulmayı ve kullanıcının notlarından gelen olayları Cortex'te Claude Code yazacak. Prototipte yalnız hafif bir gösteri yeterli; asıl iş çizimlerde ve arayüzde.

---

## 2. Teslim edilecekler

1. **`office-art.js`**: bütün çizimler, veri ya da çizim fonksiyonu olarak, prototip kodundan **ayrı** bir ES modülü. Biçimi 9. bölümde. **En önemli teslim bu:** Cortex bu dosyayı olduğu gibi içeri alacak.
2. **`index.html`**: etkileşimli prototip. Ayrıntısı 8. bölümde.
3. **Galeri**: her eşya ve her animasyon karesi 4× büyüklükte, damalı (saydamlık) zemin üzerinde, altında adıyla. Ayrı bir sayfa ya da prototipte bir sekme olabilir. Karakterlerin bütün pozları ve yönleri burada yan yana dursun.
4. **Arayüz değişkenleri**: renkler, yazı tipi, boyutlar; bir `:root { … }` CSS bloğu olarak.

---

## 3. Tarz

- **Izgara:** 16×16 piksellik kareler. Her şey 1× ölçekte çizilir, ekranda yalnız tam sayı katlarında ya da en yakın komşu (nearest-neighbor) ölçeklemeyle gösterilir. Yumuşatma yok, yarım piksel yok.
- **Bakış açısı:** yukarıdan, modern indie RPG iç mekânları gibi "3/4" görünüm.
  - Zemin tam yukarıdan görünür.
  - Her odanın **kuzey duvarı ön yüzüyle** görünür (3 kare = 48 px yüksek): üstte koyu bir duvar başlığı, ortada duvar yüzü, altta süpürgelik.
  - Yan ve güney duvarlar yalnız ince bir **duvar başlığı** şeridi olarak görünür.
  - Eşyaların hem üst yüzü hem ön yüzü görünür.
- **Işık:** sol üstten. Üst kenarlarda 1 piksel parlaklık, sağ ve alt yüzlerde bir ton koyu gölge.
- **Kontur:** 1 piksel, saf siyah değil; nesnenin kendi renginin çok koyu tonu.
- **Gölge:** eşyaların ve karakterlerin altında 1–2 piksellik yarı saydam koyu gölge; karakterlerde ayak altında küçük bir elips.
- **Palet:** sınırlı ve uyumlu, toplam 48–64 renk. Sıcak ahşaplar, serin griler, kısık vurgu renkleri. Ekranlar camgöbeği ya da mavi parlar, bitkiler koyu yeşil. Bağıran saf ana renkler yok.
- **Yoğunluk:** odalar **dolu ve yaşanmış** görünmeli. Her masada bir şeyler olsun: kâğıt yığını, kupa, küçük bitki, figür, yapışkan not, kulaklık, fotoğraf çerçevesi. Duvarlarda afiş, saat, raf, klima, pano. Bu ofiste insanlar çalışıyor gibi dursun.
- **Karakterler:**
  - 16 px genişliğinde, **32 px yüksekliğinde** bir hücre; gövde yaklaşık 24–28 px.
  - Sevimli ve hafif büyük kafalı oranlar: kafa yaklaşık 10–11 px.
  - Okunur yüzler (2 piksellik gözler) ve siluetinden tanınan saç modelleri.
  - 1× ölçekte bile her ajan ötekilerden ayırt edilebilmeli.

---

## 4. Harita

**61 × 42 kare = 976 × 672 piksel** (1× ölçekte). Dört üst oda, ortada bütün genişlikte bir salon, dört alt oda.

```
x:  0              15              30              45              60
y0  ┌──────────────┬───────────────┬───────────────┬──────────────┐
    │  POSTA ODASI │  HARİTA ODASI │  ARŞİV        │  PYN'İN ODASI│
    │  (asansör)   │               │               │              │
y13 ├────[kapı]────┴────[kapı]─────┴────[kapı]─────┴────[kapı]────┤
    │                       YAZI İŞLERİ (salon)                    │
    │    [masa grubu A 3×2]  [masa grubu B 2×2]   [Sena] [yazıcı]  │
y28 ├────[kapı]────┬────[kapı]─────┬────[kapı]─────┬────[kapı]────┤
    │  MUTFAK      │  TOPLANTI     │  SUNUCU ODASI │  DİNLENME    │
y41 └──────────────┴───────────────┴───────────────┴──────────────┘
```

### Satırlar (y)
| Satır | Ne var |
|---|---|
| 0 | dış duvar başlığı |
| 1–3 | üst odaların kuzey duvar yüzü |
| 4–12 | üst odaların zemini |
| 13 | üst odalarla salon arasındaki duvar başlığı |
| 14–16 | salonun kuzey duvar yüzü |
| 17–27 | salonun zemini |
| 28 | salonla alt odalar arasındaki duvar başlığı |
| 29–31 | alt odaların kuzey duvar yüzü |
| 32–40 | alt odaların zemini |
| 41 | dış duvar başlığı |

### Sütunlar (x)
- Dikey duvar başlıkları x = 0, 15, 30, 45, 60 üzerinde.
- Oda içleri: x 1–14, 16–29, 31–44, 46–59.
- Salon zemini x 1–59.

### Kapılar
- Her kapı **2 kare genişliğinde**, cam ve sürgülü.
- Üst odalar ile salon arasındaki kapılar x 7–8, 22–23, 37–38, 52–53 sütunlarında. y 13–16 boyunca açılırlar: hem duvar başlığı hem duvar yüzü o sütunlarda boştur.
- Alt odaların kapıları aynı sütunlarda, y 28–31 boyunca.
- Kapının yanında, yüzde küçük bir oda tabelası olabilir (yazısız levha; yazıyı motor yazar).

### Oda adları
Kantan'daki gibi her odanın zemininin sol alt köşesine, soluk büyük harflerle yazılır. Yazıyı **motor** çizer; sen yalnız prototipte göster:

| Türkçe | İngilizce |
|---|---|
| POSTA ODASI | MAILROOM |
| HARİTA ODASI | MAP ROOM |
| ARŞİV | ARCHIVE |
| PYN'İN ODASI | PYN'S OFFICE |
| YAZI İŞLERİ | NEWSROOM |
| MUTFAK | KITCHEN |
| TOPLANTI | MEETING ROOM |
| SUNUCU ODASI | SERVER ROOM |
| DİNLENME | LOUNGE |

---

## 5. Odalar, tek tek

Her oda en az **12 farklı eşya** içersin; büyük odalar daha fazla. Aşağıdaki listeler asgari; ayrıntı eklemekten çekinme.

### 5.1 Posta odası (x 1–14, gelen kutusu)
Yeni notların "düştüğü" yer; kurye Umut burada.
- **Zemin:** sıcak kahve ahşap parke.
- **Kuzey duvarı:**
  - Solda **asansör**: çelik çift kapı, üstünde kat göstergesi. Açılıp kapanan 5 karelik animasyonu olsun.
  - Ortada zarf ve dosya dolu **posta gözleri**: birkaç sıra küçük bölme, bazılarında renkli zarflar.
  - Duvara asılı iki ekran: biri gelen not listesi gibi satırlar, biri küçük bir grafik.
  - Bir duvar saati.
- **İçeride:**
  - Umut'un **ayırma masası**: zarf yığınları, damga, koli bandı.
  - İki monitörlü resepsiyon tezgâhı.
  - Tarayıcı ya da yazıcı (kâğıt çıkma animasyonu).
  - Üst üste kargo kolileri, kurye çantası asılı bir askılık.
  - Saksı bitki, küçük çöp kutusu.
  - Bekleme için iki sandalye.
- **Işık:** masa lambası.

### 5.2 Harita odası (x 16–29; Grafik sekmesinin ofisteki hali)
- **Zemin:** gri-mavi halı.
- **Kuzey duvarı:** duvarı neredeyse baştan sona kaplayan **mantar pano**. Üstünde iğnelenmiş renkli not kâğıtları var, birbirlerine **kırmızı iplerle** bağlı. Notların grafiği gibi dursun.
- **İçeride:**
  - Ortada büyük bir **harita masası**: üstünde açık bir plan ya da kâğıt, cetvel, kalemler.
  - Tekerlekli bir **beyaz tahta**: oklar ve kutular çizili.
  - Elif'in çift monitörlü masası: ekranlarda düğümler ve çizgiler.
  - Rulo kâğıt sepeti, kitaplık, yer lambası.
  - Saksı bitki, bir tabure.

### 5.3 Arşiv (x 31–44; makbuzlar burada saklanır)
- **Zemin:** açık renkli balıksırtı parke.
- **Kuzey duvarı:** **tavana kadar kitaplıklar**: renkli klasörler, sırtı etiketli dosyalar, birkaç kutu.
- **İçeride:**
  - İki sıra metal **dosya dolabı**; çekmecelerde etiket yerleri, birinin çekmecesi yarı açık.
  - Kaan'ın **okuma masası**: yeşil abajurlu banker lambası, **mühür ve ıstampa**, makbuz yığını.
  - Kitaplık merdiveni, dosya kutuları, küçük bir el arabası.
  - Saksı bitki, duvarda "SESSİZ" levhası (yazısız ikon olabilir).

### 5.4 Pyn'in odası (x 46–59; patron odası)
- **Zemin:** koyu kırmızı halı, kenarı desenli.
- **Kuzey duvarı:**
  - Ahşap lambri ve kitaplıklar.
  - Çerçeveli diplomalar.
  - **Çerçeveli bir ananas portresi**.
  - Ödül rafı (küçük kupalar).
- **İçeride:**
  - Büyük, L biçimli **yönetici masası**: monitör, masa telefonu, **"PYN" yazılı isimlik** (bu yazı piksel olarak çizime gömülebilir), evrak sepeti, onay mührü.
  - Deri yönetici koltuğu, iki misafir koltuğu.
  - Köşede **akvaryum** (balık animasyonu, 4 kare), yer lambası, portmanto.
  - Küçük bir kanepe ya da sehpa.
  - Saksıda **gerçek bir ananas bitkisi** (sevimli ayrıntı).

### 5.5 Yazı işleri (salon, x 1–59, y 17–27)
Ofisin kalbi.
- **Zemin:** açık gri, cilalı karolar; ince derz çizgileri olsun, birkaç kare hafif ton farkıyla.
- **Kuzey duvar yüzü (y 14–16), kapıların arasında:**
  - Panjurlu iç pencereler (üst odalara bakan).
  - Büyük duvar ekranları: birinde çizgi grafikli bir pano, birinde not listesi.
  - Çerçeveli afişler (biri ananaslı bir "CORTEX" afişi; yazı istemiyorsan simge olsun).
  - Duvar tipi klimalar, büyük bir **analog duvar saati** (akrep ve yelkovanı motor çizer; sen kadranı çiz).
  - Yapışkan notlu bir pano, yangın söndürücü.
- **Masa grubu A (yaklaşık x 4–10, y 19–24):**
  - 3 × 2 masa, sırt sırta.
  - **Üst sıradakiler aşağı bakar** (yüzleri görünür, masa alt gövdelerini kapatır); **alt sıradakiler yukarı bakar** (sırtları görünür).
  - Her masa 2 kare genişliğinde, kendi monitörü ve klavyesi var. **Her masa sahibine göre kişiselleştirilmiş** (karakterler bölümüne bak).
  - Sandalyeler farklı renklerde.
- **Masa grubu B (yaklaşık x 14–18, y 19–24):** 2 × 2 boş "ortak masa". Monitörler kapalı, sandalyeler içeri itilmiş, birinde "rezerve" kartı.
- **Sağ taraf:**
  - Sena'nın **L masası**: kırmızı kalemler, düzeltme işaretli kâğıtlar.
  - **Yazıcı ve fotokopi köşesi**: kâğıt yığınları, kâğıt öğütücü.
  - Ayakta toplantı için yüksek bir masa ve iki tabure.
  - Bir **sebil** (kabarcık animasyonu), bir portmanto.
  - Çöp ve geri dönüşüm kutuları, uzun bir saksı sırası.
  - Hüsnü amcanın **çay arabasının** park yeri.

### 5.6 Mutfak (x 1–14, y 32–40)
- **Zemin:** koyu ve açık gri dama karolar.
- **Kuzey duvarı:**
  - Tezgâh, evye, üst dolaplar.
  - Duvar rafında kupalar.
  - **Türk çayı köşesi**: ocakta **iki katlı çaydanlık** (buhar animasyonu, 4 kare), tepside **ince belli çay bardakları**, şekerlik.
- **İçeride:**
  - Buzdolabı (üstünde mıknatıslar), mikrodalga.
  - Atıştırmalık **otomatı** (içinde renkli paketler).
  - Sebil.
  - 4 sandalyeli yemek masası; masada bir tabak **simit**.
  - Çöp ve geri dönüşüm kutuları, saksı bitki.

### 5.7 Toplantı odası (x 16–29, y 32–40)
- **Zemin:** koyu bordo halı.
- **Kuzey duvarı:**
  - Büyük **ekran**: slayt gösteriyor, 4 farklı slayt karesi (çubuk grafik, madde listesi, ananas logosu, harita).
  - Beyaz tahta, çerçeveli tablolar.
- **İçeride:**
  - Uzun ahşap **toplantı masası** ve çevresinde 8 sandalye: üst ve alt kenarda üçer, uçlarda birer.
  - Masada su şişeleri, defterler, bir hoparlör (konferans telefonu).
  - Köşelerde bitkiler.

### 5.8 Sunucu odası (x 31–44, y 32–40; yapay zekâ araçlarının "evi")
- **Zemin:** koyu, delikli yükseltilmiş döşeme karoları.
- **Kuzey duvarı:** **5 sunucu kabini** yan yana; her biri bir aracın: Claude, Codex, OpenCode, Gemini, Qwen.
  - Her kabinin önünde yanıp sönen LED'ler (4 karelik animasyon).
  - Üstünde aracın rengini taşıyan bir şerit. **Marka logosu yok**; adları motor yazar.
  - **LED rengi gerçek veriden gelir:** yeşil "giriş yapılmış", sarı "giriş bekliyor", sönük "kurulu değil". Bu yüzden LED'leri kabinden ayrı, renklendirilebilir bir katman olarak çiz.
- **İçeride:**
  - Kablo kanalları, büyük bir soğutma ünitesi, bir UPS.
  - Melis'in **terminal masası**: yeşil yazılı siyah ekran.
  - Yangın söndürücü, alet çantası.
  - Duvarda "dikkat" levhası (yazısız ikon olabilir).

### 5.9 Dinlenme (x 46–59, y 32–40)
- **Zemin:** yumuşak deniz mavisi halı.
- **İçeride:**
  - Büyük bir **kanepe**, iki koltuk, puflar.
  - Sehpa: dergiler ve bir **tavla** (açık, pullar dizili).
  - Kitaplık, yer lambası, büyük bitkiler.
  - **Ofis kedisi Tekir'in yatağı**.
  - Duvarda bir pencere manzarası ya da tablo, bir pikap ya da radyo.

---

## 6. Kadro: 14 karakter

Her karakterin ayrı bir **arayüz rengi** var: kişi çipindeki kare ve günlükte adının rengi. Görünüşleri birbirinden çok farklı olsun; siluetten tanınsınlar.

| Kim | Rol | Araç | Görünüş | Huy | Yeri |
|---|---|---|---|---|---|
| **Pyn** | Patron | — | Ananas (1. bölüm). Küçük kollar ve bacaklar, **minik koyu bir kravat**. Tepedeki yapraklar yürürken sallanır. | Huysuz, az konuşur, her şeyi bir "Hmm." ile onaylar; ekibiyle gizlice gurur duyar. | Pyn'in odası, yönetici koltuğu |
| **Defne** | Kıdemli yazar | Claude | Buğday ten, uzun dalgalı kızıl kahve saç, yuvarlak gözlük, kiremit rengi hırka, krem gömlek, koyu pantolon. | Düşünceli ve kibar, uzun ve özenli cümleler kurar, dipnot sever, "emin misin?" diye sorar. | Grup A, üst sıra sol |
| **Baran** | Mühendis | Codex | Açık buğday ten, yanları kısa siyah saç, kısa sakal, siyah kapüşonlu (göğsünde küçük yeşil bir `>` işareti), koyu kot, beyaz spor ayakkabı, boynunda kulaklık. | Kısa konuşur, terminal aşığı: "çalışıyor, dokunma". | Grup A, üst sıra orta |
| **Ilgın** | Açık kaynakçı | OpenCode | Açık ten, asimetrik kısa **nane yeşili** saç, bol mavi-gri ekose gömlek, kargo pantolon, kalın botlar. | Her ücretsiz modeli dener, kurcalamayı sever: "bunun açık kaynak bir alternatifi var". | Grup A, üst sıra sağ |
| **Toprak** | Araştırmacı | Gemini | Koyu ten, kıvırcık afro saç, açık mavi gömlek üstüne lacivert süveter yelek, bej pantolon, elinde kitap ya da tablet. | Meraklı, 40 sekme açar: "bir kaynağa daha bakayım". | Grup A, alt sıra sol |
| **Asya** | Çevirmen | Qwen | Açık ten, yüksek at kuyruğu uzun siyah saç, mor blazer, beyaz tişört, siyah pantolon. | Cümlenin ortasında dil değiştirir, atasözlerini harfi harfine çevirir. | Grup A, alt sıra orta |
| **Berk** | Stajyer | — | Açık ten, kabarık sarı saç, bordo üniversite kapüşonlusu, boynunda yaka kartı; elinde hep birinin kahvesi. | Fazla hevesli, çok soru sorar: "abi bunu ben yapabilir miyim?" | Grup A, alt sıra sağ |
| **Sena** | Editör | — | Zeytin ten, düz koyu kâkül kesim, kırmızı ruj, siyah balıkçı yaka, gri blazer, elinde kırmızı kalem. | Yazım hatasından nefret eder, başlık düzeltir: "bu başlık olmamış". | Salonda L masa |
| **Kaan** | Arşivci | — | 50'lerinde, açık ten, gri saç, **gür bıyık**, kahverengi yelek, papyon, zincirli okuma gözlüğü. | Titiz, her şeyi mühürler: "makbuzu olmayan iş yapılmamış sayılır". | Arşiv, okuma masası |
| **Elif** | Haritacı | — | Buğday ten, topuz yapılmış kıvırcık koyu saç (topuzda kalem), sarı tişört üstüne yeşil tulum. | Her yerde bağlantı görür: "bu not şununla bağlantılı!" | Harita odası |
| **Umut** | Kurye | — | Esmer ten, dağınık kahve saç üstünde **ters kırmızı şapka**, hardal rengi kurye ceketi, şort, çapraz askılı çanta. | Hızlı ve meraklı, ofisin dedikodusunu taşır. | Posta odası |
| **Melis** | Sistemci | — | Koyu ten, toplanmış örgü saç, siyah tişört, kafasında kulaklıklı mikrofon, belinde alet çantası. | Kuru espri yapar, araçları ayakta tutar: "kim yine sunucuya çay döktü?" | Sunucu odası |
| **Hüsnü amca** | Çaycı | — | 60'larında, tepesi kel, yanları beyaz saç, beyaz bıyık, beyaz gömlek, koyu yelek; elinde **yuvarlak çay tepsisi**. | Babacan, herkese "evladım" der: "çaylar taze!" | Mutfak, çay köşesi |
| **Tekir** | Ofis kedisi | — | Gri tekir kedi, 16×16 hücre. | — | Dinlenme odası; ofiste dolaşır |

### Kişisel masa eşyaları
- **Defne:** kitap yığını, kupada kalemler, küçük sukulent.
- **Baran:** mekanik klavye, ikinci dikey monitör, enerji içeceği kutusu.
- **Ilgın:** çıkartmalarla kaplı dizüstü, küçük robot figürü.
- **Toprak:** üst üste kitaplar, dünya küresi minyatürü.
- **Asya:** sözlükler, çay fincanı, bayrak kürdanları.
- **Berk:** dağınık kâğıtlar, iki kahve bardağı, yapışkan notlar.

### Karakter pozları
Her insan karakter ve Pyn için aşağıdaki pozlar istenir. **Yönler:** `down` (aşağı, yüzü görünür), `up` (yukarı, sırtı görünür), `side` (sağa bakar; sol için motor yatay çevirir).

| Poz | Yönler | Kare | Not |
|---|---|---|---|
| `idle` | down, up, side | 2 | hafif nefes alma |
| `walk` | down, up, side | 4 | |
| `carry` | down, up, side | 4 | kollar önde, bir şey taşıyormuş gibi yürür; taşınan eşyayı motor ekler |
| `sit` | down, up, side | 1 | sandalyede oturur |
| `type` | down, up | 2 | otururken klavyede yazar |
| `phone` | down | 2 | telefona bakar ya da kulağına tutar |
| `yawn` | down | 3 | esner |
| `drink` | down | 2 | çay bardağından içer |
| `talk` | down, side | 2 | konuşurken el hareketi yapar |
| `sleep` | down | 2 | yalnız Pyn ve Hüsnü amca: koltukta uyuklar |

**Tekir için:** `walk` (down, up, side; 4 kare), `sit` (1 kare), `sleep` (kıvrılmış, 2 kare nefes), `stretch` (3 kare), `groom` (2 kare).

**Ellerin yeri:** her pozun her karesi için ellerin piksel konumunu ver. Taşınan dosya ve çay bardağı oraya çizilecek.

**Kafanın yeri:** her karede kafanın üst noktasını ver. Konuşma balonu, seçim işareti ve isim etiketi oraya oturacak.

**Portre:** karakter kartındaki portreyi motor `idle down` karesinden büyütüp kırparak üretir. Ayrı bir portre çizme.

**Önerilen yöntem:** 12 insan karakterin her karesini tek tek elle çizmek yerine, parçalı bir **karakter üreteci** yaz: ortak gövde pozları üzerine saç, üst giysi, alt giysi, ayakkabı ve aksesuar (gözlük, şapka, bıyık, sakal, kulaklık, papyon, yaka kartı, tepsi) katmanları, renkleri paletten. Pyn ve Tekir kendi özel çizimleriyle. Seçim senin; yeter ki sonuç ayrıntılı ve her karakter ayırt edilebilir olsun.

---

## 7. Hareketli eşyalar ve ışık

| Eşya | Kare | Ayrıntı |
|---|---|---|
| Monitör ekranları | 3 | kayan satırlar ya da imleç; açık ve kapalı hali |
| Sunucu LED'leri | 4 | renklendirilebilir ayrı katman |
| Çaydanlık buharı | 4 | |
| Yazıcı | 3 | kâğıt çıkarır |
| Sebil | 3 | kabarcık |
| Toplantı ekranı | 4 | dört slayt |
| Akvaryum balıkları | 4 | |
| Asansör kapısı | 5 | açılır ve kapanır |
| Cam sürgülü kapılar | 4 | biri geçerken motor açar |
| Duvar saatleri | — | yalnız kadran; akrep ve yelkovanı motor çizer |
| Masa lambaları | 2 | açık ve kapalı |
| Bitkiler | 2 | isteğe bağlı, hafif sallanma |

**Işık:** gündüz/gece ışığını motor bir kaplama olarak çizer.

| Saat | Görünüm |
|---|---|
| Sabah | serin ve aydınlık |
| Öğle | nötr |
| Akşam | turuncuya çalan |
| Gece | yaklaşık %55 koyu lacivert kaplama; üstünde lambaların sıcak, ekranların camgöbeği parıltısı |

Bunun için ışık saçan her eşyanın tanımına bir `light` alanı ekle: ışığın merkezi, yarıçapı ve rengi.

Çizimlerin **gece de güzel görünmesi** önemli. Prototipte dört ışık halini bir düğmeyle değiştirip kontrol et.

---

## 8. Arayüz

Cortex'in genel arayüzü açık renkli (krem kâğıt, altın sarısı vurgular, koyu lacivert yazı). Ofis bölümü ise içinde **koyu, retro bir monitör paneli** gibi duracak, Kantan'daki gibi. Önerilen başlangıç renkleri; sen inceltebilirsin:

| Ad | Renk |
|---|---|
| zemin | `#0E1116` |
| panel | `#141820` |
| çizgi | `#262C36` |
| yazı | `#E8E6E1` |
| soluk | `#8A93A3` |
| altın vurgu | `#F2C14E` |
| canlı yeşil | `#5BD77A` |
| tehlike | `#E5604D` |

**Yazı tipi:** Google Fonts'tan, **Türkçe karakterleri tam destekleyen** bir piksel yazı tipi; örneğin Pixelify Sans, Silkscreen, VT323 ya da Tiny5. Günlük için tek aralıklı (monospace) bir piksel yazı tipi tercih edilir. Şu satırla dene: `Ğğ Şş İı Çç Öö Üü`. Hangisini seçtiğini söyle; Cortex'e dosya olarak gömülecek.

### 8.1 Yerleşim (Ofis sekmesinin tamamı, en küçük pencere yaklaşık 1000×640)

```
┌────────────────────────────────────────────────────────────┐
│ [üst bilgi]                                          [⚙]  │
│                                                            │
│                    HARİTA (canvas)                         │
│                                                            │
│                       [ipucu]          [+] [−] [⤢] [Aa]    │
├────────────────────────────────────────────────────────────┤
│ kişi çipleri (2–3 satıra sarar)                            │
├────────────────────────────────────────────────────────────┤
│ OFİS GÜNLÜĞÜ  (yaklaşık 8 satır görünür, kayar)            │
└────────────────────────────────────────────────────────────┘
```

Günlüğün yüksekliği bir tutamaçla sürüklenerek değişsin. Tam ekranda (⤢) harita bütün sekmeyi kaplar; çipler gizlenir, günlük sol altta yarı saydam küçük bir kutu olarak kalır.

### 8.2 Üst bilgi (sol üst köşe)
`● CANLI · OFİS AÇIK · 14:32`
- Yeşil nokta yavaşça nabız gibi atar.
- Saat 20:00'den sonra ve 08:00'den önce `GECE MESAİSİ` yazar.
- Piksel çerçeveli, koyu ve yarı saydam bir şerit.

### 8.3 Yakınlaştırma düğmeleri (sağ alt)
- 24×24 kareler, 1 piksel çerçeve; `+`, `−`, `⤢` (tam ekran), `Aa` (piksel yazı tipi ile okunaklı normal yazı tipi arasında geçiş).
- Her birinin ipucu (tooltip) var.

### 8.4 İpucu (alt orta)
`karaktere ya da odaya tıkla · tekerlekle yakınlaş · sürükleyerek gez`
Küçük bir hap; ilk etkileşimden ya da 8 saniyeden sonra solar.

### 8.5 Konuşma balonu (haritanın içinde)
- Kırık beyaz dolgu (`#F7F5EF`), 1 piksel koyu çerçeve, 2 piksel kaydırılmış gölge.
- Konuşanın başına doğru piksel bir kuyruk.
- Satırda en çok yaklaşık 28 karakter, en çok 3 satır; fazlası `…`.
- Balonun açılıp kapanması 2–3 karelik küçük bir büyüme.

**Durum balonları:** yazısız, içinde küçük bir piksel simge olan kare balonlar. Gerekli simgeler (12×12 piksel): çay bardağı, uyku (zzz), dosya, telefon, ünlem, ampul, kalp, kızgınlık (💢 gibi), soru işareti, onay işareti, müzik notası. Bunları `office-art.js` içinde `ICONS` olarak çiz.

### 8.6 Seçim işareti
Seçili karakterin başının üstünde, hafifçe zıplayan altın sarısı bir **aşağı ok** (piksel çizim, 2 kare). Fareyle üstüne gelinen karakterin başında küçük bir isim etiketi çıkar.

### 8.7 Karakter kartı
Karaktere tıklanınca açılır; Kantan'daki gibi sol tarafta, harita içinde. Genişliği yaklaşık 300 px; koyu zemin, 2 piksel altın çerçeve.

- **Üst etiket:** küçük harf aralıklı `CORTEX · AJAN`. Pyn için `CORTEX · PATRON`, Tekir için `CORTEX · OFİS KEDİSİ`.
- **İsim:** karakterin renginde, kalın ve büyük. Altında rolü.
- **Portre kutusu:** yaklaşık 56×80; karakter 3× büyüklükte, daha koyu bir zemin üzerinde.
- **Durum satırı:** ruh hali emojisi ve şu anki iş. Örnek: `🙂 Toprak ile «Proje planı» üzerine konuşuyor`.
- **Araç satırı** (yalnız araç ajanlarında): `Claude ile çalışır · giriş yapıldı` ve durum noktası (yeşil, sarı ya da gri; gerçek veri).
- **Hakkında:** 2–3 satır.
- **İhtiyaç çubukları:** etiket, çubuk ve sayı.

  | Çubuk | Renk |
  |---|---|
  | Çay | kehribar ya da kahve |
  | Tokluk | yeşil |
  | Enerji | mavi |

- **Alt sayaçlar** (bugün), küçük piksel simgelerle: düzenlenen not, konuşma, taşınan dosya.
- **Kapatma:** `×` düğmesi. Başka karaktere tıklanınca kart değişir; Esc kapatır.

### 8.8 Oda paneli
Odanın boş bir yerine tıklanınca açılır; sağ üstte, yaklaşık 300 px.

- **Başlık:** oda adı, büyük harf.
- **Canlı önizleme:** odanın 2× yakın görüntüsü. Motor çizer; sen bir yer ayır ve prototipte göster.
- **Durum satırı**, odaya göre:

  | Oda | Örnek durum |
  |---|---|
  | Posta odası | `Gelen kutusunda 3 yeni not` |
  | Harita odası | `214 not, 530 bağlantı` |
  | Arşiv | `Arşivde 128 makbuz` |
  | Toplantı | `Toplantı yok` ya da `Toplantı: «Yol haritası» — 4 kişi` |
  | Mutfak | `Çay demleniyor` |
  | Sunucu odası | `3 araç hazır · 1 giriş bekliyor` |

- **`İÇERİDE (n)` listesi:** renk karesi, kalın isim, ne yaptığı (satıra sarar). Boşsa: `Kimse yok`.

### 8.9 Kişi çipleri (haritanın altı)
- Her karakter için bir çip: 1 piksel çerçeveli kutu, 6×6 renk karesi, kalın isim, ruh hali emojisi, soluk renkte ne yaptığı (yaklaşık 22 karakterde kesilir).
- Seçili çipin çerçevesi altın sarısı; fareyle üstüne gelince zemin biraz açılır.
- Tıklanınca kamera o karaktere kayar ve kartı açılır.

### 8.10 Ofis günlüğü
- Başlıkta altın sarısı küçük büyük harflerle `OFİS GÜNLÜĞÜ`.
- Her satır: soluk saat (sabit genişlikli rakamlar), simge, içerik.
- **Konuşma satırı:** isim karakterin renginde, `:`, sonra açık renkli metin.
- **Olay satırları**, kendi renkleriyle:

  | Simge | Örnek satır | Renk |
  |---|---|---|
  | 📬 | `Gelen kutusuna yeni not düştü: «Başlık…»` | sarı |
  | ✅ | `Pyn onayladı: «…»` | yeşil |
  | 🧾 | `Kaan makbuzu arşive kaldırdı: «…»` | |
  | 📰 | `Yayında: «…»` | yeşil |
  | 🗣️ | `Toplantı odasında toplantı: «…» — Defne, Baran, Sena` | |
  | 💬 | `Toprak ve Asya «…» üzerine konuşuyor` | |
  | ☕ | `Hüsnü amca çay dağıtıyor` | |
  | 🔌 | `Melis: Codex'in sunucusu yeniden ayağa kalktı` | |
  | 🗑️ | `«…» çöpe atıldı` | |

- Yeni satır alttan kayarak girer.
- Kullanıcı yukarı kaydırdıysa otomatik kaydırma durur ve `↓ yeni` hapı çıkar.

### 8.11 Ayarlar (⚙)
Küçük bir açılır kutu, başlığı `Ofis ayarları`.

- **`Canlı konuşmalar`** anahtarı, **başta kapalı.** Altında açıklama:
  > Açıkken seçtiğin yapay zekâ aracı belli aralıklarla notların hakkında kısa atışmalar yazar. Not başlıkları ve son düzenlenen notlardan kısa parçalar o araca gider; biraz kota harcar.
- Açılınca görünenler:
  - `Araç` seçimi: yalnız giriş yapılmış araçlar, durum noktalarıyla.
  - `Model` seçimi.
  - `Sıklık` için parçalı düğme: `10 dk · 20 dk · 30 dk · 60 dk`.
  - `Şimdi bir tane yaz` düğmesi.
  - Durum satırı: `Son atışma 4 dk önce · Codex`.
- **`Işık gerçek saate uysun`** anahtarı, başta açık. Kapalıyken hep gündüz.

### 8.12 Boş durum
Kasa açık değilse ofis yine çalışır, ajanlar genel konularda konuşur. Haritanın üstünde ince bir şerit: `Kasa açık değil; ajanlar genel konularda konuşuyor.`

**İngilizce:** Arayüzün İngilizcesi de olacak (Cortex iki dilli). Metinleri sen Türkçe yaz; İngilizceyi Claude Code ekleyecek.

---

## 9. `office-art.js` biçimi

Cortex'teki motor bu dosyayı içeri alıp her şeyi açılışta bir kez ekran dışı tuvallere (offscreen canvas) "pişirecek". Bu yüzden:

- Bağımlılığı olmayan bir **ES modülü**.
- DOM'a dokunmaz; yalnız kendisine verilen 2D tuval bağlamına (`ctx`) çizer.
- Rastgelelik yoksa her çağrıda aynı sonucu verir. Varsa sabit tohumlu olsun.
- Yalnız `ctx.fillRect` (tam sayı koordinatlarla) ve `ctx.fillStyle` kullanır: yol, yay, gradyan, resim yok. Yazı da yok; yalnız "PYN" isimliği gibi minik piksel yazılar çizimin içinde olabilir.
- Bir sprite istersen fonksiyon yerine **satır dizisi** olarak da verilebilir (aşağıda `rows`).

```js
// office-art.js
export const TILE = 16;

/** Renk paleti: tek karakterlik anahtarlar. '.' her zaman saydam. */
export const PALETTE = { a: '#1d1b22', b: '#3a3441', /* … */ };

/**
 * Her eşya, zemin karesi ve duvar parçası.
 *  w, h       : piksel boyutu
 *  ax, ay     : çapa noktası (eşyanın yere bastığı nokta; derinlik sırası buna göre)
 *  layer      : 'floor' (halı gibi, hep altta) | 'sorted' (karakterlerle y'ye göre sıralanır)
 *               | 'wall' (duvar yüzüne asılı) | 'top' (her şeyin üstünde)
 *  solid      : [x, y, w, h], sprite içinde yürünemez alan (piksel); yoksa null
 *  frames     : kare sayısı (varsayılan 1), fps: animasyon hızı
 *  light      : { x, y, r, color } (isteğe bağlı, gece parıltısı için)
 *  paint(ctx, frame, pal) : sprite'ı (0,0)'dan başlayarak çizer
 *  ya da rows : ['..aab..', …], PALETTE anahtarlarıyla
 */
export const SPRITES = {
  floor_wood_warm_0: { w: 16, h: 16, layer: 'floor', paint(ctx) { /* … */ } },
  desk_defne:        { w: 32, h: 32, ax: 16, ay: 30, layer: 'sorted', solid: [0, 12, 32, 18], paint(ctx) { /* … */ } },
  kettle:            { w: 16, h: 16, ax: 8, ay: 15, layer: 'sorted', frames: 4, fps: 4, paint(ctx, frame) { /* … */ } },
  /* … */
};

/** Karakterler: 12 ajan + Pyn + Tekir. */
export const CHARACTERS = {
  defne: {
    name: 'Defne', role: 'Kıdemli yazar', roleEn: 'Senior writer', tool: 'claude',
    color: '#E07A5F',                       // arayüz rengi
    bio: 'Uzun ve özenli cümleler kurar…',
    look: { /* üretecin kullandığı parçalar ve renkler */ },
  },
  /* … */
};

/** Pozlar: kare sayısı, hız ve yönler. */
export const POSES = {
  idle:  { frames: 2, fps: 2, dirs: ['down', 'up', 'side'] },
  walk:  { frames: 4, fps: 8, dirs: ['down', 'up', 'side'] },
  /* carry, sit, type, phone, yawn, drink, talk, sleep */
};

/** Bir karakteri 16×32'lik hücreye (0,0)'dan çizer. 'side' sağa bakar. */
export function paintCharacter(ctx, id, pose, dir, frame) { /* … */ }

/** Her poz, yön ve kare için el ve kafa noktaları (hücre içinde piksel). */
export function anchors(id, pose, dir, frame) { return { hand: [x, y], head: [x, y] }; }

/** Taşınabilir eşyalar (dosya, zarf, koli, çay bardağı, tepsi, telefon, tablet) ve simgeler. */
export const ITEMS = { /* SPRITES ile aynı biçim */ };
export const ICONS = { /* 12×12 durum balonu simgeleri, seçim oku (2 kare) */ };

/** Harita. */
export const MAP = {
  w: 61, h: 42,
  floor: [ /* 42 satır, her biri 61 karakter; karakter → floorTiles anahtarı */ ],
  floorTiles: { w: ['floor_wood_warm_0', 'floor_wood_warm_1'], /* çeşitlilik için varyantlar */ },
  walls: [ /* 42 satır × 61: '#' başlık, 'F' duvar yüzü, 'D' kapı boşluğu, ' ' yok */ ],
  wallFaces: { /* duvar yüzü parçalarının sprite adları: düz, köşe, süpürgelik… */ },
  rooms: [
    { id: 'posta', tr: 'POSTA ODASI', en: 'MAILROOM', x: 1, y: 4, w: 14, h: 9, doors: [[7, 13], [8, 13]] },
    /* harita, arsiv, pyn, salon, mutfak, toplanti, sunucu, dinlenme */
  ],
  objects: [
    { id: 'desk_defne', sprite: 'desk_defne', x: 72, y: 340 },  // x, y: çapanın harita üzerindeki pikseli
    /* … her eşya, flip: true ile aynalanabilir */
  ],
  seats: [
    { id: 'defne', x: 5, y: 19, dir: 'down', object: 'desk_defne' },  // kare koordinatı ve oturma yönü
    /* her karakterin koltuğu, ortak masalar, toplantı sandalyeleri, kanepe… */
  ],
  spots: [
    { id: 'tea', x: 6, y: 33, dir: 'up', room: 'mutfak' },     // etkileşim noktaları
    /* buzdolabı, otomat, sebil, yazıcı, mantar pano, dosya dolabı, posta gözleri,
       asansör, her sunucu kabini, akvaryum, Tekir'in yatağı… */
  ],
  lights: [ /* tavan lambaları gibi eşyaya bağlı olmayan ışıklar */ ],
};
```

**Kurallar:**
- Her `seat` ve `spot` karesine kapılardan yürüyerek ulaşılabilmeli: `solid` alanları buna göre ver.
- Bir karakter masasında otururken masa önde, karakter arkada görünmeli; derinlik sırası için `ay` doğru olsun.
- Sunucu LED'leri ayrı sprite'lar olsun (`rack_led_claude` vb.), rengi `pal` ile değişebilsin.
- Yatay aynalamayı motor yapar; `side` pozlarını yalnız sağa bakar çiz.

---

## 10. Prototipte görmek istediklerim

- Bütün harita; tekerlekle imlecin olduğu yere yakınlaşma (1×–4×), sürükleyerek gezme, harita sınırında durma.
- Sabah, öğle, akşam ve gece ışığı arasında geçiş düğmesi.
- 5–6 karakterin basit, önceden yazılmış yollarda yürümesi, masasına oturup yazması, arada esnemesi ya da telefona bakması.
- Hüsnü amcanın tepsiyle salonda dolaşması, Tekir'in kanepede uyuması.
- Bir atışma: Defne ile Baran buluşur, birbirine döner, balonlar yaklaşık 3,5 saniyede bir sırayla çıkar, günlüğe düşer:
  > **Defne:** «Proje planı» notunu baştan okudum, üçüncü madde biraz havada kalmış.
  > **Baran:** Çalışıyorsa dokunmayalım bence.
  > **Defne:** Çalışıyor ama kimse neden çalıştığını bilmiyor, ondan korkuyorum.
  > **Baran:** Bir test yazarım, gönlün rahatlar.
  > **Defne:** Testin açıklamasını da ben yazayım o zaman, dipnotlu.
  > **Baran:** Dipnot istemez Defne. Gerçekten istemez.
- Karaktere tıklayınca kart, odaya tıklayınca oda paneli.
- Kişi çipleri, günlük, ayarlar kutusu (anahtarlar yalnız görünüş olarak çalışsın).
- Galeri.

---

## 11. Yapma

- Referans görüntülerdeki çizimleri kopyalama, üzerinden geçme ya da piksel piksel yeniden üretme.
- Dışarıdan resim dosyası kullanma; her şey `office-art.js` içinden çizilsin.
- WebGL ya da oyun motoru kullanma; düz canvas 2D yeterli.
- Sprite'ların içinde gradyan, yumuşatma ya da yarım piksel kullanma.
- Gerçek şirket logosu çizme (Anthropic, OpenAI, Google, Alibaba…). Araçlar yalnız renk şeridi ve adla ayırt edilsin.
- Haritanın içine emoji çizme; emoji yalnız arayüz metinlerinde (çipler, günlük, kart) olabilir.

---

## 12. Bitirmeden önce kontrol et

- [ ] Her odada en az 12 farklı eşya var; salonda çok daha fazla.
- [ ] 14 karakterin her biri 1× ölçekte ötekilerden ayırt edilebiliyor.
- [ ] Yürüme döngüleri akıcı; `up` ve `side` yönleri de çizili.
- [ ] Gece ışığında her şey okunuyor ve güzel görünüyor.
- [ ] Galeride her sprite ve her kare adıyla duruyor.
- [ ] Her koltuğa ve etkileşim noktasına kapılardan yürünerek ulaşılabiliyor.
- [ ] Türkçe karakterler (ğ ş ı İ ç ö ü) seçtiğin yazı tipinde doğru görünüyor.
- [ ] `office-art.js` prototipten ayrı ve 9. bölümdeki biçimde.
