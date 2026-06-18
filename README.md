# plurnk-service

LLM agent runtime engine. Consumes [plurnk-grammar](https://github.com/plurnk/plurnk-grammar); exposes WebSocket JSON-RPC for clients. User-facing CLI: [plurnk](https://github.com/plurnk/plurnk).
Default Provider: [plurnk.ai](https://plurnk.ai).

* Plurnk Service is vendor-agnostic, and connects to (almost) any LLM.
* Plurnk Service is MIT Licensed and owned by Plurnk Foundation, not Plurnk, Inc.
* Plurnk, Inc.'s grammar-tuned [plurnk.ai](https://plurnk.ai) model is offered as an optional convenience.
* You may (OPTIONALLY) obtain free PLURNK_ACCOUNT and PLURNK_KEY variables at [plurnk.ai](https://plurnk.ai).

## Documentation

- [`SPEC.md`](./SPEC.md) — canonical specification. Sections and promises share one terse-tag namespace (`§<tag>`, no digits). Anchors `{§<tag>}` bind to integration tests (`test/intg/spec-anchors.test.ts`).
- [`AGENTS.md`](./AGENTS.md) — collaboration memory for agents working on this repo (gitignored).

## Sibling contracts

Author-facing contracts hosted in their own repos. plurnk-service is the consumer; consumption surface section noted.

| Repo | Domain | Consumption |
|---|---|---|
| [plurnk-providers](https://github.com/plurnk/plurnk-providers) | LLM transports + tokenomic primitives | SPEC §provider |
| [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) | URI scheme handlers | SPEC §scheme-surface |
| [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) | Content interpreters | SPEC §mimetype-surface |
| [plurnk-execs](https://github.com/plurnk/plurnk-execs) | Runtime executors (EXEC dispatch) | SPEC §bundled-set |

## Tests

Tiers per SPEC §test-taxonomy. Scripts: `test:lint`, `test:unit`, `test:intg`, `test:live`, `test:demo`.
