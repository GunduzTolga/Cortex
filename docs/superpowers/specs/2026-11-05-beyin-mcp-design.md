# `beyin.py mcp`: kasanın tek MCP kapısı — tasarım (taslak)
Tarih: 2026-11-05 · Dal: `mcp/tasarim` · Durum: **taslak, kararlar Tolga'ya sorulacak** · Kaynak: Tolga'nın 10. adam kararı
"`beyin.py mcp` Faz 1" (2026-11-03, kasa `projects/Cortex/Tecrube.md`), Cortex-Browser ADR-0006 "Cortex bağlayıcısı: tek
hafıza, stdio üzerinden MCP" (2026-10-29), yol haritası incelemesi (kasa `projects/Cortex/yol-haritasi-inceleme-2026-11-03.md` §1)

## Amaç
Kasaya dışarıdan erişmek isteyen her istemci (Cortex Browser'ın Engine'i, Claude Code, Codex, OpenCode, Gemini CLI) aynı
kapıdan girer: `<python> <kasa>/beyin.py mcp`. Port açılmaz; istemci süreci başlatır, stdin/stdout üzerinden MCP (JSON-RPC)
konuşur, stdin kapanınca süreç biter. Bugün her yüzey kendi yolunu yazıyor (masaüstü CLI `--json`, sunucu `ingest-server`,
kancalar); bu kapı onların yerini almaz, yanına tek ve denetlenebilir bir yol ekler.

## Kararlar
Belgede öneri olarak; Tolga onaylayınca "kullanıcıyla alındı" diye işaretlenecek.
- **Taşıma: yalnız stdio** (ADR-0006 seçenek A). HTTP/SSE yok: port, token ve DNS rebinding sorunları hiç doğmaz.
- **Yalnız standart kütüphane** (Cortex motorunun ilkesi): JSON-RPC 2.0 çerçevesi elle; dış `mcp` paketi yok.
- **Araç listesi küçük ve sabit** (ADR-0006 §3): `search`, `context` (observe), `capture`, `note_create` (act). Kasayı değiştiren
  öbür komutlar (görev, receipt, eşitleme, kurulum) bu sürümde yok; bilinmeyen araç reddedilir.
- **Gizlilik sunucuda:** her okuma `audience="internal"` ile (`retrieve`/`snapshot_context` zaten destekliyor): `visibility:
  private` notlar hiç dönmez, `trust: untrusted` kayıtlar işaretli döner. İstemcinin iyi niyetine dayanılmaz.
- **Yazma yalnız gelen kutusuna:** `capture` yalnız `📥 000-Inbox/Yakala/` altına `untrusted: true` ile yazar; `note_create` motorun
  var olan güvenli yolunu (`note-create`: üzerine yazmayı reddeder, yalnız `notes/` / `knowledge/`) kullanır. Onay istemcinin işidir
  (Browser her yazmayı kullanıcıya sorar, ADR-0006 §3); sunucu yine de sınırları uygular.
- **Ağa çıkmaz:** `capture` metni istemciden hazır alır; URL'yi yeniden indirmez (ADR-0006 §4, K-05).

## Kapsam dışı
- Uzak erişim (sunucudaki kasaya telefondan): Faz 2'nin "sunucu kapısı" ayrı iş.
- Anlamsal (vektör) arama: bugünkü sözcük tabanlı arama kalır.
- MCP "resources" ve "prompts": yalnız "tools".
- Görev/receipt/eşitleme araçları.

## Bileşenler
| Dosya / modül | Sorumluluk | Bağımlılık |
|---|---|---|
| `template/.claude/scripts/beyin_v3_mcp.py` | stdio okuma/yazma döngüsü, JSON-RPC çerçevesi, `initialize` (protokol + Cortex sürümü), `tools/list` (sabit şemalar), `tools/call` → motor çağrıları; boyut sınırları | `beyin_v3` (`retrieve`, `snapshot_context`), `beyin_v3_notes`, yakala gelen kutusu yazıcısı |
| `scripts/beyin_entry.py` | `mcp` komutu → `beyin_v3_mcp.main()` | — |
| `docs/v3/MCP.md` | kullanıcı belgesi: Claude Code / Codex / OpenCode için bağlama satırı, araçlar, gizlilik | — |
| `tests/v3_mcp_test.py` | süreç olarak başlatıp stdin/stdout üzerinden konuşan testler | — |
| Masaüstü (sonra) | Ayarlar'da "Bu kasayı AI araçlarına bağla" (Claude Code `claude mcp add` satırını yazar) | — |

## Süreçler arası sözleşme
| Mesaj | Yön | Alanlar | Not |
|---|---|---|---|
| `initialize` | istemci → mcp | `protocolVersion`, `clientInfo` → `serverInfo: {name: "cortex", version: <motor sürümü>}`, `capabilities.tools` | Desteklenmeyen protokol sürümünde hata; istemci "Cortex'i güncelle" der |
| `tools/list` | istemci → mcp | → 4 araç, sabit ad/açıklama/şema | İstemci şemaları hash'leyip sabitler (ADR-0006 §3); değişirse yeniden onay |
| `search` | çağrı | `{query, project?, limit≤20}` → `[{source, title, snippet, untrusted}]` | `audience=internal` |
| `context` | çağrı | `{query, budget_chars≤8000}` → `{text, sources[]}` | Bütçe istemcinin tavanını aşamaz |
| `capture` | çağrı | `{title, url?, text≤200 KB, origin}` → `{source}` | Yalnız Yakala gelen kutusu, `untrusted: true`, ağa çıkmaz |
| `note_create` | çağrı | `{source: notes/… ya da knowledge/…, text, metadata?}` → `{source, status}` | Üzerine yazmayı reddeder |
| stdin kapanır | istemci → mcp | — | Süreç çıkar; yarım yazma yok (atomik yazma) |

## Hata ve uç durumlar
- Kasa kurulu değil / motor eski → `initialize` hatası: "Bu kasada Cortex'in hafızası kurulu değil ya da eski; Cortex'i güncelle."
- Bilinmeyen araç → JSON-RPC hata `-32601`; şema dışı argüman → `-32602`, hangi alan olduğu yazılır (değer yazılmaz).
- `capture` metni sınırı aşıyor → reddedilir, kesilmez ("metin 200 KB'tan uzun").
- Aynı anda iki istemci → her biri kendi süreci; yazmalar motorun not kilidiyle sıralanır (`note-edit` kilidi).
- Bir satır JSON değil → hata cevabı, süreç sürer (tek bozuk mesaj oturumu düşürmez).
- Çok büyük girdi satırı (>1 MB) → okunmaz, hata.

## Test
- Birim (süreç olarak, geçici kasa): initialize + sürüm; tools/list'in şeması sabit (hash testte yazılı, değişince test düşer);
  `search` private notu döndürmez (kanarya değeri); `capture` yalnız gelen kutusuna, `untrusted: true` ile yazar; `note_create`
  var olan notun üzerine yazmaz; bozuk JSON satırı süreci düşürmez; stdin kapanınca çıkar.
- Uçtan uca: gerçek Claude Code'a `claude mcp add` ile bağla, `search` ile bir not bul (elle, Tolga'nın onayıyla).
- Windows: CI'da aynı testler (`py -3`).

## Aşamalar
1. Okuma: `search`, `context` + belge + Claude Code bağlama satırı. Kendi sürümü.
2. Yazma: `capture`, `note_create`.
3. Masaüstünde "AI araçlarına bağla" düğmesi.
4. Browser Engine'i istemci (Cortex-Browser reposunda).

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| Faz 1'e (GitHub ile bağlan, bitti) hemen sonra mı, yoksa ilk kurulum ölçümünden sonra mı | Tolga | Açık |
| Claude Code için kancalar (bugünkü bağlam enjeksiyonu) kalsın mı, MCP yanına mı eklensin | Tolga | Öneri: ikisi birlikte; kancalar otomatik bağlam, MCP isteğe bağlı arama |
| `note_create` ilk sürümde olsun mu (yazma riskini azaltmak için yalnız `capture`) | Tolga | Öneri: aşama 2'de |
| Araç adları Türkçe mi (`ara`, `yakala`) İngilizce mi | Tolga | Öneri: İngilizce (MCP istemcileri ve ADR-0006 İngilizce adlar kullanıyor) |
