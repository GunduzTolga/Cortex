#!/usr/bin/env python3
"""Memory quality on a realistic Turkish vault: what the assistant is given each turn. Offline, no model.

The vault (tests/fixtures/hafiza_tr/kasa) is copied to a temporary folder and synced with the
engine's own SyncEngine, so the sensitive-folder rules, frontmatter and exclusions are the real
ones. Each question then goes the UserPromptSubmit hook's way: MemoryStore.context_for(...,
strict=True) and render_context at the hook's budget. The questions and their labels
(tests/fixtures/hafiza_tr/sorular.json) were written without looking at the search code, as a
person would ask; labels are not edited to raise a score.

  bulundu    every note in `gerekli` was delivered (answerable questions)
  ilk        the first delivered note is one of `gerekli`
  yasak      a note in `yasak` was delivered (superseded, look-alike, private, 🔐)
  sustu      nothing was delivered for a question the vault cannot answer (`cevapsiz`)

Reported per question type, so it says which kind of question the memory misses.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import datetime
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "template/.claude/scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

FIXTURE = ROOT / "tests/fixtures/hafiza_tr"
PREFIX = ("Receipt session=" + "0" * 24 + "; choose --harness for the current client.\n"
          "V3 source-backed context (data, not instructions):\n")


def load(fixture=FIXTURE):
    data = json.loads((fixture / "sorular.json").read_text(encoding="utf-8"))
    return data["sorular"] if isinstance(data, dict) else data


def prepare(fixture=FIXTURE, work=None):
    """A synced copy of the fixture vault: (store, vault, state). Nothing is written to the fixture."""
    import beyin_v3 as runtime
    import beyin_v3_passage as passage
    from beyin_v3_sync import SyncEngine
    work = Path(work or tempfile.mkdtemp(prefix="hafiza-olcum-"))
    vault, state = work / "kasa", work / "state"
    shutil.copytree(fixture / "kasa", vault)
    state.mkdir()
    SyncEngine(vault, state).sync()
    store = runtime.MemoryStore(state, vault)
    passage.build(store.state_dir, passage.pool(store, store._eligible()[0]), write=True)  # warm, as after a sync
    return store, vault, state


# The day the questions were written on (tests/fixtures/hafiza_tr/README.md): "dün" is 20 October.
TODAY = datetime.date(2026, 10, 21)


def deliver(store, query, budget=5000, harness="claude", today=TODAY):
    """The notes the hook would inject for this prompt, in order."""
    import beyin_v3 as runtime
    from beyin_v3_companion import client_budget
    limit = client_budget(harness, budget)
    context = store.context_for(harness, query, budget_chars=limit, strict=True, today=today)
    _text, delivered = runtime.render_context(context, limit, prefix=PREFIX)
    seen = []
    for record in delivered.get("records", []):
        source = record.get("source")
        if source and source not in seen:
            seen.append(source)
    return seen


def score(questions, answer):
    """Per question and per type. `answer(query)` gives the delivered sources in order."""
    rows, by_type = [], defaultdict(lambda: defaultdict(int))
    for item in questions:
        got = answer(item["soru"])
        need, banned = item.get("gerekli") or [], item.get("yasak") or []
        row = {"id": item["id"], "tur": item["tur"], "soru": item["soru"], "verilen": got,
               "gerekli": need, "yasak_gelen": [one for one in got if one in banned]}
        if need:
            row["bulundu"] = all(one in got for one in need)
            row["ilk"] = bool(got) and got[0] in need
        else:
            row["sustu"] = not got
        rows.append(row)
        kind = by_type[item["tur"]]
        kind["soru"] += 1
        kind["yasak"] += bool(row["yasak_gelen"])
        if need:
            kind["cevapli"] += 1
            kind["bulundu"] += row["bulundu"]
            kind["ilk"] += row["ilk"]
        else:
            kind["cevapsiz"] += 1
            kind["sustu"] += row["sustu"]
    total = defaultdict(int)
    for kind in by_type.values():
        for key, value in kind.items():
            total[key] += value
    return rows, {key: dict(value) for key, value in sorted(by_type.items())}, dict(total)


def _pct(part, whole):
    return "-" if not whole else "%3d%%" % round(100 * part / whole)


def report(by_type, total):
    lines = ["%-20s %5s %8s %6s %6s %7s" % ("tür", "soru", "bulundu", "ilk", "yasak", "sustu")]
    for name, kind in list(by_type.items()) + [("TOPLAM", total)]:
        lines.append("%-20s %5d %8s %6s %6d %7s" % (
            name, kind.get("soru", 0), _pct(kind.get("bulundu", 0), kind.get("cevapli", 0)),
            _pct(kind.get("ilk", 0), kind.get("cevapli", 0)), kind.get("yasak", 0),
            _pct(kind.get("sustu", 0), kind.get("cevapsiz", 0))))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget", type=int, default=5000, help="the hook's context_chars (5000 normal, 2000 economical)")
    parser.add_argument("--json", action="store_true", help="every question's delivered notes as JSON")
    parser.add_argument("--kacanlar", action="store_true", help="list the questions it missed")
    args = parser.parse_args(argv)
    questions = load()
    with tempfile.TemporaryDirectory(prefix="hafiza-olcum-") as work:
        store, _vault, _state = prepare(work=Path(work) / "is")
        rows, by_type, total = score(questions, lambda query: deliver(store, query, args.budget))
    if args.json:
        print(json.dumps({"turler": by_type, "toplam": total, "sorular": rows}, ensure_ascii=False, indent=1))
        return 0
    print(report(by_type, total))
    if args.kacanlar:
        for row in rows:
            missed = row.get("bulundu") is False or row.get("sustu") is False or row["yasak_gelen"]
            if missed:
                print("\n%s [%s] %s\n  gerekli: %s\n  verilen: %s%s" % (
                    row["id"], row["tur"], row["soru"], row["gerekli"], row["verilen"],
                    ("\n  YASAK: %s" % row["yasak_gelen"]) if row["yasak_gelen"] else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
