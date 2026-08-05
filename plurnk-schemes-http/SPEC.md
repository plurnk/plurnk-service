# plurnk-schemes-http — Specification

This package owns the `http(s)://` request/response scheme, the `ws(s)://`
full-duplex scheme, plus automatic entry-acquisition and browser-rendering
foundations. Both handlers implement the DB-free `SchemeCtx` author contract.

## §http-manifest §1 HTTP manifest

| Field           | Value                         |
| --------------- | ----------------------------- |
| Registered name | `http` (`https` routes to it) |
| Category        | `data`                        |
| Writers         | `model`, `client`             |
| Volatile        | `true`                        |
| Model-visible   | `true`                        |
| Requires web    | `true`                        |
| Default channel | `body`                        |

| Channel  | Seed type                  | Meaning                                                         |
| -------- | -------------------------- | --------------------------------------------------------------- |
| `body`   | `application/octet-stream` | Source text, derived Unicode, binary marker, SSE data, or HTML  |
| `header` | `text/plain`               | Status line, response headers, and package acquisition metadata |
| `html`   | `text/html`                | Faithful HTML used to produce the readable body                 |

`package.json#plurnk.schemes` registers `http` through the default export and
`wss` through `Ws`.

Routing is not identity. `NetworkAddress` {§network-address} retains the exact
addressed protocol and stores
`/<host>[:<non-default-port>]<path>[?<serialized-query>]`. Query ordering,
duplicate names, and an explicit empty `?` remain significant. The fragment is
a Plurnk channel selector and never enters network identity or transport.
Request metadata affects transport but not identity. URL userinfo is rejected;
neither credentials nor metadata are reconstructed from `raw`. Within storage
pathnames, `%28` and `%29` canonicalize to literal parentheses and renderers
encode them again.

## §op-surface §2 HTTP operation surface

| Operation                         | Remote action                         | Contract                                                                                   |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Unscoped `READ(url)`              | GET unless a fresh GET copy is usable | Seed, subscribe, materialize every channel, publish the selected channel, and return `102` |
| Scoped `READ(url)<scope>`         | None                                  | Delegate selected-channel presence and scope projection to universal READ; never acquire   |
| `FIND(url)` / matcher `READ(url)` | GET only when acquisition is required | Prepare an exact entry, then use universal query, matcher, weighting, and pagination       |
| `FIND(pattern-url)`               | None                                  | Query already-materialized web entries; a path pattern does not discover the remote web    |
| `SEND[200](url):body:`            | POST                                  | Stream and persist the response under the addressed URL                                    |
| `EDIT(url):body:`                 | PUT                                   | Replace the whole remote resource; a line marker is invalid                                |
| `KILL(url)`                       | DELETE                                | Delete the remote resource and stream its response                                         |
| `SEND[410](url)`                  | None                                  | Delete the local stored entry                                                              |
| `SEND[499](url)`                  | Cancellation is engine-routed         | The routed subscription handle aborts acquisition; scheme dispatch itself is a `200` no-op |

Every direct network method uses the same streaming path. Request
headers are ordered target metadata: one trailing `{Key: value}` block per
header. The loop `SEND[code]` is never the remote HTTP status; remote status and
headers are persisted in `header`.
Exact-versus-pattern FIND preparation uses the shared
`PathSyntax.hasGlob` classifier {§path-glob}; HTTP owns no reduced
path-pattern grammar.

## §http-lifecycle §3 Acquisition, materialization, and query lifecycle

```mermaid
flowchart TD
    op{"HTTP operation"}

    op -->|scoped READ| selected["Universal READ selects the channel,<br/>requires it to exist, and applies scope"]

    op -->|FIND or matcher READ| pattern{"Path pattern?"}
    pattern -->|yes| query["Universal catalog, matcher,<br/>weight, and pagination"]
    pattern -->|no| usable{"Usable exact entry?"}
    usable -->|yes| query
    usable -->|no| prefetch["WebFetcher GET"]

    op -->|unscoped READ| fresh{"Fresh stored GET?"}
    fresh -->|yes| replay["Seed → open → replay stored channels → close"]
    fresh -->|no| stream["Seed entry → open subscription"]
    op -->|POST, PUT, or DELETE| stream

    prefetch --> guard["Guard.fetch checks the target<br/>and every followed redirect"]
    guard -->|refused or unavailable| dead
    guard -->|response| prefetchType{"Accepted response?"}
    prefetchType -->|2xx HTML| prefetchHtml["Shared HTML materialization;<br/>render lazily only if absent"]
    prefetchType -->|2xx non-HTML| prefetchClass{"Configured media class"}
    prefetchType -->|dead| dead["404 not-materialized"]
    prefetchClass -->|text| prefetchText["Materialize complete UTF-8 text"]
    prefetchClass -->|binary| prefetchBinary["Bounded readable-byte projection"]
    prefetchHtml -->|present, including empty| materialize["Write entry"]
    prefetchHtml -->|absent| noProjection["422 no-readable-projection"]
    prefetchText --> materialize
    prefetchBinary -->|present, including empty| materialize
    prefetchBinary -->|absent| noProjection
    prefetchBinary -->|input ceiling| inputLimit["413 projection-input-limit"]
    materialize --> query

    stream --> response{"Response path"}
    response -->|304 with stored GET| restore["Restore stored channels and refresh stamp"]
    response -->|GET + HTML| render["Browser → rendered HTML"]
    response -->|GET + SSE| acquired["Persist header → READ 102"]
    acquired --> events["Detached event data → body chunks"]
    response -->|other| representation{"Body representation"}
    representation -->|none| empty["Header only"]
    representation -->|configured text| text["UTF-8 response chunks → body"]
    representation -->|configured binary| binaryProjection["Bounded readable-byte projection"]
    binaryProjection -->|present, including empty| projected["Derived Unicode → body"]
    binaryProjection -->|absent| binary["Cancel bytes → typed empty marker + 415"]
    binaryProjection -->|input ceiling| binaryLimit["Typed empty marker + 413"]
    restore --> close["Persist/publish → close exact result"]
    render --> directHtml["Shared HTML materialization"]
    directHtml -->|present, including empty| close
    directHtml -->|absent| noProjection
    events --> close
    empty --> close
    text --> close
    projected --> close
    binary --> close
    binaryLimit --> close
```

| Consumer / response                          | `body`                                                          | Auxiliary materialization                              | Completion                                      |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Direct GET + HTML                            | Present projection of the rendered DOM, including `""`          | Rendered DOM in `html`; render/projection metadata     | `102`; absent projection is `422`               |
| Direct GET + `text/event-stream`             | One `data` value plus newline per `text/plain` chunk            | Initial response in `header`                           | `102` after header; origin close settles        |
| Direct request + no response body            | Empty seed                                                      | Response and package metadata in `header`              | Subscription closes; op is `102`                |
| Direct request + configured textual type     | Incremental UTF-8 text under the declared type                  | Response and package metadata in `header`              | Response-body end closes the stream             |
| Direct request + readable binary type        | Derived Unicode under the projection output type               | Origin type and projection identity in `header`        | `102`; bytes are never durable                  |
| Direct request + unreadable binary/unknown   | Empty marker; declared type or `application/octet-stream`       | Response and package metadata in `header`              | `415 binary-response-unsupported`               |
| Direct binary input exceeds configured bound | Empty marker under the source type                              | Limit evidence in the terminal Problem                 | `413 projection-input-limit`                    |
| Exact WebFetcher + non-empty 2xx HTML        | Present projection of server HTML or the lazy rendered fallback | Selected HTML plus origin/projection metadata          | Materialize; absent projection is `422`         |
| Exact WebFetcher + configured text           | Complete UTF-8 response                                         | Byte response in `header`                              | Materialize, then universal query               |
| Exact WebFetcher + readable binary           | Derived Unicode under the projection output type               | Origin type and projection identity in `header`        | Materialize; absent projection is `422`         |

A fragmentless direct operation publishes only `body`. An explicit fragment
publishes that named channel. Every acquired channel remains durable even when
it is not published to the requesting loop. FIND returns standard JSON metadata
and match coordinates; matcher READ returns selected content and navigation
evidence.

### §http-text-decoding Text response decoding

| Surface                       | Contract                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Response media type           | WHATWG `MIMEType` essence; absent or unparseable metadata becomes `application/octet-stream`     |
| Direct textual response       | Incremental replacement-mode UTF-8 through `TextDecoder`, preserving response backpressure       |
| WebFetcher textual response   | Fetch `Response.text()` UTF-8 decoding; buffering does not select a different character encoding |
| `charset` parameter           | Preserve in `header` as origin evidence; it does not replace Fetch text decoding                 |
| JSON and XML textual families | Use the same HTTP byte-to-string rule; format projections consume the resulting Unicode string   |
| Direct HTML GET               | Browser navigation owns the separate HTML document encoding algorithm                            |
| Server-sent events            | UTF-8 only under the HTML event-stream standard                                                  |
| Malformed UTF-8               | Preserve the Encoding Standard's replacement-character behavior                                  |

This decoder boundary remains text normalization, not a media-format processor.
A configured binary type bypasses it and enters the mimetype family's bounded
readable-byte projection {§mimetype-binary-input}; raw bytes never become a
durable channel.

### §html-materialization Readable materialization

`WebFetcher.materialize` is the shared readable-representation seam for exact
query preparation and executor entry acquisition. Direct GET uses the same
HTML and binary projection results while retaining incremental text streaming.

| Input or event                        | Action                                              | Result                                                          |
| ------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Configured non-HTML text              | Decode with Fetch UTF-8                             | Original representation in `body`                               |
| Configured binary with reader         | Apply the bounded byte projection                   | Derived Unicode plus source type and identity                    |
| Configured binary without reader      | Cancel without retaining bytes                      | `null`; the consumer applies its absence policy                 |
| Binary input exceeds the common bound | Cancel and preserve the typed cause                  | `WebMaterializationError` caused by `ProjectionInputLimitError`  |
| HTML with a present projection        | Stop                                                | Projection in `body`; selected HTML in `html`                    |
| HTML with an absent projection        | Render once when the caller supplies a renderer     | Rendered projection in `body`; rendered `html`                   |
| HTML still absent after fallback      | Stop                                                | `null`; the consumer applies its absence policy                 |
| Projection implementation throws      | Stop and preserve the cause                         | `WebMaterializationError` with stage `projection`                |
| Lazy renderer throws                  | Stop before another projection attempt              | `WebMaterializationError` with stage `render`                    |

A projection object is present even when its content is `""`; only `null`
denotes absence. A materialization exception retains its original `cause`; it
never enters the absence channel.

## §http-status §4 HTTP status mapping

| Outcome                                                    | Operation status                                 |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Scoped READ                                                | Exact universal selected-channel READ result     |
| Exact FIND / matcher READ after preparation                | Exact universal query result                     |
| Exact acquisition returns no WebFetcher value              | `404` (`not-materialized`)                       |
| Direct HTML or exact preparation has no readable projection | `422` (`no-readable-projection`)                 |
| Direct textual, projected-binary, or empty response        | `102`                                            |
| Direct binary response has no readable projection          | `415` (`binary-response-unsupported`)            |
| Binary projection input exceeds the configured byte bound  | `413` (`projection-input-limit`)                 |
| `SEND[410]`                                                | Exact entry-delete result                        |
| Routed `SEND[499]` dispatch                                | `200`                                            |
| Client-cancelled acquisition                               | Direct `499` (`cancelled`)                       |
| SSE cancellation after acquisition                         | `102` initial; terminal `499`                    |
| SSE parser/transfer failure after acquisition              | `102` initial; terminal `502`                    |
| Multi-statement HTTP edit batch                            | `409` (`non-atomic-edit-batch`)                  |
| Invalid target, channel, line edit, or URL userinfo        | `400` with the corresponding stable Problem kind |
| Non-corresponding 304                                      | `502` (`fetch-failed`)                           |
| Direct network or acquisition exception                    | `502` (`fetch-failed`)                           |
| Direct or prepared HTML render exception                   | `502` (`render-failed`)                          |
| Direct or prepared projection exception                    | `500` (`projection-failed`)                      |
| Uninterpreted SEND status                                  | `501` (`send-status-unsupported`)                |

An HTTP error status is still a successfully acquired direct response: its
status remains in `header` and its body streams normally. WebFetcher instead
treats a non-2xx response as unmaterializable. Handler failures use RFC 9457
Problem Details. Caught direct-acquisition diagnostics are bounded by
`PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT` in model-facing detail while complete
errors remain in daemon diagnostics.

A direct binary response first asks the installed mimetype family for a bounded
readable projection. A present result stores only its derived Unicode and
appends authoritative `x-plurnk-projection-id` evidence after the origin and
acquisition fields. Absence preserves an empty marker under the source type and
returns non-retryable `415`; exceeding the input ceiling preserves the same
marker and returns non-retryable `413` with configured and observed sizes.
These statuses describe Plurnk's materialization boundary, not the remote HTTP
outcome—a POST, PUT, or DELETE might already have changed the remote resource.
Missing or malformed `Content-Type` becomes `application/octet-stream`; the
handler does not sniff or guess unknown bytes.

## §5 Dependencies and configuration

| Surface           | Runtime contract                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Platform          | Node ≥26 native fetch, streams, abort signals, decoding, DNS, and `WebSocket`                             |
| SSE               | `eventsource-parser` for bounded WHATWG event-stream framing                                              |
| Browser rendering | Required lazy-loaded `playwright` client; executable provisioning follows {§browser-provisioning}        |

### §http-config Operator configuration

| Concern              | Contract                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Canonical registry   | Shipped `.env.defaults`; the daemon assembles it as a set-if-unset floor {§operator-config-env-defaults} |
| Required values      | Missing or invalid required values fail at their owning read; code carries no hidden fallback            |
| Browser method       | Exactly one of `launch`, `connect`, `connectOverCDP`, or `disabled`                                      |
| Method-specific data | Endpoint belongs to connection methods; channel/executable belong to launch and are mutually exclusive   |
| Browser location     | Operator-set Playwright location variables remain authoritative                                         |

`Http.ready()` verifies the selected browser route before the handler is
advertised. Disabled rendering is a valid configured route and fails clearly
if an HTML operation later requires the browser.

### §browser-provisioning Browser provisioning

| Component or method | Contract                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Playwright client   | Required runtime dependency; lazy import keeps non-render paths from initializing it                 |
| `launch`            | Requires an operator-provisioned compatible browser, selected by Playwright, channel, or exact path  |
| `connect`           | Requires an external Playwright endpoint; no local browser executable                                |
| `connectOverCDP`    | Requires an external Chromium CDP endpoint; no local browser executable                              |
| `disabled`          | Requires no browser executable; a render attempt fails clearly                                       |

The package has no browser-install lifecycle script and never assigns
`PLAYWRIGHT_BROWSERS_PATH`. Operators may provision the standard compatible
Chromium with `npx playwright install chromium`; methods never fall back into
one another.

### §automatic-fetch-check Automatic acquisition URL check

`WebFetcher` is the sole caller of `Guard.fetch`. Before automatic byte
acquisition, it accepts credential-free HTTP(S) targets only when every
resolved address is ordinary globally reachable unicast, and repeats the check
before every manually followed redirect. A refused or unresolvable target is
the ordinary unavailable `null` result.

Direct HTTP operations, WebSocket connections, Playwright navigation, browser
subresources, and Playwright/CDP endpoints do not use this check. Loopback,
private, and link-local destinations are therefore valid explicit targets.

Redirect transitions follow WHATWG Fetch: 301/302 rewrite POST to GET; 303
rewrites methods other than GET/HEAD to GET; 307/308 preserve method and body.
A body rewrite removes body headers, cross-origin redirects remove
`Authorization`, and followed redirect bodies are cancelled. The configured
hop limit returns the last redirect rather than following beyond the limit.
Validation-time DNS answers are not pinned to connection-time resolution. This
check therefore makes no DNS-rebinding, browser-sandbox, or total-egress claim.

## §render-lifecycle §6 Render lifecycle

| Concern       | Contract                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Direct gate   | A GET HTML response cancels the byte probe body and navigates through the browser                             |
| Prefetch gate | Server HTML is primary; browser rendering is a lazy fallback only when its readable projection is absent      |
| Pool          | One warm browser per `Browser`; one atomically acquired context per worker; prefetch uses worker `0`          |
| Navigation    | Mobile-emulated by default; `networkidle` with bounded substantive-DOM timeout salvage                        |
| Projection    | A present result, including `""`, becomes `body`; exact HTML used becomes `html`                              |
| Cancellation  | The render-owned page close aborts in-flight navigation; an already-aborted render never navigates            |
| Page cleanup  | Close each opened page once and await it; preserve its failure alone or aggregate it after a primary failure  |
| Shutdown      | Attempt every context and browser close, await all, then aggregate failures under {§handler-lifecycle}        |

### §host-rewrite Acquisition target rewrite

Only acquisition GETs are eligible for host rewriting. A GitHub
`…/blob/…` address uses the corresponding `raw.githubusercontent.com` source for
both byte and browser transport. Direct READ, exact FIND, matcher READ, and
WebFetcher prefetch share that rule. The originally addressed GitHub URL remains
entry identity. POST, PUT, and DELETE are never retargeted. Rewritten targets
are checked under {§automatic-fetch-check} only when `WebFetcher` acquires them.

### §revalidation GET representation freshness

Acquired responses append package-owned `x-plurnk-request-method`,
`x-plurnk-fetched-at`, and `x-plurnk-cache-variant` fields after origin headers.
Derived responses then append `x-plurnk-projection-id`. Only package metadata
after the acquisition stamp is authoritative, so an origin cannot spoof it.
Plurnk stores one representation per canonical URL rather than a variant set:

| Acquisition context                          | Package variant | Later cache use |
| -------------------------------------------- | --------------- | --------------- |
| No explicit target metadata; no `Vary`       | `default`       | Eligible        |
| Any explicit target metadata                 | `bypass`        | Ineligible      |
| No explicit target metadata; any `Vary`      | `bypass`        | Ineligible      |
| Stored response lacks authoritative evidence | Marker absent   | Ineligible      |

This conservative selection avoids persisting request values or fabricating a
multi-variant store. Exact FIND passes target metadata through acquisition but
does not reuse that response later. A `304` that introduces `Vary` changes the
restored representation's package marker to `bypass`.

Only an eligible GET representation can supply a direct READ's body, TTL stamp,
conditional validators, or exact-FIND preparation. Completion comes from
channel lifecycle, not body length: every stored channel must be final (`static`
after exact materialization or `closed` after a successful stream); `active`,
`errored`, or unknown state is ineligible. Durable operation evidence and HTTP
reuse eligibility remain distinct: an acquired response stays in the entry even
when its origin policy prevents later cache use.

| Stored origin policy                  | Direct READ after acquisition                          | Exact FIND after acquisition             |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `no-store`                            | Full acquisition without stored validators             | Full acquisition                         |
| `no-cache` (qualified or unqualified) | Validate when a stored validator exists; else acquire  | Full acquisition                         |
| Valid `max-age`                       | Serve only inside origin lifetime and operator ceiling | Reuse only while fresh under both limits |
| Valid `Expires`, without `max-age`    | Same, using the origin expiration lifetime             | Same                                     |
| Invalid or ambiguous explicit expiry  | Treat as stale; validate or acquire                    | Full acquisition                         |
| No explicit origin lifetime           | Use the operator TTL as Plurnk's heuristic             | Reuse inside the operator TTL            |

The operator ceiling is `PLURNK_SCHEMES_HTTP_TTL_MS`; `0` disables every
validation-free reuse. Origin age is the greater of the response's `Age` value
and apparent age from `Date`, plus residence since the authoritative package
stamp. A representation is fresh only while both origin lifetime and operator
ceiling permit it. Unknown cache extensions are inert. Stale content is never
served, so `must-revalidate` requires no separate path.

Outside the fresh window, direct READ sends a stored ETag or Last-Modified only
when that field is singular and syntactically valid. A 304 can restore the
stored channels only when its validator corresponds to the nominated stored
representation:

| 304 validator                                         | Correspondence requirement                  |
| ----------------------------------------------------- | ------------------------------------------- |
| Strong ETag                                           | Same stored strong ETag                     |
| Weak ETag                                             | Same opaque tag under weak comparison       |
| No ETag; Last-Modified                                | Same valid stored Last-Modified instant     |
| Missing, malformed, unsolicited, or non-corresponding | Invalid acquisition; `502` (`fetch-failed`) |

A corresponding 304 restores the stored channels without rendering and
updates the header under the following ownership rule; any other response
replaces the channels:

| 304 metadata class                                                    | Stored-header action                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| Present end-to-end origin fields, including cache and validators      | Replace prior fields of the same case-insensitive name  |
| Origin fields absent from the 304                                     | Preserve                                                |
| `Content-Type`, `Content-Encoding`, `Content-Range`, `Content-Length` | Preserve metadata describing the already-processed body |
| Package method, acquisition stamp, and variant                        | Rebuild authoritatively; refresh stamp and variant      |
| Projection identity                                                   | Preserve                                                |

A 304-provided `Vary`, `no-store`, `no-cache`, expiry, or validator
therefore governs the next operation without relabeling derived Unicode as a
different source representation.

A stored derived representation is reusable only while its projection identity
matches the currently installed reader for the origin media type. A mismatch
invalidates the body, TTL shortcut, and origin validators together: a 304 can
certify unchanged source bytes, not output from a different projection.

POST, PUT, and DELETE responses retain their method marker but cannot satisfy a
later GET or exact-FIND acquisition. An unmarked authored entry and an eligible
stored GET remain visible to universal FIND as durable evidence; exact HTTP
preparation applies the policy above. `SEND[410]` deletes the stored entry.

### §sse Server-sent events

A direct GET whose response is `text/event-stream` feeds the bounded parser.
Each event's joined `data` value plus a newline becomes one `text/plain` body
chunk. Comments and `event`, `id`, and `retry` metadata are not projected.
The response plus persisted header is the acquisition boundary: READ returns
`102`, and parsing continues through the retained `StreamSubscription` without
retaining `SchemeCtx`. Buffer exhaustion and post-acquisition transport failure
settle that subscription at `502`; cancellation settles it at `499`. The
handler does not reconnect; events accumulate until the origin closes or the
operation is cancelled.

## §prefetch §7 WebFetcher

| Result                       | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Non-empty 2xx HTML           | Server text, MIME type, package-stamped headers, and a lazy browser renderer             |
| Other 2xx body               | One unconsumed byte stream, MIME type, package-stamped headers, and cancellation owner   |
| Materialized configured text | Complete Fetch-decoded UTF-8 body                                                        |
| Materialized readable binary | Bounded derived Unicode plus source type, projection identity, and enriched header       |
| Lazy renderer value          | Non-empty rendered HTML, or `null` only when rendering yields no HTML                    |
| Lazy renderer failure        | Rejects with the complete browser failure; materialization preserves stage and cause     |
| Top-level fetch `null`       | Refused, unreachable, timed-out, non-2xx, missing body, or empty HTML byte response       |
| Materialization `null`       | Empty configured text or no final readable projection                                    |
| Caller-cancelled acquisition | Rejects with the caller signal's exact reason                                            |

Top-level `null` is a liveness value rather than a thrown failure. Caller
cancellation is not liveness: a pre-aborted caller fails before acquisition, and
the first abort reason selected between the caller and configured byte-probe
deadline owns the outcome. The probe deadline remains `null`. WebFetcher owns
no entry identity, registry selection, or query policy; its consumer supplies
the projection capability and materializes the returned value. Lazy-render
exceptions remain distinct from a renderer that honestly returns no HTML. The
handler lifecycle closes the shared browser.

## §ws §8 WebSocket

`wss` is a first-class data scheme; `ws` routes to the same handler. WebSocket
is bidirectional and stateful, not an HTTP content type. It uses `messages` as a
`text/plain` default channel and the same canonical network address contract
{§network-address}.

### §ws-lifecycle Socket ownership and settlement

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Claimed: claim canonical workspace address
    Claimed --> Connecting: seed entry, open subscription, construct socket
    Claimed --> Idle: setup or construction failure
    Connecting --> Open: native open; messages active; READ 102
    Connecting --> Settling: pre-open close/error, KILL, cancel, activation failure, or shutdown
    Open --> Open: ordered inbound frame or SEND[200]
    Open --> Settling: closing state, close/error, KILL, cancel, binary frame, persistence failure, or shutdown
    Settling --> Idle: await retained work, close subscription, release claim
```

| Operation or event                | Contract                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `READ(ws(s)://…)`                 | Claim, seed/subscribe, construct `CONNECTING`, then return `102` after native `open` plus durable activation     |
| Concurrent duplicate READ         | `409` in `claimed`, `connecting`, `open`, or `settling`; cleanup releases the only claim                         |
| `SEND[200](ws(s)://…)`            | Send only for owner `open` plus native `readyState=OPEN`; absent or non-open owner is `409`; send throw is `502` |
| `SEND[499](ws(s)://…)`            | Engine-routed cancellation closes the owning READ; scheme dispatch returns `200`                                 |
| `KILL(ws(s)://…)`                 | Close/cancel the claimed owner; no owner is `404`; an attempted close throw is `502`                             |
| Inbound frame after native `open` | Join the owner's persistence chain; the next write begins only after the preceding write succeeds               |
| Binary frame after native `open`  | Retain the text prefix, prune the binary and later frames, settle `415 binary-frame-unsupported`, close `1003`   |
| First inbound persistence failure | Retain the successful prefix, prune queued and later frames, and settle with `500 message-persistence-failed`    |
| Socket closes before `open`       | Close subscription with `502 connection-failed`; the pending READ returns that exact failure                     |
| Socket closes after `open`        | Drain the accepted frame prefix; initial READ remains `102`; settle with `200` unless a drained write fails       |
| Failure after `open`              | Initial READ remains `102`; persist the exact terminal failure and wake through subscription settlement          |

The in-instance registry is keyed by workspace, addressed protocol, and
canonical network pathname. The claim remains registered through terminal
cleanup, so a new READ cannot overlap an owner's subscription settlement. Every
terminal path drains retained owner work, closes the transport when necessary,
closes the durable subscription, then releases the claim. A persistence failure
found while draining supersedes a graceful terminal result; cancellation and
transport failures retain their exact result. Handler shutdown requests
settlement for every remainder, awaits every owner, and aggregates
transport-close failures under {§handler-lifecycle}.

| Transport limit    | Current contract                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Payload projection | String event data only into `text/plain`; binary data terminates with Plurnk `415` and WebSocket `1003` |
| Reconnection       | None; READ again after terminal cleanup                                                                 |
| Handshake metadata | Default global-WebSocket identity; custom target headers are not applied                                |
| Runtime            | Node ≥26                                                                                                |
