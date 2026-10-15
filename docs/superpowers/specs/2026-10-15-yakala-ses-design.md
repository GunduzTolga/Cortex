# Yakala'da sesle yazma: tasarım

Tarih: 15 Ekim 2026 · Dal: `masaustu-pyn` · Kaynak: kullanıcının kendi VoiceTyping notu (faster-whisper, sounddevice, sesli komutlar)

## Amaç

Ctrl+Alt+B ile açılan yakala penceresine ("Beyne at") sesle yazma. İsteğe bağlı olarak "Pyn, not al" deyince pencere açılıyor ve dinlemeye başlıyor. Ses hiçbir yere gitmiyor; çeviri yerelde yapılıyor.

## Kararlar

- **Önce yakala.** Söylenen, yakala'nın metin kutusuna yazılıyor ve oradan kasanın gelen kutusuna kart olarak gidiyor. Başka pencerelere klavye taklidiyle yazmak (VoiceTyping'in yaptığı) kapsam dışı. Pyn sohbetine mikrofon sonraki adım.
- **Uyandırma sözü "Pyn, not al".** Başta kapalı, ayarla açılıyor. Açıkken mikrofon sürekli dinliyor.
- **İki motor:**
  - **Yazma:** Whisper (faster-whisper). Önce NVIDIA ekran kartını dener, yoksa işlemciye geçer. Bu makinede (Ryzen 9 7900, Radeon RX 7800 XT) işlemcide çalışır; whisper.cpp'nin hazır Windows Vulkan derlemesi yok.
  - **Uyandırma:** küçük Türkçe Vosk modeli (yaklaşık 40 MB), yalnız o sözü yakalamak için. Whisper'ı sürekli çalıştırmak işlemciyi yorardı.
- **Motorun standart kütüphane kuralı korunuyor.** Ses ayrı bir sanal ortamda, ayrı bir yardımcı süreçte çalışıyor; yakala onunla satır satır JSON konuşuyor. Kurulum isteğe bağlı: `beyin.py ses kur`.
- **Kurulan her şey durum klasöründe:** sanal ortam, Whisper modeli (Hugging Face önbelleği) ve Vosk modeli `state/ses/` altında. Kasaya ve senkrona hiçbir şey girmiyor.

## Birimler

| Dosya | Ne yapar | Bağımlılık |
|---|---|---|
| `template/.claude/scripts/beyin_v3_ses.py` | Kurulum planı ve kurulum, ayar, durum, kaldırma; sesli komut ve uyandırma sözü eşleme (Türkçe harf katlama, bulanık eşleme); yardımcı süreç istemcisi (`Isci`); `ses` komut satırı. | Yalnız standart kütüphane |
| `template/.claude/scripts/beyin_v3_ses_isci.py` | Sanal ortamda çalışan yardımcı süreç: modeli yükler, kaydeder, sessizlikte durur, yazıya çevirir, uyandırma sözünü dinler. stdin'den komut alır, stdout'a olay yazar. | faster-whisper, sounddevice, numpy, vosk |
| `beyin_v3_yakala.py` | Dinleyici kuruluysa yardımcı süreci başlatıyor ve olaylarını açık pencereye iletiyor. Pencerede mikrofon düğmesi var; pencere açıkken Ctrl+Alt+B'ye yeniden basmak dinlemeyi başlatıp durduruyor; "Pyn, not al" pencereyi dinler halde açıyor. | `beyin_v3_ses` |

### Yardımcı sürecin sözleşmesi

| Yön | İleti | Anlamı |
|---|---|---|
| Komut | `dinle`, `bitir`, `iptal`, `uyandirma` (açık/kapalı), `kapat` | |
| Olay | `yukleniyor`, `hazir` (model ve açıklaması) | Model durumu |
| Olay | `dinliyor`, `seviye` (0–1, saniyede 10 kez) | Kayıt sürüyor |
| Olay | `ceviriyor`, `metin` (metin ve komut) | Sonuç |
| Olay | `uyandi` | Söz duyuldu, kayıt başladı |
| Olay | `hata` | Bir sorun oldu |

### Kayıt nasıl biter
- Konuşmadan sonra 1,4 saniye sessizlik.
- Sonda "kaydet" deyip susmak: metin yazılır ve kart kaydedilir.
- Düğmeye ya da Ctrl+Alt+B'ye yeniden basmak.
- En uzun 120 saniye.

### Sesli komutlar
| Komut | Ne yapar |
|---|---|
| Sonda "kaydet" | Yazar ve kaydeder |
| Yalnız "sil" | Kutuyu temizler |
| Yalnız "iptal" ya da "vazgeç" | Pencereyi kapatır |

Bir komut yalnız sonda ya da tek başına söylenince sayılıyor; "notu kaydettim" komut değil.

## Hata ve uç durumlar

- **Ses kurulu değilse:** pencere bugünkü gibi; düğme yok.
- **Yardımcı süreç ölürse ya da model yüklenemezse:** düğme gri, durum satırı sebebi söylüyor; yazmak elle sürüyor.
- **Mikrofon açılamazsa:** kısa bir hata. Windows'ta masaüstü uygulamalarının mikrofona erişimi kapalıysa durum satırı bunu söylüyor.
- **Uyandırma açık ve kayıt sürerken:** Vosk duruyor, mikrofonu Whisper kaydı tutuyor.

## Test

- **Birim:**
  - komut ve uyandırma eşleme ("Pyn, not al", "pin not al", "kaydet", "notu kaydettim");
  - kurulum planı (Python seçimi, NVIDIA varsa ek paketler, yollar);
  - istemcinin sahte bir yardımcı süreçle konuşması;
  - metnin yakala kutusuna uygulanması.
- **Gerçek:** `beyin.py ses dene` beş saniye kaydedip yazıya çeviriyor. Bu, kullanıcının onayıyla kurulumdan sonra yapılacak (yaklaşık 2 GB indirme).
