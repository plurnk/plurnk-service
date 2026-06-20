# plurnk-service

LLM agent runtime engine. Consumes [plurnk-grammar](https://github.com/plurnk/plurnk-grammar); exposes WebSocket JSON-RPC for clients. User-facing CLI: [plurnk](https://github.com/plurnk/plurnk). MIT.

## Run

```
npm install -g @plurnk/plurnk-service
plurnk-service start      # WS JSON-RPC daemon (`migrate` initializes the DB)
```

Config: `.env.example` (canonical knob list; layer with `--env-file` / `--config`). Provider-agnostic — point `PLURNK_MODEL` / `PLURNK_*` at any vendor. Also exports `{ Engine, Daemon, SchemeRegistry }` for in-process embedding.

## Contract

- [`SPEC.md`](./SPEC.md) — canonical specification. One `§<tag>` namespace; anchors `{§<tag>}` bind 1:1 to `test/intg/spec-anchors.test.ts`.
- `discover` RPC — live method + notification catalog over the wire.

## Sibling contracts

Author-facing contracts in their own repos; plurnk-service is the consumer.

| Repo | Domain | Consumption |
|---|---|---|
| [plurnk-providers](https://github.com/plurnk/plurnk-providers) | LLM transports + tokenomic primitives | SPEC §provider |
| [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) | URI scheme handlers | SPEC §scheme-surface |
| [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) | Content interpreters | SPEC §mimetype-surface |
| [plurnk-execs](https://github.com/plurnk/plurnk-execs) | Runtime executors (EXEC dispatch) | SPEC §bundled-set |

## Semantic search

`FIND` ranks via an optional embedder peer, `@plurnk/plurnk-mimetypes-embeddings` (heavy native deps; not installed by default). Absent → `FIND` degrades and `start` prints an `embedder inactive` notice. Enable: `npm i @plurnk/plurnk-mimetypes-embeddings`.

## Tests

`test:lint`, `test:unit`, `test:intg`, `test:live`, `test:demo`; off-hot-path `test:installation`.
