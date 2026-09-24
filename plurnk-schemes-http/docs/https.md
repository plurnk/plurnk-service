# https://

Plain `http://` is accepted as well, for an endpoint that requires it.

## Summary

Read and modify web resources through addressable HTTP(S) entries.

A web URL is an addressable entry. Every exact READ acquires or refreshes a
complete representation when needed, then core selects the channel and applies
the requested text/byte scope. An HTML page's `body` is the server source; its
readable Markdown (a materializer's or the local reader's) is `#readable`, and
every READ names the page's other channels with their tokens.

| Operation                                      | Remote action | Effect                                                                    |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `READ (https://…) <scope?>`              | GET if needed | Acquire/reuse the complete response, then return the selected scoped text |
| `FIND (https://…) [{"pattern": …}]` | GET if needed | Return matching text regions for a scoped READ                           |
| `SEND (https://…)` with body             | POST          | Submit the body and stream the response                                  |
| `EDIT (https://…)` with body             | PUT           | Replace the whole remote resource; a line scope does not apply           |
| `KILL (https://…)`                       | none          | Cancel a live acquisition of the address, or forget its stored response  |
| `KILL (https://…) [{"remote": true}]`              | DELETE        | Delete the remote resource and stream the response                       |

A path-pattern FIND searches only web entries already materialized in the
workspace; a pattern cannot discover the remote web. For matched content, READ
the returned `#channel` using the `region` as
`<startLine,startColumn,endLine,endColumn>`. Caller cancellation of an exact
acquisition returns `499 cancelled`.

## Channels

| Response                             | `body`                                              | Other channel                                  |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------- |
| Negotiated origin Markdown           | Exact origin Markdown                               | Status and headers in `#header`; nothing else  |
| GET HTML                             | Original server HTML                                | Materializer Markdown or local HTML-reader projection in `#readable` |
| GET `text/event-stream`              | Event `data` chunks after READ `102`                 | Initial response in `#header`                  |
| Configured textual response          | Complete Fetch-decoded text under its declared type | Status and headers in `#header`                |
| Origin HTTP `4xx`/`5xx`              | Preserve available origin text or bytes             | Exact status on each origin-backed channel    |
| Binary with a readable projection    | Original bytes, shown as hex                        | Facts/text in `#readable`; evidence in `#header` |
| Binary without a readable projection | Original bytes, shown as hex                        | Evidence in `#header`; no invented facts        |

`#header` holds origin and acquisition evidence, including a materializer's
route, status and timing. `body`, `#header` and `#readable` carry independent
outcomes: `#readable` or `#header` can remain readable after a source failure,
and a direct non-success origin response is still materialized, its
origin-backed channels carrying the exact `http-response-status` Problem. A
READ of the source names `#readable` and its tokens. `422
no-readable-projection` on `#readable` means the local route produced no
readable text; `413 projection-input-limit` is input above the configured byte
ceiling; `404 channel-not-found` lists the available channels and does not
mean the URL is missing. A binary response keeps its original bytes in `body`;
READ shows their hex and, on a supporting model, attaches the native media;
`#bytes` selects the hex view explicitly. A SEND signal is never the remote
HTTP status; a failed mutation's response evidence is in `#header`, and a
retry re-executes the mutation.

For SSE, READ returns `102` while events continue; origin close settles the
subscription at `200`, and later cancellation or transfer failure settles it
at `499` or `502` without rewriting the initial READ. Re-reading an exact URL
reuses a complete GET while the operator TTL and the origin's own lifetime
allow; request metadata, a `Vary` response, a partial `206`, or a POST, PUT or
DELETE response is never reused as a later GET. Scope never suppresses
acquisition or refresh.

## Request headers

Request headers share one `[{"Key": "value", ...}]` metadata block after the
target and any scope; option objects in the array merge left to right, and
metadata stays on one line.

````READ (https://api.example.com/v1/me) [{"Accept": "application/json"}]
````

````EDIT (https://api.example.com/v1/thing/42) [{"Content-Type": "application/json"}]
{"done":true}
````

````SEND (https://api.example.com/v1/search) [{"Content-Type": "application/json"}]
{"query":"plurnk"}
````

A request with explicit metadata is ineligible for later cache reuse, and its
HTML uses the local reader projection: request headers never reach the
materializer. GET acquisition of a GitHub `…/blob/…` URL uses its
`raw.githubusercontent.com` source; the addressed URL remains entry identity,
and POST, PUT and DELETE never use that rewrite.

A `KILL` of an https:// address never reaches the remote unless it carries
`[{"remote": true}]`: while an acquisition is in flight it cancels that
acquisition, otherwise it forgets the stored response so the next READ must
acquire it again. With `[{"remote": true}]`, the other options in that block
are the DELETE request's headers.

For a persistent bidirectional connection, `wss://` (`wss.md`).
