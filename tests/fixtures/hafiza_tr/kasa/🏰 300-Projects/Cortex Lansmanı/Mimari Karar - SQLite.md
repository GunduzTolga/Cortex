---
title: Mimari Karar — Yerel SQLite, merkezi veritabanı yok
created: 2026-09-15
modified: 2026-09-15
type: karar
status: aktif
proje: Cortex
supersedes: "📦 900-Archive/Veritabanı Kararı - PostgreSQL.md"
tags: [cortex, mimari, sqlite, karar, adr]
---
# ADR-007: Yerel SQLite, merkezi veritabanı yok

## Karar
Cortex'te merkezi bir sunucu veritabanı **olmayacak**. Her cihazın kendi SQLite dosyası var (FTS5 + WAL); notlar zaten Markdown olarak diskte. Haziran'da konuştuğumuz Supabase planı iptal.

## Gerekçe
- Gizlilik: "notların bilgisayarından çıkmaz" vaadi ürünün kalbi. Merkezi DB bunu sulandırıyordu.
- Maliyet: Supabase Pro $25/ay + kullanıcı başı depolama; 300 kullanıcıda bile marjı yiyordu.
- Offline: uçakta, trende çalışmalı.
- Basitlik: 2 kişilik çekirdek ekip; sunucu operasyonu = gece 3'te alarm.

## Senkronizasyon
- Cihazlar arası sync: notlar dosya olarak senkronize ediliyor (kullanıcının kendi iCloud/Dropbox/Syncthing'i). İndeks her cihazda yerelde yeniden kuruluyor.
- Çakışma: last-writer-wins + çakışan dosyanın ".conflict" kopyası. CRDT şimdilik gereksiz karmaşa.

## Sonuçları
- Web sürümü yok (en azından 2027'ye kadar).
- İndeks şeması değişirse migration her cihazda lokal çalışmalı → `PRAGMA user_version` ile sürümleme.
