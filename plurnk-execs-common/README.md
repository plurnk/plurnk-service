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

## Alignment with Node's permission framework

Node's `--permission` model is natively conditional: unflagged `js` invocations run
with normal Node semantics, while passing `--permission` flags through
`NODE_OPTIONS` confines `js` child processes at access time (`ERR_ACCESS_DENIED`)
without adding any PLURNK-specific knob or altering default behavior.

| Step | Existing surface | Effect |
| --- | --- | --- |
| 1. Remove out-of-model interpreters | `PLURNK_EXECS_ONLY=js` | Unregisters `sh` and `python3` at discovery ({§executor-policy}); downstream layers cannot re-enable them. |
| 2. Confine `js` children | `NODE_OPTIONS="--permission --allow-fs-read=<workspace> --allow-fs-write=<workspace>"` | Confines filesystem reads and writes to `<workspace>` and denies `child_process` spawning (`ERR_ACCESS_DENIED`). |
| 3. Discover daemon envelope (optional) | `node --permission-audit ...` | Audits paths the daemon itself touches (run root, checkout, `node_modules`) before launching the daemon under `--permission`. |

**Scope choices** ({§execution-output-identity}):

- **Workspace scope** (`plurnk (env)` with `scope: "workspace"`): `NODE_OPTIONS` reaches both `js` execution children and Node-based MCP server subprocesses in the workspace.
- **Session scope** (`plurnk (env)` with `scope: "session"`): `NODE_OPTIONS` reaches `js` execution children of that session only.

**Honest ledger:** Node's permission model provides same-UID accident containment, not adversarial security boundaries. PLURNK owns authority, consent, and audit, and never claims containment; for OS-account separation, combine with `PLURNK_EXECS_SPAWN_USER` ({§executor-spawn-account}) or an external container/VM sandbox.

## Tests

`test:lint`, `test:unit`. Live-eval tests auto-skip where the interpreter is absent.
