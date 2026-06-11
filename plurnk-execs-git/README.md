# @plurnk/plurnk-execs-git

`git` + GitHub-CLI runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Drives `EXEC[git]` / `EXEC[gh]` by **shelling the system `git`/`gh` binaries** — no third-party git/gh library; the installed CLIs are the source of truth.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Runtime tags

| Tag | Glyph | Binary | Available when |
|---|---|---|---|
| `git` | 🔀 | `git` | `git` on PATH |
| `gh` | 🐙 | `gh` | `gh` on PATH **and** authenticated (`gh auth status`) |

```
<<EXEC[git]:status --short:EXEC
<<EXEC[gh]:pr create --title "Fix the bug" --body "Closes #5":EXEC
```

The command is tokenized into **real argv** (`tokenizeArgv`) and the tag's binary is run directly — **never** through a shell. That's deliberate: shelling `git commit -m "costs $5"` would expand `$5` and corrupt the message; passing argv preserves `$`, backticks, and other specials literally. Shell metacharacters (`|`, `;`, `>`) are passed as literal args, not interpreted.

## Effect & gating

`effect` is **`host` for every command** (proposal-gated). This is required, not a shortcut: `effect(target)` classifies the target only and must never inspect the command, so `git status` and `git push` are indistinguishable to it. **The service owns all gating** — membership, proposal/confirm, the enable ceiling, and outward-confirm for `push` / `gh pr create`. The executor only runs the command and declares the effect.

## Availability

Correct per-tag availability (e.g. `gh` unauthenticated while `git` works) requires the consumer to probe **per-tag**, not per-package (plurnk-service#185).

## Tests

`test:lint`, `test:unit`. Live tests auto-skip where the binary is absent.
