# plurnk-providers

Framework + contract for `@plurnk/plurnk-providers-*` sibling packages (LLM transports + tokenizer + cost accounting). Consumed by [plurnk-service](https://github.com/plurnk/plurnk-service).

## Documentation

- [`SPEC.md`](./SPEC.md) — author-facing contract for sibling implementers.
- Constellation: [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) (HEREDOC + AST), [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes), [plurnk-schemes](https://github.com/plurnk/plurnk-schemes), [plurnk-execs](https://github.com/plurnk/plurnk-execs).

## Exports

- `Provider`, `ChatMessage`, `ProviderResponse`, `ProviderAssistant`, `ProviderUsage`, `ProviderFactory` — types.
- `parseAliasesFromEnv`, `resolveActiveAlias` — alias-cascade resolution (pure env-parsing). Provider instantiation (`instantiateProvider`, `loadActiveProvider`) is consumer-side; see SPEC §5.
- `Mock` — reference implementation + test fixture (dual-purpose).

## Tests

`test:lint`, `test:unit`.
