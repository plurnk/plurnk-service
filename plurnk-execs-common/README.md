# @plurnk/plurnk-execs-common

The **subprocess executor** for
[plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. One
package offers the shell, Node.js, and Python 3. Node is guaranteed; the rest
are detected.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework.

## How it works

The manifest claims the subprocess tags. Per-tag `probe()` reports Node
unconditionally because the daemon already runs on it. A cheap `command -v`
detects `sh` and `python3`, so one executor adapts to the host.

| Tag          | Binary  | Inline body via                |
| ------------ | ------- | ------------------------------ |
| `sh` 🐚      | sh      | `-c <body>`                    |
| `js` ⬢       | node    | `-e <body>` (always available) |
| `python3` 🐍 | python3 | `-c <body>`                    |

Each enabled runtime's catalog Summary includes a short executable inline body, with
literal `\n` separators keeping the invocation on one discovery line.

### The `(target)` slot — a script or working directory

The table above is the **inline** form: the body is the program. A directory in
the `(target)` slot selects the working directory for that inline program. A
file in the `(target)` slot is instead the script each interpreter reads
directly, and the body is tokenized by shell quoting (`tokenizeArgv`) into the
script's arguments ({§executor-subprocess-routing}, {§executor-argv-tokenizer}).

```sh (./deploy.sh)
--release "two words"
```

```python3 (transform.py)
--format json
```

All declared tags run host code, so every invocation is proposal-gated ({§executor-effect}). Inline programs have no
separate input channel; script targets receive their arguments from the body.

## Configuration

Per-tag kill-switches (`PLURNK_EXECS_<TAG>=0`) and the
`PLURNK_EXECS_ONLY` allowlist are honored by framework discovery, uniformly
across every extension ({§executor-policy}). A disabled tag is not registered and
never reaches this executor.

## Tests

`test:lint`, `test:unit`. Live-eval tests auto-skip where the interpreter is absent.
