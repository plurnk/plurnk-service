# sh

`sh` runs `text` with `-c` in the shell its summary names (`$SHELL`, or `/bin/sh` when unset).

| Arguments | Behavior |
| --- | --- |
| `{"text": "printf 'hello\\n' > hello.txt", "cwd"?: "..."}` | Run `text` inline via `<shell> -c`. |
| `{"script": "deploy.sh", "args"?: ["--flag"], "cwd"?: "..."}` | Run a local, `session://`, or `skill://` script directly in the interpreter with `args` (`string[]`); no executable bit is required. |
| `cwd` | Working directory (defaults to the workspace project root). |

## Environment

Provider credentials and `PLURNK_*` settings are stripped before launch; admitted host variables and `env` (`mcp:///plurnk/env.json`) entries pass through.

## Channels and settlement

Output streams under the receipt's `stream` address (e.g. `exec:///sh/ab3d5678`):

- `#stdout` (default) and `#stderr` (`text/stream`): while running, `## Open Work` reports each channel's size and growth; on completion, `_plurnk` emits one `read` per non-empty channel (full output when it fits the budget, or a bodiless size/range receipt with `exitCode`).
- Nonzero `exitCode` is the command's exit status, not an operation failure.
- Read a slice of a running or settled stream via `read` with `{"path": "exec:///sh/ab3d5678#stdout", "range": "17,40"}`.
