import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { ChatEvent, ChatOpened, ChatPush, CliAuth } from '../shared/chat';

/**
 * The chat screen's store (src/chat/chatStore.ts) with the main process stood
 * in for: what the window does when an installer ends, when a card is
 * answered twice, when a turn ends, and which chats wait on the person. The
 * store talks to `window.cortex` and draws once a frame; both are given here
 * before it is loaded.
 */

let installed = false;
let auth: CliAuth[] = [];
const answers: Array<[string, string, string | null]> = [];
let answerFails = false;
let pushTo: (push: ChatPush) => void = () => undefined;
let authChanged: (cli?: string | null) => void = () => undefined;
const opened: Record<string, ChatOpened> = {};

const claudeAuth = (): CliAuth => ({ id: 'claude', installed, signedIn: installed ? false : null, detail: null, canLogin: installed, canInstall: !installed, key: null, baseUrl: false, hasKey: false, kept: false });

Object.assign(globalThis, {
  requestAnimationFrame: (draw: () => void) => {
    setImmediate(draw);
    return 1;
  },
  window: {
    addEventListener: () => undefined,
    cortex: {
      on: {
        chat: (handler: (push: ChatPush) => void) => {
          pushTo = handler;
          return () => undefined;
        },
        authChanged: (handler: (cli?: string | null) => void) => {
          authChanged = handler;
          return () => undefined;
        },
      },
      chat: {
        clis: async () => [{ id: 'test', name: 'Test', available: true }],
        list: async () => [],
        auth: async () => {
          auth = [claudeAuth()];
          return auth;
        },
        install: async (id: string) => {
          if (id !== 'claude') throw new Error('Cortex does not install this tool.');
        },
        open: async (id: string) => opened[id],
        answer: async (chat: string, permission: string, option: string | null) => {
          answers.push([chat, permission, option]);
          if (answerFails) throw new Error('That chat is gone.');
        },
      },
    },
  },
});

const { useChat, waitingChats } = await import('../src/chat/chatStore');

/** Whether `condition` comes true while the store's promises and frames run: waited on, not slept for. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let turns = 0; turns < 1000; turns += 1) {
    if (condition()) return;
    await new Promise((done) => setImmediate(done));
  }
  assert.fail(`never came true: ${label}`);
}

const card = (id: string): ChatEvent => ({ type: 'permission', id, title: 'run ls', kind: 'execute', paths: [], options: [{ id: 'once', name: 'Once', kind: 'allow_once' }] });
const chatOpened = (id: string, events: ChatEvent[], running: boolean, seq: number): ChatOpened => ({
  chat: { id, title: id, cli: 'test', createdAt: 1, updatedAt: 1 },
  events,
  running,
  options: [],
  seq,
});

await useChat.getState().boot();

test('an installer that ends without its tool leaves the button to be pressed again, and says so; one that ends with it, nothing', async () => {
  await useChat.getState().install('claude');
  assert.deepEqual(useChat.getState().installing, { id: 'claude', failed: false }, 'its window is open: the button waits');
  // The installer's window closed, Claude Code still not there (an execution policy, the network, an antivirus).
  authChanged();
  await until(() => useChat.getState().installing?.failed === true, 'the install said to have failed');
  assert.deepEqual(useChat.getState().installing, { id: 'claude', failed: true });
  // Pressed again, and this time it is installed.
  await useChat.getState().install('claude');
  assert.deepEqual(useChat.getState().installing, { id: 'claude', failed: false });
  installed = true;
  authChanged();
  await until(() => useChat.getState().installing === null, 'the install over');
  installed = false;
});

test('an install said to have failed by another window closing is over once the tool is there', async () => {
  await useChat.getState().install('claude');
  // A sign-in's window closed while the installer still ran: Claude Code not there yet.
  authChanged();
  await until(() => useChat.getState().installing?.failed === true, 'said to have failed');
  installed = true;
  authChanged();
  await until(() => useChat.getState().installing === null, 'over when the installer ended with it');
  installed = false;
});

test('an installer refused outright is not waited on: the refusal goes back to be said', async () => {
  await assert.rejects(useChat.getState().install('codex'), /does not install/);
  assert.equal(useChat.getState().installing, null);
});

test('a card answered twice before the push comes is sent once; a refused answer can be given again', async () => {
  opened.c1 = chatOpened('c1', [{ type: 'user', text: 'ls', at: 1 }, card('p1')], true, 2);
  await useChat.getState().select('c1');
  useChat.getState().answer('p1', 'once');
  useChat.getState().answer('p1', 'once');
  await until(() => answers.length > 0, 'the answer sent');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(answers, [['c1', 'p1', 'once']]);

  answerFails = true;
  opened.c2 = chatOpened('c2', [{ type: 'user', text: 'ls', at: 1 }, card('p2')], true, 2);
  await useChat.getState().select('c2');
  useChat.getState().answer('p2', 'once');
  await until(() => useChat.getState().error !== null, 'the refusal said');
  answerFails = false;
  useChat.setState({ error: null });
  useChat.getState().answer('p2', 'once');
  await until(() => answers.filter(([chat]) => chat === 'c2').length === 2, 'answered again');
});

test('the chats waiting on the person: running, their card not answered', async () => {
  assert.deepEqual(waitingChats(useChat.getState().open), { c1: 'p1', c2: 'p2' });
  pushTo({ chatId: 'c1', event: { type: 'answered', id: 'p1', option: 'once' }, seq: 3 });
  await until(() => !('c1' in waitingChats(useChat.getState().open)), 'c1 answered');
  assert.deepEqual(waitingChats(useChat.getState().open), { c2: 'p2' });
  assert.deepEqual(waitingChats({ x: { events: [card('p9')], running: false, options: [], seq: 1 } }), {}, 'a chat no longer answering waits on nobody');
});

test('a turn that ends is counted, for the notes to be read again (App.tsx)', async () => {
  const before = useChat.getState().turnsEnded;
  pushTo({ chatId: 'c2', state: { running: false, options: [] } });
  await until(() => useChat.getState().turnsEnded === before + 1, 'the end counted');
  // Told again that it is not running: no turn ended this time.
  pushTo({ chatId: 'c2', state: { running: false, options: [] } });
  pushTo({ chatId: 'c1', event: { type: 'text', id: 'm', text: 'tamam' }, seq: 4 });
  await until(() => useChat.getState().open.c1.seq === 4, 'the frame taken in');
  assert.equal(useChat.getState().turnsEnded, before + 1);
});

test('a tool a chat was refused for is said refused until its own sign-in ends; another tool’s ending leaves it so', async () => {
  // Its row said "Sign-in refused" after the person signed in again, until a chat went through (31 October).
  pushTo({ chatId: 'r1', summary: { id: 'r1', title: 'r1', cli: 'claude', createdAt: 2, updatedAt: 2 }, event: { type: 'error', message: 'Not logged in', kind: 'auth' } });
  await until(() => useChat.getState().authFailed.includes('claude'), 'claude said refused');
  authChanged('codex');
  assert.ok(useChat.getState().authFailed.includes('claude'), 'another tool signed in to');
  authChanged(null);
  assert.ok(useChat.getState().authFailed.includes('claude'), 'an installer ended');
  authChanged('claude');
  assert.ok(!useChat.getState().authFailed.includes('claude'), 'its own sign-in ended');
});

test('the tools that could not be asked for are not looked for for ever: what was known stays, or none (K5)', async () => {
  // "Bu bilgisayardaki araçlar aranıyor…" is shown while the tools are null; a question that failed left them null,
  // and the line turned until the app was closed.
  const cortex = (globalThis as unknown as { window: { cortex: { chat: { auth: () => Promise<CliAuth[]> } } } }).window.cortex;
  const asked = cortex.chat.auth;
  cortex.chat.auth = async () => {
    throw new Error('The tools could not be read.');
  };
  try {
    useChat.setState({ auth: null, error: null });
    await useChat.getState().loadAuth();
    assert.deepEqual(useChat.getState().auth, [], 'none, not "being looked for"');
    assert.ok(useChat.getState().error, 'and the failure is said');
    const known = [claudeAuth()];
    useChat.setState({ auth: known, error: null });
    await useChat.getState().loadAuth();
    assert.equal(useChat.getState().auth, known, 'what was known is kept');
  } finally {
    cortex.chat.auth = asked;
    useChat.setState({ error: null });
  }
});

test('a tool that could not be installed says why on the empty chat screen too, as in the first setup (K3)', async () => {
  const fs = await import('node:fs');
  const view = fs.readFileSync('src/chat/ChatView.tsx', 'utf8');
  assert.match(view, /installing\.failed \? installFailedKey\(state\.auth\?\.find\(\(one\) => one\.id === installing\.id\)\?\.installEnded\)/);
  assert.doesNotMatch(view, /installing\.failed \? 'onboarding\.tools\.installFailed'/, 'the one sentence for every reason is gone');
});
