"""Passage-level retrieval for the per-turn strict path (#83). No model, no new dependency.

Note-level strict scoring collapses a whole note into one token set. The log(10 + vocabulary)
divisor then pushes rich, legitimate notes under STRICT_MIN_WEIGHT even when they contain
every query word, a long note that shares everything can still win, and a winning long
note is delivered as its opening characters rather than the part that matched.

Here the unit of competition is a Markdown block. A block cannot match everything, and the
delivered text is the matching block itself: a verbatim slice of the source plus its
heading path. Admission uses block-frequency idf (the scale FLOOR was calibrated on);
ranking among admitted sources uses source-level frequency, so a term's weight does not
depend on how many blocks its note happens to be split into. Coverage (shared / query
terms) rewards answering most of the question, but its denominator is capped so that a
long, chatty prompt is not ruled out merely for being long.

The index is derived data in the runtime state directory, never in the vault, stored as
JSON (never pickle) and re-tokenised per record only when that record changes. A cold
index is built in bounded steps: a turn that runs out of BUILD_SECONDS keeps its progress
and falls back to the note-level path, so a large vault can never time the hook out.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time
import unicodedata

from beyin_v3 import (HARNESSES, STOPWORDS, _allowed_statuses, _json, _name_match_score, _status_allowed, _strict_terms,
                      _tokens, pack_context, query_words, records_generation)

# #83 chose 0.15 on one 263-note Turkish vault without a coverage cap. With the cap, on a
# second 1,285-note vault 0.20 is the lowest floor that keeps everyday and agent-command
# noise at or below the note-level path (0.15 exceeds it on both); docs/v3/PREFERENCES.md
# has the numbers. Measure yours with scripts/evaluate_v3_passages.py and set
# strict_floor in the runtime retrieval.json.
FLOOR = 0.20
MIN_SHARED = 2  # Multiword queries; one-word queries require one match at the same floor.
COVERAGE_CAP = 4
BLOCK_TARGET = 900
BLOCK_OVERLAP = 200
# V3's own record paths, always excluded. receipts/ is never indexed by sync; it is listed
# for explicit callers. Personal archive folders are added through strict_exclude.
DEFAULT_EXCLUDE = ("daily/", "receipts/")
CONFIG_NAME = "retrieval.json"
CACHE_NAME = "passages.json"
# What the sync worker last warmed the cache for (warm); a prompt never reads it.
WARM_NAME = "passages-warm.json"
# A pool the cache file could not take is built again after this long, not after every change.
WARM_RETRY_SECONDS = 86400
CACHE_VERSION = 1
CACHE_MAX_BYTES = 64 * 1024 * 1024
MAX_EXCLUDES = 64
# Tokenising budget per call for records the cache does not know yet. At least one record
# is always processed, so progress is guaranteed on any machine.
BUILD_SECONDS = 1.0


class IndexPending(RuntimeError):
    """The index is still being built; the caller falls back to the note-level path.

    pending_total is the size of the pool being built, so the caller can tell a small pool
    (the note-level path is quick) from a large one (it is not)."""

    def __init__(self, message, pending_total=0):
        super().__init__(message)
        self.pending_total = pending_total


# Only the opening "#" run is a pattern; the title and its optional closing "#" sequence are
# trimmed in _heading. One pattern for both let a heading line with a long run of spaces or
# tabs backtrack quadratically (about 10 s for 40,000 spaces), inside a hook turn.
_HEADING = re.compile(r" {0,3}(#{1,6})(?=[ \t]|$)")
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")
_SENTENCE = re.compile(r"[.!?…][\"')\]]*\s+")


def _heading(bare):
    """(level, title) of an ATX heading line, or None. Linear in the line length."""
    match = _HEADING.match(bare)
    if not match:
        return None
    title = bare[match.end():].strip(" \t")
    body = title.rstrip("#")
    if body != title and body[-1:] in (" ", "\t"):  # a closing sequence needs a space before it
        title = body.rstrip(" \t")
    return len(match.group(1)), title.strip()


def _path_key(value):
    return unicodedata.normalize("NFC", value.replace("\\", "/")).casefold()


def settings(state_dir):
    """Optional runtime config; an invalid file means defaults, never a broken hook.

    strict_exclude adds prefixes to DEFAULT_EXCLUDE; it cannot remove V3's own paths.
    """
    result = {"floor": FLOOR, "exclude": DEFAULT_EXCLUDE}
    path = Path(state_dir) / CONFIG_NAME
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
            return result
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return result
    if not isinstance(value, dict):
        return result
    floor = value.get("strict_floor")
    if type(floor) in (int, float) and 0.0 <= floor <= 2.0:
        result["floor"] = float(floor)
    exclude = value.get("strict_exclude")
    if (isinstance(exclude, list) and len(exclude) <= MAX_EXCLUDES and
            all(isinstance(item, str) and 0 < len(item.strip()) and len(item) <= 256 for item in exclude)):
        extra = tuple(item.replace("\\", "/") for item in exclude)
        result["exclude"] = DEFAULT_EXCLUDE + tuple(item for item in extra if item not in DEFAULT_EXCLUDE)
    return result


def _windows(text, start, end, target, overlap):
    """Cut an oversized span on sentence, then whitespace, boundaries; windows overlap."""
    if end - start <= target + overlap:
        return [(start, end)]
    out = []
    cursor = start
    while cursor < end:
        limit = min(end, cursor + target + overlap)
        if limit >= end:
            out.append((cursor, end))
            break
        window = text[cursor:limit]
        cut = None
        for match in _SENTENCE.finditer(window, target // 2):
            cut = cursor + match.end()
        if cut is None:
            space = max(window.rfind(" ", target // 2), window.rfind("\n", target // 2))
            cut = cursor + space + 1 if space > 0 else limit
        out.append((cursor, cut))
        # Carry the trailing sentences (or words) that fit in `overlap` into the next window.
        back = text[max(cursor + 1, cut - overlap):cut]
        match = _SENTENCE.search(back)
        if match and match.end() < len(back):
            nxt = cut - len(back) + match.end()
        else:
            space = back.find(" ")
            nxt = cut - len(back) + space + 1 if 0 <= space < len(back) - 1 else cut
        cursor = max(nxt, cursor + 1)
    return out


def split_blocks(text, target=BLOCK_TARGET, overlap=BLOCK_OVERLAP):
    """Heading-aware Markdown blocks as (heading path, start, end) spans of `text`.

    Spans index the text itself, so a delivered excerpt is a verbatim slice. Blank lines
    separate paragraphs; ATX headings outside fenced code start a section and travel as a
    path of the two nearest headings. "#tag" lines and "# comments" inside code fences are
    not headings. CRLF text keeps its offsets.
    """
    units = []
    heads = []
    fence = None
    start = last = None
    offset = 0

    def close():
        nonlocal start, last
        if start is not None and last is not None and text[start:last].strip():
            units.append((" > ".join(title for _, title in heads[-2:]), start, last))
        start = last = None

    for line in text.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        line_start, offset = offset, offset + len(line)
        marker = _FENCE.match(bare)
        if fence is not None:
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                fence = None
            last = line_start + len(bare)
            continue
        if marker:
            fence = marker.group(1)
            start = line_start if start is None else start
            last = line_start + len(bare)
            continue
        heading = _heading(bare)
        if heading:
            close()
            level = heading[0]
            while heads and heads[-1][0] >= level:
                heads.pop()
            heads.append(heading)
            continue
        if not bare.strip():
            close()
            continue
        start = line_start if start is None else start
        last = line_start + len(bare)
    close()
    spans = []
    for head, begin, end in units:
        for low, high in _windows(text, begin, end, target, overlap):
            piece = text[low:high]
            stripped = piece.strip()
            if stripped:
                low += len(piece) - len(piece.lstrip())
                spans.append((head, low, low + len(stripped)))
    return spans


def _meta(record):
    aliases = record.get("aliases", [])
    aliases = aliases if isinstance(aliases, list) else []
    alias_text = " ".join(a[:160] for a in aliases[:32] if isinstance(a, str))
    facts = record.get("facts") or {}
    return _tokens(record["source"] + " " + str(record.get("title", "")) + " " + alias_text +
                   (" " + _json(facts) if facts else ""))


def _key(record):
    digest = hashlib.sha256()
    digest.update(_json({k: record.get(k) for k in ("id", "revision", "source", "source_sha256",
                                                     "title", "aliases", "facts")}).encode())
    digest.update(record["text"].encode("utf-8", "surrogatepass"))
    return digest.hexdigest()


def _passages(record):
    meta = _meta(record)
    text = record["text"]
    out = [[head, start, end, " ".join(sorted(_tokens(head + " " + text[start:end]) | meta))]
           for head, start, end in split_blocks(text)]
    return out or [["", 0, 0, " ".join(sorted(meta))]]  # a title/facts-only record stays findable


def _valid(entry, text):
    return isinstance(entry, list) and bool(entry) and all(
        isinstance(item, list) and len(item) == 4 and isinstance(item[0], str) and isinstance(item[3], str)
        and type(item[1]) is int and type(item[2]) is int and 0 <= item[1] <= item[2] <= len(text)
        for item in entry)


# Derived tokens depend on the stemmer, not only on the record: a release that changes
# _tokens must rebuild the cache instead of mixing old and new stems. The probe needs a
# word every new rule changes: the #430 verb and vowel-loss rules, the apostrophe (#hafiza).
_PROBE = "Kütüphanesindeki notlarımızı güncellediler; running tests quickly İstanbul ŞEHİR 2026 kurulmalı metni claude Kaya'nın"
_PARAMS = [BLOCK_TARGET, BLOCK_OVERLAP, hashlib.sha256(" ".join(sorted(_tokens(_PROBE))).encode()).hexdigest()[:16]]


def _read_cache(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > CACHE_MAX_BYTES:
            return None
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (not isinstance(blob, dict) or blob.get("version") != CACHE_VERSION or
            blob.get("params") != _PARAMS or not isinstance(blob.get("records"), dict)):
        return None
    return blob


def _write_cache(path, blob):
    """True when the cache was written."""
    temporary = None
    try:
        data = json.dumps(blob, ensure_ascii=False, separators=(",", ":"))
        if len(data) > CACHE_MAX_BYTES or path.is_symlink():
            return False
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".passages-",
                                         suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(data)
        os.replace(temporary, path)
        temporary = None
        return True
    except OSError:
        return False  # a cache that cannot be written (or is locked on Windows) is a slow path
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


class Index:
    def __init__(self, passages, block_df, source_df, sources, saved=None):
        # [(record, head, start, end, " token token ... ")]: tokens stay one padded string,
        # so matching a query is a few substring probes instead of a set per passage.
        self.passages = passages
        self.block_df = block_df
        self.source_df = source_df
        self.sources = sources
        # True or False when this build wrote the cache file, None when it had nothing to write.
        self.saved = saved


def build(state_dir, pool, write=True, deadline=None):
    """Index for `pool`; raises IndexPending when `deadline` stops a cold build midway."""
    path = Path(state_dir) / CACHE_NAME
    blob = _read_cache(path) or {"records": {}}
    cached = blob["records"]
    keys, fresh, changed, complete, built = [], {}, False, True, 0
    for record in pool:
        key = _key(record)
        keys.append(key)
        entry = cached.get(key)
        if not _valid(entry, record["text"]):
            if built and deadline is not None and time.monotonic() > deadline:
                complete = False
                continue
            entry, changed = _passages(record), True
            built += 1
        fresh[key] = entry
    fingerprint = hashlib.sha256("\n".join(keys).encode()).hexdigest()
    reuse = (complete and blob.get("pool") == fingerprint and isinstance(blob.get("block_df"), dict)
             and isinstance(blob.get("source_df"), dict))
    block_df, source_df = (blob["block_df"], blob["source_df"]) if reuse else ({}, {})
    if complete and not reuse:
        for entry in fresh.values():
            seen = set()
            for _head, _start, _end, tokens in entry:
                split = tokens.split()
                seen.update(split)
                for token in split:
                    block_df[token] = block_df.get(token, 0) + 1
            for token in seen:
                source_df[token] = source_df.get(token, 0) + 1
        changed = True
    saved = None
    if write and changed:
        # Keep other pools' entries (another audience or project) within a bound.
        records = dict(cached) if len(cached) <= 2 * len(fresh) + 256 else {}
        records.update(fresh)
        state = {"version": CACHE_VERSION, "params": _PARAMS, "records": records}
        if complete:
            state.update(pool=fingerprint, block_df=block_df, source_df=source_df)
        saved = _write_cache(path, state)
    if not complete:
        raise IndexPending(f"passage index pending: {len(fresh)}/{len(keys)} records", pending_total=len(keys))
    passages = [(record, head, start, end, " " + tokens + " ")
                for key, record in zip(keys, pool) for head, start, end, tokens in fresh[key]]
    return Index(passages, block_df, source_df, len(pool), saved)


def _weight(shared, frequency, total, size):
    idf_max = math.log((total + 1) / 2) + 1
    weight = sum(math.log((total + 1) / (frequency.get(token, 0) + 1)) + 1 for token in shared)
    return weight / idf_max / math.log(10 + size)


def search(index, terms, limit=5, floor=FLOOR, min_shared=MIN_SHARED, variants=None):
    """Best admitted passage per source, ranked. Returns [(rank weight, passage), ...].

    `variants` maps a term to the vault's words that stand for it; a term without an entry
    is matched as it is."""
    terms = _strict_terms(terms)
    if not terms:
        return []
    variants = variants or {}
    # For a one-word query two shared terms are impossible; keep the calibrated weight floor.
    min_shared = min(min_shared, len(terms))
    passages_total = max(1, len(index.passages))
    sources_total = max(1, index.sources)
    wanted = min(len(terms), COVERAGE_CAP)
    probes = [(term, [" " + form + " " for form in (variants.get(term) or (term,))]) for term in sorted(terms)]
    best = {}
    for passage in index.passages:
        tokens = passage[4]
        shared = []
        for _term, alternatives in probes:
            hit = next((probe for probe in alternatives if probe in tokens), None)
            if hit is not None:
                shared.append(hit[1:-1])
        if len(shared) < min_shared:
            continue
        size = tokens.count(" ") - 1
        coverage = min(1.0, len(shared) / wanted)
        if _weight(shared, index.block_df, passages_total, size) * coverage < floor:
            continue
        rank = _weight(shared, index.source_df, sources_total, size) * coverage
        record = passage[0]
        name_score = _name_match_score(record, terms)
        if name_score > 0:
            rank += 10.0 * name_score
        current = best.get(record["id"])
        if current is None or rank > current[0]:
            best[record["id"]] = (rank, passage)
    ranked = list(best.values())
    ranked.sort(key=lambda item: (item[1][0].get("updated_at", ""), item[1][0]["id"]), reverse=True)
    ranked.sort(key=lambda item: -item[0])
    return ranked[:limit]


# A person's day log (daily/YYYY-MM-DD.md; daily/v3 is the engine's own) can hold what
# happened that day and nowhere else: "macbook bataryasına kaç para verdim". Logs repeat the
# vault's words (imported chat histories land there too), so they are searched only when no
# note answers, and at most DAY_LOGS of them come back (#hafiza).
_DAY_LOG = re.compile(r"^daily/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$")
DAY_LOGS = 1
# A log answers in place of the notes only for most of the question: a log shares two words
# with nearly any question, being a day of everything.
LOG_COVERAGE = 0.75


def _covers(tokens, terms, variants=None):
    """The share of a question's words (at most COVERAGE_CAP of them) a passage holds."""
    variants = variants or {}
    shared = sum(1 for term in terms if any(" " + form + " " in tokens for form in (variants.get(term) or (term,))))
    return min(1.0, shared / max(1, min(len(terms), COVERAGE_CAP)))


def _left_out(store, exclude):
    """source -> True when pool() never admits a record of that source, whatever its fields."""
    prefixes = tuple(_path_key(prefix) for prefix in exclude)
    log_prefixes = tuple(_path_key(prefix) for prefix in exclude if prefix not in DEFAULT_EXCLUDE)

    def left_out(source):
        if _DAY_LOG.match(source):
            return bool(log_prefixes) and _path_key(source).startswith(log_prefixes)
        return source.startswith(store.STRICT_EXCLUDE) or _path_key(source).startswith(prefixes)
    return left_out


def pool(store, eligible, statuses=None, exclude=DEFAULT_EXCLUDE, superseded=None):
    """The strict candidate set of MemoryStore._retrieve, minus configured record paths; a
    person's day logs stay in (DAY_LOGS)."""
    if superseded is None:
        superseded = store._superseded_ids()
    left_out = _left_out(store, exclude)
    allowed_statuses = _allowed_statuses(statuses)
    result = []
    for record in eligible:
        source = str(record.get("source", ""))
        if record["id"] in superseded or not _status_allowed(record, allowed_statuses) or left_out(source):
            continue
        result.append(record)
    return result


def strict_records(store, exclude=DEFAULT_EXCLUDE):
    """The records the strict path can deliver, without reading the payloads pool() leaves out.

    A chat-history import (daily/import-*.md) or another excluded folder can be most of the
    index; decoding it and hashing its sources on every prompt made each turn wait on bytes it
    never delivers. Markdown-owned records are left out by their source in markdown_sources;
    records without one (ingest) are read and left to pool(). Day logs stay, for _dated().
    """
    left_out = _left_out(store, exclude)
    with store._connect() as db:
        try:
            owned = db.execute("SELECT id, source FROM markdown_sources").fetchall()
        except sqlite3.OperationalError:
            owned = []  # a store that never synced Markdown
        skipped = sorted(ident for ident, source in owned if left_out(str(source)))
        if not skipped:
            return [json.loads(row[0]) for row in db.execute("SELECT payload FROM records ORDER BY id")]
        try:
            rows = db.execute("SELECT payload FROM records WHERE id NOT IN (SELECT value FROM json_each(?)) "
                              "ORDER BY id", (json.dumps(skipped),)).fetchall()
        except sqlite3.OperationalError:
            # SQLite built without JSON functions: the same rows, filtered here.
            skip = set(skipped)
            return [json.loads(payload) for ident, payload in db.execute("SELECT id, payload FROM records ORDER BY id")
                    if ident not in skip]
    return [json.loads(row[0]) for row in rows]


def warm(store):
    """Build the per-turn index after a sync, in a sync worker no prompt waits for (the Stop at the
    end of an agent turn). True when it built.

    A prompt builds what the cache lacks for at most BUILD_SECONDS and then falls back, and a
    prompt that reads the previous index (its sync still running) never saves what it built: a
    large vault, or every vault after a release that changes the stemmer, stayed cold turn after
    turn. Here the same pool the hook reads (internal, no project, the configured exclusions) is
    built with no deadline. Nothing is done while the index is unchanged since the last warm. A
    pool the cache file could not take (over CACHE_MAX_BYTES) is not built again for
    WARM_RETRY_SECONDS whatever changes: each change would otherwise cost a slow laptop the whole
    build for nothing after every agent turn.
    """
    config, stamp = _warm_stamp(store)
    if not _warm_due(store, stamp):
        return False
    records = strict_records(store, config["exclude"])
    eligible, _stale = store._eligible("internal", None, records=records)
    candidates = pool(store, eligible, None, config["exclude"], superseded=store.superseded_ids())
    index = build(store.state_dir, candidates, write=True)
    if stamp["generation"] is not None:
        _write_cache(Path(store.state_dir) / WARM_NAME, dict(stamp, saved=index.saved, at=time.time()))
    return True


def _warm_stamp(store):
    config = settings(store.state_dir)
    with store._connect() as db:
        generation = records_generation(db)
    return config, {"generation": generation, "params": _PARAMS, "exclude": list(config["exclude"])}


def _warm_due(store, stamp):
    if stamp["generation"] is None:
        return True
    try:
        noted = json.loads((Path(store.state_dir) / WARM_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    if not isinstance(noted, dict) or (noted.get("params"), noted.get("exclude")) != (stamp["params"], stamp["exclude"]):
        return True
    if noted.get("saved") is False:
        at = noted.get("at")
        return not (isinstance(at, (int, float)) and 0 <= time.time() - at < WARM_RETRY_SECONDS)
    return not (noted.get("generation") == stamp["generation"] and (Path(store.state_dir) / CACHE_NAME).is_file())


def _dated(eligible, query, terms, today=None):
    """The logs of the days a question names (beyin_v3_tarih), each at its passage that shares
    the most of the question's words, else its start; newest wins a tie of two logs of a day."""
    from beyin_v3_tarih import day_of, days
    wanted = days(query, today)
    if not wanted:
        return []
    logs = {}
    for record in eligible:
        day = day_of(record.get("source", ""))
        if day in wanted:
            logs.setdefault(day, []).append(record)
    found = []
    for day in wanted:
        for record in sorted(logs.get(day, ()), key=lambda one: str(one.get("source", ""))):
            blocks = _passages(record)
            best = max(blocks, key=lambda block: sum(1 for term in terms if " " + term + " " in " " + block[3] + " "))
            head, start, end = best[0], best[1], best[2]
            if end <= start:
                start, end = 0, len(record["text"])
            body = record["text"][start:end]
            excerpt = head + "\n\n" + body if head else body
            found.append(dict(record, text=excerpt, text_truncated=body != record["text"]))
    return found


def context_for(store, harness, query, project=None, audience="internal", statuses=None, limit=5,
                budget_chars=8000, strict=True, today=None):
    """Strict per-turn context from passages. Same result shape as MemoryStore.retrieve.

    A question that names a day ("dün", "geçen cuma", "12 Ekim") gets that day's log first,
    though logs are otherwise left out of the per-turn search (`today` is the day it counts from)."""
    if harness not in HARNESSES:
        raise ValueError("unsupported harness")
    if strict is not True:
        raise ValueError("passage retrieval is the strict path only")
    if audience not in ("public", "internal", "private"):
        raise ValueError("invalid audience")
    if not isinstance(query, str) or type(limit) is not int or limit < 0 or type(budget_chars) is not int or budget_chars < 0:
        raise ValueError("invalid query or budget")
    if isinstance(statuses, str):
        statuses = [statuses]
    config = settings(store.state_dir)
    records = strict_records(store, config["exclude"])
    eligible, stale_count = store._eligible(audience, project, records=records)
    # Retired by any trusted record, the left-out ones included (#201): the last sync's result
    # while the index is unchanged, so the left-out payloads are not decoded for it either.
    candidates = pool(store, eligible, statuses, config["exclude"], superseded=store.superseded_ids())
    index = build(store.state_dir, candidates, write=not store.read_only,
                  deadline=time.monotonic() + BUILD_SECONDS)
    if candidates and not index.passages:
        raise RuntimeError("passage index is empty")  # a failure, not an answer: caller falls back
    terms = _strict_terms(query_words(query) - _tokens(project or ""))
    records = _dated(eligible, query, terms, today)[:limit]
    if not terms:
        return pack_context(records, limit, budget_chars, stale_count)
    from beyin_v3_esanlam import variants as synonyms
    variants = synonyms(terms, index.block_df)
    found = search(index, terms, limit + DAY_LOGS, config["floor"], variants=variants)
    notes = [item for item in found if not _DAY_LOG.match(str(item[1][0].get("source", "")))][:limit]
    logs = [] if notes else [item for item in found if _DAY_LOG.match(str(item[1][0].get("source", "")))
                             and _covers(item[1][4], terms, variants) >= LOG_COVERAGE][:DAY_LOGS]
    for _rank, (record, head, start, end, _tokens_) in notes + logs:
        body = record["text"][start:end]
        excerpt = head + "\n\n" + body if head else body
        # Only text and text_truncated change, so advisor signatures still match the index.
        if not any(one["id"] == record["id"] for one in records):
            records.append(dict(record, text=excerpt, text_truncated=body != record["text"]))
    return pack_context(records[:limit], limit, budget_chars, stale_count)
