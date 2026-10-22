import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { readProperties, splitProperties } from '../../core/vaultNotes';
import { TALK_TOOLS, type TalkLine, type TalkPerson, type TalkRequest, type TalkTool } from '../../shared/office';
import { childEnv } from './acp';
import { programOf } from './clis';
import { keyEnv } from './keys';
import { baseOf, findLocal } from './localModels';
import { readSettings } from './settings';
import { readVaultNote, vaultIndex } from './vaultNotes';

/**
 * The office's live conversations (shared/office.ts): the model the person chose in the office's
 * settings writes a short scene for the team, about the notes they last worked on.
 *
 * What goes to the model is what the office's settings say goes: the titles of the notes edited
 * last and a short piece of each, the cast, how the person is addressed. Not the inbox, and no note
 * the engine marks private or from a source it does not trust: a clipboard, a mail, a forwarded
 * Telegram message caught there. A model server on this
 * machine keeps it on the machine; Claude Code sends it to Anthropic, as any of its turns does.
 * Claude Code runs in a folder of the app's own, not in the vault, so no hook or file of the
 * vault is in its reach. Programs are started without a shell.
 */

const NOTES = 6;
const PIECE = 220;
const LINE = 120;
const TIMEOUT = { local: 120_000, claude: 150_000 };
/** Claude Code's models, the quickest first: a scene of six lines needs no more. */
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'];

let writing = false;

const say = (tr: string, en: string) => (readSettings().language === 'en' ? en : tr);

export async function talkModels(tool: unknown): Promise<{ models: string[]; loaded: string[] }> {
  if (!TALK_TOOLS.includes(tool as TalkTool)) throw new Error(say('Ofis bu araçla konuşma yazamaz.', 'Not a tool the office talks through.'));
  if (tool === 'claude') return { models: CLAUDE_MODELS, loaded: [] };
  const found = await findLocal(tool as 'lmstudio' | 'ollama');
  const loaded = found.loaded.filter((one) => found.models.includes(one));
  return { models: [...loaded, ...found.models.filter((one) => !loaded.includes(one))], loaded };
}

/** A note's body as a short plain piece: no properties block, no Markdown marks, one line. */
export function pieceOf(text: string, limit = PIECE): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>~=]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

/** The vault's inbox, at its top (`📥 000-Inbox`), as core/vaultNotes.ts finds it: what was caught there is the person's, not yet a note. */
const IN_INBOX = /^(?:[^/]*\s)?000-Inbox\//;

/** Whether the engine marks a note as not to go anywhere: private (a clipboard, a mail, a file caught), or from a source it does not trust. */
export function keptPrivate(text: string): boolean {
  const properties = readProperties(splitProperties(text).yaml).properties;
  const value = (key: string) => {
    const found = properties.find((one) => one.key.toLowerCase() === key)?.value;
    return typeof found === 'string' ? found.trim().toLowerCase() : found;
  };
  return value('visibility') === 'private' || value('untrusted') === true || value('trust') === 'untrusted' || value('kaynak_guveni') === 'guvenilmeyen';
}

/** The notes worked on last, by title with a short piece: what Cortex's engine keeps left out, and what it marks private. */
async function recentNotes(): Promise<Array<{ title: string; piece: string }>> {
  const index = await vaultIndex();
  const candidates = index.notes
    .filter((note) => !note.keeper && !note.tooLarge && !/^(receipts|daily|knowledge)\//.test(note.path) && !IN_INBOX.test(note.path.normalize('NFC')))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, NOTES * 4);
  const out: Array<{ title: string; piece: string }> = [];
  for (const note of candidates) {
    if (out.length >= NOTES) break;
    let text = '';
    try {
      text = (await readVaultNote(note.path)).text ?? '';
    } catch {
      text = '';
    }
    if (keptPrivate(text)) continue;
    out.push({ title: path.posix.basename(note.path).replace(/\.md$/i, ''), piece: pieceOf(text) });
  }
  return out;
}

/** What the model is asked, in the window's language. */
export function scenePrompt(
  cast: TalkPerson[],
  notes: Array<{ title: string; piece: string }>,
  userName: string | null,
  language: 'tr' | 'en',
): { system: string; user: string } {
  const people = cast.map((one) => `- ${one.id} · ${one.name} (${one.role}): ${one.bio}`).join('\n');
  const list = notes.length ? notes.map((one, i) => `${i + 1}. «${one.title}»${one.piece ? ` — ${one.piece}` : ''}`).join('\n') : '';
  if (language === 'en') {
    return {
      system: [
        "Inside Cortex, a notes app, there is a pixel-art office whose team works on the user's notes. You write its short scenes.",
        'Rules:',
        '- English, natural, a little funny, short: 4 to 6 lines.',
        '- Two or three people talk, chosen from the cast; keep who they are.',
        '- Name at least one of the notes by its title.',
        `- At most ${LINE - 30} characters a line.`,
        userName ? `- The user is called "${userName}"; the team may speak of them by that name.` : "- The user may be spoken of as the vault's owner.",
        '- Pyn is the boss: if Pyn speaks, it is very short ("Hmm.").',
        '- Answer with JSON only: {"lines":[{"who":"<cast id>","text":"..."}]}',
      ].join('\n'),
      user: `Cast:\n${people}\n\n${list ? `Notes worked on last:\n${list}` : 'No notes worked on yet: the team talks about getting started.'}`,
    };
  }
  return {
    system: [
      'Cortex adlı bir not uygulamasının içinde piksel sanatıyla çizilmiş bir ofis var; ekibi kullanıcının notları üzerinde çalışıyor. Sen bu ofisin kısa sahnelerini yazıyorsun.',
      'Kurallar:',
      '- Türkçe, doğal, biraz esprili ve kısa: 4 ila 6 satır.',
      '- Kadrodan iki ya da üç kişi konuşsun; kişiliklerini koru.',
      '- Notlardan en az birinin başlığını adıyla an.',
      `- Bir satır en fazla ${LINE - 30} karakter.`,
      userName ? `- Kullanıcıya "${userName}" denir; ekip ondan bu adla söz edebilir.` : '- Kullanıcıdan "kasanın sahibi" diye söz edilebilir.',
      '- Pyn patrondur: konuşursa çok kısa konuşur ("Hmm.").',
      '- Yalnız JSON ver: {"lines":[{"who":"<kişi id>","text":"..."}]}',
    ].join('\n'),
    user: `Kadro:\n${people}\n\n${list ? `Son çalışılan notlar:\n${list}` : 'Henüz not yok: ekip işe başlamaktan konuşsun.'}`,
  };
}

/**
 * The lines in what the model answered: its JSON, or, from a model that wrote the scene as a
 * script, "Name: line" rows. Only the cast speaks; thinking (<think>…</think>) is not a line.
 */
export function linesOf(answer: string, cast: TalkPerson[]): TalkLine[] {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const ids = new Set(cast.map((one) => one.id));
  const byName = new Map(cast.map((one) => [one.name.toLocaleLowerCase('tr'), one.id]));
  const clean = (one: string) => one.replace(/\s+/g, ' ').trim().slice(0, LINE);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as { lines?: unknown };
      if (Array.isArray(value.lines)) {
        const lines = value.lines
          .map((one) => one as { who?: unknown; text?: unknown })
          .map((one) => {
            const who = typeof one.who === 'string' ? one.who.trim().toLocaleLowerCase('tr') : '';
            return { who: ids.has(who) ? who : (byName.get(who) ?? ''), text: typeof one.text === 'string' ? clean(one.text) : '' };
          })
          .filter((one) => one.who && one.text);
        if (lines.length) return lines.slice(0, 8);
      }
    } catch {
      /* not JSON after all: read it as a script below */
    }
  }
  const lines: TalkLine[] = [];
  for (const row of text.split(/\r?\n/)) {
    const match = row.match(/^\s*[-*]?\s*\**([^:*]{2,24})\**\s*:\s*(.+)$/);
    if (!match) continue;
    const name = match[1].trim().toLocaleLowerCase('tr');
    const who = ids.has(name) ? name : byName.get(name);
    if (who) lines.push({ who, text: clean(match[2].replace(/^["“]|["”]$/g, '')) });
  }
  return lines.slice(0, 8);
}

/** What a model server answered: the text, and what it thought before it, apart (LM Studio's `reasoning_content`). */
interface LocalAnswer {
  content: string;
  thought: string;
}

/**
 * A model server asked once, not streamed: its OpenAI-compatible chat endpoint. `think: false` asks
 * a thinking model (Qwen 3.5, GLM) to answer at once: a short scene needs no thinking, and a
 * thinking model otherwise spends its whole budget on it and writes nothing (seen with
 * qwen3.5-9b: 700 tokens of thought, an empty answer). A server that does not know the option
 * ignores it, and gets room to think and still answer.
 */
function askLocal(tool: 'lmstudio' | 'ollama', model: string, system: string, user: string, think: boolean): Promise<LocalAnswer> {
  const url = new URL('/v1/chat/completions', baseOf(tool));
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.8,
    stream: false,
    ...(think ? { max_tokens: 3000 } : { max_tokens: 700, reasoning_effort: 'none' }),
  });
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: TIMEOUT.local },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (data += chunk));
        response.on('end', () => {
          try {
            const value = JSON.parse(data) as {
              choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
              error?: { message?: unknown } | string;
            };
            const message = value.choices?.[0]?.message;
            const content = message?.content;
            const thought = typeof message?.reasoning_content === 'string' ? message.reasoning_content : typeof message?.reasoning === 'string' ? message.reasoning : '';
            if (typeof content === 'string') return resolve({ content, thought });
            const said = typeof value.error === 'string' ? value.error : value.error?.message;
            reject(new Error(typeof said === 'string' ? said : say('Model boş cevap verdi.', 'The model answered nothing.')));
          } catch {
            reject(new Error(say('Model anlaşılır bir cevap vermedi.', 'The model did not answer in a way that could be read.')));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(say('Model zamanında cevap vermedi.', 'The model did not answer in time.'))));
    request.on('error', (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          ? new Error(say('Sunucu kapalı: uygulamasını açıp bir model yükle.', 'The server is not running: open its app and load a model.'))
          : err,
      ),
    );
    request.end(body);
  });
}

/** Claude Code asked once, its answer as text, from a folder of the app's own (no vault, no hooks). */
function askClaude(model: string, system: string, user: string): Promise<string> {
  const program = programOf('claude');
  if (!program) return Promise.reject(new Error(say('Claude Code bulunamadı.', 'Claude Code was not found.')));
  const folder = path.join(app.getPath('userData'), 'office');
  fs.mkdirSync(folder, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(program.command, [...program.args, '-p', '--output-format', 'text', '--model', model], {
      cwd: folder,
      env: childEnv({ ...(program.env ?? {}), ...keyEnv('claude') }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let out = '';
    let errors = '';
    const timer = setTimeout(() => child.kill(), TIMEOUT.claude);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (errors = (errors + chunk).slice(-2000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(errors.trim().split(/\r?\n/).pop() || say('Claude Code cevap vermedi.', 'Claude Code did not answer.')));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${system}\n\n${user}`);
  });
}

export async function officeTalk(request: unknown): Promise<TalkLine[]> {
  const asked = (request && typeof request === 'object' ? request : {}) as Partial<TalkRequest>;
  if (!TALK_TOOLS.includes(asked.tool as TalkTool)) throw new Error(say('Ofis bu araçla konuşma yazamaz.', 'Not a tool the office talks through.'));
  const cast = (Array.isArray(asked.cast) ? asked.cast : [])
    .filter((one): one is TalkPerson => Boolean(one) && typeof one.id === 'string' && typeof one.name === 'string')
    .map((one) => ({ id: one.id, name: one.name, role: String(one.role ?? ''), bio: String(one.bio ?? '').slice(0, 300) }))
    .slice(0, 16);
  if (cast.length < 2) throw new Error(say('Konuşma için ofiste en az iki kişi gerek.', 'The office needs two people to talk.'));
  if (writing) throw new Error(say('Bir konuşma zaten yazılıyor.', 'A conversation is already being written.'));
  writing = true;
  try {
    const language = asked.language === 'en' ? 'en' : 'tr';
    const { system, user } = scenePrompt(cast, await recentNotes(), readSettings().userName, language);
    let answer: string;
    if (asked.tool === 'claude') {
      answer = await askClaude(CLAUDE_MODELS.includes(String(asked.model)) ? String(asked.model) : 'haiku', system, user);
    } else {
      const tool = asked.tool as 'lmstudio' | 'ollama';
      const { models, loaded } = await talkModels(tool);
      const model = typeof asked.model === 'string' && models.includes(asked.model) ? asked.model : (loaded[0] ?? models[0]);
      if (!model) throw new Error(say('Sunucuda model yok: uygulamasında bir model indir ya da yükle.', 'The server has no model: download or load one in its app.'));
      let said = await askLocal(tool, model, system, user, false);
      // It thought all the same (a server that ignores "no thinking"): once more, with room to think and answer.
      if (!said.content.trim() && said.thought) said = await askLocal(tool, model, system, user, true);
      if (!said.content.trim() && said.thought) {
        throw new Error(say('Model yalnız düşündü, bir şey yazmadı; düşünmeyen bir model seç ya da yeniden dene.', 'The model only thought and wrote nothing; pick a model that does not think, or try again.'));
      }
      answer = said.content;
    }
    const lines = linesOf(answer, cast);
    if (!lines.length) throw new Error(say('Model bir konuşma yazmadı; başka bir model dene.', 'The model wrote no conversation; try another model.'));
    return lines;
  } finally {
    writing = false;
  }
}
