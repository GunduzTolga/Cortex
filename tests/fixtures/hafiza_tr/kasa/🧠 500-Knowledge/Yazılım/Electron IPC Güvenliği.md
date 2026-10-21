---
title: Electron IPC Güvenliği
created: 2026-04-07
modified: 2026-10-01
type: bilgi
status: aktif
tags: [electron, guvenlik, ipc, yazilim]
---
# Electron IPC güvenliği — kontrol listesi

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — üçü de açık olmalı.
- Renderer'a Node API'si açma; preload'da `contextBridge.exposeInMainWorld('cortex', {...})` ile sadece dar bir API.
- `ipcRenderer`'ın kendisini asla expose etme.
- `ipcMain.handle` tarafında her girdiyi doğrula: dosya yolu geliyorsa kasa kökünün dışına çıkmasın (path traversal).
- CSP: `default-src 'self'`; inline script yok.
- `shell.openExternal` sadece https ve allowlist'teki alan adları.
- Auto-update: electron-updater; güncelleme sunucusu Hetzner'da, paketler imzalı.
- Code signing: Windows EV sertifikası yıllık ~420 USD (DigiCert); macOS için Apple Developer $99/yıl + notarization.
