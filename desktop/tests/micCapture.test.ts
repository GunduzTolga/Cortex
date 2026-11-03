import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type Capture,
  FRAME,
  feedFile,
  frame,
  MicLink,
  micMayAsk,
  micMayCheck,
  micUrlAllowed,
  RATE,
  readFeed,
  type Wire,
} from '../electron/services/micCapture';

/**
 * Cortex records for the voice helper while it runs, so Windows names Cortex on the microphone and not Python
 * (electron/services/micCapture.ts, beyin_v3_ses.AppFeed): one contract on two sides, tested here on the app's and,
 * where a Python with numpy is found, against the helper's own code.
 */

class FakeWire extends EventEmitter implements Wire {
  written: (Buffer | string)[] = [];
  destroyed = false;
  write(data: Buffer | string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
  say(word: unknown): void {
    this.emit('data', Buffer.from(`${JSON.stringify(word)}\n`));
  }
}

class FakeCapture implements Capture {
  calls: string[] = [];
  start(microphone: string | null): void {
    this.calls.push(`start:${microphone}`);
  }
  stop(): void {
    this.calls.push('stop');
  }
}

const door = { port: 50123, key: 'k'.repeat(32), pid: 1 };

function linked(readable = true) {
  const capture = new FakeCapture();
  const wires: FakeWire[] = [];
  const ports: number[] = [];
  const link = new MicLink(capture, {
    readFeed: () => (readable ? door : null),
    connect: (port) => {
      ports.push(port);
      const wire = new FakeWire();
      wires.push(wire);
      return wire;
    },
    retryEvery: 60_000,
  });
  return { capture, wires, ports, link };
}

test('the helper’s door is read beside the app’s word, and only a whole one of a running helper', () => {
  assert.equal(feedFile({ LOCALAPPDATA: path.join('C:', 'L') }), path.join('C:', 'L', 'beyin-v3', 'akis.json'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-akis-'));
  const file = path.join(dir, 'akis.json');
  assert.equal(readFeed(file), null, 'no file');
  fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, port: 4242, anahtar: 'a'.repeat(32) }));
  assert.deepEqual(readFeed(file), { port: 4242, key: 'a'.repeat(32), pid: process.pid });
  assert.equal(readFeed(file, () => false), null, 'a helper that died');
  for (const bad of [{ port: 0 }, { port: 70_000 }, { anahtar: 'short' }, { pid: 'x' }]) {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 4242, anahtar: 'a'.repeat(32), ...bad }));
    assert.equal(readFeed(file), null, JSON.stringify(bad));
  }
  fs.writeFileSync(file, '{"port": 42');
  assert.equal(readFeed(file), null, 'half written');
});

test('a message is its kind, its length and its body', () => {
  const body = Buffer.from(new Float32Array([0.5, -0.25]).buffer);
  const message = frame('a', body);
  assert.equal(message.subarray(0, 1).toString('ascii'), 'a');
  assert.equal(message.readUInt32LE(1), 8);
  assert.deepEqual([...new Float32Array(message.buffer.slice(message.byteOffset + 5, message.byteOffset + 13))], [0.5, -0.25]);
  assert.equal(RATE, 16_000);
  assert.equal(FRAME, 480, '30 ms, as the helper counts its blocks');
});

test('the app says the key first, and records only while the helper asks', () => {
  const { capture, wires, ports, link } = linked();
  link.start();
  assert.deepEqual(ports, [door.port]);
  const wire = wires[0];
  wire.emit('connect');
  assert.deepEqual(JSON.parse(String(wire.written[0])), { anahtar: door.key, hz: 16_000 });
  wire.say({ ac: true });
  assert.deepEqual(capture.calls, [], 'not before the helper welcomed it');
  link.sound(new Float32Array(FRAME));
  assert.equal(wire.written.length, 1, 'nothing sent before the welcome');
  wire.say({ tamam: true });
  assert.ok(link.connected);
  link.sound(new Float32Array(FRAME));
  assert.equal(wire.written.length, 1, 'nothing sent while the helper does not want sound');
  wire.say({ ac: true, mikrofon: 'USB' });
  assert.deepEqual(capture.calls, ['start:USB']);
  link.sound(new Float32Array(FRAME).fill(0.5));
  const sent = wire.written[1] as Buffer;
  assert.equal(sent.subarray(0, 1).toString('ascii'), 'a');
  assert.equal(sent.readUInt32LE(1), FRAME * 4);
  link.word({ aygit: 'Mikrofon (USB)' });
  const word = wire.written[2] as Buffer;
  assert.equal(word.subarray(0, 1).toString('ascii'), 'j');
  assert.deepEqual(JSON.parse(word.subarray(5).toString('utf8')), { aygit: 'Mikrofon (USB)' });
  wire.say({ ac: false });
  assert.deepEqual(capture.calls, ['start:USB', 'stop']);
  assert.ok(!link.wanted);
  link.stop();
});

test('words split across reads are put back together, and anything else is passed by', () => {
  const { capture, wires, link } = linked();
  link.start();
  const wire = wires[0];
  wire.emit('connect');
  wire.emit('data', Buffer.from('{"tam'));
  wire.emit('data', Buffer.from('am": true}\nnot json\n{"ac": tr'));
  wire.emit('data', Buffer.from('ue, "mikrofon": null}\n'));
  assert.deepEqual(capture.calls, ['start:null']);
  link.stop();
});

test('the helper going away lets the microphone go, and the next beat looks for a helper again', () => {
  const { capture, wires, ports, link } = linked();
  link.start();
  wires[0].emit('connect');
  wires[0].say({ tamam: true });
  wires[0].say({ ac: true });
  wires[0].emit('close');
  assert.deepEqual(capture.calls, ['start:null', 'stop']);
  assert.ok(!link.connected);
  link.tryConnect();
  assert.equal(ports.length, 2, 'connected again, to whatever helper runs now');
  link.tryConnect();
  assert.equal(ports.length, 2, 'not twice while one connection stands');
  link.stop();
  assert.ok(wires[1].destroyed, 'quitting closes it');
});

test('without a helper nothing connects', () => {
  const { ports, link } = linked(false);
  link.start();
  link.tryConnect();
  assert.deepEqual(ports, []);
  link.stop();
});

test('the recording window may have the microphone and nothing else, and load only its own page', () => {
  assert.ok(micMayAsk('media', ['audio'], true));
  assert.ok(!micMayAsk('media', ['audio'], false), 'only the recording window');
  assert.ok(!micMayAsk('media', ['audio', 'video'], true), 'not the camera');
  assert.ok(!micMayAsk('media', ['video'], true));
  assert.ok(!micMayAsk('media', [], true));
  assert.ok(!micMayAsk('media', undefined, true));
  for (const other of ['notifications', 'clipboard-read', 'display-capture', 'geolocation']) assert.ok(!micMayAsk(other, ['audio'], true), other);
  assert.ok(micMayCheck('media', 'audio', true));
  assert.ok(micMayCheck('media', 'unknown', true), 'listing the microphones by name');
  assert.ok(!micMayCheck('media', 'video', true));
  assert.ok(!micMayCheck('media', 'audio', false));
  assert.ok(micUrlAllowed('file:///C:/Program%20Files/Cortex/resources/app.asar/dist-electron/mic.html'));
  assert.ok(micUrlAllowed('blob:null/1234'));
  for (const url of ['https://example.com/', 'http://127.0.0.1:9/', 'data:text/html,x', 'ws://localhost/']) assert.ok(!micUrlAllowed(url), url);
});

// The helper's side, its own code: run where a Python with numpy is (the voice environment has it; CI's may not).
const SCRIPTS = path.resolve('..', 'template', '.claude', 'scripts');
const PYTHON = process.env.CORTEX_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasNumpy = spawnSync(PYTHON, ['-c', 'import numpy'], { windowsHide: true }).status === 0;

const HELPER = `
import importlib.util, json, pathlib, sys, tempfile, time
sys.path.insert(0, sys.argv[1])
import beyin_v3_ses as ses
path = ses.write_worker(pathlib.Path(tempfile.mkdtemp()) / 'state')
spec = importlib.util.spec_from_file_location('isci', path)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h.ses, h.log = ses, (lambda _t: None)
feed = h.AppFeed(key='k' * 32)
print(json.dumps({'port': feed.port}), flush=True)
deadline = time.time() + 10
while not feed.usable() and time.time() < deadline:
    time.sleep(0.01)
got = []
stream = feed.stream(lambda data, frames, _t, _s: got.append(data), 'USB')
stream.start()
while sum(len(g) for g in got) < 960 and time.time() < deadline:
    time.sleep(0.01)
stream.stop()
print(json.dumps({'samples': sum(len(g) for g in got), 'first': float(got[0][0, 0]) if got else None, 'device': feed.device}), flush=True)
time.sleep(0.3)
feed.close()
`;

test('the app’s sound reaches the helper’s own code, with the key and the microphone it opened', { skip: !hasNumpy && 'no Python with numpy here' }, async () => {
  const child = spawn(PYTHON, ['-c', HELPER, SCRIPTS], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines: string[] = [];
  let buffered = '';
  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the helper said nothing')), 15_000);
      const check = () => {
        if (lines.length) {
          clearTimeout(timer);
          resolve(lines.shift() as string);
          return true;
        }
        return false;
      };
      if (check()) return;
      const onData = () => {
        if (check()) child.stdout.off('data', onData);
      };
      child.stdout.on('data', onData);
    });
  child.stdout.on('data', (data: Buffer) => {
    buffered += data.toString('utf8');
    let at: number;
    while ((at = buffered.indexOf('\n')) >= 0) {
      lines.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
  });
  try {
    const { port } = JSON.parse(await nextLine()) as { port: number };
    const asked: (string | null)[] = [];
    let link: MicLink | null = null;
    const stopped = new Promise<void>((resolve) => {
      link = new MicLink(
        {
          start(microphone) {
            asked.push(microphone);
            link?.word({ aygit: 'Mikrofon (USB Kulaklık)' });
            link?.sound(new Float32Array(FRAME).fill(0.25));
            link?.sound(new Float32Array(FRAME).fill(0.25));
          },
          stop: () => resolve(),
        },
        { readFeed: () => ({ port, key: 'k'.repeat(32), pid: child.pid ?? 0 }), retryEvery: 60_000 },
      );
      link.start();
    });
    const result = JSON.parse(await nextLine()) as { samples: number; first: number; device: string };
    await stopped;
    assert.deepEqual(asked, ['USB'], 'asked for sound, with the setting’s microphone');
    assert.deepEqual(result, { samples: 960, first: 0.25, device: 'Mikrofon (USB Kulaklık)' });
    (link as MicLink | null)?.stop();
  } finally {
    child.kill();
  }
});
