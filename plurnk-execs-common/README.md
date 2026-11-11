# @plurnk/plurnk-execs-common

Subprocess executor for [`@plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service) (`sh`, `js`, `python3`), built on [`@plurnk/plurnk-execs`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs). `js` (`node`) is always present; `sh` and `python3` register when `command -v` finds them on `PATH`.

## Runtimes & invocation ({§executor-subprocess}, {§executor-contract})

| Tag | Binary | Inline `{ text, cwd? }` |
| --- | --- | --- |
| `sh` 🐚 | `sh` (`-c`) | `plurnk.sh({ text: "uname -s" })` |
| `js` ⬢ | `node` (`-e`) | `plurnk.js({ text: "console.log(process.version)" })` |
| `python3` 🐍 | `python3` (`-c`) | `plurnk.python3({ text: "import sys; print(sys.version)" })` |

Local script form (`{ script, args?, cwd? }`):

```js
plurnk.sh({ script: "./deploy.sh", args: ["--release", "two words"] })
plurnk.python3({ script: "transform.py", args: ["--format", "json"] })
```

- `cwd` selects the working directory for inline or script runs; `script` executes the file directly with `args` (`string[]`, lowered via `SubprocessExecutor` / `tokenizeArgv`).
- All three runtimes declare `effect: "host"` and are proposal-gated ({§executor-results}), streaming output to `<tag>:///<id>#{stdout,stderr}`.
- Subtractive boot policy: `PLURNK_EXECS_<TAG>=0` disables one tag; `PLURNK_EXECS_ONLY=<list>` restricts registration ({§executor-policy}).

## Node `--permission` confinement

Passing `--permission` via `NODE_OPTIONS` confines `js` child processes (`ERR_ACCESS_DENIED`) with zero PLURNK-specific flags ({§execution-output-identity}):

| Scope | Surface | Effect |
| --- | --- | --- |
| Unregister shell/Python | `PLURNK_EXECS_ONLY=js` | Restricts registered subprocess tags to `js` ({§executor-policy}). |
| Confine `js` children | `NODE_OPTIONS="--permission --allow-fs-read=<dir> --allow-fs-write=<dir>"` | Applies to `js` + Node MCP stdio servers at `scope: "workspace"`, or `js` children only at `scope: "session"` (`plurnk.env`). |
| OS boundary | `PLURNK_EXECS_SPAWN_USER` / container / VM | Required for adversarial isolation (Node `--permission` is same-UID accident containment). |

## Tests

```sh
npm test -w @plurnk/plurnk-execs-common
```
