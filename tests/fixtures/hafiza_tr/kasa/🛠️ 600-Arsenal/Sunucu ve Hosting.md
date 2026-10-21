---
title: Sunucu ve Hosting
created: 2025-10-02
modified: 2026-09-12
type: arac
status: aktif
tags: [sunucu, hosting, altyapi]
---
# Sunucu ve hosting

- **Hetzner CX22** (2 vCPU, 4 GB RAM), Falkenstein — **aylık €4,51** (KDV hariç)
  - landing page (cortex.soleluna.tech), Cortex update sunucusu, Plausible analytics
- DNS: Cloudflare (ücretsiz plan)
- Alan adı: soleluna.tech — Namecheap, yenileme **14 Mart**, yıllık ~$45
- E-posta: Google Workspace, 2 kullanıcı
- Yedekler: restic → Backblaze B2, her gece 03:00, 30 gün saklama. Aylık ~$1,2
- Uptime: Uptime Kuma (aynı sunucuda — evet, ideal değil)
- SSH: sadece anahtar; port 2222, fail2ban açık
