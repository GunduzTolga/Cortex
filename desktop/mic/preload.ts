import { ipcRenderer } from 'electron';

/**
 * The hidden recording window's whole work (electron/services/micWindow.ts): the microphone opened when main says `mic:start`,
 * its sound at 16 kHz in 30 ms pieces to main (`mic:sound`), let go on `mic:stop`. The page itself (mic.html) has no
 * script; nothing crosses into it.
 *
 * Chromium's echo cancelling, noise suppression and gain are off: Whisper and the wake listener were tuned on the
 * microphone's plain sound, as the helper records it itself.
 */
const RATE = 16_000;
const FRAME = 480;

// Runs in the audio thread; made in memory, so the page needs no file of its own for it.
const TAP = `
class CortexTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('cortex-tap', CortexTap);
`;

interface Open {
  stream: MediaStream;
  context: AudioContext;
}

let current: Open | null = null;
// Each start a turn: a stop, or a newer start, while the microphone was still being opened lets the older one go.
let turn = 0;
let piece = new Float32Array(FRAME);
let filled = 0;

function take(samples: Float32Array): void {
  let at = 0;
  while (at < samples.length) {
    const count = Math.min(FRAME - filled, samples.length - at);
    piece.set(samples.subarray(at, at + count), filled);
    filled += count;
    at += count;
    if (filled === FRAME) {
      ipcRenderer.send('mic:sound', piece);
      piece = new Float32Array(FRAME);
      filled = 0;
    }
  }
}

/** The microphone whose name holds the setting's words (as the helper picks one), else the system's default. */
async function deviceFor(microphone: string | null): Promise<string | undefined> {
  if (!microphone) return undefined;
  const want = microphone.toLocaleLowerCase('tr');
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find((device) => device.kind === 'audioinput' && device.label.toLocaleLowerCase('tr').includes(want))?.deviceId;
}

async function tap(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<void> {
  // Pulled by a stream that goes nowhere: nothing is played on the speakers.
  const sink = context.createMediaStreamDestination();
  try {
    const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, 'cortex-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => take(event.data);
    source.connect(node).connect(sink);
  } catch {
    // An audio worklet that would not load: the older processor node does the same on this thread.
    const node = context.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (event) => take(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(node).connect(sink);
  }
}

function close(): void {
  turn += 1;
  const open = current;
  current = null;
  filled = 0;
  if (!open) return;
  for (const track of open.stream.getTracks()) track.stop();
  void open.context.close().catch(() => undefined);
}

async function start(microphone: string | null): Promise<void> {
  close();
  const mine = turn;
  let stream: MediaStream | null = null;
  try {
    const deviceId = await deviceFor(microphone).catch(() => undefined);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    if (mine !== turn) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Chromium turns the microphone's rate into the helper's.
    const context = new AudioContext({ sampleRate: RATE });
    current = { stream, context };
    await tap(context, context.createMediaStreamSource(stream));
    if (mine !== turn) return;
    const track = stream.getAudioTracks()[0];
    // A microphone pulled out: said, and the helper records itself until the next start.
    track?.addEventListener('ended', () => {
      if (mine === turn) ipcRenderer.send('mic:word', { hata: 'mikrofon çıkarıldı' });
    });
    ipcRenderer.send('mic:word', { aygit: track?.label ?? '' });
  } catch (err) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (mine !== turn) return;
    close();
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ipcRenderer.send('mic:word', { hata: name.slice(0, 200) });
  }
}

ipcRenderer.on('mic:start', (_event, microphone: unknown) => void start(typeof microphone === 'string' ? microphone : null));
ipcRenderer.on('mic:stop', () => close());
ipcRenderer.send('mic:ready');
