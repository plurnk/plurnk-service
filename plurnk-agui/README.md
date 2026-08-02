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
    port: 3044,
}));
```

The module owns transport authentication, request validation, event translation,
and proposal delivery. Core owns persistence and model-loop policy; clients own
rendering and local terminal/editor behavior.

## Development

```sh
npm run test -w @plurnk/plurnk-agui
```
