# plurnk-execs

Framework + contract for `@plurnk/plurnk-execs-*` runtime executor packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme for EXEC op dispatch.

## Documentation

- [`SPEC.md`](./SPEC.md) — the authoritative author-facing contract. This README is the orientation.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (EXEC AST), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) (the reference family this one mirrors).

## Write an executor

Ship an executor by publishing a package — **under any scope** (`@acme/whatever`; discovery keys on `plurnk.kind`, not the `@plurnk` scope) — that declares its runtime tags and default-exports a `BaseExecutor` subclass.

### 1. Declare tags in `package.json`

```json
{
  "plurnk": {
    "kind": "exec",
    "runtimes": [
      { "name": "cobol", "glyph": "🗄", "example": "EXEC[cobol]:DISPLAY 'HI'.:EXEC" }
    ]
  }
}
```

One package may claim many tags (the search sibling claims `search`/`news`/`images`/…); each `runtimes[]` entry registers independently. `glyph` is display; **`example`** is a one-line, self-documenting usage example (`EXEC[tag]:body:EXEC`) surfaced verbatim in the model's tools sheet — omit it and the tag just isn't advertised with a usage line.

### 2. Default-export a `BaseExecutor` subclass

The framework instantiates **one executor per tag**, injecting `{ runtime, glyph }` (`ExecutorMetadata`) — branch on `this.runtime` when one class backs several tags. Two ways in:

- **Subprocess runtimes** (the common case): subclass **`SubprocessExecutor`** and override one hook — `spawnArgs(runtime, command) → { cmd, args, useShell, stdin? }`. You inherit stdout/stderr streaming, process-group abort, **env scoping**, and exit-code reporting. Override the `binary` getter so `probe()` checks it's on PATH (`null` = always available).
- **Logical / in-process runtimes** (sqlite, search, wasm, jq): subclass **`BaseExecutor`** directly and implement:
  - `get channels()` — the output channels you write, each `{ mimetype, defaultState? }`.
  - `run(args) → ExecResult` — do the work, resolve `{ status }`. Never throw for an expected failure — `emit` telemetry and set the channel to `errored` instead.
  - `probe()` *(optional)* — `{ available, detail? }`; defaults to available. Override when you depend on an external binary or config (the `detail` is model-facing on a 501).
  - `effect(target)` *(optional)* — `"pure" | "read" | "host"`; the consumer maps it to its proposal policy (host → propose, read/pure → auto-run inline). Classify the **target only**, never the command. Defaults to `host` (the safe end).

### 3. What `run` receives (`ExecArgs`) — sinks, never the substrate

`{ runtime, command, cwd, env, signal, write(channel, chunk), setState(channel, state), emit(event) }`. The executor gets sinks and honors `signal` — never the db, subscriptions, or wake machinery (those stay in the consumer). `cwd` is the parsed EXEC target; **`env`**, when the consumer scopes it, is exactly the environment a spawned child should see (the host's own secrets already dropped — never inherit `process.env` for model-run children yourself). Stay stateless across runs beyond your construction metadata.

## Discovery & trust

`discover(options?)` scans **every installed package** under `<cwd>/node_modules` — scope-agnostic — for `plurnk.kind === "exec"`, returning `{ registry, skipped }`.

- **Tag collisions are fail-hard.** Two packages claiming the same tag throws at discovery, naming both — deliberately stricter than plurnk-mimetypes' last-wins. A runtime tag is an executable dispatch key, so a third party silently shadowing `python` is exactly the failure we refuse to let ship quietly; the operator resolves it.
- **Trust gate.** `discover()` honors **`PLURNK_PLUGINS_TRUSTED_ONLY`** (host posture, plurnk-service#229): unset/`""`/`0` → every package registers (default, no regression); any value → `@plurnk/*` always trusted plus a comma-separated allowlist (`1` = first-party only). An untrusted package is discovered but **not** registered and returned in `Discovery.skipped` for the consumer to note — never a crash.

## Exports

- `BaseExecutor` — abstract base: `channels`, `run(args)`, optional `probe()` / `effect(target)`.
- `SubprocessExecutor` — concrete base for subprocess runtimes; override `spawnArgs()` (and `binary`). Streaming + process-group abort + env scoping + exit code, inherited.
- `discover(options?)` — the scope-agnostic registry scan (trust-gated, fail-hard on collision).
- Contract types: `ExecArgs`, `ExecResult`, `ChannelDecl`, `ChannelState`, `ExecutorMetadata`, `RuntimeAvailability`, `Effect`, `ExecInfo`, `ExecRegistry`, `Discovery`, `DiscoverOptions`.
- `TelemetryEvent`, `ContentOffset`, `LogCoordinate` — the `emit` sink's payload (mirror of grammar's telemetry envelope).
- `resolveRuntime`, `isKnownRuntime`, `KNOWN_RUNTIMES`, `SpawnArgs`, `RuntimeResolver` — subprocess-family helper for the consumer's legacy spawn path (SPEC §4).

## Tests

`test:lint`, `test:unit`.
