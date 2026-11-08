# sh

`plurnk.sh` runs `text` with `-c` in the shell its summary names (`$SHELL`, or `/bin/sh` when unset).

await plurnk.sh({ text: "printf 'hello\\n' > hello.txt\nwc -l hello.txt" });

| Input | Behavior |
| --- | --- |
| `{ text, cwd? }` | Run `text` inline via `<shell> -c`. |
| `{ script, args?, cwd? }` | Run a local, `session://`, or `skill://` script directly in the interpreter with `args` (`string[]`); no executable bit is required. |
| `cwd` | Working directory (defaults to the workspace project root). |

## Environment

Provider credentials and `PLURNK_*` settings are stripped before launch; admitted host variables and `plurnk.env` (`mcp:///plurnk/env.json`) entries pass through.

## Channels and settlement

Output streams under the receipt's `stream` address (e.g. `sh:///ab3d5678`):

- `#stdout` (default) and `#stderr` (`text/stream`): while running, `## Open Work` reports each channel's size and growth; on completion, `_plurnk` emits one `read` per non-empty channel (full output when it fits the budget, or a bodiless size/range receipt with `exitCode`).
- Nonzero `exitCode` is the command's exit status, not an operation failure.
- Read a slice of a running or settled stream with `range`:

await plurnk.read({ path: "sh:///ab3d5678#stdout", range: "17,40" });
