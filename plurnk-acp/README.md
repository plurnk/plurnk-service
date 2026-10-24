# `@plurnk/plurnk-acp`

Agent Client Protocol (ACP v2) daemon module for the Plurnk daemon.

Mounts `/acp` on the daemon's shared HTTP listener (`PLURNK_HOST:PLURNK_PORT`, default `127.0.0.1:1066`), serving:

- **WebSocket (`Upgrade: websocket` on `/acp`)** — bidirectional JSON-RPC 2.0 ACP v2 sessions, streaming `session/update` notifications, and server-initiated `session/request_permission` and `_plurnk/question` gates.
- **Streamable HTTP (`POST /acp` and `GET /acp/entry`)** — JSON-RPC 2.0 request/response and Server-Sent Events (`Accept: text/event-stream`) over `/acp`, plus entry-channel body retrieval at `/acp/entry`.
- **OAuth 2.1 Bearer Admission** — verifies `acp`-scoped access tokens against `ApplicationPort.credentials` when `PLURNK_AUTH=1`.

See [`SPEC.md`](./SPEC.md) for the authoritative contract.
