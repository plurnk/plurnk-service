# @plurnk/plurnk-acp — ACP v2 Server Module Specification

The module is the daemon's Standard ACP v2 (`@agentclientprotocol/sdk/experimental/v2/unstable`)
server interface. It consumes the contracts-owned {§application-port} and mounts `/acp` on the
daemon's listener via `AcpServer` (`@agentclientprotocol/sdk/experimental/server`), serving
Streamable HTTP and WebSocket JSON-RPC 2.0 connections alongside HTTP entry and history resources
under one OAuth 2.1 perimeter. Core's numbers and semantics pass through verbatim; the module
introduces no parallel lifecycle dialect or custom `sessionUpdate` variants.

## 1. Architecture and Session Binding

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-daemon-client} | The module is a discovered module of the daemon. |
| {§acp-client-types} | A client's contracts are runtime-neutral. |
| {§acp-listener-admission} | Bound is not ready. |
| {§acp-thread-binding} | An ACP session binds a workspace and session worker. |
| {§acp-run-authority} | Standard ACP v2 owns the protocol surface. |
| {§acp-thread-address} | A qualified session address is `<workspace ID>#<session name>`: |
<!-- /map -->

- §acp-daemon-client **The module is a discovered module of the daemon.** The package declares
  `plurnk: { kind: "module", module: "./module" }` and the daemon discovers it
  ({§module-discovery}); nothing composes it by hand. It claims only `/acp` on the daemon's single
  HTTP/WebSocket listener ({§http-host}, {§module-http-mounts}) and owns no separate socket or
  `stdio` transport. Its `setup` registers the `acp` `MessageScheme`, and its `start` seam is
  {§application-port}. A daemon without a listener leaves it out.
- §acp-client-types **A client's contracts are runtime-neutral.** `@plurnk/plurnk-acp/client`
  exports runtime-neutral types for the `_meta.plurnk` state and action outcomes a client consumes.
  A browser type-checks it with DOM libraries and no Node globals ({§runtime-neutral-root}); lint
  checks its whole source graph that way (`tsconfig.browser.json`). The package root is the server
  module.
- §acp-listener-admission **Bound is not ready.** The socket is core's
  ({§startup-listener-admission}): bound before durable-state admission and answering a retryable
  `503 service-starting` until daemon activation admits it after every module has started
  ({§module-http-mounts}). This module mounts `/acp` at `start`, so no request reaches it before its
  port is installed; from `stop` it answers `503 service-stopping`.
- §acp-thread-binding **An ACP session binds a workspace and session worker.** `session/new`,
  `session/resume`, `session/fork`, `session/list`, `session/delete`, and `session/close` resolve
  their workspace from `cwd` (`AbsolutePath`), `_meta.plurnk.workspace`, or a qualified `sessionId`
  (`<workspaceId>#<sessionName>`, {§acp-thread-address}). `session/prompt`, `session/cancel`,
  `session/fork`, `session/set_config_option`, and `session/delete` operate on the bound session
  worker. Extended context persists across prompts because the session's log is durable.

  | Fact | Rule |
  | --- | --- |
  | Qualified address (`<workspaceId>#<name>`) | Resolves directly to that immutable workspace ID and model worker name ({§acp-thread-address}). |
  | Workspace selection by `cwd` or `_meta.plurnk.workspace` | `session/new` attaches or creates the workspace for `cwd` (or `_meta.plurnk.workspace`); `session/resume` and `session/list` attach an existing workspace and return `404 workspace-not-found` when absent. |
  | Session name resolution | Resolves among model-origin workers only (forks and earlier sessions are addressable; the runtime actor `_plurnk` is never bound as a conversation session). `session/new` creates the session worker; `session/resume` attaches an existing session worker (unless `_meta.plurnk.create === true`) and returns `404 session-not-found` when absent. |
  | Opaque `sessionId` | Without a workspace qualifier, an opaque `sessionId` resolves through core's `acp` worker reference ({§worker-external-reference}) or as a worker name within the `cwd` workspace. |
  | Process-local bindings | Key on `(workspaceId, workerId)`; equal session names in different workspaces never share an envelope, replay, state, or active loop. |
  | Concurrent first requests | Workspace acquisition is serialized across sessions, retaining each request's create/attach contract; failed acquisitions leave no stale cache entry. |

- §acp-run-authority **Standard ACP v2 owns the protocol surface.** `initialize` negotiates
  `protocolVersion: 2` (`PROTOCOL_VERSION` from `@agentclientprotocol/sdk/experimental/v2/unstable`)
  and advertises `agentCapabilities` (`promptCapabilities: { image: true, embeddedContext: true }`,
  `sessionCapabilities: { list: {}, resume: { replay: true }, fork: {}, close: {}, delete: {}, configOptions: {} }`,
  `providerCapabilities: { list: {}, set: {}, disable: {} }`, `mcpCapabilities: { http: true, sse: false }`).
  Every client-to-agent request, agent-to-client request, and `session/update` notification uses
  standard ACP v2 types from `@agentclientprotocol/sdk/experimental/v2/unstable`; Plurnk facts
  about a standard item ride its `_meta.plurnk` ({§acp-plurnk-metadata}).
- §acp-thread-address **A qualified session address is `<workspace ID>#<session name>`:** a
  canonical positive, safe decimal integer and a native model-worker name. A string beginning with
  decimal digits then `#` reserves this grammar; leading zeroes, an out-of-range ID, or an invalid
  worker name fail with `400 session-address-invalid`. Qualified IDs always select the immutable
  workspace ID.

## 2. Approval Ownership and Connection Lifetime

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-worker-owner} | The ACP owner is `acp://operator`, scoped by workspace. |
| {§acp-owner-activation} | An owner's arrival activates its workspace. |
| {§acp-run-disconnect} | A disconnect ends delivery, never work. |
| {§acp-owner-connection} | Persistent observation. |
| {§acp-held-interrupts} | A session that holds an active gate waits on it without duplicate presentation. |
| {§acp-shutdown} | Shutdown releases every remaining connection. |
<!-- /map -->

§acp-worker-owner **The ACP owner is `acp://operator`, scoped by workspace.** Every ACP session in
the workspace shares it. Control attachment registers `acp://operator` with core's
`request_approval` capability ({§worker-ownership}) plus any client-declared `_meta.plurnk.tools`,
and claims the bound session worker and its model descendants; passive observation
(`_meta.plurnk.control === false`) claims nothing.

| Request | Ownership effect |
| --- | --- |
| `session/new`, `session/prompt` ({§acp-run-input}), or a permission / elicitation response | Control attachment for the bound session worker ({§acp-action-binding}). |
| `session/resume` with `_meta.plurnk.control !== false` | Control attachment without model inference. |
| Passive `session/resume` (`_meta.plurnk.control === false`), `session/list`, or client operations ({§acp-client-operation}) | No claim and no capability replacement. |

§acp-owner-activation **An owner's arrival activates its workspace.** A control attachment starts
the workspace's Functionality activation ({§methods-workspace-activate}) asynchronously without
blocking the session response; a subsequent prompt waits only for what remains of that activation.
Passive observation activates nothing.

§acp-run-disconnect **A disconnect ends delivery, never work.** Once Core has admitted a prompt,
permission resolution, or client operation, closing the WebSocket or HTTP stream that submitted it
cancels nothing and changes nothing about its owner, permissions, execution state, or accounting.
Only an explicit `session/cancel` ({§methods-loop-cancel}) or the work's own conclusion ends it.
`session/close` detaches the calling connection's observation of `sessionId` without cancelling or
deleting the durable session.

§acp-owner-connection **Persistent observation.** A connection attached to a session via
`session/new`, `session/resume`, or `session/fork` receives live `session/update` notifications,
`session/request_permission` requests, and `elicitation/create` requests for that session until
`session/close` or connection close.

§acp-held-interrupts **A session that holds an active gate waits on it without duplicate
presentation.** Each peer connection tracks the pending permission and elicitation requests it has
sent (`pendingGates`), never sending the same gate twice to the same peer. When `session/cancel` is
received for a session, the module calls `ApplicationPort.cancelWorker` (and `cancelLoop` if a
client slash-command operation is running).

§acp-shutdown **Shutdown releases every remaining connection.** Module `stop` refuses new requests
with `503 service-stopping` while admitted requests retain terminal delivery. In `close`, after core
settlement ({§module-shutdown-order}), the module closes its `AcpServer` and all active WebSocket
and HTTP streams, returning once every admitted request has settled ({§module-route-settlement}).
Repeated closure is inert.

## 3. Bodies by Reference and Entry Route

§acp-body-reference **Bodies travel by reference when stripped or past the character ceiling.** A
tool receipt whose result carries a body (`content`, a non-empty string) projects to
`tool_call_update` with two `ToolCallContent` blocks: a text block containing the receipt metadata
without its body, and a `resource_link` block (`{ type: "content", content: { type: "resource_link", uri, name, mimeType } }`)
whose `uri` points to the entry route ({§acp-entry-route}). For file edits carrying `original` and
`patched` text in `attrs`, `tool_call_update` also includes a standard ACP v2 `Diff` block
(`{ type: "diff", path, oldText, newText }`). Line anchors (`lineAnchors`, `lineAnchorIdentity`,
`lineNumberWidth`) are stripped from client-facing receipts.

§acp-entry-route **An address at this daemon has one HTTP form:**
`<origin>/acp/<workspaceId>/<workerId>/entry?target=<address>[&channel=<ch>&offset=<n>]`. `GET` at
this route is admitted under the same bearer perimeter as `/acp` ({§acp-http-authorization}) and
answers the selected channel ({§methods-entry-channel-read}) as
`content-type: <mimetype>; charset=utf-8` with `cache-control: no-store`. A request without
`target` fails with `400 entry-target-required`.

## 4. Standard ACP v2 Event Projection

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-call-result} | `log/entry` that discharges an obligation ({§methods-invocation}) — `tool_call_update` updating the opening… |
| {§acp-parse-refusal} | `log/entry` model `error` row, a parse refusal — `tool_call_update` (`status: "failed"`, `kind: "other"`,… |
| {§acp-progress-reply} | `log/entry` reply reporting progress on a message this worker sent ({§methods-answering}) —… |
| {§acp-outside-text} | `outside/event` — `agent_message_chunk` carrying `text` and `_meta.plurnk.outside: { coordinate, tokens }`… |
| {§acp-run-outcome} | `loop/terminated` — `usage_update` followed by `state_update` (`state: "idle"`, `stopReason: "end_turn" \ |
| {§acp-lifecycle-projection} | Lifecycle, memory, and speech remain distinct. |
| {§acp-readable-reasoning} | Readable provider reasoning uses ACP's standard `agent_thought_chunk` channel. |
| {§acp-reasoning-link} | A session may negotiate its reasoning by link. |
| {§acp-encrypted-reasoning} | The encrypted-reasoning interface is not implemented. |
| {§acp-plurnk-metadata} | Plurnk facts ride standard `_meta.plurnk`. |
| {§acp-status-descendants} | The subagent tree is the daemon's, never inferred. |
| {§acp-status-spend} | Spend is the daemon's cumulative accounting, passed through on `usage_update`. |
| {§acp-status-streams} | Open execution streams project as ACP v2 terminals. |
| {§acp-status-timing} | A loop's timing travels with the loop's identity. |
| {§acp-numbers-passthrough} | Gauge numbers pass through verbatim. |
| {§acp-state-patches} | Session state metadata is consistent across initial responses and live `usage_update` notifications. |
| {§acp-provider-routes} | `_meta.plurnk.providers[*]` — `ApplicationPort.listProviders().aliases[*]` |
| {§acp-status-model} | `_meta.plurnk.status.model` — `ApplicationPort.readWorkerModel` |
| {§acp-status-loop-number} | `_meta.plurnk.status.loopSeq` — `ApplicationLoopProjection.sequence` |
| {§acp-status-wait} | `_meta.plurnk.status.waitUntil` — `ApplicationLoopProjection.waitUntil` |
| {§acp-workspace-state} | `_meta.plurnk.workspace` — Client envelope + `workspacePreparationStatus` + `workspaceDerivationStatus` |
| {§acp-cost-evidence} | Complete provider accounting is preserved. |
| {§acp-ambient} | Non-conversation rows project as standard `notice` updates. |
| {§acp-run-start} | Session responses start with authoritative state. |
<!-- /map -->

Every daemon log entry and runtime notification projects to standard ACP v2 `SessionUpdate`
variants on `session/update`:

| Daemon source | Standard ACP v2 `SessionUpdate` |
| --- | --- |
| `session/new`, `session/resume`, `session/fork` | Response carrying `configOptions`, `availableCommands`, and `_meta.plurnk`; `session/resume` emits a current-state `state_update` snapshot (`idle` \| `running` \| `requires_action`) and `usage_update` before returning. |
| `log/entry` arrival (`_plurnk` SEND, `kind=message`) | `user_message_chunk` under the sender's `messageId` (or coordinate when external) with `_meta.plurnk`. |
| `log/entry` WAIT (model) | A WAIT carrying a body emits `agent_message_chunk` with the body as written and its receipt in `_meta.plurnk`; a bodiless WAIT emits `tool_call_update` (`kind: "other"`). |
| Successful SEND replying to this session | Optional `agent_thought_chunk` ({§acp-readable-reasoning}), then `agent_message_chunk` with `_meta.plurnk`. |
| `log/entry` model operation (`READ`, `WRITE`, `EDIT`, `COPY`, `MOVE`, `KILL`, `FIND`, `NOTE`, `WORK`, `FORK`, `EXEC`, scheme calls) | Optional turn `agent_thought_chunk` ({§acp-readable-reasoning}), then `tool_call_update` (`toolCallId: coordinate`, `kind`, `title`, `locations`, `rawInput`, `rawOutput`, `content`, `status: "completed" \| "failed" \| "in_progress"`). `NOTE` maps to `kind: "think"`. |
| §acp-call-result `log/entry` that discharges an obligation ({§methods-invocation}) | `tool_call_update` updating the opening call's `toolCallId` to `status: "completed" \| "failed"` with the discharging receipt and `_meta.plurnk.coordinate` naming the discharging row. |
| §acp-parse-refusal `log/entry` model `error` row, a parse refusal | `tool_call_update` (`status: "failed"`, `kind: "other"`, `rawInput: { text }`) when `attrs.attempt.verb` is present; otherwise a `notice` (`severity: "warning"`, {§acp-ambient}). |
| §acp-progress-reply `log/entry` reply reporting progress on a message this worker sent ({§methods-answering}) | `user_message_chunk` named by its source; a reply that completes the message updates the opening call via `tool_call_update` ({§acp-call-result}). |
| `reasoning/event` | Live `agent_thought_chunk` deltas ({§acp-readable-reasoning}), or `resource_link` when reasoning-by-link was negotiated ({§acp-reasoning-link}). |
| §acp-outside-text `outside/event` | `agent_message_chunk` carrying `text` and `_meta.plurnk.outside: { coordinate, tokens }` ({§notifications-outside-event}), once per admitted emission for the bound session worker; foreign-worker text never enters the session. |
| `stream/event` + `stream/concluded` (`sh://` execution streams) | The opening `tool_call_update` includes `{ type: "terminal", terminalId }`; live stream events emit `terminal_update` (`terminalId`, `command`, `cwd`, `exitStatus`) and `terminal_output_chunk` (`terminalId`, base64 `data`, `_meta.plurnk.stream`) ({§acp-status-streams}, {§acp-stream-producer}). |
| `loop/packet` | `usage_update` (`used`, `size`, `cost`, `_meta.plurnk`) and `state_update` (`state: "running"`). |
| §acp-run-outcome `loop/terminated` | `usage_update` followed by `state_update` (`state: "idle"`, `stopReason: "end_turn" \| "max_turn_requests" \| "cancelled" \| "refusal" \| "error"`), carrying the daemon's complete terminal record in `_meta.plurnk.terminal` ({§acp-plurnk-metadata}) and physical-request accounting ({§acp-cost-evidence}). |
| `notice/event` and `workspace/preparation` | Standard ACP v2 `notice` (`severity: "info" \| "warning" \| "error"`, `title`, `description`, `_meta.plurnk`). |

§acp-lifecycle-projection **Lifecycle, memory, and speech remain distinct.** Live updates, replay,
and log reads preserve literal native bodies. `NOTE` is a `tool_call_update` (`kind: "think"`),
never assistant speech or reasoning; `WAIT` without a body is a `tool_call_update`; `SEND` to the
session is `agent_message_chunk`; loop completion is `state_update` (`state: "idle"`).

§acp-readable-reasoning **Readable provider reasoning uses ACP's standard `agent_thought_chunk`
channel.** A `{§notifications-reasoning-event}` for the bound worker projects each delta immediately
as `agent_thought_chunk` with `messageId: "model-call-<call>/request-<n>/reasoning"`. A retried
request receives a distinct `messageId`. When a turn's first model operation row carries durable
`reasoning` ({§methods-readable-reasoning}) that was not already streamed live to the peer, it is
emitted once as `agent_thought_chunk` before that row's `tool_call_update`.

§acp-reasoning-link **A session may negotiate its reasoning by link.** When `_meta.plurnk.reasoning`
is `"link"`, `agent_thought_chunk` carries a `resource_link` content block pointing to
`reasoning://<worker>/L/T` at the entry route ({§acp-entry-route}) instead of inline text; any value
other than `"inline"` or `"link"` fails with `400 reasoning-invalid`.

- §acp-encrypted-reasoning **The encrypted-reasoning interface is not implemented.** Plurnk emits
  and stores no encrypted reasoning bytes ({§provider-open-reasoning}).
- §acp-plurnk-metadata **Plurnk facts ride standard `_meta.plurnk`.** Every standard ACP v2
  response and `session/update` notification carries its Plurnk provenance in `_meta.plurnk` without
  inventing custom `sessionUpdate` types:
  - On row-derived updates (`tool_call_update`, `agent_message_chunk`, `user_message_chunk`, `notice`):
    `withoutBodies(attrs)` (`original`, `patched`, `patchedBytes`, `patch`, `editReceipt`, `body`,
    `inputBody` stripped) and `addressOf(op, attrs)` ({§methods-log-entry-wire}).
  - On `usage_update` and session responses: `{ status, budget, workspace, providers }`.
  - On `state_update` (`state: "idle"`): `{ terminal }` with the complete `loop/terminated` payload.
  - On `RequestError.data`: `{ problem }` with exact RFC 9457 Problem Details ({§acp-http-failure}).

§acp-status-descendants **The subagent tree is the daemon's, never inferred.** Child workers beneath
the bound session worker are projected from `ApplicationPort.listWorkers`, `pendingProposals`, and
`pendingClientInteractions` as standard ACP v2 `subagent_update` notifications (`sessionId:
"<workspaceId>#<name>"`, `title: name`, `state: "running" | "idle" | "requires_action"`,
`capabilities: { cancel: {} }`, `_meta.plurnk: { id, name, parentWorkerId, kind, lifecycle, gates }`),
and summarized in `_meta.plurnk.status.descendants` on session responses and `usage_update`.

§acp-status-spend **Spend is the daemon's cumulative accounting, passed through on `usage_update`.**
`ApplicationPort.workerAccounting({ workspaceId, workerId })` ({§methods-worker-accounting})
populates `usage_update.cost` (`{ amount: costUsd, currency: "USD" }` when known) and
`_meta.plurnk.status.spend` (`{ requests, usage, knownUsage, costUsd, knownCostUsd }`).

§acp-status-streams **Open execution streams project as ACP v2 terminals.** Each active `sh://`
stream from `ApplicationPort.readStreams` ({§methods-worker-streams}) projects as a `terminal_update`
(`terminalId`, `command`, `cwd`, `exitStatus`) and `terminal_output_chunk` (`terminalId`, base64
`data`), linked from its opening `tool_call_update` via `ToolCallContent`
`{ type: "terminal", terminalId }`, and is listed in `_meta.plurnk.status.streams`.

§acp-status-timing **A loop's timing travels with the loop's identity.**
`_meta.plurnk.status.claimedAt` and `terminatedAt` carry the latest loop's Unix-millisecond
timestamps from `ApplicationPort.listWorkerLoops` ({§application-loop-observation}), or `null`
until they occur.

§acp-numbers-passthrough **Gauge numbers pass through verbatim.** `usage_update.used` (`contextTokens`
or `curationWeight`) and `usage_update.size` (`contextCapacity` or `curationBudget`) and
`_meta.plurnk.budget` (`{ curationWeight, curationBudget, contextTokens, contextCapacity }`) pass
through from `ApplicationPort.workerGauge` without recomputation.

§acp-state-patches **Session state metadata is consistent across initial responses and live
`usage_update` notifications.**

| Metadata path | Daemon source | Meaning |
| --- | --- | --- |
| §acp-provider-routes `_meta.plurnk.providers[*]` | `ApplicationPort.listProviders().aliases[*]` | Each declared alias as `{ alias, provider, model, effort, effortSource, active, inputCapacity }`, also exposed via `providers/list`. |
| §acp-status-model `_meta.plurnk.status.model` | `ApplicationPort.readWorkerModel` | The bound worker's durable resolved model route, also exposed as the `model` and `spawn_model` `SessionConfigOption` entries and updated via `config_option_update`. |
| §acp-status-loop-number `_meta.plurnk.status.loopSeq` | `ApplicationLoopProjection.sequence` | The active or latest loop's sequence number `L`, or `null` when `loopId` is `null`. |
| §acp-status-wait `_meta.plurnk.status.waitUntil` | `ApplicationLoopProjection.waitUntil` | Absolute Unix-millisecond observation deadline while parked, otherwise `null`. |
| §acp-workspace-state `_meta.plurnk.workspace` | Client envelope + `workspacePreparationStatus` + `workspaceDerivationStatus` | `{ id, name, projectRoot, projectLabel, preparation, activity }`. |

§acp-cost-evidence **Complete provider accounting is preserved.** `usage_update` carries token gauge
and cost, while `_meta.plurnk.terminal.usage.accounting` on the terminal `state_update` preserves
the daemon's ordered physical-request accounting records verbatim ({§provider-accounting}).

§acp-ambient **Non-conversation rows project as standard `notice` updates.** Rows outside standard
messages and tool calls (foists, deltas, narrations, rejected emission attempts, and verb-less parse
refusals) project as `session/update` `notice` (`severity: "info" | "warning" | "error"`, `title`,
`description`) with the row's bodyless facts in `_meta.plurnk` ({§acp-plurnk-metadata}).

§acp-run-start **Session responses start with authoritative state.** `session/new`, `session/resume`,
and `session/fork` return `configOptions` (`model`, `thought_level`, `spawn_model`, `mode`),
`availableCommands`, and `_meta.plurnk` carrying the workspace, providers, status, and budget.

## 5. Replay and History Pagination

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-replay} | `session/resume` replays the recent loop window before returning. |
| {§acp-sync} | Synchronization is an inference-free session attachment. |
| {§acp-snapshot} | A replay page is the exact `session/update` sequence the live projection built. |
| {§acp-history-window} | A session replay holds the bound worker's newest `PLURNK_ACP_HISTORY_LOOPS` loops, bounded by… |
| {§acp-history-page} | History before the window travels one HTTP `GET` page at a time. |
| {§acp-loop-page} | A loop travels whole by its sequence number. |
| {§acp-history-advance} | Each `session/resume` computes the current bounded window |
| {§acp-words-by-reference} | Words exceeding `PLURNK_ACP_HISTORY_PAGE_CHARS` travel by reference. |
<!-- /map -->

§acp-replay **`session/resume` replays the recent loop window before returning.** When
`session/resume` is called (with `replayFrom` or default replay), the module emits the bound
worker's recent conversation window as `session/update` notifications ({§acp-snapshot},
{§acp-history-window}), followed by current `usage_update`, `state_update`, and any pending
`session/request_permission` or `elicitation/create` requests ({§acp-proposal-resolve}).

§acp-sync **Synchronization is an inference-free session attachment.** `session/resume` attaches and
replays without submitting a prompt, creating a turn, or performing model inference.

§acp-snapshot **A replay page is the exact `session/update` sequence the live projection built.**
Replay emits `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, and
`tool_call_update` notifications in log order under their live identities and `_meta.plurnk`
metadata, pairing each obligation-discharge `tool_call_update` after its opening call
({§acp-call-result}). Unobserved inbox messages sent on the session follow as `user_message_chunk`
with `_meta.plurnk.published: false` ({§acp-message-acceptance}).

§acp-history-window **A session replay holds the bound worker's newest `PLURNK_ACP_HISTORY_LOOPS`
loops, bounded by `PLURNK_ACP_HISTORY_PAGE_CHARS`.** Cuts occur between whole turns unless a single
turn exceeds the character ceiling. `_meta.plurnk.history.older` holds the URL of the preceding
history page, or `null` when the window contains the beginning of the conversation.

§acp-history-page **History before the window travels one HTTP `GET` page at a time.** `GET` at
`<origin>/acp/<workspaceId>/<workerId>/messages?session=<sessionId>&before=<cursor>` is admitted
under {§acp-http-authorization} and returns `{ final, updates, hasMore, beforeLoopSeq, older }` as
`application/json` with `cache-control: no-store`. Missing `session` fails with `400
history-session-required`; an unknown cursor fails with `404 history-cursor-not-found`.

§acp-loop-page **A loop travels whole by its sequence number.** `GET` at
`<origin>/acp/<workspaceId>/<workerId>/messages?session=<sessionId>&loop=<sequence>` returns that
loop's complete `updates` array without character-ceiling truncation. Invalid `loop` parameters fail
with `400 history-loop-invalid`; an absent loop sequence fails with `404 history-loop-not-found`.

§acp-history-advance **Each `session/resume` computes the current bounded window** of at most
`PLURNK_ACP_HISTORY_LOOPS` loops and `PLURNK_ACP_HISTORY_PAGE_CHARS` characters and links prior
items via `_meta.plurnk.history.older`.

§acp-words-by-reference **Words exceeding `PLURNK_ACP_HISTORY_PAGE_CHARS` travel by reference.**
When a message or reply body exceeds the character ceiling, its update carries a `resource_link`
content block pointing to `/acp/<workspaceId>/<workerId>/entry?target=<address>`
({§acp-body-reference}) instead of truncating or omitting the text.

## 6. Session Directory (`session/list`)

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-overview} | `session/list` provides the daemon and workspace session directory. |
| {§acp-overview-run} | `session/list` inspects without side effects. |
| {§acp-overview-state} | Each `SessionInfo` entry carries structured Plurnk overview state |
| {§acp-overview-updates} | Live directory updates use `session_info_update`. |
<!-- /map -->

§acp-overview **`session/list` provides the daemon and workspace session directory.** Calling
`session/list` (`ListSessionsRequest: { cwd?, cursor?, _meta? }`) reads
`ApplicationPort.readWorkerOverview` and `listWorkers` without binding or creating a worker
({§acp-overview-run}), returning `ListSessionsResponse: { sessions: SessionInfo[], nextCursor?, _meta }`
where each `SessionInfo` carries `{ sessionId: "<workspaceId>#<name>", cwd, title, updatedAt, _meta: { plurnk: { workspaceId, workerId, kind, lifecycle, gates, reply } } }`
({§acp-overview-state}), bounded by `PLURNK_ACP_OVERVIEW_WORKERS` and `PLURNK_ACP_EXCERPT_CHARS`.
When a session's title or status changes while observed, `session_info_update` notifies attached
peers ({§acp-overview-updates}).

- §acp-overview-run **`session/list` inspects without side effects.** It binds no worker, creates no
  workspace, claims no ownership, and triggers no model inference. An invalid `_meta.plurnk.workspaceId`
  fails with `400 overview-invalid`; an unknown workspace fails with `404 workspace-not-found`.
- §acp-overview-state **Each `SessionInfo` entry carries structured Plurnk overview state** in
  `_meta.plurnk`, with the latest finished reply excerpt bounded to `PLURNK_ACP_EXCERPT_CHARS` and
  its full words linked by reference at the entry route ({§acp-entry-route}).
- §acp-overview-updates **Live directory updates use `session_info_update`.** When a bound session's
  metadata or lifecycle updates, the module emits `session_info_update` to attached peers.

## 7. First-Party and Stock Client Conformance

§acp-first-party-client-conformance **The platform gate verifies `@plurnk/plurnk` against the built
daemon.**

§acp-official-client-conformance The integration gate runs a stock `@agentclientprotocol/sdk` v2
client (`ClientApp` over `createWebSocketStream` and `createHttpStream`) against the daemon and a
deterministic model fixture, exercising `initialize`, `session/new`, `session/resume`,
`session/fork`, `session/list`, `session/delete`, `session/close`, `session/prompt`,
`session/cancel`, `session/set_config_option`, `providers/list`, `session/request_permission`,
`elicitation/create`, streaming `agent_thought_chunk`, `agent_message_chunk`, `tool_call_update`,
`terminal_update`, `subagent_update`, `usage_update`, and `notice`. The installed-client gate checks
`PLURNK_CLIENT_CHECKOUT` (defaulting to `../plurnk`) against the packed release.

## 8. Human-in-the-Loop: Permissions and Elicitations

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-proposal-resolve} | Stopped-world proposals and client interactions use standard ACP v2 `session/request_permission` and… |
| {§acp-gate-deferral} | A gate is tracked per peer and cancelled across peers once settled. |
| {§acp-message-before-gate} | A message submitted via `session/prompt` is durable before a pending gate is re-presented. |
| {§acp-resume-before-gate} | Gate resolutions are validated at Core's boundary. |
| {§acp-proposal-disposition} | ACP consumes Core's `ProposalProjection` identically for live delivery and `session/resume` replay. |
<!-- /map -->

§acp-proposal-resolve **Stopped-world proposals and client interactions use standard ACP v2
`session/request_permission` and `elicitation/create`.** When a session worker (or an observed
descendant owned by `acp://operator`) pauses on a `ProposalProjection` (`disposition: "review"`) or
`ClientInteractionProjection`, the module transitions the session to
`state_update: { state: "requires_action" }` and sends the corresponding standard ACP v2 request to
every peer observing the owning session:

- **Proposals (`session/request_permission`):**
  - `sh` command proposals use `subject: { type: "command", command, cwd }` from `ProposalProjection.subject`
  - File, scheme, and MCP proposals use `subject: { type: "tool_call", toolCall }` derived from `ProposalProjection.subject`
  - `options`: all 4 standard ACP v2 permission options with `optionId === kind`:
    `allow_once`, `allow_always`, `reject_once`, and `reject_always`
  - `_meta.plurnk.proposal`: the `ProposalProjection`
  - Answering with `outcome: { outcome: "selected", optionId }` calls
    `ApplicationPort.resolveProposal(logEntryId, { decision, scope, outcome }, owner)`, where
    `allow_always` and `reject_always` pass `scope: "always"` so Core atomically updates the
    workspace's `capabilities.allow` or `capabilities.deny` policy. Answering with
    `outcome: { outcome: "cancelled" }` cancels the proposal.
- **Client Interactions (`elicitation/create`):**
  - `question/ask` and structured form interactions use `mode: "form"` with `elicitationId`,
    `scope: { type: "session", sessionId }`, `message`, and `requestedSchema`
  - OAuth consent URLs use `mode: "url"` with `elicitationId`,
    `scope: { type: "session", sessionId }`, `message`, and `url`
  - Answering calls `ApplicationPort.resolveClientInteraction` and emits `elicitation/complete`
    (`{ elicitationId }`).

§acp-gate-deferral **A gate is tracked per peer and cancelled across peers once settled.** When any
peer or Core settles a proposal or interaction, the module sends standard JSON-RPC
`$/cancel_request` (`methods.protocol.cancelRequest`) for that request ID to all other peers where
the request was in flight and emits `state_update: { state: "running" }`.

§acp-message-before-gate **A message submitted via `session/prompt` is durable before a pending gate
is re-presented.** `session/prompt` delivers its prompt through `ApplicationPort.runLoop` so Core
holds it in the worker's inbox; the prompt is never discarded when a gate is pending.

§acp-resume-before-gate **Gate resolutions are validated at Core's boundary.** Invalid outcomes or
already-settled gates fail with their exact RFC 9457 Problem Details (`400 interrupt-invalid`,
`409 interrupt-not-pending`, `403 proposal-not-owned`) without releasing stopped work.

§acp-proposal-disposition **ACP consumes Core's `ProposalProjection` identically for live delivery
and `session/resume` replay.** Only `disposition: "review"` becomes a `session/request_permission`
request; `accept` and `reject` are Core's automatic settlements.

## 9. Configuration Options, Available Commands, and Module Actions

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-management-plane} | Configuration, slash commands, and module actions share one schema-validated plane. |
| {§acp-worker-loops} | `worker.loops` — Workspace |
| {§acp-place-hiding} | Directories omit hidden workspaces and sessions. |
| {§acp-action-binding} | Each request binds only the resources its scope requires. |
| {§acp-client-operation} | `/script` (`op.parse`) executes in the workspace's runtime worker (`_plurnk`). |
| {§acp-worker-model-actions} | Session model selection is server-backed. |
| {§acp-worker-effort-actions} | Session reasoning effort is server-backed. |
| {§acp-module-action-scope} | Extension module actions share the same schema-validated dispatch plane. |
| {§acp-op-parse} | Parsed-operation projection (`/script` / `op.parse`). |
| {§acp-module-actions} | One public action namespace. |
| {§discovery} | Discovery contract. |
| {§acp-stream-producer} | Stream updates route to the initiating worker. |
<!-- /map -->

§acp-management-plane **Configuration, slash commands, and module actions share one schema-validated
plane.**

- **Session Configuration (`configOptions` and `session/set_config_option`):**
  Every session advertises `SessionConfigOption[]` entries for `model` (`category: "model"`),
  `thought_level` (`category: "thought_level"`), `spawn_model` (`category: "model_config"`), and `mode`
  (`category: "mode"`, workspace capability policy `propose` | `allow` | `deny`), plus boolean
  toggles `<family>:<alias>` (`mcp`, `skills`, `a2a`, `schedule`) and `providers/list`,
  `providers/set`, and `providers/disable`.
- **Available Slash Commands (`availableCommands` on `session/prompt`):**
  Every session advertises `AvailableCommand[]` entries for `/mcp`, `/skills`, `/a2a`, `/members`,
  `/env`, `/schedule`, `/rollback`, `/share`, and `/script`. Submitting `/<command> ...` via
  `session/prompt` executes the command under ACP v2's local-command lifecycle
  (`state_update: { state: "running" }` → `agent_message_chunk` / `notice` →
  `state_update: { state: "idle", stopReason: "end_turn" }`).
- **Typed Extension Method (`_plurnk/action`):**
  Programmatic callers and conformance suites may also invoke registered actions directly via the
  ACP v2 `ExtensionMethod` `_plurnk/action` (`{ kind, params, sessionId?, workspace?, workspaceId?, workerId?, workerName? }`).

| Action | Scope | Owner / Effect |
| --- | --- | --- |
| `ping` | Daemon | Liveness check; returns `{}`. |
| `discover` | Daemon | Returns the complete `AcpDiscovery` manifest ({§discovery}). |
| `models.list` | Daemon | `ApplicationPort.listModels` ({§model-catalog}). |
| `workspace.list` / `workspace.create` / `workspace.attach` / `workspace.rename` / `workspace.hide` | Daemon / Workspace | Workspace lifecycle on `ApplicationPort` ({§acp-place-hiding}). |
| §acp-worker-loops `worker.loops` | Workspace | `ApplicationPort.listWorkerLoops`, each loop in sequence order as `{ id, sequence, lifecycle, source, opening, continued }` with `opening` bounded to `PLURNK_ACP_EXCERPT_CHARS`. |
| `log.read` / `entry.read` / `workspace.prompts` | Workspace | `ApplicationPort.readLog`, `readEntry`, and `listPrompts`. |
| `workspace.share` (`/share`) | Workspace | `ApplicationPort.shareWorkspace`. |
| `workspace.rollback` (`/rollback`) | Workspace | `ApplicationPort.rollback`. |
| `op.parse` (`/script`) | Workspace | Client operations in the workspace runtime worker `_plurnk` ({§acp-client-operation}, {§acp-op-parse}). |

§acp-place-hiding **Directories omit hidden workspaces and sessions.** `session/list` and
`workspace.list` omit hidden entries unless `includeHidden: true` is passed. `session/delete` hides
the target session via `ApplicationPort.setWorkerHidden({ hidden: true })` and fails if the session
holds live work.

§acp-action-binding **Each request binds only the resources its scope requires.** Daemon-scoped
requests (`initialize`, `providers/list`, `session/list` without `cwd`, `ping`, `discover`,
`models.list`, `workspace.list`) bind neither a workspace nor a worker. Workspace-scoped requests
attach the workspace without creating a model worker. Session-creating requests (`session/new`,
`session/prompt` with a new session) create the named model worker if absent; read-only or
mutation-of-existing requests (`session/resume`, `session/fork`, `session/delete`,
`session/set_config_option`) return `404` (`session-not-found` or `worker-not-found`) when absent.

§acp-client-operation **`/script` (`op.parse`) executes in the workspace's runtime
worker (`_plurnk`).** It never creates or claims a model worker and never presents a permission
prompt because the operator is the author. The request settles only after every non-detached stream
opened by the operation has concluded ({§acp-broadcast-fan}).

§acp-worker-model-actions **Session model selection is server-backed.** `session/set_config_option`
with `configId: "model"` or `"spawn_model"` reads and persists the session worker's durable model
route via `ApplicationPort.readWorkerModel`, `setWorkerModel`, and `setWorkerSpawnModel`
({§worker-model-selection}), emitting `config_option_update` to attached peers.

§acp-worker-effort-actions **Session reasoning effort is server-backed.**
`session/set_config_option` with `configId: "thought_level"` reads and persists the session worker's
durable effort policy via `ApplicationPort.readWorkerEffort` and `setWorkerEffort`
({§worker-effort}), emitting `config_option_update` to attached peers.

§acp-module-action-scope **Extension module actions share the same schema-validated dispatch plane.**
`ApplicationPort.listModuleActions()` supplies `{ name, scope, inputSchema, outputSchema }`
descriptors ({§acp-discovery-contract}) for `workspace.mcp.*`, `worker.skills.*`, `worker.a2a.*`,
`worker.members.*`, `workspace.env.*`, `worker.env.*`, and `worker.schedule.*`. Workspace and
session identities come from the bound session context, never from untrusted client parameters.

§acp-op-parse **Parsed-operation projection (`/script` / `op.parse`).** `op.parse` parses client
statements with `parseStatements` and dispatches all trusted-prefix statements before any
`unparsedTail` boundary as one client operation ({§acp-client-operation}), returning per-statement
results in source order and `400 acp/action/parse-failed` (`stage: "parsing"`, `retryable: false`)
for bounded hard errors or `unparsedTail` ({§unparsed-tail-boundary}).

§acp-module-actions **One public action namespace.** At startup the module rejects any extension
action colliding with a built-in name and validates all action inputs and outputs against their
advertised JSON Schemas ({§acp-action-schema-enforcement}). Recognized Problems cross the boundary
unchanged; unexpected handler exceptions map to `500 action-failed`.

§discovery **Discovery contract.** `discover` returns the complete `{ schemaVersion: 1, actions, notifications, display }`
manifest ({§acp-discovery-contract}), where `display` is `ApplicationPort.listClientDisplayCapabilities()`
({§client-display-capabilities}).

§acp-stream-producer **Stream updates route to the initiating worker.** `stream/event` and
`stream/concluded` notifications route to sessions observing `workerId` as `terminal_update` and
`terminal_output_chunk` notifications ({§notifications-stream-event-on-channel-change}).

## 10. Topology Scope and Subagents

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-topology-scope} | A session observes its bound worker and, when enabled, its delegated subagent tree. |
| {§acp-delegation-observation} | Delegated subagent observation. |
| {§acp-subagents} | Observed subagent updates carry their child worker's coordinate namespace. |
<!-- /map -->

§acp-topology-scope **A session observes its bound worker and, when enabled, its delegated subagent
tree.** Unrelated sibling workers never broadcast into the session ({§actor-boundary}).

§acp-delegation-observation **Delegated subagent observation.** A session with
`_meta.plurnk.descendants !== false` receives `subagent_update` notifications when child workers are
spawned, updated, or concluded beneath the bound worker, and receives child messages and tool calls
attributed via `session_message` / `session_message_chunk` (`senderSessionId`, `recipientSessionId`)
and `_meta.plurnk.subagentRunId` ({§acp-subagents}). When `_meta.plurnk.descendants === false`, only
the bound worker's own events are streamed.

§acp-subagents **Observed subagent updates carry their child worker's coordinate namespace.** Child
updates carry coordinates in `worker://<name>#L/T/S` and `_meta.plurnk.subagentRunId`
(`ops://<worker>/<loop>`, {§worker-loop-result}) in both live streaming and replay. A child's
termination never settles the parent session's `session/prompt`.

## 11. Event Fan, Revocation, Configuration, and HTTP Boundary

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§acp-broadcast-fan} | One Core event subscription fans out to all attached ACP connections. |
| {§acp-oauth-revocation} | Credential revocation closes admitted streams without cancelling work. |
| {§acp-configuration} | Module configuration is read and validated from the assembled environment at startup. |
| {§acp-run-endpoint} | `/acp` is the single HTTP and WebSocket endpoint. |
| {§acp-run-input} | `session/prompt` submits a user message and optional resource attachments to the bound worker's loop. |
| {§acp-message-acceptance} | Accepted messages are tracked through `ApplicationPort.readInbox` and arrival rows. |
| {§acp-run-source} | The session's user message is the causal actor behind its inbound SEND |
| {§acp-http-authorization} | `/acp` is a protected resource requiring scope `acp`. |
| {§acp-cors} | CORS headers follow `PLURNK_ACP_ALLOW_ORIGIN`. |
| {§acp-http-failure} | Failures preserve exact RFC 9457 Problem Details. |
| {§problems-acp} | ACP Problems. |
| {§pinned-wording-acp} | Pinned wording. |
<!-- /map -->

§acp-broadcast-fan **One Core event subscription fans out to all attached ACP connections.**
`session/prompt` admission resolves with `{ messageId }` once accepted by `ApplicationPort.runLoop`
while `state_update: { state: "idle", stopReason }` signals loop termination; client operations
(`/script` / `op.parse`) settle after all non-detached streams they opened conclude.

§acp-oauth-revocation **Credential revocation closes admitted streams without cancelling work.**
When a token family is revoked ({§auth-oauth-tokens}), every active WebSocket or HTTP stream
admitted under that family closes with `401 credential-revoked` ({§acp-shutdown}); running loops
continue unaffected ({§acp-run-disconnect}).

§acp-configuration **Module configuration is read and validated from the assembled environment at
startup.** Invalid values fail boot; explicit `Module.create` options override environment defaults.

| Key | Default | Accepted value | Effect |
| --- | --- | --- | --- |
| `PLURNK_ACP_ALLOW_ORIGIN` | `*` | Empty, `*`, or one origin | CORS `access-control-allow-origin` header ({§acp-cors}). |
| `PLURNK_ACP_MAX_TURNS` | empty | Empty, `-1`, or non-negative safe integer | Default `maxTurns` passed to `runLoop` when not specified on `session/prompt`. |
| `PLURNK_ACP_HEARTBEAT_MS` | `15000` | Safe integer `0..2147483647` | Transport keepalive cadence in milliseconds (`0` disables). |
| `PLURNK_ACP_HISTORY_LOOPS` | `2` | Positive safe integer | Newest loops included in a `session/resume` replay window ({§acp-history-window}). |
| `PLURNK_ACP_HISTORY_PAGE_CHARS` | `2000000` | Positive safe integer | Character ceiling per replay window, history page, or inline message body ({§acp-history-window}). |
| `PLURNK_ACP_EXCERPT_CHARS` | `240` | Positive safe integer | Maximum excerpt length in `worker.loops` ({§acp-worker-loops}) and `session/list` ({§acp-overview}). |
| `PLURNK_ACP_OVERVIEW_WORKERS` | `200` | Positive safe integer | Maximum non-gated sessions returned in `session/list` ({§acp-overview}). |

§acp-run-endpoint **`/acp` is the single HTTP and WebSocket endpoint.** It serves Streamable HTTP
(`POST /acp`, `GET /acp`, `DELETE /acp` via `AcpServer.handleRequest`), WebSocket upgrades (`GET /acp`
with `Upgrade: websocket` via `AcpServer.prepareWebSocketUpgrade`), entry reads
(`GET /acp/<workspaceId>/<workerId>/entry`), and history pages
(`GET /acp/<workspaceId>/<workerId>/messages`).

§acp-run-input **`session/prompt` submits a user message and optional resource attachments to the
bound worker's loop.** It requires non-empty text or attachment content (`400
user-message-text-required` when empty) and passes `messageId` as Core's idempotency key
({§message-idempotency}); reusing a `messageId` with different text fails with `422
message-address-reused`.

§acp-message-acceptance **Accepted messages are tracked through `ApplicationPort.readInbox` and
arrival rows.** Until observed at a turn boundary, an accepted message appears in
`_meta.plurnk.status.inbox` (`{ path, id, loopId, lifecycle }`) and replays on `session/resume` with
`_meta.plurnk.published: false`; when observed, its arrival `log/entry` emits `user_message_chunk`
with its durable coordinate.

§acp-run-source **The session's user message is the causal actor behind its inbound SEND**
({§message-causal-source}), addressed as
`acp://operator/sessions/<sessionId>/messages/<messageId>` (each segment URI-encoded).

§acp-http-authorization **`/acp` is a protected resource requiring scope `acp`.** When
`port.credentials.mode() === "oauth"`, every non-preflight HTTP request and WebSocket upgrade must
present `Authorization: Bearer <token>` with scope `acp` (missing bearer token returns
`401 bearer-token-required` with `WWW-Authenticate: Bearer`; invalid, expired, or revoked token
returns `401 bearer-token-invalid` with `error="invalid_token"`; token lacking `acp` scope returns
`403 bearer-scope-insufficient` with `error="insufficient_scope"`). When `PLURNK_AUTH=0`
(`mode() === "none"`), all requests are admitted as `acp://operator`. Also supports `auth/login`
and `auth/logout` over ACP v2.

§acp-cors **CORS headers follow `PLURNK_ACP_ALLOW_ORIGIN`.** When non-empty, responses include
`access-control-allow-origin: <value>`, `access-control-allow-headers: content-type, authorization, acp-connection-id, acp-session-id`,
and `access-control-expose-headers: acp-connection-id, acp-session-id`, and `OPTIONS /acp*`
preflights answer `204 No Content` before authorization. When empty, no CORS headers are emitted.

§acp-http-failure **Failures preserve exact RFC 9457 Problem Details.** HTTP errors return
`application/problem+json`; JSON-RPC errors return `RequestError` with the RFC 9457 Problem in
`error.data.problem`.

§problems-acp **ACP Problems.**

| Code | Status | Contract |
| --- | --- | --- |
| `parse-failed` | 400 | A client-authored block did not parse; detail is the parser's diagnostic verbatim ({§acp-op-parse}). |
| `invalid-json` | 400 | The request body is not valid JSON. |
| `invalid-json-rpc` | 400 | The request body is not a valid ACP v2 JSON-RPC 2.0 message. |
| `invalid-session-metadata` | 400 | Session metadata field *field* must be *expected*. |
| `reasoning-invalid` | 400 | Session reasoning mode must be 'inline' or 'link'. |
| `proposal-not-owned` | 403 | This session does not own the worker for this proposal. |
| `bearer-token-required` | 401 | The request did not provide a bearer token. Recovery: Present an access token issued by this daemon as `Authorization: Bearer <token>`. |
| `bearer-token-invalid` | 401 | The access token is unknown, expired or revoked. Recovery: Obtain a new access token from this daemon's token endpoint. |
| `bearer-token-revoked` | 401 | The access token's authorization grant was revoked. Recovery: Obtain a new access token from this daemon's token endpoint. |
| `bearer-scope-insufficient` | 403 | The access token does not carry the scope *scope*. Recovery: Obtain an access token with the scope *scope*. |
| `credential-revoked` | 401 | The credential this stream was admitted under has been revoked. |
| `service-stopping` | 503 | The service is shutting down. |
| `route-not-found` | 404 | The requested HTTP route does not exist. |
| `entry-target-required` | 400 | The request names no address in `target`. Recovery: Request `?target=<address>`, the address percent-encoded. |
| `entry-query-invalid` | 400 | workspaceId, workerId and target are required to read an entry channel. |
| `history-session-required` | 400 | A history page request requires a `session` query parameter. |
| `history-cursor-not-found` | 404 | The history cursor does not match any item in the conversation. |
| `history-loop-invalid` | 400 | The history `loop` query parameter must be a positive integer without `before`. |
| `history-loop-not-found` | 404 | No loop with that sequence exists in the conversation. |
| `overview-invalid` | 400 | An overview's scope is `{}` or `{ workspaceId: <positive integer> }` ({§acp-overview-run}). |
| `overview-read-failed` | 500 | The overview read failed; the observation ends with it ({§acp-overview-run}). |
| `request-failed` | 500 | The ACP request failed unexpectedly. |
| `session-not-found` | 404 | The session has no conversation. |
| `session-address-invalid` | 400 | The qualified session address is not `<workspace ID>#<worker name>`. |
| `worker-not-found` | 404 | No model worker named *name* exists in workspace *workspace*. Recovery: Name an existing model worker, or create one by sending it a message. |
| `user-message-text-required` | 400 | A new user message must be non-empty text. Recovery: Send the message as non-empty text. |
| `interrupt-invalid` | 400 | An interrupt resolution is missing its `interruptId` or carries an invalid resolution payload ({§acp-resume-before-gate}). |
| `interrupt-duplicate` | 400 | Duplicate interrupt resolution '*id*' ({§acp-resume-before-gate}). |
| `interrupt-not-pending` | 409 | The named proposal or interaction interrupt '*id*' is not pending ({§acp-held-interrupts}, {§acp-resume-before-gate}). |
| `worker-scope-invalid` | 400 | A single resume request may only resolve interrupts for one worker ({§acp-resume-before-gate}). |
| `request-cancelled` | 499 | The ACP request was cancelled before completion. |

§pinned-wording-acp **Pinned wording.**

| Sentence | Arises when |
| --- | --- |
| Action '*name*' is not registered. Recovery: Use an action advertised by discover. | An action call naming no registered action. |
| Action '*name*' rejected parameters. *schema path*: *reason*. | An action call whose parameters fail the action's schema. |
| The action failed unexpectedly. | An action handler that threw an unrecognized error. |
