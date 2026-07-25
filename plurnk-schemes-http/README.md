# plurnk-schemes-http

`http(s)://` URI scheme handler for the [plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The **first greenfield `@plurnk/plurnk-schemes-*` sibling** — authored entirely against the DB-free capability contract ([`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes) `SchemeCtx`), importing zero plurnk-service internals.

## What it does

Lets the model treat any web URL as an addressable, streamable resource:

| Op | Behavior |
|---|---|
| `READ(http(s)://host/path)` | Without `<scope>`, fetch/revalidate the URL and stream its readable body. With `<scope>`, read that range from the materialized response without refetching. |
| `SEND[200](http(s)://…)` | Request with a body (POST); response streams back the same way. |
| `SEND[499](http(s)://…)` | Cancel an in-flight request (abort the fetch). |
| `SEND[410](http(s)://…)` | Delete the cached response entry. |

Response status + headers land in the `header` channel; the body in `body` (the default).

## Channels

- `body` — response payload (default channel).
- `header` — `HTTP <status> <statusText>` line + response headers.

## Design

- **Streaming via the capability `subscriptions` lifecycle** (`open` → `notifyChunk` → `close`). `open()` returns the worker+teardown-composed `AbortSignal`; a `SubscriptionHandle` is registered so the engine routes `SEND[499]` cancellation to the in-flight `fetch`.
- **Batteries-included rendering** — installation provisions Playwright's compatible Chromium and daemon boot verifies it. Explicit remote, system-browser, and rendering-disabled modes are documented in the shipped `.env.defaults`; there is no browser guessing or silent fallback.
- **DB-free** — reaches the substrate only through `ctx` capabilities (`subscriptions`, `entries`), never a raw DB handle (plurnk-schemes SPEC §5). This is what the keystone capability ctx made possible.

## Install

```
npm i @plurnk/plurnk-schemes-http && plurnk start
```

Plugin discovery registers it at boot (`package.json#plurnk.kind === "scheme"`).
No browser setup is required for the default installation.

## Tests

`test:lint` (tsc) + `test:unit` (conformant `SchemeCtx` stub + mock `fetch`).
