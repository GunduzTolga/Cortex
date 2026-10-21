---
title: Kuzey Lojistik — Teknik Mimari
created: 2026-09-12
modified: 2026-10-10
type: teknik
status: aktif
musteri: Kuzey Lojistik A.Ş.
tags: [kuzey-lojistik, mimari, react-native, mobil]
---
# Teknik Mimari

- **Framework:** React Native 0.74 + Expo (SDK 51), TypeScript. Flutter'ı da tarttık; ekipte RN tecrübesi olduğu için RN.
- **Min Android sürümü:** API 26 (Android 8). Burcu Hanım'ın bahsettiği Android 9 cihazlar sorun değil.
- **Barkod:** Zebra cihazlarda DataWedge intent; telefonlarda react-native-vision-camera + ML Kit.
- **State yönetimi:** Zustand (Redux'a gerek yok, ekran sayısı az).
- **Kuyruk / yeniden deneme:** kendi basit kuyruğumuz, MMKV üzerinde. v1.1'de WatermelonDB ile tam offline.
- **API:** müşterinin .NET 6 REST API'si. Auth: OAuth2 client credentials → JWT (15 dk ömür, refresh yok, süre dolunca yeniden al).
- **Bildirimler:** Firebase Cloud Messaging (rota değişikliği bildirimi).
- **Crash reporting:** Sentry (müşterinin hesabı altında, EU region).
- **CI/CD:** GitHub Actions + EAS Build; dağıtım Google Play internal testing → production.
- **Play Store hesabı:** müşterinin kendi "Kuzey Lojistik A.Ş." developer hesabı; biz yönetici olarak ekliyiz.
