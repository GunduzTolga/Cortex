/**
 * What the main process says, in Turkish.
 *
 * The main process refuses in English (src/i18n/index.ts): a sentence it threw
 * reaches the window as the detail under a translated title, or as the line
 * under a chat answer that failed. A window in Turkish showed a Turkish title
 * over an English sentence; this puts the sentence in Turkish too, at the
 * point where it is shown, so the main process and its tests keep one language.
 *
 * One rule per sentence the main process can throw (electron/**, setup.ts
 * aside: it speaks Turkish already). What a sentence carries - a path, a
 * name, a program's own words - is caught and put back as it was. A sentence
 * no rule knows comes back unchanged: a CLI's own error, a system error.
 * tests/refusalsTr.test.ts reads electron/ for thrown sentences, so a new one
 * without a rule here fails the tests.
 */

interface Rule {
  pattern: RegExp;
  say: (parts: string[]) => string;
}

/** Why a name was refused (core/vaultNotes.ts, `nameProblem`), as tr.ts says it under the name field. */
const NAME_PROBLEMS: Record<string, string> = {
  empty: 'ad boş',
  long: 'ad çok uzun',
  characters: 'ad şunları içeremez: \\ / : * ? " < > | # ^ [ ]',
  dot: 'ad nokta ile başlayamaz, nokta ya da boşlukla bitemez',
  reserved: 'Windows bu adı kendine ayırıyor',
};

/** The reason in brackets where it is known; left out where it is not, rather than shown in English. */
const why = (problem: string) => (NAME_PROBLEMS[problem] ? ` (${NAME_PROBLEMS[problem]})` : '');

/** What is not done to a note Cortex keeps (vaultNotes.ts, `refuseKept`); anything else, said in general. */
const NOT_DONE: Record<string, string> = {
  'moved or renamed': 'taşınamaz ya da yeniden adlandırılamaz',
  'put in the bin': 'çöpe taşınamaz',
};
const notDone = (what: string) => NOT_DONE[what] ?? 'değiştirilemez';

/** Where something already is: a folder by its path, or the vault itself. */
const placed = (folder: string) => (folder === 'the vault' ? 'Kasada' : `${folder} klasöründe`);

/** A program's last words carry one sentence of Cortex's own (acp.ts, a line too long): that one is put in Turkish, the program's are left. */
const programWords = (text: string) => text.replace(/A message longer than (\d+) bytes: the program was stopped\./g, '$1 bayttan uzun bir mesaj geldi: program durduruldu.');

/** Order matters only where one sentence begins as another does: the longer first. */
const RULES: Rule[] = [
  // electron/ipc.ts
  { pattern: /^Refused: not the app’s own page\.$/, say: () => 'Reddedildi: bu, uygulamanın kendi sayfası değil.' },

  // electron/services/acp.ts: a program spoken to over JSON-RPC
  { pattern: /^The program is not running\.$/, say: () => 'Program çalışmıyor.' },
  { pattern: /^The program stopped\.$/, say: () => 'Program durdu.' },
  { pattern: /^The program stopped: ([\s\S]*)$/, say: ([words]) => `Program durdu: ${programWords(words)}` },
  { pattern: /^The program refused\.$/, say: () => 'Program isteği reddetti.' },

  // electron/services/acpChat.ts, codexChat.ts, claudeChat.ts, chat.ts, auth.ts
  { pattern: /^([\s\S]+?) is not installed on this machine\.$/, say: ([cli]) => `${cli} bu bilgisayarda kurulu değil.` },
  { pattern: /^The program did not start a session\.$/, say: () => 'Program bir oturum başlatmadı.' },
  { pattern: /^The chat is not connected; write to it first\.$/, say: () => 'Sohbet bağlı değil; önce bir mesaj yaz.' },
  { pattern: /^Claude Code was stopped\.$/, say: () => 'Claude Code durduruldu.' },
  { pattern: /^Claude Code stopped\.$/, say: () => 'Claude Code durdu.' },
  { pattern: /^Claude Code stopped: ([\s\S]*)$/, say: ([words]) => `Claude Code durdu: ${words}` },
  { pattern: /^Claude Code could not start: ([\s\S]*)$/, say: ([words]) => `Claude Code başlatılamadı: ${words}` },
  { pattern: /^(Claude Code|Codex) could not answer\.$/, say: ([tool]) => `${tool} cevap veremedi.` },
  { pattern: /^Codex did not start a thread\.$/, say: () => 'Codex bir konuşma başlatmadı.' },

  // electron/services/localChat.ts: LM Studio, Ollama
  { pattern: /^([\s\S]+?) is not running\. Open it, load a model, and write again\.$/, say: ([server]) => `${server} çalışmıyor. Uygulamayı aç, bir model yükle ve yeniden yaz.` },
  { pattern: /^([\s\S]+?) is not running, or has no model\. Open it, load a model, and write again\.$/, say: ([server]) => `${server} çalışmıyor ya da yüklü bir modeli yok. Uygulamayı aç, bir model yükle ve yeniden yaz.` },
  { pattern: /^([\s\S]+?) has no model\.$/, say: ([server]) => `${server}: yüklü bir model yok.` },

  // electron/services/auth.ts, keys.ts: signing in, keys
  { pattern: /^Not a tool Cortex signs in to\.$/, say: () => 'Bu, Cortex’in giriş yaptığı araçlardan biri değil.' },
  { pattern: /^This tool is not signed in to from here\.$/, say: () => 'Bu araca buradan giriş yapılmıyor.' },
  { pattern: /^Signing in from Cortex opens a console window, which only Windows does here\.$/, say: () => 'Cortex’ten giriş yapmak bir konsol penceresi açar; bu yalnız Windows’ta çalışır.' },
  { pattern: /^This tool keeps its keys in its own sign-in\.$/, say: () => 'Bu araç anahtarlarını kendi girişinde saklar.' },
  { pattern: /^That is not a key\.$/, say: () => 'Bu bir anahtar değil.' },
  { pattern: /^Codex did not take the key\.$/, say: () => 'Codex anahtarı kabul etmedi.' },
  { pattern: /^This tool does not take a key here\.$/, say: () => 'Bu araç burada anahtar almıyor.' },
  { pattern: /^That is not an address\.$/, say: () => 'Bu bir adres değil.' },
  { pattern: /^This computer offers no safe place to keep a key\.$/, say: () => 'Bu bilgisayarda anahtarı saklayacak güvenli bir yer yok.' },

  // electron/services/chat.ts: the chats
  { pattern: /^Choose the vault first\.$/, say: () => 'Önce kasayı seç.' },
  { pattern: /^Not a chat\.$/, say: () => 'Bu bir sohbet değil.' },
  { pattern: /^That chat is gone\.$/, say: () => 'Bu sohbet artık yok.' },
  { pattern: /^An empty message is not sent\.$/, say: () => 'Boş mesaj gönderilmez.' },
  { pattern: /^That message is too long to send\.$/, say: () => 'Bu mesaj gönderilemeyecek kadar uzun.' },
  { pattern: /^Not a CLI the chat knows\.$/, say: () => 'Bu, sohbetin tanıdığı bir yapay zeka aracı değil.' },
  { pattern: /^That chat was held in another vault\.$/, say: () => 'Bu sohbet başka bir kasada tutuluyordu.' },
  { pattern: /^Wait for the answer, or stop it, before writing again\.$/, say: () => 'Yeniden yazmadan önce cevabı bekle ya da durdur.' },
  { pattern: /^Not a setting\.$/, say: () => 'Bu bir ayar değil.' },
  { pattern: /^Not a choice this chat offers\.$/, say: () => 'Bu, sohbetin sunduğu bir seçenek değil.' },
  { pattern: /^Wait for the answer to end before changing this\.$/, say: () => 'Bunu değiştirmeden önce cevabın bitmesini bekle.' },
  { pattern: /^A chat needs a name\.$/, say: () => 'Sohbetin bir adı olmalı.' },

  // electron/services/vault.ts: choosing the vault
  { pattern: /^([\s\S]+?) cannot be the vault: the app keeps its own files in or around it\. Choose the folder your notes are in\.$/, say: ([name]) => `${name} kasa olamaz: uygulama kendi dosyalarını onun içinde ya da çevresinde tutuyor. Notlarının durduğu klasörü seç.` },
  { pattern: /^The vault ([\s\S]+?) leads elsewhere through a link now\. Choose it again\.$/, say: ([name]) => `${name} kasası artık bir bağlantı üzerinden başka bir yere çıkıyor. Onu yeniden seç.` },
  { pattern: /^([\s\S]+?) leads elsewhere through a link\. Choose the folder itself\.$/, say: ([name]) => `${name} bir bağlantı üzerinden başka bir yere çıkıyor. Klasörün kendisini seç.` },
  { pattern: /^Not a folder: ([\s\S]*)$/, say: ([name]) => `Klasör değil: ${name}` },

  // electron/services/vaultNotes.ts: the notes screen
  { pattern: /^Not a path inside the vault\.$/, say: () => 'Bu, kasanın içinde bir yol değil.' },
  { pattern: /^Not a path the notes screen reads: ([\s\S]*)$/, say: ([path]) => `Not ekranının okuduğu bir yol değil: ${path}` },
  { pattern: /^The vault ([\s\S]+?) is not where it was any more\.$/, say: ([name]) => `${name} kasası artık olduğu yerde değil.` },
  { pattern: /^Not in the vault: ([\s\S]*)$/, say: ([path]) => `Kasada değil: ${path}` },
  { pattern: /^Reached through a link: ([\s\S]*)$/, say: ([path]) => `Bir bağlantı üzerinden ulaşılıyor: ${path}` },
  { pattern: /^Not a note: ([\s\S]*)$/, say: ([path]) => `Not değil: ${path}` },
  { pattern: /^A note is read as a note: ([\s\S]*)$/, say: ([path]) => `Bu bir not, not olarak açılır: ${path}` },
  { pattern: /^Not a file: ([\s\S]*)$/, say: ([path]) => `Dosya değil: ${path}` },
  { pattern: /^A note is saved as text, over the version that was read\.$/, say: () => 'Not, okunan sürümün üzerine metin olarak kaydedilir.' },
  { pattern: /^The note is larger than a note the screen keeps\.$/, say: () => 'Bu not, ekranın kaydedebileceğinden büyük.' },
  { pattern: /^([\s\S]+?) is not UTF-8 text, and saving it here would change bytes the person did not touch\.$/, say: ([path]) => `${path} UTF-8 metin değil; burada kaydetmek dokunmadığın baytları da değiştirir.` },
  { pattern: /^Cortex keeps ([\s\S]+?) itself: it is read here and not written\.$/, say: ([path]) => `Cortex bunu kendisi tutuyor, burada okunur ama yazılmaz: ${path}` },
  { pattern: /^Cortex keeps ([\s\S]+?) itself: it is not ([\s\S]+?) from here\.$/, say: ([path, what]) => `Cortex bunu kendisi tutuyor, buradan ${notDone(what)}: ${path}` },
  { pattern: /^([\s\S]+?) holds notes Cortex keeps \(([\s\S]+?)\): it is not ([\s\S]+?) from here\.$/, say: ([path, kept, what]) => `Bu klasörde Cortex’in tuttuğu notlar var (${kept}), buradan ${notDone(what)}: ${path}` },
  { pattern: /^A note needs a name\.$/, say: () => 'Notun bir adı olmalı.' },
  { pattern: /^A folder needs a name\.$/, say: () => 'Klasörün bir adı olmalı.' },
  { pattern: /^A new name is needed\.$/, say: () => 'Yeni bir ad gerekli.' },
  { pattern: /^Not a name a note can have \(([^)]*)\): ([\s\S]*)$/, say: ([problem, name]) => `Bir not bu adı alamaz${why(problem)}: ${name}` },
  { pattern: /^Not a name a folder can have \(([^)]*)\): ([\s\S]*)$/, say: ([problem, name]) => `Bir klasör bu adı alamaz${why(problem)}: ${name}` },
  { pattern: /^Not a name it can have \(([^)]*)\): ([\s\S]*)$/, say: ([problem, name]) => `Bu ad verilemez${why(problem)}: ${name}` },
  { pattern: /^A note named ([\s\S]+?) is already in ([\s\S]+)\.$/, say: ([name, folder]) => `${placed(folder)} ${name} adında bir not zaten var.` },
  { pattern: /^Something named ([\s\S]+?) is already in ([\s\S]+)\.$/, say: ([name, folder]) => `${placed(folder)} ${name} adında bir şey zaten var.` },
  { pattern: /^No free name for a new note was found\.$/, say: () => 'Yeni not için boş bir ad bulunamadı.' },
  { pattern: /^No free name for ([\s\S]+?) was found\.$/, say: ([name]) => `${name} için boş bir ad bulunamadı.` },
  { pattern: /^The vault itself is not moved from here\.$/, say: () => 'Kasanın kendisi buradan taşınmaz.' },
  { pattern: /^The vault itself is not put in the bin from here\.$/, say: () => 'Kasanın kendisi buradan çöpe taşınmaz.' },
  { pattern: /^A folder cannot go inside itself: ([\s\S]*)$/, say: ([path]) => `Bir klasör kendi içine taşınamaz: ${path}` },
  { pattern: /^([\s\S]+?) in the vault is not a folder Cortex can keep its bin in\.$/, say: ([name]) => `Kasadaki ${name}, Cortex’in çöp kutusunu tutabileceği bir klasör değil.` },
  { pattern: /^Not something in the bin\.$/, say: () => 'Çöp kutusunda böyle bir şey yok.' },
  { pattern: /^([\s\S]+?) is not in the bin any more\.$/, say: ([name]) => `${name} artık çöp kutusunda değil.` },
  { pattern: /^([\s\S]+?) is not a folder any more\.$/, say: ([path]) => `${path} artık bir klasör değil.` },
  { pattern: /^Opened in Obsidian or shown in its folder, nothing else\.$/, say: () => 'Yalnız Obsidian’da açılır ya da klasöründe gösterilir.' },
];

/** The Turkish of a sentence the main process said; a sentence it does not know, as it came. */
export function turkishOf(message: string): string {
  for (const rule of RULES) {
    const found = message.match(rule.pattern);
    if (found) return rule.say(found.slice(1));
  }
  return message;
}
