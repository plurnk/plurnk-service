# https://

Plain `http://` is accepted as well, for an endpoint that requires it.

## Summary

Read and modify web resources through addressable HTTP(S) entries.

| Operation | Remote action | Effect |
| --- | --- | --- |
| `plurnk.read({ path: "https://…", range })` | GET if needed | Acquire/reuse the complete response, then return the selected scoped text (`#readable` for HTML Markdown) |
| `plurnk.find({ path: "https://…", pattern })` | GET if needed | Return matching text regions for a scoped `read` (glob paths search only already-materialized workspace entries) |
| `plurnk.send({ target: "https://…", text })` | POST | Submit the body and stream the response |
| `plurnk.edit({ path: "https://…", text })` | PUT | Replace the whole remote resource; a line scope does not apply |
| `plurnk.kill({ path: "https://…" })` | none | Cancel a live acquisition of the address, or forget its stored response |
| `plurnk.kill({ path: "https://…", remote: true })` | DELETE | Delete the remote resource and stream the response |

## Channels

| Response | `body` | Other channel |
| --- | --- | --- |
| Negotiated origin Markdown | Exact origin Markdown | Status and headers in `#header`; nothing else |
| GET HTML | Original server HTML | Local HTML-reader projection in `#readable` |
| GET `text/event-stream` | Event `data` chunks after `read` `102` | Initial response in `#header` |
| Configured textual response | Complete Fetch-decoded text under its declared type | Status and headers in `#header` |
| Origin HTTP `4xx`/`5xx` | Preserve available origin text or bytes | Exact `http-response-status` Problem on origin-backed channels; `#header` remains readable |
| Binary response | Original bytes (shown as hex in `#bytes`, native media attached when supported) | Facts/text in `#readable` when available; evidence in `#header` |

- `422 no-readable-projection` on `#readable` means the local reader produced no readable text; `413 projection-input-limit` means the response exceeded the byte ceiling; `404 channel-not-found` lists the available channels.
- For SSE (`text/event-stream`), `read` returns `102` while events stream and settles at `200` on origin close (`499` on cancellation, `502` on transfer failure).
- Re-reading an exact URL reuses a cached complete GET within TTL unless `headers` were supplied, the response carried `Vary` or `206`, or the entry came from POST/PUT/DELETE. GET of a GitHub `…/blob/…` URL fetches `raw.githubusercontent.com`.

## Request headers

plurnk.read({ path: "https://api.example.com/v1/me", headers: { "Accept": "application/json" } })

plurnk.edit({ path: "https://api.example.com/v1/thing/42", headers: { "Content-Type": "application/json" }, text: "{\"done\":true}" })

plurnk.send({ target: "https://api.example.com/v1/search", headers: { "Content-Type": "application/json" }, text: "{\"query\":\"plurnk\"}" })

Requests with explicit `headers` bypass cache reuse. For persistent bidirectional connections, see `skill://plurnk/wss.md`.
