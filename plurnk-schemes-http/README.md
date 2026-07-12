# plurnk-schemes-http

`http(s)://` URI scheme handler for the [plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The **first greenfield `@plurnk/plurnk-schemes-*` sibling** — authored entirely against the DB-free capability contract ([`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-schemes) `SchemeCtx`), importing zero plurnk-service internals.

## What it does

Lets the model treat any web URL as an addressable, streamable resource:

| Op | Behavior |
|---|---|
| `READ(http(s)://host/path)` | `fetch` the URL; stream the response body into the `body` channel as it arrives. A streaming read — returns `102 Processing`, the subscription accumulates, the model reads the entry on a later turn. |
| `SEND[200](http(s)://…)` | Request with a body (POST); response streams back the same way. |
| `SEND[499](http(s)://…)` | Cancel an in-flight request (abort the fetch). |
| `SEND[410](http(s)://…)` | Delete the cached response entry. |

Response status + headers land in the `header` channel; the body in `body` (the default).

## Channels

- `body` — response payload (default channel).
- `header` — `HTTP <status> <statusText>` line + response headers.

## Design

- **Streaming via the capability `subscriptions` lifecycle** (`open` → `notifyChunk` → `close`). `open()` returns the run+teardown-composed `AbortSignal`; a `SubscriptionHandle` is registered so the engine routes `SEND[499]` cancellation to the in-flight `fetch`.
- **No runtime dependencies** — `fetch`, `AbortController`, `TextDecoder`, `ReadableStream` are Node ≥25 built-ins.
- **DB-free** — reaches the substrate only through `ctx` capabilities (`subscriptions`, `entries`), never a raw DB handle (plurnk-schemes SPEC §5). This is what the keystone capability ctx made possible.

## Install

```
npm i @plurnk/plurnk-schemes-http && plurnk start
```

Plugin discovery registers it at boot (`package.json#plurnk.kind === "scheme"`).

## Tests

`test:lint` (tsc) + `test:unit` (conformant `SchemeCtx` stub + mock `fetch`).
