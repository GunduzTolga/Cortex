import { strict as assert } from 'node:assert';
import test from 'node:test';
import { messageOf, plainIpcMessage, rejectionText } from '../shared/ipcError';

/**
 * What a refused call says when it reaches a screen.
 *
 * Electron wraps whatever a handler throws as `Error invoking remote method
 * '<channel>': <Name>: <message>`, and the window showed all of it. The preload
 * cannot be loaded by a test, so the rule is held here, on the function it
 * calls. Each test names one thing the rule must not get wrong in either
 * direction: taking off too little leaves the channel name in front of the
 * sentence, and taking off too much changes what somebody else said.
 */

test('the envelope and its Error prefix come off, and the sentence is what is left', () => {
  assert.equal(
    plainIpcMessage(
      "Error invoking remote method 'hermes:confirmVault': Error: C:\\data cannot be the vault: the app keeps its own data there.",
    ),
    'C:\\data cannot be the vault: the app keeps its own data there.',
  );
});

test('the prefix is whatever class the handler threw, as long as it is an error', () => {
  assert.equal(
    plainIpcMessage("Error invoking remote method 'projects:detail': TypeError: Cannot read properties of undefined"),
    'Cannot read properties of undefined',
  );
  assert.equal(plainIpcMessage("Error invoking remote method 'x': ToolError: No project called nebula."), 'No project called nebula.');
  // A class that does not say it is an error is part of the sentence.
  assert.equal(
    plainIpcMessage("Error invoking remote method 'x': ENOENT: no such file or directory"),
    'ENOENT: no such file or directory',
  );
});

test('a channel with colons or dots in its name is still the envelope', () => {
  assert.equal(plainIpcMessage("Error invoking remote method 'studio:runTool': Error: denied"), 'denied');
  assert.equal(plainIpcMessage("Error invoking remote method 'workers.tasks:v2.cancel': Error: denied"), 'denied');
  assert.equal(plainIpcMessage("Error invoking remote method 'a.b.c': Error: denied"), 'denied');
});

test('only one prefix comes off, and an Error: further in stays where it was said', () => {
  assert.equal(
    plainIpcMessage("Error invoking remote method 'x': Error: Upstream answered Error: 500"),
    'Upstream answered Error: 500',
  );
  // A handler that rethrew another error: the second name is part of the message.
  assert.equal(plainIpcMessage("Error invoking remote method 'x': Error: TypeError: bad input"), 'TypeError: bad input');
});

test('a message that does not start with the envelope is not touched', () => {
  assert.equal(plainIpcMessage('Choose the folder first.'), 'Choose the folder first.');
  // Somebody else's Error: prefix, with no envelope in front of it.
  assert.equal(plainIpcMessage('Error: something else entirely'), 'Error: something else entirely');
  // The envelope has to be at the start; one quoted later is just text.
  assert.equal(
    plainIpcMessage("The log said Error invoking remote method 'x': Error: denied"),
    "The log said Error invoking remote method 'x': Error: denied",
  );
  assert.equal(plainIpcMessage(''), '');
});

test('an envelope with nothing after it is kept, because a channel name beats a blank', () => {
  const bare = "Error invoking remote method 'x': ";
  assert.equal(plainIpcMessage(bare), bare);
  const onlyPrefix = "Error invoking remote method 'x': Error: ";
  assert.equal(plainIpcMessage(onlyPrefix), onlyPrefix);
  const blanks = "Error invoking remote method 'x': Error:    ";
  assert.equal(plainIpcMessage(blanks), blanks);
});

test('a message of several lines keeps every one of them', () => {
  assert.equal(
    plainIpcMessage("Error invoking remote method 'x': Error: first line\nsecond line\n  third, indented\n"),
    'first line\nsecond line\n  third, indented\n',
  );
});

/* ------------------------------------------------------------------ */
/* What a screen shows of whatever it caught                            */
/* ------------------------------------------------------------------ */

test('an Error is said by its sentence, without its class name in front', () => {
  assert.equal(messageOf(new Error('The disk would not take it.')), 'The disk would not take it.');
  // A subclass is still an Error, and its name is no part of what was said.
  assert.equal(messageOf(new TypeError('Cannot read properties of undefined')), 'Cannot read properties of undefined');
  // The trap the helper is for, so the rest of the file does not have to be taken on trust.
  assert.equal(String(new Error('denied')), 'Error: denied');
});

test('what is not an Error is said the way String says it, and never as a blank', () => {
  assert.equal(messageOf('the disk is full'), 'the disk is full');
  assert.equal(
    messageOf({ toString: () => 'an object that knows how to say itself' }),
    'an object that knows how to say itself',
  );
  // A rejection with nothing in it: not pretty, and not an empty line that reads as a bug in the toast.
  assert.equal(messageOf(undefined), 'undefined');
});

/* ------------------------------------------------------------------ */
/* What the preload reads off a rejection                              */
/* ------------------------------------------------------------------ */

test('a rejection is read by its message, not by whose Error it is', () => {
  const wrapped = "Error invoking remote method 'hermes:confirmVault': Error: not a folder";
  assert.equal(rejectionText(new Error(wrapped)), wrapped);
  // What an error from another realm looks like to `instanceof`: not one.
  const foreign = { name: 'Error', message: wrapped, toString: () => `Error: ${wrapped}` };
  assert.equal(foreign instanceof Error, false);
  assert.equal(rejectionText(foreign), wrapped);
  // The whole path the preload runs, on that: the sentence and nothing before it.
  assert.equal(plainIpcMessage(rejectionText(foreign)), 'not a folder');
  // The same object through `String` is what the `instanceof` check fell back to.
  assert.notEqual(plainIpcMessage(String(foreign)), 'not a folder');
});

test('a rejection with no string message is said the way String says it', () => {
  assert.equal(rejectionText('the channel went away'), 'the channel went away');
  assert.equal(rejectionText({ message: 42, toString: () => 'forty-two' }), 'forty-two');
  assert.equal(rejectionText(undefined), 'undefined');
  assert.equal(rejectionText(null), 'null');
});
