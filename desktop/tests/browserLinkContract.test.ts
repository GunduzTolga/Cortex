import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import {
  BROWSER_LINK_PROTOCOL,
  BYE_REASONS,
  CAPTURED_CODES,
  ERROR_CODES,
  EVENT_KINDS,
  LIMITS,
  LINE_MAX,
  OPTION_KINDS,
  PAIRING_STATES,
  RENDEZVOUS_FILE,
  START_ARGUMENTS,
  STATUS_PHASES,
  TOOL_PERMISSIONS,
  codePoints,
  cutTo,
  encodeLine,
  longerThan,
  parseBrowserLine,
  readBrowserMessage,
  readCortexMessage,
  readRendezvous,
} from '../shared/browserLink';
import type { PermissionKind } from '../shared/chat';
import { PAGE_TEXT_MAX } from '../electron/services/browserPage';
import { MESSAGE_MAX } from '../electron/services/chat';

/**
 * The contract of the link between Cortex and Cortex Browser (shared/browser-link-contract.json): the same file lies
 * in both repositories and is what both sides' tests read. Every example message in it is read by the code here and
 * comes back as it was written, and every list of values is the code's own: a value or a field added to the file
 * fails here until the code knows it, and one changed in the code fails here until the file says so.
 */

const contract = JSON.parse(fs.readFileSync('shared/browser-link-contract.json', 'utf8')) as {
  about: string;
  protocol: number;
  rendezvous_file: { name: string; example: unknown; example_listener_closed: unknown; example_turned_off: unknown; start_arguments: string[] };
  limits: Record<string, number>;
  enums: Record<string, string[]>;
  messages: { browser_to_cortex: Array<Record<string, unknown>>; cortex_to_browser: Array<Record<string, unknown>> };
};

test('the protocol, the line limit and the meeting file are the contract’s', () => {
  assert.equal(BROWSER_LINK_PROTOCOL, contract.protocol);
  assert.equal(LINE_MAX, 16 * 1024 * 1024);
  assert.ok(contract.about.includes(String(LINE_MAX)), 'the limit the contract names');
  assert.equal(RENDEZVOUS_FILE, contract.rendezvous_file.name);
  assert.deepEqual(readRendezvous(contract.rendezvous_file.example), contract.rendezvous_file.example);
  // Written at every start, the listener open or not: with it closed the file names the program and no pipe.
  assert.deepEqual(readRendezvous(contract.rendezvous_file.example_listener_closed), contract.rendezvous_file.example_listener_closed);
  assert.equal((readRendezvous(contract.rendezvous_file.example_listener_closed) as { pipe: unknown }).pipe, null);
  // Closed by the person in Cortex's settings: said, so the browser does not start Cortex to open it.
  assert.deepEqual(readRendezvous(contract.rendezvous_file.example_turned_off), contract.rendezvous_file.example_turned_off);
  assert.deepEqual(readRendezvous(contract.rendezvous_file.example_turned_off), { version: 1, pipe: null, off: true, exe: 'C:\\Users\\ornek\\AppData\\Local\\Programs\\Cortex\\Cortex.exe', pid: 4242 });
  // The word is there only when it is so: left out, null or false, the file reads as one without it.
  assert.ok(!('off' in (readRendezvous(contract.rendezvous_file.example) as object)) && !('off' in (readRendezvous(contract.rendezvous_file.example_listener_closed) as object)));
  assert.deepEqual(readRendezvous({ version: 1, pipe: null, off: false, exe: 'x', pid: 1 }), { version: 1, pipe: null, exe: 'x', pid: 1 });
  assert.equal(readRendezvous({ version: 1, pipe: null, off: 'yes', exe: 'x', pid: 1 }), null);
  assert.equal(readRendezvous({ version: 1, pipe: '', exe: 'x', pid: 1 }), null, 'an empty name is no pipe');
  assert.equal(readRendezvous({ version: 1, pipe: 7, exe: 'x', pid: 1 }), null);
  assert.equal(readRendezvous({ version: 1, exe: 'x', pid: 1 }), null, 'the pipe is said, or said to be none');
  assert.equal(readRendezvous('x'), null);
  assert.deepEqual(contract.rendezvous_file.start_arguments, [...START_ARGUMENTS]);
});

test('the limits are the code’s own: the ones the link holds a message to, and the ones the chat holds a question to', () => {
  assert.deepEqual(contract.limits, { ...LIMITS });
  assert.deepEqual(Object.keys(contract.limits).sort(), ['detail_chars', 'hello_wait_ms', 'id_chars', 'line_bytes', 'line_bytes_before_hello_ok', 'name_chars', 'page_text_chars', 'permission_options', 'permission_paths', 'permission_title_chars', 'text_chars']);
  assert.equal(LIMITS.line_bytes, LINE_MAX);
  // Not two numbers that could drift: what the chat sends a tool at most, and the longest page taken.
  assert.equal(LIMITS.text_chars, MESSAGE_MAX);
  assert.equal(LIMITS.page_text_chars, PAGE_TEXT_MAX);
  const id = (length: number) => parseBrowserLine(JSON.stringify({ type: 'cancel', id: 'a'.repeat(length) }));
  assert.deepEqual(id(LIMITS.id_chars), { message: { type: 'cancel', id: 'a'.repeat(LIMITS.id_chars) } });
  assert.deepEqual(id(LIMITS.id_chars + 1), { bad: true });
  // Counted in characters as Unicode has them, not in the two halves JavaScript keeps some of them in.
  const face = '😀';
  assert.equal(face.length, 2);
  assert.equal(codePoints(`a${face}ş`), 3);
  assert.deepEqual(parseBrowserLine(JSON.stringify({ type: 'cancel', id: face.repeat(LIMITS.id_chars) })), { message: { type: 'cancel', id: face.repeat(LIMITS.id_chars) } }, 'two hundred of them is an id');
  assert.deepEqual(parseBrowserLine(JSON.stringify({ type: 'cancel', id: face.repeat(LIMITS.id_chars + 1) })), { bad: true });
  assert.deepEqual([longerThan('abc', 3), longerThan('abcd', 3), longerThan(face.repeat(3), 3), longerThan(face.repeat(4), 3), longerThan('', 0)], [false, true, false, true, false]);
  assert.deepEqual([cutTo('abcdef', 3), cutTo(`${face}${face}${face}`, 2), cutTo('ab', 5), cutTo(`a${face}`, 1)], ['abc', `${face}${face}`, 'ab', 'a'], 'cut between characters, never through one');
});

test('every list of values is the code’s own, in the contract’s order', () => {
  assert.deepEqual(Object.keys(contract.enums).sort(), ['bye_reason', 'captured_code', 'error_code', 'event_kind', 'option_kind', 'pairing_state', 'status_phase', 'tool_permission']);
  assert.deepEqual(contract.enums.option_kind, [...OPTION_KINDS]);
  assert.deepEqual(contract.enums.tool_permission, [...TOOL_PERMISSIONS]);
  // A card's answers are the chat's own kinds (shared/chat.ts): the same four, so none is sent that the contract has no word for.
  const chatKinds: Record<PermissionKind, true> = { allow_once: true, allow_always: true, reject_once: true, reject_always: true };
  assert.deepEqual(Object.keys(chatKinds).sort(), [...OPTION_KINDS].sort());
  assert.deepEqual(contract.enums.pairing_state, [...PAIRING_STATES]);
  assert.deepEqual(contract.enums.event_kind, [...EVENT_KINDS]);
  assert.deepEqual(contract.enums.status_phase, [...STATUS_PHASES]);
  assert.deepEqual(contract.enums.error_code, [...ERROR_CODES]);
  assert.deepEqual(contract.enums.captured_code, [...CAPTURED_CODES]);
  assert.deepEqual(contract.enums.bye_reason, [...BYE_REASONS]);
});

test('every message the browser may send is read as the contract writes it', () => {
  const examples = contract.messages.browser_to_cortex;
  assert.deepEqual([...new Set(examples.map((one) => one.type))], ['hello', 'ask', 'answer', 'cancel', 'capture', 'bye'], 'the kinds the code reads');
  for (const example of examples) {
    assert.deepEqual(readBrowserMessage(example), example, JSON.stringify(example));
    // As it comes down the pipe: one line of JSON.
    assert.deepEqual(parseBrowserLine(JSON.stringify(example)), { message: example });
  }
});

test('every message Cortex may send is written as the contract writes it', () => {
  const examples = contract.messages.cortex_to_browser;
  assert.deepEqual([...new Set(examples.map((one) => one.type))], ['pairing', 'hello_ok', 'event', 'captured', 'bye']);
  assert.deepEqual([...new Set(examples.filter((one) => one.type === 'event').map((one) => one.kind))].sort(), [...EVENT_KINDS].sort(), 'an example of every kind of event');
  for (const example of examples) {
    const read = readCortexMessage(example);
    assert.deepEqual(read, example, JSON.stringify(example));
    // Written as one line, and read back the same.
    const line = encodeLine(read as NonNullable<typeof read>);
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
    assert.deepEqual(JSON.parse(line), example);
  }
});

test('a field the code does not know is left out, a kind it does not know is no message, and neither closes the link', () => {
  assert.deepEqual(parseBrowserLine('{"type":"cancel","id":"a2","later":true}'), { message: { type: 'cancel', id: 'a2' } });
  assert.deepEqual(parseBrowserLine('{"type":"from-the-future","id":"a2"}'), { message: null });
  assert.deepEqual(parseBrowserLine(' {"type":"bye","reason":"shutdown"}\r'), { message: { type: 'bye', reason: 'shutdown' } }, 'a line ended as Windows ends one');
  // What is left out of a message is as the contract's `null`: no token, no page.
  assert.deepEqual(parseBrowserLine('{"type":"hello","protocol":1}'), { message: { type: 'hello', protocol: 1, client: '', client_version: '', token: null } });
  // "Ask again" is there only when it is asked for: left out, null or false, a hello is an ordinary one.
  assert.deepEqual(parseBrowserLine('{"type":"hello","protocol":1,"ask_again":false,"token":null}'), { message: { type: 'hello', protocol: 1, client: '', client_version: '', token: null } });
  assert.deepEqual(parseBrowserLine('{"type":"hello","protocol":1,"ask_again":true}'), { message: { type: 'hello', protocol: 1, client: '', client_version: '', token: null, ask_again: true } });
  assert.deepEqual(parseBrowserLine('{"type":"ask","id":"a","conversation":"c","text":"x"}'), { message: { type: 'ask', id: 'a', conversation: 'c', text: 'x', page: null } });
  assert.deepEqual(
    parseBrowserLine('{"type":"ask","id":"a","conversation":"c","text":"x","page":{"title":"T","url":"https://example.com/","text":"p"}}'),
    { message: { type: 'ask', id: 'a', conversation: 'c', text: 'x', page: { title: 'T', url: 'https://example.com/', text: 'p', truncated: false } } },
  );
  // The person's own word that a page may go to a tool Cortex cannot hold to asking: there only when it is given.
  assert.deepEqual(parseBrowserLine('{"type":"ask","id":"a","conversation":"c","text":"x","page_ack":false}'), { message: { type: 'ask', id: 'a', conversation: 'c', text: 'x', page: null } });
  assert.deepEqual(parseBrowserLine('{"type":"ask","id":"a","conversation":"c","text":"x","page_ack":true}'), { message: { type: 'ask', id: 'a', conversation: 'c', text: 'x', page: null, page_ack: true } });
  // A hello of a protocol not known is still a hello: it is answered with `bye {reason: protocol}`, not as a bad line.
  assert.deepEqual(parseBrowserLine('{"type":"hello","protocol":7,"shape":"new"}'), { message: { type: 'hello', protocol: 7, client: '', client_version: '', token: null } });
});

test('a line that is not JSON, not an object, or a known message without what it needs, is a bad message', () => {
  for (const line of ['', 'hello', '{"type":"ask"', '[]', '"ask"', 'null', '7', '{}', '{"type":7}', '{"type":"ask","id":"a"}', '{"type":"ask","id":7,"conversation":"c","text":"x"}', '{"type":"hello"}', '{"type":"hello","protocol":"1"}', '{"type":"hello","protocol":1,"ask_again":"yes"}', '{"type":"ask","id":"a","conversation":"c","text":"x","page_ack":"yes"}', '{"type":"answer","id":"a","permission":"p","option":7}', '{"type":"ask","id":"a","conversation":"c","text":"x","page":"text"}', '{"type":"ask","id":"a","conversation":"c","text":"x","page":{"title":"T"}}', '{"type":"capture","id":"k"}', '{"type":"cancel"}', '{"type":"ask","id":"","conversation":"c","text":"x"}']) {
    assert.deepEqual(parseBrowserLine(line), { bad: true }, line);
  }
  // An id is a short name, not a text: one too long to be one is not taken.
  assert.deepEqual(parseBrowserLine(JSON.stringify({ type: 'cancel', id: 'a'.repeat(201) })), { bad: true });
});

test('a line longer than the limit is a bad message, measured in bytes', () => {
  const head = '{"type":"capture","id":"k","title":"","url":"","note":"';
  const tail = '"}';
  const fits = head + 'a'.repeat(LINE_MAX - head.length - tail.length) + tail;
  assert.equal(Buffer.byteLength(fits), LINE_MAX);
  assert.equal((parseBrowserLine(fits) as { message?: { type: string } }).message?.type, 'capture', 'a line of exactly the limit is read');
  assert.deepEqual(parseBrowserLine(`${fits.slice(0, -2)}a"}`), { bad: true }, 'one byte more is not');
  // Two bytes a letter: half as many letters reach the limit.
  const turkish = head + 'ş'.repeat((LINE_MAX - head.length - tail.length) / 2 + 1) + tail;
  assert.ok(turkish.length < LINE_MAX && Buffer.byteLength(turkish) > LINE_MAX);
  assert.deepEqual(parseBrowserLine(turkish), { bad: true });
});

test('Cortex writes nothing the contract has no word for', () => {
  assert.equal(readCortexMessage({ type: 'event', id: 'a', kind: 'status', phase: 'waiting' }), null);
  assert.equal(readCortexMessage({ type: 'event', id: 'a', kind: 'error', code: 'out_of_luck', detail: '' }), null);
  assert.equal(readCortexMessage({ type: 'bye', reason: 'bored' }), null);
  assert.equal(readCortexMessage({ type: 'pairing', state: 'maybe' }), null);
  // A browser told to wait is told the code the person sees in Cortex; one refused is told none.
  assert.equal(readCortexMessage({ type: 'pairing', state: 'waiting' }), null);
  assert.equal(readCortexMessage({ type: 'pairing', state: 'waiting', code: 4821 }), null);
  assert.equal(readCortexMessage({ type: 'pairing', state: 'waiting', code: '48x1' }), null);
  assert.deepEqual(readCortexMessage({ type: 'pairing', state: 'refused', code: '4821' }), { type: 'pairing', state: 'refused' });
  // The tool that answers a question is said with its first status, and with the refusal of a page it cannot be held to asking for.
  const told = { id: 'gemini', name: 'Gemini CLI', permission: 'unknown', can_ask: false };
  assert.deepEqual(readCortexMessage({ type: 'event', id: 'a', kind: 'status', phase: 'starting', tool: told }), { type: 'event', id: 'a', kind: 'status', phase: 'starting', tool: told });
  assert.equal(readCortexMessage({ type: 'event', id: 'a', kind: 'status', phase: 'starting', tool: { id: 'gemini' } }), null);
  assert.equal(readCortexMessage({ type: 'event', id: 'a', kind: 'error', code: 'page_unprotected', detail: '' }), null, 'refused for its tool, the tool is named');
  assert.notEqual(readCortexMessage({ type: 'event', id: 'a', kind: 'error', code: 'page_unprotected', detail: '', tool: told }), null);
  // What Cortex writes keeps to the limits too.
  const sized = (patch: Record<string, unknown>) => readCortexMessage({ type: 'event', id: 'a', kind: 'permission', permission: { id: 'p', title: 't', kind: 'edit', paths: [], options: [], after_page: false, ...patch } });
  assert.notEqual(sized({ title: 'x'.repeat(LIMITS.permission_title_chars), paths: Array.from({ length: LIMITS.permission_paths }, () => 'a.md') }), null);
  assert.equal(sized({ title: 'x'.repeat(LIMITS.permission_title_chars + 1) }), null);
  assert.equal(sized({ paths: Array.from({ length: LIMITS.permission_paths + 1 }, () => 'a.md') }), null);
  assert.equal(sized({ options: Array.from({ length: LIMITS.permission_options + 1 }, (_, n) => ({ id: `o${n}`, name: 'n', kind: 'allow_once' })) }), null);
  assert.equal(sized({ options: [{ id: 'o', name: 'n'.repeat(LIMITS.name_chars + 1), kind: 'allow_once' }] }), null);
  assert.equal(readCortexMessage({ type: 'hello_ok', protocol: 1, app_version: '1', tool: { id: 'x', name: 'n'.repeat(LIMITS.name_chars + 1), permission: 'ask', can_ask: true }, vault_name: null, token: null }), null);
  assert.equal(readCortexMessage({ type: 'captured', id: 'k', ok: false, code: 'no_idea', detail: '' }), null);
  const welcome = (tool: unknown) => readCortexMessage({ type: 'hello_ok', protocol: 1, app_version: '1.0.63', tool, vault_name: null, token: null });
  assert.notEqual(welcome({ id: 'claude', name: 'Claude Code', permission: 'ask', can_ask: true }), null);
  assert.equal(welcome({ id: 'claude', name: 'Claude Code' }), null, 'a tool is told with how it asks');
  assert.equal(welcome({ id: 'claude', name: 'Claude Code', permission: 'sometimes', can_ask: true }), null);
  assert.equal(welcome({ id: 'claude', name: 'Claude Code', permission: 'ask', can_ask: 'yes' }), null);
  const card = (kind: string) => readCortexMessage({ type: 'event', id: 'a', kind: 'permission', permission: { id: 'p', title: 't', kind: 'anything the tool says', paths: [], options: [{ id: 'o', name: 'n', kind }], after_page: false } });
  assert.notEqual(card('allow_once'), null);
  assert.equal(card('allow_forever'), null, 'an answer of a kind the contract does not list');
  assert.equal(readCortexMessage({ type: 'event', id: 'a', kind: 'error', code: 'internal', detail: 'x'.repeat(LIMITS.detail_chars + 1) }), null, 'a detail longer than the contract allows');
});
