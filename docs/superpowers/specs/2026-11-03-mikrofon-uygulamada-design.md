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
- Yol: önerilen yol (2026-11-03). Cortex açıkken uygulama kaydeder; kapalıyken not penceresi yardımcının kendi
  mikrofonuyla kaydeder. Sesin tamamının (not penceresi dahil) uygulamaya taşınması seçilmedi.
## Kapsam dışı
- Not penceresinin (tkinter) uygulamaya taşınması; macOS ve Linux (dinleyici yalnız Windows'ta).

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `desktop/electron/services/micCapture.ts` (yeni) | Bağlantı (Electron'suz): `akis.json`'ı okur, anahtarı söyler, `ac` sözlerine göre kaydı açar/kapar, sesi iletir; izin kararları | Node |
| `desktop/electron/services/micWindow.ts` (yeni) | Gizli kayıt penceresi (ayrı oturum `cortex-mikrofon`, yalnız ses izni), son istekten 60 sn sonra kapanır | Electron |
| `desktop/mic/preload.ts`, `desktop/mic/mic.html` (yeni) | `getUserMedia` (yankı/gürültü/kazanç kapalı) + AudioWorklet (olmazsa ScriptProcessor), 16 kHz, 480 örneklik parçalar | Chromium |
| `desktop/electron/main.ts`, `ipc.ts` | Başlat/durdur; kapanışta gizli pencere uygulamayı tutmaz; klasör seçici gizli pencereyi atlar | — |
| `beyin_v3_ses.py` (WORKER_SOURCE) | `AppFeed` (127.0.0.1 ucu, anahtar), `FeedStream`, `Recorder`'ın kaynak seçimi, `akis.json` yazma/silme | stdlib + numpy (ses ortamı) |

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| `akis.json` (`%LOCALAPPDATA%\beyin-v3`) | yardımcı → uygulama | `surum`, `pid`, `port`, `anahtar` | Yardımcı açılınca (Windows); kapanınca silinir |
| TCP 127.0.0.1, uygulama → yardımcı | | İlk satır `{"anahtar", "hz": 16000}`; sonra mesajlar: tür baytı + uzunluk (uint32 LE) + gövde. `a`: float32 16 kHz; `j`: `{"aygit"}` ya da `{"hata"}` | Bağlanınca; ses yalnız `ac` açıkken |
| TCP 127.0.0.1, yardımcı → uygulama | | JSON satırları: `{"tamam": true}`, `{"ac": true, "mikrofon": ad\|null}`, `{"ac": false}` | İlk kayıt akışı açılınca / sonuncusu kapanınca |

Anahtarı yardımcı her açılışta yeniden üretir; anahtar yalnız kullanıcının okuyabildiği `beyin-v3` klasöründeki dosyada durur; anahtarsız
bağlantı ilk satırda kapatılır (aynı makinedeki başka bir sürecin ses sokmasına karşı).

## Hata ve uç durumlar
- Uygulama izin vermedi ya da Windows mikrofon erişimini kapattı → yardımcı `sounddevice`'a döner, durum satırı bugünkü
  "mikrofon" sorununu söyler ("Windows Cortex'in mikrofonu kullanmasına izin vermiyor: Ayarlar › Gizlilik › Mikrofon.").
- Ses istendi ama 3 sn'de gelmedi, ya da uygulama `hata` dedi → yardımcı 60 sn kendi mikrofonunu kullanır (`FEED_START_SN`,
  `FEED_REST_SN`); uyandırma dinleyicisinin bugünkü takılma algısı (5 sn sessizlik) onu yeniden açtırır.
- Bağlantı koptu (uygulama çıktı, çöktü) → sonraki kayıt `sounddevice` ile; uygulama 3 sn'de bir yeniden bağlanmayı dener.
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
| Önerilen yol mu, sesin tamamı uygulamaya mı? | Kullanıcı | karar: önerilen yol (2026-11-03) |
| Windows'ta göstergede gerçekten "Cortex" görünüyor mu, dikte kalitesi aynı mı? | Kullanıcıyla elle deneme | açık |
