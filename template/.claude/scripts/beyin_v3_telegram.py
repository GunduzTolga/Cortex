#!/usr/bin/env python3
"""Optional Telegram capture ("telegram"): what the person sends their own bot lands in yakala's inbox.

The person makes a bot of their own with @BotFather and gives Cortex its key. `kur` checks the
key and hands out a one-time pairing link; the first private chat that opens it is the only one
the bot listens to from then on, and every other chat is ignored without an answer.

`dinle` asks Telegram for new messages (long polling): no port is opened and nothing listens on
this machine. A text, a link, a photo, a file, a forwarded message becomes one yakala card in
`📥 000-Inbox/Yakala` (beyin_v3_yakala.capture), nothing moved or edited; a voice note is written
out by the local Whisper that voice typing set up (beyin_v3_ses.transcribe_file) and kept beside
its card. The bot answers each one quietly, so the phone shows it arrived.

Telegram keeps a bot's undelivered messages for 24 hours only. A message is never lost to that:

- each message in the chat has a number, and the numbers run on. A gap before the next message,
  or one found when this machine was away for most of a day (`probe`), is what was missed;
- each missing number is forwarded by the bot into the same chat, quietly, and the copy deleted
  at once: the forward hands the bot the message itself, however old (`recover`). A number that
  is no message (deleted, or another chat's) is passed over;
- what could not be fetched that way is asked for once: "forward them to me again".

The bot's key never enters the vault: the desktop app keeps it encrypted and passes it in
BEYIN_TELEGRAM_TOKEN; from a terminal, `kur --token` keeps it in state/telegram/token, readable by
this user only. Telegram's own servers carry what is sent to a bot (bot chats are not end-to-end
encrypted); nothing from the vault is ever sent back.
"""
import argparse
from datetime import datetime, timezone
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True

API = 'https://api.telegram.org'
DIR = 'telegram'
STATE_FILE = 'durum.json'
TOKEN_FILE = 'token'
TOKEN_ENV = 'BEYIN_TELEGRAM_TOKEN'
LOCK_FILE = 'dinle.lock'
POLL_SN = 50
# Telegram lets a bot download files up to this size; a larger one stays in Telegram, named on its card.
FILE_LIMIT = 20 * 1024 * 1024
# An audio file is written out when it is no longer than this; a voice note or a round video always.
AUDIO_LIMIT_SN = 600
# Numbers looked through in one recovery; older ones are asked for again.
GAP_LIMIT = 500
# A bot's undelivered messages last 24 hours: away for longer than this, the chat is looked through at start.
PROBE_AFTER_SN = 23 * 3600
KEEP_IDS = 500
CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
TOKEN_PATTERN = re.compile(r'^\d{5,15}:[A-Za-z0-9_-]{30,60}$')
URL_PATTERN = re.compile(r'https?://[^\s<>"]+')
NOT_FOUND = re.compile(r'message to (?:forward|copy) not found|message_id_invalid|message not found', re.I)
HELP = ('Bana gönderdiğin her şey Cortex\'in gelen kutusuna (📥 000-Inbox/Yakala) düşer: yazı, bağlantı, '
        'fotoğraf, dosya, başka sohbetten iletilen mesaj. Sesli notları bilgisayardaki Whisper yazıya çevirir. '
        'Bilgisayar kapalıyken gönderdiklerin açılınca gelir.')


class TelegramError(Exception):
    """Telegram said no: its error code, its description, and how long to wait when it asks."""

    def __init__(self, code, description, retry_after=None):
        super().__init__(description)
        self.code = code
        self.description = description
        self.retry_after = retry_after


class Bot:
    """The Bot API over HTTPS, standard library only. The key is in every address: no address is ever logged."""

    def __init__(self, token, opener=urlopen):
        self.token = token
        self.opener = opener

    def call(self, method, _wait=30, **params):
        """`_wait`: how long the connection waits for an answer (a long poll's is longer than Telegram's own)."""
        body = json.dumps(params, ensure_ascii=False).encode('utf-8')
        request = Request(API + '/bot' + self.token + '/' + method, data=body, headers={'Content-Type': 'application/json'})
        try:
            with self.opener(request, timeout=_wait) as response:
                answer = json.loads(response.read().decode('utf-8'))
        except ValueError:
            raise TelegramError(0, 'Telegram anlaşılmayan bir cevap verdi') from None
        except HTTPError as exc:
            try:
                answer = json.loads(exc.read().decode('utf-8'))
            except (ValueError, OSError):
                raise TelegramError(exc.code, 'HTTP ' + str(exc.code)) from None
        if not isinstance(answer, dict) or not answer.get('ok'):
            answer = answer if isinstance(answer, dict) else {}
            retry = (answer.get('parameters') or {}).get('retry_after')
            raise TelegramError(answer.get('error_code') or 0, str(answer.get('description') or 'Telegram hata verdi'), retry)
        return answer.get('result')

    def download(self, file_path, target, limit=FILE_LIMIT):
        request = Request(API + '/file/bot' + self.token + '/' + file_path)
        written = 0
        try:
            with self.opener(request, timeout=120) as response, open(target, 'wb') as sink:
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > limit:
                        raise TelegramError(0, 'Dosya beklenenden büyük')
                    sink.write(chunk)
        except HTTPError as exc:
            raise TelegramError(exc.code, 'HTTP ' + str(exc.code)) from None
        return target


# ---------------------------------------------------------------- state --
def folder(state):
    return Path(state) / DIR


def load(state):
    try:
        data = json.loads((folder(state) / STATE_FILE).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        data = {}
    return data if isinstance(data, dict) else {}


def save(state, data):
    where = folder(state)
    where.mkdir(parents=True, exist_ok=True)
    _private_write(where / STATE_FILE, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def _private_write(path, text):
    """Through a temporary renamed into place, readable by this user only."""
    fd, temporary = tempfile.mkstemp(prefix='.telegram-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def token_for(state, env=None):
    env = os.environ if env is None else env
    token = (env.get(TOKEN_ENV) or '').strip()
    if token:
        return token
    try:
        return (folder(state) / TOKEN_FILE).read_text(encoding='utf-8').strip() or None
    except OSError:
        return None


def check_token(token):
    token = (token or '').strip()
    if not TOKEN_PATTERN.match(token):
        raise ValueError('Bu bir bot anahtarına benzemiyor. @BotFather\'ın verdiği anahtar "123456789:AA…" gibi görünür.')
    return token


def _now():
    return time.time()


def _iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).astimezone().isoformat(timespec='seconds')


def _remember(data, key, number):
    kept = [one for one in data.get(key, []) if isinstance(one, int)]
    if number not in kept:
        kept.append(number)
    data[key] = sorted(kept)[-KEEP_IDS:]


def _saw(data, number):
    """A number now known to be taken in the chat: the highest seen is where a gap starts."""
    if isinstance(number, int) and number > int(data.get('son_id') or 0):
        data['son_id'] = number


def pairing_link(data):
    bot = (data.get('bot') or {}).get('kullanici_adi')
    code = data.get('eslesme_kodu')
    return 'https://t.me/' + bot + '?start=' + code if bot and code else None


# ---------------------------------------------------------------- setup --
def setup(state, token=None, keep_token=False, again=False, bot=None, env=None):
    """`kur`: the key checked with Telegram, a pairing link handed out; nothing is received yet."""
    token = check_token(token or token_for(state, env) or '')
    bot = bot or Bot(token)
    try:
        me = bot.call('getMe')
    except TelegramError as exc:
        if exc.code in (401, 404):
            raise ValueError('Telegram bu anahtarı tanımadı. @BotFather\'dan anahtarı yeniden kopyala.') from None
        raise
    if not me.get('is_bot'):
        raise ValueError('Bu anahtar bir bota ait değil.')
    hook = bot.call('getWebhookInfo') or {}
    if hook.get('url'):
        raise ValueError('Bu bot başka bir yere bağlı (webhook). Cortex için @BotFather\'dan ayrı bir bot aç.')
    data = load(state)
    same_bot = (data.get('bot') or {}).get('id') == me.get('id')
    if not same_bot or again:
        data = {'schema': 1}
    data['bot'] = {'id': me.get('id'), 'kullanici_adi': me.get('username'), 'ad': me.get('first_name')}
    if not data.get('sohbet'):
        data['eslesme_kodu'] = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        data['yanlis_kod'] = 0
    save(state, data)
    if keep_token:
        _private_write(folder(state) / TOKEN_FILE, token + '\n')
    try:
        bot.call('setMyCommands', commands=[{'command': 'yardim', 'description': 'Ne yapabildiğim'}])
    except (TelegramError, OSError):
        pass  # only the bot's menu
    return {'status': 'kuruldu', **status(state, env)}


def status(state, env=None):
    data = load(state)
    bot = data.get('bot') or {}
    return {'kurulu': bool(bot.get('id')) and bool(token_for(state, env)), 'anahtar': bool(token_for(state, env)),
            'bot': bot.get('kullanici_adi'), 'eslesti': bool(data.get('sohbet')), 'kisi': data.get('ad'),
            'baglanti': None if data.get('sohbet') else pairing_link(data), 'kod': None if data.get('sohbet') else data.get('eslesme_kodu'),
            'son_bakis': data.get('son_bakis'), 'son_hata': data.get('son_hata'), 'yakalanan': int(data.get('yakalanan') or 0),
            'calisiyor': running(state), 'sesli_not': _voice_notes(state), 'klasor': str(folder(state))}


def _voice_notes(state):
    """Whether a voice note can be written out here: voice typing set up, and able to open a recorded file."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import beyin_v3_ses as ses
    return bool(ses.installed(state) and ses.reads_files(state))


def forget(state):
    """`kaldir`: the bot's key and this machine's memory of the chat go; the cards in the vault stay."""
    where = folder(state)
    existed = where.exists()
    if running(state):
        raise ValueError('Telegram dinleyicisi çalışıyor; önce onu kapat (masaüstünde Telegram\'ı kapat).')
    shutil.rmtree(where, ignore_errors=True)
    return {'status': 'kaldirildi' if existed else 'zaten-yok', 'klasor': str(where)}


# ----------------------------------------------------------------- lock --
# One listener per machine: an OS advisory lock on state/telegram/dinle.lock (flock / msvcrt, the
# `_portalock` primitive, inline: that helper is not in the release package).
def _lock_handle(state):
    where = folder(state)
    where.mkdir(parents=True, exist_ok=True)
    return open(where / LOCK_FILE, 'a+b')


def _lock(handle):
    """True when this process now holds the lock; False when another listener holds it."""
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(handle):
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def running(state):
    if not (folder(state) / LOCK_FILE).exists():
        return False
    try:
        handle = open(folder(state) / LOCK_FILE, 'a+b')
    except OSError:
        return False
    with handle:
        if _lock(handle):
            _unlock(handle)
            return False
        return True


# -------------------------------------------------------------- reading --
def _name_of(origin):
    """Who a forwarded message came from, as Telegram names them."""
    if not isinstance(origin, dict):
        return None
    user = origin.get('sender_user') or {}
    chat = origin.get('chat') or origin.get('sender_chat') or {}
    name = ' '.join(part for part in (user.get('first_name'), user.get('last_name')) if part)
    name = name or origin.get('sender_user_name') or chat.get('title')
    handle = user.get('username') or chat.get('username')
    if name and handle:
        return name + ' (@' + handle + ')'
    return name or (('@' + handle) if handle else None)


def _origin(message):
    """(name, when) of a forwarded message's first sender; (None, None) for the person's own."""
    origin = message.get('forward_origin')
    if origin is None and message.get('forward_date'):  # Bot API before 7.0
        origin = {'type': 'user', 'sender_user': message.get('forward_from'), 'chat': message.get('forward_from_chat'),
                  'sender_user_name': message.get('forward_sender_name'), 'date': message.get('forward_date')}
    if not isinstance(origin, dict):
        return None, None
    return _name_of(origin), origin.get('date')


def _origin_link(message):
    """A channel post forwarded: its own address, so the card says where it is."""
    origin = message.get('forward_origin') or {}
    chat = origin.get('chat') or {}
    if origin.get('type') == 'channel' and chat.get('username') and origin.get('message_id'):
        return 'https://t.me/' + chat['username'] + '/' + str(origin['message_id'])
    return None


def links_of(message):
    text = message.get('text') or message.get('caption') or ''
    found = []
    for entity in (message.get('entities') or message.get('caption_entities') or []):
        if entity.get('type') == 'text_link' and entity.get('url'):
            found.append(entity['url'])
    for match in URL_PATTERN.finditer(text):
        found.append(match.group(0).rstrip('.,;:!?)]}\'"'))
    seen, out = set(), []
    for url in found:
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _media(message):
    """(kind, the file Telegram holds, a file name) for what a message carries; None for none."""
    if message.get('voice'):
        return 'ses', message['voice'], 'sesli-not.ogg'
    if message.get('video_note'):
        return 'ses', message['video_note'], 'yuvarlak-video.mp4'
    if message.get('audio'):
        audio = message['audio']
        kind = 'ses' if int(audio.get('duration') or 0) <= AUDIO_LIMIT_SN else 'dosya'
        return kind, audio, audio.get('file_name') or 'ses' + _suffix(audio.get('mime_type'), '.mp3')
    if message.get('photo'):
        biggest = max(message['photo'], key=lambda size: (size.get('file_size') or 0, size.get('width') or 0))
        return 'foto', biggest, 'foto.jpg'
    for key, default in (('document', 'dosya'), ('video', 'video.mp4'), ('animation', 'animasyon.mp4')):
        if message.get(key):
            item = message[key]
            return 'dosya', item, item.get('file_name') or default
    return None


def _suffix(mime, default):
    return {'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav',
            'audio/x-wav': '.wav', 'audio/flac': '.flac'}.get((mime or '').lower(), default)


def safe_name(name, stamp):
    """A downloaded file's name: its own, made safe for every file system, with the time in front."""
    name = Path(str(name or 'dosya')).name
    stem, suffix = os.path.splitext(name)
    suffix = re.sub(r'[^A-Za-z0-9.]', '', suffix)[:10]
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', stem).strip(' .')[:60] or 'dosya'
    return 'telegram-' + stamp + '-' + stem + suffix


def _place_or_message(message):
    if message.get('venue'):
        venue = message['venue']
        location = venue.get('location') or {}
        return '\n'.join(part for part in (venue.get('title'), venue.get('address'), _map(location)) if part)
    if message.get('location'):
        return 'Konum: ' + _map(message['location'])
    if message.get('contact'):
        contact = message['contact']
        name = ' '.join(part for part in (contact.get('first_name'), contact.get('last_name')) if part)
        return 'Kişi: ' + ', '.join(part for part in (name, contact.get('phone_number')) if part)
    return None


def _map(location):
    lat, lon = location.get('latitude'), location.get('longitude')
    if lat is None or lon is None:
        return ''
    return '%.6f, %.6f · https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=17/%.6f/%.6f' % (lat, lon, lat, lon, lat, lon)


def _first_line(text, limit=80):
    line = next((one.strip() for one in (text or '').splitlines() if one.strip()), '')
    return line if len(line) <= limit else line[:limit - 1].rstrip() + '…'


# -------------------------------------------------------------- capture --
class Context:
    """What one round of handling needs: the vault, the state, the bot, and how a voice note is written out."""

    def __init__(self, vault, state, bot, transcribe=None, sleep=time.sleep, now=_now):
        self.vault = Path(vault)
        self.state = Path(state)
        self.bot = bot
        self.transcribe = transcribe or _transcribe
        self.sleep = sleep
        self.now = now
        self.data = load(state)

    def save(self):
        save(self.state, self.data)

    def send(self, text, reply_to=None):
        """A quiet answer in the chat, its number kept as the bot's own."""
        params = {'chat_id': self.data['sohbet'], 'text': text, 'disable_notification': True,
                  'link_preview_options': {'is_disabled': True}}
        if reply_to:
            params['reply_parameters'] = {'message_id': reply_to, 'allow_sending_without_reply': True}
        try:
            sent = self.call('sendMessage', **params)
        except (TelegramError, OSError):
            return None
        _saw(self.data, (sent or {}).get('message_id'))
        return sent

    def call(self, method, **params):
        """A call, once more after the wait Telegram asks for when it says too many."""
        try:
            return self.bot.call(method, **params)
        except TelegramError as exc:
            if exc.code != 429:
                raise
            self.sleep(min(float(exc.retry_after or 5), 60))
            return self.bot.call(method, **params)


def _transcribe(state, path):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import beyin_v3_ses as ses
    return ses.transcribe_file(state, path)


def _own_kind(context, message):
    """'bot' for the bot's own message, 'kisi' for the person's, met again as a forward while recovering; else None."""
    origin = message.get('forward_origin') or {}
    user = origin.get('sender_user') or (message.get('forward_from') or {})
    if user.get('id') and user.get('id') == (context.data.get('bot') or {}).get('id'):
        return 'bot'
    if user.get('id') and user.get('id') == context.data.get('kisi_id'):
        return 'kisi'
    if origin.get('type') == 'hidden_user' and origin.get('sender_user_name') == context.data.get('kisi_adi_tam'):
        return 'kisi'
    return None


def capture_messages(context, messages, recovered=False):
    """One card for one message, or for an album sent together (`media_group_id`). Returns the card's result."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import beyin_v3_yakala as yakala
    first = messages[0]
    text = (next((m.get('text') or m.get('caption') for m in messages if m.get('text') or m.get('caption')), '') or '').strip()
    own = _own_kind(context, first) if recovered else None
    if own == 'bot':
        return None  # the bot's own answer, met again while recovering
    sender, sent_at = (None, (first.get('forward_origin') or {}).get('date') or first.get('forward_date')) if own else _origin(first)
    when = (sent_at if own else None) or first.get('date')
    extra = {'telegram_mesaj': first.get('message_id'), 'gonderildi': _iso(when) if when else None}
    notes, files, spoken, voiced = [], [], [], False
    if sender:
        extra['iletildi'] = sender
        notes.append('İletildi: ' + sender)
    own_link = _origin_link(first)
    if own_link:
        notes.append('Telegram: ' + own_link)
    stamp = datetime.fromtimestamp(when or context.now(), timezone.utc).astimezone().strftime('%Y%m%d-%H%M%S')
    workdir = Path(tempfile.mkdtemp(prefix='cortex-telegram-'))
    try:
        for message in messages:
            media = _media(message)
            if not media:
                continue
            kind, item, name = media
            voiced = voiced or kind == 'ses'
            size = int(item.get('file_size') or 0)
            if size > FILE_LIMIT:
                notes.append('Telegram\'da kaldı: %s (%.0f MB); botlar 20 MB\'tan büyük dosyayı indiremiyor.' % (name, size / 1048576))
                continue
            target = workdir / safe_name(name, stamp)
            if target.exists():
                target = target.with_name(target.stem + '-' + str(len(files) + 1) + target.suffix)
            try:
                info = context.call('getFile', file_id=item['file_id'])
                context.bot.download(info['file_path'], target)
            except TelegramError as exc:
                # Telegram will not hand this file over (gone, too big): said on the card, never retried for ever.
                target.unlink(missing_ok=True)
                notes.append('Telegram dosyayı vermedi: %s (%s)' % (name, exc.description[:120]))
                continue
            files.append(target)
            if kind == 'ses':
                words, why_not = context.transcribe(context.state, target)
                if words:
                    spoken.append(words)
                else:
                    notes.append('Yazıya çevrilemedi: ' + (why_not or 'Whisper bir şey yazmadı.'))
        place = _place_or_message(first)
        urls = links_of(first)
        url = urls[0] if urls else None
        if url and not (files or spoken or place):
            # A link, with the words around it as why it was kept.
            why_parts = ([text] if text and text != url else []) + notes
            body_text, title = None, None
        else:
            body_parts = list(spoken) + ([place] if place else [])
            why_parts = list(notes)
            if text and (files or spoken):
                why_parts.insert(0, text)
            elif text:
                body_parts.insert(0, text)
            body_text = '\n\n'.join(body_parts) or None
            title = _first_line(spoken[0] if spoken else text or place or '') or (
                'Telegram sesli not' if voiced else 'Telegram fotoğrafı' if any(m.get('photo') for m in messages)
                else files[0].name if files else 'Telegram')
        why = '\n\n'.join(why_parts)
        if not (url or body_text or files):
            if not why:
                return {'status': 'bos'}
            body_text, why = why, ''
        try:
            result = yakala.capture(context.vault, url=url, text=body_text, files=files, why=why, app='Telegram',
                                    title=title, tool='telegram', extra=extra)
        except ValueError:
            if not url:
                raise
            # A link yakala does not take (a local address): kept as the words it came in.
            result = yakala.capture(context.vault, text=text or url, files=files, why='\n\n'.join(notes), app='Telegram',
                                    tool='telegram', extra=extra)
        result['sesli'] = bool(spoken)
        result['ozet'] = _first_line(spoken[0], 120) if spoken else None
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _unsupported(message):
    for key, word in (('sticker', 'çıkartma'), ('poll', 'anket'), ('dice', 'zar'), ('game', 'oyun')):
        if message.get(key):
            return word
    return None


def _answer(result):
    if not result:
        return None
    if result.get('status') == 'mevcut_karta_eklendi':
        return '✓ Bu bağlantı zaten gelen kutusundaydı; notunu ekledim.'
    if result.get('sesli') and result.get('ozet'):
        return '✓ Gelen kutusuna eklendi: «' + result['ozet'] + '»'
    return '✓ Gelen kutusuna eklendi'


# --------------------------------------------------------------- handle --
def handle_batch(context, updates):
    """Updates in order, an album's messages taken together; the offset kept after each."""
    index = 0
    handled = {'yakalanan': 0, 'kurtarilan': 0, 'yok_sayilan': 0}
    while index < len(updates):
        update = updates[index]
        message = update.get('message')
        group = [update]
        if message and message.get('media_group_id'):
            while (index + len(group) < len(updates) and (updates[index + len(group)].get('message') or {}).get('media_group_id')
                   == message['media_group_id']):
                group.append(updates[index + len(group)])
        messages = [one['message'] for one in group if one.get('message')]
        if messages:
            outcome = handle_messages(context, messages)
            for key in handled:
                handled[key] += outcome.get(key, 0)
        context.data['offset'] = group[-1]['update_id'] + 1
        context.save()
        index += len(group)
    return handled


def _from_partner(context, message):
    chat = message.get('chat') or {}
    sender = message.get('from') or {}
    return (chat.get('type') == 'private' and chat.get('id') == context.data.get('sohbet')
            and sender.get('id') == context.data.get('kisi_id'))


def try_pair(context, message):
    """A private chat opening the pairing link (`/start KOD`) or sending the code: the one chat from now on."""
    chat = message.get('chat') or {}
    sender = message.get('from') or {}
    code = context.data.get('eslesme_kodu')
    if chat.get('type') != 'private' or not code or sender.get('is_bot'):
        return False
    said = (message.get('text') or '').strip()
    said = said[len('/start'):].strip() if said.startswith('/start') else said
    if not said:
        return False
    if not hmac.compare_digest(said.upper().encode(), code.encode()):
        context.data['yanlis_kod'] = int(context.data.get('yanlis_kod') or 0) + 1
        if context.data['yanlis_kod'] >= 20:
            context.data['eslesme_kodu'] = None  # guessed at: a new link is made with `kur`
        return False
    name = ' '.join(part for part in (sender.get('first_name'), sender.get('last_name')) if part)
    context.data.update(sohbet=chat['id'], kisi_id=sender['id'], ad=sender.get('first_name') or name or None,
                        kisi_adi_tam=name or None, eslesme_kodu=None, yanlis_kod=0, eslesti=_iso(context.now()),
                        son_bakis=_iso(context.now()), son_bakis_sn=context.now(), son_id=message.get('message_id'))
    _remember(context.data, 'islenen', message.get('message_id'))
    context.send('Eşleştik ✓ ' + HELP, reply_to=message.get('message_id'))
    return True


def handle_messages(context, messages):
    first = messages[0]
    if not context.data.get('sohbet'):
        return {'yok_sayilan': 0 if try_pair(context, first) else 1}
    if not _from_partner(context, first):
        return {'yok_sayilan': 1}  # not the person's chat: no answer, so the bot gives nothing away
    numbers = [m.get('message_id') for m in messages]
    done = set(context.data.get('islenen') or [])
    if all(number in done for number in numbers):
        return {}
    outcome = {}
    start = min(numbers)
    if start > int(context.data.get('son_id') or 0) + 1:
        outcome['kurtarilan'] = recover(context, int(context.data.get('son_id') or 0) + 1, start - 1)
    for number in numbers:
        _saw(context.data, number)
    text = (first.get('text') or '').strip()
    if text.startswith('/'):
        command = text.split()[0][1:].split('@')[0].lower()
        if command in ('start', 'yardim', 'help'):
            context.send(HELP, reply_to=first.get('message_id'))
            for number in numbers:
                _remember(context.data, 'islenen', number)
            return outcome
    word = _unsupported(first)
    if word:
        context.send('Bunu (' + word + ') kaydedemiyorum.', reply_to=first.get('message_id'))
        for number in numbers:
            _remember(context.data, 'islenen', number)
        return outcome
    try:
        result = capture_messages(context, messages)
    except ValueError as exc:
        context.send('Kaydedemedim: ' + str(exc), reply_to=first.get('message_id'))
        result = None
    for number in numbers:
        _remember(context.data, 'islenen', number)
    if result and result.get('status') != 'bos':
        context.data['yakalanan'] = int(context.data.get('yakalanan') or 0) + 1
        outcome['yakalanan'] = 1
        context.send(_answer(result), reply_to=first.get('message_id'))
    return outcome


# ------------------------------------------------------------- recovery --
def recover(context, low, high):
    """Each number from `low` to `high` fetched by forwarding it into the chat and deleting the copy.

    Returns how many messages became cards. What could not be fetched (Telegram refused the
    forward, or there were more numbers than one round looks through) is asked for once.
    """
    if high < low:
        return 0
    chat = context.data['sohbet']
    asked_again = max(0, high - low + 1 - GAP_LIMIT)
    low = max(low, high - GAP_LIMIT + 1)
    found, failed = 0, 0
    album = []

    def flush():
        nonlocal found
        if album:
            result = capture_messages(context, list(album), recovered=True)
            if result and result.get('status') not in ('bos', None):
                found += 1
                context.data['yakalanan'] = int(context.data.get('yakalanan') or 0) + 1
            album.clear()

    for number in range(low, high + 1):
        if number in set(context.data.get('islenen') or []):
            continue
        try:
            copy = context.call('forwardMessage', chat_id=chat, from_chat_id=chat, message_id=number, disable_notification=True)
        except TelegramError as exc:
            if not NOT_FOUND.search(exc.description or ''):
                failed += 1
            _remember(context.data, 'islenen', number)
            continue
        _saw(context.data, (copy or {}).get('message_id'))
        try:
            context.call('deleteMessage', chat_id=chat, message_id=copy['message_id'])
        except (TelegramError, OSError, KeyError, TypeError):
            pass
        _remember(context.data, 'islenen', number)
        if not isinstance(copy, dict):
            continue
        copy = dict(copy, message_id=number)  # the card names the message, not its deleted copy
        if album and copy.get('media_group_id') != album[0].get('media_group_id'):
            flush()
        album.append(copy)
        if not copy.get('media_group_id'):
            flush()
        context.save()
    flush()
    context.save()
    if found:
        context.send('Bilgisayar kapalıyken gönderdiğin %d mesajı aldım ✓' % found)
    missed = failed + asked_again
    if missed:
        context.send(('Bilgisayar kapalıyken gönderdiğin mesajlardan %d tanesini alamadım. '
                      'Onları sohbette seçip bana yeniden iletir misin?') % missed if failed or not found else
                     ('Kapalıyken gönderdiklerinin bir kısmını alamamış olabilirim. Eksik varsa onları seçip bana yeniden ilet.'))
    return found


def probe(context):
    """Away for most of a day: the newest number in the chat found by forwarding a known message,
    so what was sent meanwhile is fetched now, not when the next message comes."""
    data = context.data
    if not data.get('sohbet') or not data.get('son_id'):
        return 0
    last = data.get('son_bakis_sn')
    if last and context.now() - float(last) < PROBE_AFTER_SN:
        return 0
    chat, newest = data['sohbet'], None
    candidates = [data['son_id']] + sorted((one for one in data.get('islenen') or [] if one < data['son_id']), reverse=True)[:4]
    for number in candidates:
        try:
            copy = context.call('forwardMessage', chat_id=chat, from_chat_id=chat, message_id=number, disable_notification=True)
        except TelegramError:
            continue
        newest = (copy or {}).get('message_id')
        try:
            context.call('deleteMessage', chat_id=chat, message_id=newest)
        except (TelegramError, OSError):
            pass
        break
    if not newest:
        return 0
    before = int(data['son_id'])
    _saw(data, newest)
    return recover(context, before + 1, newest - 1)


# --------------------------------------------------------------- listen --
def poll_once(context, timeout=POLL_SN):
    # `timeout` is Telegram's long-poll wait; the connection waits a little longer than Telegram does.
    updates = context.call('getUpdates', _wait=timeout + 15, timeout=timeout, offset=int(context.data.get('offset') or 0),
                           allowed_updates=['message'], limit=100)
    handled = handle_batch(context, updates or [])
    context.data['son_bakis'] = _iso(context.now())
    context.data['son_bakis_sn'] = context.now()
    context.data['son_hata'] = None
    context.save()
    return handled


def listen(vault, state, token=None, bot=None, stop=None, sleep=time.sleep, transcribe=None, say=None):
    """`dinle`: until stopped, one long poll after another; a lost connection waits longer each time."""
    token = token or token_for(state)
    if not token:
        raise ValueError('Bot anahtarı yok. Önce: beyin.py telegram kur --token <anahtar>')
    handle = _lock_handle(state)
    if not _lock(handle):
        handle.close()
        return {'status': 'zaten-calisiyor'}
    say = say or (lambda text: None)
    try:
        context = Context(vault, state, bot or Bot(token), transcribe=transcribe, sleep=sleep)
        if not (context.data.get('bot') or {}).get('id'):
            raise ValueError('Telegram kurulmamış. Önce: beyin.py telegram kur')
        wait = 5
        first = True
        while not (stop and stop()):
            try:
                context.data = load(state)  # `kur` may have changed it (a new pairing link)
                if first:
                    try:
                        probe(context)
                    except TelegramError:
                        pass
                    first = False  # a connection lost on the way: looked at again on the next round
                handled = poll_once(context)
                if any(handled.values()):
                    say(json.dumps({'olay': 'alindi', **handled}, ensure_ascii=False))
                wait = 5
            except TelegramError as exc:
                if exc.code == 401:
                    _fail(state, 'Telegram anahtarı geçersiz; Ayarlar → Telegram\'dan yeniden gir.')
                    return {'status': 'anahtar_gecersiz'}
                if exc.code == 409:
                    _fail(state, 'Bu bot başka bir yerde de dinleniyor; Cortex için ayrı bir bot kullan.')
                    sleep(60)
                    continue
                _fail(state, 'Telegram: ' + exc.description[:200])
                sleep(min(max(float(exc.retry_after or 0), wait), 300))
                wait = min(wait * 2, 300)
            except (URLError, OSError, TimeoutError) as exc:
                _fail(state, 'Bağlantı yok: ' + (str(getattr(exc, 'reason', '') or exc) or type(exc).__name__)[:200])
                sleep(wait)
                wait = min(wait * 2, 300)
        return {'status': 'durdu'}
    finally:
        try:
            _unlock(handle)
        finally:
            handle.close()


def _fail(state, text):
    data = load(state)
    data['son_hata'] = text
    data['son_hata_zaman'] = _iso(_now())
    save(state, data)


# ------------------------------------------------------------------ cli --
def human(result, command):
    if command == 'kur' or command == 'durum':
        if not result.get('kurulu'):
            return 'Telegram kurulu değil. @BotFather\'dan bir bot aç, sonra: beyin.py telegram kur --token <anahtar>'
        lines = ['Bot: @' + str(result.get('bot'))]
        if result.get('eslesti'):
            lines.append('Eşleşti: ' + str(result.get('kisi') or 'evet'))
        elif result.get('baglanti'):
            lines.append('Eşleşmek için telefonda aç: ' + result['baglanti'])
            lines.append('(ya da bota şu kodu yaz: ' + str(result.get('kod')) + ')')
        else:
            lines.append('Eşleşme kodu kullanılamaz oldu; yenisi için: beyin.py telegram kur --yeniden-esle')
        lines.append('Dinleyici: ' + ('çalışıyor' if result.get('calisiyor') else 'çalışmıyor (beyin.py telegram dinle)'))
        if result.get('son_bakis'):
            lines.append('Son bakış: ' + str(result['son_bakis']))
        if result.get('son_hata'):
            lines.append('Son hata: ' + str(result['son_hata']))
        lines.append('Gelen kutusuna eklenen: ' + str(result.get('yakalanan') or 0))
        return '\n'.join(lines)
    if command == 'kaldir':
        return 'Telegram ayarı silindi: ' + str(result.get('klasor')) + ' (gelen kutusundaki kartlar duruyor)'
    if command == 'dinle':
        return {'zaten-calisiyor': 'Telegram dinleyicisi zaten çalışıyor.', 'anahtar_gecersiz': 'Telegram anahtarı geçersiz.'}.get(
            result.get('status'), 'Telegram dinleyicisi durdu.')
    return json.dumps(result, ensure_ascii=False, indent=2)


def main(argv=None, vault=None, state=None):
    parser = argparse.ArgumentParser(prog='beyin.py telegram', description='Telegram botundan gelen kutusuna yakalama.')
    sub = parser.add_subparsers(dest='command', required=True)
    setup_parser = sub.add_parser('kur', help='Bot anahtarını doğrula ve eşleşme bağlantısı ver')
    setup_parser.add_argument('--token', help='@BotFather\'ın verdiği anahtar (state/telegram/token\'a yazılır)')
    setup_parser.add_argument('--yeniden-esle', action='store_true', help='Eşleşmeyi kaldır, yeni bağlantı ver')
    sub.add_parser('durum', help='Kurulu mu, eşleşti mi, dinleyici çalışıyor mu')
    sub.add_parser('dinle', help='Gelen mesajları gelen kutusuna yaz (durdurulana kadar)')
    sub.add_parser('kaldir', help='Anahtarı ve eşleşmeyi sil; kartlara dokunmaz')
    argv = list(sys.argv[1:] if argv is None else argv)
    as_json = '--json' in argv or ('--human' not in argv and not (sys.stdout and sys.stdout.isatty()))
    args = parser.parse_args([one for one in argv if one not in ('--json', '--human')])
    if not as_json and hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')
    if state is None or vault is None:
        raise SystemExit('Kasa bilinmiyor; beyin.py telegram ile çalıştırın.')
    state, vault = Path(state), Path(vault)
    if args.command == 'kur':
        result = setup(state, token=args.token, keep_token=bool(args.token), again=args.yeniden_esle)
    elif args.command == 'durum':
        result = status(state)
    elif args.command == 'kaldir':
        result = forget(state)
    else:
        utf8 = (getattr(sys.stdout, 'encoding', '') or '').lower().replace('-', '') in ('utf8', 'utf8sig')
        say = (lambda text: print(text if utf8 else json.dumps(json.loads(text)), flush=True)) if as_json else None
        result = listen(vault, state, say=say)
    if as_json:
        utf8 = (getattr(sys.stdout, 'encoding', '') or '').lower().replace('-', '') in ('utf8', 'utf8sig')
        print(json.dumps(result, ensure_ascii=not utf8))
    else:
        print(human(result, args.command))
    return 0 if result.get('status') != 'anahtar_gecersiz' else 2


if __name__ == '__main__':
    raise SystemExit('beyin.py telegram ile çalıştırın.')
