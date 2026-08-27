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
for both live events and reconnect rather than rebuilding policy from loop flags.
Core owns persistence and model-loop policy; clients own rendering and local
terminal/editor behavior.

## Development

```sh
npm run test -w @plurnk/plurnk-agui
```
