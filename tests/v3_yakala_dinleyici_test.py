"""Yakala's resident Windows listener (listen_windows), run on any system against a stand-in Win32
and a stand-in Tk on a virtual clock: its loop survives an error, it stays without its key and
takes it when it is freed, it leaves when another vault owns the key, it looks less often when idle,
and a window fading out is not the one the next press goes to.

The hotkey thread is real; it is only ever waited on through a message it has taken, never slept on.
"""
import ctypes
import heapq
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_yakala as yakala  # noqa: E402

WM_QUIT, WM_TIMER, WM_HOTKEY, SENTINEL = 0x0012, 0x0113, 0x0312, 0x0400


class Fn:
    """A DLL function: callable, and it takes the argtypes and restype the code sets on it."""

    def __init__(self, call):
        self.call = call

    def __call__(self, *args):
        return self.call(*args)


class Dll:
    def __init__(self, functions):
        self.functions = {name: Fn(call) for name, call in functions.items()}

    def __getattr__(self, name):
        if name.startswith('__') or name not in self.functions:
            raise AttributeError(name)
        return self.functions[name]


class Win32:
    """user32 and kernel32 as the listener uses them: named events, one mutex, a key another app
    may hold, the hotkey thread's message queue and the clipboard's sequence number."""

    def __init__(self, key_free=True):
        self.key_free, self.sequence, self.last_error = key_free, 41, 0
        self.messages, self.taken = queue.Queue(), threading.Event()
        self.events, self.handles, self.timer, self.killed, self.registered = {}, {}, None, None, 0
        self.user32 = Dll({
            'PeekMessageW': lambda *_a: 0,
            'RegisterHotKey': self.register,
            'UnregisterHotKey': lambda *_a: 1,
            'GetMessageW': self.get_message,
            'PostThreadMessageW': lambda _tid, message, *_a: self.messages.put(message) or 1,
            'SetTimer': self.set_timer,
            'KillTimer': lambda _hwnd, timer: setattr(self, 'killed', timer) or 1,
            'GetClipboardSequenceNumber': lambda: self.sequence,
        })
        self.kernel32 = Dll({
            'CreateMutexW': self.create_mutex,
            'CreateEventW': self.create_event,
            'ResetEvent': lambda handle: self.handles[handle].update(on=False) or 1,
            'WaitForSingleObject': self.wait,
            'CloseHandle': lambda _handle: 1,
            'GetCurrentThreadId': lambda: 4242,
        })

    def dll(self, name, **_options):
        return self.user32 if name == 'user32' else self.kernel32

    def register(self, *_args):
        self.registered += 1
        return int(self.key_free)

    def set_timer(self, _hwnd, _id, every, _call):
        self.timer = every
        return 7

    def get_message(self, reference, *_args):
        message = self.messages.get()
        if message == WM_QUIT:
            return 0
        reference._obj.message = message
        if message == SENTINEL:
            self.taken.set()
        return 1

    def through_the_hotkey_thread(self, *messages):
        """Post messages to the hotkey thread and return once it has handled every one of them."""
        self.taken.clear()
        for message in messages + (SENTINEL,):
            self.messages.put(message)
        assert self.taken.wait(10), 'the hotkey thread took its messages'

    def create_mutex(self, _attributes, _owner, name):
        self.last_error = 183 if ('mutex', name) in self.events else 0
        self.events[('mutex', name)] = True
        return 1

    def create_event(self, _attributes, manual, initial, name):
        handle = len(self.handles) + 10
        self.handles[handle] = {'manual': bool(manual), 'on': bool(initial), 'name': name}
        return handle

    def signal(self, name):
        for event in self.handles.values():
            if event['name'] == name:
                event['on'] = True

    def wait(self, handle, _timeout):
        event = self.handles.get(handle)
        if event and event['on']:
            if not event['manual']:
                event['on'] = False  # auto-reset: one window a request
            return 0
        return 258


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Window:
    def __init__(self, master):
        self.alive, self.closing, self.toggled, self.events = True, False, 0, []
        self.name = '.!toplevel%d' % (len(master.children) + 1)
        master.children.append(self)

    def __str__(self):
        return self.name

    def winfo_exists(self):
        return self.alive

    def destroy(self):
        self.alive = False

    def lift(self):
        pass

    def focus_force(self):
        pass

    def voice_toggle(self):
        self.toggled += 1


class Tk:
    """A Tk root whose `after` runs on the virtual clock; `script` holds (moment, action) pairs run
    when the clock reaches them. Records each delay the listener asked for."""

    made = []

    def __init__(self, clock, script, until):
        self.clock, self.script, self.until = clock, sorted(script, key=lambda item: item[0]), until
        self.timers, self.alive, self.children, self.delays, self.order = [], True, [], [], 0
        Tk.made.append(self)

    def withdraw(self):
        pass

    def after(self, delay, call, *args):
        if not self.alive:
            raise RuntimeError('destroyed')
        self.order += 1
        self.delays.append((self.clock.now, delay))
        heapq.heappush(self.timers, (self.clock.now + delay / 1000, self.order, call, args))

    def destroy(self):
        self.alive = False

    def winfo_children(self):
        return [child for child in self.children if child.alive]

    def mainloop(self):
        while self.alive and self.timers and self.clock.now < self.until:
            at, _order, call, args = heapq.heappop(self.timers)
            self.clock.now = max(self.clock.now, at)
            while self.script and self.script[0][0] <= self.clock.now:
                self.script.pop(0)[1]()
            call(*args)


class ListenerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-dinleyici-dongu-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.vault, self.state = root / 'Kasa', root / 'state'
        self.vault.mkdir()
        self.environment = {'LOCALAPPDATA': str(root / 'local'), 'BEYIN_SES_DIR': str(root / 'ses')}
        self.opened, self.fail_first = [], False
        Tk.made = []

    def popup(self, _vault, context, master=None, **options):
        window = Window(master)
        self.opened.append((context, options, window))
        if self.fail_first and len(self.opened) == 1:
            # What a malformed link on the clipboard did: an error with the window half built.
            raise ValueError('Invalid IPv6 URL')
        return window

    def listen(self, win32, script=(), until=60.0, vault=None):
        """listen_windows to its end (or `until` seconds of virtual time): what it returned."""
        clock = Clock()
        fake_tk = types.ModuleType('tkinter')
        fake_tk.Tk = lambda: Tk(clock, [(clock.now + at, action) for at, action in script], clock.now + until)
        with patch.dict(os.environ, self.environment), \
                patch.dict(sys.modules, {'tkinter': fake_tk}), \
                patch.object(ctypes, 'WinDLL', win32.dll, create=True), \
                patch.object(ctypes, 'get_last_error', lambda: win32.last_error, create=True), \
                patch.object(yakala, 'popup', self.popup), \
                patch.object(yakala, 'windows_context', lambda read_url=True: {}), \
                patch.object(yakala, '_load_fonts', lambda _state: False), \
                patch('time.monotonic', clock), patch('time.sleep', lambda _seconds: None):
            code = yakala.listen_windows(vault or self.vault, self.state, spec='ctrl+alt+shift+f11',
                                         mutex_name='kilit', stop_name='dur', open_name='ac')
        self.clock = clock
        return code

    def said(self):
        return json.loads((Path(self.environment['LOCALAPPDATA']) / 'beyin-v3' / 'dinleyici.json').read_text(encoding='utf-8'))

    def own_state(self):
        return json.loads((self.state / yakala.LISTENER_STATE).read_text(encoding='utf-8'))

    def test_an_error_while_a_window_opens_is_written_down_and_the_next_press_still_opens_one(self):
        # One error in its loop (a malformed link on the clipboard) left a listener alive that never
        # looked again: no window, no stop for `kur`, a microphone nobody could let go.
        self.fail_first = True
        win32 = Win32()
        code = self.listen(win32, [(0.3, lambda: win32.signal('ac')), (1.0, lambda: win32.signal('ac')),
                                   (1.5, lambda: win32.signal('dur'))])
        self.assertEqual(code, 0)
        self.assertEqual(len(self.opened), 2, 'the second request opened a window')
        self.assertFalse(self.opened[0][2].alive, 'the half-built window was taken away')
        self.assertTrue(self.opened[1][2].alive)
        self.assertFalse(Tk.made[0].alive, 'the stop request still ended it')
        self.assertLess(self.clock.now - 1000.0, 2.0)
        log = (self.state / 'yakala' / yakala.LISTENER_LOG).read_text(encoding='utf-8')
        self.assertIn('ValueError: Invalid IPv6 URL', log)

    def test_without_its_key_it_stays_says_so_and_takes_the_key_once_it_is_free(self):
        win32 = Win32(key_free=False)
        seen = {}

        def look():
            seen['state'], seen['said'] = self.own_state(), self.said()

        def free():
            win32.key_free = True
            win32.through_the_hotkey_thread(WM_TIMER)  # the half-minute retry
        code = self.listen(win32, [(0.2, look), (0.4, lambda: win32.signal('ac')), (31.0, free),
                                   (31.2, lambda: seen.update(after=self.said())), (32.0, lambda: win32.signal('dur'))])
        self.assertEqual(code, 0)
        self.assertEqual(seen['state']['kisayol_calisiyor'], False)
        self.assertEqual(seen['said']['kisayol'], 'mesgul')
        self.assertEqual(win32.timer, yakala.KEY_RETRY_MS, 'asked again every half minute')
        self.assertEqual(len(self.opened), 1, '"Not al" opens the window without the key')
        self.assertEqual(seen['after']['kisayol'], 'tamam')
        self.assertTrue(self.own_state()['kisayol_calisiyor'])
        self.assertEqual(win32.killed, 7, 'no more retries once the key is held')

    def test_the_key_taken_later_is_said_even_where_its_own_state_cannot_be_written(self):
        # The state file held by another program (an antivirus scan, OneDrive): the desktop app
        # still heard "mesgul" for good, though the key was the listener's.
        win32 = Win32(key_free=False)
        real, seen = yakala._write_listener_state, {}

        def held(state, **values):
            if values.get('kisayol_calisiyor') is True:
                raise PermissionError('baska bir program kullaniyor')
            return real(state, **values)

        def free():
            win32.key_free = True
            win32.through_the_hotkey_thread(WM_TIMER)
        with patch.object(yakala, '_write_listener_state', held):
            code = self.listen(win32, [(31.0, free), (31.2, lambda: seen.update(after=self.said())),
                                       (32.0, lambda: win32.signal('dur'))])
        self.assertEqual(code, 0)
        self.assertEqual(seen['after']['kisayol'], 'tamam')
        self.assertIn('baska bir program kullaniyor', (self.state / 'yakala' / yakala.LISTENER_LOG).read_text(encoding='utf-8'))

    def test_it_leaves_within_two_seconds_once_the_key_is_another_vaults(self):
        win32 = Win32()
        record = yakala.owner_file

        def moved():
            with patch.dict(os.environ, self.environment):
                path = record()
                path.write_text(json.dumps({'surum': 1, 'vault': str(Path(self.tmp.name) / 'Baska'), 'state': 'x',
                                            'tus': 'ctrl+alt+c', 'at': 1}), encoding='utf-8')
        seen = {}

        def look():
            with patch.dict(os.environ, self.environment):
                seen['owner'] = yakala._owner()
        code = self.listen(win32, [(0.1, look), (5.0, moved)])
        self.assertEqual(code, 0)
        # Set up before the record existed: the running listener writes it for its own vault.
        self.assertTrue(yakala._same_vault(seen['owner']['vault'], self.vault))
        self.assertEqual(seen['owner']['tus'], 'ctrl+alt+shift+f11')
        self.assertFalse(Tk.made[0].alive)
        self.assertLessEqual(self.clock.now - 1005.0, 2.1, 'gone within about two seconds')
        # And one started for that vault again (an old Startup shortcut) does not even begin.
        Tk.made = []
        self.assertEqual(self.listen(Win32()), 0)
        self.assertEqual(Tk.made, [])

    def test_it_looks_less_often_when_idle_and_often_while_a_window_is_open(self):
        win32 = Win32()
        self.listen(win32, [(6.0, lambda: win32.signal('ac')), (12.0, lambda: win32.signal('dur'))])
        delays = Tk.made[0].delays
        idle = [delay for at, delay in delays if 1003.0 < at < 1006.0]
        busy = [delay for at, delay in delays if 1006.1 < at < 1012.0]
        self.assertTrue(idle and set(idle) == {yakala.TICK_IDLE}, idle)
        self.assertTrue(busy and set(busy) == {yakala.TICK_ACTIVE}, busy)
        self.assertEqual(yakala._tick(False, 0.0, 1.0), yakala.TICK_ACTIVE, 'just after something happened')
        self.assertEqual(yakala._tick(False, 0.0, 2.5), yakala.TICK_IDLE)
        self.assertEqual(yakala._tick(True, 0.0, 99.0), yakala.TICK_ACTIVE)

    def test_a_window_fading_out_is_not_the_one_the_next_press_goes_to(self):
        win32 = Win32()

        def saved():
            self.opened[0][2].closing = True  # Enter: the window fades for about 0.65 s
        self.listen(win32, [(0.3, lambda: win32.signal('ac')), (0.6, saved), (0.7, lambda: win32.signal('ac')),
                            (1.5, lambda: win32.signal('dur'))])
        self.assertEqual(len(self.opened), 2, 'the press opened a new window')
        self.assertEqual(self.opened[0][2].toggled, 0, 'and started no recording for the one going away')

    def test_the_window_learns_how_long_ago_the_clipboard_changed(self):
        win32 = Win32()

        def copy():
            win32.sequence = 43
        self.listen(win32, [(0.3, lambda: win32.signal('ac')), (1.0, lambda: self.opened[-1][2].destroy()), (3.0, copy),
                            (3.2, lambda: win32.signal('ac')), (3.3, lambda: self.opened[-1][2].destroy()),
                            (400.0, lambda: win32.signal('ac')), (401.0, lambda: win32.signal('dur'))], until=500)
        ages = [context['pano_yasi'] for context, _options, _window in self.opened]
        self.assertIsNone(ages[0], 'on the clipboard before the listener started: of unknown age')
        self.assertLessEqual(ages[1], 0.6)
        self.assertGreater(ages[2], yakala.CLIP_FRESH)
        self.assertEqual({context['clipboard_baseline'] for context, _o, _w in self.opened}, {41})


if __name__ == '__main__':
    unittest.main()
