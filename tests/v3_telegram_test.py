"""Telegram capture (beyin_v3_telegram): a bot of one's own into yakala's inbox, against a stand-in Telegram.

The stand-in keeps one numbering for every message the bot sees, as Telegram does, and drops
undelivered updates when told a day went by: what the bot then gets back by forwarding is what
a real chat would still hold. Nothing reaches the network.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import wave

from v3_package_helpers import inherited_env

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_ses as ses  # noqa: E402
import beyin_v3_telegram as telegram  # noqa: E402
import beyin_v3_yakala as yakala  # noqa: E402

TOKEN = '123456789:' + 'A' * 35
BOT = {'id': 900, 'is_bot': True, 'first_name': 'Pyn', 'username': 'pyn_cortex_bot'}
PERSON = {'id': 42, 'is_bot': False, 'first_name': 'Tolga', 'last_name': 'Gündüz', 'username': 'tolga'}
STRANGER = {'id': 77, 'is_bot': False, 'first_name': 'Yabancı'}
CONTENT = ('text', 'caption', 'entities', 'caption_entities', 'photo', 'voice', 'audio', 'document', 'video', 'video_note',
           'sticker', 'location', 'venue', 'contact', 'media_group_id')


class FakeTelegram:
    """One bot's view of Telegram: chats, one running message number, the updates not yet taken."""

    def __init__(self):
        self.clock = 1_760_000_000
        self.next_id = 1
        self.next_update = 1000
        self.chats = {}
        self.updates = []
        self.files = {}
        self.calls = []
        self.deleted = []
        self.webhook = ''
        self.token_ok = True
        self.refuse_forward = False

    # -- the people's side
    def say(self, who, deliver=True, **content):
        """`who` writes in their private chat with the bot; `deliver=False` is a message whose update expired."""
        message = {'message_id': self.next_id, 'date': self.clock, 'chat': {'id': who['id'], 'type': 'private'}, 'from': who}
        message.update(content)
        self.next_id += 1
        self.clock += 60
        self.chats.setdefault(who['id'], []).append(message)
        if deliver:
            self.updates.append({'update_id': self.next_update, 'message': message})
        self.next_update += 1
        return message

    def file(self, file_id, data, size=None):
        self.files[file_id] = data
        return {'file_id': file_id, 'file_unique_id': 'u' + file_id, 'file_size': len(data) if size is None else size}

    def sent(self, chat_id):
        return [m for m in self.chats.get(chat_id, []) if (m.get('from') or {}).get('id') == BOT['id'] and 'forward_origin' not in m]

    # -- the Bot API
    def call(self, method, _wait=None, **params):
        self.calls.append((method, params))
        if not self.token_ok:
            raise telegram.TelegramError(401, 'Unauthorized')
        if method == 'getMe':
            return dict(BOT)
        if method == 'getWebhookInfo':
            return {'url': self.webhook}
        if method == 'setMyCommands':
            return True
        if method == 'getUpdates':
            offset = params.get('offset') or 0
            self.updates = [u for u in self.updates if u['update_id'] >= offset]
            return list(self.updates[:params.get('limit', 100)])
        if method == 'sendMessage':
            message = {'message_id': self.next_id, 'date': self.clock, 'chat': {'id': params['chat_id'], 'type': 'private'},
                       'from': dict(BOT), 'text': params['text']}
            self.next_id += 1
            self.chats.setdefault(params['chat_id'], []).append(message)
            return message
        if method == 'forwardMessage':
            if self.refuse_forward:
                raise telegram.TelegramError(400, "Bad Request: message can't be forwarded")
            original = next((m for m in self.chats.get(params['from_chat_id'], []) if m['message_id'] == params['message_id']), None)
            if original is None:
                raise telegram.TelegramError(400, 'Bad Request: message to forward not found')
            copy = {key: original[key] for key in CONTENT if key in original and key != 'media_group_id'}
            copy.update(message_id=self.next_id, date=self.clock, chat={'id': params['chat_id'], 'type': 'private'}, from_=None)
            copy.pop('from_')
            copy['from'] = dict(BOT)
            copy['forward_origin'] = original.get('forward_origin') or {'type': 'user', 'sender_user': original['from'], 'date': original['date']}
            self.next_id += 1
            self.chats.setdefault(params['chat_id'], []).append(copy)
            return copy
        if method == 'deleteMessage':
            chat = self.chats.get(params['chat_id'], [])
            self.chats[params['chat_id']] = [m for m in chat if m['message_id'] != params['message_id']]
            self.deleted.append(params['message_id'])
            return True
        if method == 'getFile':
            return {'file_id': params['file_id'], 'file_path': 'files/' + params['file_id']}
        raise AssertionError('unexpected call ' + method)

    def download(self, file_path, target, limit=telegram.FILE_LIMIT):
        Path(target).write_bytes(self.files[file_path.split('/', 1)[1]])
        return target

    def methods(self, name):
        return [params for method, params in self.calls if method == name]


class TelegramTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-telegram-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Kasa'
        self.state = Path(self.tmp.name) / 'state'
        self.vault.mkdir()
        self.fake = FakeTelegram()
        self.heard = []
        env = mock.patch.dict(os.environ, {telegram.TOKEN_ENV: TOKEN})
        env.start()
        self.addCleanup(env.stop)

    def transcribe(self, state, path):
        self.heard.append(Path(path).read_bytes())
        return self.spoken, None if self.spoken else 'Whisper bir şey yazmadı.'

    spoken = 'Yarın sabah Ali\'yi ara, teklifi konuş'

    def context(self):
        return telegram.Context(self.vault, self.state, self.fake, transcribe=self.transcribe, sleep=lambda _s: None,
                                now=lambda: float(self.fake.clock))

    def poll(self):
        context = self.context()
        handled = telegram.poll_once(context)
        return handled

    def paired(self):
        telegram.setup(self.state, bot=self.fake)
        code = telegram.load(self.state)['eslesme_kodu']
        self.fake.say(PERSON, text='/start ' + code)
        self.poll()
        self.assertTrue(telegram.status(self.state)['eslesti'])
        return code

    def cards(self):
        return yakala.cards(self.vault)

    # ---------------------------------------------------------------- setup
    def test_setup_checks_the_key_and_hands_out_a_pairing_link(self):
        with self.assertRaisesRegex(ValueError, 'anahtar'):
            telegram.setup(self.state, token='merhaba', bot=self.fake)
        result = telegram.setup(self.state, bot=self.fake)
        code = telegram.load(self.state)['eslesme_kodu']
        self.assertEqual(len(code), 8)
        self.assertEqual(result['baglanti'], 'https://t.me/pyn_cortex_bot?start=' + code)
        self.assertEqual((result['bot'], result['eslesti'], result['kurulu']), ('pyn_cortex_bot', False, True))
        self.assertNotIn(TOKEN, (self.state / 'telegram' / 'durum.json').read_text(encoding='utf-8'))
        self.assertFalse((self.state / 'telegram' / 'token').exists(), 'a key from the environment is not written down')

    def test_a_key_given_on_the_command_line_is_kept_for_this_user_only(self):
        with mock.patch.dict(os.environ, {telegram.TOKEN_ENV: ''}):
            telegram.setup(self.state, token=TOKEN, keep_token=True, bot=self.fake)
            self.assertEqual(telegram.token_for(self.state), TOKEN)
        if os.name != 'nt':
            self.assertEqual((self.state / 'telegram' / 'token').stat().st_mode & 0o777, 0o600)

    def test_a_key_telegram_does_not_know_or_a_bot_tied_elsewhere_is_refused(self):
        self.fake.token_ok = False
        with self.assertRaisesRegex(ValueError, 'tanımadı'):
            telegram.setup(self.state, bot=self.fake)
        self.fake.token_ok, self.fake.webhook = True, 'https://example.com/hook'
        with self.assertRaisesRegex(ValueError, 'webhook'):
            telegram.setup(self.state, bot=self.fake)

    def test_setting_up_again_keeps_the_pairing_unless_asked(self):
        self.paired()
        telegram.setup(self.state, bot=self.fake)
        self.assertTrue(telegram.status(self.state)['eslesti'])
        again = telegram.setup(self.state, again=True, bot=self.fake)
        self.assertFalse(again['eslesti'])
        self.assertTrue(again['baglanti'])

    # -------------------------------------------------------------- pairing
    def test_only_the_chat_that_opens_the_link_is_listened_to(self):
        telegram.setup(self.state, bot=self.fake)
        code = telegram.load(self.state)['eslesme_kodu']
        self.fake.say(STRANGER, text='/start YANLISKD')
        self.fake.say(STRANGER, text='merhaba')
        self.poll()
        self.assertFalse(telegram.status(self.state)['eslesti'])
        self.assertEqual(self.fake.methods('sendMessage'), [], 'a stranger gets no answer at all')
        self.fake.say(PERSON, text='/start ' + code)
        self.poll()
        status = telegram.status(self.state)
        self.assertEqual((status['eslesti'], status['kisi'], status['baglanti']), (True, 'Tolga', None))
        self.assertIn('Eşleştik', self.fake.sent(PERSON['id'])[-1]['text'])
        self.fake.say(STRANGER, text='/start ' + code)
        self.fake.say(STRANGER, text='bunu da kaydet')
        self.poll()
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.fake.sent(STRANGER['id']), [])

    def test_a_code_guessed_at_is_given_up(self):
        telegram.setup(self.state, bot=self.fake)
        for number in range(20):
            self.fake.say(STRANGER, text='KOD%05d' % number)
        self.poll()
        self.assertIsNone(telegram.status(self.state)['baglanti'])
        self.assertFalse(telegram.status(self.state)['eslesti'])

    # -------------------------------------------------------------- capture
    def test_a_text_becomes_a_card_and_the_bot_says_so_quietly(self):
        self.paired()
        sent = self.fake.say(PERSON, text='Süt al\nekmek de')
        self.poll()
        [card] = self.cards()
        self.assertEqual((card['meta']['arac'], card['meta']['uygulama'], card['meta']['kaynak_turu']), ('telegram', 'Telegram', 'metin'))
        self.assertEqual(card['meta']['baslik'], 'Süt al')
        self.assertEqual(card['meta']['telegram_mesaj'], str(sent['message_id']))
        self.assertIn('ekmek de', card['body'])
        answer = self.fake.methods('sendMessage')[-1]
        self.assertEqual(answer['text'], '✓ Gelen kutusuna eklendi')
        self.assertTrue(answer['disable_notification'])
        self.assertEqual(answer['reply_parameters']['message_id'], sent['message_id'])
        self.assertEqual(telegram.status(self.state)['yakalanan'], 1)

    def test_a_link_is_a_source_and_the_words_around_it_why(self):
        self.paired()
        self.fake.say(PERSON, text='https://example.com/makale')
        self.fake.say(PERSON, text='Şuna bak sonra: https://example.org/yazi.')
        self.poll()
        cards = sorted(self.cards(), key=lambda card: card['meta']['url'])
        self.assertEqual([c['meta']['url'] for c in cards], ['https://example.com/makale', 'https://example.org/yazi'])
        self.assertEqual(cards[0]['meta']['kaynak_turu'], 'makale')
        self.assertIn('Şuna bak sonra', cards[1]['body'].split('## Kaynak')[0])

    def test_a_photo_with_its_caption(self):
        self.paired()
        self.fake.say(PERSON, caption='Toplantı tahtası', photo=[self.fake.file('k', b'small'), self.fake.file('b', b'bigger photo')])
        self.poll()
        [card] = self.cards()
        self.assertEqual(card['meta']['baslik'], 'Toplantı tahtası')
        [saved] = list((self.vault / yakala.INBOX / yakala.FILES).glob('telegram-*'))
        self.assertEqual(saved.read_bytes(), b'bigger photo')
        self.assertTrue(saved.name.endswith('foto.jpg'))
        self.assertIn('[[' + saved.relative_to(self.vault).as_posix() + ']]', card['body'])

    def test_a_voice_note_is_written_out_by_the_local_whisper(self):
        self.paired()
        self.fake.say(PERSON, voice=dict(self.fake.file('v', b'OggS voice'), duration=4, mime_type='audio/ogg'))
        self.poll()
        [card] = self.cards()
        self.assertEqual(self.heard, [b'OggS voice'])
        self.assertEqual(card['meta']['baslik'], self.spoken)
        self.assertIn(self.spoken, card['body'])
        self.assertTrue(list((self.vault / yakala.INBOX / yakala.FILES).glob('telegram-*-sesli-not.ogg')))
        self.assertEqual(self.fake.methods('sendMessage')[-1]['text'], '✓ Gelen kutusuna eklendi: «' + self.spoken + '»')

    def test_a_voice_note_whisper_could_not_write_is_still_kept(self):
        self.paired()
        self.spoken = ''
        self.fake.say(PERSON, voice=dict(self.fake.file('v', b'OggS'), duration=2))
        self.poll()
        [card] = self.cards()
        self.assertEqual(card['meta']['baslik'], 'Telegram sesli not')
        self.assertIn('Yazıya çevrilemedi', card['body'])

    def test_an_album_is_one_card(self):
        self.paired()
        self.fake.say(PERSON, media_group_id='g1', caption='Fiş ve fatura', photo=[self.fake.file('a', b'one')])
        self.fake.say(PERSON, media_group_id='g1', photo=[self.fake.file('b', b'two')])
        self.poll()
        [card] = self.cards()
        self.assertEqual(card['body'].count('[[' + yakala.INBOX), 2)
        self.assertEqual(len(self.fake.methods('sendMessage')), 2, 'the pairing answer and one for the album')

    def test_a_forwarded_message_says_where_it_came_from(self):
        self.paired()
        self.fake.say(PERSON, text='Kanal duyurusu: yeni sürüm çıktı', forward_origin={
            'type': 'channel', 'chat': {'id': -100, 'title': 'Haberler', 'username': 'haberler'}, 'message_id': 55, 'date': 1_700_000_000})
        self.poll()
        [card] = self.cards()
        self.assertEqual(card['meta']['iletildi'], 'Haberler (@haberler)')
        self.assertIn('https://t.me/haberler/55', card['body'])
        self.assertIn('yeni sürüm çıktı', card['body'])

    def test_a_file_too_big_for_a_bot_is_named_not_fetched(self):
        self.paired()
        self.fake.say(PERSON, document=dict(self.fake.file('d', b'x', size=30 * 1024 * 1024), file_name='sunum.pdf'))
        self.poll()
        [card] = self.cards()
        self.assertIn("Telegram'da kaldı: sunum.pdf (30 MB)", card['body'])
        self.assertEqual(self.fake.methods('getFile'), [])

    def test_a_file_telegram_will_not_hand_over_is_named_and_the_message_not_tried_for_ever(self):
        self.paired()
        real = self.fake.call

        def gone(method, **params):
            if method == 'getFile':
                raise telegram.TelegramError(400, 'Bad Request: file is temporarily unavailable')
            return real(method, **params)
        self.fake.call = gone
        self.fake.say(PERSON, caption='Fatura', document=dict(self.fake.file('d', b'pdf'), file_name='fatura.pdf'))
        self.poll()
        [card] = self.cards()
        self.assertIn('Telegram dosyayı vermedi: fatura.pdf', card['body'])
        self.assertEqual(telegram.load(self.state)['offset'], self.fake.updates[-1]['update_id'] + 1,
                         'taken: the next round does not meet it again')

    def test_a_place_and_a_contact_are_written_as_text(self):
        self.paired()
        self.fake.say(PERSON, location={'latitude': 41.0082, 'longitude': 28.9784})
        self.poll()
        [card] = self.cards()
        self.assertIn('41.008200, 28.978400', card['body'])
        self.assertIsNone(card['meta'].get('url'), 'a map is not a page to fetch')

    def test_a_sticker_is_answered_not_kept(self):
        self.paired()
        self.fake.say(PERSON, sticker={'file_id': 's'})
        self.poll()
        self.assertEqual(self.cards(), [])
        self.assertIn('çıkartma', self.fake.methods('sendMessage')[-1]['text'])

    def test_an_update_met_twice_is_kept_once(self):
        self.paired()
        sent = self.fake.say(PERSON, text='bir kez')
        self.poll()
        self.fake.updates.append({'update_id': 1, 'message': sent})
        context = self.context()
        telegram.handle_batch(context, [{'update_id': 5000, 'message': sent}])
        self.assertEqual(len(self.cards()), 1)

    def test_a_link_yakala_does_not_fetch_is_kept_as_words(self):
        self.paired()
        self.fake.say(PERSON, text='http://192.168.1.10/panel')
        self.poll()
        [card] = self.cards()
        self.assertIsNone(card['meta'].get('url'))
        self.assertIn('192.168.1.10', card['body'])

    # ------------------------------------------------------------- recovery
    def test_messages_whose_updates_expired_are_fetched_by_forwarding(self):
        self.paired()
        missed = [self.fake.say(PERSON, deliver=False, text='kaçan bir'),
                  self.fake.say(PERSON, deliver=False, voice=dict(self.fake.file('v', b'voice'), duration=3))]
        self.fake.clock += 3 * 86400
        self.fake.say(PERSON, text='yeni mesaj')
        self.poll()
        cards = self.cards()
        self.assertEqual(len(cards), 3)
        self.assertEqual({card['meta']['telegram_mesaj'] for card in cards}, {str(m['message_id']) for m in missed} | {str(missed[1]['message_id'] + 1)},
                         'the cards carry the numbers the messages were sent under, not their copies\'')
        first = next(card for card in cards if 'kaçan bir' in card['body'])
        self.assertEqual(first['meta']['gonderildi'], telegram._iso(missed[0]['date']), 'the day it was sent, not the day it was fetched')
        self.assertNotIn('iletildi', first['meta'], "the person's own message, not one forwarded from somebody")
        self.assertTrue(all(params['disable_notification'] for params in self.fake.methods('forwardMessage')))
        self.assertEqual(len(self.fake.deleted), 2, 'each copy deleted at once')
        self.assertFalse([m for m in self.fake.chats[PERSON['id']] if 'forward_origin' in m], 'no copy left in the chat')
        self.assertIn('2 mesajı aldım', ' '.join(m['text'] for m in self.fake.sent(PERSON['id'])))

    def test_the_bots_own_answers_and_deleted_messages_are_passed_over(self):
        self.paired()
        gone = self.fake.say(PERSON, deliver=False, text='silinen')
        self.fake.chats[PERSON['id']].remove(gone)
        self.fake.call('sendMessage', chat_id=PERSON['id'], text='kayıp bir cevap')  # an answer whose number was not kept
        self.fake.say(PERSON, text='sonraki')
        self.poll()
        self.assertEqual([card['meta']['baslik'] for card in self.cards()], ['sonraki'])
        texts = [m['text'] for m in self.fake.sent(PERSON['id'])]
        self.assertFalse(any('aldım' in text or 'alamadım' in text for text in texts), texts)

    def test_what_cannot_be_forwarded_is_asked_for_again(self):
        self.paired()
        self.fake.say(PERSON, deliver=False, text='kaçan')
        self.fake.refuse_forward = True
        self.fake.say(PERSON, text='yeni')
        self.poll()
        self.assertEqual(len(self.cards()), 1)
        self.assertIn('yeniden iletir misin', self.fake.sent(PERSON['id'])[-2]['text'])

    def test_a_long_absence_is_looked_through_at_start(self):
        self.paired()
        self.fake.say(PERSON, deliver=False, text='hafta sonu notu')
        self.fake.clock += 5 * 86400
        context = self.context()
        self.assertEqual(telegram.probe(context), 1)
        [card] = self.cards()
        self.assertIn('hafta sonu notu', card['body'])
        self.assertFalse([m for m in self.fake.chats[PERSON['id']] if 'forward_origin' in m])
        # Back within a day: nothing is forwarded at start.
        self.fake.calls.clear()
        self.poll()
        self.assertEqual(telegram.probe(self.context()), 0)
        self.assertEqual(self.fake.methods('forwardMessage'), [])

    # --------------------------------------------------------------- listen
    def test_listen_runs_once_per_machine_and_stops_on_a_bad_key(self):
        self.paired()
        rounds = []

        def stop():
            rounds.append(1)
            return len(rounds) > 2
        result = telegram.listen(self.vault, self.state, bot=self.fake, stop=stop, sleep=lambda _s: None, transcribe=self.transcribe)
        self.assertEqual(result['status'], 'durdu')
        self.assertFalse(telegram.status(self.state)['calisiyor'])
        self.fake.token_ok = False
        result = telegram.listen(self.vault, self.state, bot=self.fake, stop=lambda: False, sleep=lambda _s: None)
        self.assertEqual(result['status'], 'anahtar_gecersiz')
        self.assertIn('geçersiz', telegram.status(self.state)['son_hata'])

    def test_a_second_listener_is_not_started(self):
        self.paired()
        started, release = threading.Event(), threading.Event()

        def stop():
            started.set()
            return release.wait(5)
        first = threading.Thread(target=telegram.listen, args=(self.vault, self.state),
                                 kwargs=dict(bot=self.fake, stop=stop, sleep=lambda _s: None))
        first.start()
        try:
            self.assertTrue(started.wait(5))
            if os.name != 'nt':
                # flock: another open file of the same process is another lock, as another process' would be.
                self.assertEqual(telegram.listen(self.vault, self.state, bot=self.fake, stop=lambda: True)['status'], 'zaten-calisiyor')
                self.assertTrue(telegram.status(self.state)['calisiyor'])
        finally:
            release.set()
            first.join(5)

    def test_a_lost_connection_waits_longer_each_time(self):
        self.paired()
        waits = []
        calls = {'n': 0}
        real = self.fake.call

        def flaky(method, **params):
            if method == 'getUpdates':
                calls['n'] += 1
                if calls['n'] <= 3:
                    raise OSError('ağ yok')
            return real(method, **params)
        self.fake.call = flaky
        result = telegram.listen(self.vault, self.state, bot=self.fake, stop=lambda: calls['n'] > 3, sleep=waits.append)
        self.assertEqual(result['status'], 'durdu')
        self.assertEqual(waits, [5, 10, 20])
        self.assertIsNone(telegram.status(self.state)['son_hata'], 'a poll that worked clears the last error')

    def test_the_look_at_start_is_tried_again_when_the_connection_was_lost(self):
        self.paired()
        self.fake.say(PERSON, deliver=False, text='uzun aradan önce')
        self.fake.clock += 3 * 86400
        real, tries = self.fake.call, {'n': 0}

        def offline_once(method, **params):
            if method == 'forwardMessage' and tries['n'] == 0:
                tries['n'] += 1
                raise OSError('ağ yok')
            return real(method, **params)
        self.fake.call = offline_once
        rounds = []
        telegram.listen(self.vault, self.state, bot=self.fake, stop=lambda: rounds.append(1) or len(rounds) > 2,
                        sleep=lambda _s: None, transcribe=self.transcribe)
        self.assertEqual([card['meta']['baslik'] for card in self.cards()], ['uzun aradan önce'])

    def test_forget_removes_the_key_and_the_pairing_not_the_cards(self):
        self.paired()
        self.fake.say(PERSON, text='kalsın')
        self.poll()
        result = telegram.forget(self.state)
        self.assertEqual(result['status'], 'kaldirildi')
        self.assertFalse((self.state / 'telegram').exists())
        self.assertEqual(len(self.cards()), 1)

    def test_human_lines(self):
        result = telegram.setup(self.state, bot=self.fake)
        text = telegram.human(result, 'kur')
        self.assertIn('https://t.me/pyn_cortex_bot?start=', text)
        self.assertIn('Dinleyici: çalışmıyor', text)

    def test_safe_names(self):
        self.assertEqual(telegram.safe_name('../../ev:rak?.pdf', '20261020-101010'), 'telegram-20261020-101010-ev rak.pdf')
        self.assertEqual(telegram.safe_name('', 'x'), 'telegram-x-dosya')


class TranscribeFileTest(unittest.TestCase):
    """ses.transcribe_file: the voice helper run for one recorded file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-dosya-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)

    def install(self):
        python = ses.venv_python(self.state)
        python.parent.mkdir(parents=True)
        python.write_text('')
        (ses.ses_dir(self.state) / ses.VOSK_DIR).mkdir(parents=True)
        (ses.ses_dir(self.state) / ses.MARKER).write_text('{"motor": "islemci"}', encoding='utf-8')

    def test_without_voice_typing_it_says_so(self):
        self.assertEqual(ses.transcribe_file(self.state, 'x.ogg'), (None, 'Sesle yazma kurulu değil (Ayarlar → Sesle yazma).'))

    def test_the_helpers_line_is_read_and_tidied(self):
        self.install()
        if not ses.installed(self.state):
            self.skipTest('installed() wants more than this stand-in')
        asked = []

        def run(command, **options):
            asked.append(command)
            return subprocess.CompletedProcess(command, 0, 'loading\n{"metin": "Süt al. Altyazı M.K.", "model": "small"}\n', '')
        self.assertEqual(ses.transcribe_file(self.state, 'not.ogg', run=run), ('Süt al', None))
        self.assertEqual(asked[0][-2:], ['--dosya', 'not.ogg'])

        def broken(command, **options):
            return subprocess.CompletedProcess(command, 0, json.dumps({'hata': 'Ses dosyasını açacak çözücü yok'}) + '\n', '')
        self.assertEqual(ses.transcribe_file(self.state, 'not.ogg', run=broken), (None, 'Ses dosyasını açacak çözücü yok'))

        def crashed(command, **options):
            return subprocess.CompletedProcess(command, 1, '', 'Traceback\nRuntimeError: model yok\n')
        self.assertEqual(ses.transcribe_file(self.state, 'not.ogg', run=crashed), (None, 'RuntimeError: model yok'))

    def test_status_says_whether_a_recorded_file_can_be_read(self):
        self.install()
        with mock.patch('shutil.which', return_value=None):
            self.assertIs(ses.status(self.state)['dosya_okur'], False)
            site = ses.ses_dir(self.state) / 'venv' / ('Lib/site-packages' if os.name == 'nt' else 'lib/python3.12/site-packages')
            (site / 'av').mkdir(parents=True)
            (site / 'av' / '__init__.py').write_text('')
            self.assertIs(ses.status(self.state)['dosya_okur'], ses.installed(self.state))

    def test_whisper_cpps_environment_can_read_a_voice_note(self):
        self.assertIn('av', ses.packages_for('vulkan'))
        self.assertIn('--dosya', ses.WORKER_SOURCE)



class WorkerFileTest(unittest.TestCase):
    """The helper's `--dosya`: a recorded file read and written out (numpy, which the engine's own Python may lack)."""

    def setUp(self):
        try:
            import numpy
        except ImportError:
            self.skipTest('numpy yok')
        self.np = numpy
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-dosya-isci-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'
        spec = importlib.util.spec_from_file_location('isci_dosya_testi', ses.write_worker(self.state))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.ses = ses
        self.said = []
        self.helper.out = lambda **event: self.said.append(event)
        self.wav = Path(self.tmp.name) / 'ses.wav'
        with wave.open(str(self.wav), 'wb') as sink:
            sink.setnchannels(1)
            sink.setsampwidth(2)
            sink.setframerate(16000)
            sink.writeframes((numpy.sin(numpy.arange(16000) / 8) * 8000).astype('<i2').tobytes())

    def test_a_file_is_read_with_ffmpeg_when_pyav_is_not_there(self):
        import shutil
        if not shutil.which('ffmpeg'):
            self.skipTest('ffmpeg yok')
        with mock.patch.object(self.helper, '_decode_pyav', side_effect=ImportError):
            audio = self.helper.decode_file(self.wav)
        self.assertEqual(len(audio), 16000)
        self.assertLess(abs(float(audio.max()) - 8000 / 32768), 0.01)

    def test_it_is_written_out_with_the_dictations_model(self):
        loaded = []
        with mock.patch.object(self.helper, 'decode_file', return_value=self.np.ones(32000, dtype='float32')), \
                mock.patch.object(self.helper, 'load_model', return_value=('model', 'small (işlemci)')), \
                mock.patch.object(self.helper, 'release', side_effect=loaded.append), \
                mock.patch.object(self.helper, 'transcribe', return_value='Süt al'):
            self.assertEqual(self.helper.transcribe_path(self.state, {}, self.wav), 0)
        self.assertEqual(self.said, [{'metin': 'Süt al', 'model': 'small (işlemci)', 'sure_sn': 2.0}])
        self.assertEqual(loaded, ['model'], 'the model is let go after the one file')

    def test_without_a_decoder_it_says_how_to_get_one(self):
        with mock.patch.object(self.helper, '_decode_pyav', side_effect=ImportError), mock.patch('shutil.which', return_value=None):
            self.helper.transcribe_path(self.state, {}, self.wav)
        self.assertIn('ses kur', self.said[0]['hata'])



class TelegramInstalledTest(unittest.TestCase):
    """`beyin.py telegram` in an installed vault: the module goes in with the engine, the entry routes to it."""

    def test_status_through_the_entry(self):
        with tempfile.TemporaryDirectory(prefix='v3-telegram-kurulu-') as tmp:
            root = Path(tmp)
            vault, state = root / 'Kasa', root / 'state'
            vault.mkdir()
            env = inherited_env(BEYIN_V3_NO_SPAWN='1', PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8',
                                HOME=str(root / 'home'), APPDATA=str(root / 'appdata'))
            env.pop(telegram.TOKEN_ENV, None)
            done = subprocess.run([sys.executable, str(ROOT / 'scripts/install_v3.py'), '--vault', str(vault), '--state', str(state)],
                                  capture_output=True, text=True, encoding='utf-8', env=env, timeout=120)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue((vault / '.claude/scripts/beyin_v3_telegram.py').is_file())
            done = subprocess.run([sys.executable, str(vault / 'beyin.py'), 'telegram', 'durum', '--json'], capture_output=True,
                                  text=True, encoding='utf-8', env=env, cwd=vault, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            result = json.loads(done.stdout)
            self.assertEqual((result['kurulu'], result['anahtar'], result['calisiyor']), (False, False, False))
            done = subprocess.run([sys.executable, str(vault / 'beyin.py'), 'telegram', 'kur', '--token', 'merhaba'],
                                  capture_output=True, text=True, encoding='utf-8', env=env, cwd=vault, timeout=60)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('anahtar', done.stderr)
            # The listener's lock with only what the vault was given: no helper of the source tree (#151).
            listen = '\n'.join([
                'import sys',
                'sys.path[:0] = [sys.argv[1]]',
                'import beyin_v3_telegram as t',
                't.save(sys.argv[2], {"bot": {"id": 1}})',
                'class Gone:',
                '    def call(self, method, **params):',
                '        raise t.TelegramError(401, "Unauthorized")',
                'print(t.listen(sys.argv[3], sys.argv[2], token="1:x", bot=Gone(), sleep=lambda s: None)["status"], t.running(sys.argv[2]))',
            ])
            done = subprocess.run([sys.executable, '-I', '-c', listen, str(vault / '.claude/scripts'), str(state), str(vault)],
                                  capture_output=True, text=True, encoding='utf-8', env=env, cwd=root, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.split(), ['anahtar_gecersiz', 'False'])


if __name__ == '__main__':
    unittest.main()
