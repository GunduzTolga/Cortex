import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The engine package the app carries and sets up in a vault from its settings
 * (electron/services/setup.ts), built from this checkout by the engine's own
 * release builder: `cortex-paket/beyin-v3-<VERSION>.zip`, which the installer
 * puts among the app's resources as `cortex/` (package.json, extraResources).
 * The app's version and the engine's are one (VERSION).
 */
const root = path.resolve('..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const out = path.resolve('cortex-paket');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const builder = path.join(root, 'scripts', 'build_v3_release.py');
const target = path.join(out, `beyin-v3-${version}.zip`);
const pythons = process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
for (const [command, ...first] of pythons) {
  const run = spawnSync(command, [...first, builder, '--output', target], { stdio: 'inherit' });
  if (run.error) continue; // not on this machine: the next one
  process.exit(run.status ?? 1);
}
console.error('Python bulunamadı: Cortex paketi derlenemedi.');
process.exit(1);
