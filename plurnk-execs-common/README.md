# @plurnk/plurnk-execs-common

The **universal subprocess executor** for
[plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. One
package covers the shell, Node, Python, and whichever supported host
interpreters are present. Node is guaranteed; the rest are detected.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework. **Supersedes the former `-sh`, `-node`, `-python` packages** (folded in here).

## How it works

The manifest claims the subprocess tags. Per-tag `probe()` reports Node
unconditionally because the daemon already runs on it. A cheap `command -v`
detects every other interpreter, so one executor adapts to the host.

| Tag                              | Binary            | Command via                              |
| -------------------------------- | ----------------- | ---------------------------------------- |
| `sh` 🐚 / `bash` 🐚              | sh / bash         | `-c <command>`                           |
| `node` ⬢                         | node              | `-e <command>` (always available)        |
| `python` / `python3` 🐍          | python3           | `-c <command>`                           |
| `perl` 🐪 / `ruby` 💎 / `lua` 🌙 | perl / ruby / lua | `-e <command>`                           |
| `php` 🐘                         | php               | `-r <command>`                           |
| `deno` 🦕                        | deno              | `eval <command>`                         |
| `bun` 🥟                         | bun               | `-e <command>`                           |
| `tcl` 🪶                         | tclsh             | stdin                                    |
| `bc` 🧮                          | bc                | stdin (for example, `6 * 7`)             |
| `awk` 🪄                         | awk               | program arg, empty stdin (`BEGIN { … }`) |

### A program with stdin — the `(target)` slot

The table above is the **inline** form: `command` is the program. Put a program
in the **`(target)` slot** instead and `command` becomes its **stdin**—a shell
runs `sh -c "<target>"` (the shell tokenizes it), while another interpreter
runs `<interpreter> <target>` as a script file ({§executor-subprocess-routing}).

```plurnk
<<EXEC[sh](./deploy.sh --prod):yes\nyes\nno:EXEC
<<EXEC[python](transform.py):3\n1\n4\n1\n5:EXEC
```

The first operation answers a shell script's prompts through stdin. The second
feeds records to a Python script.

All declared tags run host code, so every invocation is proposal-gated. The
current installed in-process evaluators are jq, SQLite, and WebAssembly; their
`pure` or `read` invocations bypass the proposal gate but still return through
the same next-turn stream path ({§executor-effect}). Input-processing
transforms (`sed`, input-driven `awk`) await an EXEC input-channel contract and
are not claimed here.

## Configuration

Per-tag kill-switches (`PLURNK_EXECS_<TAG>=0`) and the
`PLURNK_EXECS_ONLY` allowlist are honored by framework discovery, uniformly
across every plugin ({§executor-policy}). A disabled tag is not registered and
never reaches this executor.

## Tests

`test:lint`, `test:unit`. Live-eval tests auto-skip where the interpreter is absent.
