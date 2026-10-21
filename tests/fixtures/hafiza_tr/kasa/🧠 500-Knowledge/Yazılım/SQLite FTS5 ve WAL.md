---
title: SQLite — FTS5, WAL ve Türkçe
created: 2026-05-11
modified: 2026-10-08
type: bilgi
status: aktif
tags: [sqlite, fts5, veritabani, turkce]
---
# SQLite notları

## WAL modu
- `PRAGMA journal_mode=WAL;` — bir kez çalıştırınca veritabanı dosyasında kalıcı. Okuyucular yazıcıyı bloklamıyor.
- Yanına (bağlantı başına) `PRAGMA busy_timeout=5000;` ve `PRAGMA synchronous=NORMAL;`.
- `-wal` ve `-shm` dosyaları oluşur; ağ sürücüsünde (SMB/NFS) WAL kullanma.
- Checkpoint varsayılanı 1000 sayfa; uzun süren okumalar checkpoint'i bekletebilir.

## FTS5
- `CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize="unicode61 remove_diacritics 2", prefix='2 3');`
- `bm25(notes_fts, 10.0, 1.0)` → başlığa 10 kat ağırlık.
- `remove_diacritics 2` "ş"→"s", "ç"→"c" yapıyor ama "ı"yı "i"ye çevirmiyor (ı ayrı bir harf, aksanlı değil).

## Türkçe büyük/küçük harf tuzağı
- Python'da `"İSTANBUL".lower()` → `"i̇stanbul"` (i + birleştirici nokta U+0307). Eşleşme bozuluyor.
- `"I".lower()` → `"i"`, ama Türkçede `"ı"` olmalı.
- Çözüm: indekslemeden önce kendi `tr_lower()` fonksiyonumuz: önce `İ→i`, `I→ı`, sonra `lower()`.

## Bakım
- Haftada bir `PRAGMA optimize;`, ayda bir `VACUUM` (kilit alır, uygulama kapalıyken).
- Şema sürümü: `PRAGMA user_version`.
