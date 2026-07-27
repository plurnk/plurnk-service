# @plurnk/plurnk-execs-git

In-process git runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme — [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git), **no subprocess**. `EXEC[git]` is the sandbox-portable versioning surface: version control that survives a deployment disabling `sh`, with zero shell-escape surface (no aliases, hooks, pagers — there is no process to escape into).

Built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework (#460, DIVERGENCES #15).

## The contract

- **`EXEC[git]` = the safe subset.** A deliberately limited verb set (`init` / `status` / `add` / `commit` / `log` / `branch` / `checkout`) mapped onto the isomorphic-git API, in-process. Results are JSON on `#results`.
- **Full git = the shell.** `<<EXEC:git rebase -i …:EXEC` rides the sh fallthrough and works only where the deployment grants a shell. Sandboxes can't do everything — that's the design, not a gap.
- The old `gh` tag is gone (a CLI wrapped as a CLI adds nothing over the fallthrough); GitHub work rides the shell.

## Usage

```
<<EXEC[git]:status:EXEC
<<EXEC[git]:add .:EXEC
<<EXEC[git]:commit -m "save work":EXEC
<<EXEC[git](./subrepo):log -n 5:EXEC
```

`(target)` is the repo directory (default: the workspace workspace). Commit author comes from the repo's own `user.name`/`user.email` config — never invented; unset fails with `git_no_author`.

## Availability & gating

`probe()` is always available — in-process, nothing on PATH to check. Every op
is `effect → host` (proposal-gated): mutating verbs exist and `effect()` never
inspects the command. Failures return RFC 9457 Problems in the terminal
operation result.

## Tests

`test:lint`, `test:unit` — the unit suite drives real temp-dir repos end-to-end.
