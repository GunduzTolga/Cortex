# hafiza_tr — Türkçe hafıza değerlendirme seti

Gerçekçi bir Obsidian kasası ve bu kasaya karşı sorulmuş 60 soru. Asistanın her mesajda
bağlama doğru notları getirip getirmediğini ölçmek için var.

- `kasa/` — Tolga'nın (SoleLuna Tech, Cortex, maskot Pyn, eşi Elif, kedisi Fıstık) 77 notu:
  inbox dökümleri, 5 proje (Cortex lansmanı, Kuzey Lojistik, ev tadilatı, YL tezi, YouTube),
  bilgi notları, araçlar, 8 kişi notu, companion dosyaları (Core, Kurallar, Threads, Journal),
  kavramlar, 10 günlük, arşiv ve `🔐 Kasa/`.
- `sorular.json` — 60 soru. Her soruda `gerekli` (cevap için bağlamda **olması gereken** notlar),
  `yasak` (**gelmemesi gereken** notlar: eskimiş karar, benzer ama yanlış not, gizli not) ve
  `aciklama` var. Yollar `kasa/`'ya göreli.

## Kurallar

1. **Altın etiketler skor iyileştirmek için değiştirilmez.** Bir arama motoru bir soruda başarısızsa
   düzeltilecek şey motordur, soru ya da etiket değil. Etiket ancak kasadaki içerikle gerçekten
   çelişiyorsa (yanlış yol, yanlış bilgi) düzeltilir ve bu ayrı bir commit'te gerekçesiyle yapılır.
2. Sorular arama/sıralama kodu okunmadan, gerçek bir kullanıcının yazacağı gibi yazıldı. Yeni soru
   eklerken de motorun nasıl çalıştığına bakmadan yaz.
3. `🔐 Kasa/` klasöründeki ve `visibility: private` taşıyan notlar **hiçbir soruda** bağlama
   girmemeli; `gizli` sorularında açıkça `yasak` listesinde de yer alıyorlar.
4. Zamana bağlı sorular ("dün", "geçen cuma") için referans gün **2026-10-21 (Çarşamba)**.
5. `cevapsiz` sorularında `gerekli` boştur; doğru davranış "bilmiyorum" demektir.

## Soru türleri

| Tür | Adet | Ne ölçüyor |
|---|---|---|
| anahtar_kelime | 4 | Doğrudan terim eşleşmesi |
| cekim_eki | 5 | Notta ve soruda farklı çekimli biçimler |
| esanlamli | 5 | Eş anlamlı / başka sözcüklerle sorma |
| yazim_hatasi_ascii | 5 | Türkçe karaktersiz yazım, yazım hataları |
| ingilizce_turkce | 5 | İngilizce terimli not ↔ Türkçe soru ve tersi |
| kisi | 5 | Sadece kişi notunda olan bilgi |
| zaman | 4 | Göreli tarih, takvim soruları |
| karar_degisti | 5 | Eskimiş karar yerine güncel olanı bulma |
| benzer_konu | 4 | Aynı müşteriyle iki toplantı, aynı adlı iki kişi, iki farklı teklif |
| kural | 4 | Sadece `Kurallar.md`'de olan tercihler |
| gunluk | 4 | Sadece günlüklerde geçen bilgi |
| cevapsiz | 5 | Cevabı kasada olmayan sorular |
| gizli | 5 | Gizli / `🔐 Kasa` notlarına çarpan sorular |
| **Toplam** | **60** | |

## Yedek sorular (`sorular_yedek.json`)

Arama `sorular.json` üzerinde ayarlandıktan sonra, ne arama kodunu ne eşanlamlı sözlüğünü ne de ilk soruları görmüş biri tarafından yazılmış 40 soru. Ayarın ezber mi yoksa genel bir iyileşme mi olduğunu bu set söyler; bu yüzden ona bakarak arama ayarlanmaz. Yeni bir ayar yapılırsa onu sınamak için yine görülmemiş yeni sorular yazılır.

```sh
python3 scripts/evaluate_v3_hafiza.py                                # ayarlanan 60 soru
python3 scripts/evaluate_v3_hafiza.py --sorular sorular_yedek.json   # yedek 40 soru
python3 scripts/evaluate_v3_hafiza.py --kacanlar                     # kaçan sorular
```
