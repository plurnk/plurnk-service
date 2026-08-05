# http(s)://

Use a web URL as an addressable entry. An unscoped READ performs a GET
or reuses a fresh stored GET representation, then streams the selected response
channel. HTML becomes a readable model-facing body (normally markdown); its
faithful DOM is retained separately. Auxiliary channels are never presented by
default.

| Operation                         | Remote action | Effect                                                                         |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| Unscoped `READ(http(s)://…)`      | GET           | Acquire/reuse the response and publish the selected channel                    |
| Scoped `READ(http(s)://…)<scope>` | None          | Read a range from the selected already-materialized channel; never refetch     |
| `FIND(http(s)://…):matcher`       | GET if needed | Prepare an exact URL, then return standard JSON metadata and match coordinates |
| `SEND[200](http(s)://…):body:`    | POST          | Submit the body and stream the response                                        |
| `EDIT(http(s)://…):body:`         | PUT           | Replace the whole remote resource; do not use a line scope                     |
| `KILL(http(s)://…)`               | DELETE        | Delete the remote resource and stream the response                             |

A path-pattern FIND searches only web entries already materialized in the
workspace; a pattern cannot discover the remote web. FIND returns navigation
metadata, not the selected page body. Use READ for content.

Caller cancellation of an exact acquisition returns `499 cancelled`. The
independent byte-probe deadline remains an ordinary unavailable result.

| Direct response                      | `body`                                                       | Other channel                              |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| GET HTML                             | Readable projection of the rendered page                     | Faithful rendered DOM in `#html`           |
| GET `text/event-stream`              | Event `data` chunks after READ `102`                          | Initial response in `#header`              |
| Configured textual response          | Incremental UTF-8 text under its declared type               | Status and headers in `#header`            |
| Binary with a readable projection    | Derived Unicode under the projection output type             | Origin type and projection ID in `#header` |
| Binary without a readable projection | Empty marker under its type or `application/octet-stream`    | Status and headers in `#header`            |

Projection presence is structural: a returned projection is accepted even
when its content is empty. `422 no-readable-projection` means exact acquisition,
or a direct HTML READ, produced no model-facing body. A direct HTML READ retains
its faithful `#html` and `#header` evidence; exact FIND preparation creates no entry.
An internal projection exception instead returns non-retryable
`500 projection-failed`; a browser failure returns retryable
`502 render-failed`.

A binary response uses the installed mimetype reader when one supplies a
bounded Unicode projection; raw bytes never enter a durable channel. Without a
reader, a direct operation returns `415 binary-response-unsupported`. Input
above the configured byte ceiling returns `413 projection-input-limit`. The
remote response was received and its metadata remains in `#header`; do not
retry a POST, PUT, or DELETE solely to retrieve its binary body. Exact FIND
instead prunes responses that produce no readable projection.

`#header` contains the remote HTTP status line and headers. The PLURNK
operation result describes the streaming lifecycle; `SEND[code]` is never the
remote HTTP status. An HTTP 4xx/5xx response still streams normally and remains
visible in `#header`.

For SSE, the response and persisted `#header` establish acquisition. READ then
returns `102` while events continue. Origin close settles the subscription at
`200`; later cancellation or transfer failure settles it at `499` or `502`
without rewriting the initial READ.

Re-reading without a scope can reuse only a complete GET acquired without
explicit request metadata whose response had no `Vary` field. Plurnk keeps one
representation per URL, so any target metadata or `Vary` response bypasses both
the freshness shortcut and old validators instead of creating a variant store.
Eligible content is served directly only while both the operator TTL and any
origin `max-age` or `Expires` lifetime remain live. `no-cache` requires origin
validation; `no-store` evidence remains in the log but supplies neither content
nor validators to a later request. A 304 restores the stored channels without
rendering and updates cache and validator metadata while preserving fields that
describe the already-processed body. Responses to POST, PUT, and DELETE are not
reused as later GET representations. A projected GET is reused only while the
installed reader has the same projection identity; changing it forces a full
acquisition without old validators.

A scoped READ never fetches. Its fragment, or `body` by default, selects an
already-materialized channel before the universal READ contract applies the
range. If that channel is absent, READ the URL without a scope to acquire the
response first.

Request headers ride inside the target as ordered trailing `{Key: value}`
blocks, one header per block:

```plurnk
<<READ(https://api.example.com/v1/me{Authorization: Bearer TOKEN}{Accept: application/json})::READ
<<EDIT(https://api.example.com/v1/thing/42{Authorization: Bearer TOKEN}{Content-Type: application/json}):{"done":true}:EDIT
```

Percent-encode `)`, `<`, and `}` inside a header value.
An exact FIND forwards these headers when it must acquire the URL, but the
result remains intentionally ineligible for later cache reuse.

GET acquisition of a GitHub `…/blob/…` URL uses its
`raw.githubusercontent.com` source. The addressed GitHub URL remains entry
identity. POST, PUT, and DELETE never use that rewrite.

| Control                  | Effect                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `SEND[499](http(s)://…)` | Cancel the routed in-flight acquisition                               |
| `SEND[410](http(s)://…)` | Delete the local stored response; the next READ must acquire it again |

For a persistent bidirectional connection, use `wss://`.
