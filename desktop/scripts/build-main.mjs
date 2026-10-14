import { build } from 'esbuild';
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

export const preloadOptions = {
  ...mainOptions,
  entryPoints: { preload: 'electron/preload.ts' },
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Promise.all([build(mainOptions), build(preloadOptions)]);
}
