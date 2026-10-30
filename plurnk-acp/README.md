# @plurnk/plurnk-acp

Standard ACP v2 (`@agentclientprotocol/sdk/experimental/v2/unstable`) server module for the PLURNK
daemon. It mounts `/acp` on the daemon's HTTP listener via `AcpServer`
(`@agentclientprotocol/sdk/experimental/server`), serving WebSocket and Streamable HTTP JSON-RPC 2.0
connections alongside HTTP entry and history resources under one OAuth 2.1 perimeter.

## Interface

`/acp` serves ACP v2 JSON-RPC 2.0 over WebSocket (`Upgrade: websocket`) and Streamable HTTP
(`POST /acp`, `GET /acp`, `DELETE /acp`), plus HTTP entry and history resources
(`GET /acp/<workspaceId>/<sessionId>/entry`, `GET /acp/<workspaceId>/<sessionId>/messages`) under
{§acp-http-authorization}.

A stock `@agentclientprotocol/sdk` v2 client needs only the endpoint and, when enabled, a bearer
token:

- `session/new` creates or attaches a workspace (`cwd`) and session, returning
  `configOptions` (`model`, `thought_level`, `spawn_model`, `persona`, `mode`, plus any `<family>:<alias>` Functionality selectors), `availableCommands` (`/mcp`,
  `/skills`, `/members`, `/env`, `/schedule`, `/rollback`, `/share`, `/script`, `/update`), and
  `_meta.plurnk`.
- `session/resume` reopens an existing conversation, replays its recent loop window as standard
  `session/update` notifications ({§acp-history-window}), emits the current-state
  `state_update` snapshot and `usage_update`, and re-emits any pending `session/request_permission`
  or `elicitation/create` requests ({§acp-proposal-resolve}).
- `session/fork`, `session/list`, `session/delete`, `session/close`, `session/set_config_option`,
  `session/prompt`, `session/cancel`, `providers/list`, `mcp/message`, and `_plurnk/action`
  operate directly on the daemon's `ApplicationPort` ({§acp-daemon-client}).

## Event Projection

Each attached session observes its bound session and, by default, its delegated subagent tree
({§acp-topology-scope}) through standard ACP v2 `SessionUpdate` variants:

| Daemon evidence | Standard ACP v2 `SessionUpdate` |
| --- | --- |
| User message arrival | `user_message_chunk` |
| Model reasoning (`thinking`) | `agent_thought_chunk` ({§acp-plurnk-metadata}) |
| Model reply (`SEND`, body-bearing `WAIT`, `outside/event`) | `agent_message_chunk` ({§acp-plurnk-metadata}) |
| Model operations (`READ`, `EDIT`, `COPY`, `MOVE`, `KILL`, `FIND`, `NOTE`, runtime tags, etc.) | `tool_call_update` (`NOTE` is `kind: "think"`, file edits carry `Diff` content, obligation discharges update the opening `toolCallId` per {§acp-plurnk-metadata}) |
| Live `sh://` execution streams | `terminal_update` and `terminal_output_chunk`, linked from `tool_call_update` via `{ type: "terminal", terminalId }` ({§acp-status-descendants}) |
| Delegated child sessions | `subagent_update` and `session_message` / `session_message_chunk` ({§acp-status-descendants}) |
| Context window and spend | `usage_update` (`used`, `size`, `cost: { amount, currency: "USD" }`, {§acp-status-descendants}) |
| Loop state transitions | `state_update` (`running`, `requires_action`, `idle` with `stopReason`, {§acp-plurnk-metadata}) |
| Notices and non-conversation rows | `notice` (`severity: "info" \| "warning" \| "error"`, {§acp-plurnk-metadata}) |
| Stopped-world proposals and interactions | `session/request_permission` (`subject: { type: "command" \| "tool_call" }`) and `elicitation/create` (`mode: "form" \| "url"`) + `$/cancel_request` on multi-peer race ({§acp-proposal-resolve}) |

## Integration

A browser or runtime-neutral client imports state and action-outcome types from
`@plurnk/plurnk-acp/client`, which requires no Node globals ({§acp-daemon-client}); the package root
is the server module ({§acp-daemon-client}).

## Development

```sh
npm run test -w @plurnk/plurnk-acp
```
