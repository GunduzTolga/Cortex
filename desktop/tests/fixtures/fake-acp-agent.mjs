// A stand-in for an AI CLI speaking the Agent Client Protocol, for the chat's
// tests and the end-to-end run (CORTEX_TEST_AGENT). It answers as OpenCode was
// recorded answering (14 October), and what it does is chosen by words in the
// message: "izin" asks leave first, "yavaş" waits to be stopped, "inatçı"
// waits and never heeds a cancel, "hata" fails as a provider out of quota
// does, "yetkisiz" as an agent not signed in does by the protocol's code
// alone, "çök" dies. With FAKE_ACP_HANG_INIT set it never answers
// `initialize`, with FAKE_ACP_FAIL_INIT it refuses it. Every method it is sent
// is written to FAKE_AGENT_LOG, when set, as one JSON line. With FAKE_AGENT_GATE
// set, "kapı" holds the leave it asks until a file is at that path (and takes
// it away): the end-to-end run asks while the person is in another view.
import fs from 'node:fs';
import path from 'node:path';

const cwdAtStart = process.cwd();
const sessions = new Map();
let nextId = 1000;
const waiting = new Map();
let cancelled = null;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const log = (entry) => process.env.FAKE_AGENT_LOG && fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(entry)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const optionsFor = (session) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: [{ value: 'fake/a', name: 'Fake A' }, { group: 'more', name: 'More', options: [{ value: 'fake/b', name: 'Fake B' }] }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
];

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((part) => part.text ?? '').join(' ');
  if (text.includes('hata')) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error: Insufficient balance or no resource package. Please recharge.', data: { service: 'session', errorName: 'provider.quota' } } });
    return;
  }
  if (text.includes('giriş')) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required: Use Qwen Code CLI to authenticate first.', data: { authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }] } } });
    return;
  }
  if (text.includes('yetkisiz')) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }
  if (text.includes('çök')) {
    process.stderr.write('fake agent: boom\n');
    process.exit(3);
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-1:reasoning', content: { type: 'text', text: 'Düşünüyorum' } });
  const note = path.join(cwdAtStart, 'Notes', 'Plan.md');
  // A file outside the vault, at the root of the vault's own drive: C:\Windows\win.ini on Windows, /Windows/win.ini elsewhere.
  const outside = path.join(path.parse(cwdAtStart).root, 'Windows', 'win.ini');
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', name: 'read', title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', locations: [{ path: note }, { path: outside }], content: [{ type: 'content', content: { type: 'text', text: `Read file ${note}` } }] });
  if (text.includes('izin')) {
    const gate = process.env.FAKE_AGENT_GATE;
    if (gate && text.includes('kapı')) {
      while (!fs.existsSync(gate)) await sleep(20);
      fs.rmSync(gate, { force: true });
    }
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-2', title: `edit ${note}`, kind: 'edit', locations: [{ path: note }] },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
    update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: `izin: ${outcome}. ` } });
  }
  if (text.includes('inatçı')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Durmayacağım…' } });
    for (;;) await sleep(1000);
  }
  if (text.includes('yavaş')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Uzun sürecek…' } });
    while (cancelled !== sessionId) await sleep(20);
    cancelled = null;
    send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Merhaba' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: ' dünya, [[Ideas]] notuna baktım.' } });
  update(sessionId, { sessionUpdate: 'usage_update', used: 6088, size: 262144, cost: { amount: 0, currency: 'USD' } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
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
    if (message.method) log({ method: message.method, params: message.params, cwd: process.cwd() });
    if (message.id !== undefined && !message.method) {
      waiting.get(message.id)?.(message.result);
      waiting.delete(message.id);
      continue;
    }
    const { id, method, params } = message;
    if (method === 'initialize' && process.env.FAKE_ACP_HANG_INIT) continue;
    if (method === 'initialize' && process.env.FAKE_ACP_FAIL_INIT) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error: could not read its settings' } });
      continue;
    }
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } }, agentInfo: { name: 'Fake', version: '1' } } });
    else if (method === 'session/new') {
      const session = { id: `ses_${sessions.size + 1}`, model: 'fake/a', mode: 'build' };
      sessions.set(session.id, session);
      send({ jsonrpc: '2.0', id, result: { sessionId: session.id, configOptions: optionsFor(session) } });
    } else if (method === 'session/resume') {
      const session = sessions.get(params.sessionId);
      if (session) send({ jsonrpc: '2.0', id, result: { configOptions: optionsFor(session) } });
      else send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown session' } });
    } else if (method === 'session/set_config_option') {
      const session = sessions.get(params.sessionId);
      session[params.configId] = params.value;
      send({ jsonrpc: '2.0', id, result: { configOptions: optionsFor(session) } });
    } else if (method === 'session/prompt') void prompt(id, params);
    else if (method === 'session/cancel') cancelled = params.sessionId;
    else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
