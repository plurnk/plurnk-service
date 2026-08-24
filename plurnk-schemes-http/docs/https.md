# https://

Plain `http://` is also accepted for the endpoint that requires it — a local
service, an interior tool. Prefer `https://` everywhere else.

## Summary

Read and modify web resources through addressable HTTP(S) entries.

Use a web URL as an addressable entry. Every exact READ acquires or refreshes a
complete representation when needed, then core selects the channel and applies
the requested text scope. HTML becomes a readable model-facing body (normally
Markdown); original server source is retained separately. Auxiliary channels
are never presented by default.

| Operation                                      | Remote action | Effect                                                                    |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `## READ0 (https://…) <scope?>`              | GET if needed | Acquire/reuse the complete response, then return the selected scoped text |
| `## FIND0 (https://…)` with matcher body     | GET if needed | Prepare an exact URL, then return flat match locations                    |
| `## SEND0 [200] (https://…)` with body       | POST          | Submit the body and stream the response                                  |
| `## EDIT0 (https://…)` with body             | PUT           | Replace the whole remote resource; do not use a line scope               |
| `## KILL0 (https://…)`                       | DELETE        | Delete the remote resource and stream the response                       |

A path-pattern FIND searches only web entries already materialized in the
workspace; a pattern cannot discover the remote web. FIND returns navigation
metadata, not the selected page body. Use READ for content.

Caller cancellation of an exact acquisition returns `499 cancelled`.

| Response                             | `body`                                              | Other channel                                  |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------- |
| Negotiated origin Markdown           | Exact origin Markdown                               | Independently requested server HTML in `#html` |
| GET HTML                             | Materializer Markdown or local HTML-reader projection | Original server HTML in `#html`                |
| GET `text/event-stream`              | Event `data` chunks after READ `102`                 | Initial response in `#header`                  |
| Configured textual response          | Complete Fetch-decoded text under its declared type | Status and headers in `#header`                |
| Origin HTTP `4xx`/`5xx`              | Preserve available origin or independently produced text | Exact status on each origin-backed channel |
| Binary with a readable projection    | Derived Unicode under the projection output type    | Origin type and projection ID in `#header`     |
| Binary without a readable projection | No fabricated text representation                   | Exact `415` Problem                            |

Generic public HTML uses the selected materializer as its body producer. A recoverable
timeout, transport error, `429`, `5xx`, or per-URL extraction failure uses the
local HTML reader and records terminal body status `203`. Authentication,
provider rejection, and malformed provider responses are hard failures and do
not silently switch producers. Any authored target metadata makes HTML use the
local reader directly. Origin Markdown always wins without the materializer.

Projection presence is structural: a returned projection is accepted even
when its content is empty. `422 no-readable-projection` means the local route
produced no model-facing body. An internal projection exception returns
non-retryable `500 projection-failed`.

A binary response uses the installed mimetype reader when one supplies a
bounded Unicode projection; raw bytes never enter a durable channel. Without a
reader, finite GET preparation returns `415 binary-response-unsupported`
without fabricating an entry. Input above the configured byte ceiling returns
`413 projection-input-limit`. A streamed POST, PUT, or DELETE response already
owns lifecycle evidence in `#header`; do not retry a mutation solely to
retrieve its binary body.

`#header` contains origin and package acquisition evidence. A materializer attempt
adds its route, status, timing, any reported request ID and credits, and bounded
failure evidence. `body`, `header`, and `html` carry independent durable
producer outcomes; the selected channel determines success. Thus `#html` or
`#header` can remain readable after a body failure, while a materializer body can
succeed without fabricating unavailable server HTML. A SEND signal is never the
remote HTTP status. A direct non-success origin response is still materialized:
origin-backed channels carry its exact durable `http-response-status` Problem,
while independently produced materializer content and acquisition headers retain
their own outcomes.

For SSE, the response and persisted `#header` establish acquisition. READ then
returns `102` while events continue. Origin close settles the subscription at
`200`; later cancellation or transfer failure settles it at `499` or `502`
without rewriting the initial READ.

Re-reading an exact URL can reuse only a complete GET acquired without
explicit request metadata whose response had no `Vary` field. Plurnk keeps one
representation per URL, so any target metadata or `Vary` response bypasses both
the freshness shortcut and old validators instead of creating a variant store.
Eligible content is served directly only while both the operator TTL and any
origin `max-age` or `Expires` lifetime remain live. `no-cache` requires origin
validation; `no-store` evidence remains in the log but supplies neither content
nor validators to a later request. Only singular, syntactically valid stored
validators are sent. A 304 restores a non-page representation only when its
ETag or Last-Modified value identifies the nominated representation; otherwise
acquisition fails without serving the stored body. Responses to POST, PUT, and
DELETE are not reused as later GET representations. A projected GET is reused
only while the installed reader has the same projection identity. Page bodies
likewise require the same origin-Markdown, local, materializer-id, or
local-fallback route. Once stale, a page composite is fully reacquired without
old validators; an origin 304 cannot certify provider or auxiliary material.

Scope never suppresses acquisition or refresh. The HTTP producer cannot see the
fragment or text coordinates; after preparation, the fragment (or `body` by
default) selects a durable channel and core applies the range. Cold and warm
forms therefore have identical selection and scope semantics.

Request headers ride inside the target as ordered trailing `{Key: value}`
blocks, one header per block:

```plurnk
## READ0 (https://api.example.com/v1/me{Authorization: Bearer TOKEN}{Accept: application/json})

## EDIT0 (https://api.example.com/v1/thing/42{Authorization: Bearer TOKEN}{Content-Type: application/json})
{"done":true}
```

Percent-encode `)`, `<`, and `}` inside a header value.
An exact FIND forwards these headers when it must acquire the URL, but the
result remains intentionally ineligible for later cache reuse. Target headers
are never forwarded to the materializer, so HTML requests carrying any explicit
metadata use the local HTML-reader projection. Executor-supplied HTML also
stays local; only generic web acquisition grants materializer authority.

GET acquisition of a GitHub `…/blob/…` URL uses its
`raw.githubusercontent.com` source. The addressed GitHub URL remains entry
identity. POST, PUT, and DELETE never use that rewrite.

| Control                  | Effect                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `## SEND0 [499] (https://…)` | Cancel the routed in-flight acquisition                               |
| `## SEND0 [410] (https://…)` | Delete the local stored response; the next READ must acquire it again |

For a persistent bidirectional connection, use `wss://`.
