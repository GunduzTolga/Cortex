import { spawn } from 'node:child_process';

/**
 * The smoke run (e2e/smoke.mjs) wherever it is run, as Krewgent's.
 *
 * - On Linux there may be no display, so the run goes under Xvfb; Windows and
 *   macOS have one.
 * - `ELECTRON_RUN_AS_NODE`, which some editors and terminals set, makes
 *   Electron start as plain node and never open a window; it is taken off.
 * - The window is never shown (CORTEX_HIDDEN=1, electron/main.ts): it is drawn
 *   offscreen and photographed with `capturePage`, so a run does not put a
 *   window in front of whoever is at the machine. CORTEX_SHOW=1 shows it.
 */
const useXvfb = process.platform === 'linux';
const command = useXvfb ? 'xvfb-run' : process.execPath;
const args = useXvfb ? ['-a', '-s', '-screen 0 1280x800x24', process.execPath, 'e2e/smoke.mjs'] : ['e2e/smoke.mjs'];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CORTEX_SHOW === '1') delete env.CORTEX_HIDDEN;
else env.CORTEX_HIDDEN = '1';

const child = spawn(command, args, { stdio: 'inherit', env });
child.on('error', (err) => {
  if (useXvfb && err.code === 'ENOENT') {
    console.error('xvfb-run is not installed. On a machine with a display, run `node e2e/smoke.mjs` directly.');
    process.exit(1);
  }
  throw err;
});
child.on('exit', (code) => process.exit(code ?? 1));
