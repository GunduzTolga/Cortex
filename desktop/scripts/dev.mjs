import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { createServer } from 'vite';
import { mainOptions, preloadOptions } from './build-main.mjs';

/**
 * Dev loop, as Krewgent's: vite serves the window, esbuild watches the main
 * process, and Electron is restarted whenever the main bundle changes.
 */
let child = null;
let restartQueued = false;

function startElectron(devServerUrl) {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  const env = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, NODE_ENV: 'development' };
  // Set by some editors and terminals for their own tooling; with it Electron starts as plain node.
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (!restartQueued) process.exit(code ?? 0);
    restartQueued = false;
  });
}

// The port is vite.config.ts's, read with the rest of it.
const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('Vite did not report a local URL.');
server.printUrls();

const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    let first = true;
    build.onEnd(() => {
      if (first) {
        first = false;
        return;
      }
      console.log('\n[dev] main process changed, restarting Electron...');
      restartQueued = true;
      startElectron(url);
    });
  },
};

const mainCtx = await context({ ...mainOptions, plugins: [restartPlugin], logLevel: 'warning' });
const preloadCtx = await context({ ...preloadOptions, plugins: [restartPlugin], logLevel: 'warning' });
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

startElectron(url);

const shutdown = async () => {
  restartQueued = false;
  await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
  await server.close();
  child?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
