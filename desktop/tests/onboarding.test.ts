import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
// The build without a message channel of its own: the tests' process ends when they do.
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { CliAuth, CliId } from '../shared/chat';
import { LOGIN_SLOW_AFTER, installFailedKey, progressWords } from '../src/chat/AuthDialog';
import { tr } from '../src/i18n/tr';
import { atMostEvery } from '../src/onboarding/focusRefresh';
import { ToolsStep } from '../src/onboarding/ToolsStep';

/**
 * The first-run screen's "Yapay zeka aracın" step (src/onboarding/ToolsStep.tsx), drawn as the window draws it
 * (Turkish, the first run's language) for the states a first install got stuck in: a sign-in that never ends, a tool
 * list not read yet, an install that failed or says nothing of how far it is (the review before 1.0.62: K2, K3, K4,
 * K5), and the asking again on every focus (K9).
 */

const tool = (id: CliId, over: Partial<CliAuth> = {}): CliAuth => ({
  id,
  installed: true,
  signedIn: false,
  detail: null,
  canLogin: true,
  canInstall: false,
  key: null,
  baseUrl: false,
  hasKey: false,
  kept: false,
  chosen: true,
  own: false,
  loginEnded: null,
  installEnded: null,
  ...over,
});
const none = new Set<CliId>();
type Props = Parameters<typeof ToolsStep>[0];
const draw = (props: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(ToolsStep, { auth: [], fresh: none, signingIn: none, unfinished: none, installing: null, onLogin: () => undefined, onCancel: () => undefined, onInstall: () => undefined, ...props }),
  );
/** What the page says, without its tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('K2: while a sign-in goes on its row has "Yeniden dene" and "Vazgeç"; before and after, the sign-in button', () => {
  // The row had no button at all while "Giriş sürüyor" turned: ten minutes, whatever had happened to the browser.
  const going = draw({ auth: [tool('claude')], signingIn: new Set<CliId>(['claude']) });
  assert.match(going, /data-onboarding-tool-signing-in/);
  assert.match(going, /data-onboarding-tool-retry="claude"/);
  assert.match(going, /data-onboarding-tool-cancel="claude"/);
  assert.ok(words(going).includes(tr['auth.login.retry']) && words(going).includes(tr['auth.cancel']));
  assert.doesNotMatch(going, /data-onboarding-tool-login=/, 'one way to begin it again, not two');

  const idle = draw({ auth: [tool('claude')] });
  assert.match(idle, /data-onboarding-tool-login="claude"/);
  assert.doesNotMatch(idle, /data-onboarding-tool-(retry|cancel)=/);
  // Signed in from here: nothing left to press, as before.
  const done = draw({ auth: [tool('claude', { signedIn: true })], signingIn: new Set<CliId>(['claude']), fresh: new Set<CliId>(['claude']) });
  assert.doesNotMatch(done, /data-onboarding-tool-(retry|cancel|login)=/);
  // A tool whose way in is a key has no sign-in to cancel.
  assert.doesNotMatch(draw({ auth: [tool('gemini', { canLogin: false, key: 'cortex' })], signingIn: new Set<CliId>(['gemini']) }), /data-onboarding-tool-(retry|cancel)=/);
});

test('R2K: a sign-in given up here and then made in a terminal is said signed in, not left "unfinished"', () => {
  // "Vazgeç", then `claude auth login` in a terminal as the row itself suggests: the row stayed red, "Giriş
  // tamamlanmadı", though the tool was signed in (the second review, R2K-1).
  const givenUp = draw({ auth: [tool('claude')], unfinished: new Set<CliId>(['claude']) });
  assert.ok(words(givenUp).includes(tr['onboarding.tools.unfinished']), 'not signed in: said unfinished');
  const signedInElsewhere = draw({ auth: [tool('claude', { signedIn: true })], unfinished: new Set<CliId>(['claude']) });
  assert.ok(!words(signedInElsewhere).includes(tr['onboarding.tools.unfinished']), 'signed in since: no longer said unfinished');
});

test('K2: a sign-in still going on after a minute or so says what to do, and for Claude Code that it takes a paid plan', () => {
  assert.ok(LOGIN_SLOW_AFTER >= 60_000 && LOGIN_SLOW_AFTER <= 90_000, 'not said in the minute a sign-in takes, nor kept for the ten it is waited on');
  const fresh = draw({ auth: [tool('claude')], signingIn: new Set<CliId>(['claude']) });
  assert.doesNotMatch(fresh, /data-auth-login-slow|data-auth-plan-note/, 'a sign-in just begun says only to finish it in the browser');
  assert.ok(words(fresh).includes(tr['onboarding.tools.signingIn.note']));

  const slow = draw({ auth: [tool('claude')], signingIn: new Set<CliId>(['claude']), slowAfter: 0 });
  assert.match(slow, /data-auth-login-slow/);
  assert.ok(words(slow).includes(tr['auth.login.slow']), words(slow));
  assert.ok(words(slow).includes(tr['auth.login.plan.claude']));
  assert.match(tr['auth.login.slow'], /tarayıcı açılmadıysa/i);
  assert.match(tr['auth.login.plan.claude'], /ücretli/);

  const codex = draw({ auth: [tool('codex')], signingIn: new Set<CliId>(['codex']), slowAfter: 0 });
  assert.match(codex, /data-auth-login-slow/);
  assert.doesNotMatch(codex, /data-auth-plan-note/, 'only the tool that asks for a plan says so');
  // Not going on: nothing of it.
  assert.doesNotMatch(draw({ auth: [tool('claude')], slowAfter: 0 }), /data-auth-login-slow/);
});

test('K2: a sign-in ended after its ten minutes says, for Claude Code, that it takes a paid plan', () => {
  const ended = { end: 'timeout' as const, code: null, command: 'claude auth login' };
  const claude = draw({ auth: [tool('claude', { loginEnded: ended })] });
  assert.match(claude, /data-auth-login-ended="timeout"/);
  assert.ok(words(claude).includes(tr['auth.login.ended.timeout']));
  assert.ok(words(claude).includes('claude auth login'), 'the way round a browser that never opened, as before');
  assert.ok(words(claude).includes(tr['auth.login.plan.claude']), words(claude));
  const codex = draw({ auth: [tool('codex', { loginEnded: { ...ended, command: 'codex login' } })] });
  assert.match(codex, /data-auth-login-ended="timeout"/);
  assert.doesNotMatch(codex, /data-auth-plan-note/);
});

test('K5: until the tools have been asked the step says it is looking for them, not nothing', () => {
  const looking = draw({ auth: null });
  assert.match(looking, /data-onboarding-tools-looking/);
  assert.ok(words(looking).includes(tr['onboarding.tools.looking']));
  // Asked: the tools, or that there is none; never both that and "looking".
  const empty = draw({ auth: [] });
  assert.doesNotMatch(empty, /data-onboarding-tools-looking/);
  assert.ok(words(empty).includes(tr['onboarding.tools.none']));
  assert.doesNotMatch(draw({ auth: [tool('claude')] }), /data-onboarding-tools-looking/);
});

test('K3: an install that ended without its tool says why and what to do, in the window’s language', () => {
  const missing = (installEnded: CliAuth['installEnded']) => tool('claude', { installed: false, canLogin: false, canInstall: true, installEnded });
  const said = (installEnded: CliAuth['installEnded']) => words(draw({ auth: [missing(installEnded), tool('codex', { installed: false, canLogin: false, canInstall: true })], installing: { id: 'claude', failed: true } }));
  assert.ok(said('network').includes('Claude Code indirilemedi: kurulum sunucusuna ulaşılamadı'), said('network'));
  assert.ok(said('blocked').includes('Claude Code kurulumu engellendi'), said('blocked'));
  assert.match(said('blocked'), /başka bir ağda.*yeniden dene.*başka bir aracı kur/);
  assert.ok(said('timeout').includes('Claude Code kurulumu 20 dakikada bitmedi'), said('timeout'));
  // Not known: the sentence there was, with where to look.
  assert.ok(said('unknown').includes('Claude Code kurulamadı ya da bulunamadı'));
  assert.ok(said(null).includes('Claude Code kurulamadı ya da bulunamadı'));
  assert.equal(installFailedKey(undefined), 'onboarding.tools.installFailed');
  // What the main process refused before anything ran is said as it was.
  const refused = words(draw({ auth: [missing('network')], installing: { id: 'claude', failed: true, why: 'Bu araç zaten kuruluyor.' } }));
  assert.ok(refused.includes('Bu araç zaten kuruluyor.') && !refused.includes('ulaşılamadı'));
  // Still installing: not said failed.
  assert.doesNotMatch(draw({ auth: [missing(null)], installing: { id: 'claude', failed: false } }), /data-onboarding-install-failed/);
});

test('K4: a download’s progress is said in percent and megabytes, or in megabytes alone where its length is not known', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(progressWords({ got: 43 * MB, total: 173 * MB }), { key: 'onboarding.tools.install.progress', values: { percent: 24, got: 43, total: 173 } });
  assert.deepEqual(progressWords({ got: 173 * MB, total: 173 * MB })?.values.percent, 100);
  assert.deepEqual(progressWords({ got: 5 * MB, total: null }), { key: 'onboarding.tools.install.progressSome', values: { got: 5 } });
  // A length that is less than what came is no length.
  assert.equal(progressWords({ got: 5 * MB, total: MB })?.key, 'onboarding.tools.install.progressSome');
  assert.equal(progressWords(null), null);
  assert.equal(progressWords({ got: 0, total: 173 * MB }), null, 'nothing has come yet: only "installing" is said');
  assert.match(tr['onboarding.tools.install.progress'], /%\{percent\}.*\{got\}.*\{total\} MB/);
});

test('K9: coming back to the window asks again at most once in a while, and never drops the asking', () => {
  let now = 1_000_000;
  const timers: Array<{ work: () => void; at: number }> = [];
  let ran = 0;
  const focus = atMostEvery(
    () => (ran += 1),
    10_000,
    () => now,
    (work, ms) => {
      const timer = { work, at: now + ms };
      timers.push(timer);
      return timer;
    },
    (timer) => void timers.splice(timers.indexOf(timer as (typeof timers)[number]), 1),
  );
  focus.ask();
  assert.equal(ran, 1, 'the first time at once');
  // The focus comes and goes with every click between the window and a browser.
  for (let i = 0; i < 20; i += 1) {
    now += 200;
    focus.ask();
  }
  assert.equal(ran, 1, 'not again for each');
  assert.equal(timers.length, 1, 'once more, when the while has gone by');
  assert.equal(timers[0].at, 1_010_000);
  now = timers[0].at;
  timers.shift()?.work();
  assert.equal(ran, 2, 'what happened meanwhile (a sign-in done in the browser) is still asked after');
  now += 10_000;
  focus.ask();
  assert.equal(ran, 3, 'and at once again after a while away');
  now += 100;
  focus.ask();
  focus.stop();
  assert.equal(timers.length, 0, 'nothing left to run once the screen is gone');

  // The first-run screen's focus goes through it (Onboarding.tsx brings pictures the tests' bundler does not read: read as text).
  const source = fs.readFileSync('src/onboarding/Onboarding.tsx', 'utf8');
  assert.match(source, /const back = atMostEvery\(/);
  assert.match(source, /addEventListener\('focus', back\.ask\)/);
  assert.doesNotMatch(source, /addEventListener\('focus', back\)/);
});
