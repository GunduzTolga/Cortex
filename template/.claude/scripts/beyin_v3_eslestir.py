"""beyin.py eslestir: a pairing code that connects a desktop Cortex to this server with nothing installed.

Design: docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md (stage 2). Run on the server
that serves the agent. It asks Tailscale for a one-off, pre-approved, tagged auth key and writes one line:

    cortex-pair-1:<base64url JSON {"v":1,"url":…,"profile":…,"authkey":…,"hermesKey":…,"exp":…}>

The desktop app reads the line (`desktop/shared/pairing.ts`), joins the tailnet with the key through its own
small node (`tools/cortex-tailnet`) and keeps the agent's key encrypted. The key is burnt by its one use and
lives a day at most; the code itself says it is stale after `--sure` minutes.

No secret is taken from argv (every process can read a command line) and none is written anywhere but the
code on stdout:
- Tailscale's OAuth client (scope `auth_keys`, with the tag): a JSON file {"client_id", "client_secret"},
  `<state>/tailscale-oauth.json` unless `--oauth` says another; on POSIX it must be readable by its owner only.
- The agent's API key: the environment variable CORTEX_HERMES_KEY.

Standard library only. Errors are one sentence on stderr and exit code 1.
"""
import argparse
import base64
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PREFIX = 'cortex-pair-1:'
API = 'https://api.tailscale.com'
DEFAULT_TAG = 'tag:cortex-desktop'
KEY_SECONDS = 24 * 3600   # the shortest a Tailscale auth key can live (1 to 90 days, kb/1085)
TIMEOUT = 20


class Refusal(Exception):
    """A sentence for the person; nothing was made."""


def address(value):
    """`http(s)://host[:port][/path]` without its closing `/`; None for anything else (as desktop/shared/hermes.ts)."""
    text = (value or '').strip()
    if not text or len(text) > 300 or any(c.isspace() for c in text):
        return None
    parts = urllib.parse.urlsplit(text)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password \
            or parts.query or parts.fragment:
        return None
    return parts.scheme + '://' + parts.netloc + parts.path.rstrip('/')


def oauth_client(path):
    try:
        info = os.stat(path)
    except OSError:
        raise Refusal('Tailscale OAuth dosyası yok (' + str(path) + '); Tailscale panelinde auth_keys yetkili bir '
                      'istemci oluşturup client_id ve client_secret ile bu dosyaya yaz.') from None
    if os.name == 'posix' and info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise Refusal('Tailscale OAuth dosyasını başkaları da okuyabiliyor; izni 600 yap (chmod 600 ' + str(path) + ').')
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        client_id, secret = data['client_id'], data['client_secret']
    except (OSError, ValueError, KeyError, TypeError):
        raise Refusal('Tailscale OAuth dosyası okunamadı; içinde client_id ve client_secret olan bir JSON olmalı.') from None
    if not (isinstance(client_id, str) and client_id and isinstance(secret, str) and secret):
        raise Refusal('Tailscale OAuth dosyasında client_id ya da client_secret boş.')
    return client_id, secret


def _call(url, data, headers):
    request = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return json.loads(answer.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        exc.close()  # its body (Tailscale's own sentence) is not shown: it may echo what was sent
        return {'_status': exc.code}
    except (urllib.error.URLError, OSError, ValueError):
        raise Refusal("Tailscale'e ulaşılamadı; sunucunun internet bağlantısını kontrol edip yeniden dene.") from None


def auth_key(client_id, secret, tag, api=API):
    token = _call(api + '/api/v2/oauth/token',
                  urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': client_id,
                                          'client_secret': secret}).encode(),
                  {'Content-Type': 'application/x-www-form-urlencoded'})
    if '_status' in token or not isinstance(token.get('access_token'), str):
        raise Refusal('Tailscale OAuth istemcisi reddedildi; client_id ve client_secret doğru mu, istemci silinmiş olabilir.')
    body = {'capabilities': {'devices': {'create': {'reusable': False, 'ephemeral': False, 'preauthorized': True,
                                                    'tags': [tag]}}},
            'expirySeconds': KEY_SECONDS}
    made = _call(api + '/api/v2/tailnet/-/keys', json.dumps(body).encode(),
                 {'Authorization': 'Bearer ' + token['access_token'], 'Content-Type': 'application/json'})
    if '_status' in made or not isinstance(made.get('key'), str) or not made['key']:
        raise Refusal('Tailscale giriş anahtarı üretmedi; OAuth istemcisinin auth_keys yazma yetkisi ve ' + tag +
                      ' etiketi olmalı (etiket tailnet ilkesinde tagOwners altında tanımlı olmalı).')
    return made['key']


def code(url, profile, key, hermes_key, minutes, now=None):
    now = now or datetime.now(timezone.utc)
    payload = {'v': 1, 'url': url, 'profile': profile, 'authkey': key, 'hermesKey': hermes_key,
               'exp': (now + timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%SZ')}
    raw = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    return PREFIX + base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def main(argv=None, vault=None, state=None):
    parser = argparse.ArgumentParser(prog='beyin.py eslestir',
                                     description='Bir bilgisayardaki Cortex için tek kullanımlık eşleştirme kodu üretir.')
    parser.add_argument('--adres', required=True, help="ajanın bu tailnet'teki adresi, ör. https://sunucu.tailnet.ts.net:8642")
    parser.add_argument('--profil', default=None, help='adreste /p/<profil>/ altında sunulan profil (ör. pyn)')
    parser.add_argument('--etiket', default=DEFAULT_TAG, help='bağlanan bilgisayarın etiketi (varsayılan %(default)s)')
    parser.add_argument('--sure', type=int, default=60, help='kodun geçerli kaldığı dakika (1-1440, varsayılan 60)')
    parser.add_argument('--oauth', type=Path, default=None, help='Tailscale OAuth dosyası (varsayılan <state>/tailscale-oauth.json)')
    parser.add_argument('--json', action='store_true', help='kodu ve son geçerlilik zamanını JSON olarak yaz')
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    try:
        url = address(args.adres)
        if not url:
            raise Refusal('Adres geçerli değil; http(s)://sunucu[:port] biçiminde yaz (kullanıcı adı, parola ve sorgu olmadan).')
        if args.profil is not None and not (args.profil[:1].isalnum() and len(args.profil) <= 64 and
                                            all(c.isalnum() or c in '_-' for c in args.profil)):
            raise Refusal('Profil adı geçerli değil; harf, rakam, _ ve - kullan.')
        if not (args.etiket.startswith('tag:') and len(args.etiket) > 4):
            raise Refusal('Etiket tag: ile başlamalı, ör. tag:cortex-desktop.')
        if not 1 <= args.sure <= 1440:
            raise Refusal('Süre 1 ile 1440 dakika arasında olmalı.')
        hermes_key = os.environ.get('CORTEX_HERMES_KEY', '').strip()
        if not hermes_key:
            raise Refusal("Ajanın API anahtarı yok; CORTEX_HERMES_KEY ortam değişkeniyle ver (komut satırına yazma).")
        oauth = args.oauth or (Path(state) / 'tailscale-oauth.json' if state else None)
        if oauth is None:
            raise Refusal('Tailscale OAuth dosyasının yeri bilinmiyor; --oauth ile ver.')
        client_id, secret = oauth_client(oauth)
        key = auth_key(client_id, secret, args.etiket, os.environ.get('CORTEX_TS_API', API))
        made = code(url, args.profil, key, hermes_key, args.sure)
    except Refusal as refusal:
        print(str(refusal), file=sys.stderr)
        return 1
    if args.json:
        expiry = json.loads(base64.urlsafe_b64decode(made[len(PREFIX):] + '=' * (-len(made[len(PREFIX):]) % 4)))['exp']
        print(json.dumps({'kod': made, 'son': expiry}, ensure_ascii=False))
    else:
        print(made)
    return 0


if __name__ == '__main__':
    sys.exit(main())
