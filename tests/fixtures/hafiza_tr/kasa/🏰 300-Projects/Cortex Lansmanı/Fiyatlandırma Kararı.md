---
title: Fiyatlandırma Kararı (v2)
created: 2026-10-05
modified: 2026-10-07
type: karar
status: aktif
proje: Cortex
supersedes: "📦 900-Archive/Cortex Fiyatlandırma v1.md"
tags: [cortex, fiyat, karar]
---
# Cortex Fiyatlandırma — v2 (güncel)

7 Ekim lansman toplantısında onaylandı. Ağustos'taki v1 artık geçersiz.

## Planlar
- **Ücretsiz:** sınırsız not, yerel tam metin arama, 1 kasa. AI hafıza yok.
- **Pro (Türkiye):** aylık **149 TL**, yıllık **1.490 TL** (2 ay bedava gibi).
- **Pro (yurtdışı):** aylık **$6**, yıllık **$59**.
- **Öğrenci:** Pro'da %50 indirim (.edu.tr / .edu e-postasıyla doğrulama).
- **Bekleme listesindekiler:** ilk yıl %30 indirim kuponu (CORTEXERKEN).

## Ömür boyu lisans
Kaldırıldı. Sebep: her yeni model/özellik için sunucu tarafı maliyeti (embedding API, update sunucusu) sürekli; tek seferlik ödemeyle destek sürdürülemez.

## Ödeme altyapısı
- **Paddle** (merchant of record). Komisyon: işlem başına **%5 + $0,50**.
- Paddle KDV/VAT'ı kendisi topluyor; biz Paddle'a ayda tek fatura kesiyoruz.
- iyzico'yu da düşündük ama yurtdışı satışta vergi yükü bizde kalıyordu.

## Neden 149?
- Rakipler: Obsidian Sync $4–8, Mem ~$10, Reflect $10.
- Türkiye için referans: "ayda 2 kahve".
