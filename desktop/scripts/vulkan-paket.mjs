import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * whisper.cpp built for Vulkan, as the installer carries it: the build the engine pins (VULKAN_BUILD in
 * template/.claude/scripts/beyin_v3_ses.py, url and SHA-256), put among the app's resources as `whisper-vulkan/`
 * (package.json, extraResources) and given to `ses kur` (electron/services/setup.ts), which checks its digest
 * and takes it instead of downloading it. The release it is published in answered 404 once the repository
 * went private (30 October); fetched here with the person's own `gh` login where a plain download is refused.
 * A file already here with the right digest is kept.
 */
const engine = fs.readFileSync(path.resolve('..', 'template', '.claude', 'scripts', 'beyin_v3_ses.py'), 'utf8');
const pinned = engine.match(/VULKAN_BUILD = \{[\s\S]*?'url': '([^']+)'[\s\S]*?'sha256': '([0-9a-f]{64})'/);
if (!pinned) {
  console.error('VULKAN_BUILD bulunamadı (beyin_v3_ses.py)');
  process.exit(1);
}
const [, url, sha256] = pinned;
const name = url.split('/').pop();
const out = path.resolve('vulkan-paket');
const target = path.join(out, name);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(target) && digest(fs.readFileSync(target)) === sha256) {
  console.log(`${name}: zaten burada`);
  process.exit(0);
}

let bytes = null;
const response = await fetch(url).catch(() => null);
if (response?.ok) bytes = Buffer.from(await response.arrayBuffer());
else {
  // github.com/<owner>/<repo>/releases/download/<tag>/<file>: a private repository's asset, through `gh`.
  const parts = url.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//);
  if (!parts) {
    console.error(`${url}: ${response?.status ?? 'ulaşılamadı'}`);
    process.exit(1);
  }
  const into = fs.mkdtempSync(path.join(os.tmpdir(), 'vulkan-paket-'));
  const got = spawnSync('gh', ['release', 'download', parts[3], '--repo', `${parts[1]}/${parts[2]}`, '--pattern', name, '--dir', into, '--clobber'], { encoding: 'utf8' });
  if (got.status !== 0) {
    console.error(`${name}: indirilemedi (${response?.status ?? 'ağ'}; gh: ${(got.stderr || got.error?.message || '').trim()})`);
    process.exit(1);
  }
  bytes = fs.readFileSync(path.join(into, name));
  fs.rmSync(into, { recursive: true, force: true });
}
if (digest(bytes) !== sha256) {
  console.error(`${name}: SHA-256 tutmadı, dosya yazılmadı`);
  process.exit(1);
}
for (const old of fs.readdirSync(out)) fs.rmSync(path.join(out, old), { force: true });
fs.writeFileSync(target, bytes);
console.log(`${name}: ${bytes.length} bayt, SHA-256 doğru`);
