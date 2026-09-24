# perl

The body is Perl code, run with `perl -e`; `-n`/`-p` have no equivalent here,
so a line loop is written in the body. A script target runs that file and
receives the body as stdin; `[{"args": [...]}]` passes literal arguments.
Environment, channels and exit status are the executor family's (`sh.md`):
`die` or a nonzero `exit` closes with status 500.

````perl <!-- the body is the program -->
use strict; use warnings;
my %count; $count{$_}++ for qw(a b a c a);
printf "%s=%d\n", $_, $count{$_} for sort keys %count;
````

````perl (tools/rename.pl) [{"args": ["--dry-run"]}]
````

Live input (`[{"stdin": "open"}]`, SEND, `[{"eof": true}]`) is as `node.md`
shows.
