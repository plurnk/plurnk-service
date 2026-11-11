# `@plurnk/plurnk-schemes-http` Specification

Owns the `http(s)://` request/response scheme (`Http`), the `ws(s)://` full-duplex WebSocket scheme (`Ws`), automatic web acquisition (`WebFetcher`), and URL/host policy (`Guard`, `HostPolicy`).

## §http-manifest HTTP manifest and operation surface

`Http` registers as `https` (plain `http` routes to the same handler; `package.json#plurnk.schemes` registers `http` via default export and `wss` via `Ws`) with `category: "data"`, `writableBy: ["model", "client"]`, `volatile: true`, `modelVisible: true`, `traits: ["web"]`, and channels:

| Channel | Seed type | Meaning |
|---|---|---|
| `body` (default) | `application/octet-stream` | Source text or original binary bytes; SSE `data` lines for a live response |
| `header` | `text/plain` | Origin status/headers, acquisition stamps, cache variant, and projection evidence |
| `readable` | `text/markdown` | Optional derived text/facts from an installed mimetype projection ({§channel-selection}) |

Identity and transport URLs normalize through `NetworkAddress` ({§network-address}): authority is `<host>[:<non-default-port>]`, pathname is `<path>[?<serialized-query>]` (`%28`/`%29` in path canonicalize to literal `(` / `)`, query order/duplicates/empty `?` preserved), `#fragment` selects the Plurnk channel, and URL userinfo is rejected (`400`).

| Operation | Remote action | Contract |
|---|---|---|
| Exact `plurnk.read({ path: url, range? })` | `GET` (unless a fresh cached `GET` is usable) | Scope-blind `prepareRepresentation`, then Core selects channel and scope |
| Exact `plurnk.find({ path: url })` | `GET` only when acquisition is required | Same preparation, then universal query, matcher, weighting, and pagination |
| Pattern `plurnk.find({ path: patternUrl })` | None (`PathSyntax.hasGlob`, {§path-syntax}) | Query already-materialized web entries in the workspace without remote discovery |
| `plurnk.send({ target: url, text })` | `POST` | Proposes (`effect: "host"`, `202`); on apply, streams and persists response under `url` |
| `plurnk.edit({ path: url, content })` | `PUT` | Proposes (`effect: "host"`, `202`); replaces whole remote resource (line markers fail `400`: `Remove the line range and submit the complete replacement body.`) |
| `plurnk.kill({ path: url })` | None | Cancels all live workspace acquisitions of `url` (owners settle `499`), else deletes local stored entry |
| `plurnk.kill({ path: url, remote: true, headers? })` | `DELETE` | Proposes (`effect: "host"`, `202`); `headers` supplies the request headers |

- **Headers and proposals (`http-outbound-proposes`):** Request headers are passed in `headers: { "Key": "value" }` ({§slot-order}). `POST`, `PUT`, remote `DELETE`, and WebSocket `edit`/`send` frames declare `effect: "host"` and return `202` ({§proposal}), governed by `PLURNK_SERVICE_EFFECT_HOST`. `GET` and WebSocket `read` connection opens are observational and ungated; a WebSocket frame checks for an open socket both before proposing and again at `applyResolution`, and the resolver may replace the proposed body before it is sent.

## §http-lifecycle Acquisition, decoding, and materialization

```mermaid
flowchart TD
    get["GET acquisition"] --> live{"text/event-stream?"}
    live -->|yes| sse["Seed canonical channels, retain subscription, return 102"]
    live -->|no| origin{"Finite origin outcome"}
    origin -->|text / negotiated Markdown| text["Fetch UTF-8 text in body (JSON formatted via contract-representations)"]
    origin -->|binary| bin["Bounded original bytes in body + optional projection in readable"]
    origin -->|server HTML or transport loss| local["Installed HTML projection -> readable (or origin failure on both channels)"]
    text & bin & local --> settle["Write complete canonical channels & durable producerResults atomically"]
```

| Response / surface | `body` | Auxiliary materialization (`readable` / `header`) | Completion |
|---|---|---|---|
| Negotiated origin `text/markdown` | Exact origin Markdown | None (single request; no `readable` needed) | Static representation |
| HTML page production | Exact server HTML when origin supplied it | Installed HTML reader Markdown or independent `422 no-readable-projection` error in `readable`; `x-plurnk-projection-id` in `header` | Static representation; channels carry independent `producerResult`s |
| `text/event-stream` (SSE) | One joined `data` value + `\n` per `text/plain` chunk | Initial response metadata in `header` | `102`; origin close settles subscription |
| Empty response body | Present empty text `""` | Response and package metadata in `header` | Static representation (`READ` of `body` returns `204`) |
| Origin HTTP `4xx`/`5xx` | Available origin text or bytes preserved | Origin-backed channels carry durable `http-response-status` Problem | Selected channel's durable outcome |
| Configured textual / JSON type | Fetch `Response.text()` UTF-8 (streamed mutations use incremental `TextDecoder`; finite JSON formats via {§contract-representations}) | Response and package metadata in `header` (`charset` preserved as evidence) | Static representation |
| Configured binary type | Complete original bytes via {§mimetype-binary-input} (native attachment eligible on `READ` of `body`, `#bytes`, or `#readable`, {§log-wire-format}) | Derived Unicode in `readable` (when reader exists); `x-plurnk-projection-id` in `header` | Static representation, or `413 projection-input-limit` if over byte ceiling |
| Unreadable binary or unknown bytes | Complete original bytes (`application/octet-stream`) | No `readable` projection or native media claim | Static representation; ordinary hex `READ` |

`WebFetcher.materialize` outcomes across input states:

| Input or event | Action | Result |
|---|---|---|
| Configured non-HTML text | Decode with Fetch UTF-8 | Original representation in `body` |
| Configured binary with / without reader | Retain bounded bytes (and apply projection when present) | Original `body`, optional `readable`, and `projectionIdentity` (or `WebMaterializationError` from `ProjectionInputLimitError` when over limit) |
| Negotiated origin `text/markdown` | Accept directly | Exact Markdown in `body`; no `readable`, no second request |
| Origin HTML | Run installed HTML projection | Origin HTML in `body`; local Markdown in `readable` (or `422 no-readable-projection` when no readable body exists) |
| Origin transport unavailability | Preserve origin failure | `body` and `readable` errored with origin's own failure |
| Projection implementation throws | Stop and preserve cause | `WebMaterializationError` with stage `projection` |

- **Content negotiation and projection:** `Http` publishes `WebFetcher` as `webMaterializer` ({§scheme-operation-dispatch}). When no `Accept` header is authored, `GET` sends `Accept: text/markdown, text/html;q=0.9, */*;q=0.1`.
- **Origin `llms.txt` companions (`PLURNK_SCHEMES_HTTP_LLMS_TXT`):** When `PLURNK_SCHEMES_HTTP_LLMS_TXT=1` (default), a successful generic `GET` opportunistically probes `<origin>/llms.txt` once per origin TTL window and materializes `https://<host>/llms.txt` as a discoverable workspace entry; missing/non-`2xx`/binary/failed probes are remembered quietly and never fail the initiating `READ`.

## §http-status Status mapping and replay

| Outcome | Operation status |
|---|---|
| Finite origin `2xx`/`3xx` exact `READ` / empty text response | `200` / `204` (origin status preserved in `header`) |
| Exact `FIND` after preparation / `KILL` with no live acquisition | Universal query result / exact entry-delete result |
| Automatic `WebFetcher` returns `null` / missing response channel | `404 not-materialized` / `404 channel-not-found` |
| Selected origin-backed channel received HTTP `4xx`/`5xx` | Origin status with durable `http-response-status` Problem |
| Final status outside `200..599` | `502 invalid-response-status` with `originStatus` |
| Absent local HTML projection | `422 no-readable-projection` on `#readable` |
| Binary input exceeds byte bound | `413 projection-input-limit` |
| `KILL` of live acquisition / client-cancelled finite acquisition | `200` (owner settles `499`) / `499 cancelled` |
| `SSE` after acquisition: normal / cancelled / parser or transfer failure | `102` initial; settles channel result, `499`, or `502` |
| Multi-statement HTTP edit batch / invalid target, line edit, or userinfo | `409 non-atomic-edit-batch` / `400` |
| Non-corresponding `304` or transport failure | `502 fetch-failed` (detail bounded by `PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT`) |
| Projection exception / uninterpreted `SEND` status | `500 projection-failed` / `501 send-status-unsupported` |

- **Replay:** Failed `GET`, `PUT`, and `DELETE` acquisitions are retryable (idempotent); `POST` and post-open `SSE` stream failures are non-retryable.

## §http-host-policy Host policy and URL guard

| Surface | Contract |
|---|---|
| Configuration floor | `plurnk-schemes-http/.env.defaults` assembled via {§operator-config-precedence}; missing or invalid required values fail at readiness or owning read. |
| `PLURNK_SCHEMES_HTTP_HOSTS` | Unset or empty admits all hosts. A JSON array admits exact hostnames (`"example.com"`), wildcard subdomains (`"*.example.com"`), or none (`[]`). Disallowed direct `HTTP`/`WS` targets and redirect hops fail `403 host-not-permitted` before I/O; disallowed automatic acquisitions return `null` ({§capability-admission}). |
| `Guard.fetch` (automatic acquisition) | Solely used by `WebFetcher` for automatic byte acquisition: requires credential-free `http(s):` targets whose resolved DNS addresses are all globally reachable unicast, re-checked on every redirect hop (`301`/`302` rewrite `POST` $\to$ `GET`; `303` rewrites non-`GET`/`HEAD` $\to$ `GET`; `307`/`308` preserve method/body; cross-origin hops strip `Authorization`). Direct `HTTP` and `WebSocket` operations do not run `Guard.fetch` and permit loopback/private/link-local targets. |

## §revalidation Revalidation, target rewrite, and SSE

- **GitHub raw rewrite (`host-rewrite`):** Acquisition `GET`s (direct `READ`, exact `FIND`, `WebFetcher`) rewrite `https://github.com/<owner>/<repo>/blob/<ref>/<path>` to `raw.githubusercontent.com` for byte transport while preserving the addressed GitHub URL as entry identity. `POST`, `PUT`, and `DELETE` are never retargeted.
- **Cache variants and freshness (`PLURNK_SCHEMES_HTTP_TTL_MS`):** Acquired responses append authoritative `x-plurnk-request-method`, `x-plurnk-fetched-at`, `x-plurnk-cache-variant` (`default` when no explicit request headers and no `Vary`, else `bypass`), and `x-plurnk-projection-id`. Only terminal `default`-variant `GET` responses with successful `body` and `header`, current projection identity, and cacheable status/directives (excluding `no-store`, `private`, and `206`) are eligible for reuse:

| Stored origin policy | Direct `READ` after acquisition | Exact `FIND` after acquisition |
|---|---|---|
| `no-store` or `private` (qualified or unqualified) | Full acquisition without stored validators | Full acquisition |
| `no-cache` (qualified or unqualified) | Validate when a stored validator exists; else acquire | Full acquisition |
| Valid `s-maxage` > `max-age` > `Expires` | Serve while fresh under both origin lifetime and `PLURNK_SCHEMES_HTTP_TTL_MS` (`s-maxage` overrides `max-age`/`Expires` even if invalid) | Reuse while fresh under both limits |
| Invalid or ambiguous explicit expiry | Treat as stale; validate or acquire | Full acquisition |
| Eligible response without explicit lifetime | Heuristic reuse within `PLURNK_SCHEMES_HTTP_TTL_MS` (`0` disables validation-free reuse) | Reuse within `PLURNK_SCHEMES_HTTP_TTL_MS` |

- **Conditional `304` revalidation:** Outside the fresh window, a reusable representation with a singular valid `ETag` or `Last-Modified` sends conditional headers. A `304` restores stored channels only when its validator corresponds per RFC 9111 §4.3.4:

| `304` validator / metadata class | Correspondence & stored-header action |
|---|---|
| Strong `ETag` / Weak `ETag` / `Last-Modified` (no `ETag`) | Must match stored strong `ETag`, weak `ETag` (weak comparison; strong `304` tag cannot promote stored weak tag), or exact `Last-Modified` instant; non-corresponding `304` triggers one unconditional `GET`, and a second or unsolicited `304` fails `502 fetch-failed`. |
| Present end-to-end origin fields vs absent origin fields | Present fields replace prior case-insensitive matches; absent origin fields are preserved (`Vary` on `304` downgrades variant to `bypass`). |
| `Content-Type`, `Content-Encoding`, `Content-Range`, `Content-Length`, projection evidence | Preserved from the stored representation; package method, acquisition stamp, and cache variant are rebuilt authoritatively. |

- **Server-sent events (`sse`):** Direct `GET` with `text/event-stream` persists `header`, returns `102`, and streams each event's joined `data` + `\n` into `body` (`text/plain`) via `eventsource-parser` and the retained `StreamSubscription` (no reconnect; buffer/transport failure settles `502`, cancellation settles `499`).

## §prefetch WebFetcher

`WebFetcher` implements `webMaterializer` ({§scheme-operation-dispatch}) over `Guard.fetch` and `HostPolicy`:

| Result | Meaning |
|---|---|
| Origin HTML / Negotiated origin Markdown | Exact source text (negotiated Markdown skips a second HTML request), MIME type, and package-stamped headers |
| Other accepted body | Unconsumed byte stream, MIME type, package-stamped headers, and cancellation owner |
| Preserved origin transport failure | Bounded origin failure recorded on `body` and `readable` when `preserveUnavailable` is requested |
| `materialize`: text / binary / HTML page | Complete UTF-8 `body`; bounded `body` bytes + optional `readable` + `projectionIdentity`; or independent HTML `body`/`readable` outcomes |
| Automatic top-level `null` vs caller cancellation | Refused target, non-`2xx` automatic response, or unavailable target returns `null`; caller `AbortSignal` aborts reject with the caller's exact reason |

## §ws-lifecycle WebSocket scheme and lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Claimed: READ claims workspace + canonical URL
    Claimed --> Connecting: seed entry, open StreamSubscription, construct WebSocket
    Claimed --> Idle: setup or construction failure
    Connecting --> Open: native open -> messages active -> READ returns 102
    Connecting --> Settling: pre-open close/error (502 connection-failed), KILL, cancel, or shutdown
    Open --> Open: ordered inbound text frame, single EDIT, or SEND 200
    Open --> Settling: close/error, KILL, cancel, binary frame (415 + close 4003), persistence failure (500), or shutdown
    Settling --> Idle: drain accepted frame prefix, close transport & subscription, release claim
```

`Ws` registers as `wss` (`ws` routes to it) with default `text/plain` channel `messages` and canonical `NetworkAddress` identity (no `headers`, `remote`, or `attachments` options; Node $\ge 26$):

| Operation / event | Contract |
|---|---|
| `plurnk.read({ path: "ws(s)://..." })` | Claims workspace/URL coordinate, seeds entry and `StreamSubscription`, opens native `WebSocket`, and returns `102` on `open`. Concurrent duplicate `read`s join the pending open and return `200` with connection state without opening a second socket. |
| `plurnk.edit({ path: "ws(s)://...", content })` / `plurnk.send({ target: "ws(s)://...", text })` | Single-statement markerless `edit` and `send` (`200`) propose (`202`, `effect: "host"`) and send one text frame when the owner is `open` (`readyState === OPEN`). Absent/non-open owner fails `409` (`Read the WebSocket URL before sending a message.`); send throw fails `502` (`The WebSocket message could not be sent.`); line ranges and multi-statement batches fail `400`/`409`. |
| `plurnk.kill({ path: "ws(s)://..." })` | Closes/cancels the claimed owner (`404` when no live owner exists; close throw fails `502`: `The WebSocket connection could not be closed.`). |
| Inbound frames & settlement | Text frames chain sequentially onto `messages` after `open`. A binary frame retains the text prefix, prunes later frames, closes with WebSocket code `4003`, and settles `415 binary-frame-unsupported`. First persistence failure prunes later frames and settles `500 message-persistence-failed`. Pre-open close settles `502 connection-failed`; post-open close drains accepted frames and settles `200` ({§execution-output-identity}, {§scheme-operation-dispatch}). |
