import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSettings } from './settings';
import { netFetch } from './netFetch';
import { UNPACK, runPython } from './setup';
import { toolsDir } from './toolPackages';

/**
 * Git for someone who has never installed it (Faz 1): on Windows, where none is on the PATH, Cortex brings MinGit -
 * Git for Windows' own small package for programs that need git (38 MB) - into %LOCALAPPDATA%\Cortex\tools\git.
 * The version and each package's SHA-256 are pinned here (read from the release, and the 64-bit one downloaded and
 * hashed again, 4 November); a download that is not those bytes is thrown away before anything in it is unpacked,
 * and nothing in it runs until it is all in place. A git on the PATH is always the one used; macOS and Linux have
 * their own (the window says where to get it).
 *
 * The engine is told which git to run as its environment (`CORTEX_GIT`, beyin_v3_esitle.py `git_program`), which it
 * takes only from outside the vault.
 */

const TAG = 'v2.56.0.windows.4';
export const MINGIT = {
  version: '2.56.0.4',
  x64: { file: 'MinGit-2.56.0.4-64-bit.zip', size: 39846926, sha256: 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877' },
  arm64: { file: 'MinGit-2.56.0.4-arm64.zip', size: 37980967, sha256: '70f7649f78088c1db1d2f3571ca46a04d5bef06e4e9d56d8ed7f9829e8c6c4db' },
};
const RELEASES = `https://github.com/git-for-windows/git/releases/download/${TAG}/`;
/** Git's program in the package: the `cmd` one, which finds the rest of the package itself. */
const PROGRAM = ['cmd', 'git.exe'];
const RECORD = 'cortex-tool.json';
/** A download this slow is given up: 15 minutes is under 45 kB/s for 38 MB. */
const DOWNLOAD_LIMIT = 15 * 60_000;

const say = (tr: string, en: string) => (readSettings().language === 'en' ? en : tr);

export class GitToolRefusal extends Error {}

type Pin = (typeof MINGIT)['x64'];
let releases = RELEASES;
let platform: NodeJS.Platform = process.platform;
let pinFor = (arch: 'x64' | 'arm64'): Pin => MINGIT[arch];
/** The tests stand a local server in for GitHub's releases, a package of their own for MinGit, and play Windows. */
export function setGitToolForTests(next: { releases: string; platform: NodeJS.Platform; pin: Pin } | null): void {
  releases = next?.releases ?? RELEASES;
  platform = next?.platform ?? process.platform;
  pinFor = next ? () => next.pin : (arch) => MINGIT[arch];
}

/** Whether Cortex brings git here: on Windows alone. */
export const bringsGit = () => platform === 'win32';

/** The git Cortex brought, when it did and all of it is there: the program's path; null otherwise. */
export function ownGit(dir: string = toolsDir()): string | null {
  const folder = path.join(dir, 'git');
  try {
    const record = JSON.parse(fs.readFileSync(path.join(folder, RECORD), 'utf8')) as { name?: unknown };
    if (record.name !== 'MinGit') return null;
  } catch {
    return null;
  }
  const program = path.join(folder, ...PROGRAM);
  return fs.existsSync(program) ? program : null;
}

const archOf = (arch: string = process.arch) => (arch === 'arm64' ? 'arm64' : 'x64');

/**
 * MinGit downloaded, checked and unpacked into a folder beside where it goes, put in place once all of it is there.
 * Returns the program. The steps are said as they come (`step`).
 */
export async function installGit(step: (text: string) => void = () => undefined, options: { dir?: string; arch?: string } = {}): Promise<string> {
  if (!bringsGit()) throw new GitToolRefusal(say("Git'i bu bilgisayara kendin kur: git-scm.com/downloads", 'Install Git on this computer yourself: git-scm.com/downloads'));
  const pin = pinFor(archOf(options.arch));
  const dir = options.dir ?? toolsDir();
  const target = path.join(dir, 'git');
  const part = path.join(dir, 'git-indiriliyor');
  const zip = path.join(dir, 'git-indiriliyor.zip');
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(part, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  try {
    step(say(`Git indiriliyor (${Math.round(pin.size / 1e6)} MB)…`, `Downloading Git (${Math.round(pin.size / 1e6)} MB)…`));
    let answer: Response;
    try {
      answer = await netFetch(`${releases}${pin.file}`, { signal: AbortSignal.timeout(DOWNLOAD_LIMIT) });
    } catch {
      throw new GitToolRefusal(say('Git indirilemedi; internet bağlantını kontrol edip yeniden dene.', 'Git could not be downloaded; check the internet connection and try again.'));
    }
    if (!answer.ok || !answer.body) throw new GitToolRefusal(say(`Git indirilemedi (${answer.status}); yeniden dene.`, `Git could not be downloaded (${answer.status}); try again.`));
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        // Longer than the package is not the package: stopped before the disk fills with it.
        if (size > pin.size) return done(new GitToolRefusal(say('İndirilen dosya beklenen Git paketi değil; hiçbir şey kurulmadı.', 'The download is not the expected Git package; nothing was installed.')));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]), tap, fs.createWriteStream(zip));
    } catch (err) {
      if (err instanceof GitToolRefusal) throw err;
      throw new GitToolRefusal(say('Git indirmesi yarıda kaldı; yeniden dene.', 'The Git download stopped halfway; try again.'));
    }
    if (size !== pin.size || hash.digest('hex') !== pin.sha256) {
      throw new GitToolRefusal(say('İndirilen dosya beklenen Git paketi değil (SHA-256 tutmadı); hiçbir şey kurulmadı.', 'The download is not the expected Git package (its SHA-256 differs); nothing was installed.'));
    }
    step(say('Git kuruluyor…', 'Installing Git…'));
    fs.mkdirSync(part, { recursive: true });
    try {
      await runPython(['-I', '-c', UNPACK, zip, part], { cwd: part, timeout: 5 * 60_000 });
    } catch (err) {
      // What Python said (a traceback's last line, a path) is the developer's: the person is told what to do.
      console.warn('[git] the package could not be unpacked', err);
      throw new GitToolRefusal(
        say(
          'Git paketi açılamadı; diskte yer olduğunu ve Python’un kurulu olduğunu (Ayarlar → Cortex) kontrol edip yeniden dene.',
          'The Git package could not be unpacked; check that the disk has room and that Python is installed (Settings → Cortex), then try again.',
        ),
      );
    }
    if (!fs.existsSync(path.join(part, ...PROGRAM))) throw new GitToolRefusal(say('Git paketinde git.exe yok; hiçbir şey kurulmadı.', 'The Git package has no git.exe in it; nothing was installed.'));
    fs.writeFileSync(path.join(part, RECORD), `${JSON.stringify({ name: 'MinGit', version: MINGIT.version, program: PROGRAM.join('/') }, null, 2)}\n`);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(part, target);
    } catch {
      throw new GitToolRefusal(say('Git yerine konamadı; açık bir Cortex penceresi ya da terminal kullanıyorsa kapatıp yeniden dene.', 'Git could not be put in place; close what is using it, then try again.'));
    }
  } catch (err) {
    fs.rmSync(part, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(zip, { force: true });
  }
  return path.join(target, ...PROGRAM);
}
