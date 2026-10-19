# @plurnk/plurnk-agui

AG-UI server module for the PLURNK daemon. It exposes the client-facing HTTP/SSE
interface and translates daemon lifecycle events into AG-UI events.

## Interface

`POST /agui` accepts `RunAgentInput` and returns an AG-UI event stream.

A stock AG-UI client needs only the endpoint and, when enabled, authentication.
Its first message creates a folderless workspace and worker; the same `threadId`
reopens that conversation after reconnect or daemon restart. An existing worker
is directly addressable as `<workspace ID>#<worker name>`, stable across workspace
renames. Inspection creates nothing ({§agui-thread-binding}, {§agui-thread-address}).

PLURNK uses standard AG-UI events for Runs, messages, steps, tool calls, state,
and approval requests. PLURNK's facts about those parts ride their standard
`metadata` under `plurnk`; facts with no standard subject use namespaced
`plurnk.*` custom events, so generic AG-UI clients can ignore them safely.

Workspace selection and PLURNK-specific management actions use namespaced
fields under `forwardedProps.plurnk`. `SPEC.md` defines those extensions.

## Event projection

Each Run observes its bound worker and, once known, its exact loop. Delegated
children have standard subagent identities rather than speaking as the parent;
Core owns delivery of their replies and results into the parent's log
({§agui-topology-scope}, {§agui-subagents}). Unrelated siblings stay outside the
conversation.

| Daemon evidence | Client projection |
| --- | --- |
| NOTE | Ordinary operation row containing literal working memory. |
| WAIT | A tool call with its receipt; a WAIT that carries a body speaks it instead. |
| Loop conclusion | Lifecycle signals; delivered SEND replies are assistant speech. |
| Live provider reasoning | Standard `REASONING_*` deltas, immediately. Retries have separate identities. |
| SEND | Assistant text; already-streamed reasoning is not repeated. |
| A message to the worker | A user message, named by its source unless this client sent it. |
| Other model operations | Standard tool calls and results. |
| A row's facts | `metadata.plurnk` on the message, tool call or result the row builds, live and on snapshot. |
| Delegated child activity | Standard `SUBAGENT_*` lifecycle and attributed messages/tool calls; its conclusion answers the parent's delegation call. |
| Non-conversation harness activity | `CUSTOM plurnk.ambient`, without invented model speech. |
| Loop end | `RUN_FINISHED` completed with its result or cancelled, or `RUN_ERROR` for a failure; the end carries its token `usage`. |
| Packet and terminal usage | State updates, and the loop's terminal record as the end's `metadata.plurnk.terminal`: the complete accounting with cost; daemon quantities pass through unchanged. |

READ of `reasoning://<worker>/…` is an operation receipt, not another reasoning stream.

A Run's `messages` are the client's copy of the conversation. A Run submits only a
user message the conversation doesn't hold, and a Run with nothing new reattaches:
the durable `MESSAGES_SNAPSHOT` restores the whole conversation without a prompt or
model inference ({§agui-run-input}, {§agui-sync}). A stock `HttpAgent` therefore
reattaches by running again with its history.

Pending proposals and user interactions use standard AG-UI interrupts and
resume Runs. Core decides their owner and disposition, including delegated
gates; clients do not infer approval policy from tool names. A client whose person
is still deciding stays informed by reattaching with `forwardedProps.plurnk.interrupts`
naming the interrupts it holds: the Run waits on them instead of presenting them
again, and finishes when any view or Core settles one ({§agui-held-interrupts}).
The exact mappings, event schemas, and settlement rules live in [SPEC.md](./SPEC.md).

## Integration

A browser client imports the state and action-outcome types from
`@plurnk/plurnk-agui/client`, which needs no Node types ({§agui-client-types}); the
package root is the server module.

The daemon discovers this package as a module: its `package.json` declares
`plurnk: { kind: "module", module: "./module" }`, and the service composes
nothing by hand. The module mounts only `/agui` on the daemon's listener
and reads its settings from the assembled environment, which carries this
package's `.env.defaults`. `SPEC.md` owns the exact value contract.

The module owns transport authentication, request validation, event translation,
and proposal delivery. It consumes core's disposition-bearing proposal projection
for both live events and reconnect. The recorded worker owner handles approvals;
A2A clarification remains protocol-routed. Core owns persistence and server approval;
clients own rendering and local
terminal/editor behavior.

## Development

```sh
npm run test -w @plurnk/plurnk-agui
```

Deterministic tests use isolated configuration. The service's explicit
`test:live` tier also includes the real-model AG-UI stories; its
`--specimen` selector can run either story by exact name.
