const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * What the installer must carry, checked before electron-builder packs it
 * (package.json, `build.beforePack`). A folder named in `extraResources` that
 * is not there is only a warning to electron-builder: a local `npm run
 * package` built an installer without the engine package and without Python,
 * and on a friend's clean computer the first-run setup could do nothing
 * (desktop-shell-7). In CI too, as the hook is part of the build's own
 * settings.
 *
 * - `cortex-paket/`: exactly this checkout's engine, `beyin-v3-<VERSION>.zip`,
 *   with its list of digests beside it (scripts/cortex-paket.mjs);
 * - `python-paket/`: python.org's installer pinned in python.json, by its SHA-256
 *   (scripts/python-paket.mjs);
 * - the app's own version is the engine's (VERSION): the app tells an engine's
 *   age by it.
 */
function problems(desktop) {
  const found = [];
  const version = fs.readFileSync(path.join(desktop, '..', 'VERSION'), 'utf8').trim();
  const own = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
  if (own !== version) found.push(`package.json sürümü (${own}) VERSION dosyasındakiyle (${version}) aynı değil.`);

  const engine = path.join(desktop, 'cortex-paket');
  const zips = fs.existsSync(engine) ? fs.readdirSync(engine).filter((name) => /^beyin-v3-.*\.zip$/.test(name)) : [];
  const wanted = `beyin-v3-${version}.zip`;
  if (zips.length !== 1 || zips[0] !== wanted) {
    found.push(`cortex-paket/ içinde yalnız ${wanted} olmalı (bulunan: ${zips.join(', ') || 'hiçbiri'}); önce: npm run cortex-paket`);
  } else if (!fs.existsSync(path.join(engine, `beyin-v3-${version}.manifest.json`))) {
    found.push(`cortex-paket/beyin-v3-${version}.manifest.json yok; önce: npm run cortex-paket`);
  }

  const pin = JSON.parse(fs.readFileSync(path.join(desktop, 'python.json'), 'utf8'));
  const python = path.join(desktop, 'python-paket', `${pin.file}.paket`);
  if (!fs.existsSync(python)) {
    found.push(`python-paket/${pin.file}.paket yok; önce: npm run python-paket`);
  } else if (createHash('sha256').update(fs.readFileSync(python)).digest('hex') !== pin.sha256) {
    found.push(`python-paket/${pin.file}.paket python.json'daki SHA-256 ile tutmuyor; yeniden: npm run python-paket`);
  }
  return found;
}

/** electron-builder's hook: the build stops, with what is missing, before anything is packed. */
module.exports = async function beforePack() {
  const found = problems(path.resolve(__dirname, '..'));
  if (found.length) throw new Error(`Kurulum dosyası eksik kaynakla yapılmaz:\n- ${found.join('\n- ')}`);
};
module.exports.problems = problems;

// Run alone (`node scripts/check-resources.cjs`): the same check, its answer as an exit code.
if (require.main === module) {
  const found = problems(path.resolve(__dirname, '..'));
  for (const one of found) console.error(one);
  process.exit(found.length ? 1 : 0);
}
