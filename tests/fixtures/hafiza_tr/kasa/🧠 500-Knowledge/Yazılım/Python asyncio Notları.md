---
title: Python asyncio Notları
created: 2026-03-02
modified: 2026-09-30
type: bilgi
status: aktif
tags: [python, asyncio, yazilim]
---
# asyncio notları

## gather vs TaskGroup
- Python 3.11+ ise **`asyncio.TaskGroup` tercih et.** Bir görev patlarsa diğerlerini iptal ediyor, hatalar `ExceptionGroup` olarak geliyor.
- `asyncio.gather(..., return_exceptions=True)` hâlâ işe yarar: "hepsi bitsin, hataları sonra toplarım" durumunda.
- gather'da bir görev hata verince diğerleri **iptal edilmiyor**, arka planda çalışmaya devam ediyor — Cortex sidecar'da bu yüzden yetim görevler kaldı.

## Bloklayan kod
- sqlite3 ve embedding hesabı bloklayıcı → `await asyncio.to_thread(fn, *args)`.
- CPU ağırsa (embedding batch) `ProcessPoolExecutor` + `loop.run_in_executor`.
- Cortex sidecar'da event loop 2 sn donuyordu; embedding'i thread pool'a alınca düzeldi.

## Timeout
- 3.11+: `async with asyncio.timeout(5):` — `wait_for`'dan daha temiz.

## Hatırlatma
- `asyncio.run()` sadece en dışta, bir kez.
- Jupyter'de zaten çalışan bir loop var → doğrudan `await`.
