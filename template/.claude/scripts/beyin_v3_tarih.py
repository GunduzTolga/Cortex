"""The days a question names, for the per-turn search (#hafiza).

"dün neler yaptım", "geçen cuma Zeynep'ten ne gelmişti", "12 Ekim'de ne konuştuk": the
answer is in that day's log (daily/YYYY-MM-DD.md), which the per-turn search leaves out
because logs repeat every word of the vault. A question that names a day gets that day's log;
a question that names none is searched as before.

Only days a person names outright: today, yesterday, the day before, a weekday said with
"geçen" or "bu" or followed by "günü", a day and month, and an ISO or dotted date. A weekday
alone ("cuma toplantısı") is a habit, not a day; "geçen hafta" is a week, not a day.
"""
from __future__ import annotations

import datetime
import re
import unicodedata

MONTHS = ("ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik")
WEEKDAYS = ("pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar")
MOST_DAYS = 3

_WEEKDAY = "|".join(sorted(WEEKDAYS, key=len, reverse=True))
_MONTH = "|".join(MONTHS)
_NAMED_WEEKDAY = re.compile(
    r"\b(?:(gecen|bu|onceki)\s+(" + _WEEKDAY + r")[a-z]*|(" + _WEEKDAY + r")\s+gun[a-z]*)\b")
_DAY_MONTH = re.compile(r"\b([0-3]?[0-9])\s+(" + _MONTH + r")[a-z]*(?:\s+(20[0-9]{2}))?\b")
_ISO = re.compile(r"\b(20[0-9]{2})-([01][0-9])-([0-3][0-9])\b")
_DOTTED = re.compile(r"\b([0-3]?[0-9])[./]([01]?[0-9])[./](20[0-9]{2})\b")
_RELATIVE = (
    (re.compile(r"\b(?:evvelsi\s+gun|onceki\s+gun|dunden\s+onceki)"), 2),
    (re.compile(r"\bdun(?:ku|ki|u)?\b"), 1),
    (re.compile(r"\bbugun(?:ku|ki|u)?\b"), 0),
)


def _fold(text):
    text = unicodedata.normalize("NFKD", str(text).casefold())
    text = "".join(c for c in text if not unicodedata.combining(c)).replace("ı", "i")
    return re.sub(r"['’]", " ", text)


def _past(day, today):
    """A day and month without a year: this year's when it has come; last year's when this
    year's is more than half a year ahead ("28 Aralık" asked in January); else none, for a
    day still to come is a deadline, not a log ("teslim 15 Kasım")."""
    if day <= today:
        return day
    if (day - today).days > 183:
        try:
            return day.replace(year=day.year - 1)
        except ValueError:  # 29 February
            return None
    return None


def days(query, today=None):
    """The calendar days the question names, at most MOST_DAYS, in the order said."""
    today = today or datetime.date.today()
    text = _fold(query)
    found = []

    def add(day):
        if day is not None and day <= today and day not in found and len(found) < MOST_DAYS:
            found.append(day)
    for pattern, back in _RELATIVE:
        if pattern.search(text):
            add(today - datetime.timedelta(days=back))
            if back == 2:
                text = pattern.sub(" ", text)  # "önceki gün" is not also a weekday's "önceki"
    for match in _NAMED_WEEKDAY.finditer(text):
        word, name = match.group(1), match.group(2) or match.group(3)
        target = WEEKDAYS.index(name)
        back = (today.weekday() - target) % 7
        if word in ("gecen", "onceki") and back == 0:
            back = 7  # "geçen cuma" said on a Friday is a week ago
        add(today - datetime.timedelta(days=back))
    for match in _DAY_MONTH.finditer(text):
        try:
            day = datetime.date(int(match.group(3) or today.year), MONTHS.index(match.group(2)) + 1, int(match.group(1)))
        except ValueError:
            continue
        add(day if match.group(3) else _past(day, today))
    for match in _ISO.finditer(text):
        try:
            add(datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3))))
        except ValueError:
            continue
    for match in _DOTTED.finditer(text):
        try:
            add(datetime.date(int(match.group(3)), int(match.group(2)), int(match.group(1))))
        except ValueError:
            continue
    return found


_LOG = re.compile(r"^daily/(?:v3/)?([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$")


def day_of(source):
    """The day a daily log is named for; None for any other note."""
    match = _LOG.match(str(source))
    if not match:
        return None
    try:
        return datetime.date.fromisoformat(match.group(1))
    except ValueError:
        return None
