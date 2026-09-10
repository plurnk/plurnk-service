# @plurnk/plurnk-agui

AG-UI server module for the PLURNK daemon. It exposes the client-facing HTTP/SSE
interface and translates daemon lifecycle events into AG-UI events.

## Interface

`POST /` accepts `RunAgentInput` and returns an AG-UI event stream.

PLURNK uses standard AG-UI events for Runs, messages, steps, tool calls, state,
and approval requests. Additional execution metadata uses namespaced
`plurnk.*` custom events so generic AG-UI clients can ignore it safely.

Workspace selection and PLURNK-specific management actions use namespaced
fields under `forwardedProps.plurnk`. `SPEC.md` defines those extensions.

## Conversation projection

Each Run observes its bound Worker and, once known, its exact Loop. Sibling
events do not become chat messages; child activity arrives only when Core
delivers it into the parent's log ({§agui-topology-scope}).

| Daemon evidence | Client projection |
| --- | --- |
| TASK | Replaceable `ACTIVITY_SNAPSHOT` with an ACP Plan; not reasoning. |
| Live provider reasoning | Standard `REASONING_*` deltas, immediately. Retries have separate identities. |
| SEND | Assistant text; already-streamed reasoning is not repeated. |
| Other model operations | Standard tool calls and results. |
| Log rows | `CUSTOM plurnk.row` for richer clients; not a second chat stream to render alongside standard messages. |
| Harness activity | `CUSTOM plurnk.ambient`, without invented model speech. |
| Packet and terminal usage | State updates and `plurnk.terminated`; daemon quantities pass through unchanged. |

READ of `reasoning://<worker>/…` is an operation receipt, not another reasoning stream.
On reattach, the durable conversation snapshot restores accepted reasoning,
SENDs, and the latest PLAN. `forwardedProps.plurnk.mode="sync"` obtains that
state without a prompt or model inference ({§agui-conversation-sync}).

Pending proposals and user interactions use standard AG-UI interrupts and
resume Runs. Core decides their owner and disposition, including delegated
gates; clients do not infer approval policy from tool names. The exact mappings,
event schemas, and settlement rules live in [SPEC.md](./SPEC.md).

## Integration

The daemon loads the module in process:

```ts
import { Module } from "@plurnk/plurnk-agui";

daemon.registerModule(Module.init({
    host: "127.0.0.1",
    port: 1066,
}));
```

The service supplies this package's `.env.defaults` through the assembled
environment before module startup. A direct in-process consumer must provide
that environment or an explicit `heartbeatMs`; explicit `token`, `maxTurns`,
and `heartbeatMs` options override their corresponding environment values.
`SPEC.md` owns the exact value contract.

The module owns transport authentication, request validation, event translation,
and proposal delivery. It consumes core's disposition-bearing proposal projection
for both live events and reconnect rather than rebuilding the general loop policy.
Core owns persistence and model-loop policy; clients own rendering and local
terminal/editor behavior.

## Development

```sh
npm run test -w @plurnk/plurnk-agui
```
