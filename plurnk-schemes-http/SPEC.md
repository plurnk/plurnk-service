# plurnk-schemes-http — Specification

`http(s)://` scheme handler. Implements the `@plurnk/plurnk-schemes` author contract (SPEC §2 interface + §3.bis capability ctx). Consumed by plurnk-service via plugin discovery.

## §1 Manifest

```ts
static manifest: SchemeManifest = {
    name: "http",
    // Seed defaults (pre-fetch placeholders). `body` is retyped per-call via
    // notifyChunk's mimetype arg — to the response Content-Type, or text/html
    // for a rendered page. `header` is always text/plain.
    channels: { body: "application/octet-stream", header: "text/plain" },
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

1. `ctx.subscriptions.open(pathname, handle)` — registers the subscription for cancel routing; returns the run+teardown-composed `AbortSignal`. The handle's `cancel()` aborts a local `AbortController` wired to the `fetch`/render.
2. `fetch(url, { signal })` — GET (READ) or POST (SEND[200], body from `SendBody.raw`); read the response `Content-Type`.
3. **Render gate (§6):** a GET whose response is HTML routes to the render path; everything else (POST responses, non-HTML bodies) streams raw.
4. Response status + headers → `notifyChunk("header", …, "text/plain")`.
5. Body → `notifyChunk("body", chunk, mimetype)` — labelled with its real type (the response Content-Type, or `text/html` rendered). Byte path streams chunks as they arrive; render path writes the serialized DOM in one chunk.
6. `close("done", …)` on clean end; `close("error", reason)` on failure.

Returns `102 Processing` on success (the subscription drives the channel content). The composed signal aborting (loop.cancel) and the local handle (SEND[499]) both tear the fetch/render down.

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

## §5 Dependencies

The **byte path** is dependency-free: `fetch` / `AbortController` / `TextDecoder` / `ReadableStream` are Node ≥25 built-ins.

The **render path** takes one runtime dependency, `playwright`, **lazy-imported** (`Browser.ts`) so only an actual render pays for it — a byte fetch never loads it. The chromium binary is optional: set `PLURNK_SCHEMES_HTTP_PLAYWRIGHT_WS` to drive a remote CDP endpoint (shared chromium / Lightpanda / browserless) instead of launching locally. This is the conscious, scoped inversion of the original "no runtime deps" stance — rendering is acquisition, and acquisition is this scheme's job.

## §6 Render lifecycle

`Browser` (`export default class`, barrel-exported as a standalone foundation) is the headless-Chromium render engine — ported from rummy.web's WebFetcher, render-only.

- **Gate:** a GET whose response `Content-Type` is `text/html` / `application/xhtml+xml` renders; the probe-fetch body is discarded and the browser does its own navigation. POST never renders.
- **Render:** warm chromium (one per `Browser`), per-run `BrowserContext` keyed on `ctx.runId`, **mobile-emulated by default** (Pixel-5-class viewport + UA — responsive sites serve lighter layouts; `PLURNK_SCHEMES_HTTP_MOBILE=0` renders desktop), navigate with `waitUntil: "networkidle"` + a salvage path (timed-out-but-rendered pages with substantive body text), serialize the final DOM via `page.content()`.
- **Body:** the serialized DOM is delivered as one `body` chunk labelled `text/html`; the mimetype layer projects everything (`content`/`symbols`/`deepXml`/embedding) off it. http never cleans or extracts — the body is the faithful, final page (schemes-http#1).
- **Host rewrite (bounded, first-party):** a GitHub `…/blob/…` URL is fetched as its `raw.githubusercontent.com` source (line-navigable, exact) — the blob page is a CSP-locked JS SPA and code wants source, not a rendered viewer. This is the ONLY host rewrite; Wikipedia was measured through the extractor and deliberately gets none (desktop already extracts the full clean article; rewrites regressed it — schemes-http#4).
- **Config:** `.env.example` is the authoritative list (family-namespaced `PLURNK_SCHEMES_HTTP_*`). Required render-path numerics — `FETCH_TIMEOUT`, `SALVAGE_MIN_BODY_CHARS`, `IDLE_TIMEOUT` — fail hard when unset (no in-code defaults). Optional modes: `MOBILE` (default on), `PLAYWRIGHT_WS`, `NO_SANDBOX`, `CHROMIUM_HEAP_MB`.
- **Conditional revalidation (READ):** a repeat READ recovers the prior fetch's validators from its own stored entry (`ETag`→`If-None-Match`, `Last-Modified`→`If-Modified-Since`) and revalidates. A `304` re-serves the stored body and **skips the render** — a first-class READ (the model sees an ordinary streaming result, never a cache status; `revalidated 304` rides the close summary). Always-revalidate is the meaning of `volatile`; there is no TTL. The servable decision lives behind one predicate boundary (`#storedCopyServable`) where the deferred per-URL TTL milestone lands as the same predicate (service#341/#333). `SEND[410]` drops the stored copy, forcing the next READ to full-fetch.
- **Cancel:** the composed `AbortSignal` / SEND[499] handle aborts the render by closing the page (in-flight `goto` rejects promptly).
