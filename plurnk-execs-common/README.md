# @plurnk/plurnk-execs-common

The **universal subprocess executor** for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme: one package covering the shell + node + python floor *and* whichever host interpreters (`perl`/`ruby`/`php`/`lua`/`awk`/`bc`/…) are present. Install it once and the model gets every subprocess runtime the host can serve — `node` always, the rest detected.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework. **Supersedes the former `-sh`, `-node`, `-python` packages** (folded in here).

## How it works

The manifest claims the subprocess runtime tags. The framework's `probe()` (per-tag) lights up `node` unconditionally (the daemon *is* node) and detects the rest via a cheap `command -v`, so the consumer offers the model exactly the platform's runtimes. No per-language packages — one executor adapts to the host.

| Tag | Binary | Command via |
|---|---|---|
| `sh` 🐚 / `bash` 🐚 | sh / bash | `-c <command>` |
| `node` ⬢ | node | `-e <command>` (always available) |
| `python` / `python3` 🐍 | python3 | `-c <command>` |
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
