"""Optional voice typing for yakala (beyin_v3_ses): words, install plan, helper protocol.

Offline and silent: nothing is installed, downloaded or recorded. The helper process is stood
in for by a small script that speaks the same protocol, and the installer's commands are
recorded instead of run.
"""
import gc
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_ses as ses  # noqa: E402
import beyin_v3_yakala as yakala  # noqa: E402


class WordsTest(unittest.TestCase):
    def test_the_wake_phrase_is_heard_however_the_name_is_spelled(self):
        for said in ('Pyn, not al', 'pyn not al.', 'pin not al', 'Pın not al', 'hey pen not al lütfen', 'PİN NOT AL'):
            self.assertTrue(ses.wake_heard(said), said)
        for said in ('not al', 'pyn not', 'bunu not alma', 'pyn notları aç', 'pin kodunu al'):
            self.assertFalse(ses.wake_heard(said), said)

    def test_the_wake_listener_hears_a_grammar_of_the_phrase_and_its_sound_alikes(self):
        grammar = json.loads(ses.wake_grammar())
        self.assertEqual(grammar[0], 'pyn not al')
        self.assertIn('pay not al', grammar, '"payn not al" as the small model hears it')
        self.assertIn('not al', grammar, 'the rest of the phrase alone: a real voice saying "payn" is mostly [unk] to it')
        self.assertEqual(grammar[-1], '[unk]', 'anything else is nothing')
        for heard in ('pay not al', 'bin not al', 'bayan not al'):
            self.assertTrue(ses.wake_heard(heard), heard)
        self.assertEqual(json.loads(ses.wake_grammar('hey pyn not al'))[1], 'hey pay not al', 'the name where it is in the phrase')

    def test_what_the_small_model_hears_is_the_phrase_a_candidate_for_whisper_or_nothing(self):
        for heard in ('pay not al', 'bin not al', 'pyn not al'):
            self.assertEqual(ses.wake_verdict(heard), 'soz', heard)
        for heard in ('[unk] not al', 'not al', '[unk] [unk] not al', 'pay [unk] not al'):
            self.assertEqual(ses.wake_verdict(heard), 'aday', heard)
        for heard in ('[unk]', '[unk] not', 'not [unk] al', 'pay', ''):
            self.assertIsNone(ses.wake_verdict(heard), heard)

    def test_whisper_hears_pyns_name_however_it_writes_it_and_no_other_word(self):
        for written in ('Pyn, not al.', 'Payn not al', 'Pain, not al.', 'Bayın not al.', 'Payın not al', 'Pin not al.',
                        'Pyn not al. Yarın toplantı var'):
            self.assertTrue(ses.wake_heard(written), written)
        for written in ('Bunu not al.', 'Bana not al.', 'Şunu not al', 'Onu not al', 'Not al.', 'Notları al.', ''):
            self.assertFalse(ses.wake_heard(written), written)

    def test_a_dictation_the_wake_phrase_began_starts_after_the_phrase(self):
        self.assertEqual(ses.without_wake('Al. Yarın toplantı var'), 'Yarın toplantı var', 'the end of "al" the recording caught')
        self.assertEqual(ses.without_wake('not al, yarın onda'), 'yarın onda')
        self.assertEqual(ses.without_wake('Payn, not al. Süt al'), 'Süt al', 'the name however written; the last "al" is a word')
        self.assertEqual(ses.without_wake('Pyn, not al'), '')
        for kept in ('Alışveriş listesi', 'Yarın onda', 'Notlar hazır'):
            self.assertEqual(ses.without_wake(kept), kept)

    def test_hey_pyn_is_heard_with_the_name_last(self):
        phrase = 'hey pyn'
        self.assertEqual(json.loads(ses.wake_grammar(phrase)), ['hey pyn', 'hey pay', 'hey bin', 'hey bayan', 'hey', '[unk]'])
        for written in ('Hey Pyne.', 'Hey Payne, yarın toplantı var', 'hey pin', 'Hey Pain!'):
            self.assertTrue(ses.wake_heard(written, phrase), written)
        for written in ('Hey, nasılsın?', 'Hey millet', 'Pyn hey', 'Çok heyecanlıyım'):
            self.assertFalse(ses.wake_heard(written, phrase), written)
        self.assertEqual(ses.wake_verdict('hey pay', phrase), 'soz')
        self.assertEqual(ses.wake_verdict('hey', phrase), 'aday', 'a "hey" alone: Whisper checks the name')
        self.assertIsNone(ses.wake_verdict('[unk]', phrase))
        self.assertEqual(ses.without_wake('Pyne, yarın toplantı var', phrase), 'yarın toplantı var', 'the name the recording caught')
        self.assertEqual(ses.without_wake('Hey Pyn, süt al', phrase), 'süt al')
        self.assertEqual(ses.without_wake('Yarın toplantı var', phrase), 'Yarın toplantı var')
        self.assertEqual(ses.wake_verdict('not al'), 'aday', '"Pyn, not al" as it was')

    def test_both_wake_phrases_at_once(self):
        both = 'ikisi'
        grammar = json.loads(ses.wake_grammar(both))
        for line in ('hey pyn', 'hey pay', 'hey', 'pyn not al', 'pay not al', 'not al'):
            self.assertIn(line, grammar)
        self.assertEqual(grammar[-1], '[unk]')
        self.assertEqual(len(grammar), len(set(grammar)), 'each once')
        for written in ('Hey Pyne.', 'Payn, not al.', 'Pin not al'):
            self.assertTrue(ses.wake_heard(written, both), written)
        for written in ('Hey, nasılsın?', 'Bunu not al.'):
            self.assertFalse(ses.wake_heard(written, both), written)
        self.assertEqual([ses.wake_verdict(heard, both) for heard in ('hey pay', 'not al', 'hey', '[unk]')], ['soz', 'aday', 'aday', None])
        self.assertEqual(ses.without_wake('Pyne, yarın toplantı var', both), 'yarın toplantı var')
        self.assertEqual(ses.without_wake('Al. Süt al', both), 'Süt al')
        self.assertEqual(ses.phrase_label(both), 'Hey Pyn ya da Pyn, not al')

    def test_the_picture_on_the_clipboard_is_added_by_voice(self):
        self.assertEqual(ses.command_of('Panodaki resmi ekle.'), ('resim_ekle', ''))
        self.assertEqual(ses.command_of('Pyn, resmi ekle'), ('resim_ekle', ''))
        self.assertEqual(ses.command_of('Bu hata tekrar çıktı, panodaki resmi ekle'), ('resim_ekle', 'Bu hata tekrar çıktı'), 'the longest phrase first')
        self.assertEqual(ses.command_of('Ekran görüntüsünü ekle'), ('resim_ekle', ''))
        self.assertEqual(ses.command_of('Resimler güzel olmuş'), (None, 'Resimler güzel olmuş'))

    def test_a_wake_phrase_is_named_as_it_is_said(self):
        self.assertEqual(ses.phrase_label('pyn not al'), 'Pyn, not al')
        self.assertEqual(ses.phrase_label('hey pyn'), 'Hey Pyn')
        self.assertEqual(ses.phrase_label(None), 'Pyn, not al')

    def test_the_wake_phrase_is_a_setting_of_its_two(self):
        tmp = tempfile.TemporaryDirectory(prefix='v3-ses-soz-')
        self.addCleanup(tmp.cleanup)
        state = Path(tmp.name) / 'state'
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out), mock.patch.object(ses, 'restart_listener', return_value=False):
            ses.main(['ayar', '--uyandirma-sozu', 'hey pyn', '--json'], state=state)
        self.assertEqual(json.loads(out.getvalue())['uyandirma_sozu'], 'hey pyn')
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', io.StringIO()):
            ses.main(['ayar', '--uyandirma-sozu', 'merhaba', '--json'], state=state)

    def test_whisper_writing_the_phrase_joined_is_still_the_phrase(self):
        # Seen in the window: "Py notal. Şu an ne yapıyoruz?", the phrase left at the note's start.
        self.assertEqual(ses.without_wake('Py notal. Şu an ne yapıyoruz?'), 'Şu an ne yapıyoruz?')
        self.assertEqual(ses.without_wake('Notal, yarın onda'), 'yarın onda')
        self.assertTrue(ses.wake_heard('Py notal.'))
        self.assertTrue(ses.wake_heard('Payn notal'))
        self.assertFalse(ses.wake_heard('Bunu notal.'))
        self.assertEqual(ses.without_wake('Notalar hazır'), 'Notalar hazır', 'a word that only starts like it is a word')

    def test_kaydet_counts_at_the_end_sil_and_iptal_only_alone(self):
        self.assertEqual(ses.command_of('Toplantı notu, kaydet.'), ('kaydet', 'Toplantı notu'))
        self.assertEqual(ses.command_of('Kaydet'), ('kaydet', ''))
        self.assertEqual(ses.command_of('sil'), ('sil', ''))
        self.assertEqual(ses.command_of('Vazgeç.'), ('iptal', ''))
        self.assertEqual(ses.command_of('notu kaydettim'), (None, 'notu kaydettim'), 'a word that starts like a command is a word')
        self.assertEqual(ses.command_of('bu satırı sil'), (None, 'bu satırı sil'), 'sil inside a sentence is written')
        self.assertEqual(ses.command_of('   '), (None, ''))
        self.assertEqual(ses.command_of('Haftalık plan kaydı kaydet'), ('kaydet', 'Haftalık plan kaydı'))

    def test_pyn_kaydet_saves_and_the_name_is_not_written(self):
        self.assertEqual(ses.command_of('Toplantı yarın onda, Pyn kaydet.'), ('kaydet', 'Toplantı yarın onda'))
        self.assertEqual(ses.command_of('Pyn kaydet'), ('kaydet', ''))
        self.assertEqual(ses.command_of('pın, kaydet'), ('kaydet', ''))
        self.assertEqual(ses.command_of('Pyn sil'), ('sil', ''))
        self.assertEqual(ses.command_of('Pinpon oynadık, kaydet'), ('kaydet', 'Pinpon oynadık'), 'only the name itself is taken off')
        self.assertEqual(ses.command_of('Market listesi, Payn kaydet.'), ('kaydet', 'Market listesi'), 'the name as Whisper writes it')

    def test_the_window_takes_back_the_last_word_or_sentence(self):
        self.assertEqual(yakala.without_last_word("Toplantı yarın Ali'ye."), 'Toplantı yarın')
        self.assertEqual(yakala.without_last_word('tek'), '')
        self.assertEqual(yakala.without_last_sentence('Py notal. Şu an ne yapıyoruz? Bunların hepsini kay'), 'Py notal. Şu an ne yapıyoruz?')
        self.assertEqual(yakala.without_last_sentence('Bir. İki.'), 'Bir.')
        self.assertEqual(yakala.without_last_sentence('Kira 12.500 lira'), '', 'a full stop inside a number ends no sentence')
        self.assertEqual(yakala.without_last_sentence(''), '')

    def test_the_field_counts_the_lines_a_note_takes_wrapped(self):
        measure = lambda text: len(text) * 10
        self.assertEqual(yakala.wrapped_lines('', measure, 100), 1)
        self.assertEqual(yakala.wrapped_lines('kısa not', measure, 100), 1)
        self.assertEqual(yakala.wrapped_lines('bir iki üç dört beş altı', measure, 100), 3)
        self.assertEqual(yakala.wrapped_lines('a\nb', measure, 100), 2)
        self.assertEqual(yakala.wrapped_lines('x' * 35, measure, 100), 4, 'a word longer than the line breaks inside it')

    def test_the_panel_says_the_commands_by_the_words_set_for_them(self):
        line = yakala.spoken_commands_line(ses.DEFAULTS['komutlar'])
        self.assertEqual(line, 'Komutlar: “kaydet” · “resmi ekle” · “son kelimeyi sil” · “son cümleyi sil” · “hepsini sil” · “iptal”')
        self.assertEqual(yakala.spoken_commands_line({'kaydet': ['tamam'], 'sil': []}), 'Komutlar: “tamam”')
        self.assertEqual(yakala.spoken_commands_line({}), '')

    def test_the_last_word_or_sentence_is_taken_back_alone_or_at_the_end_everything_only_alone(self):
        self.assertEqual(ses.command_of('Son kelimeyi sil.'), ('kelime_sil', ''))
        self.assertEqual(ses.command_of('Toplantı yarın saat beş, son kelimeyi sil'), ('kelime_sil', 'Toplantı yarın saat beş'))
        self.assertEqual(ses.command_of('Pyn, son cümleyi sil'), ('cumle_sil', ''))
        self.assertEqual(ses.command_of('Hayır öyle değil, son cümleyi sil.'), ('cumle_sil', 'Hayır öyle değil'))
        self.assertEqual(ses.command_of('Hepsini sil.'), ('sil', ''))
        self.assertEqual(ses.command_of('Pyn, hepsini sil'), ('sil', ''))
        for note in ('Dosyaların hepsini sil', 'Son kelimeyi silmeyi unutma', 'son kelime güzeldi'):
            self.assertEqual(ses.command_of(note), (None, note), note)

    def test_gonder_tamam_bitti_save_only_right_after_the_name(self):
        self.assertEqual(ses.command_of('Pyn, gönder.'), ('kaydet', ''))
        self.assertEqual(ses.command_of('Toplantı yarın onda, Pyn tamam'), ('kaydet', 'Toplantı yarın onda'))
        self.assertEqual(ses.command_of('Pin bitti.'), ('kaydet', ''))
        for note in ("Raporu Ali'ye gönder", 'Tamam', 'Proje bitti', 'tamam mı'):
            self.assertEqual(ses.command_of(note), (None, note), note)
        self.assertEqual(ses.command_of('Pyn gönder', after_name=[]), (None, 'Pyn gönder'), 'the list is a setting')

    def test_the_small_models_sound_alikes_are_turkish_words_in_a_note_not_the_name(self):
        # "bin", "pay", "bayan" stand for Pyn only to the wake listener; Whisper writes the name.
        for note in ("Ali'ye beş bin gönder", 'Fiyat on bin tamam', 'Kira bitti, pay bitti'):
            self.assertEqual(ses.command_of(note), (None, note), note)
        self.assertEqual(ses.command_of('Maaş on bin, kaydet'), ('kaydet', 'Maaş on bin'))
        self.assertEqual(ses.command_of('Bin kaydet'), ('kaydet', 'Bin'))
        self.assertTrue(ses.wake_heard('pay not al'), 'still the name to the wake listener')

    def test_what_whisper_makes_up_for_silence_is_never_a_note(self):
        for made_up in ('Altyazı M.K.', 'İzlediğiniz için teşekkürler.', 'Abone olmayı unutmayın!', '[BLANK_AUDIO]', '[Müzik]'):
            self.assertEqual(ses.clean_spoken(made_up), '', made_up)
        self.assertEqual(ses.clean_spoken(' Altyazı dosyasını düzelt '), 'Altyazı dosyasını düzelt')

    def test_what_whisper_makes_up_after_the_words_is_cut_so_kaydet_is_still_the_end(self):
        cleaned = ses.clean_spoken('Toplantı notu, Pyn kaydet. Altyazı M.K.')
        self.assertEqual(cleaned, 'Toplantı notu, Pyn kaydet')
        self.assertEqual(ses.command_of(cleaned), ('kaydet', 'Toplantı notu'))
        self.assertEqual(ses.clean_spoken('Merhaba [Müzik] dünya'), 'Merhaba dünya')
        prompt = ses.DEFAULTS['ipucu']
        self.assertEqual(ses.clean_spoken('Süt al. ' + prompt, prompt), 'Süt al', 'its prompt said back')
        self.assertEqual(ses.clean_spoken(prompt, prompt), '')
        self.assertEqual(ses.clean_spoken('Yarın konser var, müzik'), 'Yarın konser var, müzik', 'one word is a word')

    def test_what_is_said_goes_after_what_was_typed(self):
        self.assertEqual(yakala.with_spoken('', 'merhaba dünya'), 'merhaba dünya')
        self.assertEqual(yakala.with_spoken('Toplantı:', 'yarın onda'), 'Toplantı: yarın onda')
        self.assertEqual(yakala.with_spoken('aynı ', ''), 'aynı')


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'

    def test_settings_are_their_defaults_until_changed_and_unknown_keys_are_dropped(self):
        config = ses.load_config(self.state)
        self.assertFalse(config['uyandirma'], 'the wake word starts off')
        self.assertEqual(config['uyandirma_sozu'], 'pyn not al')
        (ses.ses_dir(self.state)).mkdir(parents=True)
        (ses.ses_dir(self.state) / ses.CONFIG).write_text(json.dumps({'uyandirma': True, 'yabanci': 1, 'komutlar': {'kaydet': ['tamam', 'kaydet']}}), encoding='utf-8')
        config = ses.load_config(self.state)
        self.assertTrue(config['uyandirma'])
        self.assertNotIn('yabanci', config)
        self.assertEqual(config['komutlar']['kaydet'], ['tamam', 'kaydet'])
        self.assertEqual(config['komutlar']['sil'], ses.DEFAULTS['komutlar']['sil'], 'the other commands keep their words')
        self.assertFalse(ses.installed(self.state))
        self.assertFalse(ses.usable(self.state))

    def test_commands_saved_as_the_old_defaults_get_the_new_words_ones_chosen_stay(self):
        ses.ses_dir(self.state).mkdir(parents=True)
        path = ses.ses_dir(self.state) / ses.CONFIG
        path.write_text(json.dumps({'komutlar': {'kaydet': ['kaydet'], 'sil': ['sil', 'temizle'], 'iptal': ['iptal', 'vazgeç']}}), encoding='utf-8')
        config = ses.load_config(self.state)
        self.assertIn('hepsini sil', config['komutlar']['sil'], 'every older settings file holds the old default')
        self.assertEqual(config['komutlar']['kelime_sil'], ['son kelimeyi sil'])
        path.write_text(json.dumps({'komutlar': {'sil': ['temizle']}}), encoding='utf-8')
        self.assertEqual(ses.load_config(self.state)['komutlar']['sil'], ['temizle'], 'a list someone chose is theirs')

    def ayar(self, *args):
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out), mock.patch.object(ses, 'restart_listener', return_value=False):
            ses.main(['ayar', *args, '--json'], state=self.state)
        return json.loads(out.getvalue())

    def test_the_commands_words_are_a_setting_checked_before_they_are_kept(self):
        result = self.ayar('--komutlar', json.dumps({'kaydet': ['kaydet', ' Tamamdır  '], 'kelime_sil': ['geri al'],
                                                     'adla_kaydet': ['yolla']}, ensure_ascii=False))
        self.assertEqual(result['komutlar']['kaydet'], ['kaydet', 'Tamamdır'])
        self.assertEqual(result['komutlar']['kelime_sil'], ['geri al'])
        self.assertEqual(result['komutlar']['sil'], ses.DEFAULTS['komutlar']['sil'], 'what was not given stays')
        self.assertEqual(result['adla_kaydet'], ['yolla'])
        config = ses.load_config(self.state)
        self.assertEqual(ses.command_of('Bugün bitti, tamamdır', config['komutlar'], config['adla_kaydet']), ('kaydet', 'Bugün bitti'))
        for wrong, why in (({'kaydet': ['sil']}, 'iki komutta'), ({'uydur': ['x']}, 'Bilinmeyen'), ({'sil': ['a' * 41]}, 'uzun'),
                           ({'sil': 'sil'}, 'liste'), ({'sil': ['...']}, 'kelime')):
            with self.assertRaises(SystemExit) as raised:
                self.ayar('--komutlar', json.dumps(wrong))
            self.assertIn(why, str(raised.exception), wrong)
        self.assertEqual(ses.load_config(self.state)['komutlar']['kaydet'], ['kaydet', 'Tamamdır'], 'a refused change keeps nothing')
        reset = self.ayar('--varsayilan-komutlar')
        self.assertEqual((reset['komutlar'], reset['adla_kaydet']), (ses.DEFAULTS['komutlar'], ses.DEFAULTS['adla_kaydet']))

    def test_a_microphones_name_is_whole_and_without_the_word_microphone_around_it(self):
        names = ['Microsoft Sound Mapper - Input', 'Microphone (HyperX Cloud III Wi', 'Microphone (HyperX Cloud III Wireless)']
        self.assertEqual(ses.mic_label('Microphone (HyperX Cloud III Wi', names), 'HyperX Cloud III Wireless', 'MME cuts at 31 letters')
        self.assertEqual(ses.mic_label('Mikrofon (USB Audio)'), 'USB Audio')
        self.assertEqual(ses.mic_label('Headset Microphone'), 'Headset Microphone')
        self.assertEqual(ses.mic_label(''), '')

    def test_the_plan_picks_a_python_with_wheels_and_adds_cuda_only_with_an_nvidia_card(self):
        calls = []

        def run(command, **_options):
            calls.append(command)
            if command[:2] == ['py', '-3.12']:
                return subprocess.CompletedProcess(command, 1, '', 'not installed')
            if command[:2] == ['py', '-3.13']:
                return subprocess.CompletedProcess(command, 0, 'C:\\Python313\\python.exe\n', '')
            if command[0] == 'nvidia-smi':
                return subprocess.CompletedProcess(command, 0, 'GPU 0: RTX', '')
            return subprocess.CompletedProcess(command, 1, '', '')

        found = {'py': 'C:\\Windows\\py.exe', 'nvidia-smi': 'C:\\nvidia-smi.exe'}
        plan = ses.install_plan(self.state, which=found.get, run=run)
        if os.name == 'nt':
            self.assertEqual(plan['python'], 'C:\\Python313\\python.exe', '3.12 missing, 3.13 next')
        self.assertTrue(plan['ekran_karti'])
        self.assertIn('nvidia-cublas-cu12', plan['paketler'])
        self.assertTrue(plan['klasor'].endswith(ses.SES_DIR), 'everything under state/ses, outside the vault')
        self.assertEqual(plan['motor'], 'cuda')
        plan = ses.install_plan(self.state, which={'py': None}.get, run=run, system=self.tmp.name)
        self.assertFalse(plan['ekran_karti'])
        self.assertEqual(plan['motor'], 'islemci')
        self.assertNotIn('nvidia-cublas-cu12', plan['paketler'])
        self.assertIn('faster-whisper>=1.2', plan['paketler'])

    @unittest.skipUnless(os.name == 'nt', 'graphics cards are looked up the Windows way')
    def test_an_amd_or_intel_arc_card_with_vulkan_writes_with_whisper_cpp_and_integrated_intel_does_not(self):
        system = Path(self.tmp.name) / 'Windows'
        cards = []

        def run(command, **_options):
            if command[0] == 'powershell':
                return subprocess.CompletedProcess(command, 0, '\n'.join(cards) + '\n', '')
            return subprocess.CompletedProcess(command, 1, '', '')

        cards[:] = ['AMD Radeon(TM) Graphics', 'AMD Radeon RX 7800 XT']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'islemci', 'no Vulkan loader, no Vulkan')
        (system / 'System32').mkdir(parents=True)
        (system / 'System32' / 'vulkan-1.dll').write_bytes(b'')
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'vulkan')
        plan = ses.install_plan(self.state, which={}.get, run=run, system=system)
        self.assertEqual(plan['paketler'], list(ses.BASE_PACKAGES) + list(ses.DECODE_PACKAGES),
                         'whisper.cpp writes: no faster-whisper, no CUDA; PyAV only to open a recorded file')
        cards[:] = ['Intel(R) Arc(TM) A770 Graphics']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'vulkan')
        cards[:] = ['Intel(R) UHD Graphics 770', 'Intel(R) Iris(R) Xe Graphics']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'islemci')
        nvidia = {'nvidia-smi': 'C:\\nvidia-smi.exe'}.get
        found = lambda command, **_options: subprocess.CompletedProcess(command, 0, 'GPU 0: RTX', '')
        self.assertEqual(ses.engine_for(which=nvidia, run=found, system=system), 'cuda', 'an NVIDIA card goes first')
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='islemci'))
        self.assertEqual(ses.install_plan(self.state, which={}.get, run=run, system=system)['motor'], 'islemci', 'a chosen engine wins')

    def test_the_engine_in_use_is_the_chosen_one_else_the_installed_one_and_a_1_0_8_install_keeps_cuda(self):
        folder = ses.ses_dir(self.state)
        folder.mkdir(parents=True)
        self.assertEqual(ses.engine_in_use(self.state), 'islemci', 'nothing installed: the processor')
        (folder / ses.MARKER).write_text(json.dumps({'schema': 1, 'ekran_karti': True}), encoding='utf-8')
        self.assertEqual(ses.engine_in_use(self.state), 'cuda', 'before engines, the NVIDIA flag said CUDA')
        (folder / ses.MARKER).write_text(json.dumps({'schema': 1, 'motor': 'vulkan', 'ekran_karti': True}), encoding='utf-8')
        self.assertEqual(ses.engine_in_use(self.state), 'vulkan')
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='islemci'))
        self.assertEqual(ses.engine_in_use(self.state), 'islemci')

    def test_install_builds_the_environment_fetches_both_models_and_says_each_step(self):
        archive = Path(self.tmp.name) / 'vosk.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('vosk-model-small-tr-0.3/am/final.mdl', b'model')
        commands, said = [], []

        def run(command, **_options):
            commands.append(command)
            if '-m' in command and 'venv' in command:
                python = ses.venv_python(self.state)
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text('')
            if '--indir' in command:
                return subprocess.CompletedProcess(command, 0, 'large-v3-turbo (işlemci)\n', '')
            return subprocess.CompletedProcess(command, 0, '', '')

        def download(url, target):
            self.assertTrue(url.startswith('https://'))
            copy = target.with_name('indirilen.zip')
            copy.write_bytes(archive.read_bytes())
            return copy

        result = ses.install(self.state, say=said.append, run=run, download=download, which={}.get)
        self.assertEqual(result['model'], 'large-v3-turbo (işlemci)')
        self.assertTrue(ses.installed(self.state))
        self.assertTrue((ses.ses_dir(self.state) / ses.VOSK_DIR / 'am/final.mdl').is_file(), 'the archive’s top folder is the model folder')
        pip = next(c for c in commands if 'pip' in c)
        self.assertIn('faster-whisper>=1.2', pip)
        self.assertIn('vosk>=0.3.45', pip)
        fetch = next(c for c in commands if '--indir' in c)
        self.assertIn('--scripts', fetch, 'the Whisper model is fetched by the install, not by the first word')
        self.assertTrue(any('Whisper' in line for line in said))
        self.assertFalse((ses.ses_dir(self.state) / 'indirilen.zip').exists(), 'the archive is removed')
        self.assertEqual(ses.uninstall(self.state)['status'], 'kaldirildi')
        self.assertFalse(ses.ses_dir(self.state).exists())

    def vulkan_install(self, fetched, build=None):
        """An install with the Vulkan engine chosen; downloads and commands recorded, not run."""
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='vulkan'))
        (ses.ses_dir(self.state) / ses.VOSK_DIR).mkdir(parents=True, exist_ok=True)  # the wake model is not this test's
        commands, said = [], []

        def run(command, **_options):
            commands.append(command)
            if '-m' in command and 'venv' in command:
                python = ses.venv_python(self.state)
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text('')
            if '--indir' in command:
                engine = json.loads((ses.ses_dir(self.state) / ses.MARKER).read_text(encoding='utf-8'))['motor']
                return subprocess.CompletedProcess(command, 0, 'large-v3-turbo (%s)\n' % engine, '')
            return subprocess.CompletedProcess(command, 0, '', '')

        def download_checked(url, target, sha256, say=print):
            fetched.append((url, sha256))
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            Path(target).write_bytes(build.read_bytes() if url == ses.VULKAN_BUILD['url'] else b'ggml')
            return target

        result = ses.install(self.state, say=said.append, run=run, download=None, which={}.get, download_checked=download_checked)
        return result, next(c for c in commands if 'pip' in c), said

    def test_with_whisper_cpp_in_place_the_vulkan_install_fetches_its_model_by_digest_and_no_faster_whisper(self):
        exe = ses.server_exe(self.state)
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b'MZ')  # a build put there by hand, as before the pre-release is published
        fetched = []
        result, pip, _said = self.vulkan_install(fetched)
        self.assertEqual((result['motor'], result['model']), ('vulkan', 'large-v3-turbo (vulkan)'), 'the trial load ran on Vulkan')
        self.assertEqual(fetched, [(ses.GGML_MODEL['url'], ses.GGML_MODEL['sha256'])])
        self.assertNotIn('faster-whisper>=1.2', pip)
        self.assertIn('vosk>=0.3.45', pip)
        self.assertEqual(ses.engine_in_use(self.state), 'vulkan')

    def test_whisper_cpp_comes_from_its_pre_release_and_without_one_the_processor_writes(self):
        fetched = []
        with mock.patch.dict(ses.VULKAN_BUILD, sha256=None):
            result, pip, said = self.vulkan_install(fetched)
        self.assertEqual(result['motor'], 'islemci')
        self.assertIn('faster-whisper>=1.2', pip, 'the processor writes with faster-whisper')
        self.assertTrue(any('İşlemciye' in line for line in said))
        self.assertEqual(fetched, [], 'nothing fetched for an engine that is not used')
        build = Path(self.tmp.name) / 'whisper-vulkan-win-x64.zip'
        with zipfile.ZipFile(build, 'w') as zipped:  # as the workflow packs it: the files at the top
            zipped.writestr(ses.SERVER_EXE, b'MZ')
            zipped.writestr('LICENSE-whisper.cpp.txt', b'MIT')
        fetched.clear()
        with mock.patch.dict(ses.VULKAN_BUILD, sha256='ab' * 32):
            result, _pip, _said = self.vulkan_install(fetched, build)
        self.assertEqual(result['motor'], 'vulkan')
        self.assertEqual(fetched[0], (ses.VULKAN_BUILD['url'], 'ab' * 32), 'the build is checked by its digest')
        self.assertTrue(ses.server_exe(self.state).is_file())
        self.assertFalse((ses.ses_dir(self.state) / 'whisper-vulkan.zip').exists(), 'the archive is removed')

    def test_a_failed_reinstall_leaves_the_working_install_as_it_was(self):
        folder = ses.ses_dir(self.state)
        (folder / ses.VOSK_DIR).mkdir(parents=True)
        before = json.dumps({'schema': 1, 'motor': 'islemci', 'ekran_karti': False, 'model': 'small (işlemci)'})
        (folder / ses.MARKER).write_text(before, encoding='utf-8')
        python = ses.venv_python(self.state)
        python.parent.mkdir(parents=True)
        python.write_text('')

        def run(command, **_options):
            failed = '--indir' in command
            return subprocess.CompletedProcess(command, 1 if failed else 0, '', 'CUDA failed' if failed else '')

        with self.assertRaises(RuntimeError):
            ses.install(self.state, say=lambda _text: None, run=run, which={}.get, system=self.tmp.name)
        self.assertEqual((folder / ses.MARKER).read_text(encoding='utf-8'), before)

    def test_a_download_whose_digest_does_not_match_never_takes_the_name(self):
        folder = Path(self.tmp.name) / 'indirme'
        target = folder / 'model.bin'

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        with mock.patch('urllib.request.urlopen', lambda url, timeout: Response(b'not the model')):
            with self.assertRaises(ValueError):
                ses._download_checked('https://example.invalid/model.bin', target, '0' * 64)
        self.assertEqual(list(folder.iterdir()), [], 'neither the name nor a partial file is left')
        with self.assertRaises(ValueError):
            ses._download_checked('http://example.invalid/model.bin', target, None)

    def test_a_big_download_says_how_far_it_is_and_the_install_says_each_step_as_a_line(self):
        data = os.urandom(3 << 20)

        class Response(io.BytesIO):
            headers = {'Content-Length': str(len(data))}

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        import hashlib
        said = []
        with mock.patch('urllib.request.urlopen', lambda url, timeout: Response(data)):
            ses._download_checked('https://example.invalid/m.bin', Path(self.tmp.name) / 'm.bin', hashlib.sha256(data).hexdigest(), said.append)
        self.assertEqual(said[-1].strip(), '%100 (3 / 3 MB)')
        self.assertLessEqual(len(said), 10, 'a tenth at a time, not a line a megabyte')

        def install(state, say):
            say('Motor: işlemci')
            say('  %50 (800 / 1600 MB)')
            return {'status': 'kuruldu', 'motor': 'islemci'}

        out = io.StringIO()
        from contextlib import redirect_stdout
        with mock.patch.object(ses, 'install', install), mock.patch.object(ses, 'restart_listener', lambda _state: True), redirect_stdout(out):
            ses.main(['kur', '--json'], state=self.state)
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(lines[:2], [{'adim': 'Motor: işlemci'}, {'adim': '%50 (800 / 1600 MB)'}])
        self.assertEqual((lines[-1]['status'], lines[-1]['dinleyici']), ('kuruldu', True), 'the result is the last line')

    def test_an_archive_that_reaches_outside_its_folder_is_refused(self):
        archive = Path(self.tmp.name) / 'kotu.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('../../disari.txt', b'x')
        with self.assertRaises(ValueError):
            ses._unpack(archive, Path(self.tmp.name) / 'model')
        self.assertFalse((Path(self.tmp.name).parent / 'disari.txt').exists())

    def test_the_command_line_says_when_it_is_not_installed(self):
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out):
            ses.main(['durum', '--human'], state=self.state)
        self.assertIn('kurulu değil', out.getvalue())
        out = io.StringIO()
        with redirect_stdout(out):
            ses.main(['durum'], state=self.state)
        self.assertFalse(json.loads(out.getvalue())['kurulu'], 'read by a program, not a terminal: JSON')
        out = io.StringIO()
        with redirect_stdout(out):
            ses.main(['durum', '--json'], state=self.state)
        self.assertFalse(json.loads(out.getvalue())['kurulu'])


FAKE_HELPER = r'''
import json, sys
print(json.dumps({"olay": "yukleniyor"}), flush=True)
print(json.dumps({"olay": "hazir", "aciklama": "sahte (islemci)"}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    name = command["komut"]
    if name == "dinle":
        print(json.dumps({"olay": "dinliyor"}), flush=True)
    elif name == "bitir":
        print(json.dumps({"olay": "ceviriyor"}), flush=True)
        print(json.dumps({"olay": "metin", "metin": "Toplantı notu", "komut": "kaydet"}, ensure_ascii=False), flush=True)
    elif name == "kapat":
        break
'''


class TrialWakeTest(unittest.TestCase):
    def test_the_wake_trial_says_what_was_heard_and_whether_the_window_would_open(self):
        events = [{'olay': 'dinliyor', 'sn': 20, 'mikrofon': 'Mikrofon (USB)', 'model': 'large-v3-turbo', 'soz': 'pyn not al'},
                  {'olay': 'duyulan', 'metin': '[unk] not al'},
                  {'olay': 'karar', 'karar': 'aday', 'duyulan': '[unk] not al', 'whisper': 'Payn, not al.', 'uyanir': True},
                  {'olay': 'karar', 'karar': 'aday', 'duyulan': '[unk] not al', 'whisper': 'Bunu not al.', 'uyanir': False},
                  {'olay': 'karar', 'karar': 'soz', 'duyulan': 'pay not al', 'uyanir': True}]
        asked = []

        def popen(command, **_options):
            asked.append(command)
            lines = [json.dumps(event, ensure_ascii=False) + '\n' for event in events]
            return types.SimpleNamespace(stdout=iter(lines), wait=lambda: 0)

        said = []
        with tempfile.TemporaryDirectory(prefix='v3-ses-dene-') as tmp:
            self.assertEqual(ses.trial_wake(Path(tmp), 20, False, popen=popen, say=said.append), 0)
        self.assertEqual(asked[0][-2:], ['--dene-uyandirma', '20'])
        text = '\n'.join(said)
        self.assertIn('20 saniye dinliyorum · Mikrofon (USB)', text)
        self.assertIn('"Pyn, not al" de', text)
        self.assertIn('küçük model: [unk] not al', text)
        self.assertIn('Whisper: “Payn, not al.” · pencere açılırdı ✓', text)
        self.assertIn('Whisper: “Bunu not al.” · Pyn\'in adını duymadı, pencere açılmazdı ✗', text)
        self.assertIn('sözü tam duydu: pencere açılırdı ✓', text)


class WorkerTest(unittest.TestCase):
    def test_commands_go_in_and_events_come_out_one_line_each(self):
        with tempfile.TemporaryDirectory(prefix='v3-ses-isci-') as tmp:
            script = Path(tmp) / 'sahte.py'
            script.write_text(FAKE_HELPER, encoding='utf-8')
            worker = ses.Worker(Path(tmp) / 'state', command=[sys.executable, '-u', str(script)])
            try:
                events = self.until(worker, 'hazir')
                self.assertEqual([e['olay'] for e in events], ['yukleniyor', 'hazir'])
                self.assertTrue(worker.send('dinle'))
                self.assertEqual(self.until(worker, 'dinliyor')[-1]['olay'], 'dinliyor')
                worker.send('bitir')
                spoken = self.until(worker, 'metin')[-1]
                self.assertEqual((spoken['metin'], spoken['komut']), ('Toplantı notu', 'kaydet'))
            finally:
                worker.close()
            self.assertFalse(worker.alive)
            self.assertEqual(self.until(worker, 'bitti')[-1]['olay'], 'bitti', 'a helper that ends says so')
            self.assertFalse(worker.send('dinle'), 'nothing is sent to a helper that is gone')

    def until(self, worker, kind, wait=10.0):
        seen, deadline = [], time.monotonic() + wait
        while time.monotonic() < deadline:
            seen.extend(worker.take())
            if any(e.get('olay') == kind for e in seen):
                return seen
            time.sleep(0.02)
        self.fail('no %s event; saw %s' % (kind, seen))


class FakeWorker:
    def __init__(self):
        self.sent, self.values = [], []

    def send(self, command, **values):
        self.sent.append(command)
        self.values.append(values)
        return True


class PopupVoiceTest(unittest.TestCase):
    """The capture window ("Not al") with a microphone, built on a hidden Tk root and never shown."""

    def setUp(self):
        try:
            import tkinter as tk
            self.root = tk.Tk()
        except Exception as exc:  # no Tk, or no display
            self.skipTest('Tk yok: %s' % exc)
        self.root.withdraw()
        # Built and never shown, as the tests' listener does it: no window put on screen, and on a
        # Mac none of the native window calls (_style_mac). A Tk update() in a test with them hung
        # GitHub's macOS runner for good (17-18 October); these tests need no update() either.
        patcher = mock.patch.dict(os.environ, {'BEYIN_YAKALA_GIZLI': '1'})
        patcher.start()
        self.addCleanup(patcher.stop)
        # Tk's images are freed here, after the root: freed later on another test's thread, each
        # one waits there for a main loop that is not running.
        self.addCleanup(gc.collect)
        self.addCleanup(self.root.destroy)
        from unittest.mock import patch
        # Nothing appears on the screen and nothing is read from the person's clipboard.
        for target in ('tkinter.Toplevel.deiconify', 'tkinter.Toplevel.lift', 'tkinter.Toplevel.focus_force'):
            patcher = patch(target, lambda *_a, **_k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (('_clipboard', lambda _root: ''), ('clipboard_image', lambda *_a: None), ('_bring_to_front', lambda *_a: False)):
            patcher = patch.object(yakala, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-pencere-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Kasa'
        self.vault.mkdir()
        self.link = yakala.VoiceLink(FakeWorker())

    def window(self, **options):
        win = yakala.popup(self.vault, {}, master=self.root, state=Path(self.tmp.name) / 'state', voice=self.link, **options)
        self.root.update_idletasks()
        return win

    @staticmethod
    def texts(win):
        canvas = next(child for child in win.winfo_children() if child.winfo_class() == 'Canvas')
        return [canvas.itemcget(item, 'text') for item in canvas.find_all() if canvas.type(item) == 'text']

    def cards(self):
        return list((self.vault / yakala.INBOX).glob('*.md'))

    def test_it_is_named_for_what_it_does_and_says_what_to_do_while_it_listens(self):
        self.link.ready = True
        win = self.window()
        texts = self.texts(win)
        self.assertIn('Not al', texts)
        self.assertNotIn('Beyne at', texts)
        self.assertTrue(any(text.startswith('Konuşmak için mikrofona tıkla') for text in texts), 'what a press does')
        commands = next(text for text in texts if text.startswith('Komutlar:'))
        for said in ('“kaydet”', '“resmi ekle”', '“son kelimeyi sil”', '“son cümleyi sil”', '“hepsini sil”', '“iptal”'):
            self.assertIn(said, commands, 'the spoken commands are written down')
        win.voice_toggle()
        win.voice_event({'olay': 'dinliyor', 'mikrofon': 'Microphone (HyperX Cloud III Wireless)'})
        texts = self.texts(win)
        self.assertIn('● Dinliyorum · Microphone (HyperX Cloud III Wireless)', texts, 'which microphone is listened to')
        self.assertTrue(any('Susunca yazarım' in text and 'Enter' in text and 'Esc' in text for text in texts),
                        'how to stop is said while it listens')

    def test_it_listens_as_it_opens_and_typing_lets_the_microphone_go(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        self.assertEqual(self.link.worker.sent, ['dinle'], 'listening at once')
        win.voice_event({'olay': 'dinliyor'})
        win.typed()
        self.assertEqual(self.link.worker.sent, ['dinle', 'iptal'], 'a key typed: the microphone goes')
        self.assertTrue(any('Yazmaya başladın' in text for text in self.texts(win)))
        # What the helper still says about that recording changes nothing.
        for event in ({'olay': 'dinliyor'}, {'olay': 'metin', 'metin': '', 'komut': None}):
            win.voice_event(event)
        self.assertIn('Yazmaya başladın; dinlemeyi bıraktım', self.texts(win), 'still let go')
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['dinle', 'iptal', 'dinle'], 'and a press listens again')

    def test_opened_before_the_model_is_loaded_it_listens_once_it_is(self):
        win = self.window(auto_listen=True)
        self.assertEqual(self.link.worker.sent, [])
        self.assertTrue(any(text.startswith('Ses hazırlanıyor') for text in self.texts(win)))
        self.link.ready = True
        win.voice_event({'olay': 'hazir', 'aciklama': 'large-v3-turbo (ekran kartı, Vulkan)'})
        self.assertEqual(self.link.worker.sent, ['dinle'])

    def test_opened_listening_it_takes_dictation_until_pyn_kaydet(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        self.assertEqual((self.link.worker.sent, self.link.worker.values), (['dinle'], [{'surekli': True}]),
                         'one dictation: the helper keeps the microphone open between sentences')
        win.voice_event({'olay': 'dinliyor'})
        self.assertTrue(any('Pyn, kaydet' in text for text in self.texts(win)), 'how to finish is said')
        # A pause: the sentence is written in and the microphone was never let go.
        win.voice_event({'olay': 'metin', 'metin': 'Cuma günü', 'komut': None, 'son': False})
        self.assertEqual(self.link.worker.sent, ['dinle'], 'nothing to ask: it still listens')
        self.assertTrue(any(text.startswith('● Dinliyorum') for text in self.texts(win)))
        self.assertEqual(self.cards(), [])
        win.voice_event({'olay': 'metin', 'metin': 'sunum provası', 'komut': 'kaydet', 'son': True})
        cards = self.cards()
        self.assertEqual(len(cards), 1, 'saved without a key pressed')
        self.assertIn('Cuma günü sunum provası', cards[0].read_text(encoding='utf-8'))

    def test_a_long_silence_ends_the_dictation(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': None, 'son': True})  # the helper's own end
        self.assertEqual(self.link.worker.sent, ['dinle'], 'it does not listen again by itself')
        self.assertIn('Bir süredir ses gelmedi; dinlemeyi bıraktım', self.texts(win))

    def test_enter_while_it_listens_ends_it_and_saves_what_was_said(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.enter()
        self.assertEqual(self.link.worker.sent, ['dinle', 'bitir'])
        self.assertEqual(self.cards(), [], 'not saved before the words are written')
        win.voice_event({'olay': 'ceviriyor'})
        win.voice_event({'olay': 'metin', 'metin': 'Cuma', 'komut': None, 'son': False})
        self.assertEqual(self.cards(), [], 'a sentence said before it: the last one is still to come')
        win.voice_event({'olay': 'metin', 'metin': 'sunum provası', 'komut': None, 'son': True})
        cards = self.cards()
        self.assertEqual(len(cards), 1)
        self.assertIn('Cuma sunum provası', cards[0].read_text(encoding='utf-8'))

    def test_sil_in_a_dictation_clears_the_field_and_it_goes_on_listening(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.voice_event({'olay': 'metin', 'metin': 'yanlış bir şey', 'komut': None, 'son': False})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'sil', 'son': False})
        win.voice_event({'olay': 'metin', 'metin': 'Doğrusu bu', 'komut': 'kaydet', 'son': True})
        cards = self.cards()
        self.assertEqual(len(cards), 1)
        self.assertNotIn('yanlış', cards[0].read_text(encoding='utf-8'))
        self.assertIn('Doğrusu bu', cards[0].read_text(encoding='utf-8'))

    def field(self, win):
        return next(child for child in win.winfo_children() if child.winfo_class() == 'Text')

    def test_son_kelimeyi_sil_and_son_cumleyi_sil_take_back_what_was_said_and_it_goes_on(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.voice_event({'olay': 'metin', 'metin': 'Toplantı yarın.', 'komut': None, 'son': False})
        win.voice_event({'olay': 'metin', 'metin': 'Saat beş altı', 'komut': 'kelime_sil', 'son': False})
        self.assertEqual(self.field(win).get('1.0', 'end-1c'), 'Toplantı yarın. Saat beş')
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'cumle_sil', 'son': False})
        self.assertEqual(self.field(win).get('1.0', 'end-1c'), 'Toplantı yarın.')
        self.assertEqual(self.link.worker.sent, ['dinle'], 'it still listens')
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'cumle_sil', 'son': False})
        self.assertTrue(any('Konuş, ben yazayım' in text for text in [self.field(win).get('1.0', 'end-1c')]), 'nothing left: the hint again')
        win.voice_event({'olay': 'metin', 'metin': 'Saat altıda', 'komut': 'kaydet', 'son': True})
        self.assertIn('Saat altıda', self.cards()[0].read_text(encoding='utf-8'))

    def test_panodaki_resmi_ekle_adds_the_picture_copied_last_and_the_note_is_saved_with_it(self):
        from unittest.mock import patch
        folder = Path(tempfile.mkdtemp(prefix='v3-pano-'))
        png = folder / 'pano-goruntusu.png'
        png.write_bytes(bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                                      '1f15c4890000000d49444154789c6300010000050001'
                                      '0d0a2db40000000049454e44ae426082'))
        picture = {'path': str(png), 'folder': str(folder), 'width': 1, 'height': 1, 'age': None, 'stale': False, 'on': False}
        self.link.ready = True
        win = self.window(auto_listen=True)  # nothing on the clipboard as it opened
        win.voice_event({'olay': 'dinliyor'})
        with patch.object(yakala, 'clipboard_image', lambda *_a: dict(picture)):
            win.voice_event({'olay': 'metin', 'metin': 'Hata yine çıktı', 'komut': 'resim_ekle', 'son': False})
        self.assertTrue(any('Panodaki görüntü eklendi' in text for text in self.texts(win)), 'it says the picture goes')
        win.voice_event({'olay': 'metin', 'metin': 'Ekranı Ali\'ye göster', 'komut': 'kaydet', 'son': True})
        card = self.cards()[0].read_text(encoding='utf-8')
        self.assertIn('Hata yine çıktı', card)
        saved = [path for path in (self.vault / yakala.INBOX / 'dosyalar').glob('*') if not path.name.startswith('.')]
        self.assertEqual(len(saved), 1, 'the picture is saved with the note')

    def test_panodaki_resmi_ekle_with_nothing_on_the_clipboard_says_so(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'resim_ekle', 'son': False})
        self.assertTrue(any('Panoda görüntü yok' in text for text in self.texts(win)))

    def test_a_long_note_wraps_and_the_window_grows_to_show_it(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        canvas = next(child for child in win.winfo_children() if child.winfo_class() == 'Canvas')
        before = int(canvas.cget('height'))
        win.voice_event({'olay': 'dinliyor'})
        said = 'Şu an ne yapıyoruz? Bunların hepsini kaydedip yarın sabah toplantıda konuşalım, sonra da raporu bitirelim.'
        win.voice_event({'olay': 'metin', 'metin': said, 'komut': None, 'son': False})
        field = self.field(win)
        self.assertEqual(field.get('1.0', 'end-1c'), said, 'all of it in the field')
        self.assertGreater(int(field.cget('height')), 1, 'more than one line shown')
        self.assertGreater(int(canvas.cget('height')), before, 'the window grew with it')
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'sil', 'son': False})
        self.assertEqual((int(field.cget('height')), int(canvas.cget('height'))), (1, before), 'and back once emptied')

    def test_typing_in_a_dictation_keeps_what_was_said_before_but_no_command(self):
        self.link.ready = True
        win = self.window(auto_listen=True)
        win.voice_event({'olay': 'dinliyor'})
        win.typed()
        self.assertEqual(self.link.worker.sent, ['dinle', 'iptal'])
        win.voice_event({'olay': 'metin', 'metin': 'Söylenen', 'komut': 'kaydet', 'son': False})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': None, 'son': True})
        self.assertEqual(self.cards(), [], 'nothing saved by itself once typing began')
        win.enter()
        self.assertIn('Söylenen', self.cards()[0].read_text(encoding='utf-8'))

    def test_the_wake_phrase_said_to_an_open_window_begins_a_dictation(self):
        self.link.ready = True
        win = self.window()
        win.voice_event({'olay': 'dinliyor'})
        win.voice_event({'olay': 'uyandi'})
        self.assertTrue(any('Pyn, kaydet' in text for text in self.texts(win)), 'it takes dictation')

    def test_what_is_said_is_written_into_the_field_and_kaydet_at_the_end_saves_it(self):
        self.link.ready = True
        win = self.window()
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['dinle'])
        for event in ({'olay': 'dinliyor'}, {'olay': 'seviye', 'deger': 0.6}, {'olay': 'ceviriyor'}):
            win.voice_event(event)
        win.voice_toggle()  # writing: a press does nothing more
        self.assertEqual(self.link.worker.sent, ['dinle'])
        win.voice_event({'olay': 'metin', 'metin': 'Yarın onda toplantı', 'komut': 'kaydet'})
        cards = list((self.vault / yakala.INBOX).glob('*.md'))
        self.assertEqual(len(cards), 1, 'saved as a card in the inbox')
        self.assertIn('Yarın onda toplantı', cards[0].read_text(encoding='utf-8'))

    def test_a_quiet_microphone_that_hears_speech_is_not_called_silent(self):
        # Seen: "Mikrofondan ses gelmiyor" over a sentence being written, from a headset with little gain.
        self.link.ready = True
        clock = types.SimpleNamespace(t=1000.0)
        with mock.patch.object(yakala, 'time_now', lambda: clock.t):
            win = self.window()
            win.voice_toggle()
            win.voice_event({'olay': 'dinliyor', 'mikrofon': 'HyperX'})
            clock.t += 4
            win.voice_event({'olay': 'seviye', 'deger': 0.1, 'konusma': True})
            self.assertFalse(any('ses gelmiyor' in text for text in self.texts(win)), 'speech came in')
            win.voice_event({'olay': 'dinliyor', 'mikrofon': 'HyperX'})
            clock.t += 4
            win.voice_event({'olay': 'seviye', 'deger': 0.0})
            self.assertTrue(any('Mikrofondan ses gelmiyor · HyperX' in text for text in self.texts(win)), 'nothing at all: said')
            win.voice_event({'olay': 'metin', 'metin': 'Beni duyuyor musun?', 'son': False})
            self.assertFalse(any('ses gelmiyor' in text for text in self.texts(win)), 'a sentence written: the warning goes')
            self.assertTrue(any('Dinliyorum' in text for text in self.texts(win)))
            clock.t += 4
            win.voice_event({'olay': 'seviye', 'deger': 0.0})
            self.assertFalse(any('ses gelmiyor' in text for text in self.texts(win)), 'and does not come back in that dictation')

    def test_opened_by_the_wake_phrase_it_is_already_listening_and_closing_lets_the_microphone_go(self):
        win = self.window(listening=True)
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['bitir'], 'a press ends what the wake phrase began')
        win.voice_event({'olay': 'dinliyor'})
        win.leave()  # Esc
        self.assertEqual(self.link.worker.sent, ['bitir', 'iptal'])

    def test_until_the_model_is_loaded_the_microphone_waits_and_a_failure_is_said(self):
        win = self.window()
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, [], 'not ready: nothing is recorded yet')
        self.link.ready = True
        win.voice_event({'olay': 'hazir', 'aciklama': 'large-v3-turbo (işlemci)'})
        self.assertEqual(self.link.worker.sent, ['dinle'], 'pressed while loading: it listens once loaded')
        win.voice_event({'olay': 'hata', 'neden': 'mikrofon', 'mesaj': 'Mikrofon açılamadı'})
        self.assertIn('Ses: Mikrofon açılamadı', self.texts(win))
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['dinle', 'dinle'], 'ready again after the failure')
        win.voice_event({'olay': 'metin', 'metin': 'sil bunu', 'komut': None})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'sil'})
        win.voice_event({'olay': 'bitti'})


# whisper.cpp's server stood in for: the same flags, GET / when ready, POST /inference with a WAV.
FAKE_SERVER = r'''
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
record, args = sys.argv[1], sys.argv[2:]
with open(record, 'a', encoding='utf-8') as log:
    log.write(json.dumps({'argv': args}) + '\n')
if 'kart-yok' in args and '-dev' in args:
    print('ggml_vulkan: no devices found', file=sys.stderr, flush=True)
    sys.exit(3)
port = int(args[args.index('--port') + 1])


class Answer(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        silent = body.count(b'\x00' * 64) > 100
        with open(record, 'a', encoding='utf-8') as log:
            log.write(json.dumps({'yol': self.path, 'wav': b'RIFF' in body and b'WAVEfmt' in body,
                                  'json': b'name="response_format"\r\n\r\njson' in body, 'sessiz': silent}) + '\n')
        text = ' [BLANK_AUDIO]\n' if silent else ' Merhaba\n dünya\n'
        payload = json.dumps({'text': text}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


HTTPServer(('127.0.0.1', port), Answer).serve_forever()
'''


class VulkanServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-sunucu-')
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        (self.folder / 'sunucu.py').write_text(FAKE_SERVER, encoding='utf-8')
        self.record = self.folder / 'kayit.jsonl'
        # The helper as it runs: written into a voice folder and loaded from there.
        spec = importlib.util.spec_from_file_location('isci_sunucu_testi', ses.write_worker(self.folder / 'state'))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.ses = ses

    def stand_in(self, *extra):
        return [sys.executable, str(self.folder / 'sunucu.py'), str(self.record), *extra]

    def seen(self):
        return [json.loads(line) for line in self.record.read_text(encoding='utf-8').splitlines()]

    def test_whisper_cpp_starts_on_a_local_port_is_warmed_up_and_is_asked_with_a_wav(self):
        import threading
        config = dict(ses.DEFAULTS, ipucu='Pyn, Cortex')
        server = self.helper.Server(self.stand_in(), self.folder / 'model.bin', config, self.folder / 'sunucu.log')
        try:
            text = self.helper.transcribe(server, b'\x10\x00\xf0\xff' * 8000, config, threading.Lock())
        finally:
            self.helper.release(server)
        self.assertEqual(text, 'Merhaba dünya', 'its lines joined, its spaces trimmed')
        self.assertIsNotNone(server.process.poll(), 'released with the helper')
        launch, warm, asked = self.seen()
        argv = launch['argv']
        self.assertEqual(argv[argv.index('--host') + 1], '127.0.0.1', 'only this machine can reach it')
        self.assertEqual(argv[argv.index('-l') + 1], 'tr')
        self.assertEqual(argv[argv.index('--prompt') + 1], 'Pyn, Cortex')
        self.assertEqual(argv[argv.index('-dev') + 1], '0')
        self.assertIn('-nt', argv)
        self.assertEqual((warm['yol'], warm['sessiz']), ('/inference', True), 'warmed up on silence before the first sentence')
        self.assertEqual((asked['wav'], asked['json'], asked['sessiz']), (True, True, False))

    def test_a_card_that_fails_is_said_and_whisper_cpp_writes_on_the_processor(self):
        from contextlib import redirect_stderr
        stand_in = self.stand_in('kart-yok')
        self.helper.ses = types.SimpleNamespace(
            engine_in_use=lambda _state, _config: 'vulkan', server_exe=lambda _state: stand_in,
            ggml_model=lambda _state: self.folder / 'ggml-large-v3-turbo.bin', ses_dir=lambda _state: self.folder,
            GGML_MODEL=ses.GGML_MODEL)
        errors = io.StringIO()
        with redirect_stderr(errors):
            model, what = self.helper.load_model(self.folder, dict(ses.DEFAULTS))
        self.helper.release(model)
        self.assertEqual(what, 'large-v3-turbo (işlemci, whisper.cpp)')
        self.assertIn('Vulkan açılamadı', errors.getvalue())
        self.assertIn('no devices found', errors.getvalue(), 'why, from whisper.cpp itself (isci.log)')
        first, second = [entry['argv'] for entry in self.seen() if 'argv' in entry]
        self.assertIn('-dev', first)
        self.assertIn('-ng', second)


class Sound:
    """A piece of recorded sound, by name: what the stand-in Whisper is asked to write."""

    def __init__(self, name, seconds=1.0):
        self.name, self.seconds = name, seconds

    def __len__(self):
        return int(self.seconds * 16000)


class FakeRecorder:
    """The microphone, played by the test: it says when someone speaks and what each sentence is."""

    def __init__(self, clock):
        self.clock, self.stream, self.level, self.said = clock, None, 0.0, []
        self.starts = self.stops = 0
        self._sentence()

    def _sentence(self):
        self.spoke, self.started, self.last_voice = False, self.clock.t, self.clock.t

    def start(self, on_chunk=None):
        self.stream, self.said = 'open', []
        self.starts += 1
        self._sentence()

    def speak(self, name):
        self.said.append(name)
        self.spoke, self.last_voice = True, self.clock.t

    def cut(self):
        sound = Sound('+'.join(self.said))
        self.said = []
        self._sentence()
        return sound

    def peek(self):
        return Sound('+'.join(self.said))

    def stop(self):
        self.stream = None
        self.stops += 1
        sound, self.said = Sound('+'.join(self.said), 1.0 if self.said else 0.0), []
        return sound


class FakeWake:
    def __init__(self):
        self.running, self.verdicts, self.text, self.starts = False, [], '', 0
        self.fail, self.stall, self.last_sound = 0, False, 0.0

    def start(self):
        self.starts += 1
        if self.fail:
            self.fail -= 1
            raise OSError('Error opening InputStream: Invalid device')
        self.running = True

    def stalled(self, _moment):
        return self.stall

    def stop(self):
        self.running = False

    def heard(self, seen=None):
        if self.verdicts:
            self.text = '[unk] not al'
            return self.verdicts.pop(0)
        return None

    def clip(self):
        return Sound('once')


class ServeTest(unittest.TestCase):
    """The helper's loop with the microphone, Vosk and Whisper stood in for and the clock held."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-dongu-')
        self.addCleanup(self.tmp.cleanup)
        spec = importlib.util.spec_from_file_location('isci_dongu_testi', ses.write_worker(Path(self.tmp.name) / 'state'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        helper.ses = ses
        self.clock = types.SimpleNamespace(t=1000.0)
        self.recorder, self.wake = FakeRecorder(self.clock), FakeWake()
        self.events, self.asked, self.written = queue.Queue(), [], {}
        self.logged, self.refreshed = [], []
        self.hold = threading.Event()
        self.hold.set()

        def transcribe(_model, audio, _config, _lock):
            self.asked.append(audio.name)
            self.hold.wait(5)
            return self.written.get(audio.name, '')

        for name, value in (('Recorder', lambda _config: self.recorder), ('Wake', lambda _state, _config: self.wake),
                            ('load_model', lambda _state, _config: ('model', 'sahte')), ('release', lambda _model: None),
                            ('transcribe', transcribe), ('_device_name', lambda _config: 'Mikrofon'),
                            ('join_audio', lambda *parts: Sound('+'.join(part.name for part in parts if part.name))),
                            ('out', lambda **event: self.events.put(event)), ('log', self.logged.append),
                            ('_refresh_audio', lambda: self.refreshed.append(1) or True),
                            ('now', lambda: self.clock.t)):
            setattr(helper, name, value)
        self.helper, self.lines = helper, queue.Queue()

    def serve(self, **config):
        def lines():
            while True:
                line = self.lines.get()
                if line is None:
                    return
                yield line
        settings = dict(ses.DEFAULTS, **config)
        thread = threading.Thread(target=self.helper.serve, args=(Path(self.tmp.name) / 'state', settings, lines()), daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.send('kapat'), self.hold.set(), thread.join(5)))
        self.until('hazir')

    def send(self, command, **values):
        self.lines.put(json.dumps(dict(values, komut=command)) + '\n')

    def until(self, kind, wait=5.0, **fields):
        seen, deadline = [], time.monotonic() + wait
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=0.02)
            except queue.Empty:
                continue
            seen.append(event)
            if event.get('olay') == kind and all(event.get(k) == v for k, v in fields.items()):
                return event
        self.fail('no %s %s; saw %s' % (kind, fields, seen))

    def quiet(self, wait=0.4):
        """What it said in a little while, `seviye` aside."""
        deadline, seen = time.monotonic() + wait, []
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=0.02)
            except queue.Empty:
                continue
            if event.get('olay') != 'seviye':
                seen.append(event)
        return seen

    def pause(self, seconds=1.5):
        self.clock.t += seconds

    def until_asked(self, *names, wait=5.0):
        deadline = time.monotonic() + wait
        while self.asked != list(names) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.asked, list(names), 'what Whisper was asked to write')

    def until_recording(self, wait=5.0):
        deadline = time.monotonic() + wait
        while self.recorder.stream is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.recorder.stream, 'open')

    def test_a_dictation_keeps_the_microphone_open_while_a_sentence_is_written(self):
        self.serve()
        self.written.update({'cuma': 'Cuma günü', 'prova': 'sunum provası, Pyn kaydet.'})
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.hold.clear()  # Whisper is slow: the first sentence is still being written...
        self.recorder.speak('cuma')
        self.pause()
        self.until_asked('cuma')
        self.recorder.speak('prova')  # ...while the next one is said into the open microphone
        self.assertEqual((self.recorder.stream, self.recorder.stops), ('open', 0), 'never let go between sentences')
        self.hold.set()
        first = self.until('metin')
        self.assertEqual((first['metin'], first['komut'], first['son']), ('Cuma günü', None, False))
        self.pause()
        last = self.until('metin')
        self.assertEqual((last['metin'], last['komut'], last['son']), ('sunum provası', 'kaydet', True))
        self.assertEqual(self.asked, ['cuma', 'prova'])
        self.assertIsNone(self.recorder.stream, 'saved: the microphone goes')

    def test_commands_changed_in_the_settings_count_from_the_next_sentence(self):
        self.serve()
        state = Path(self.tmp.name) / 'state'
        ses.save_config(state, dict(ses.load_config(state), komutlar=dict(ses.DEFAULTS['komutlar'], kaydet=['yolla'])))
        self.send('ayar')  # the listener saw the settings file change
        self.written.update({'not': 'Market listesi, yolla.'})
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.recorder.speak('not')
        self.pause()
        last = self.until('metin')
        self.assertEqual((last['metin'], last['komut'], last['son']), ('Market listesi', 'kaydet', True))

    def wait_for(self, test, wait=5.0):
        deadline = time.monotonic() + wait
        while not test() and time.monotonic() < deadline:
            time.sleep(0.02)
        return test()

    def test_a_microphone_not_there_yet_at_start_is_tried_again_and_the_wake_phrase_stays_on(self):
        # Seen as "on first start it never works; switching the microphone off and on fixes it":
        # a headset not ready as Windows signs in switched the wake phrase off for good.
        self.wake.fail = 2
        self.serve(uyandirma=True)
        self.assertTrue(self.wait_for(lambda: self.wake.starts == 1))
        self.assertTrue(self.wait_for(lambda: len(self.refreshed) == 1), 'the device list made anew')
        self.assertIn('mikrofon açılamadı', self.logged[0])
        self.assertFalse(self.wake.running)
        self.pause(5)  # the first wait
        self.assertTrue(self.wait_for(lambda: self.wake.starts == 2))
        time.sleep(0.2)
        self.assertEqual(self.wake.starts, 2, 'then a longer wait')
        self.pause(10)
        self.assertTrue(self.wait_for(lambda: self.wake.running), 'listening again, never switched off')
        self.assertTrue(self.wait_for(lambda: 'mikrofon yeniden açıldı' in self.logged[-1]))
        self.assertEqual([e for e in self.quiet(0.2) if e['olay'] == 'hata'], [], 'nobody is bothered with it')

    def test_a_wake_microphone_gone_quiet_is_opened_again(self):
        self.serve(uyandirma=True)
        self.assertTrue(self.wait_for(lambda: self.wake.running))
        self.wake.stall = True
        self.assertTrue(self.wait_for(lambda: not self.wake.running), 'let go')
        self.assertEqual(len(self.refreshed), 1)
        self.assertIn('mikrofondan ses gelmiyor', self.logged[-1])
        self.wake.stall = False
        self.pause(5)
        self.assertTrue(self.wait_for(lambda: self.wake.running and self.wake.starts == 2), 'and opened again')

    def test_a_microphone_windows_makes_the_default_later_is_listened_to(self):
        # Seen: "Hey Pyn" never heard after the first start until the wake phrase was switched off and
        # on; a wireless headset that became Windows' microphone after the helper opened the old one.
        mics = ['dahili']
        self.helper._inputs_now = lambda: tuple(mics)
        self.serve(uyandirma=True)
        self.assertTrue(self.wait_for(lambda: self.wake.running))
        self.pause(5)
        time.sleep(0.2)
        self.assertEqual((self.wake.starts, self.refreshed), (1, []), 'the same microphone: left as it is')
        mics[:] = ['hyperx']
        self.pause(5)
        self.assertTrue(self.wait_for(lambda: self.wake.starts == 2 and self.wake.running), 'opened again')
        self.assertEqual(len(self.refreshed), 1, 'on the device list made anew')
        self.assertIn('mikrofonu değişti', self.logged[-1])
        self.pause(5)
        time.sleep(0.2)
        self.assertEqual(self.wake.starts, 2)

    def test_a_recording_lists_the_devices_anew_when_the_microphones_changed(self):
        mics = ['dahili']
        self.helper._inputs_now = lambda: tuple(mics)
        self.serve()
        mics[:] = ['hyperx']
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.assertEqual(len(self.refreshed), 1)
        level = self.until('seviye')
        self.assertIn('konusma', level)

    def test_the_level_is_on_a_scale_a_quiet_headset_moves(self):
        self.assertEqual(self.helper.loudness(0.0), 0.0)
        self.assertEqual(self.helper.loudness(1.0), 1.0)
        self.assertGreater(self.helper.loudness(0.01), 0.25, 'speech from a headset with little gain shows')
        self.assertLess(self.helper.loudness(0.0015), 0.05, 'a room\'s faint noise barely does')

    def test_a_recording_whose_microphone_fails_lists_the_devices_anew_and_tries_once_more(self):
        self.serve()
        tries = []
        real = self.recorder.start

        def start(*args, **kwargs):
            tries.append(1)
            if len(tries) == 1:
                raise OSError('Error opening InputStream: Invalid device')
            return real(*args, **kwargs)
        self.recorder.start = start
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.assertEqual((len(tries), len(self.refreshed)), (2, 1))

    def test_a_wake_phrase_changed_in_the_settings_is_listened_for_at_once(self):
        built = []
        self.helper.Wake = lambda _state, config: built.append(config['uyandirma_sozu']) or self.wake
        self.serve(uyandirma=True)
        deadline = time.monotonic() + 5
        while not built and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(built, ['pyn not al'])
        state = Path(self.tmp.name) / 'state'
        ses.save_config(state, dict(ses.load_config(state), uyandirma=True, uyandirma_sozu='hey pyn'))
        self.send('uyandirma', acik=True)
        self.send('ayar')  # the listener saw the settings file change
        deadline = time.monotonic() + 5
        while len(built) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(built, ['pyn not al', 'hey pyn'], 'the small model listens for the new phrase')

    def test_bitir_writes_the_last_sentence_after_the_ones_before_it(self):
        self.serve()
        self.written.update({'bir': 'Birinci', 'iki': 'ikinci'})
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.hold.clear()
        self.recorder.speak('bir')
        self.pause()
        self.until_asked('bir')
        self.recorder.speak('iki')
        self.send('bitir')  # Enter
        self.until('ceviriyor')
        self.hold.set()
        events = [e for e in self.quiet(1.0) if e['olay'] == 'metin']
        self.assertEqual([(e['metin'], e['son']) for e in events], [('Birinci', False), ('ikinci', True)])

    def test_a_dictation_nobody_speaks_into_ends_by_itself(self):
        self.serve()
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.pause(10)
        self.assertEqual([e for e in self.quiet() if e['olay'] == 'metin'], [], 'ten seconds of quiet is a pause')
        self.pause(15)
        last = self.until('metin')
        self.assertEqual((last['metin'], last['son']), ('', True))
        self.assertIsNone(self.recorder.stream)

    def test_a_heard_not_al_whisper_confirms_opens_listening_and_the_phrase_is_not_written(self):
        self.serve(uyandirma=True)
        self.written.update({'once': 'Payn, not al.', 'once+al': 'Payn, not al.', 'al+yarin': 'Al. Yarın toplantı var.'})
        self.wake.verdicts = ['aday']
        self.until_recording()
        self.recorder.speak('al')  # the end of "al" the recording caught
        nothing = self.quiet()
        self.assertFalse([e for e in nothing if e['olay'] in ('dinliyor', 'uyandi')], 'nobody is told before Whisper says so')
        self.assertEqual(self.recorder.stream, 'open', 'but the recording has begun: no word after the phrase is lost')
        self.pause(ses.WAKE_AFTER_SN)
        self.assertEqual(self.until('uyandi')['mikrofon'], 'Mikrofon', 'the window it opens says which microphone')
        self.assertEqual(self.asked[0], 'once+al', 'Whisper heard the seconds before it and the phrase\'s end')
        self.recorder.speak('yarin')
        self.pause()
        first = self.until('metin')
        self.assertEqual((first['metin'], first['son']), ('Yarın toplantı var.', False))

    def test_a_heard_not_al_whisper_does_not_confirm_says_nothing_and_listens_for_the_phrase_again(self):
        self.serve(uyandirma=True)
        self.written.update({'once': 'Bunu not al.'})
        self.wake.verdicts = ['aday']
        self.until_recording()
        self.pause(ses.WAKE_AFTER_SN)
        self.until_asked('once')
        said = self.quiet(0.6)
        self.assertFalse([e for e in said if e['olay'] in ('dinliyor', 'uyandi', 'metin')], said)
        self.assertIsNone(self.recorder.stream, 'the recording let go')
        self.assertTrue(self.wake.running and self.wake.starts >= 2, 'listening for the phrase again')

    def test_the_whole_phrase_the_small_model_heard_is_checked_by_whisper_too(self):
        # Seen during a game: talk the small model took for "pay not al" opened the window over it.
        self.serve(uyandirma=True)
        self.written.update({'once': 'CS, CS. Ne oldu?'})
        self.wake.verdicts = ['soz']
        self.until_recording()
        self.pause(ses.WAKE_AFTER_SN)
        self.until_asked('once')
        said = self.quiet(0.6)
        self.assertFalse([e for e in said if e['olay'] in ('dinliyor', 'uyandi')], 'Whisper did not hear it: no window')
        self.written.update({'once': 'Pyn, not al.'})
        self.wake.verdicts = ['soz']
        self.until_recording()
        self.pause(ses.WAKE_AFTER_SN)
        self.assertEqual(self.until('uyandi')['mikrofon'], 'Mikrofon', 'heard by Whisper: the window opens')

    def test_asked_to_listen_while_a_not_al_is_being_checked_it_listens(self):
        self.serve(uyandirma=True)
        self.wake.verdicts = ['aday']
        self.until_recording()
        self.send('dinle', surekli=True)
        self.until('dinliyor')
        self.assertEqual(self.recorder.starts, 1, 'the same recording')
        self.pause(ses.WAKE_AFTER_SN)
        self.assertFalse([e for e in self.quiet() if e['olay'] == 'uyandi'])


class RecorderTest(unittest.TestCase):
    """The helper's microphone on real sample arrays (numpy, which the engine's own Python may lack)."""

    def setUp(self):
        try:
            import numpy
        except ImportError:
            self.skipTest('numpy yok')
        self.np = numpy
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-kayit-')
        self.addCleanup(self.tmp.cleanup)
        spec = importlib.util.spec_from_file_location('isci_kayit_testi', ses.write_worker(Path(self.tmp.name) / 'state'))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.ses = ses
        self.clock = types.SimpleNamespace(t=0.0)
        self.helper.now = lambda: self.clock.t
        self.streams = []
        test = self

        class Stream:
            def __init__(self, callback=None, **_settings):
                self.callback, self.open = callback, False
                test.streams.append(self)

            def start(self):
                self.open = True

            def stop(self):
                self.open = False

            def close(self):
                pass

        fake = types.SimpleNamespace(InputStream=Stream, query_devices=lambda *_a: [], default=types.SimpleNamespace(device=[0]))
        patcher = mock.patch.dict(sys.modules, {'sounddevice': fake})
        patcher.start()
        self.addCleanup(patcher.stop)

    def feed(self, seconds, loud):
        """Ten-millisecond blocks into the stream, as the sound card gives them."""
        stream = self.streams[-1]
        for _ in range(int(round(seconds * 100))):
            block = self.np.full((160, 1), 0.1 if loud else 0.0005, dtype='float32')
            if loud:
                block[::2] *= -1
            stream.callback(block, 160, None, None)
            self.clock.t += 0.01

    def test_a_cut_takes_the_sentence_trimmed_to_its_speech_and_the_stream_goes_on(self):
        recorder = self.helper.Recorder(dict(ses.DEFAULTS))
        recorder.start()
        self.feed(1.0, False)
        self.feed(1.0, True)
        self.feed(1.5, False)
        self.assertTrue(recorder.spoke)
        self.assertAlmostEqual(self.clock.t - recorder.last_voice, 1.5, places=1)
        sentence = recorder.cut()
        self.assertAlmostEqual(len(sentence) / 16000, 0.3 + 1.0 + 0.4, places=1, msg='the speech, a little either side')
        self.assertTrue(self.streams[-1].open, 'the microphone stays open')
        self.assertFalse(recorder.spoke, 'the next sentence begins unsaid')
        self.feed(0.5, True)
        self.feed(0.2, False)
        last = recorder.stop()
        self.assertTrue(recorder.spoke)
        self.assertFalse(self.streams[-1].open)
        self.assertAlmostEqual(len(last) / 16000, 0.5 + 0.2, places=1, msg='what was said since the cut, no sound lost between')

    def test_the_wake_listener_keeps_the_last_seconds_and_says_a_candidate_with_what_it_heard(self):
        heard = {'partial': '[unk]'}

        class Recognizer:
            def __init__(self, _model, _rate, grammar):
                self.grammar = json.loads(grammar)

            def Reset(self):
                pass

            def AcceptWaveform(self, _pcm):
                return False

            def PartialResult(self):
                return json.dumps(heard)

        vosk = types.SimpleNamespace(KaldiRecognizer=Recognizer, Model=lambda _path: None, SetLogLevel=lambda _level: None)
        with mock.patch.dict(sys.modules, {'vosk': vosk}):
            wake = self.helper.Wake(Path(self.tmp.name) / 'state', dict(ses.DEFAULTS))
        self.assertIn('not al', wake.recognizer.grammar)
        wake.start()
        self.feed(6.0, False)  # six seconds of the room
        seen = []
        self.assertIsNone(wake.heard(seen.append))
        self.assertEqual(seen, ['[unk]'], 'what it heard, each new thing once')
        heard['partial'] = '[unk] not al'
        self.feed(0.02, True)
        self.assertEqual(wake.heard(seen.append), 'aday')
        self.assertEqual(wake.text, '[unk] not al')
        self.feed(0.5, True)  # the rest of the phrase, waiting in the queue
        clip = wake.clip()
        self.assertLessEqual(len(clip) / 16000, ses.WAKE_CLIP_SN + 0.02, 'only the last few seconds')
        self.assertGreater(float(abs(clip[-800:]).max()), 0.05, 'what still waited is its end')
        wake.stop()
        self.assertFalse(wake.running)

    def test_a_click_is_not_speech_and_nothing_said_is_kept_whole(self):
        recorder = self.helper.Recorder(dict(ses.DEFAULTS))
        recorder.start()
        self.feed(0.5, False)
        self.feed(0.02, True)  # two loud blocks: a click
        self.feed(0.5, False)
        self.assertFalse(recorder.spoke)
        self.assertAlmostEqual(len(recorder.stop()) / 16000, 1.02, places=1)


class HelperModuleTest(unittest.TestCase):
    def test_the_helper_is_written_into_the_voice_folder_and_loads_its_packages_only_when_it_runs(self):
        with tempfile.TemporaryDirectory(prefix='v3-ses-kaynak-') as tmp:
            state = Path(tmp) / 'state'
            path = ses.write_worker(state)
            self.assertEqual(path, ses.ses_dir(state) / 'isci.py', 'beside its environment, outside the vault and the engine')
            self.assertEqual(path.read_text(encoding='utf-8'), ses.WORKER_SOURCE)
            stamp = path.stat().st_mtime_ns
            ses.write_worker(state)
            self.assertEqual(path.stat().st_mtime_ns, stamp, 'written again only when it changed')
            command = ses.worker_command(state, '--indir')
            self.assertEqual(command[2:4], [str(path), '--scripts'])
            # Imported by the engine's own Python (no faster-whisper, no vosk), it must not fail.
            done = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import isci', str(path.parent)],
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()
