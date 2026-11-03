# Mikrofon uygulamada — tasarım
Tarih: 2026-11-03 · Dal: ses/mikrofon-uygulamada · Kaynak: 1.0.42 sürüm notundaki bilinen eksik

## Amaç
Windows'un mikrofon göstergesinde (görev çubuğu simgesi, Ayarlar › Gizlilik › Mikrofon) dinleyen uygulama "Python"
görünüyor; kullanıcı bunu tanımıyor ve güvenmiyor. Cortex açıkken mikrofonu Cortex'in kendisi tutsun, göstergede "Cortex"
yazsın. Ses yine makineden çıkmaz; yazıya çevirme (Whisper) ve uyandırma sözü (Vosk) yardımcıda kalır.

## Bugün nasıl
- Masaüstü uygulaması hiç ses kaydetmez. Mikrofonu yakala'nın sürekli çalışan dinleyicisinin (pythonw) başlattığı
  yardımcı (`isci.py`, ses sanal ortamında) `sounddevice.InputStream` ile açar (`beyin_v3_ses.py`, `Recorder.start`).
- Sürekli dinleme yalnız uygulama çalışırken ve kullanıcı izin verdiyse açıktır (`masaustu.json`, `wake_allowed`).
- Tuşla ya da simgeyle açılan not penceresi uygulama kapalıyken de çalışır ve aynı yardımcıyla kaydeder.
- Exe adını değiştirmek yetmez: Windows'ta sanal ortamın `python.exe`'si temel kurulumdaki yorumlayıcıyı alt süreç olarak
  başlatır, göstergede o görünür; sürüm kaynağını (FileDescription) değiştirmek kullanıcının Python'unu değiştirmek olur.

## Önerilen yol: uygulama kaydeder, yardımcı dinler
- Uygulama, gizli ve yalnız bu işe ayrılmış bir pencerede `getUserMedia({audio})` ile mikrofonu açar; bir AudioWorklet
  sesi 16 kHz, tek kanal, float32 bloklara çevirir; ana süreç blokları yardımcıya yerel bir bağlantıdan akıtır.
- Yardımcı sesi iki kaynaktan alabilir: uygulamanın akışı (varsa) ya da bugünkü gibi `sounddevice`. `Recorder`'ın
  kaynağı değişir, gerisi (konuşma algılama, kesme, Vosk, Whisper) aynı kalır.
- Uygulama kapalıyken açılan not penceresi bugünkü gibi `sounddevice` ile kaydeder: o kısa kayıtta göstergede yine
  "Python" görünür. Sürekli dinleme zaten yalnız uygulama açıkken olduğundan, sürekli açık mikrofon her zaman "Cortex" olur.

## Kararlar (kullanıcıyla)
- (açık) Yol: yukarıdaki önerilen yol mu, yoksa sesin tamamen uygulamaya taşınması mı (not penceresi de uygulamada)?
## Kapsam dışı
- Not penceresinin (tkinter) uygulamaya taşınması; macOS ve Linux (dinleyici yalnız Windows'ta).

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `desktop/electron/services/micCapture.ts` (yeni) | Gizli kayıt penceresi, yaşam döngüsü (izin + uygulama açık), akışı yardımcıya iletme | Electron |
| `desktop/electron/capture/` (yeni, gizli pencere) | `getUserMedia` + AudioWorklet, 16 kHz'e indirme, seviye | Chromium |
| `desktop/electron/main.ts` | İzin işleyicisi: yalnız kayıt penceresinin kendi kökenine, yalnız `media`/ses | — |
| `beyin_v3_ses.py` (WORKER_SOURCE) | Yerel dinleme ucu, `Recorder` için dış kaynak, kaynak yoksa `sounddevice`'a dönüş | stdlib |
| `masaustu.json`, `dinleyici.json` | Uygulamanın sözüne `akis: true`; yardımcının sözüne `akis_port` ve `akis_anahtar` eklenir | — |

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| `dinleyici.json` | yardımcı → uygulama | `akis_port` (127.0.0.1), `akis_anahtar` | Yardımcı hazır olunca |
| TCP 127.0.0.1 | uygulama → yardımcı | İlk satır `{"anahtar": "...", "hz": 16000}`, sonra ham float32 bloklar | Sürekli dinleme izinliyken ya da yardımcı kayıt isteyince |
| `masaustu.json` | uygulama → dinleyici | `akis: true` (uygulama kaydedebiliyor) | Her 5 sn'lik sözde |

Anahtarı yardımcı her açılışta yeniden üretir; anahtar yalnız kullanıcının okuyabildiği `beyin-v3` klasöründeki dosyada durur; anahtarsız
bağlantı ilk satırda kapatılır (aynı makinedeki başka bir sürecin ses sokmasına karşı).

## Hata ve uç durumlar
- Uygulama izin vermedi ya da Windows mikrofon erişimini kapattı → yardımcı `sounddevice`'a döner, durum satırı bugünkü
  "mikrofon" sorununu söyler ("Windows Cortex'in mikrofonu kullanmasına izin vermiyor: Ayarlar › Gizlilik › Mikrofon.").
- Akış koptu (uygulama çöktü, yeniden yüklendi) → yardımcı 2 sn içinde `sounddevice`'a döner; uygulama gelince geri geçer.
- Seçili mikrofon: ayardaki ad Chromium'un aygıt adlarıyla eşleştirilir; bulunamazsa varsayılan, durum satırında yazar.
- Chromium'un yankı/gürültü/kazanç işlemleri kapalı (`echoCancellation`, `noiseSuppression`, `autoGainControl` false):
  Whisper bugünkü ham sesi duymaya alışkın.
- Eski motor (akış ucu yok) → uygulama kaydetmez, her şey bugünkü gibi.

## Test
- Birim (Python): sahte TCP istemcisiyle anahtar, blok sırası, kopunca `sounddevice`'a dönüş; `Recorder`'ın dış kaynakla
  aynı kesmeleri üretmesi (kayıtlı bir ses dosyasından).
- Birim (masaüstü): izin işleyicisi yalnız kayıt penceresine ve yalnız sese evet der; yaşam döngüsü (izin kapanınca pencere kapanır).
- Gerçek test (Windows, elle, kullanıcıyla): göstergede "Cortex" görünüyor mu; "Hey Pyn" ve dikte eskisi kadar iyi mi.

## Aşamalar
1. Yardımcıda dış kaynak + yerel uç (Python, testleriyle); uygulama yokken davranış değişmez.
2. Masaüstünde kayıt penceresi, izin işleyicisi, akış (testleriyle).
3. Windows'ta elle deneme; sürüm notu.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| Önerilen yol mu, sesin tamamı uygulamaya mı? | Kullanıcı | açık |
