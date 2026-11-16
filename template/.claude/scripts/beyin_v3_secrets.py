"""Opt-in local secret redaction for user-authored V3 write commands."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3


# A credential assignment name may carry an ASCII environment prefix (OPENAI_, DB_,
# MY_): OPENAI_API_KEY=... and export DB_PASSWORD=... are as secret as API_KEY=...
# The secret word must still end the name, so configuration names such as
# API_KEY_COUNT, PUBLIC_API_KEY_NAME or TOKENIZER_MODEL stay readable. The prefix is
# ASCII only (?a), so a non-ASCII letter cannot turn into an identifier character.
# SECRET_KEY, AWS_SECRET_ACCESS_KEY, SSH_PRIVATE_KEY and DB_PASS end in KEY or PASS rather than in
# the bare word, so those endings are listed too; the name must still end there (SECRET_KEY_ID stays).
_SECRET_NAME = (r"(?a:(?:[a-z_][a-z0-9_]*_|_)?)"
                r"(?:api[_ -]?key|access[_ -]?token|token|secret[_ -]?(?:access[_ -]?)?key|"
                r"private[_ -]?key|secret|password|passwd|pass)")
# A value that only names where the secret comes from is not the secret, whatever the name says: a
# dotted reference (tokenizer.eos_token, settings.SECRET) or a call or subscript that closes and ends
# the value (os.getenv(...), userdata.get(...), form.cleaned_data[...]). The reference starts with a
# lowercase letter and its identifier parts carry no digit, so PASSWORD=MySecret.Pass,
# PASSWORD=Secret(2024)!x and abcd.1234.efgh still mask. A tokenizer special token (<|eot_id|>,
# <extra_token_0>, [PAD]) is model vocabulary rather than a credential; the exception follows the value,
# so PAD_TOKEN=<a real key> masks, and so does a key written inside angle brackets (<abcd1234efgh...>).
# The value ends at a space, a separator, a closing bracket or a quote (also a JSON-escaped one, as
# Jev scans json.dumps output).
_VALUE_END = r"""(?:[\s,;)\]}"\'`\\]|$)"""
_SPECIAL_TOKEN = (r"""(?a:<\|?/?[a-z][a-z_./-]{0,60}(?:_?\d{1,4})?\|?>|\[(?-i:[A-Z][A-Z_]{0,30})\])""")
_CODE_REFERENCE = (r"""(?a:(?-i:[a-z_])[a-z_]*(?=[.(\[])(?:\.[a-z_]+|\([^()\n]*\)|\[[^\[\]\n]*\])+)""")
_NOT_A_SECRET = (r"""(?!\\{0,8}["\'`]?""" + _SPECIAL_TOKEN + r"""\\{0,8}["\'`]?""" + _VALUE_END +
                 r"""|""" + _CODE_REFERENCE + _VALUE_END + r""")""")
_SECRET_VALUE = _NOT_A_SECRET + r"""(?:\\{0,8}["\']\S{8,}\\{0,8}["\']|[^"\'\s,;][^\s,;]{7,})"""
_QUOTE = r"""\\{0,8}["\'`]"""
# A string literal in code: an optional prefix (f, b, r, rb), then any quote kind, triple and typographic
# quotes included. The value runs to the matching closing quote, so it may hold spaces or the other
# quote kind, and a following argument ('Machine') is kept. A typographic value stops at either quote
# of its pair. The value is at most 1024 characters, so a line of unclosed openings cannot make every
# opening scan the rest of the line (a longer literal is not masked; a PEM key has its own pattern).
_LITERAL_OPEN = r'(?:[rbuf]{1,2})?\\{0,8}(?:"""|' + r"'''" + r'|["\'`\u201c\u2018])'
_LITERAL_VALUE = (r'(?P<value>(?!\[REDACTED\])(?:'
                  r'(?<=""")(?:(?!""")[^\n]){8,1024}(?=""")|'
                  r"(?<=''')(?:(?!''')[^\n]){8,1024}(?=''')|"
                  r'(?<=\u201c)[^\u201c\u201d\n]{8,1024}(?=\u201d)|(?<=\u2018)[^\u2018\u2019\n]{8,1024}(?=\u2019)|'
                  r'(?<=")[^"\n]{8,1024}(?=")|' + r"(?<=')[^'\n]{8,1024}(?=')|" + r'(?<=`)[^`\n]{8,1024}(?=`)))')

BUILTIN_PATTERNS = (
    re.compile(r"(?i)(?<=[?&])" + _SECRET_NAME + r"=[^&\s]{8,}"),
    # The left boundary is case-sensitive ASCII: under (?i) the class would also match İ, ı and the
    # Kelvin sign, so OPENAİ_API_KEY=... (Caps Lock on a Turkish keyboard) slipped through.
    re.compile(r"""(?i)(?-i:(?<![a-zA-Z0-9_]))(?:\\{0,8}["\']?""" + _SECRET_NAME +
               r"""\\{0,8}["\']?)\s*[:=]\s*""" + _SECRET_VALUE),
    re.compile(r"(?<=://)[^/\s?#:]*:[^/\s?#]*(?=@[^/\s?#@]+)"),
    re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,255}\b"),
    # Hugging Face access token: hf_ plus exactly 34 letters or digits. A fixed length
    # keeps identifiers such as hf_TransformersAutoModelLoader out.
    re.compile(r"\bhf_[A-Za-z0-9]{34}(?![A-Za-z0-9])"),
    # The key alphabet includes - and _, so only a key character may not follow; a period
    # or dash before the key, or a sentence-ending period after it, still redacts.
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{20,}"),
    # Provider formats with a fixed, distinctive prefix. Stripe keys use underscores,
    # so the dashed sk- pattern above never sees them (#151).
    re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}\b"),
    re.compile(r"\bxox[abeoprs]-[0-9]+-[A-Za-z0-9-]{8,255}\b"),
    re.compile(r"\bxapp-[0-9]+-[A-Za-z0-9-]{8,255}\b"),
    re.compile(r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"),
    re.compile(r"\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_.-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])"),
    # A JWT header is base64url JSON, so it always opens with eyJ; three dot-separated
    # base64url segments are required (five for an encrypted JWE). Plain base64
    # (images, blobs) has no dots.
    re.compile(r"(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2}(?:\.[A-Za-z0-9_-]+){0,2}(?![A-Za-z0-9_-])"),
    # Discord bot token: base64 of a numeric user id (so it starts with M, N or O),
    # a 6 character timestamp and an HMAC of at least 27 characters. Like SendGrid it
    # must stand alone: a segment of a longer dotted name is not a token.
    re.compile(r"(?<![A-Za-z0-9_.-])[MNO][A-Za-z0-9_-]{22,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])"),
)


# Forms where the name is not followed by = or a colon. These replace only the value and keep the
# name, its quotes and what follows, so the note still reads as code: os.environ["X"] = "[REDACTED]".
VALUE_PATTERNS = (
    # A quoted name closing a subscript: os.environ["NAME"] = "value", process.env[`NAME`] = `value`.
    # The value must be a literal; os.environ["NAME"] = getpass.getpass() reads it from elsewhere. The
    # quote around the name is required, so a Markdown reference link such as [token]: url stays text.
    re.compile(r"""(?i)(?P<head>\[\s*""" + _QUOTE + _SECRET_NAME + _QUOTE + r"""\s*\]\s*=\s*""" + _LITERAL_OPEN +
               r""")""" + _LITERAL_VALUE),
    # A call whose first argument is the name and second a literal value: os.environ.setdefault,
    # os.putenv, [Environment]::SetEnvironmentVariable (arguments may continue on the next line).
    re.compile(r"""(?i)(?P<head>(?-i:(?<![a-zA-Z0-9_]))(?:setdefault|putenv|setenvironmentvariable)\(\s*"""
               + _QUOTE + _SECRET_NAME + _QUOTE + r"""\s*,\s*""" + _LITERAL_OPEN + r""")""" + _LITERAL_VALUE),
    # Commands that separate the name from the value with a space: Windows setx and fish
    # set -x / --export (flags in any order). A space also separates prose words, so an unquoted value
    # must end the command and carry a digit or be 20 characters long, and may not be a variable or an
    # expression ($X, %X%, (...)): "setx API_KEY 2024-01-01 tarihinde değişti" stays text. The command
    # ends at a line end, a switch (/M, /S host), a redirection (>nul, 2>&1), ; & | # ( or the closing
    # backtick of Markdown inline code; a closing backtick or parenthesis is not part of the value.
    re.compile(r"""(?i)(?P<head>(?-i:(?<![a-zA-Z0-9_-]))(?:setx(?:[ \t]+/m)?|set"""
               r"""(?=(?:[ \t]+-(?:-[a-z]{2,12}|[a-z]{1,4})){0,3}[ \t]+-(?:-export|[a-z]{0,3}x[a-z]{0,3})(?![a-z-]))"""
               r"""(?:[ \t]+-(?:-[a-z]{2,12}|[a-z]{1,4})){1,4})"""
               r"""[ \t]+["\']?""" + _SECRET_NAME + r"""["\']?[ \t]+(?P<q>`?["\'\u201c\u201d\u2018\u2019])?)"""
               r"""(?P<value>(?!\[REDACTED\])(?(q)[^"\'`\s\u201c\u201d\u2018\u2019]{8,}(?=`?["\'\u201c\u201d\u2018\u2019])|"""
               r"""(?![$%(])(?=[^\s,;`)]*\d|[^\s,;`)]{20})[^"\'`\s,;)][^\s,;`)]{7,}"""
               r"""(?=[ \t]*(?:\r?\n|$|/[a-z]|\d?>|[;&|`#(])|[`)])))"""),
)


def _custom_literals(state):
    """Load bounded literal values, not executable regular expressions."""
    path = Path(state) / 'secret-patterns.txt'
    if not path.exists():
        return []
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
        raise ValueError('secret-patterns.txt must be a regular file no larger than 64 KiB')
    values = []
    for number, raw in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        value = raw.strip()
        if not value or value.startswith('#'):
            continue
        if len(value) < 4 or len(value) > 1000 or value == '[REDACTED]':
            raise ValueError(f'invalid secret literal at line {number}')
        values.append(value)
        if len(values) > 100:
            raise ValueError('secret-patterns.txt supports at most 100 literals')
    return values


def redact(text, state):
    if not isinstance(text, str):
        raise ValueError('secret filter input must be text')
    result, count = text, 0
    for pattern in VALUE_PATTERNS:
        result, matches = pattern.subn(r'\g<head>[REDACTED]', result)
        count += matches
    for pattern in BUILTIN_PATTERNS:
        result, matches = pattern.subn('[REDACTED]', result)
        count += matches
    for literal in _custom_literals(state):
        matches = result.count(literal)
        if matches:
            result = result.replace(literal, '[REDACTED]')
            count += matches
    return result, count


def record(state, count):
    """Persist only aggregate counts outside the vault; never persist matches."""
    if type(count) is not int or count < 0:
        raise ValueError('redaction count must be a nonnegative integer')
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state / 'secret-filter.sqlite3'
    if path.is_symlink():
        raise ValueError('secret filter health database must not be a symlink')
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL, last_count INTEGER NOT NULL, last_at TEXT)')
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT total FROM health WHERE id=1').fetchone()
        total = (row[0] if row else 0) + count
        db.execute('INSERT OR REPLACE INTO health VALUES (1,?,?,?)',
                   (total, count, datetime.now(timezone.utc).isoformat()))
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return {'total': total, 'last_count': count}


def health(state):
    path = Path(state) / 'secret-filter.sqlite3'
    if not path.exists():
        return {'total': 0, 'last_count': 0, 'last_at': None}
    if path.is_symlink() or not path.is_file():
        raise ValueError('secret filter health database must be a regular file')
    with closing(sqlite3.connect(path, timeout=2)) as db:
        row = db.execute('SELECT total,last_count,last_at FROM health WHERE id=1').fetchone()
    return ({'total': row[0], 'last_count': row[1], 'last_at': row[2]}
            if row else {'total': 0, 'last_count': 0, 'last_at': None})
