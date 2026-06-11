# plurnk-schemes-http — Specification

`http(s)://` scheme handler. Implements the `@plurnk/plurnk-schemes` author contract (SPEC §2 interface + §3.bis capability ctx). Consumed by plurnk-service via plugin discovery.

## §1 Manifest

```ts
static manifest: SchemeManifest = {
    name: "http",
    channels: { body: "text/markdown", header: "text/markdown" },
    defaultChannel: "body",
    category: "data",
    scope: "session",
    writableBy: ["model", "client"],
    volatile: true,        // remote content can change between fetches
    modelVisible: true,
    flags: { requiresWeb: true },  // excluded under the loop's noWeb flag
};
```

`package.json#plurnk`: `{ "kind": "scheme", "name": "http" }`.

**Open question — dual prefix.** plurnk-service's `SchemeRegistry` keys handlers by a single name (`register("http", …)`); there is no alias mechanism today. This package serves both `http://` and `https://`. How the second prefix registers (registry alias, the handler claiming both, or a convention) is a plurnk-service concern — tracked with the consumer, not resolved here.

## §2 Op surface

Implemented against the DB-free `SchemeCtx` (no `ctx.db`):

- `read(statement, ctx): Promise<PassthroughResult>` — fetch + stream (below).
- `send(statement, ctx): Promise<PassthroughResult>` — status-as-verb dispatch (200/410/499; else 501).

Results use the `passthrough` family (read-only / network shape) — http entries are coordinate/URL-addressed, not entry-CRUD-backed.

## §3 Streaming lifecycle

READ and SEND[200] share one core:

1. `ctx.subscriptions.open(pathname, handle)` — registers the subscription for cancel routing; returns the run+teardown-composed `AbortSignal`. The handle's `cancel()` aborts a local `AbortController` wired to the `fetch`.
2. `fetch(url, { signal })` — GET (READ) or POST (SEND[200], body from `SendBody.raw`).
3. Response status + headers → `ctx.subscriptions.notifyChunk("header", …)`.
4. Body chunks → `ctx.subscriptions.notifyChunk("body", chunk)` as they arrive (fused append + stream/event).
5. `ctx.subscriptions.close("done", "HTTP <status>; <n> bytes")` on clean end; `close("error", reason)` on failure.

Returns `102 Processing` on success (the subscription drives the channel content). The composed signal aborting (loop.cancel) and the local handle (SEND[499]) both tear the fetch down.

## §4 Status mapping

| Outcome | status |
|---|---|
| Stream opened (READ / SEND[200] success) | 102 |
| SEND[410] delete | as `ctx.entries.delete` returns |
| SEND[499] cancel | 200 (engine already routed teardown to the handle) |
| Client-cancelled fetch | 499 (`kind: aborted`) |
| Upstream / network failure | 502 (`kind: fetch_failed`) |
| Non-url target | 400 (`kind: bad_target`) |
| Uninterpreted SEND status | 501 (`kind: unsupported_send`) |

Error results carry a `scheme:http` `TelemetryEvent` (via `Results.error`).

## §5 No runtime dependencies

`fetch` / `AbortController` / `TextDecoder` / `ReadableStream` are Node ≥25 built-ins. The package declares only peer deps (`@plurnk/plurnk-schemes`, `@plurnk/plurnk-grammar`) — never pulls a transport library.
