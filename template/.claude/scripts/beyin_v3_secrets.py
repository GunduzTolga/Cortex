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
# Hugging Face tokenizer attributes (pad_token, eos_token, ...) are model vocabulary, not credentials:
# tokenizer.pad_token = tokenizer.eos_token must not mask a note or make Jev refuse the query. Only
# the exact attribute names are skipped; SPLUNK_TOKEN and PAD_TOKEN_SECRET still mask.
_SECRET_NAME = (r"(?!(?:pad|eos|bos|unk|sep|cls|mask)_token(?a:(?![a-z0-9_])))"
                r"(?a:(?:[a-z_][a-z0-9_]*_|_)?)"
                r"(?:api[_ -]?key|access[_ -]?token|token|secret[_ -]?(?:access[_ -]?)?key|"
                r"private[_ -]?key|secret|password|passwd|pass)")
_SECRET_VALUE = r"""(?:\\{0,8}["\']\S{8,}\\{0,8}["\']|[^"\'\s,;][^\s,;]{7,})"""


BUILTIN_PATTERNS = (
    re.compile(r"(?i)(?<=[?&])" + _SECRET_NAME + r"=[^&\s]{8,}"),
    # The left boundary is case-sensitive ASCII: under (?i) the class would also match İ, ı and the
    # Kelvin sign, so OPENAİ_API_KEY=... (Caps Lock on a Turkish keyboard) slipped through.
    # A quoted name may close a subscript: os.environ["NAME"] = "value". The quote is required, so a
    # Markdown reference link such as [token]: url stays text.
    re.compile(r"""(?i)(?-i:(?<![a-zA-Z0-9_]))(?:\\{0,8}["\']?""" + _SECRET_NAME +
               r"""(?:\\{0,8}["\']\]|\\{0,8}["\']?))\s*[:=]\s*""" + _SECRET_VALUE),
    # Commands that separate the name from the value without = or a colon: Windows setx and
    # [Environment]::SetEnvironmentVariable, fish set -x. A space also separates prose words, so an
    # unquoted value needs a digit: "setx OPENAI_API_KEY komutunu kullan" stays text.
    re.compile(r"""(?i)(?-i:(?<![a-zA-Z0-9_-]))(?:(?:setx(?:[ \t]+/m)?|set[ \t]+-[a-z]{0,3}x[a-z]{0,3})"""
               r"""[ \t]+["\']?""" + _SECRET_NAME + r"""["\']?[ \t]+|setenvironmentvariable\([ \t]*["\']"""
               + _SECRET_NAME + r"""["\'][ \t]*,[ \t]*)"""
               r"""(?:\\{0,8}["\']\S{8,}\\{0,8}["\']|(?=[^\s,;]*\d)[^"\'\s,;][^\s,;]{7,})"""),
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
