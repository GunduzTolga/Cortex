---
title: Local-first yazılım
created: 2026-06-25
modified: 2026-09-15
type: kavram
status: aktif
tags: [kavram, local-first, mimari]
---
# Local-first yazılım

**Tanım:** Verinin birincil kopyasının kullanıcının cihazında durduğu, bulutun sadece senkronizasyon/yedek için kullanıldığı yazılım yaklaşımı. Kaynak: Kleppmann, Wiggins, van Hardenberg, McGranaghan — "Local-first software" (Ink & Switch, 2019).

## 7 ideal
1. Hızlı: spinner yok, işlem yerelde.
2. Çoklu cihaz.
3. Offline çalışır.
4. İşbirliği (collaboration).
5. Uzun ömür: şirket batsa da veri okunur.
6. Gizlilik ve güvenlik.
7. Kullanıcı sahipliği ve kontrolü.

## Cortex'teki karşılığı
- 1, 3, 5, 6, 7: var (Markdown dosyaları + yerel SQLite).
- 2: kullanıcının kendi dosya senkronizasyonuyla.
- 4: yok, bilinçli olarak kapsam dışı.

İlgili: [[Mimari Karar - SQLite]]
