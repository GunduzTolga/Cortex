import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

/**
 * The tests run on the real source, as Krewgent's do: the main process is
 * TypeScript that imports electron, so each test is bundled first with a stub
 * in electron's place (tests/electron-stub.mjs), and node:test runs the
 * bundles. No copy of the code under test can drift from it.
 */
const outdir = path.resolve('.tmp-tests');
fs.rmSync(outdir, { recursive: true, force: true });

const entryPoints = [];
for await (const file of glob('tests/*.test.ts')) entryPoints.push(file);
if (!entryPoints.length) {
  console.error('No tests found.');
  process.exit(1);
}

/** `@shared/...` as tsconfig.json and Vite map it, from this folder. */
const rootPaths = {
  name: 'root-paths',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) =>
      build.resolve(`./shared/${args.path.slice('@shared/'.length)}`, { resolveDir: path.resolve('.'), kind: args.kind }),
    );
  },
};

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  alias: { electron: path.resolve('tests/electron-stub.mjs') },
  plugins: [rootPaths],
  // The compiler a test reads the source with is loaded where it lies, not copied into every bundle.
  external: ['typescript'],
  logLevel: 'warning',
});

const compiled = fs.readdirSync(outdir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(outdir, f));
const child = spawn(process.execPath, ['--test', ...compiled], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
