# MCP: kasayı yapay zeka araçlarına bağlamak

`beyin.py mcp`, kasanın MCP (Model Context Protocol) kapısıdır. Claude Code, Codex, OpenCode gibi bir yapay zeka
aracına bağladığında asistan kasanda kendisi arama yapabilir: "geçen hafta kuvars planı için ne yazmıştım?" sorusunda
notu bulup kaynağıyla getirir.

Bu sürüm (1. aşama) yalnız okur: iki araç var, `search` ve `context`. Not yazan araçlar sonraki aşamada gelecek.

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

## Araçlar

| Araç | Argümanlar | Döndürdüğü |
| --- | --- | --- |
| `search` | `query`: aranacak sözcükler (zorunlu, en çok 2000 karakter). `project`: yalnız o projede ara (isteğe bağlı). `limit`: en çok kaç not (1–20, varsayılan 10). | `results`: her not için `source` (kasadaki yolu), `title`, `snippet` (aranan sözcüğün çevresinden yaklaşık 240 karakter) ve `untrusted` |
| `context` | `query`: soru ya da sözcükler (zorunlu; boş bırakılırsa güncel durumun özeti gelir: en yeni etkin ve bekleyen notlar ve işler, yani `active` ve `waiting`; durumu yazılmamış not etkin sayılır). `budget_chars`: metnin en çok uzunluğu (200–8000, varsayılan 4000). | `text`: en uygun notlar, numaralı ve kasadaki yollarıyla; toplamı `budget_chars`'ı hiçbir zaman aşmaz, uzun not kısaltılır. `sources`: metne giren notlar (`source`, `title`, `untrusted`). |

Arama sözcük tabanlıdır, anlamsal değildir: `beyin.py context` ile aynı sıralamayı kullanır.

`capture` ve `note_create` 2. aşamada gelecek. Bu sürümde istenirlerse bilinmeyen araç gibi reddedilirler.

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
- **Yalnız okur.** İndeks salt okunur açılır; kasaya ve runtime klasörüne hiçbir şey yazılmaz, eşitleme yapılmaz.
  Bu yüzden son eşitlemeden sonra eklenen bir not, bir sonraki eşitlemeden sonra görünür (kanca, `beyin.py sync` ya da
  masaüstü uygulaması). Değişen ya da silinen not o arada zaten dönmez.
- **Ağa çıkmaz.** Dönen notlar, kancalarda olduğu gibi, kullandığın yapay zeka sağlayıcısına gider. Yerel bir model
  kullanırsan hiçbir şey bilgisayardan çıkmaz.

## Hata durumları

Her hata tek cümledir ve ne yapılacağını söyler.

| Durum | Cevap |
| --- | --- |
| Kasada Cortex kurulu değil, bu bilgisayarda indeksi yok ya da motor eski | `initialize` hatası (-32001): "Bu kasada Cortex'in hafızası kurulu değil ya da eski; Cortex'i güncelle." |
| Kasa taşınmış ya da kopyalanmış | `initialize` hatası (-32001), `beyin.py relocate`'i söyleyen cümle |
| Bilinmeyen araç ya da yöntem | -32601 |
| Şemaya uymayan argüman | -32602; hangi alan olduğu yazılır, değeri yazılmaz |
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
  `content` içinde metin olarak da durur. Aracın cevaplayamadığı durumda (kilitli indeks, okunamayan sır listesi)
  `isError: true` ve tek cümle döner.
- **Araç şeması özeti:** `tools/list` cevabındaki `tools` dizisinin, anahtarları sıralı ve boşluksuz JSON'unun
  (UTF-8) SHA-256'sı:

  `c27c7612bf9dd1533bcc7b00d5a03e2b2c45a79c7ae6532a461fd0061094305c`

  Bir istemci bu özeti sabitleyebilir (Cortex Browser böyle yapacak, ADR-0006 §3). Özet değişirse sürüm notunda
  "MCP sözleşmesi değişti" satırı bulunur. `tests/v3_mcp_test.py` özeti sabitler; şema değişince test düşer.
- **Kod ve tasarım:** `template/.claude/scripts/beyin_v3_mcp.py`,
  [tasarım belgesi](../superpowers/specs/2026-11-05-beyin-mcp-design.md).
