---
title: Veritabanı Kararı — PostgreSQL (Supabase)
created: 2026-06-20
modified: 2026-06-20
type: karar
status: superseded
superseded_by: "🏰 300-Projects/Cortex Lansmanı/Mimari Karar - SQLite.md"
tags: [cortex, mimari, postgresql, arsiv]
---
# Veritabanı kararı: Supabase üzerinde PostgreSQL

> ARŞİV — 15 Eylül 2026'da geri alındı.

- Tüm notların metadata'sı ve embedding'leri merkezi Postgres'te (pgvector) tutulacak.
- Supabase Pro planı: $25/ay, Frankfurt bölgesi.
- Avantaj: web ve mobil istemciler aynı API'yi kullanır, sync bedavaya gelir.
- Auth: Supabase Auth (e-posta magic link).
- Ahmet Yılmaz şema taslağını çıkaracak: `notes`, `chunks`, `embeddings`, `devices`.
