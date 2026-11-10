import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { createElement, isValidElement, type ReactNode } from 'react';
import { SHOW_ANYWAY_MS, failedLoadStep } from '../electron/services/pageLoad';
import { CrashScreen, RenderGuard } from '../src/ui/RenderGuard';

/**
 * A window that cannot show the app says so (K7, 10 November): a page that will not load is loaded once more and then
 * the person is asked (electron/services/pageLoad.ts, electron/main.ts); a window whose first frame never comes is
 * shown anyway; an error while the page is drawn puts a sentence and a button on the screen (src/ui/RenderGuard.tsx).
 * Before, each of the three left a blank sheet of paper, or no window at all.
 */

const main = fs.readFileSync('electron/main.ts', 'utf8');

/** What a drawn tree says and holds, read from its elements: function components called, tags and their `data-`/`role` kept. */
function drawn(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(drawn).join('');
  if (!isValidElement(node)) return '';
  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  if (typeof node.type === 'function') return drawn((node.type as (props: unknown) => ReactNode)(props));
  const marks = Object.keys(props).filter((name) => name === 'role' || name.startsWith('data-')).map((name) => ` ${name}${typeof props[name] === 'string' ? `="${props[name] as string}"` : ''}`);
  return `<${String(node.type)}${marks.join('')}>${drawn(props.children)}</${String(node.type)}>`;
}

test('a page that will not load is loaded once more by itself, then the person is asked; a load given up is not a failure', () => {
  assert.equal(failedLoadStep(0, -6, true), 'reload', 'ERR_FILE_NOT_FOUND, the first time');
  assert.equal(failedLoadStep(1, -6, true), 'tell');
  assert.equal(failedLoadStep(4, -105, true), 'tell');
  assert.equal(failedLoadStep(0, -3, true), 'ignore', 'ERR_ABORTED: another load took its place');
  assert.equal(failedLoadStep(1, -3, true), 'ignore');
  assert.equal(failedLoadStep(0, -6, false), 'ignore', 'a frame inside the page is not the page');
});

test('the main process listens for a failed load, counts from none again once one goes through, and asks in the person’s language', () => {
  assert.match(main, /contents\.on\('did-fail-load', \(_event, errorCode, errorDescription, validatedURL, isMainFrame\) => \{\s+const step = failedLoadStep\(loadFailures, errorCode, isMainFrame\);/);
  assert.match(main, /contents\.on\('did-finish-load', \(\) => \{\s+loadFailures = 0;/);
  assert.match(main, /if \(step === 'reload'\) loadPage\(made\);\s+else void pageNotLoaded\(made\);/);
  const asked = /async function pageNotLoaded[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
  assert.match(asked, /dialog\.showMessageBox/);
  assert.match(asked, /'Cortex penceresini açamadı\.'/);
  assert.match(asked, /yeniden başlat, yine olmazsa Cortex’i yeniden kur\./);
  assert.match(asked, /\['Yeniden dene', 'Çık'\]/);
  assert.match(asked, /'Cortex could not open its window\.'/);
  // Nothing appears by itself at a start with Windows: the page is tried again when the window is asked for.
  assert.match(asked, /if \(START_HIDDEN \|\| seen\) \{\s+loadFailedUnseen = true;\s+return;/);
  assert.match(main, /if \(loadFailedUnseen\) \{\s+loadFailedUnseen = false;\s+loadFailures = 0;\s+loadPage\(window\);/);
  // A load that fails rejects its promise too: caught, so that the event is the one place it is handled.
  assert.doesNotMatch(main, /void window\.load(File|URL)\(/);
});

test('a window whose first frame has not come after a while is shown anyway, once', () => {
  assert.ok(SHOW_ANYWAY_MS >= 3_000 && SHOW_ANYWAY_MS <= 15_000, 'longer than a slow start, shorter than giving up');
  assert.match(main, /made\.once\('ready-to-show', showFirst\);\s+const showAnyway = setTimeout\(showFirst, SHOW_ANYWAY_MS\);/);
  assert.match(main, /const showFirst = \(\) => \{\s+if \(firstShown \|\| HIDDEN \|\| !showNow \|\| made\.isDestroyed\(\) \|\| window !== made\) return;\s+reveal\(made\);/);
  assert.match(main, /clearTimeout\(showAnyway\);/);
});

test('an error while the page is drawn puts a sentence and a reload button on the screen, in Turkish unless English is chosen', () => {
  assert.deepEqual(RenderGuard.getDerivedStateFromError(), { failed: true });
  const guard = new RenderGuard({ children: createElement('p', null, 'the app') });
  assert.equal(drawn(guard.render()), '<p>the app</p>');
  guard.state = { failed: true };
  const shown = drawn(guard.render());
  assert.match(shown, /role="alert"/);
  assert.match(shown, /Cortex bu ekranı gösteremedi/);
  assert.match(shown, /Yeniden yükle; sürerse Cortex'i kapatıp aç, yine olmazsa yeniden kur\./);
  assert.match(shown, /<button[^>]*data-app-crash-reload[^>]*>Yeniden yükle<\/button>/);
  assert.doesNotMatch(shown, /the app/);
  const english = drawn(createElement(CrashScreen, { language: 'en', onReload: () => undefined }));
  assert.match(english, /Cortex could not show this screen/);
  assert.match(english, />Reload<\/button>/);
  // The whole window is drawn inside it, so an error in any view is caught.
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /export function App\(\) \{\s+return \(\s+<RenderGuard beforeReload=\{leaveOpenNotes\}>\s+<AppWindow \/>\s+<\/RenderGuard>/);
  assert.match(fs.readFileSync('src/main.tsx', 'utf8'), /<App \/>/);
});
