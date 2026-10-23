"""Command text Cortex writes for other programs to run: hooks, launchers, Pyn's status line and profile.

One spelling for every place that writes one (security-5). A value goes into PowerShell as a
single-quoted literal, and PowerShell ends such a literal at the typographic quotes U+2018..U+201B
as well as at the ASCII one, so each of them is doubled (as yakala's `_ps_quote` already did). Eight
copies doubled only the ASCII quote, and a vault named on an iPhone - "Ayşe’nin Kasası", with iOS's
curly apostrophe - broke every hook, the update launcher and Pyn's status line while setup said done.

A hook command never ends with exit code 2 (C3). Claude Code, Codex and Qwen read 2 from a hook as
"block": a prompt is refused and erased, a Stop keeps the agent running. Python itself exits 2 when
the script it is given is not there - a vault moved or renamed - and argparse does for a bad
argument, so every such failure blocked the client. Decisions travel as JSON (`decision: block`),
never as an exit code, so 2 becomes 1: the failure shows, and blocks nothing. In PowerShell a Python
that is gone leaves no exit code at all ($null), which used to end as 0 and hid it; that is 1 too.

Standard library only. The installer loads this file by its path; the engine imports it.
"""
import re
import shlex

QUOTES = "'‘’‚‛"
_QUOTE = re.compile('([' + QUOTES + '])')
_DOUBLED = re.compile('([' + QUOTES + '])\\1')
# Text after the call in a hook's PowerShell script. No quote in it: the readers of installed hooks
# (`literals`, beyin.py doctor and hook-reconcile) take every quoted string for an argument.
EXIT_NOT_TWO = '; $c = $LASTEXITCODE; if ($null -eq $c -or $c -eq 2) { $c = 1 }; exit $c'
# The same rule for a POSIX shell, run by /bin/sh whether the client hands the command to a shell
# or splits it into arguments itself.
POSIX_NOT_TWO = ' || { s=$?; [ "$s" -eq 2 ] && s=1; exit "$s"; }'
POSIX_SHELL = '/bin/sh'


def literal(value):
    """One PowerShell single-quoted literal holding `value` exactly."""
    return "'" + _QUOTE.sub(r'\1\1', str(value)) + "'"


def call(argv):
    """`& 'program' 'argument' ...`: the call operator on literals, nothing evaluated."""
    return '& ' + ' '.join(literal(value) for value in argv)


def hook_script(argv):
    """A hook's PowerShell script: the call, then its exit code with 2 (and none) made 1."""
    return call(argv) + EXIT_NOT_TWO


def posix_hook(argv):
    """A hook's POSIX command: the call, then its exit code with 2 made 1, inside /bin/sh -c."""
    return shlex.join([POSIX_SHELL, '-c', shlex.join([str(value) for value in argv]) + POSIX_NOT_TWO])


def literals(script):
    """The values of the single-quoted literals in PowerShell text, as `literal` wrote them."""
    return [_DOUBLED.sub(r'\1', item) for item in re.findall(r"'((?:[^']|'')*)'", script)]


def posix_arguments(command):
    """The arguments of a POSIX command, the /bin/sh -c wrapper of `posix_hook` taken off; [] when unreadable."""
    try:
        parts = shlex.split(command)
        if len(parts) == 3 and parts[0] == POSIX_SHELL and parts[1] == '-c':
            parts = shlex.split(parts[2])
    except ValueError:
        return []
    return parts
