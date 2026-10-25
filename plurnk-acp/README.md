# @plurnk/plurnk-acp

Standard ACP v2 (`@agentclientprotocol/sdk/experimental/v2/unstable`) server module for the PLURNK
daemon. It mounts `/acp` on the daemon's HTTP listener via `AcpServer`
(`@agentclientprotocol/sdk/experimental/server`), serving WebSocket and Streamable HTTP JSON-RPC 2.0
connections alongside HTTP entry and history resources under one OAuth 2.1 perimeter.

## Interface

`/acp` serves ACP v2 JSON-RPC 2.0 over WebSocket (`Upgrade: websocket`) and Streamable HTTP
(`POST /acp`, `GET /acp`, `DELETE /acp`), plus HTTP entry and history resources
(`GET /acp/<workspaceId>/<workerId>/entry`, `GET /acp/<workspaceId>/<workerId>/messages`) under
`{§acp-http-authorization}`.

A stock `@agentclientprotocol/sdk` v2 client needs only the endpoint and, when enabled, a bearer
token:

- `session/new` creates or attaches a workspace (`cwd`) and session worker, returning
  `configOptions` (`model`, `thought_level`, `spawn_model`, `mode`), `availableCommands` (`/mcp`,
  `/skills`, `/a2a`, `/members`, `/env`, `/schedule`, `/rollback`, `/share`, `/script`), and
  `_meta.plurnk`.
- `session/resume` reopens an existing conversation, replays its recent loop window as standard
  `session/update` notifications ({§acp-replay}, {§acp-history-window}), emits the current-state
  `state_update` snapshot and `usage_update`, and re-emits any pending `session/request_permission`
  or `elicitation/create` requests ({§acp-proposal-resolve}).
- `session/fork`, `session/list`, `session/delete`, `session/close`, `session/set_config_option`,
  `session/prompt`, `session/cancel`, `providers/list`, `providers/set`, `providers/disable`,
  `auth/login`, and `auth/logout` operate directly on the daemon's `ApplicationPort`
  ({§acp-thread-binding}, {§acp-thread-address}).

## Event Projection

Each attached session observes its bound worker and, by default, its delegated subagent tree
({§acp-topology-scope}, {§acp-subagents}) through standard ACP v2 `SessionUpdate` variants:

| Daemon evidence | Standard ACP v2 `SessionUpdate` |
| --- | --- |
| User message arrival | `user_message_chunk` |
| Model reasoning (`thinking`) | `agent_thought_chunk` ({§acp-readable-reasoning}) |
| Model reply (`SEND`, body-bearing `WAIT`, `outside/event`) | `agent_message_chunk` ({§acp-outside-text}) |
| Model operations (`READ`, `WRITE`, `EDIT`, `EXEC`, `NOTE`, etc.) | `tool_call_update` (`NOTE` is `kind: "think"`, file edits carry `Diff` content, obligation discharges update the opening `toolCallId` per {§acp-call-result}) |
| Live `sh://` execution streams | `terminal_update` and `terminal_output_chunk`, linked from `tool_call_update` via `{ type: "terminal", terminalId }` ({§acp-status-streams}) |
| Delegated child sessions | `subagent_update` and `session_message` / `session_message_chunk` ({§acp-status-descendants}) |
| Context window and spend | `usage_update` (`used`, `size`, `cost: { amount, currency: "USD" }`, {§acp-status-spend}) |
| Loop state transitions | `state_update` (`running`, `requires_action`, `idle` with `stopReason`, {§acp-run-outcome}) |
| Notices and non-conversation rows | `notice` (`severity: "info" \| "warning" \| "error"`, {§acp-ambient}) |
| Stopped-world proposals and interactions | `session/request_permission` (`subject: { type: "command" \| "tool_call" }`) and `elicitation/create` (`mode: "form" \| "url"`) + `$/cancel_request` on multi-peer race ({§acp-proposal-resolve}) |

## Integration

A browser or runtime-neutral client imports state and action-outcome types from
`@plurnk/plurnk-acp/client`, which requires no Node globals ({§acp-client-types}); the package root
is the server module ({§acp-daemon-client}).

## Development

```sh
npm run test -w @plurnk/plurnk-acp
```
