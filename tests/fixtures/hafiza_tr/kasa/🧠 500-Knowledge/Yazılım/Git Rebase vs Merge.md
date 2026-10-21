---
title: Git — Rebase mi Merge mi
created: 2025-11-20
modified: 2026-07-02
type: bilgi
status: aktif
tags: [git, yazilim, ekip]
---
# Git: rebase vs merge (ekip uzlaşısı)

- Feature branch'te kendi commitlerini toparlamak için `git rebase -i` serbest (branch paylaşılmamışsa).
- main'e: **squash merge**. Tek commit, PR başlığı = commit mesajı.
- main'e force push yasak (branch protection açık).
- Paylaşılmış branch'te rebase yapma; `git pull --rebase` sadece kendi branch'inde.
- `git reflog` hayat kurtarır: yanlış reset sonrası `git reset --hard HEAD@{2}`.
- `git rerere` açık: aynı çakışmayı iki kez çözme.
