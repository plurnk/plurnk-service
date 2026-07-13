# @plurnk/plurnk-execs-wasm

WebAssembly runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Runs model-authored WebAssembly **in-process, sandboxed** — the safe arbitrary-execution tier that `node -e` can't be.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Runtime tags

The module comes from the **EXEC body** (inline) or, when a `(target)` path is given, from a **file** — mirroring `sqlite`'s target-as-path:

| Tag | Glyph | `(target)` = file path | no target (body) |
|---|---|---|---|
| `wat` | 🧩 | read `.wat` file → compile | WebAssembly **Text** → compile |
| `wasm` | 🧩 | read `.wasm` file → bytes | base64-encoded **binary** |

```
<<EXEC[wat]:(module (func (export "main") (result i32) (i32.const 42))):EXEC   # inline text
<<EXEC[wasm](./build/mod.wasm)::EXEC                                            # built module from disk
```

`wat` is assembled to wasm via [wabt](https://github.com/AssemblyScript/wabt.js); `wasm` is the raw binary. (`.wast` — the spec test-suite superset with `assert_*` commands — is deliberately *not* supported; this executes a module, not a test script.)

## Execution model

Both forms instantiate in a sandbox whose only import is `env.log` (capture). The executor then calls the module's entry point — `main`, else `_start`, else the sole exported function — and writes:

```json
{ "returned": <value|null>, "log": [ … ], "exports": [ "main", … ] }
```

to the `results` channel (`application/json`). A module that imports `(import "env" "log" (func $log (param i32)))` can emit intermediate values.

- **`effect`** — inline body → `pure` (sandboxed; **auto-runs inline**, never proposal-gated). File-path target → `read` (it touches the filesystem, even though execution stays sandboxed). Target-classified, never command-inspected.
- **`probe`** — always available (`WebAssembly` builtin + bundled `wabt`).
- **Errors** emit a `TelemetryEvent` (`source: "exec:wat"`/`"exec:wasm"`): `wat_parse_error`, `wasm_invalid`, `wasm_trap`, `wasm_read_failed`, `wabt_init_failed`.

## Tests

`test:lint`, `test:unit`.
