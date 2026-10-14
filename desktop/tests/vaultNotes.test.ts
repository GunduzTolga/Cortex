import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  captureFolder,
  fillTemplate,
  freeName,
  insertTemplate,
  isTemplatesFolder,
  retitle,
  fuzzyMatch,
  makeResolver,
  nameProblem,
  parseNote,
  parseQuery,
  proseOnly,
  relativeHref,
  relink,
  landingOf,
  searchNote,
  shortestLink,
  splitProperties,
  splitWikiLink,
  vaultGraph,
  type IndexedNote,
} from '../core/vaultNotes';

/**
 * The person's notes as the Cortex side's notes screen reads them
 * (core/vaultNotes.ts): in Obsidian's own terms, so that a note written in
 * either reads the same in the other.
 */

test('the properties block is the first thing in the file or it is not one, and its values stay the text the person wrote', () => {
  const note = '---\ntags: [proje, "kod/krewgent"]\naliases: Kasa notu, Vault\ncreated: 2026-10-14\nrating: 4\ndone: false\n---\n# Başlık\n';
  const facts = parseNote(note);
  assert.equal(facts.propertiesBroken, false);
  assert.deepEqual(facts.properties.find((one) => one.key === 'created')?.value, '2026-10-14', 'a date is not turned into an object');
  assert.equal(facts.properties.find((one) => one.key === 'rating')?.value, 4);
  assert.equal(facts.properties.find((one) => one.key === 'done')?.value, false);
  assert.deepEqual(facts.tags, ['proje', 'kod/krewgent']);
  assert.deepEqual(facts.aliases, ['Kasa notu', 'Vault']);
  assert.equal(facts.bodyLine, 7);
  assert.deepEqual(facts.headings, [{ level: 1, text: 'Başlık', line: 7 }]);

  assert.equal(splitProperties('﻿---\na: 1\n---\nbody').body, 'body', 'a byte-order mark is not the first thing in the file');
  assert.equal(splitProperties('---\na: 1\nbody without a fence').yaml, null, 'a block never closed is not a block');
  assert.equal(splitProperties('text\n---\na: 1\n---\n').yaml, null, 'a rule further down is a rule');
  assert.equal(splitProperties('---\n---\nbody').body, 'body', 'an empty block is a block');

  const broken = parseNote('---\ntags: [unclosed\n---\n#real\n');
  assert.equal(broken.propertiesBroken, true);
  assert.deepEqual(broken.properties, [], 'a block that will not parse gives no properties, as in Obsidian');
  assert.deepEqual(broken.tags, ['real'], 'and the body is still read');
});

test('wiki links carry their heading, block and alias; embeds are links drawn in place', () => {
  const facts = parseNote('See [[Proje planı]], [[Ev/Tadilat#Mutfak|mutfak]], [[#Yerel]], [[Not#^abc123]] and ![[çizim.png]].\n');
  assert.deepEqual(
    facts.links.map(({ kind, target, subpath, alias, embed }) => ({ kind, target, subpath, alias, embed })),
    [
      { kind: 'wiki', target: 'Proje planı', subpath: null, alias: null, embed: false },
      { kind: 'wiki', target: 'Ev/Tadilat', subpath: 'Mutfak', alias: 'mutfak', embed: false },
      { kind: 'wiki', target: '', subpath: 'Yerel', alias: null, embed: false },
      { kind: 'wiki', target: 'Not', subpath: '^abc123', alias: null, embed: false },
      { kind: 'wiki', target: 'çizim.png', subpath: null, alias: null, embed: true },
    ],
  );
  assert.deepEqual(splitWikiLink('Not\\|takma'), { target: 'Not', subpath: null, alias: 'takma' }, "a table's escaped pipe is still the alias");
  const md = parseNote('[plan](../Planlar/Yeni%20plan.md#Hedef) [site](https://example.com) ![](resim.png) [mail](mailto:a@b.c)\n');
  assert.deepEqual(
    md.links.map(({ kind, target, subpath, embed }) => ({ kind, target, subpath, embed })),
    [
      { kind: 'markdown', target: '../Planlar/Yeni plan.md', subpath: 'Hedef', embed: false },
      { kind: 'markdown', target: 'resim.png', subpath: null, embed: true },
    ],
    'a link off the machine is not a note of the vault',
  );
});

test('a link in code, in a comment or in the properties is text, as Obsidian draws it', () => {
  const note = [
    '---',
    'related: "[[Properties link]]"',
    '---',
    '```js',
    'const a = "[[In code]]";',
    '```',
    'Inline `[[Ticked]]` and %% [[Hidden]] %% and <!-- [[Html]] -->.',
    '%% a comment',
    '[[Still hidden]]',
    'over lines %% [[After]]',
    '~~~',
    '#notatag',
    '~~~',
    '#real-tag and [[Real]]',
  ].join('\n');
  const facts = parseNote(note);
  assert.deepEqual(facts.links.map((one) => one.target), ['After', 'Real']);
  assert.deepEqual(facts.tags, ['real-tag']);
  const prose = proseOnly(note);
  assert.equal(prose.length, note.length, 'blanked character for character, so a position is the same in both');
  assert.equal(facts.links[1].line, 13);
  assert.equal(note.slice(facts.links[1].start, facts.links[1].end), '[[Real]]');
});

test('tags: a heading is not one, a number is not one, a colour in a URL is not one, and case does not make two', () => {
  const facts = parseNote('# Heading\n#Proje and #proje, #2026, #a/b, http://x.com/#anchor, (#içinde)\n## Başlık #etiket\n');
  assert.deepEqual(facts.tags, ['Proje', 'a/b', 'içinde', 'etiket']);
  assert.deepEqual(facts.headings.map((one) => [one.level, one.text]), [[1, 'Heading'], [2, 'Başlık #etiket']]);
});

test('headings are read without their Markdown, blocks by their id, and words are counted', () => {
  const facts = parseNote('# A **bold** [[Link|link]] heading ##\nText here ^blok-1\n');
  assert.equal(facts.headings[0].text, 'A bold link heading');
  assert.deepEqual(facts.blocks, [{ id: 'blok-1', line: 1 }]);
  assert.equal(facts.words, 8);
});

const VAULT = [
  'Proje planı.md',
  'Ev/Tadilat.md',
  'Ev/Notlar/Liste.md',
  'İş/Liste.md',
  'Liste.md',
  'Kişisel/Sağlık.md',
  'ekler/çizim.png',
  'v1.2.md',
  'v1.2',
  'Planlar/Yeni plan.md',
];

test('a name finds the note of that name anywhere, case and Turkish I aside; a path from the top, then from here, then by its ending', () => {
  const resolve = makeResolver(VAULT);
  assert.equal(resolve('proje PLANI', 'Ev/Tadilat.md'), 'Proje planı.md');
  assert.equal(resolve('Tadilat', 'Proje planı.md'), 'Ev/Tadilat.md');
  assert.equal(resolve('Tadilat.md', 'Proje planı.md'), 'Ev/Tadilat.md');
  assert.equal(resolve('ev/tadilat', 'x.md'), 'Ev/Tadilat.md');
  assert.equal(resolve('Notlar/Liste', 'x.md'), 'Ev/Notlar/Liste.md', 'by its ending');
  assert.equal(resolve('IŞ/liste', 'x.md'), 'İş/Liste.md', 'İ and I fold onto i');
  assert.equal(resolve('çizim.png', 'Ev/Tadilat.md'), 'ekler/çizim.png');
  assert.equal(resolve('v1.2', 'x.md'), 'v1.2.md', 'a note before a file of the same name');
  assert.equal(resolve('Yok', 'x.md'), null);
  assert.equal(resolve('Tadi', 'x.md'), null, 'a name is whole');
  assert.equal(resolve('Proje planı'.normalize('NFD'), 'x.md'), 'Proje planı.md');
});

test('two notes of one name: the one beside the linking note, else the one nearest the top', () => {
  const resolve = makeResolver(VAULT);
  assert.equal(resolve('Liste', 'İş/Rapor.md'), 'İş/Liste.md');
  assert.equal(resolve('Liste', 'Ev/Notlar/Yeni.md'), 'Ev/Notlar/Liste.md');
  assert.equal(resolve('Liste', 'Kişisel/Sağlık.md'), 'Liste.md');
});

test("a Markdown link is read from the linking note's folder first, and never climbs out of the vault", () => {
  const resolve = makeResolver(VAULT);
  assert.equal(resolve('../Planlar/Yeni plan.md', 'Ev/Tadilat.md', 'markdown'), 'Planlar/Yeni plan.md');
  assert.equal(resolve('Tadilat.md', 'Ev/Notlar/Liste.md', 'markdown'), 'Ev/Tadilat.md', 'by name when not beside it');
  assert.equal(resolve('Liste.md', 'Ev/Notlar/Yeni.md', 'markdown'), 'Ev/Notlar/Liste.md');
  assert.equal(resolve('../../../etc/passwd', 'Ev/Tadilat.md', 'markdown'), null);
});

test('the shortest link is the name when only one file answers to it', () => {
  assert.equal(shortestLink('Ev/Tadilat.md', VAULT), 'Tadilat');
  assert.equal(shortestLink('İş/Liste.md', VAULT), 'İş/Liste');
  assert.equal(shortestLink('ekler/çizim.png', VAULT), 'çizim.png');
});

/** The vault after a move, and `relink` run over one note of it. */
function afterMove(moves: Array<{ from: string; to: string }>, note: string, text: string) {
  const movedTo = landingOf(moves);
  const after = VAULT.map(movedTo);
  return relink(text, { was: note, now: movedTo(note) }, makeResolver(VAULT), makeResolver(after), movedTo, after);
}

test('a rename points every link to the note at its new name and keeps its heading, block and alias', () => {
  const text = 'A [[Tadilat]], [[Ev/Tadilat#Mutfak|mutfak]], ![[Tadilat#^b1]], [[Proje planı]], `[[Tadilat]]`, [md](Ev/Tadilat.md#Mutfak) and | [[Tadilat\\|t]] |.\n';
  const { text: out, changed } = afterMove([{ from: 'Ev/Tadilat.md', to: 'Ev/Yenileme 2026.md' }], 'Proje planı.md', text);
  assert.equal(changed, 5);
  assert.equal(
    out,
    'A [[Yenileme 2026]], [[Yenileme 2026#Mutfak|mutfak]], ![[Yenileme 2026#^b1]], [[Proje planı]], `[[Tadilat]]`, [md](Ev/Yenileme%202026.md#Mutfak) and | [[Yenileme 2026\\|t]] |.\n',
  );
  assert.equal(relativeHref('Ev/Notlar/Liste.md', 'Ev/Tadilat.md'), '../Tadilat.md');
  assert.equal(relativeHref('Proje planı.md', 'Kişisel/Sağlık.md'), 'Ki%C5%9Fisel/Sa%C4%9Fl%C4%B1k.md');
});

test('a move rewrites only the links that would lose their file: a name still finds it, a path does not', () => {
  const moves = [{ from: 'Ev/Tadilat.md', to: 'Planlar/Tadilat.md' }];
  const { text, changed } = afterMove(moves, 'Proje planı.md', 'By name [[Tadilat]], by path [[Ev/Tadilat|t]], [md](Ev/Tadilat.md).\n');
  assert.equal(changed, 2);
  assert.equal(text, 'By name [[Tadilat]], by path [[Tadilat|t]], [md](Planlar/Tadilat.md).\n');
  assert.deepEqual(afterMove(moves, 'Proje planı.md', 'Only [[Tadilat]].\n'), { text: 'Only [[Tadilat]].\n', changed: 0, lost: 0 }, 'nothing churned');
});

test('the moved note keeps its own Markdown links, written from where it is now', () => {
  const { text, changed } = afterMove([{ from: 'Ev/Tadilat.md', to: 'Planlar/Eski/Tadilat.md' }], 'Ev/Tadilat.md', '[liste](Notlar/Liste.md), [[Proje planı]], [yeni](../Planlar/Yeni%20plan.md)\n');
  assert.equal(changed, 2);
  assert.equal(text, '[liste](../../Ev/Notlar/Liste.md), [[Proje planı]], [yeni](../Yeni%20plan.md)\n');
});

test('a folder moved takes everything under it, and a note arriving beside a link of its name does not take that link', () => {
  const folder = afterMove([{ from: 'Ev', to: 'Konut' }], 'Proje planı.md', '[[Ev/Notlar/Liste]] and [[Tadilat]] and [x](Ev/Tadilat.md)\n');
  assert.equal(folder.text, '[[Konut/Notlar/Liste]] and [[Tadilat]] and [x](Konut/Tadilat.md)\n');
  assert.equal(landingOf([{ from: 'Ev', to: 'Konut' }])('Ev/Notlar/Liste.md'), 'Konut/Notlar/Liste.md');
  assert.equal(landingOf([{ from: 'Ev', to: 'Konut' }])('Evler/x.md'), 'Evler/x.md', 'a folder is whole by name');
  // `[[Liste]]` from Kişisel/ found the top's Liste.md; İş/Liste.md arriving in Kişisel/ takes it, and no wiki link can name the top's apart from it.
  const resolveAfter = makeResolver(VAULT.map(landingOf([{ from: 'İş/Liste.md', to: 'Kişisel/Liste.md' }])));
  assert.equal(resolveAfter('Liste', 'Kişisel/Sağlık.md'), 'Kişisel/Liste.md', 'the arriving note is beside it now');
  assert.deepEqual(afterMove([{ from: 'İş/Liste.md', to: 'Kişisel/Liste.md' }], 'Kişisel/Sağlık.md', 'See [[Liste]].\n'), { text: 'See [[Liste]].\n', changed: 0, lost: 1 });
  assert.deepEqual(
    afterMove([{ from: 'Ev/Notlar/Liste.md', to: 'Kişisel/Liste.md' }], 'Kişisel/Sağlık.md', 'See [[İş/Liste]].\n'),
    { text: 'See [[İş/Liste]].\n', changed: 0, lost: 0 },
    'a path still finds its own',
  );
});

test('a name Windows or a wiki link would not take is refused, and a free one is found', () => {
  assert.equal(nameProblem('Proje planı'), null);
  assert.equal(nameProblem('  '), 'empty');
  for (const bad of ['a/b', 'a:b', 'a#b', 'a^b', 'a[b]', 'a|b', 'a?', 'a*']) assert.equal(nameProblem(bad), 'characters', bad);
  assert.equal(nameProblem('.gizli'), 'dot');
  assert.equal(nameProblem('sonu.'), 'dot');
  assert.equal(nameProblem('CON'), 'reserved');
  assert.equal(nameProblem('x'.repeat(181)), 'long');
  assert.equal(freeName('Adsız', ['Başka']), 'Adsız');
  assert.equal(freeName('Adsız', ['adsiz', 'Adsız 1']), 'Adsız 2');
});

test('search: every word somewhere, a title worth more than a body, tags and paths as filters, lines with their marks', () => {
  const query = parseQuery('kahve "sabah rutini" tag:#alışkanlık path:kişisel');
  assert.deepEqual(query, { terms: ['kahve', 'sabah rutini'], tags: ['alişkanlik'], paths: ['kişisel'] }, 'folded as titles are matched');
  const text = '# Sabah\nHer gün sabah rutini ile başlar.\nKahve önce, KAHVE sonra.\n';
  const hit = searchNote('Kişisel/Kahve.md', text, { tags: ['Alışkanlık/sabah'], aliases: [] }, query);
  assert.ok(hit);
  assert.equal(hit.count, 3);
  assert.deepEqual(hit.lines.map((one) => one.line), [1, 2]);
  assert.deepEqual(hit.lines[1].marks, [[0, 5], [12, 17]]);
  assert.equal(searchNote('İş/Kahve.md', text, { tags: ['alışkanlık'], aliases: [] }, query), null, 'outside the path');
  assert.equal(searchNote('Kişisel/Kahve.md', text, { tags: [], aliases: [] }, query), null, 'without the tag');
  const inTitle = searchNote('Kahve.md', 'nothing', { tags: [], aliases: [] }, parseQuery('kahve'))!;
  const inBody = searchNote('Not.md', 'kahve kahve kahve', { tags: [], aliases: [] }, parseQuery('kahve'))!;
  assert.ok(inTitle.score > inBody.score);
  assert.equal(searchNote('Not.md', 'ISPARTA', { tags: [], aliases: [] }, parseQuery('ısparta'))?.count, 1, 'Turkish I folds');
});

test('the quick switcher finds letters in order and ranks a run and a word start first', () => {
  assert.ok(fuzzyMatch('pp', 'Proje planı'));
  assert.equal(fuzzyMatch('xyz', 'Proje planı'), null);
  const exact = fuzzyMatch('plan', 'Proje planı')!;
  const scattered = fuzzyMatch('plan', 'Pazar listesi ana')!;
  assert.ok(exact.score > scattered.score);
  assert.deepEqual(exact.indices, [6, 7, 8, 9]);
  assert.deepEqual(fuzzyMatch('pp', 'Proje planı')!.indices, [0, 6], 'the second p is the start of a word');
  assert.ok(fuzzyMatch('ıs', 'İş/Liste'));
});

const INDEX: IndexedNote[] = [
  { path: 'A.md', modified: 0, size: 1, aliases: [], tags: ['x'], links: ['B.md', 'pic.png'], unresolved: ['Yazılacak'] },
  { path: 'B.md', modified: 0, size: 1, aliases: [], tags: [], links: ['C.md'], unresolved: [] },
  { path: 'C.md', modified: 0, size: 1, aliases: [], tags: [], links: [], unresolved: [] },
  { path: 'D.md', modified: 0, size: 1, aliases: [], tags: [], links: [], unresolved: [] },
];

test('the graph is drawn from the links that are there, with orphans, missing notes, tags and files as the person chooses', () => {
  const all = vaultGraph(INDEX, ['pic.png'], { around: null, depth: 1, orphans: false, missing: false, tags: false, files: false });
  assert.deepEqual(all.nodes.map((one) => one.id).sort(), ['A.md', 'B.md', 'C.md']);
  assert.equal(all.edges.length, 2);
  const everything = vaultGraph(INDEX, ['pic.png'], { around: null, depth: 1, orphans: true, missing: true, tags: true, files: true });
  assert.deepEqual(everything.nodes.map((one) => one.id).sort(), ['A.md', 'B.md', 'C.md', 'D.md', 'missing:yazilacak', 'pic.png', 'tag:x']);
  assert.equal(everything.nodes.find((one) => one.id === 'A.md')!.degree, 4);
  const local = vaultGraph(INDEX, [], { around: 'C.md', depth: 1, orphans: false, missing: false, tags: false, files: false });
  assert.deepEqual(local.nodes.map((one) => one.id).sort(), ['B.md', 'C.md']);
  const deeper = vaultGraph(INDEX, [], { around: 'C.md', depth: 2, orphans: false, missing: false, tags: false, files: false });
  assert.deepEqual(deeper.nodes.map((one) => one.id).sort(), ['A.md', 'B.md', 'C.md']);
});

test("a template is filled in Cortex's and Obsidian's placeholders, and Cortex's empty title and heading are given the note's name", () => {
  const now = new Date(2026, 9, 14, 9, 5, 7);
  const cortex = '---\ntitle:\ncreated: {{TODAY}}\nmodified: {{TODAY}}\ntype: note\ntags: []\n---\n# \n';
  assert.equal(fillTemplate(cortex, 'Toplantı: plan', now), '---\ntitle: "Toplantı: plan"\ncreated: 2026-10-14\nmodified: 2026-10-14\ntype: note\ntags: []\n---\n# Toplantı: plan\n');
  assert.equal(fillTemplate('{{date}} {{time}} {{date:DD.MM.YYYY HH:mm:ss}} {{ title }}', 'X', now), '2026-10-14 09:05 14.10.2026 09:05:07 X');
  assert.equal(fillTemplate('# Kept\n# \n', 'Y', now), '# Kept\n# Y\n', 'only an empty heading is filled');
});

test('a template goes in at the cursor, its properties to the top only when the note has none', () => {
  assert.deepEqual(insertTemplate('Önce\n', 5, '- [ ] madde\n'), { text: 'Önce\n- [ ] madde\n', cursor: 17 });
  const withOwn = insertTemplate('---\na: 1\n---\nGövde\n', 0, '---\nb: 2\n---\nŞablon\n');
  assert.deepEqual(withOwn, { text: '---\na: 1\n---\nŞablon\nGövde\n', cursor: 20 }, 'one note, one properties block, and not inside it');
  assert.deepEqual(insertTemplate('Gövde\n', 6, '---\nb: 2\n---\nŞablon\n'), { text: '---\nb: 2\n---\nGövde\nŞablon\n', cursor: 26 });
});

test('a renamed note carries its new name where it repeated the old one, and nowhere else', () => {
  assert.equal(retitle('---\ntitle: "Adsız"\ntype: note\n---\n# Adsız\n\n# Adsız\n', 'Adsız', 'Plan'), '---\ntitle: "Plan"\ntype: note\n---\n# Plan\n\n# Adsız\n');
  assert.equal(retitle('---\ntitle:\n---\n# Başka\n', 'Adsız', 'Plan'), '---\ntitle: "Plan"\n---\n# Başka\n');
  assert.equal(retitle('---\ntitle: Kendi başlığım\n---\nGövde title: Adsız\n', 'Adsız', 'Plan'), '---\ntitle: Kendi başlığım\n---\nGövde title: Adsız\n');
});

test("a quick note goes to Cortex's inbox dump, its inbox, or the top, and templates are found by their folder's name", () => {
  assert.equal(captureFolder(['📥 000-Inbox', '📥 000-Inbox/Dump', 'daily']), '📥 000-Inbox/Dump');
  assert.equal(captureFolder(['📥 000-Inbox']), '📥 000-Inbox');
  assert.equal(captureFolder(['Notlar']), '');
  assert.ok(isTemplatesFolder('📋 Templates') && isTemplatesFolder('Templates') && isTemplatesFolder('Ev/Templates'));
  assert.ok(!isTemplatesFolder('MyTemplates') && !isTemplatesFolder('Templates eski'));
});
