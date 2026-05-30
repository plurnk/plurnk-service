# plurnk-service

LLM agent runtime engine. Consumes [plurnk-grammar](https://github.com/plurnk/plurnk-grammar); exposes WebSocket JSON-RPC for clients. User-facing CLI: [plurnk](https://github.com/plurnk/plurnk).

## Documentation

- [`SPEC.md`](./SPEC.md) — canonical specification. 16 numbered sections. Anchors `{§<id>}` bind to integration tests (`test/intg/spec-anchors.test.ts`).
- [`AGENTS.md`](./AGENTS.md) — collaboration memory for agents working on this repo (gitignored).

## Sibling contracts

Author-facing contracts hosted in their own repos. plurnk-service is the consumer; consumption surface section noted.

| Repo | Domain | Consumption |
|---|---|---|
| [plurnk-providers](https://github.com/plurnk/plurnk-providers) | LLM transports + tokenomic primitives | SPEC §2 |
| [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) | URI scheme handlers | SPEC §3.6 |
| [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) | Content interpreters | SPEC §4.5 |
| [plurnk-execs](https://github.com/plurnk/plurnk-execs) | Runtime executors (EXEC dispatch) | SPEC §10 |

## Tests

Tiers per SPEC §0.7. Scripts: `test:lint`, `test:unit`, `test:intg`, `test:live`, `test:demo`.
