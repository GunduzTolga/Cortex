import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { turkishOf } from '../shared/refusalsTr';
import { useApp } from '../src/store/app';

/**
 * The main process's sentences, in Turkish (shared/refusalsTr.ts).
 *
 * A Turkish window showed a Turkish title over the English sentence the main
 * process threw. These hold the translation to the sentences as they are
 * thrown: what a sentence carries comes back as it was, a sentence no rule
 * knows comes back untouched, and every sentence thrown under electron/ has a
 * rule - read from the source, so the next English sentence written there
 * fails here until it is given its Turkish.
 */

test('a sentence with a path, a name or a folder keeps them as they were', () => {
  assert.equal(turkishOf('Not a note: Notes/x.md'), 'Not değil: Notes/x.md');
  assert.equal(turkishOf('Not a folder: Projeler/2026'), 'Klasör değil: Projeler/2026');
  assert.equal(turkishOf('A note named Plan is already in Projeler/2026.'), 'Projeler/2026 klasöründe Plan adında bir not zaten var.');
  assert.equal(turkishOf('Something named Taslak.md is already in Gelen.'), 'Gelen klasöründe Taslak.md adında bir şey zaten var.');
  assert.equal(turkishOf('The vault Beyin is not where it was any more.'), 'Beyin kasası artık olduğu yerde değil.');
  assert.equal(turkishOf('Raporlar is not a folder any more.'), 'Raporlar artık bir klasör değil.');
  assert.equal(turkishOf('No free name for Plan.md was found.'), 'Plan.md için boş bir ad bulunamadı.');
  // What looks like a pattern or a replacement inside the path is only text.
  assert.equal(turkishOf('Not a note: a (b) [c] $1 $&.md'), 'Not değil: a (b) [c] $1 $&.md');
});

test('the vault said by its own words is said in Turkish, not carried over', () => {
  assert.equal(turkishOf('A note named Plan is already in the vault.'), 'Kasada Plan adında bir not zaten var.');
  assert.equal(turkishOf('Something named Plan is already in the vault.'), 'Kasada Plan adında bir şey zaten var.');
  // The one sentence that begins as another: the specific one wins.
  assert.equal(turkishOf('No free name for a new note was found.'), 'Yeni not için boş bir ad bulunamadı.');
});

test('why a name was refused is said in Turkish, and left out when it is not known', () => {
  assert.equal(turkishOf('Not a name a note can have (reserved): con'), 'Bir not bu adı alamaz (Windows bu adı kendine ayırıyor): con');
  assert.equal(turkishOf('Not a name a folder can have (dot): .gizli'), 'Bir klasör bu adı alamaz (ad nokta ile başlayamaz, nokta ya da boşlukla bitemez): .gizli');
  assert.equal(turkishOf('Not a name it can have (empty): '), 'Bu ad verilemez (ad boş): ');
  assert.equal(turkishOf('Not a name it can have (sideways): x'), 'Bu ad verilemez: x');
});

test('what is not done to a note Cortex keeps is said in Turkish', () => {
  assert.equal(turkishOf('Cortex keeps Raporlar/x.md itself: it is not put in the bin from here.'), 'Cortex bunu kendisi tutuyor, buradan çöpe taşınamaz: Raporlar/x.md');
  assert.equal(
    turkishOf('Raporlar holds notes Cortex keeps (Raporlar/x.md): it is not moved or renamed from here.'),
    'Bu klasörde Cortex’in tuttuğu notlar var (Raporlar/x.md), buradan taşınamaz ya da yeniden adlandırılamaz: Raporlar',
  );
  assert.equal(turkishOf('Cortex keeps a.md itself: it is not copied from here.'), 'Cortex bunu kendisi tutuyor, buradan değiştirilemez: a.md');
});

test('a tool or a model server keeps its name, and a program its own words', () => {
  assert.equal(turkishOf('opencode is not installed on this machine.'), 'opencode bu bilgisayarda kurulu değil.');
  assert.equal(turkishOf('Claude Code is not installed on this machine.'), 'Claude Code bu bilgisayarda kurulu değil.');
  assert.equal(turkishOf('LM Studio is not running. Open it, load a model, and write again.'), 'LM Studio çalışmıyor. Uygulamayı aç, bir model yükle ve yeniden yaz.');
  assert.equal(turkishOf('Ollama has no model.'), 'Ollama: yüklü bir model yok.');
  assert.equal(turkishOf('Codex could not answer.'), 'Codex cevap veremedi.');
  assert.equal(turkishOf('Claude Code stopped: Error: spawn EPERM'), 'Claude Code durdu: Error: spawn EPERM');
  assert.equal(
    turkishOf('The program stopped: panic at main.rs A message longer than 16777216 bytes: the program was stopped.'),
    'Program durdu: panic at main.rs 16777216 bayttan uzun bir mesaj geldi: program durduruldu.',
  );
});

test('a sentence no rule knows comes back as it came', () => {
  for (const said of [
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'ENOENT: no such file or directory, open \'x.md\'',
    'LM Studio: model not loaded',
    'Önce kasayı seç.',
    '',
    // Only the whole sentence is known, not a sentence that holds one.
    'Why: Not a note: x.md',
    'Choose the vault first. Then write.',
  ]) {
    assert.equal(turkishOf(said), said);
  }
});

test('the toasts say the main process in Turkish while the window is in Turkish, and as it was in English', () => {
  const shown = () => useApp.getState().toasts.at(-1);
  useApp.setState({ toasts: [], settings: { ...useApp.getState().settings, language: null } });
  useApp.getState().toast({ tone: 'error', title: 'Not yeniden adlandırılamadı', detail: 'Not a note: Notes/x.md', sticky: true });
  assert.equal(shown()?.detail, 'Not değil: Notes/x.md');
  assert.equal(shown()?.title, 'Not yeniden adlandırılamadı');

  useApp.setState({ settings: { ...useApp.getState().settings, language: 'tr' } });
  useApp.getState().toast({ tone: 'error', title: 'x', detail: 'Choose the vault first.', sticky: true });
  assert.equal(shown()?.detail, 'Önce kasayı seç.');

  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' } });
  useApp.getState().toast({ tone: 'error', title: 'Could not rename', detail: 'Not a note: Notes/x.md', sticky: true });
  assert.equal(shown()?.detail, 'Not a note: Notes/x.md');

  useApp.getState().toast({ tone: 'success', title: 'Saved', sticky: true });
  assert.equal(shown()?.detail, undefined);
  useApp.setState({ toasts: [] });
});

test('no circumflex: the Turkish is written the way the rest of the window writes it', () => {
  assert.doesNotMatch(fs.readFileSync('shared/refusalsTr.ts', 'utf8'), /[\u00e2\u00c2]/);
});

/* ------------------------------------------------------------------ */
/* Every sentence thrown under electron/ has its Turkish               */
/* ------------------------------------------------------------------ */

/** Speak the window's language themselves (`say(tr, en)`), and have their own tests. */
const TURKISH_ALREADY = new Set([path.join('electron', 'services', 'setup.ts'), path.join('electron', 'services', 'officeTalk.ts')]);

/**
 * Thrown, and never shown: each is caught where it is thrown, or answered to
 * the program that asked rather than to the window. Written here with what a
 * `${...}` part stands in as `HOLE`.
 */
const NEVER_SHOWN = new Set([
  // settings.ts: caught three lines down, and the settings file set aside.
  'the settings file holds no object',
  // vaultNotes.ts: caught at once, and the bin's record set aside.
  'no items',
  // acpChat.ts, codexChat.ts: the JSON-RPC answer to a request the program made, never the window's.
  'Cortex does not answer HOLE.',
]);

const HOLE = 'HOLE';

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') && !TURKISH_ALREADY.has(full) ? [full] : [];
  });
}

/** One way a thrown message can read: its words with each `${...}` filled, the words Cortex wrote itself, and a fallback put in a hole. */
interface Sample {
  text: string;
  own: string[];
  fallback?: string;
}

const literalText = (node: ts.Node): string | null => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null);

/** The string literals a `${...}` part falls back to (`${folder || 'the vault'}`). */
function fallbacksOf(node: ts.Expression): string[] {
  const text = literalText(node);
  if (text !== null) return [text];
  if (ts.isParenthesizedExpression(node)) return fallbacksOf(node.expression);
  if (ts.isConditionalExpression(node)) return [...fallbacksOf(node.whenTrue), ...fallbacksOf(node.whenFalse)];
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [...fallbacksOf(node.left), ...fallbacksOf(node.right)];
  }
  return [];
}

/** The declaration of a name in a block around the throw: `const text = ... || 'The program refused.'`. */
function initializerOf(name: string, from: ts.Node): ts.Expression | undefined {
  for (let at: ts.Node | undefined = from; at; at = at.parent) {
    if (!ts.isBlock(at) && !ts.isSourceFile(at) && !ts.isCaseClause(at)) continue;
    for (const statement of at.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration.initializer;
      }
    }
  }
  return undefined;
}

/** Every way the first argument of a thrown error can read, as far as its words are in the source. */
function samplesOf(node: ts.Expression, depth = 0): Sample[] {
  if (depth > 6) return [];
  const text = literalText(node);
  if (text !== null) return [{ text, own: [text] }];
  if (ts.isTemplateExpression(node)) {
    const own = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    const fill = (with_: (at: number) => string) => node.head.text + node.templateSpans.map((span, at) => with_(at) + span.literal.text).join('');
    const samples: Sample[] = [{ text: fill(() => HOLE), own }];
    node.templateSpans.forEach((span, at) => {
      for (const fallback of fallbacksOf(span.expression)) samples.push({ text: fill((one) => (one === at ? fallback : HOLE)), own, fallback });
    });
    return samples;
  }
  if (ts.isParenthesizedExpression(node)) return samplesOf(node.expression, depth + 1);
  if (ts.isConditionalExpression(node)) return [...samplesOf(node.whenTrue, depth + 1), ...samplesOf(node.whenFalse, depth + 1)];
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [...samplesOf(node.left, depth + 1), ...samplesOf(node.right, depth + 1)];
  }
  // `sentenceOf(textOf(...) || 'Codex could not answer.')`: what a call is given, not what it is called on.
  if (ts.isCallExpression(node)) return node.arguments.flatMap((one) => samplesOf(one, depth + 1));
  if (ts.isIdentifier(node)) {
    const initializer = initializerOf(node.text, node);
    return initializer ? samplesOf(initializer, depth + 1) : [];
  }
  return [];
}

/** Words of Cortex's own: a sample whose written parts are only punctuation (`${server}: ${said}`) carries somebody else's. */
const hasWords = (sample: Sample) => sample.own.some((one) => /[A-Za-z]{2,}/.test(one));

function thrownSentences(): Array<{ where: string; sample: Sample }> {
  const found: Array<{ where: string; sample: Sample }> = [];
  for (const file of sources('electron')) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /(?:Error|Refusal|Failure)$/.test(node.expression.text) && node.arguments?.length) {
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        for (const sample of samplesOf(node.arguments[0])) if (hasWords(sample)) found.push({ where, sample });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test('every sentence thrown under electron/ has its Turkish, with no English words of its own left in it', () => {
  const thrown = thrownSentences();
  // The reader itself is checked: a reader that finds nothing would pass anything.
  assert.ok(thrown.length >= 70, `only ${thrown.length} sentences found under electron/`);
  const missing: string[] = [];
  for (const { where, sample } of thrown) {
    if (NEVER_SHOWN.has(sample.text)) continue;
    const turkish = turkishOf(sample.text);
    if (turkish === sample.text) {
      missing.push(`${where}  ${sample.text}`);
      continue;
    }
    // A run of English Cortex wrote itself, still there in the Turkish.
    for (const own of sample.own) {
      const words = own.trim();
      if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(words)) assert.ok(!turkish.includes(words), `${where}: "${words}" is still in "${turkish}"`);
    }
    if (sample.fallback && /[A-Za-z]{3,}/.test(sample.fallback)) assert.ok(!turkish.includes(sample.fallback), `${where}: "${sample.fallback}" is still in "${turkish}"`);
  }
  assert.deepEqual(missing, [], `sentences with no Turkish in shared/refusalsTr.ts:\n${missing.join('\n')}`);
});
