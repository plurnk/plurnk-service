# @plurnk/plurnk-execs-common

The **universal subprocess executor** for
[plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. One
package offers the shell, Node.js, and Python 3 by default, with other supported
host interpreters available as opt-ins. Node is guaranteed; the rest are detected.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework.

## How it works

The manifest claims the subprocess tags. Per-tag `probe()` reports Node
unconditionally because the daemon already runs on it. A cheap `command -v`
detects every other interpreter, so one executor adapts to the host.

| Tag                              | Binary            | Inline body via                          |
| -------------------------------- | ----------------- | ---------------------------------------- |
| `sh` 🐚                          | sh                | `-c <body>`                              |
| `node` ⬢                         | node              | `-e <body>` (always available)           |
| `python3` 🐍                     | python3           | `-c <body>`                              |
| `perl` 🐪 / `ruby` 💎 / `lua` 🌙 | perl / ruby / lua | `-e <body>`                              |
| `deno` 🦕                        | deno              | `eval <body>`                            |
| `bun` 🥟                         | bun               | `-e <body>`                              |
| `tcl` 🪶                         | tclsh             | stdin                                    |
| `bc` 🧮                          | bc                | stdin (for example, `6 * 7`)             |
| `awk` 🪄                         | awk               | program arg, empty stdin (`BEGIN { … }`) |

Each enabled runtime's catalog Summary includes a short executable inline body, with
literal `\n` separators keeping the invocation on one discovery line.

### A script — the `(target)` slot

The table above is the **inline** form: the body is the program. A file in the
`(target)` slot is instead the script each interpreter reads directly, and the
body becomes that script's stdin. A `[{"cwd": "<directory>"}]` block on the heading
selects the working directory. Script arguments use `[{"args": ["arg",...]}]`;
each string is passed literally, without shell expansion ({§executor-metadata}).
These options work for local, Worker, and Skill script targets alike.

```sh (./deploy.sh)
yes
yes
no
```

```python3 (transform.py) [{"args": ["--format","json"]}]
3
1
4
1
5
```

The first operation answers a shell script's prompts through stdin. The second
feeds records to a Python script.

All declared tags run host code, so every invocation is proposal-gated. The
current installed in-process evaluators are jq and SQLite; their
`pure` or `read` invocations bypass the proposal gate but still return through
the same next-turn stream path ({§executor-effect}). Inline programs have no
separate input channel; script targets receive stdin from the body.

## Configuration

The shipped [`.env.defaults`](./.env.defaults) disables `perl`, `ruby`, `lua`,
`deno`, `bun`, `tcl`, `bc`, and `awk`. To expose one, set its switch to `1`
in the ordinary environment cascade and restart the service; commented opt-ins
are in [`.env.example`](./.env.example). For example, `PLURNK_EXECS_PERL=1`
enables the Perl executor when Perl is installed. These switches do not prevent
calling an interpreter through `sh`.

Per-tag kill-switches (`PLURNK_EXECS_<TAG>=0`) and the
`PLURNK_EXECS_ONLY` allowlist are honored by framework discovery, uniformly
across every plugin ({§executor-policy}). A disabled tag is not registered and
never reaches this executor.

## Tests

`test:lint`, `test:unit`. Live-eval tests auto-skip where the interpreter is absent.
