# https://

Plain `http://` is accepted as well, for an endpoint that requires it.

## Summary

Read and modify web resources through addressable HTTP(S) entries.

A web URL is an addressable entry. Every exact `plurnk.read` acquires or refreshes a
complete representation when needed, then core selects the channel and applies
the requested text/byte scope. An HTML page's `body` is the server source; its
readable Markdown (a materializer's or the local reader's) is `#readable`, read as
`await plurnk.read({ path: "https://…#readable" });`, and every `read` names the page's other channels with their tokens.

| Operation | Remote action | Effect |
| --- | --- | --- |
| `await plurnk.read({ path: "https://…", range })` | GET if needed | Acquire/reuse the complete response, then return the selected scoped text |
| `await plurnk.find({ path: "https://…", pattern })` | GET if needed | Return matching text regions for a scoped `read` |
| `await plurnk.send({ target: "https://…", text })` | POST | Submit the body and stream the response |
| `await plurnk.edit({ path: "https://…", content })` | PUT | Replace the whole remote resource; a line scope does not apply |
| `await plurnk.kill({ path: "https://…" })` | none | Cancel a live acquisition of the address, or forget its stored response |
| `await plurnk.kill({ path: "https://…", metadata: ["{\"remote\": true}"] })` | DELETE | Delete the remote resource and stream the response |

A path-pattern `find` searches only web entries already materialized in the
workspace; a pattern cannot discover the remote web. For matched content, `read`
the returned `#channel` on the path (`…#channel`) using the `region` as
`range: "startLine,startColumn,endLine,endColumn"`. Caller cancellation of an exact
acquisition returns `499 cancelled`.

## Channels

| Response | `body` | Other channel |
| --- | --- | --- |
| Negotiated origin Markdown | Exact origin Markdown | Status and headers in `#header`; nothing else |
| GET HTML | Original server HTML | Materializer Markdown or local HTML-reader projection in `#readable` |
| GET `text/event-stream` | Event `data` chunks after `read` `102` | Initial response in `#header` |
| Configured textual response | Complete Fetch-decoded text under its declared type | Status and headers in `#header` |
| Origin HTTP `4xx`/`5xx` | Preserve available origin text or bytes | Exact status on each origin-backed channel |
| Binary with a readable projection | Original bytes, shown as hex | Facts/text in `#readable`; evidence in `#header` |
| Binary without a readable projection | Original bytes, shown as hex | Evidence in `#header`; no invented facts |

`#header` holds origin and acquisition evidence, including a materializer's
route, status and timing. `body`, `#header` and `#readable` carry independent
outcomes: `#readable` or `#header` can remain readable after a source failure,
and a direct non-success origin response is still materialized, its
origin-backed channels carrying the exact `http-response-status` Problem. A
`read` of the source names `#readable` and its tokens. `422
no-readable-projection` on `#readable` means the local route produced no
readable text; `413 projection-input-limit` is input above the configured byte
ceiling; `404 channel-not-found` lists the available channels and does not
mean the URL is missing. A binary response keeps its original bytes in `body`;
`read` shows their hex and, on a supporting model, attaches the native media;
`#bytes` selects the hex view explicitly. A failed mutation's response evidence
is in `#header`, and a retry re-executes the mutation.

For SSE, `read` returns `102` while events continue; origin close settles the
subscription at `200`, and later cancellation or transfer failure settles it
at `499` or `502` without rewriting the initial `read`. Re-reading an exact URL
reuses a complete GET while the operator TTL and the origin's own lifetime
allow; request metadata, a `Vary` response, a partial `206`, or a POST, PUT or
DELETE response is never reused as a later GET. Scope never suppresses
acquisition or refresh.

## Request headers

Request headers share one `metadata` array of JSON option objects; option objects in the array merge left to right.

await plurnk.read({ path: "https://api.example.com/v1/me", metadata: ["{\"Accept\": \"application/json\"}"] });

await plurnk.edit({ path: "https://api.example.com/v1/thing/42", metadata: ["{\"Content-Type\": \"application/json\"}"], content: "{\"done\":true}" });

await plurnk.send({ target: "https://api.example.com/v1/search", metadata: ["{\"Content-Type\": \"application/json\"}"], text: "{\"query\":\"plurnk\"}" });

A request with explicit metadata is ineligible for later cache reuse, and its
HTML uses the local reader projection: request headers never reach the
materializer. GET acquisition of a GitHub `…/blob/…` URL uses its
`raw.githubusercontent.com` source; the addressed URL remains entry identity,
and POST, PUT and DELETE never use that rewrite.

A `plurnk.kill` of an `https://` address never reaches the remote unless it carries
`metadata: ["{\"remote\": true}"]`: while an acquisition is in flight it cancels that
acquisition, otherwise it forgets the stored response so the next `read` must
acquire it again. With `{"remote": true}`, the other options in that object
are the DELETE request's headers.

For a persistent bidirectional connection, `wss://` (`skill://plurnk/wss.md`).
