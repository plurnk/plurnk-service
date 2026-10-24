# Plurnk ACP v2 Specification

`@plurnk/plurnk-acp` is the Agent Client Protocol (`protocolVersion: 2`) exterior adapter for the Plurnk daemon. It consumes the contracts-owned {§application-port} and mounts `/acp` on the daemon's single HTTP listener ({§http-host}).

## 1. Module & Transport Surface

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-daemon-module} | `@plurnk/plurnk-acp` is a discovered daemon module claiming `/acp` and registering the `acp://` message… |
| {§acp-configuration} | **The module reads `PLURNK_ACP_*` from the assembled environment; explicit options override them.**… |
| {§acp-transport} | `/acp` serves both WebSocket (`Upgrade: websocket`) and Streamable HTTP (`POST /acp`, `GET /acp/entry`). |
| {§acp-http-authorization} | When the daemon publishes a credential face, `/acp` requires a valid `acp`-scoped Bearer access token. |
| {§acp-session-binding} | An ACP `sessionId` resolves to a `(workspaceId, workerId)` pair via qualified `<workspaceId>#<workerName>`… |
| {§acp-projection} | Daemon log rows and live events project onto ACP v2 `session/update` notifications with `_meta.plurnk`… |
| {§acp-session-load} | `session/load` and `session/resume` replay the bound worker's recent loop window as `session/update`… |
| {§acp-hitl} | Stopped-world proposals and client interactions project to `session/request_permission` and… |
| {§acp-extensions} | **`_plurnk/*` JSON-RPC methods expose discovery, worker overview, and management actions over the same… |
<!-- /map -->

§acp-daemon-module **`@plurnk/plurnk-acp` is a discovered daemon module claiming `/acp` and registering the `acp://` message scheme.** At `setup` it registers the `acp` `MessageScheme` so client-submitted messages and interactions are addressable at `acp://operator/sessions/<session>/messages/<id>`, and sets `acp://operator` as the approval and interaction owner in workspaces it attaches. At `start` it mounts `/acp` via `registerHttpRoute` and `registerHttpUpgrade`. `close` closes active WebSocket and SSE streams and awaits in-flight requests before returning ({§module-route-settlement}).

§acp-configuration **The module reads `PLURNK_ACP_*` from the assembled environment; explicit options override them.** `PLURNK_ACP_ALLOW_ORIGIN`, `PLURNK_ACP_MAX_TURNS`, `PLURNK_ACP_HEARTBEAT_MS`, `PLURNK_ACP_HISTORY_LOOPS`, `PLURNK_ACP_HISTORY_PAGE_CHARS`, `PLURNK_ACP_EXCERPT_CHARS`, and `PLURNK_ACP_OVERVIEW_WORKERS` govern CORS headers, turn caps, stream heartbeats, replay windowing, inline body limits, and list excerpts.

§acp-transport **`/acp` serves both WebSocket (`Upgrade: websocket`) and Streamable HTTP (`POST /acp`, `GET /acp/entry`).**

| Path & Method | Behavior |
| --- | --- |
| `GET /acp` with `Upgrade: websocket` | Completes the RFC 6455 handshake (`101 Switching Protocols`) and exchanges bidirectional JSON-RPC 2.0 text frames. |
| `POST /acp` | Accepts a JSON-RPC 2.0 request or response (`application/json`). When `Accept` includes `text/event-stream` on a streaming method (`session/prompt`, `session/load`, `session/resume`), streams `data: <jsonrpc>\n\n` frames before the terminal JSON-RPC response; otherwise answers `200 OK` with `application/json`. |
| `GET /acp/entry` | Reads an entry channel by reference (`?workspaceId=<id>&workerId=<id>&target=<uri>`) via `ApplicationPort.readEntryChannel`; answers 400 `entry-query-invalid` when parameters are missing or invalid, or the entry's Problem status when reading fails. |
| `OPTIONS /acp` | Answers `204 No Content` with CORS headers when `PLURNK_ACP_ALLOW_ORIGIN` is non-empty. |
| Other methods / subpaths | Refused with 405 `method-not-allowed`, 404 `route-not-found`, 415 `unsupported-media-type`, or 400 `invalid-json` Problem details. |

§acp-http-authorization **When the daemon publishes a credential face, `/acp` requires a valid `acp`-scoped Bearer access token.** With no face (`PLURNK_AUTH=0`), requests and WebSocket upgrades admit anonymously. With a published face (`PLURNK_AUTH=1`), the module checks `Authorization: Bearer <token>` (or `?access_token=<token>` on WebSocket upgrades) via `credentials.verify(token)`: missing or invalid credentials answer 401 `unauthorized` with `WWW-Authenticate: Bearer realm="plurnk", resource_metadata="<issuer>/.well-known/oauth-protected-resource"`, a token lacking the `acp` scope answers 403 `insufficient-scope`, and revoking a credential family closes its active streams with 401 `credential-revoked` (or 503 `service-stopping` on daemon shutdown).

§acp-session-binding **An ACP `sessionId` resolves to a `(workspaceId, workerId)` pair via qualified `<workspaceId>#<workerName>` syntax or the `"acp"` external worker reference namespace.** A qualified `<workspaceId>#<workerName>` address is parsed syntactically (400 `session-address-invalid` when malformed, 404 `session-not-found` when absent). An unqualified `sessionId` resolves through `readWorkerReference` / `ensureWorkerReference` under `namespace: "acp"`. `session/new` attaches or creates the requested workspace (`cwd` / `projectRoot`, `workspaceId`, or `workspaceName`), allocates or binds the worker, claims `acp://operator` ownership, and returns the canonical `sessionId`.

§acp-projection **Daemon log rows and live events project onto ACP v2 `session/update` notifications with `_meta.plurnk` metadata.**

| Daemon Source | ACP `sessionUpdate` | Rule |
| --- | --- | --- |
| Model `SEND` row | `agent_message_chunk` | Carries speech text (or a resource link to `/acp/entry` when exceeding `historyPageChars`) and `_meta.plurnk` row metadata (`aside`, `receipt`, `coordinate`, `status`, bodyless `attrs`). |
| `_plurnk` `SEND` arrival (`attrs.kind === "message"`) | `user_message_chunk` | Carries the arriving message content and causal source. |
| Model operation row (`READ`, `EDIT`, `EXEC`, etc.) | `tool_call` / `tool_call_update` | Maps `op` to ACP `ToolKind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`), `state`/`status_rx` to `pending`, `in_progress`, `completed`, or `failed`, and attaches `_meta.plurnk`. |
| `reasoning/event` or row `reasoning` | `agent_thought_chunk` | Streams reasoning deltas for the session's bound worker. |
| `loop/packet` and `loop/terminated` | `usage_update` | Carries verbatim packet gauge and loop accounting numbers. |
| Ambient / outside / notice / stream / preparation | `_plurnk/ambient`, `_plurnk/outside`, `_plurnk/notice`, `_plurnk/stream`, `_plurnk/workspace/preparation` | Preserves Plurnk-specific observability on the ACP session stream. |

§acp-session-load **`session/load` and `session/resume` replay the bound worker's recent loop window as `session/update` notifications and subscribe to live events.** Replay windows the worker's log to the newest `PLURNK_ACP_HISTORY_LOOPS` concluded loops (or an explicit `beforeLoopSeq` page cursor), emits each row's `session/update` notification in log order followed by pending inbox messages, and returns `{ sessionId, workspaceId, workerId, modes, models, configOptions, hasMore, beforeLoopSeq }`.

§acp-hitl **Stopped-world proposals and client interactions project to `session/request_permission` and `_plurnk/question` and settle through `ApplicationPort`.** When a proposal or client interaction is pending for the session's workspace, the adapter sends a `session/request_permission` (with options `accept`, `reject`, `cancel`) or `_plurnk/question` JSON-RPC request on WebSocket (and notifications on SSE), and resolves the gate via `resolveProposal` or `resolveClientInteraction` when the client answers or invokes `session/resolve_permission` / `_plurnk/interaction.resolve`.

§acp-extensions **`_plurnk/*` JSON-RPC methods expose discovery, worker overview, and management actions over the same connection.** `_plurnk/discover` returns the installed action and notification schemas and display capabilities; `_plurnk/overview` returns `ApplicationPort.readWorkerOverview`; and `_plurnk/action` validates and dispatches built-in and module actions (`invalid-action-parameters`, `parse-failed`, `action-failed`), sharing one transport and authentication boundary with standard ACP v2 methods.
