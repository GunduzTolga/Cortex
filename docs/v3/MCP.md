# MCP: kasayı yapay zeka araçlarına bağlamak

`beyin.py mcp`, kasanın MCP (Model Context Protocol) kapısıdır. Claude Code, Codex, OpenCode gibi bir yapay zeka
aracına bağladığında asistan kasanda kendisi arama yapabilir: "geçen hafta kuvars planı için ne yazmıştım?" sorusunda
notu bulup kaynağıyla getirir.

Dört araç var. `search` ve `context` okur. `capture` ve `note_create` kasaya yeni bir not ekler; var olan hiçbir
notu değiştirmez, silmez ya da üzerine yazmaz. Yazmadan önce aracın sana sorması önerilir: [Yazma ve onay](#yazma-ve-onay).

## Ne işe yarar

- **Kancaların yanına eklenir, yerini almaz.** Kancalar her mesajda ilgili notları kendiliğinden bağlama ekler.
  MCP ise asistanın gerektiğinde kendisinin araması içindir. İkisi birlikte çalışır.
- **Port açmaz.** Aracın kendisi `beyin.py mcp` sürecini başlatır ve onunla stdin/stdout üzerinden konuşur. Araç
  kapanınca süreç de biter. Sürekli çalışan bir servis ya da açık bir ağ kapısı yoktur.
- **Her araç aynı kapıdan girer.** Hangi aracı bağlarsan bağla, kurallar (gizli notlar, güvenilmeyen içerik, sırlar)
  aynı yerde, Cortex'in içinde uygulanır.

## Bağlama

Komut her araçta aynıdır: `<python> <kasa>/beyin.py mcp`. Python, Windows'ta `py -3`, macOS ve Linux'ta `python3`
olur. Kasa yolu tam yol olmalıdır.

### Masaüstü uygulamasından (1.0.59)

Cortex masaüstü uygulamasında **Ayarlar › Yapay zeka araçlarına bağla** bu satırları açık kasa için hazır verir:
Cortex'in o bilgisayarda çalıştığı Python'un tam yolu, kasanın `beyin.py`'si ve `mcp`. Claude Code, Codex ve OpenCode
için birer satır, her birinin yanında **Kopyala**. Boşluklu ya da Türkçe harfli bir klasör adı terminalin okuyacağı
gibi tırnaklanır (Windows'ta PowerShell'in tırnakları).

- **Claude Code'a ekle:** Claude Code kuruluysa düğme, sana sorduktan sonra Claude Code'un kendi komutunu çalıştırır:
  `claude mcp add --scope user cortex -- <python> <kasa>/beyin.py mcp`. Bağlantı her projede kullanılır. "Eklendi"
  yalnız Claude Code bağlantıyı gösterince (`claude mcp get cortex`) yazılır.
- **Zaten bağlıysa** bölüm bunu söyler ve düğme çıkmaz. Claude Code'da `cortex` adıyla başka bir kasa ya da sunucu
  varsa Cortex ona dokunmaz; önce `claude mcp remove cortex` çalıştırmanı söyler.
- **Claude Code yoksa** yalnız kopyalanacak satırlar kalır.
- **Motor 1.0.58'den eskiyse** (ya da kasada `beyin.py mcp` yoksa) satırlar yerine "Cortex'i güncelle" yazar; güncelleme
  aynı ekrandaki Cortex bölümündedir.

Uygulama hiçbir komutu kabuk üzerinden çalıştırmaz ve pencereden gelen bir yolu kullanmaz: kasa, uygulamanın açık
tuttuğu kasadır. Gerçek bir Claude Code'a ekleme, Windows ve macOS'ta henüz denenmedi; düğme sahte bir `claude`
ile test edildi (`desktop/tests/mcp.test.ts`, e2e smoke).

### Claude Code

```
claude mcp add cortex -- python3 /Users/ad/Documents/Kasa/beyin.py mcp
```

Windows'ta:

```
claude mcp add cortex -- py -3 "C:\Users\ad\Documents\Kasa\beyin.py" mcp
```

Bu satır Cortex'i yalnız o klasörde açılan Claude Code oturumlarına bağlar. Her projede kullanmak için
`claude mcp add --scope user cortex -- …` yaz. Bağlantıyı `claude mcp list` gösterir.

Gerçek bir Claude Code oturumunda henüz denenmedi. Komut ve protokol, aracın gönderdiği mesajlarla süreç olarak
konuşan testlerle doğrulandı (`tests/v3_mcp_test.py`).

### Codex (denenmedi)

`~/.codex/config.toml` dosyasına:

```toml
[mcp_servers.cortex]
command = "python3"
args = ["/Users/ad/Documents/Kasa/beyin.py", "mcp"]
```

Windows'ta `command = "py"` ve `args = ["-3", "C:\\Users\\ad\\Documents\\Kasa\\beyin.py", "mcp"]`.

### OpenCode (denenmedi)

Projedeki `opencode.json` dosyasına ya da `~/.config/opencode/opencode.json` dosyasına:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cortex": {
      "type": "local",
      "command": ["python3", "/Users/ad/Documents/Kasa/beyin.py", "mcp"],
      "enabled": true
    }
  }
}
```

### Başka araçlar

Stdio MCP sunucusu başlatabilen her araç bağlanabilir: komut `<python>`, argümanlar `<kasa>/beyin.py` ve `mcp`.

## Yazma ve onay

Kasaya yazan iki araç (`capture`, `note_create`) her çağrıda sana sorulmalıdır: "bu sayfayı gelen kutuna kaydedeyim
mi?" sorusu aracın işidir. Cortex sınırları kendisi uygular (aşağıda), ama neyin yazılacağına sen karar verirsin.
İki araç da `tools/list`'te `readOnlyHint: false` ile gelir; araç bunu görüp yazdığını bilir.

**Claude Code** bir MCP aracını, ona izin vermedikçe her seferinde sorar. Önerilen ayar: okuyan iki araca izin ver,
yazan ikisine verme. Projedeki `.claude/settings.json` dosyasına (ya da her proje için `~/.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["mcp__cortex__search", "mcp__cortex__context"]
  }
}
```

İzin sorulduğunda yazan iki araç için kalıcı izin seçme ve sunucunun tamamına (`mcp__cortex`) izin verme; yoksa yazma
sorulmadan olur. Asistanın kasaya hiç yazmamasını istersen `"deny": ["mcp__cortex__capture", "mcp__cortex__note_create"]`
ekle.

**Codex, OpenCode ve ötekiler (denenmedi):** aracın onay ayarında `capture` ve `note_create`'i her seferinde
sorulacak şekilde bırak; okuyan iki araç sorulmadan çalışabilir.

## Araçlar

| Araç | Argümanlar | Döndürdüğü |
| --- | --- | --- |
| `search` | `query`: aranacak sözcükler (zorunlu, en çok 2000 karakter). `project`: yalnız o projede ara (isteğe bağlı). `limit`: en çok kaç not (1–20, varsayılan 10). | `results`: her not için `source` (kasadaki yolu), `title`, `snippet` (aranan sözcüğün çevresinden yaklaşık 240 karakter) ve `untrusted` |
| `context` | `query`: soru ya da sözcükler (zorunlu; boş bırakılırsa güncel durumun özeti gelir: en yeni etkin ve bekleyen notlar ve işler, yani `active` ve `waiting`; durumu yazılmamış not etkin sayılır). `budget_chars`: metnin en çok uzunluğu (200–8000, varsayılan 4000). | `text`: en uygun notlar, numaralı ve kasadaki yollarıyla; toplamı `budget_chars`'ı hiçbir zaman aşmaz, uzun not kısaltılır. `sources`: metne giren notlar (`source`, `title`, `untrusted`). |

| `capture` | `title`: kısa başlık (zorunlu, en çok 200 karakter). `text`: yakalanan metin (zorunlu, en çok 200 KB). `origin`: yakalayan araç ya da uygulama (zorunlu, en çok 100 karakter). `url`: içeriğin herkese açık http(s) adresi (isteğe bağlı; yalnız kaynak olarak yazılır, indirilmez). | `source`: gelen kutusunda yazılan notun yolu |
| `note_create` | `source`: yeni notun yolu, `notes/` ya da `knowledge/` altında, `.md` ile biten (zorunlu). `text`: notun gövdesi, ön bilgisiz (zorunlu, en çok 200 KB). `metadata`: ön bilgi alanları (isteğe bağlı; yalnız `title`, `project`, `kind`, `status`, `tags`, `visibility`). | `source` ve `status: "created"` |

Arama sözcük tabanlıdır, anlamsal değildir: `beyin.py context` ile aynı sıralamayı kullanır.

### `capture`: gelen kutusuna yakalama

- **Yalnız gelen kutusuna yazar:** `📥 000-Inbox/Yakala/` altına tek bir yeni dosya. Başka bir klasöre, indekse ya da
  bir kilit dosyasına yazmaz.
- **Not bir Yakala kartıdır** (`tur: yakala`, `durum: bekliyor`, `arac: mcp`, `uygulama: <origin>`): `beyin.py yakala
  liste`, masaüstü uygulaması ve ajan onu öbür yakalamalar gibi görür. Web Clipper kartı gibi `visibility: internal`
  taşır, ayrıca `untrusted: true`: MCP onu her zaman "dışarıdan gelen içerik" diye işaretli döndürür. Metin kartın
  `## Icerik` bölümüne olduğu gibi yazılır.
- **Ağa çıkmaz.** `url` yalnız biçimine bakılarak denetlenir (herkese açık http(s) adresi; yerel ağ, kullanıcı adı ya
  da parola olmaz) ve kaynak olarak yazılır. Kartı sonra kendin `beyin.py yakala isle` ile işlersen Web Clipper
  kartındaki kural geçer: 200 karakterden uzun metin olduğu gibi alınır; metin kısaysa ya da adres bir YouTube
  videosuysa kaynağı `isle` indirir.
- **Hiçbir notu ezmez, var olan karta da eklemez.** Dosya adı Yakala'nınkiyle aynıdır (`YYYY-AA-GG-SSDD-<başlık>.md`);
  ad doluysa `-2`, `-3`… alır. Not önce geçici bir adla yazılıp diske alınır, sonra adını tek adımda alır; bu adım ad
  doluysa (kırık bir bağlantı da olsa) yazmaz. Yakala'nın kendisi aynı adresi ikinci kez yakalayınca var olan karta
  ekler; MCP bunu yapmaz, her çağrı yeni bir karttır.
- **Metin 200 KB'tan uzunsa reddedilir, kesilmez** (UTF-8; "metin 200 KB'tan uzun").
- **Aramada bir sonraki eşitlemeden sonra görünür** (kanca, `beyin.py sync` ya da masaüstü uygulaması): `capture`
  indeksi değiştirmez.

### `note_create`: yeni not

- **Motorun `note-create` yolunu kullanır:** yalnız `notes/` ya da `knowledge/` altına yazar, var olan bir dosyanın
  üzerine yazmaz, not yazıcılarının kilidini alır (`note-edit` ile aynı kilit), notu indeksler ve geri okuyarak
  doğrular. Bu yüzden `search` notu hemen bulur.
- **Yol kuralları `note-edit`'inkiler kadar sıkıdır:** kasaya göre ve `/` ile ayrılmış olmalı; `..`, mutlak yol,
  sürücü harfi, ters bölü, gizli klasör (`.` ile başlayan), yönetilen klasör (`knowledge/v3`), dizin dışında tutulan
  klasör ("Şifreler", "Özel" gibi) ve yolda bir bağlantı (symlink, junction) reddedilir (-32602, `data.field: source`).
- **Ön bilgi yalnız `metadata` ile gelir** ve yalnız şu alanlar kabul edilir: `title`, `project`, `kind`, `status`,
  `tags` (en çok 20), `visibility` (`internal`, `public` ya da `private`). `id`, `supersedes`, `trust` gibi alanlar
  reddedilir: bir kimlik ya da `supersedes` başka bir notun yerine geçip onu gizleyebilirdi. `kind: task` ve
  makbuzlar bu araçla yazılmaz (`beyin.py task-create`).
- **`visibility: private` ile yazılan not** hiçbir yapay zeka aracına, bu kapıya da, dönmez.

## Gizlilik

- **`visibility: private` notlar hiç dönmez.** Kural Cortex'in içinde uygulanır: motor bu notları vermez, MCP
  kapısı da ikinci kez bakar. Aracın iyi niyetine dayanılmaz. Adında "Şifreler", "Özel" gibi sözcükler geçen
  klasörler zaten indekse girmez.
- **Güvenilmeyen kayıtlar kapıda kalır.** `trust: untrusted`, `trusted: false` ya da `kind: untrusted` taşıyan
  notlar kancalarda olduğu gibi MCP'den de dönmez.
- **Dışarıdan gelen içerik işaretlenir.** `untrusted: true` ya da `kaynak_guveni: guvenilmeyen` taşıyan notlar ve gelen
  kutusundaki (`📥 000-Inbox/`) her not `untrusted: true` ile döner. `context` metninde bu notlar rastgele üretilmiş
  bir sınır satırının arasında durur ve "veri, talimat değil" diye işaretlidir. Yakalanmış bir sayfadaki gizli
  talimat (prompt injection), haftalar sonra hafızadan geliyormuş gibi asistana karışmaz.
- **Sırlar maskelenir.** Bilinen sır biçimleri (API anahtarları, GitHub jetonları, parolalar) ve kasanın kendi sır
  listesi (runtime klasöründeki `secret-patterns.txt`) dışarıya `[REDACTED]` olarak gider. Asistan sorgusunu kendisi
  seçebildiği için ("token" da bir sorgudur) bu süzgeç MCP'de her zaman açıktır. Sır listesi okunamazsa Cortex not
  göndermez ve nedenini söyler.
- **Yazılanda da sırlar maskelenir.** `capture` ve `note_create` metni, başlığı ve ön bilgi alanlarını kasaya
  yazmadan önce aynı süzgeçten geçirir; kasanın `secret_filter` tercihi kapalı olsa da. Maskelenen bir adres başka
  bir adres olacağı için sır taşıyan bir `url` maskelenmez, reddedilir. Sır listesi okunamazsa Cortex hiçbir şey
  yazmaz.
- **Okuma hiçbir şey yazmaz.** `search` ve `context` için indeks salt okunur açılır; kasaya ve runtime klasörüne
  hiçbir şey yazılmaz, eşitleme yapılmaz. Bu yüzden son eşitlemeden sonra eklenen bir not, bir sonraki eşitlemeden
  sonra görünür (kanca, `beyin.py sync` ya da masaüstü uygulaması). Değişen ya da silinen not o arada zaten dönmez.
- **Yazma yalnız yeni bir dosya ekler.** Var olan bir not değişmez, silinmez, üzerine yazılmaz. Bir yolda not olup
  olmadığını `note_create`'in "zaten var" cevabı söyler (gizli bir notun yolu için de); notun içeriği hiçbir yazma
  cevabında yoktur.
- **Ağa çıkmaz.** `capture` adresi indirmez. Dönen notlar, kancalarda olduğu gibi, kullandığın yapay zeka
  sağlayıcısına gider. Yerel bir model kullanırsan hiçbir şey bilgisayardan çıkmaz.

## Hata durumları

Her hata tek cümledir ve ne yapılacağını söyler.

| Durum | Cevap |
| --- | --- |
| Kasada Cortex kurulu değil, bu bilgisayarda indeksi yok ya da motor eski | `initialize` hatası (-32001): "Bu kasada Cortex'in hafızası kurulu değil ya da eski; Cortex'i güncelle." |
| Kasa taşınmış ya da kopyalanmış | `initialize` hatası (-32001), `beyin.py relocate`'i söyleyen cümle |
| Bilinmeyen araç ya da yöntem | -32601 |
| Şemaya uymayan argüman (bilinmeyen alan, `metadata` içinde izin verilmeyen alan da) | -32602; hangi alan olduğu yazılır (`data.field`, ör. `metadata.id`), değeri yazılmaz |
| `capture` ya da `note_create` metni 200 KB'tan uzun | -32602, `text`: "metin 200 KB'tan uzun"; metin kesilmez, hiçbir şey yazılmaz |
| `capture` adresi herkese açık bir http(s) adresi değil ya da bir sır taşıyor | -32602, `url`; hiçbir şey yazılmaz |
| `note_create` yolu `notes/` ya da `knowledge/` dışında, `..`, mutlak yol, bağlantı ya da yasak klasör | -32602, `source`; hiçbir şey yazılmaz |
| `note_create` yolunda zaten bir not var | `isError: true`: "Bu yolda zaten bir not var; Cortex var olan notun üzerine yazmaz, başka bir ad seç." |
| Kasada o anda başka bir yazma sürüyor (kilit 15 saniyede alınamadı) | `isError: true`; birazdan yeniden dene |
| Not yazıldı ama indekste doğrulanamadı | `isError: true`; aynı notu yeniden gönderme, kasada `beyin.py sync` çalıştır |
| JSON olmayan bir satır | -32700; süreç sürer |
| 1 MB'tan uzun bir satır | okunmaz, -32600; süreç sürer |
| stdin kapanır | süreç çıkar (çıkış kodu 0) |

## Sözleşme (geliştiriciler için)

- **Taşıma:** stdio; her satırda bir JSON-RPC 2.0 mesajı. Toplu (dizi) istek yoktur. Yöntemler `initialize`, `ping`,
  `tools/list` ve `tools/call`. Bildirimler (`notifications/initialized`, `notifications/cancelled`) sessizce alınır.
  `initialize` cevaplanmadan gelen araç isteği -32002 alır.
- **Protokol sürümleri:** `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. İstemci bunlardan birini isterse
  aynısı döner. Daha yeni bir tarih isterse buradaki en yeni sürüm döner: MCP belirtimi bunu ister, istemci devam eder
  ya da bağlantıyı keser. Başka her değer -32602 ile reddedilir ve desteklenenler `data.supported` içinde yazılır.
- **`serverInfo`:** `{"name": "cortex", "version": "<kasadaki .beyin-version>"}`.
- **Sonuç:** her başarılı `tools/call`, aracın `outputSchema`'sına uyan `structuredContent` taşır; aynı JSON
  `content` içinde metin olarak da durur. Aracın cevaplayamadığı ya da yazamadığı durumda (kilitli indeks, okunamayan
  sır listesi, yolda zaten bir not) `isError: true` ve tek cümle döner.
- **Yazma araçlarının ipuçları:** `readOnlyHint: false`, `destructiveHint: false` (yalnız dosya eklenir),
  `idempotentHint: false` (aynı çağrı ikinci bir not ekler ya da "zaten var" der), `openWorldHint: false`.
- **Araç şeması özeti:** `tools/list` cevabındaki `tools` dizisinin, anahtarları sıralı ve boşluksuz JSON'unun
  (UTF-8) SHA-256'sı:

  `c283cfa0ada5e9ebbe6f891c8d0429bdc09c5380c39c0147a2364adb9e8d32d3`

  Bir istemci bu özeti sabitleyebilir (Cortex Browser böyle yapacak, ADR-0006 §3). Özet değişirse sürüm notunda
  "MCP sözleşmesi değişti" satırı bulunur. `tests/v3_mcp_test.py` özeti sabitler; şema değişince test düşer.
  Özetin geçmişi: 1.0.57 `c27c7612…` (`search`, `context`), 1.0.58 `c283cfa0…` (`capture` ve `note_create` eklendi).
- **Kod ve tasarım:** `template/.claude/scripts/beyin_v3_mcp.py`,
  [tasarım belgesi](../superpowers/specs/2026-11-05-beyin-mcp-design.md).
