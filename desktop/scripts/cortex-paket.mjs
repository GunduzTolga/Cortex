import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The engine package the app carries and sets up in a vault from its settings
 * (electron/services/setup.ts), built from this checkout by the engine's own
 * release builder: `cortex-paket/beyin-v3-<VERSION>.zip`, which the installer
 * puts among the app's resources as `cortex/` (package.json, extraResources).
 * The app's version and the engine's are one (VERSION).
 *
 * Beside it, the package's own list of its files and their digests
 * (`beyin-v3-<VERSION>.manifest.json`, the zip's manifest.json as it is): a
 * build given out under an unchanged version is told from the engine in a
 * vault by those, not by its number (setup.ts, engineStale).
 */
const root = path.resolve('..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const out = path.resolve('cortex-paket');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const builder = path.join(root, 'scripts', 'build_v3_release.py');
const target = path.join(out, `beyin-v3-${version}.zip`);
const manifest = path.join(out, `beyin-v3-${version}.manifest.json`);
const READ_MANIFEST = "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read('manifest.json').decode('utf-8'))";
const pythons = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
for (const [command, ...first] of pythons) {
  const run = spawnSync(command, [...first, builder, '--output', target], { stdio: 'inherit' });
  if (run.error) continue; // not on this machine: the next one
  if (run.status !== 0) process.exit(run.status ?? 1);
  const read = spawnSync(command, [...first, '-c', READ_MANIFEST, target], { encoding: 'utf8' });
  if (read.status !== 0 || !read.stdout) {
    console.error(`Paketin manifest.json dosyası okunamadı. ${read.stderr || read.error?.message || ''}`.trim());
    process.exit(1);
  }
  fs.writeFileSync(manifest, read.stdout, 'utf8');
  process.exit(0);
}
console.error('Python bulunamadı: Cortex paketi derlenemedi.');
process.exit(1);
