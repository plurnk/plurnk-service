# @plurnk/plurnk-execs-common

A **detection harness** for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme: one package that exposes whichever common interpreters/REPLs exist on the host. Install it once and the model gets `perl`/`ruby`/`php`/`lua`/`awk`/`bc`/… — but only the ones actually present.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## How it works

The manifest claims a candidate set of common-REPL tags. The framework's `probe()` (per-tag, cheap `command -v`) lights up only the interpreters on PATH, so the consumer offers the model exactly the platform's runtimes. No per-language packages to install — one harness adapts to the host.

| Tag | Binary | Command via |
|---|---|---|
| `perl` 🐪 / `ruby` 💎 / `lua` 🌙 | perl / ruby / lua | `-e <command>` |
| `php` 🐘 | php | `-r <command>` |
| `deno` 🦕 | deno | `eval <command>` |
| `bun` 🥟 | bun | `-e <command>` |
| `tcl` 🪶 | tclsh | stdin |
| `bc` 🧮 | bc | stdin (e.g. `6 * 7`) |
| `awk` 🪄 | awk | program arg, empty stdin (`BEGIN { … }`) |

All run arbitrary code → `effect: host` → **proposal-gated** (not auto-run). For the snappy auto-run tier, see the pure in-process evaluators (`calc`/`jq`/`wasm`, planned). Input-processing transforms (`sed`, input-driven `awk`) await the EXEC input-channel and aren't claimed here.

## Configuration

`.env.example` documents per-tag kill-switches: `PLURNK_EXECS_<TAG>=0` disables a tag even when installed (drops it from the available list with a "disabled" 501 reason).

## Tests

`test:lint`, `test:unit`. Live-eval tests auto-skip where the interpreter is absent.
