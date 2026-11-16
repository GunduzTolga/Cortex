"""Secret mask regression table: one row per input, synthetic values only.

Each row is (text, secrets). secrets is a tuple of fragments that must not survive redaction (the row
must also count at least one match); an empty tuple means the text is not a secret and must come back
unchanged with no match. Rows come from review probes of the assignment, subscript, call and command
forms; add a row whenever a form is fixed or a false positive is found.
"""
V = 'abcd1234efgh5678ijkl'
L = 'abcdefghijklmnopqrst'
S = 'abc123def456'
TABLE = (
    # Prefixed names, whatever the word before TOKEN.
    (f'OPENAI_API_KEY={V}', (V,)),
    (f'export DB_PASSWORD="{V}"', (V,)),
    (f'PAD_TOKEN={V}', (V,)),
    (f'export SEP_TOKEN="{V}"', (V,)),
    (f'MASK_TOKEN={V}', (V,)),
    (f'Pad_Token={V}', (V,)),
    (f'eos_token: {V}', (V,)),
    ('API_KEY = sk_live.abc123def456', ('abc123def456',)),
    ('TOKEN=ghp_' + 'a1B2' * 9, ('a1B2a1B2',)),
    (f'$env:OPENAI_API_KEY = "{V}"', (V,)),
    (f'process.env.GITHUB_TOKEN = "{V}"', (V,)),
    (f'os.environ.update(GITHUB_TOKEN="{V}")', (V,)),
    (f'putenv("GITHUB_TOKEN={V}")', (V,)),
    (f'SECRET = "".join(["{V}"])', (V,)),
    ('json: {\\"api_key\\": \\"abcd1234efgh5678\\"}', ('abcd1234efgh5678',)),
    ('"password": "abcd.efgh.ijkl"', ('abcd.efgh',)),
    ('PASSWORD=abcd1234.efgh', ('abcd1234',)),
    # Values that look like code but are not: a call or subscript must close and end the value; a
    # dotted reference starts with a lowercase letter and has no digit.
    ('PASSWORD=Secret(2024)!x', ('Secret(2024)',)),
    ('PASSWORD=pass[word]123', ('pass[word]',)),
    ('DB_PASSWORD=Pa(ss)w0rd99', ('Pa(ss)w0rd',)),
    ('PASSWORD=abc(defghij12', ('abc(defghij',)),
    ('password: hunter(2)hunter', ('hunter(2)',)),
    ('PASSWORD=x.y_z.w(abc123', ('abc123',)),
    ('PASSWORD=MySecret.Pass', ('MySecret',)),
    ('PASSWORD=Hunter.Correct.Horse', ('Hunter.Correct',)),
    ('api_key: Bearer.Token.Here', ('Bearer.Token',)),
    ('token = tokenizer.eos_token_id2', ('eos_token_id2',)),
    # Special token shapes are not secrets, a key inside angle or square brackets is.
    ('API_KEY=<abc>realsecret123', ('realsecret123',)),
    ('API_KEY="<abc>realsecret123"', ('realsecret123',)),
    ('API_KEY=[PAD]realsecret123', ('realsecret123',)),
    (f'API_KEY=<{V}>', (V,)),
    (f'API_KEY="<{V}>"', (V,)),
    # Subscripts: any literal prefix or quote kind, a value with a space or the other quote.
    (f'os.environ["OPENAI_API_KEY"] = "{V}"', (V,)),
    (f"os.environ['OPENAI_API_KEY']='{V}'", (V,)),
    (f'env["PAD_TOKEN"] = "{V}"', (V,)),
    (f'os.environ[ "GITHUB_TOKEN" ] = "{V}"', (V,)),
    (f'process.env[`GITHUB_TOKEN`] = `{V}`', (V,)),
    (f'ENV["GITHUB_TOKEN"] = "{V}"', (V,)),
    (f'os.environ[\'GITHUB_TOKEN\']\n= "{V}"', (V,)),
    ('env["TOKEN"]="abcdefgh12"]', ('abcdefgh12',)),
    (f'os.environ["GITHUB_TOKEN"] = f"{V}"', (V,)),
    (f'os.environ["GITHUB_TOKEN"] = b"{V}"', (V,)),
    (f'os.environ["GITHUB_TOKEN"] = r"{V}"', (V,)),
    (f'os.environ["GITHUB_TOKEN"] = Rb"{V}"', (V,)),
    (f'os.environ["GITHUB_TOKEN"] = “{V}”', (V,)),
    (f"os.environ['GITHUB_TOKEN'] = '''{V}'''", (V,)),
    (f'os.environ["GITHUB_TOKEN"] = """{V}"""', (V,)),
    ('os.environ["GITHUB_TOKEN"] = "abc\'def123456"', ("abc'def",)),
    ('os.environ["GITHUB_TOKEN"] = "pass word 12345"', ('pass word',)),
    (f'os.environ["GITHUB_TOKEN"] = "{V}" + suffix', (V,)),
    ('os.environ["OPENAI_API_KEY"]="abcd1234efgh5678"; os.environ["HF_TOKEN"]="hf1234567890abcd"',
     ('abcd1234efgh5678', 'hf1234567890abcd')),
    ('d["token"] = "nextPageToken123"', ('nextPageToken123',)),
    # Calls.
    (f'os.environ.setdefault("GITHUB_TOKEN", "{V}")', (V,)),
    (f'os.putenv("GITHUB_TOKEN", "{V}")', (V,)),
    (f'[Environment]::SetEnvironmentVariable("GITHUB_TOKEN",\n"{V}")', (V,)),
    (f"[System.Environment]::SetEnvironmentVariable('DB_PASSWORD','{V}','Machine')", (V,)),
    (f'[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "{V}", "User")', (V,)),
    # Commands.
    (f'set --export GITHUB_TOKEN {V}', (V,)),
    (f'set -x -g GITHUB_TOKEN {V}', (V,)),
    (f'set -gx GITHUB_TOKEN {V}', (V,)),
    (f'set -Ux MY_SECRET {V}', (V,)),
    (f'set --global --export MY_SECRET "{V}"', (V,)),
    (f'setx GITHUB_TOKEN {L}', (L,)),
    (f'set -gx GITHUB_TOKEN {L}', (L,)),
    (f'setx OPENAI_API_KEY "{V}"', (V,)),
    (f'SETX OPENAI_API_KEY "{V}" /M', (V,)),
    (f'setx GITHUB_TOKEN “{V}”', (V,)),
    (f'setx GITHUB_TOKEN `"{V}`"', (V,)),
    ('setx OPENAI_API_KEY abcd1234efgh5678 && echo ok', ('abcd1234efgh5678',)),
    ('set -x MY_TOKEN abcd1234efgh\nnext line', ('abcd1234efgh',)),
    (f'setx GITHUB_TOKEN {S} >nul', (S,)),
    (f'setx GITHUB_TOKEN {S} 2>&1', (S,)),
    (f'set -gx GITHUB_TOKEN {S}  # yorum', (S,)),
    (f'`setx GITHUB_TOKEN {S}` komutunu çalıştır', (S,)),
    (f'`setx GITHUB_TOKEN {S}`', (S,)),
    (f'setx GITHUB_TOKEN {S} /M', (S,)),
    (f'setx GITHUB_TOKEN {S} /m /f', (S,)),
    (f'setx GITHUB_TOKEN {S} /S host', (S,)),
    (f'set -gx GITHUB_TOKEN {S}; and echo', (S,)),
    (f'set -gx GITHUB_TOKEN {S} | cat', (S,)),
    (f'set -gx GITHUB_TOKEN {S})', (S,)),
    (f'Komut: setx GITHUB_TOKEN {S}.', (S,)),
    (f'setx GITHUB_TOKEN {S}\r\n', (S,)),
    ('- `set -Ux OPENAI_API_KEY sk1234abcd5678`: kalıcı', ('sk1234abcd5678',)),
    (f'> setx GITHUB_TOKEN {S} (kalıcı)', (S,)),

    # Not secrets: the value is read from elsewhere, is model vocabulary, a variable, or prose.
    ('PASSWORD=abc.def', ()),
    ('SECRET = "x".join(parts)', ()),
    ('os.environ["X_TOKEN"] = f"{y}"', ()),
    ('TOKEN=abcdefgh[1]', ()),
    ('OPENAI_API_KEY="<your-api-key-here>"', ()),
    ('API_KEY=[YOUR_KEY]', ()),
    ('export GITHUB_TOKEN=$(gh auth token)', ()),
    ('api_key=os.environ["OPENAI_API_KEY"]', ()),
    ('os.environ["API_KEY"] == "abcdefgh12"', ()),
    ('os.environ["OPENAI_API_KEY"] = getpass.getpass("Key: ")', ()),
    ("os.environ['HF_TOKEN'] = userdata.get('HF_TOKEN')", ()),
    ('os.environ["GITHUB_TOKEN"] = token_value', ()),
    ('OPENAI_API_KEY = getpass.getpass("Key: ")', ()),
    ('API_KEY = os.getenv("API_KEY")', ()),
    ('OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")', ()),
    ("HF_TOKEN = userdata.get('HF_TOKEN')", ()),
    ('password = settings.DATABASE_PASSWORD', ()),
    ('client = Client(api_key=config.openai_api_key)', ()),
    ('data["password"] = form.cleaned_data["password1"]', ()),
    ('config["secret"] = settings.SECRET', ()),
    ('set -euxo pipefail', ()),
    ('set -x GITHUB_TOKEN (gh auth token)', ()),
    ('setx API_KEY 2024-01-01 tarihinde değişti', ()),
    ('set -x TOKEN $GITHUB_TOKEN2', ()),
    ('setx GITHUB_TOKEN $GITHUB_TOKEN2', ()),
    ('setx GITHUB_TOKEN %GH_TOKEN_2%', ()),
    ('setx TYPESAFE_API_KEY komutunu kullan', ()),
    ('[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", $key2024, "User")', ()),
    ('headers["Authorization"] = "Bearer x"', ()),
    ('x["pad_token"] = tokenizer.eos_token', ()),
    ('x["PAD_TOKEN"] = tokenizer.eos_token', ()),
    ('special_tokens = {"pad_token": "<pad>"}', ()),
    ('tokenizer.pad_token_id = tokenizer.eos_token_id', ()),
    ('tokenizer.pad_token=tokenizer.unk_token', ()),
    ('tokenizer.pad_token = tokenizer.eos_token', ()),
    ('model.config.pad_token = 50256', ()),
    ('additional_special_tokens=["<extra_token_0>"]', ()),
    ('tokenizer.sep_token = "</s>"', ()),
    ('tokenizer.mask_token = "<mask>"', ()),
    ('tokenizer.eot_token = "<|eot_id|>"', ()),
    ('tokenizer.chat_token = "<|im_start|>"', ()),
    ('tokenizer.start_token = "<|startoftext|>"', ()),
    ('tokenizer.end_token = "<|endoftext|>"', ()),
    ('tokenizer.pad_token = "<|finetune_right_pad_id|>"', ()),
    ('tokenizer.pad_token = "<|reserved_special_token_250|>"', ()),
    ('image_token = "<|image_pad|>"', ()),
    ('tokenizer.bos_token = "<|begin_of_text|>"', ()),
    ('{"sep_token": "<|separator|>"}', ()),
    ('eot_token = "<|eot_id|>"', ()),
)
# Known limits, deliberately not rows: a lowercase dotted value without digits
# (PASSWORD=abcdefgh.ijklmnop) reads as a code reference; a literal after an expression
# (os.environ["X"] = os.environ.get("Y") or "<key>") is not seen.
# --- end of table ---

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'template/.claude/scripts'))
from beyin_v3_secrets import redact


class SecretMaskTableTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='beyin-secret-table-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'

    def test_table(self):
        self.assertEqual(len({text for text, _ in TABLE}), len(TABLE), 'duplicate rows')
        for text, secrets in TABLE:
            with self.subTest(text=text):
                masked, count = redact(text, self.state)
                if secrets:
                    self.assertGreaterEqual(count, 1, masked)
                    for secret in secrets:
                        self.assertNotIn(secret, masked)
                else:
                    self.assertEqual((masked, count), (text, 0))


if __name__ == '__main__':
    unittest.main()
