// A stand-in for Claude Code in its structured mode (`claude -p --input-format
// stream-json --output-format stream-json`), for the chat's tests and the
// end-to-end run (CORTEX_TEST_CLAUDE). Its lines are shaped as Claude Code
// 2.1.296 was recorded writing them (14 October). What it does is chosen by
// words in the message: "izin" asks leave for a step, "plan" writes a todo
// list, "yavaş" waits to be interrupted, "hata" fails as a sign-in that has
// expired does, "çök" dies. Its arguments and every line it is sent are
// written to FAKE_AGENT_LOG, when set.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
const session = resumed ?? `claude-ses-${process.pid}`;
const cwd = process.cwd();
const log = (entry) => process.env.FAKE_AGENT_LOG && fs.appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(entry)}\n`);
log({ argv, cwd });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let nextControl = 1;
const waiting = new Map();
let interrupted = false;
let started = false;

const control = (request) =>
  new Promise((resolve) => {
    const id = `cli-${nextControl++}`;
    waiting.set(id, resolve);
    send({ type: 'control_request', request_id: id, request });
  });
const stream = (event) => send({ type: 'stream_event', event, parent_tool_use_id: null, session_id: session });
const usage = { input_tokens: 1200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 40 };
const result = (fields) =>
  send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '', stop_reason: 'end_turn', total_cost_usd: 0.0123, usage, modelUsage: { 'claude-haiku-5-5': { contextWindow: 200000, inputTokens: 1200 } }, permission_denials: [], ...fields });

async function turn(text) {
  if (!started) {
    started = true;
    send({ type: 'system', subtype: 'init', cwd, session_id: session, model: 'claude-haiku-5-5', permissionMode: 'default', tools: ['Read', 'Write', 'Bash'] });
  }
  if (text.includes('hata')) {
    const failed = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
    send({ type: 'assistant', message: { id: 'synthetic-1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: failed }] }, parent_tool_use_id: null, session_id: session });
    result({ is_error: true, result: failed, terminal_reason: 'api_error', modelUsage: {} });
    return;
  }
  if (text.includes('çök')) {
    process.stderr.write('fake claude: boom\n');
    process.exit(3);
  }
  const note = path.join(cwd, 'Notes', 'Plan.md');
  stream({ type: 'message_start', message: { id: 'msg_1' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Düşünüyorum' } });
  send({ type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-5-5', role: 'assistant', usage, content: [{ type: 'thinking', thinking: 'Düşünüyorum' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: note } }] }, parent_tool_use_id: null, session_id: session });
  // A sub-agent's message is the sub-agent's: not the chat's.
  send({ type: 'assistant', message: { id: 'msg_sub', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT' }] }, parent_tool_use_id: 'toolu_task', session_id: session });
  send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `Read file ${note}`, is_error: false }] }, parent_tool_use_id: null, session_id: session });
  let said = '';
  if (text.includes('plan')) {
    send({ type: 'assistant', message: { id: 'msg_p', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [{ content: 'Notu oku', status: 'completed' }, { content: 'Özet yaz', status: 'in_progress' }] } }] }, parent_tool_use_id: null, session_id: session });
  }
  if (text.includes('izin')) {
    const answer = await control({ subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: note, content: 'x' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' }], tool_use_id: 'toolu_2' });
    said = `izin: ${answer.behavior}${answer.updatedPermissions ? ' always' : ''}. `;
  }
  if (text.includes('yavaş')) {
    stream({ type: 'message_start', message: { id: 'msg_2' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Uzun sürecek…' } });
    while (!interrupted) await sleep(20);
    interrupted = false;
    result({ subtype: 'error_during_execution', is_error: false });
    return;
  }
  stream({ type: 'message_start', message: { id: 'msg_2' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${said}Merhaba` } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' dünya, [[Ideas]] notuna baktım.' } });
  // The whole message after its pieces: already shown, not shown again.
  send({ type: 'assistant', message: { id: 'msg_2', model: 'claude-haiku-5-5', role: 'assistant', usage, content: [{ type: 'text', text: `${said}Merhaba dünya, [[Ideas]] notuna baktım.` }] }, parent_tool_use_id: null, session_id: session });
  result({});
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
    log({ in: message });
    if (message.type === 'control_response') {
      waiting.get(message.response.request_id)?.(message.response.response);
      waiting.delete(message.response.request_id);
    } else if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [{ value: 'default', displayName: 'Default (recommended)' }, { value: 'haiku', displayName: 'Haiku' }, { value: 'opus', displayName: 'Opus' }], current_permission_mode: 'default' } } });
    } else if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
      interrupted = true;
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    } else if (message.type === 'user') {
      void turn(message.message.content.map((part) => part.text ?? '').join(' '));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
