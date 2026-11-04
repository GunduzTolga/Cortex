# Masaüstü cila: koyu mod, oturum maliyeti, sohbete ek — tasarım
Tarih: 2026-11-04 · Dal: `masaustu/cila-notlar` · Kaynak: geliştiricinin 2 Kasım el notları (1-4. maddeler)

## Amaç
Masaüstü Cortex'te üç eksik kapanır: uygulama koyu temada da kullanılabilir; soldaki sohbet listesinde her oturumun ne
kadar tuttuğu görünür; sohbete resim ve dosya eklenebilir. Notların 4. maddesi (Beyin sekmesinin alt yazıları) ekran
görüntüsü gelince bu belgeye eklenir. 5-7. maddeler yol haritasına yazıldı (PR #43).

## Kararlar (kullanıcıyla alındı, 2026-11-04)
- **Koyu mod:** Ayarlar › Genel › Tema: Açık / Koyu / Sistem. Varsayılan Sistem (Windows koyuysa uygulama da koyu).
- **Maliyet:** sol listede oturum başına API liste fiyatıyla dolar karşılığı ve jeton. Abonelikle çalışan araçta
  (Claude Code, Codex) "abonelikte ödediğin değil, API fiyatıyla karşılığı" diye işaretli. Dolar bildirmeyen araçta
  yalnız jeton.
- **Ek:** önce Claude Code ve Codex; resim ve dosya. Ek almayan araçta düğme soluk durur, üstüne gelince "Bu araç ek
  almıyor" der.
- **Görsel doğrulama:** sunucuda Playwright Chromium ile her ekran açık ve koyu temada görüntülenir.

## Kapsam dışı
- Yerel model, OpenCode/Gemini/Qwen (ACP) ve sunucudaki Pyn için ek (sonraki adım; ACP'nin resim yeteneği bildirimi var).
- Ofis ekranının piksel sahnesi koyulaşmaz (kendi sahnesi; çerçevesi ve paneli koyulaşır).
- Fiyat tablosu tutmak: dolar yalnız aracın kendi bildirdiği değerden gelir (Claude Code `total_cost_usd`, ACP `cost`).
  Codex dolar bildirmez, onda yalnız jeton.
- Ekleri kasaya yazmak: ekler cihazda kalır (yol haritası kararı).

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `electron/services/settings.ts` | `theme: 'system' \| 'light' \| 'dark'` (varsayılan `system`) | — |
| `electron/main.ts` | açılışta ve ayar değişince `nativeTheme.themeSource = theme` | Electron `nativeTheme` |
| `src/index.css` | koyu palet: `@media (prefers-color-scheme: dark)` altında aynı değişkenler | Tailwind v4 tema değişkenleri |
| `src/ui/SettingsDialog.tsx` | Tema seçici (Açık / Koyu / Sistem) | — |
| `src/notes/GraphView.tsx`, `GraphGuide.tsx` | tuvalde sabit renkler CSS değişkeninden okunur | — |
| `shared/chat.ts` | `spend` olayı; `ChatSummary.spend` | — |
| `electron/services/claudeChat.ts`, `codexChat.ts`, `acpChat.ts` | tur başına harcamayı bildirir | — |
| `electron/services/chat.ts` | oturum toplamını tutar, listede gösterir | — |
| `src/chat/SidePane.tsx` | satırda küçük harcama etiketi | — |
| `src/chat/Composer.tsx` | ek düğmesi, sürükle-bırak, yapıştır; ek çipleri | — |
| `electron/services/chat.ts` + motorlar | eki motora verir (Claude: içerik bloğu; Codex: `localImage` / dosya yolu) | — |

## Süreçler arası sözleşme
| Mesaj / kanal | Yön | Alanlar | Ne zaman |
|---|---|---|---|
| `settings:set` | pencere → ana | `{ theme }` | Tema seçilince |
| ChatEvent `spend` | ana → pencere | `{ usd: number \| null; input: number; output: number; subscription: boolean }` | Her tur sonunda |
| `ChatSummary.spend` | ana → pencere | `{ usd: number \| null; tokens: number; subscription: boolean }` | Liste ve push |
| `chat:send` | pencere → ana | `attachments: Array<{ path: string; name: string; kind: 'image' \| 'file' }>` | Mesaj gönderilince |

## Hata ve uç durumlar
- Tema ayarı bozuk/eksik → `system`.
- Araç dolar bildirmez → yalnız jeton ("12,4 B jeton"); hiçbir şey bildirmez → etiket yok.
- Claude Code'un `total_cost_usd`'si süreç boyunca birikimliyse fark alınır; süreç yeniden açılınca sıfırdan sayılır.
- Ek 20 MB'tan büyük → "Bu dosya çok büyük (en çok 20 MB)." Resim türü desteklenmiyor → dosya olarak eklenir.
- Ek almayan araçta ekli mesaj gönderilmeye çalışılırsa → gönderim durmaz, "Bu araç ek almıyor; ek gönderilmedi." uyarısı.
- Ek dosya silinmiş/taşınmışsa → "Ek bulunamadı: <ad>".

## Test
- Birim: tema ayarının okunması/varsayılanı; `spend` toplamı (birikimli ve tur başına bildirim); ek doğrulaması
  (boyut, tür, araç desteği); Claude/Codex mesaj gövdesine ekin girişi (sahte CLI ile).
- Görsel: Playwright Chromium ile pencere sayfası sahte köprüyle (`electron-stub`) açılır; Notlar, Sohbet, Ayarlar,
  Ofis, ilk kurulum açık ve koyu temada görüntülenir; görüntüler geliştiriciye gönderilir.
- Gerçek test (geliştiricinin PC'si): deneme sürümünde Windows koyu temasıyla açılış, Claude'a resim ekleme.

## Aşamalar
1. Koyu mod (ayar + palet + sabit renkler + görüntüler).
2. Oturum maliyeti (olay + toplam + liste etiketi).
3. Sohbete ek (Claude, Codex).
4. 4. madde (Beyin alt yazıları), ekran görüntüsü gelince.

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| 4. madde: Beyin sekmesinde hangi alt yazı yanlış | Geliştirici | Ekran görüntüsü bekleniyor |
| Claude Code `total_cost_usd` birikimli mi tur başına mı | Ölçüm | 2. aşamada sahte değil gerçek CLI ile denenecek |
