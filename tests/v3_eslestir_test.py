"""beyin.py eslestir: the pairing code (design 2026-11-06-gomulu-tailscale-eslestirme, stage 2).

A fake Tailscale API on localhost answers the two calls; the tests read what was asked of it and what came out.
"""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_eslestir as eslestir  # noqa: E402

CLIENT_SECRET = 'tskey-client-SAHTESIR7f31'     # canaries: never in stdout's code, stderr or a log
HERMES_KEY = 'hermes-anahtar-KANARYA-92ab'
AUTH_KEY = 'tskey-auth-SAHTEANAHTAR-55cd'


class FakeTailscale(BaseHTTPRequestHandler):
    calls: list = []
    token_status = 200
    key_status = 200

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
        FakeTailscale.calls.append({'path': self.path, 'body': body, 'auth': self.headers.get('Authorization'),
                                    'type': self.headers.get('Content-Type')})
        if self.path == '/api/v2/oauth/token':
            status, answer = FakeTailscale.token_status, {'access_token': 'erisim-jetonu', 'token_type': 'Bearer'}
        elif self.path == '/api/v2/tailnet/-/keys':
            status, answer = FakeTailscale.key_status, {'id': 'k1', 'key': AUTH_KEY}
        else:
            status, answer = 404, {}
        data = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def decode(made):
    body = made[len(eslestir.PREFIX):]
    return json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))


class EslestirTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(('127.0.0.1', 0), FakeTailscale)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.api = 'http://127.0.0.1:%d' % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeTailscale.calls, FakeTailscale.token_status, FakeTailscale.key_status = [], 200, 200
        self.state = Path(tempfile.mkdtemp())
        self.oauth = self.state / 'tailscale-oauth.json'
        self.oauth.write_text(json.dumps({'client_id': 'istemci-1', 'client_secret': CLIENT_SECRET}), encoding='utf-8')
        os.chmod(self.oauth, 0o600)
        self.env = {'CORTEX_TS_API': self.api, 'CORTEX_HERMES_KEY': HERMES_KEY}

    def run_main(self, argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        old = {k: os.environ.get(k) for k in ('CORTEX_TS_API', 'CORTEX_HERMES_KEY')}
        os.environ.pop('CORTEX_HERMES_KEY', None)
        os.environ.update(self.env if env is None else env)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = eslestir.main(argv, state=self.state)
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        return code, out.getvalue(), err.getvalue()

    def test_code_carries_what_the_desktop_needs(self):
        code, out, err = self.run_main(['--adres', 'https://sunucu.ornek.ts.net:8642/', '--profil', 'pyn'])
        self.assertEqual(code, 0, err)
        line = out.strip()
        self.assertTrue(line.startswith('cortex-pair-1:'), line[:30])
        self.assertNotIn('\n', line)
        payload = decode(line)
        self.assertEqual(payload['v'], 1)
        self.assertEqual(payload['url'], 'https://sunucu.ornek.ts.net:8642')
        self.assertEqual(payload['profile'], 'pyn')
        self.assertEqual(payload['authkey'], AUTH_KEY)
        self.assertEqual(payload['hermesKey'], HERMES_KEY)
        expiry = datetime.strptime(payload['exp'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        minutes = (expiry - datetime.now(timezone.utc)).total_seconds() / 60
        self.assertTrue(58 <= minutes <= 61, minutes)
        self.assertEqual(err, '')

    def test_asks_tailscale_for_a_one_off_preapproved_tagged_key(self):
        self.assertEqual(self.run_main(['--adres', 'https://s.ts.net:8642'])[0], 0)
        token, key = FakeTailscale.calls
        self.assertEqual(token['path'], '/api/v2/oauth/token')
        self.assertEqual(token['type'], 'application/x-www-form-urlencoded')
        form = parse_qs(token['body'])
        self.assertEqual(form, {'grant_type': ['client_credentials'], 'client_id': ['istemci-1'],
                                'client_secret': [CLIENT_SECRET]})
        self.assertEqual(key['path'], '/api/v2/tailnet/-/keys')
        self.assertEqual(key['auth'], 'Bearer erisim-jetonu')
        self.assertEqual(json.loads(key['body']), {
            'capabilities': {'devices': {'create': {'reusable': False, 'ephemeral': False, 'preauthorized': True,
                                                    'tags': ['tag:cortex-desktop']}}},
            'expirySeconds': 86400})

    def test_json_output_names_the_expiry(self):
        code, out, _ = self.run_main(['--adres', 'https://s.ts.net:8642', '--sure', '5', '--json'])
        self.assertEqual(code, 0)
        result = json.loads(out)
        self.assertEqual(decode(result['kod'])['exp'], result['son'])

    def test_secrets_never_leave_but_in_the_code(self):
        for status in ('ok', 'token', 'key'):
            FakeTailscale.token_status = 401 if status == 'token' else 200
            FakeTailscale.key_status = 403 if status == 'key' else 200
            code, out, err = self.run_main(['--adres', 'https://s.ts.net:8642'])
            self.assertNotIn(CLIENT_SECRET, out + err, status)
            if status != 'ok':
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertNotIn(HERMES_KEY, err)
                self.assertEqual(len(err.strip().splitlines()), 1, err)

    def test_refusals_are_one_sentence_and_ask_nothing_of_tailscale(self):
        cases = [
            (['--adres', 'ftp://s'], None, 'Adres geçerli değil'),
            (['--adres', 'https://kullanici:parola@s'], None, 'Adres geçerli değil'),
            (['--adres', 'https://s?x=1'], None, 'Adres geçerli değil'),
            (['--adres', 'https://s', '--profil', '../x'], None, 'Profil adı'),
            (['--adres', 'https://s', '--etiket', 'cortex'], None, 'tag:'),
            (['--adres', 'https://s', '--sure', '0'], None, 'Süre'),
            (['--adres', 'https://s'], {'CORTEX_TS_API': 'x'}, 'CORTEX_HERMES_KEY'),
        ]
        for argv, env, said in cases:
            FakeTailscale.calls = []
            code, out, err = self.run_main(argv, env)
            self.assertEqual((code, out), (1, ''), argv)
            self.assertIn(said, err, argv)
            self.assertEqual(FakeTailscale.calls, [], argv)

    @unittest.skipUnless(os.name == 'posix', 'file modes')
    def test_an_oauth_file_others_can_read_is_refused(self):
        os.chmod(self.oauth, 0o644)
        code, out, err = self.run_main(['--adres', 'https://s.ts.net:8642'])
        self.assertEqual((code, out), (1, ''))
        self.assertIn('600', err)
        self.assertEqual(FakeTailscale.calls, [])

    def test_missing_or_broken_oauth_file(self):
        self.oauth.unlink()
        self.assertIn('OAuth dosyası yok', self.run_main(['--adres', 'https://s'])[2])
        self.oauth.write_text('{"client_id": ""}', encoding='utf-8')
        os.chmod(self.oauth, 0o600)
        self.assertIn('okunamadı', self.run_main(['--adres', 'https://s'])[2])

    def test_unreachable_tailscale(self):
        code, out, err = self.run_main(['--adres', 'https://s'], {'CORTEX_TS_API': 'http://127.0.0.1:1',
                                                                  'CORTEX_HERMES_KEY': HERMES_KEY})
        self.assertEqual((code, out), (1, ''))
        self.assertIn("Tailscale'e ulaşılamadı", err)

    def test_dispatched_by_beyin_entry(self):
        text = (ROOT / 'scripts/beyin_entry.py').read_text(encoding='utf-8')
        self.assertIn("argv[0] == 'eslestir'", text)
        self.assertIn('import beyin_v3_eslestir as eslestir', text)


if __name__ == '__main__':
    unittest.main()
