# cortex-tailnet

Masaüstü Cortex'in kendi sunucuna, bilgisayara Tailscale kurmadan bağlanmak için kullandığı küçük araç. Tailscale'in
[tsnet](https://pkg.go.dev/tailscale.com/tsnet) kütüphanesiyle yazıldı. Tailnet'e kendi başına bir cihaz olarak katılır
ve yalnız tek bir sunucuya giden yerel bir vekil açar. Bunun için yönetici izni gerekmez, sistem servisi kurulmaz ve
bilgisayarın ağ ayarları değişmez.

Tasarım: [`docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md`](../../docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md).

## Sözleşme
- **Komutlar:**
  - `cortex-tailnet up`: stdin'in ilk satırındaki giriş anahtarıyla tailnet'e katılır. Cihaz zaten katıldıysa satır boş
    bırakılır.
  - `cortex-tailnet logout`: tailnet'ten çıkar.
- **Ayarlar** ortam değişkeniyle verilir, hiçbiri argv'de değildir:
  - `CORTEX_TAILNET_DIR`: durum klasörü.
  - `CORTEX_TAILNET_HOSTNAME`: cihazın tailnet'teki adı.
  - `CORTEX_TAILNET_TARGET`: vekilin ulaştığı tek sunucu.
- **stdout'a tek bir JSON satırı yazılır:** `{"ready":true,"port":N,"token":"…"}` ya da `{"error":"<kod>","message":"…"}`.
- **Vekil:**
  - Yalnız `127.0.0.1` üzerinde dinler.
  - `X-Cortex-Tailnet: <token>` başlığı olmayan isteği 403 ile reddeder.
  - Yolu ve sorguyu hedefe ekler; adres ve şema hiçbir zaman istekten alınmaz.
  - `Authorization` başlığına dokunmaz.
  - Akışları (SSE) parça parça iletir.
- **Ömür:** stdin kapanınca, yani aracı başlatan uygulama gidince, araç da kapanır.

## Geliştirme
```
go vet ./... && go test -count=1 ./...
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags "-s -w" -o cortex-tailnet.exe .
```
Ölçüm (2026-11-06, Go 1.27.3, tsnet v1.104.5): bir ikili 19,6 ile 21,4 MB arası; Windows x64 için gzip ile 8,3 MB.
Yayın `.github/workflows/tailnet-helper.yml` ile yapılır (prerelease, SHA-256 sabit, üzerine yazılmaz).
