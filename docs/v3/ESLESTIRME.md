# Bilgisayarı sunucuna kodla bağlamak (eşleştirme)

Kendi sunucunda bir Hermes ajanı çalışıyorsa masaüstündeki Cortex'i ona bağlayabilirsin. Bilgisayara Tailscale
kurman, adres ya da anahtar yazman gerekmez. Sunucu tek kullanımlık bir kod üretir, sen bu kodu bilgisayardaki
Cortex'e yapıştırırsın. Sunucu internete açılmaz: bilgisayar senin tailnet'ine kendi küçük bağlantı aracıyla
(`tools/cortex-tailnet`) katılır.

Tasarım: [`docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md`](../superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md).
Durum (2026-11-06): kod üretici ve bağlantı aracı hazır. Masaüstündeki "Kodla bağlan" ekranı sıradaki aşama.

## Bir kez: Tailscale tarafı
1. **Etiket.** Tailscale panelinde Access controls'u aç. Bilgisayarlar için bir etiket tanımla ve bu etiketli
   cihazların yalnız ajanın portuna ulaşmasına izin ver:
   ```json
   "tagOwners": { "tag:cortex-desktop": ["autogroup:admin"] },
   "grants": [ { "src": ["tag:cortex-desktop"], "dst": ["<sunucunun adı ya da etiketi>"], "ip": ["tcp:8642"] } ]
   ```
   Bu satır yalnız bir öneri; senin ilkene göre uyarla. Cortex bu ilkeyi hiçbir zaman kendisi değiştirmez.
2. **OAuth istemcisi.** <https://console.tailscale.com/admin/settings/trust-credentials> sayfasında sırasıyla:
   1. **Credential** › **OAuth**'u seç.
   2. **Auth Keys** için **Write**'ı seç ve etiket olarak `tag:cortex-desktop`'u ver.
   3. **Generate credential**'a bas.
   4. Client ID ve secret'ı kopyala. Sayfa kapanınca secret bir daha gösterilmez.
3. **Sunucuda dosya.** İkisini sunucuda yalnız senin okuyabileceğin bir dosyaya yaz:
   ```sh
   umask 077; cat > "<state>/tailscale-oauth.json"      # {"client_id": "...", "client_secret": "..."}
   chmod 600 "<state>/tailscale-oauth.json"
   ```
   `<state>`, Cortex'in bu makinedeki durum klasörüdür (`beyin.py doctor` gösterir). Dosyayı başka bir yerde tutmak
   istersen yolunu `--oauth` ile ver.

## Her bilgisayar için: kodu üret
```sh
CORTEX_HERMES_KEY="$(…ajanın API anahtarını okuyan komut…)" \
  python3 beyin.py eslestir --adres https://<sunucu>.<tailnet>.ts.net:8642 --profil <profil>
```
- **Çıktı** tek bir satırdır: `cortex-pair-1:…`. Bilgisayarda Cortex › Ayarlar › Sunucu › "Kodla bağlan"a yapıştır.
- **Geçerlilik:** kod 1 saatte dolar (`--sure` ile değişir). İçindeki Tailscale anahtarı tek kullanımlıktır ve en çok
  bir gün yaşar.
- **Kod bir sırdır.** Sohbete ya da nota yapıştırma, ekran görüntüsü alma. Kullanılmadıysa süresi dolar; kullanıldıysa
  bir daha işe yaramaz.
- **Sırlar komut satırından verilmez.** Ajanın anahtarı yalnız `CORTEX_HERMES_KEY` ortam değişkeninden, OAuth bilgisi
  yalnız dosyadan okunur.

## Bir bilgisayarı çıkarmak
Tailscale panelindeki Machines listesinde cihazı (adı `cortex-…`) kaldır. Bilgisayardaki Cortex sunucuya bir daha
ulaşamaz. Cortex'teki "Bağlantıyı kaldır" düğmesi de aynı işi yapar.
