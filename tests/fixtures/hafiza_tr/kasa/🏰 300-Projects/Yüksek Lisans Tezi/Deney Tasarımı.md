---
title: Deney Tasarımı
created: 2026-06-10
modified: 2026-10-16
type: plan
status: taslak
proje: Tez
tags: [tez, deney, degerlendirme]
---
# Deney Tasarımı

- **Korpus:** 3 kasa (benim kasam anonimleştirilmiş + 2 gönüllü), toplam ~9.000 not
- **Soru seti:** şu an 60 soru; genişletilecek. Tür etiketleri: anahtar kelime, eş anlamlı, çekim eki, zaman, kişi...
- **Altın etiketler önceden yazılır**, sistem çıktısına bakılarak değiştirilmez.
- **Baseline'lar:** BM25 (ham), BM25 + Zemberek kök, BM25 + 5 karakter kesme, BGE-M3 dense, hibrit RRF
- **Donanım:** M2 MacBook Air; embedding'ler önceden hesaplanıp diske yazılıyor.
- Zemberek Java 17 istiyor → Docker imajı içinde çalıştırıyorum.
