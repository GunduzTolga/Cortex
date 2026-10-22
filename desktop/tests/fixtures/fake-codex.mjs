// A stand-in for Codex's app server (`codex app-server`), for the chat's tests
// and the end-to-end run (CORTEX_TEST_CODEX). Its messages are shaped as Codex
// 0.162.1 was recorded writing them (14 October), from the types it generates
// itself. What it does is chosen by words in the message: "izin" asks leave to
// run a command, "dosya" to change a file, "yetki" asks for more permissions
// (the network, a folder outside the vault to write in) and says what it was
// given, "plan" writes a plan, "yavaş" waits to be interrupted, "inatçı" waits
// and never heeds an interrupt (it goes on talking after one, and asks leave
// for a command: at once, and again once its chat's next turn has begun on its
// thread), "geç" answers its turn/start late, "hata" fails as a sign-in that
// has gone does, "model" fails as a model the account may not use does. Every
// method it is sent is written to FAKE_AGENT_LOG, when set, with its process
// id, and so is every answer an interrupted turn is given ("answered").
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const log = (entry) => process.env.FAKE_AGENT_LOG && fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const threads = new Set();
let nextId = 5000;
const waiting = new Map();
const interrupted = new Set();
/** The turn each thread was last asked to start. */
const latest = new Map();
let turns = 0;

const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const models = [
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' },
  { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }], defaultReasoningEffort: 'medium' },
  { id: 'secret', model: 'secret', displayName: 'Hidden', hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' },
];

async function turn(threadId, turnId, text) {
  const item = (method, body) => notify(method, { threadId, turnId, item: body });
  const finish = (status, error = null) => {
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 9000 }, last: { totalTokens: 4096, inputTokens: 4000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 96, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } });
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error } });
  };
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  if (text.includes('hata')) return finish('failed', { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized' });
  if (text.includes('model'))
    return finish('failed', { message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." } }), codexErrorInfo: 'other' });
  const note = path.join(cwd, 'Notes', 'Plan.md');
  item('item/started', { type: 'reasoning', id: 'rs_1', summary: [], content: [] });
  notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'rs_1', delta: 'Düşünüyorum', summaryIndex: 0 });
  item('item/completed', { type: 'reasoning', id: 'rs_1', summary: ['Düşünüyorum'], content: [] });
  item('item/started', { type: 'agentMessage', id: 'msg_c', text: '', phase: 'commentary' });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_c', delta: 'Notu ' });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_c', delta: 'okuyorum.' });
  item('item/completed', { type: 'agentMessage', id: 'msg_c', text: 'Notu okuyorum.', phase: 'commentary' });
  const exec = { type: 'commandExecution', id: 'exec-1', command: `"powershell.exe" -Command 'Get-Content -Raw ${note}'`, cwd, status: 'inProgress', commandActions: [{ type: 'read', command: `Get-Content -Raw ${note}`, name: 'Plan.md', path: note }], aggregatedOutput: null, exitCode: null };
  item('item/started', exec);
  item('item/completed', { ...exec, status: 'completed', aggregatedOutput: `# Plan (${note})\n`, exitCode: 0 });
  let said = '';
  if (text.includes('plan')) notify('turn/plan/updated', { threadId, turnId, explanation: null, plan: [{ step: 'Notu oku', status: 'completed' }, { step: 'Özet yaz', status: 'inProgress' }] });
  if (text.includes('izin')) {
    const answer = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'exec-2', startedAtMs: Date.now(), command: `git status ${cwd}`, cwd, reason: null, environmentId: null });
    said += `komut: ${answer.decision}. `;
  }
  if (text.includes('yetki')) {
    const permissions = { network: { enabled: true }, fileSystem: { write: [process.env.FAKE_CODEX_OUTSIDE ?? path.join(path.parse(cwd).root, 'dis')] } };
    const answer = await ask('item/permissions/requestApproval', { threadId, turnId, itemId: 'perm-1', reason: 'Paketleri indirmem gerekiyor', permissions });
    said += `yetki: ${JSON.stringify(answer)}. `;
  }
  if (text.includes('dosya')) {
    const change = { type: 'fileChange', id: 'patch-1', changes: [{ path: note, kind: 'update', diff: '@@\n-# Plan\n+# Plan 2\n+yeni satır\n' }], status: 'inProgress' };
    item('item/started', change);
    const answer = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: 'patch-1', startedAtMs: Date.now(), reason: null, grantRoot: null });
    item('item/completed', { ...change, status: answer.decision === 'decline' ? 'declined' : 'completed' });
    said += `dosya: ${answer.decision}. `;
  }
  if (text.includes('yavaş')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_c', delta: ' Uzun sürecek…' });
    while (!interrupted.has(turnId)) await sleep(20);
    return finish('interrupted');
  }
  if (text.includes('inatçı')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_c', delta: ' Durmayacağım…' });
    // Interrupted, it goes on talking on its thread, as a turn that will not stop does, and asking leave.
    let asked = 0;
    for (;;) {
      await sleep(100);
      if (!interrupted.has(turnId)) continue;
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg_s', delta: ' Hâlâ buradayım.' });
      if (asked === 0 || (asked === 1 && latest.get(threadId) !== turnId)) {
        asked += 1;
        const answer = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: `exec-s${asked}`, startedAtMs: Date.now(), command: 'rm -rf Notes', cwd, reason: null, environmentId: null });
        log({ method: 'answered', params: { turnId, decision: answer?.decision ?? null }, cwd });
      }
    }
  }
  // The final answer comes whole, in its completion, with no pieces before it.
  item('item/started', { type: 'agentMessage', id: 'msg_f', text: '', phase: 'final_answer' });
  item('item/completed', { type: 'agentMessage', id: 'msg_f', text: `${said}Merhaba dünya, [[Ideas]] notuna baktım.`, phase: 'final_answer' });
  finish('completed');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method) log({ method: message.method, params: message.params, cwd });
    if (message.id !== undefined && !message.method) {
      waiting.get(message.id)?.(message.result);
      waiting.delete(message.id);
      continue;
    }
    const { id, method, params } = message;
    if (method === 'initialize') send({ id, result: { userAgent: 'fake', codexHome: path.join(cwd, '.codex-home'), platformFamily: 'windows', platformOs: 'windows' } });
    else if (method === 'initialized') continue;
    else if (method === 'model/list') send({ id, result: { data: models, nextCursor: null } });
    else if (method === 'thread/start') {
      const threadId = `thr-${process.pid}-${threads.size + 1}`;
      threads.add(threadId);
      send({ id, result: { thread: { id: threadId }, model: 'gpt-5.5', cwd } });
    } else if (method === 'thread/resume') {
      if (threads.has(params.threadId) || params.threadId.startsWith('thr-')) {
        threads.add(params.threadId);
        send({ id, result: { thread: { id: params.threadId } } });
      } else send({ id, error: { code: -32602, message: 'unknown thread' } });
    } else if (method === 'turn/start') {
      turns += 1;
      const turnId = `turn-${turns}`;
      latest.set(params.threadId, turnId);
      const text = params.input.map((part) => part.text ?? '').join(' ');
      const begin = () => {
        send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
        void turn(params.threadId, turnId, text);
      };
      // Answered late: Stop can be pressed before the turn has its id.
      if (text.includes('geç')) setTimeout(begin, 400);
      else begin();
    } else if (method === 'turn/interrupt') {
      interrupted.add(params.turnId);
      send({ id, result: {} });
    } else if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
