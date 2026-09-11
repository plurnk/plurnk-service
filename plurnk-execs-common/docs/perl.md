# perl

For continuing input, launch with `[{"stdin": "open"}]`, then SEND exact text to the
returned execution address; `[{"eof": true}]` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is Perl code, run with `perl -e`. A script target runs that file and
receives the body as stdin; `[{"args": [...]}]` passes literal script arguments.

````perl <!-- the body is the program -->
use strict; use warnings;
my %count; $count{$_}++ for qw(a b a c a);
printf "%s=%d\n", $_, $count{$_} for sort keys %count;
````

````perl (tools/rename.pl) [{"args": ["--dry-run"]}]
````

stdout streams to `#stdout`, stderr to `#stderr`; `die` or a nonzero `exit`
closes with status 500. The environment is scoped exactly as for `sh`
(plurnk's own settings and provider keys are stripped). Use `-n`/`-p`-style
one-liners by writing the loop yourself, or run a script target over the
files you name in `{args}`.
