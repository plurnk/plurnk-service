# Notifications and Event Surfaces

Plurnk separates discrete state-transition notifications (`GET /notifications`) from sub-turn session streaming (`/acp`) and MCP resource/tool invalidation (`/mcp`), eliminating any need for in-daemon hook or plugin seams.

```mermaid
flowchart LR
    Core["Core Engine & Functionality"] -->|"subscribeToEvents<br/>18 discrete events"| SSE["GET /notifications[/&lt;workspace&gt;[/&lt;session&gt;]]"]
    Core -->|"subscribeToEvents"| ACP["/acp (ACP v2)"]
    Core -->|"subscribeToEvents"| MCP["/mcp (MCP 2026-07-28 subscriptions/listen & 2025-06-18 resources/subscribe)"]
    Core -->|"subscribeToRuntimeStream<br/>sub-turn chunks & telemetry"| ACP
    Core -->|"subscribeToRuntimeStream"| MCP
```

## Channel selection

| Need | Endpoint | Mechanism |
| --- | --- | --- |
| Daemon, workspace, or session state transitions, gates, settled log entries, and user-facing notices | `GET /notifications[/<workspace>[/<session>]][?event=...]` | Server-Sent Events (`DaemonNotificationEnvelope.json`) with `Last-Event-ID` replay |
| Interactive session control, token/reasoning streaming, live tool progress, and gate resolution | `/acp` | ACP v2 `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call_update`, `available_commands_update`, `config_option_update`, `state_update`), `session/request_permission`, and `elicitation/create` |
| External MCP host tool/resource cache invalidation | `/mcp[/<workspace>[/<session>]]` | MCP `2026-07-28` `POST` `subscriptions/listen` and `2025-06-18` stateful `resources/subscribe` SSE (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`) |

## Routes, authentication, and `Last-Event-ID` resume

| Aspect | Contract |
| --- | --- |
| Routes | `/notifications` (daemon-wide), `/notifications/<workspace>` (workspace ID or URL-encoded name), `/notifications/<workspace>/<session>` (session ID or name; subtree `session/archived` and `session/deleted` match descendants) |
| Query filter | Repeatable or comma-separated `?event=<event>` validated against `DAEMON_NOTIFICATION_EVENTS`; unknown parameters or event names fail `400 daemon/notifications/invalid-filter` |
| Authentication & CORS | Loopback-open by default with `admitBrowserOrigin` CSRF defense; when `PLURNK_AUTH_ISSUER` is configured, requires `Authorization: Bearer <token>` or `?access_token=<token>` (`401` / `403` RFC 9457 Problem Details); `PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN` (empty default = same-origin only; `*` or one origin enables CORS) governs `OPTIONS` `204` preflight and `Access-Control-Allow-Origin` / `Access-Control-Allow-Methods: GET, HEAD, OPTIONS` / `Access-Control-Allow-Headers: Authorization, Last-Event-ID` |
| Wire frame | `id: <epoch>:<seq>\nevent: <event>\ndata: <DaemonNotification JSON>\n\n` plus `: heartbeat\n\n` on open and every `PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS` (`15000` ms default; `0` disables periodic heartbeats) |
| Replay & resync | Sending `Last-Event-ID: <epoch>:<seq>` replays matching missed events from the per-boot ring buffer (`PLURNK_SERVICE_NOTIFICATIONS_BUFFER`, default `512`; `0` disables replay). When out of window, the server emits `id: <epoch>:<latestId>\nevent: notifications/resync` with `{"reason": "restarted" \| "evicted" \| "malformed", "epoch": "<hex>", "latestId": <n>}` before live events so reconnecting `EventSource` cursors advance |

## Discrete event alphabet (`DAEMON_NOTIFICATION_EVENTS`)

Every `data:` payload conforms to `@plurnk/plurnk-contracts/schema/DaemonNotificationEnvelope.json` (`{ id, event, timestamp, workspaceId, sessionId, data }`):

| Family | Event | `workspaceId` | `sessionId` | `data` shape |
| --- | --- | --- | --- | --- |
| Workspace | `workspace/created` | `<id>` | `null` | `{ id, name, projectRoot, projectLabel }` |
| Workspace | `workspace/renamed` | `<id>` | `null` | `{ id, name }` |
| Workspace | `workspace/archived` | `<id>` | `null` | `{ id, archivedAt }` |
| Functionality | `functionality/changed` | `<id>` | `<id> \| null` | `{ workspaceId, sessionId, family }` (`personas`, `members`, `env`, `skills`, `schedule`, `mcp`) |
| Session | `session/created` | `<id>` | `<id>` | `{ id, workspaceId, workspaceName, projectRoot, projectLabel, name, parentSessionId, origin, kind, lifecycle, persona? }` |
| Session | `session/archived` | `<id>` | `<id>` | `{ id, sessionIds, archivedAt }` |
| Session | `session/deleted` | `<id>` | `<id>` | `{ id, sessionIds }` |
| Session | `session/titled` | `<id>` | `<id>` | `{ id, title }` |
| Session | `session/policy` | `<id>` | `<id>` | `{ sessionId, model, childModel, persona? }` |
| Loop & gates | `loop/started` | `<id>` | `<id>` | `{ sessionId, loopId, loopSeq }` |
| Loop & gates | `loop/parked` | `<id>` | `<id>` | `{ sessionId, loopId, loopSeq, status }` |
| Loop & gates | `loop/proposal` | `<id>` | `<id>` | `ProposalProjection` (`disposition.decision === "review"` opens a client review gate) |
| Loop & gates | `loop/interaction` | `<id>` | `<id>` | `ClientInteractionProjection` |
| Loop & gates | `loop/gate-settled` | `<id>` | `<id>` | `{ kind: "proposal", sessionId, loopId, logEntryId, decision, outcome } \| { kind: "interaction", sessionId, loopId, interactionId, action }` |
| Loop & gates | `loop/terminated` | `<id>` | `<id>` | `{ sessionId, loopId, loopSeq, result, hitMaxTurns, turnIds, attributions, terminatedAt, usage }` |
| Journal & streams | `log/entry` | `<id>` | `<id>` | `{ entry: LogEntry }` (committed or settled row) |
| Journal & streams | `stream/concluded` | `<id>` | `<id>` | `{ sessionId, entryId, target, subscriptionId, result, scheme, summary, wakeAction, loopSeq?, turnSeq?, sequence? }` |
| Notices | `notice/event` | `<id>` | `<id> \| null` | `{ sessionId, loopId, notice }` (user-facing notices only; internal telemetry stays on `subscribeToRuntimeStream`) |
