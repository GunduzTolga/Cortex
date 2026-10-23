---
name: beyin-guncelle
description: Mevcut beyin kurulumunu yeni resmi sürüme güncelle, sürümü kontrol et veya başarısız yükseltmeden geri dön. Beynimi güncelle, yeni sürüm var mı ve rollback isteklerinde kullan.
---

# Beyni güncelle

Tek güncelleme aracı vault kökündeki `beyin.py` dosyasıdır. macOS/Linux'ta `python3`, Windows'ta `py -3` kullan. Kendi curl/copy/git-pull zincirinle kullanıcı vault'unu güncelleme.

- Kullanıcı yalnız sürüm soruyorsa `python3 beyin.py update --check --metadata-only` çalıştır; kurulum yapma.
- Kullanıcı güncellemeyi istiyorsa `python3 beyin.py update` çalıştır. Bu istek rutin yerel güncelleme için yetkilendirmedir; ikinci kez izin isteme. Resmi stable sürüm varsayılandır; preview veya özel paket ancak kullanıcı onu seçtiyse kullanılır.
- Kullanıcı geri dönmek istiyorsa `python3 beyin.py rollback` çalıştır; ardından `doctor` ile sonucu doğrula.
- Başlangıç skill'lerini, adaptörleri veya başlatıcıları susturma/açma isteklerinde `python3 beyin.py preferences --exclude-component <ad>` veya `--include-component <ad>` çalıştır (ayar `.beyin-exclusions.json` dosyasına yazılır, sonraki güncelleme veya kurulumda uygulanır). Güncellemede hariç tutulan dosyalardan değiştirilmemiş olanlar temizlenir, kullanıcı tarafından değiştirilmiş olanlar korunur.

Aynı sürümün no-op olması başarıdır; `refreshed` (aynı sürümün farklı dosyaları yazıldı) ve `ahead` (kurulu sürüm yayımlanmış son sürümden ileride) da başarıdır. `ahead` bir geri alma isteği değildir; rollback çalıştırma. Hata JSON'u `"code": "vault_moved"` taşıyorsa vault taşınmış ya da kopyalanmıştır: önce `python3 beyin.py relocate`, sonra güncellemeyi yeniden dene. `updater_busy` ise birkaç saniye bekleyip bir kez yeniden dene. Başarı yalnız sürüm ve sağlık geri okumasıyla söylenir. Yarım işlem, indirme hatası, bozuk paket veya yerel dosya çakışması varsa mevcut bilgiyi koru; sürüm damgasını elle değiştirme. Konflikti zorla aşma veya kişisel notları yedekten topluca geri yazma. Yeni release yoksa ya da erişim yoksa 'güncellendi' deme.

Updater paket kaynağını, bütünlüğünü ve değiştirebileceği sistem dosyalarını denetler. Notlar, kullanıcı skill'leri ve kişisel ayarlar güncelleme metni değildir. Yeni/çeşitli hook tanımı güven incelemesi gerektirirse bunu istemciye uygun şekilde açıkla; güven kaydı uydurma. Gerekli yeniden başlatmayı ve varsa tek kullanıcı adımını söyle.

Sonuç mesajında önceki→yeni sürümü, doğrulama sonucunu ve varsa açık kalan adımı belirt. Token, yerel kullanıcı yolu, kişisel ayar dökümü veya ham log paylaşma.

`--metadata-only` tanınmıyorsa mevcut `update --check` komutuna dön. Sürüm bildirimi varsayılan açık, günlük GitHub metadata kontrolüdür; not göndermez. Kapat/aç talebini `preferences --update-notifications off/on` ile uygula. Tek sürümü susturmak için `update --dismiss X.Y.Z` kullan. Metadata-only sonucu paketin kurulabilirlik kanıtı değildir.
