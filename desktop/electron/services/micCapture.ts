import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { microphoneFile } from './microphone';

/**
 * The microphone held by Cortex itself. Windows names, in its microphone indicator, the program that holds the
 * microphone; the voice helper that listens for the wake phrase and records dictation is Python, and the person saw
 * "Python" listen without knowing what it was. While the app runs, it records and sends the sound to the helper over
 * 127.0.0.1 (beyin_v3_ses.AppFeed); the helper still hears the wake phrase and writes what was said. With the app
 * closed, or when it cannot record, the helper opens the microphone itself as before.
 *
 * This side is the connection only, with no Electron in it: the hidden window that records is services/micWindow.ts.
 * The helper writes its port and a key, new each time it starts, to `akis.json` beside the app's own word
 * (microphone.ts); the app says the key first, and from then on the helper says when it wants sound (`{"ac": true,
 * "mikrofon": ...}`) and when not (`{"ac": false}`): the microphone is open only while a recording or the wake listener
 * needs it. The app sends messages of a kind byte and a length (uint32, little-endian): `a`, float32 samples at 16 kHz;
 * `j`, a JSON object (`{"aygit": name}`, `{"hata": why}`).
 */

/** The rate the helper records at (beyin_v3_ses RATE). */
export const RATE = 16_000;
/** Samples a message of sound carries: 30 ms, as the helper's own blocks are counted. */
export const FRAME = 480;
/** How often, while no helper is connected, its file is read again (a helper started, or started again). */
export const RETRY_EVERY = 3_000;

export interface FeedDoor {
  port: number;
  key: string;
  pid: number;
}

export function feedFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(microphoneFile(env)), 'akis.json');
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The running helper's way in; null without one (no file, a helper that died, a file not whole). */
export function readFeed(file: string = feedFile(), alive: (pid: number) => boolean = running): FeedDoor | null {
  try {
    const said = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { port, anahtar: key, pid } = said ?? {};
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    if (typeof key !== 'string' || key.length < 16 || typeof pid !== 'number' || !alive(pid)) return null;
    return { port, key, pid };
  } catch {
    return null;
  }
}

/** One message to the helper: its kind, its length, its body. */
export function frame(kind: 'a' | 'j', body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'ascii');
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** What records: the hidden window (micWindow.ts), or a test's stand-in. */
export interface Capture {
  /** Open the microphone; `microphone` is part of the name the voice setting chose, or null for the default. */
  start(microphone: string | null): void;
  stop(): void;
}

/** The part of a socket the link uses. */
export interface Wire {
  write(data: Buffer | string): boolean;
  destroy(): void;
  on(event: 'connect', listener: () => void): this;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface LinkDeps {
  readFeed: () => FeedDoor | null;
  connect: (port: number) => Wire;
  retryEvery: number;
}

const DEFAULT_DEPS: LinkDeps = {
  readFeed: () => readFeed(),
  connect: (port) => net.createConnection({ host: '127.0.0.1', port }),
  retryEvery: RETRY_EVERY,
};

export class MicLink {
  private wire: Wire | null = null;
  private ready = false;
  private open = false;
  private timer: NodeJS.Timeout | null = null;
  private pending = '';
  private readonly deps: LinkDeps;

  constructor(
    private readonly capture: Capture,
    deps: Partial<LinkDeps> = {},
  ) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Connected to a helper and told it is welcome: sound sent now reaches it. */
  get connected(): boolean {
    return this.ready;
  }

  /** Whether the helper wants sound now. */
  get wanted(): boolean {
    return this.open;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tryConnect(), this.deps.retryEvery);
    this.timer.unref?.();
    this.tryConnect();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drop();
  }

  /** A piece of what the microphone heard, sent while the helper wants it. */
  sound(samples: Float32Array): void {
    if (!this.wire || !this.ready || !this.open || !samples.length) return;
    this.wire.write(frame('a', Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)));
  }

  /** The microphone opened (`aygit`) or could not record (`hata`). */
  word(word: { aygit?: string; hata?: string }): void {
    if (!this.wire || !this.ready) return;
    this.wire.write(frame('j', Buffer.from(JSON.stringify(word), 'utf8')));
  }

  /** Tried at every beat while not connected: the helper's file read again, its door knocked on. */
  tryConnect(): void {
    if (this.wire) return;
    const door = this.deps.readFeed();
    if (!door) return;
    let wire: Wire;
    try {
      wire = this.deps.connect(door.port);
    } catch {
      return;
    }
    this.wire = wire;
    this.ready = false;
    this.pending = '';
    wire.on('connect', () => {
      if (this.wire === wire) wire.write(`${JSON.stringify({ anahtar: door.key, hz: RATE })}\n`);
    });
    wire.on('data', (data) => {
      if (this.wire === wire) this.heard(data);
    });
    wire.on('error', () => undefined); // its close follows
    wire.on('close', () => {
      if (this.wire === wire) this.drop();
    });
  }

  private heard(data: Buffer): void {
    this.pending += data.toString('utf8');
    let at: number;
    while ((at = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      let said: Record<string, unknown>;
      try {
        said = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!said || typeof said !== 'object') continue;
      if (said.tamam === true) this.ready = true;
      else if (said.ac === true && this.ready) {
        this.open = true;
        this.capture.start(typeof said.mikrofon === 'string' && said.mikrofon ? said.mikrofon : null);
      } else if (said.ac === false && this.ready) {
        this.open = false;
        this.capture.stop();
      }
    }
    if (this.pending.length > 4096) this.pending = ''; // no word is that long: not the helper speaking
  }

  /** The helper gone, or the app quitting: the microphone let go, the next beat looks for a helper again. */
  private drop(): void {
    const wire = this.wire;
    this.wire = null;
    this.ready = false;
    this.pending = '';
    if (this.open) {
      this.open = false;
      this.capture.stop();
    }
    wire?.destroy();
  }
}

/*
  What the hidden window may ask of its own session (micWindow.ts). The app's window asks for nothing (main.ts,
  holdSession); this one, in a session of its own, may have the microphone and nothing more: not the camera, not the
  screen, and only itself, not a page it was led to.
*/

/** A permission request: the microphone alone, from the recording window. */
export function micMayAsk(permission: string, mediaTypes: readonly string[] | undefined, own: boolean): boolean {
  return own && permission === 'media' && !!mediaTypes?.length && mediaTypes.every((type) => type === 'audio');
}

/** A permission check (listing the microphones by name asks one): sound, or a kind Chromium does not say. */
export function micMayCheck(permission: string, mediaType: string | undefined, own: boolean): boolean {
  return own && permission === 'media' && mediaType !== 'video';
}

/** What the recording window may load: its own page and the small recorder it makes in memory. */
export function micUrlAllowed(url: string): boolean {
  return url.startsWith('file:') || url.startsWith('blob:');
}
