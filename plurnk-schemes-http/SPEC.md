# plurnk-schemes-http — Specification

`http(s)://` scheme handler. Implements the `@plurnk/plurnk-schemes` author contract (SPEC §2 interface + §3.bis capability ctx). Consumed by plurnk-service via plugin discovery.

## §1 Manifest

```ts
static manifest: SchemeManifest = {
    name: "http",
    // Seed defaults (pre-fetch placeholders). `body` is retyped per-call via
    // notifyChunk's mimetype arg. Rendered HTML projects into body while the
    // faithful DOM is archived in html. `header` is always text/plain.
    channels: { body: "application/octet-stream", header: "text/plain", html: "text/html" },
    defaultChannel: "body",
    category: "data",
    scope: "workspace",
    writableBy: ["model", "client"],
    volatile: true,        // remote content can change between fetches
    modelVisible: true,
    flags: { requiresWeb: true },  // excluded under the loop's noWeb flag
};
```

`package.json#plurnk`: `{ "kind": "scheme", "name": "http" }`.

`https` routes through the registered `http` handler, but routing is not identity: entries retain the addressed protocol and fold authority into their storage pathname (`https` + `/example.com/page`). Thus two hosts never collide and `http://` never aliases `https://`.

## §2 Op surface {§op-surface}

Implemented against the DB-free `SchemeCtx` (no `ctx.db`):

The HTTP method is the op: `read` → GET, `send` (SEND[200]) → POST, `edit` → PUT (whole-body; `<L>` rejected), `kill` → DELETE. `SEND[410]` drops the cached copy; `SEND[499]` cancels in-flight; other SEND codes → 501. Request headers ride the target's `{Key: value}` blocks (grammar#46).

Results use the `passthrough` family (read-only / network shape) — http entries are coordinate/URL-addressed, not entry-CRUD-backed.

## §3 Streaming lifecycle

All verbs share one streaming core:

1. `ctx.subscriptions.open(pathname, handle, { publishedChannel })` — registers the subscription for cancel routing and selects the one channel published to the requesting loop; returns the worker+teardown-composed `AbortSignal`. The handle's `cancel()` aborts a local `AbortController` wired to the `fetch`/render.
2. `fetch(url, { signal })` — GET (READ) or POST (SEND[200], body from `SendBody.raw`); read the response `Content-Type`.
3. **Render gate ({§render-lifecycle}):** a GET whose response is HTML routes to the render path; a GET whose response is `text/event-stream` routes to the SSE path ({§sse}); everything else (POST responses, non-HTML bodies) streams raw.
4. Response status + headers are persisted in `header`.
5. Non-HTML body is persisted in `body` under its response type. Rendered HTML → `projection.readable(finalDom, "text/html")`, then the readable result goes to `body` and the faithful DOM to `html`. A page with no readable projection fails; raw DOM never silently becomes the model-facing body.
6. `close("done", …)` on clean end; `close("error", reason)` on failure.

Returns `102 Processing` on success (the subscription drives the channel content). The composed signal aborting (loop.cancel) and the local handle (SEND[499]) both tear the fetch/render down.

Channel publication follows the manifest contract: a fragmentless READ publishes only `defaultChannel` (`body`) and renders under the exact fragmentless URL. An explicit fragment publishes that named channel. All channels still persist, but auxiliary transport metadata and faithful DOM do not become ambient model results merely because they were acquired alongside the readable projection. Unit and core integration coverage pin both publication filtering and durable auxiliary persistence.

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

## §6 Render lifecycle {§render-lifecycle}

`Browser` (`export default class`, barrel-exported as a standalone foundation) is the headless-Chromium render engine — ported from rummy.web's WebFetcher, render-only.

- **Gate:** a GET whose response `Content-Type` is `text/html` / `application/xhtml+xml` renders; the probe-fetch body is discarded and the browser does its own navigation. POST never renders.
- **Render:** warm chromium (one per `Browser`), per-worker `BrowserContext` keyed on `ctx.workerId`, **mobile-emulated by default** (Pixel-5-class viewport + UA — responsive sites serve lighter layouts; `PLURNK_SCHEMES_HTTP_MOBILE=0` renders desktop), navigate with `waitUntil: "networkidle"` + a salvage path (timed-out-but-rendered pages with substantive body text), serialize the final DOM via `page.content()`.
- **Body:** the consumer's configured mimetype family projects the serialized DOM. Its readable markdown is the decisive `body` used by READ, FIND, embeddings, weights, and the model; the faithful final DOM is archived under `html` for XPath and inspection. Direct READ and search prefetch therefore expose the same kind of model-facing content.
- **Host rewrite (bounded, first-party):** {§host-rewrite} a GitHub `…/blob/…` URL is fetched as its `raw.githubusercontent.com` source (line-navigable, exact) — the blob page is a CSP-locked JS SPA and code wants source, not a rendered viewer. This is the ONLY host rewrite; Wikipedia was measured through the extractor and deliberately gets none (desktop already extracts the full clean article; rewrites regressed it — schemes-http#4).
- **Config:** `.env.defaults` at the package root is the authoritative list (family-namespaced `PLURNK_SCHEMES_HTTP_*`), shipped in the tarball; the daemon assembles it into the boot floor set-if-unset (service SPEC §operator-config-env-defaults, schemes#31). Required render-path numerics — `FETCH_TIMEOUT`, `SALVAGE_MIN_BODY_CHARS`, `IDLE_TIMEOUT` — fail hard when unset (no in-code defaults). `MOBILE` is floor-defaulted to `1` and a required read (unset crashes). Absence-is-a-mode knobs: `PLAYWRIGHT_WS`, `NO_SANDBOX`, `CHROMIUM_HEAP_MB`.
- **Freshness (READ):** {§revalidation} one predicate (`#storedCopyServable`), two phases. Pre-fetch: a stored copy whose materialization stamp (`x-plurnk-fetched-at`, HEADER channel) is inside `PLURNK_SCHEMES_HTTP_TTL_MS` serves with zero round-trips — identical for model READs and lane-1 prefetch (#405). The shipped five-minute window makes a just-materialized search result immediately readable as an ordinary entry; `0` explicitly opts into revalidation on every read. The stamp resets only when the origin vouches (fetch or 304), never on a cache serve. Past the window a repeat READ recovers the prior fetch's validators from its own stored entry (`ETag`→`If-None-Match`, `Last-Modified`→`If-Modified-Since`) and revalidates. A `304` re-serves the stored body and **skips the render** — a first-class READ (the model sees an ordinary streaming result, never a cache status; `revalidated 304` rides the close summary). The TTL is the #333 milestone landed at that same one-predicate boundary (blessed by service#341; delivered per #405). `SEND[410]` drops the stored copy, forcing the next READ to full-fetch.
- **Cancel:** the composed `AbortSignal` / SEND[499] handle aborts the render by closing the page (in-flight `goto` rejects promptly).

- **SSE (READ):** {§sse} a GET whose response is `text/event-stream` is parsed, not streamed raw: events split on a blank line, and each event's `data` field(s) — joined by `\n`, the `data:`/comment framing stripped, `\r\n` normalized — dispatch as one `notifyChunk("body", …, "text/plain")`. The model reads event payloads, not the wire. Comment lines (`:`) and non-`data` fields (`event`/`id`/`retry`) drop day-one; reconnection (`Last-Event-ID`) is a follow-up (#468). A long-lived GET — events land across turns until the origin closes; the close summary counts events.

## §7 Prefetch primitive {§prefetch}

`WebFetcher` is the guarded acquisition seam core's entry-materialization calls (#454):

```ts
new WebFetcher().fetch(url, opts): Promise<{
  body: string;
  mimetype: string;
  render?: () => Promise<{ body: string; mimetype: string } | null>;
} | null>
```

- **Primary body** — the guarded HTTP response. Core projects HTML through
  the MIME handler first; a useful model-facing projection wins.
- **Lazy `render()`** — present for HTML. Core invokes guarded
  Playwright/salvage only when the primary MIME projection is empty, then
  projects the rendered DOM through the same handler. Browser mutation must
  not replace already-useful server-rendered content (#596).
- **`null`** — dead: SSRF-refused, unreachable, non-2xx, non-textual (binary pruned), or empty. Dead-ness is a **value, not a throw** — the liveness verdict core prunes on.
- **SSRF guard** (`Guard`): http(s) only, no localhost, every resolved address public (RFC-reserved v4/v6 ranges blocked), with **manual per-hop redirect re-guarding**; the chromium render is guarded too via request interception. Hops capped by `PLURNK_SCHEMES_HTTP_REDIRECTS`. Residual DNS-rebinding sliver (runtime re-resolves after the check) accepted day-one.
- **Textual set**: `text/*`, `application/{json,xml,xhtml+xml}`, `+json`/`+xml` suffixes.

## §8 WebSocket {§ws}

`Ws` is this package's **second first-class scheme** (#468, #473): registered `wss` via `package.json` `plurnk.schemes` (`{ name: "wss", export: "Ws" }`), with the `ws` prefix riding it in core's `schemeNameOf` exactly as `https` rides `http`. WebSocket is a distinct protocol — bidirectional, stateful, full-duplex, its own URI scheme — not an http content-type (that's SSE, §sse), so it has its own manifest (🔌, `messages` channel, `docs/wss.md`) and its own directory entry the model discovers natively. Op → socket lifecycle:

- **`READ(wss://…)`** — open the socket, guard the target through `Guard.isPublicUrl` (extended to `ws:`/`wss:`), seed + subscribe (create-then-subscribe, http#3), stream each inbound frame into the `messages` channel (`notifyChunk`, text/plain). Returns `102`; the op **holds until the socket closes** (mirrors the streaming lifecycle — the worker wakes on close, summary counts messages).
- **`SEND[200](wss://…):msg:`** — push `msg` onto the open socket. No open socket → `409` (`kind: no_open_socket`) — READ opens the connection SEND rides.
- **`SEND[499](wss://…)`** — cancel; engine routes teardown to the READ's handle (which closes the socket), scheme-level `200` no-op.
- **`KILL(wss://…)`** — close the open socket (`404` if none open).

**Stateless-contract exception:** every other scheme is stateless per schemes SPEC §forbidden ("no state past a handler return"). A live socket IS per-workspace state, so `Ws` holds open sockets in an **in-instance registry** across op invocations — keyed `workspace:pathname`, entries present only while the socket is open (every terminal path — close/error/KILL/cancel — removes). This is the ONE sanctioned exception, because that persistence is the whole point of a WebSocket. Day-one limits: text frames only, no reconnection, default handshake identity (custom headers pending) — all #468 follow-ups.
