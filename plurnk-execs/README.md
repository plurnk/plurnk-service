# plurnk-execs

Framework + contract for `@plurnk/plurnk-execs-*` runtime executor packages. Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme for EXEC op dispatch.

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (EXEC AST), [plurnk-providers](https://github.com/plurnk/plurnk-providers), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes).

## Exports

- `SpawnArgs`, `RuntimeResolver` — types.
- `KNOWN_RUNTIMES` — read-only set of v0 hardcoded runtime tags.
- `isKnownRuntime(runtime)` — predicate.
- `resolveRuntime(runtime, command)` — runtime tag + command → `SpawnArgs` for `node:child_process.spawn`.

## Tests

`test:lint`, `test:unit`.
