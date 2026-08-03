# @plurnk/plurnk-execs-wasm

WebAssembly runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Runs model-authored WebAssembly **in-process, sandboxed** — the safe arbitrary-execution tier that `node -e` can't be.

A `@plurnk/plurnk-execs-*` sibling built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework.

## Runtime tags

The module comes from the **EXEC body** (inline) or, when a `(target)` path is given, from a **file** — mirroring `sqlite`'s target-as-path:

| Tag    | Glyph | `(target)` is a file   | No target: body is                |
| ------ | ----- | ---------------------- | --------------------------------- |
| `wat`  | 🧩    | `.wat` text to compile | WebAssembly Text to compile       |
| `wasm` | 🧩    | `.wasm` binary bytes   | Base64-encoded WebAssembly binary |

```plurnk
<<EXEC[wat]:(module (func (export "main") (result i32) (i32.const 42))):EXEC
<<EXEC[wasm](./build/mod.wasm)::EXEC
```

`wat` is assembled through [wabt](https://github.com/AssemblyScript/wabt.js),
while `wasm` is the raw binary. The `.wast` test-suite superset is not
supported because this runtime executes modules rather than test scripts.

## Execution model

Both forms instantiate in a sandbox whose only import is `env.log` (capture). The executor then calls the module's entry point — `main`, else `_start`, else the sole exported function — and writes:

```json
{ "returned": <value|null>, "log": [ … ], "exports": [ "main", … ] }
```

to the `results` channel (`application/json`). A module that imports `(import "env" "log" (func $log (param i32)))` can emit intermediate values.

- **`effect`** — an inline body is `pure`; a file target is `read`. Both bypass
  proposal review and then use the ordinary background result stream
  ({§executor-effect}). Classification uses only the target.
- **`probe`** — always available (`WebAssembly` builtin + bundled `wabt`).
- **Errors** return RFC 9457 Problems in the terminal operation result.

## Tests

`test:lint`, `test:unit`.
