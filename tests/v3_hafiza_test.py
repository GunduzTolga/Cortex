#!/usr/bin/env python3
"""Memory quality on Turkish questions (#hafiza): the days a question names, words that mean
the same, how a question is asked, and the Turkish vault benchmark as a gate."""
import datetime
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "template/.claude/scripts"))
sys.path.append(str(ROOT / "scripts"))  # after the engine: scripts/ has a beyin_v3.py of its own
import beyin_v3  # noqa: E402
import beyin_v3_esanlam as esanlam  # noqa: E402
import beyin_v3_tarih as tarih  # noqa: E402

WEDNESDAY = datetime.date(2026, 10, 21)


class DaysTest(unittest.TestCase):
    def days(self, query, today=WEDNESDAY):
        return [day.isoformat() for day in tarih.days(query, today)]

    def test_the_days_a_person_names_outright(self):
        self.assertEqual(self.days("dün neler yaptım"), ["2026-10-20"])
        self.assertEqual(self.days("bugünkü plan ne"), ["2026-10-21"])
        self.assertEqual(self.days("önceki gün ne oldu"), ["2026-10-19"])
        self.assertEqual(self.days("geçen cuma Zeynep'ten ne gelmişti"), ["2026-10-16"])
        self.assertEqual(self.days("pazar günü pazara gittim"), ["2026-10-18"], "the second pazar is a market")
        self.assertEqual(self.days("12 Ekim'de ne konuştuk"), ["2026-10-12"])
        self.assertEqual(self.days("2026-10-14 notları"), ["2026-10-14"])
        self.assertEqual(self.days("15.10.2026 ne yaptım"), ["2026-10-15"])

    def test_a_habit_a_week_or_a_day_ahead_is_not_a_day(self):
        for query in ("cuma toplantısı ne zaman", "geçen hafta ne yaptık", "31 şubat", "Kuzey'in teslimi 15 Kasım"):
            self.assertEqual(self.days(query), [], query)

    def test_a_day_and_month_without_a_year_is_the_last_one_past(self):
        self.assertEqual(self.days("3 Ekim'de ne olmuştu"), ["2026-10-03"])
        self.assertEqual(self.days("28 Aralık'ta ne konuştuk", datetime.date(2027, 1, 5)), ["2026-12-28"])
        self.assertEqual(self.days("3 Aralık'ta ne var"), [], "a day still to come this year is not a log")

    def test_last_friday_said_on_a_friday_is_a_week_ago(self):
        friday = datetime.date(2026, 10, 23)
        self.assertEqual(self.days("geçen cuma", friday), ["2026-10-16"])
        self.assertEqual(self.days("cuma günü", friday), ["2026-10-23"])

    def test_only_a_persons_day_logs_are_named_by_a_day(self):
        self.assertEqual(tarih.day_of("daily/2026-10-20.md"), datetime.date(2026, 10, 20))
        self.assertEqual(tarih.day_of("daily/v3/2026-10-20.md"), datetime.date(2026, 10, 20))
        self.assertIsNone(tarih.day_of("notes/2026-10-20.md"))
        self.assertIsNone(tarih.day_of("daily/2026-13-40.md"))


class QuestionWordsTest(unittest.TestCase):
    def test_how_a_question_is_asked_is_not_what_it_is_about(self):
        self.assertEqual(beyin_v3.query_words("Ahmet Yılmaz hangi şehirde yaşıyordu"), {"ahmet", "yilmaz", "sehir"})
        self.assertEqual(beyin_v3.query_words("squatta kaç kiloya çıkmıştım"), {"squat", "kilo"})
        self.assertEqual(beyin_v3.query_words("elif'in neye alerjisi vardı"), {"elif", "alerj"})

    def test_nouns_that_end_like_a_verb_stay(self):
        for word in ("geçmiş", "yiyecek", "quantum", "dostum", "radyo", "stüdyo"):
            self.assertTrue(beyin_v3.query_words(word), word)

    def test_a_suffix_after_an_apostrophe_is_the_names(self):
        self.assertEqual(beyin_v3._tokens("Kaya'nın"), {"kaya"})
        self.assertEqual(beyin_v3._tokens("Kuzey Lojistik’in"), beyin_v3._tokens("Kuzey Lojistik"))


class SynonymTest(unittest.TestCase):
    def test_a_word_stands_with_the_vaults_words_of_its_group(self):
        vocabulary = {beyin_v3._stem("fiyat"): 1, beyin_v3._stem("crash"): 1}
        para, cokme, kahve = (beyin_v3._stem(word) for word in ("para", "cokme", "kahve"))
        found = esanlam.variants({para, cokme, kahve}, vocabulary)
        self.assertEqual(found[para][0], para, "the word itself first")
        self.assertIn(beyin_v3._stem("fiyat"), found[para])
        self.assertIn(beyin_v3._stem("crash"), found[cokme])
        self.assertNotIn(kahve, found, "a word without a group is matched as it is")


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="v3-hafiza-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.vault = root / "vault"
        self.vault.mkdir()
        self.store = beyin_v3.MemoryStore(root / "state", self.vault)
        self.addCleanup(self.store.close)

    def ingest(self, ident, text, source, **kwargs):
        path = self.vault / source
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        record = dict(id=ident, kind="note", status="active", visibility="internal", text=text, facts={},
                      source=source, updated_at="2026-10-11T10:00:00Z")
        record.update(kwargs)
        self.store.ingest(record)

    def ids(self, query, today=WEDNESDAY):
        return [one["id"] for one in self.store.context_for("claude", query, strict=True, today=today)["records"]]

    def test_a_question_that_names_a_day_gets_that_days_log_first(self):
        self.ingest("dun", "Zeynep çizimlerin ilk taslağını gönderdi. Akşam koşu.", "daily/2026-10-20.md")
        self.ingest("evvel", "Zeynep ile görüşme yok.", "daily/2026-10-19.md")
        self.ingest("not", "Zeynep tasarımcı, çizim teslimi kasımda.", "notes/kisiler/zeynep.md")
        self.assertEqual(self.ids("dün Zeynep çizim gönderdi mi")[0], "dun")
        self.assertNotIn("evvel", self.ids("dün Zeynep çizim gönderdi mi"))

    def test_a_log_answers_only_when_no_note_does(self):
        self.ingest("log", "Macbook bataryası değişti, servis 4.200 TL aldı.", "daily/2026-10-18.md")
        self.ingest("v3", "Macbook bataryası makbuzu.", "daily/v3/2026-10-18.md")
        self.assertEqual(self.ids("macbook bataryası ne kadar tuttu"), ["log"], "the engine's daily/v3 never")
        self.ingest("note", "Macbook bataryası garantide, servis Kadıköy'de.", "notes/macbook.md")
        self.assertEqual(self.ids("macbook bataryası ne kadar tuttu"), ["note"])

    def test_a_synonym_counts_as_the_word_it_stands_for(self):
        self.ingest("teklif", "Kuzey Lojistik fiyat teklifi: toplam 480.000 TL, üç taksit.", "projects/kuzey/teklif.md")
        self.ingest("baska", "Kuzey Lojistik sprint notları, şoför uygulaması.", "projects/kuzey/sprint.md")
        self.assertEqual(self.ids("kuzey lojistikten toplamda ne kadar para istemiştik")[0], "teklif")


class TurkishVaultBenchmarkTest(unittest.TestCase):
    """tests/fixtures/hafiza_tr: a realistic Turkish vault and questions written blind to the
    search. The floors hold today's result; a change that lowers it has to say why."""

    def test_the_turkish_vault_benchmark(self):
        import evaluate_v3_hafiza as benchmark
        with tempfile.TemporaryDirectory(prefix="v3-hafiza-olcum-") as work:
            store, _vault, _state = benchmark.prepare(work=Path(work) / "is")
            rows, _by_type, total = benchmark.score(benchmark.load(), lambda query: benchmark.deliver(store, query))
        sensitive = [row for row in rows for source in row["verilen"]
                     if source.startswith("🔐 Kasa/") or source in {
                         "🛠️ 600-Arsenal/Ev Ağı ve Cihazlar.md", "🧠 500-Knowledge/Sağlık/Kan Tahlili Ekim 2026.md"}]
        self.assertEqual(sensitive, [], "a private note or the 🔐 folder reached the assistant")
        self.assertGreaterEqual(total["bulundu"] / total["cevapli"], 0.68)
        self.assertGreaterEqual(total["sustu"] / total["cevapsiz"], 0.85)


if __name__ == "__main__":
    unittest.main()
