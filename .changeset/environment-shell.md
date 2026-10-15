---
"@plurnk/plurnk-execs": major
"@plurnk/plurnk-execs-common": major
---

`sh` runs the environment's shell: `$SHELL` when it is an absolute path to an
executable file, else `/bin/sh` ({§executor-shell}). One resolution per daemon
process serves both the spawn and the summary, which names the program, the
version its `--version` reports when it reports one, and the path; with bash
it reads `Run shell commands and scripts with bash 5.2.37 (/bin/bash).` The
POSIX promise is gone, and a script target runs under the same shell. `Shell`
is exported from `@plurnk/plurnk-execs`, and `@plurnk/plurnk-execs-common`
declares its runtimes through `plurnk.runtimesModule` (`./runtimes`).
