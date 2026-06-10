# @plurnk/plurnk-execs-wasm

WebAssembly runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Runs model-authored WebAssembly **in-process, sandboxed** — the safe arbitrary-execution tier that `node -e` can't be.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Runtime tags

| Tag | Glyph | Input |
|---|---|---|
| `wat` | 🧩 | WebAssembly **Text** (S-expression module) — the model-facing form |
| `wasm` | 🧩 | base64-encoded **binary** module (pre-compiled) |

`wat` is the primary: a model emits text, not bytes. WAT is assembled to wasm via [wabt](https://github.com/AssemblyScript/wabt.js); `wasm` decodes base64. (`.wast` — the spec test-suite superset with `assert_*` commands — is deliberately *not* supported; this executes a module, not a test script.)

## Execution model

Both forms instantiate in a sandbox whose only import is `env.log` (capture). The executor then calls the module's entry point — `main`, else `_start`, else the sole exported function — and writes:

```json
{ "returned": <value|null>, "log": [ … ], "exports": [ "main", … ] }
```

to the `results` channel (`application/json`). A module that imports `(import "env" "log" (func $log (param i32)))` can emit intermediate values.

- **`effect: pure`** — a module can't touch the host (only the imports it's handed), so it **auto-runs inline**, never proposal-gated.
- **`probe`** — always available (`WebAssembly` builtin + bundled `wabt`).
- **Errors** emit a `TelemetryEvent` (`source: "exec:wat"`/`"exec:wasm"`): `wat_parse_error`, `wasm_invalid`, `wasm_trap`, `wabt_init_failed`.

## Tests

`test:lint`, `test:unit`.
