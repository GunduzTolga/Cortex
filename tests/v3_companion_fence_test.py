"""Fenced Markdown examples in companion notes are examples, not live headings or rules.

A sample `## Closed Threads` inside a code block cut the live open threads short; a suffixed
run (```not-a-close) inside a fence was taken as its closer, so the real closer opened a new
fence and the rules after it disappeared from the opening.
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = str(ROOT / 'template/.claude/scripts')
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
import beyin_v3_companion as companion

CASES = (('```markdown', '```not-a-close', '```'), ('~~~markdown', '~~~ not-a-close', '~~~'),
         ('````markdown', '```', '`````'), ('```markdown', '~~~', '```'),
         ('   ```markdown', '   ``` not-a-close', '   ``` \t'))


class ThreadsExcerptFenceTest(unittest.TestCase):
    def test_fenced_closed_heading_does_not_cut_open_threads(self):
        for newline in ('\n', '\r\n'):
            for opener, false_close, closer in CASES:
                with self.subTest(newline=newline, opener=opener, false_close=false_close):
                    text = newline.join(('# Threads', '## Active Threads', '### Current', opener, false_close,
                                         '## Closed Threads', '### Example', closer, '### LIVE_LATER',
                                         '## Closed Threads', '### OLD_CLOSED', ''))
                    excerpt = companion.excerpt('Threads.md', text)
                    self.assertTrue(excerpt.startswith('## Active Threads'), excerpt)
                    self.assertIn('### LIVE_LATER', excerpt)
                    self.assertNotIn('OLD_CLOSED', excerpt)

    def test_fenced_active_heading_is_not_the_live_section(self):
        text = '# Threads\n```md\n## Active Threads\n### EXAMPLE_ONLY\n```\n## Active Threads\n### Real\n'
        excerpt = companion.excerpt('Threads.md', text)
        self.assertEqual(excerpt, '## Active Threads\n### Real\n')

    def test_unclosed_example_keeps_the_rest_of_the_section(self):
        text = '## Active Threads\n### Current\n```md\n## Closed Threads\n### STILL_EXAMPLE\n'
        self.assertEqual(companion.excerpt('Threads.md', text), text)

    def test_unfenced_closed_heading_still_ends_the_section(self):
        text = '## Active Threads\n### Open\n```inline```\n## Closed Threads\n### OLD_CLOSED\n'
        self.assertEqual(companion.excerpt('Threads.md', text), '## Active Threads\n### Open\n```inline```\n')


class RuleStartsFenceTest(unittest.TestCase):
    def test_a_suffixed_run_does_not_close_the_fence(self):
        for opener, false_close, closer in CASES:
            with self.subTest(opener=opener, false_close=false_close):
                text = '\n'.join(('- one', opener, false_close, '- example', closer, '- two', ''))
                starts = companion.rule_starts(text)
                self.assertEqual([text[start:].split('\n', 1)[0] for start in starts], ['- one', '- two'])

    def test_an_inline_backtick_run_does_not_open_a_fence(self):
        text = '- one\n```inline```\n- two\n'
        self.assertEqual(len(companion.rule_starts(text)), 2)


if __name__ == '__main__':
    unittest.main()
