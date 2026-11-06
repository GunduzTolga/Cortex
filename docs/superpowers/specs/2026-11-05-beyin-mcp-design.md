# `beyin.py mcp`: kasanın tek MCP kapısı — tasarım (taslak)
Tarih: 2026-11-05 · Dal: `mcp/tasarim` · Durum: **1. aşama uygulandı (dal `mcp/asama-1-okuma`, 1.0.57); 2. aşama (yazma) uygulandı, onay bekliyor (dal
`mcp/asama-2-yazma`, 1.0.58); açık sorular öneriyle, onay bekliyor** · Kaynak: Tolga'nın 10. adam kararı
"`beyin.py mcp` Faz 1" (2026-11-03, kasa `projects/Cortex/Tecrube.md`), Cortex-Browser ADR-0006 "Cortex bağlayıcısı: tek
hafıza, stdio üzerinden MCP" (2026-10-29), yol haritası incelemesi (kasa `projects/Cortex/yol-haritasi-inceleme-2026-11-03.md` §1)

## Amaç
Kasaya dışarıdan erişmek isteyen her istemci (Cortex Browser'ın Engine'i, Claude Code, Codex, OpenCode, Gemini CLI) aynı
kapıdan girer: `<python> <kasa>/beyin.py mcp`. Port açılmaz; istemci süreci başlatır, stdin/stdout üzerinden MCP (JSON-RPC)
konuşur, stdin kapanınca süreç biter. Bugün her yüzey kendi yolunu yazıyor (masaüstü CLI `--json`, sunucu `ingest-server`,
kancalar); bu kapı onların yerini almaz, yanına tek ve denetlenebilir bir yol ekler.

## Kararlar
Belgede öneri olarak; Tolga onaylayınca "kullanıcıyla alındı" diye işaretlenecek.

**2026-11-06, Tolga "başla" dedi; açık sorular öneriyle uygulandı, onay bekliyor:** araç adları İngilizce (`search`,
`context`); `note_create` 2. aşamada; kancalar kalır, MCP onların yanına eklenir. 1. aşamada uygulamanın netleştirdiği
üç nokta (onay bekliyor):
- **`trust: untrusted` kayıtlar dönmez.** Motorun `audience="internal"` kapısı bu kayıtları (`trust: untrusted`,
  `trusted: false`, `kind`/`status: untrusted`) hiç vermiyor; MCP bu kapıyı gevşetmedi. `untrusted: true` işareti
  kapıdan geçen ama dışarıdan gelmiş notlara konur: `untrusted: true`, `kaynak_guveni: guvenilmeyen` ve gelen kutusu
  (`📥 000-Inbox/`). Untrusted kayıtların işaretli dönmesi istenirse motorun kapısında ayrı bir karar gerekir.
- **Protokol sürümü:** desteklenen sürüm aynen döner; daha yeni bir tarih en yeni desteklenenle cevaplanır (MCP
  belirtimi bunu ister; istemci devam eder ya da "Cortex'i güncelle" der); biçimsiz ya da daha eski değer -32602.
- **Yalnız okuma, eşitleme yok:** indeks salt okunur açılır (`context --no-sync` gibi); yeni not bir sonraki
  eşitlemede görünür. Sırlar (`beyin_v3_secrets.redact`) MCP çıktısında her zaman maskelenir.
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

**2026-11-06, 2. aşama (yazma) uygulandı, onay bekliyor.** Uygulamanın netleştirdiği noktalar:
- **`capture` notu bir Yakala kartıdır** (`tur: yakala`, `durum: bekliyor`, `arac: mcp`, `uygulama: <origin>`):
  Yakala'nın klasörü, dosya adı, URL kuralı (`_safe_source_url`, ağsız) ve ön bilgi yazıcısı (`_dump`) kullanılır;
  `yakala liste`/`isle` ve masaüstü onu görür. Web Clipper kartı gibi `visibility: internal` ve metin `## Icerik`
  altında, ayrıca `untrusted: true` (gelen kutusunda olduğu için MCP onu zaten işaretli döndürürdü). `trust:
  untrusted` konmaz: motorun kapısı o notu hiç vermez, yakalanan sayfa aranamazdı. Yakala'nın `capture()`'ı
  doğrudan çağrılmadı: metinli kartı `private` yapıyor (aranamaz) ve aynı adresi var olan karta ekliyor (var olan
  notu değiştirmek). ingest-server'ın `save_capture`'ı da değil: `trust: untrusted` yazıyor ve `Yakala/` dışına.
- **Ezmeyen yazma:** dosya geçici adla yazılıp `fsync` edilir, sonra adını sabit bağla (POSIX) ya da `rename` ile
  (Windows) alır; ikisi de dolu adı reddeder (kırık bağlantı da dolu sayılır). Sabit bağ olmayan dosya sisteminde
  `open(..., 'xb')` (ingest-server'ın yolu). Ad doluysa `-2`, `-3`…
- **`capture` not kilidini almaz:** var olan hiçbir dosyaya dokunmadığı ve yeni dosyayı tek adımda açtığı için
  sıralamaya gerek yok; kilit klasörü (`.beyin-note-write/`) gelen kutusu dışına yazma olurdu. `note_create`
  motorun yolu olduğu için kilidi alır.
- **`note_create` sınırları:** motorun `note-create`'inden önce `note-edit`'in yol kuralları (`source_path`:
  ters bölü, sürücü, gizli/yönetilen/dizin dışı klasör, symlink/junction) ve `metadata` için izin listesi
  (`title`, `project`, `kind`, `status`, `tags`, `visibility`); `id` ve `supersedes` başka notun yerine geçebildiği
  için yok. Var olan yol `isError` ("zaten var"), sınır dışı yol -32602. Sonuç `status: "created"`.
- **200 KB `note_create`'e de uygulanır** (UTF-8 bayt; reddedilir, kesilmez).
- **Sırlar yazılırken de maskelenir** (kasanın `secret_filter` tercihinden bağımsız); sır taşıyan `url` reddedilir
  (motorun makbuz bağlantısı kuralı gibi). Maskeleme sayısı motorun sağlık sayacına (`secret-filter.sqlite3`) yazılır.

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
- Aynı anda iki istemci → her biri kendi süreci; `note_create` motorun not kilidiyle sıralanır (`note-edit` kilidi);
  `capture` yalnız yeni dosya açtığı için kilit gerekmez, aynı ad ikinci istemcide `-2` olur.
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
2. Yazma: `capture`, `note_create`. Uygulandı (1.0.58), onay bekliyor.
3. Masaüstünde "AI araçlarına bağla" düğmesi.
4. Browser Engine'i istemci (Cortex-Browser reposunda).

## Açık sorular
| Soru | Kim karar verir | Durum |
|---|---|---|
| Faz 1'e (GitHub ile bağlan, bitti) hemen sonra mı, yoksa ilk kurulum ölçümünden sonra mı | Tolga | Kapandı: 2026-11-06, Tolga "beyin.py mcp uygulamasına başla" |
| Claude Code için kancalar (bugünkü bağlam enjeksiyonu) kalsın mı, MCP yanına mı eklensin | Tolga | Öneriyle uygulandı (2026-11-06): ikisi birlikte; onay bekliyor |
| `note_create` ilk sürümde olsun mu (yazma riskini azaltmak için yalnız `capture`) | Tolga | Öneriyle uygulandı (2026-11-06): aşama 2'de; onay bekliyor |
| Araç adları Türkçe mi (`ara`, `yakala`) İngilizce mi | Tolga | Öneriyle uygulandı (2026-11-06): İngilizce; onay bekliyor |
