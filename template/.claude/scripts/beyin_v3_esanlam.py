"""Words that mean the same thing, for the per-turn search (#hafiza).

A note says "fiyat teklifi" and the question asks "ne kadar para istemiştik"; a note says
"crash" and the question asks "çökme". The search matches stems, so such a question found
nothing. A question's word also matches the other words of its group here, and the group
counts as that one word: the question's coverage does not grow with it.

Only words that stand for one another in a person's notes, Turkish and the English a Turkish
vault is full of. A word with another everyday sense stays out ("kur": exchange rate, and to
set up; "ders": lesson, and a course). Each line is a group; a word may sit in two groups.
"""
from __future__ import annotations

import functools

GROUPS = """
para ücret fiyat tutar bedel maliyet ödeme price cost fee
bütçe budget
maaş salary
kira rent
vergi tax
fatura invoice
avans advance
teklif offer proposal quote
sözleşme kontrat contract
müşteri client customer
toplantı görüşme meeting
teslim deadline
sürüm release version
lansman launch
fiyatlandırma pricing
abonelik subscription
kullanıcı user
hata bug error
çökme crash
oran rate
sunucu server
şifre parola password
eposta email mail
düzenleme refactor
senkronizasyon eşitleme sync
çizim illüstrasyon illustration drawing
ev daire konut home house
tadilat yenileme renovasyon tamirat onarım renovation
spor antrenman egzersiz idman gym workout fitness
muhasebeci muhasebe müşavir accountant
ilaç hap tablet medication pill
doktor hekim doctor
uyku uyumak sleep
alerji allergy
aşı vaccine
doğum birthday
kedi cat
köpek dog
şoför sürücü driver
tez thesis
danışman advisor supervisor
""".strip()


@functools.lru_cache(maxsize=1)
def _groups():
    """stem -> the stems it stands with."""
    from beyin_v3 import _tokens
    table = {}
    for line in GROUPS.splitlines():
        stems = set()
        for word in line.split():
            stems |= _tokens(word)
        for stem in stems:
            table.setdefault(stem, set()).update(stems - {stem})
    return {stem: frozenset(others) for stem, others in table.items()}


def variants(terms, vocabulary):
    """term -> the term and the vault's words of its group, the term first; only terms with a
    group word in the vault are listed."""
    table = _groups()
    result = {}
    for term in terms:
        others = sorted(stem for stem in table.get(term, ()) if stem in vocabulary)
        if others:
            result[term] = (term, *others)
    return result
