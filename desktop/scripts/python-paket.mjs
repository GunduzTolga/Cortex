import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Python the installer carries (python.json): python.org's own Windows
 * installer, signed by the Python Software Foundation, pinned by its SHA-256.
 * The app runs it, quietly and for this user only, when the machine has no
 * Python for Cortex's engine (electron/services/setup.ts, the first-run
 * screen). It goes among the app's resources as `python/` (package.json,
 * extraResources), named `.paket`; a file already here with the right digest is kept.
 */
const pin = JSON.parse(fs.readFileSync('python.json', 'utf8'));
const out = path.resolve('python-paket');
// `.paket`, not `.exe`: a signed build signs every .exe among the resources, and that would change
// the bytes the app checks (electron/services/setup.ts runs it from a copy named .exe).
const target = path.join(out, pin.file + '.paket');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(target) && digest(fs.readFileSync(target)) === pin.sha256) {
  console.log(`${pin.file}: zaten burada`);
  process.exit(0);
}
const response = await fetch(pin.url);
if (!response.ok) {
  console.error(`${pin.url}: ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (digest(bytes) !== pin.sha256) {
  console.error(`${pin.file}: SHA-256 tutmadı, dosya yazılmadı`);
  process.exit(1);
}
for (const name of fs.readdirSync(out)) fs.rmSync(path.join(out, name), { force: true });
fs.writeFileSync(target, bytes);
console.log(`${pin.file}: ${bytes.length} bayt, SHA-256 doğru`);
