# plurnk-execs

Framework + contract for `@plurnk/plurnk-execs-*` runtime executor packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme for EXEC op dispatch.

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (EXEC AST), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes).

## Exports

- `BaseExecutor` — abstract base a `@plurnk/plurnk-execs-*` sibling subclasses: declares its output channels and implements `run(args) → ExecResult`.
- `discover(options?)` — scans `node_modules/@plurnk/` for `plurnk.kind === "exec"` packages and builds the runtime-tag registry (fail-hard on tag collision).
- `ExecArgs`, `ExecResult`, `ChannelDecl`, `ChannelState`, `ExecutorMetadata`, `ExecInfo`, `ExecRegistry`, `Discovery`, `DiscoverOptions` — contract types.
- `TelemetryEvent`, `ContentOffset`, `LogCoordinate` — local mirror of grammar's telemetry envelope (the `emit` sink's payload).
- `resolveRuntime(runtime, command)`, `isKnownRuntime(runtime)`, `KNOWN_RUNTIMES`, `SpawnArgs`, `RuntimeResolver` — subprocess-family helper for the consumer's legacy spawn path (§4).

## Tests

`test:lint`, `test:unit`.
