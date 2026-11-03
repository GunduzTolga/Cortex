import { build } from 'esbuild';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The main process and the preload are bundled to CommonJS: Electron loads the
 * preload as a classic script, and CJS keeps __dirname working in the main
 * process. The preload runs sandboxed (electron/main.ts), where `require`
 * answers for `electron` and little else, so everything it imports - the one
 * helper in shared/ipcError.ts - is bundled into it.
 */
export const mainOptions = {
  entryPoints: { main: 'electron/main.ts' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

/**
 * The hidden recording window (electron/services/micWindow.ts) is built beside the app's: its preload, and its page,
 * which has no script and is copied as it is.
 */
const micPage = {
  name: 'mic-page',
  setup(build) {
    build.onEnd(() => {
      fs.mkdirSync('dist-electron', { recursive: true });
      fs.copyFileSync('mic/mic.html', 'dist-electron/mic.html');
    });
  },
};

export const preloadOptions = {
  ...mainOptions,
  entryPoints: { preload: 'electron/preload.ts', 'mic-preload': 'mic/preload.ts' },
  plugins: [micPage],
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Promise.all([build(mainOptions), build(preloadOptions)]);
}
