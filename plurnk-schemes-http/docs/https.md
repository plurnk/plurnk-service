# https:// and wss://

Plain `http://` and `ws://` are accepted as well, for endpoints that require them.

## Summary

Read and modify web resources through addressable http, https, ws, wss, and sse entries.

| Tool & arguments | Remote action | Effect |
| --- | --- | --- |
| `read` `{"path": "https://…", "range"?: "…", "headers"?: {…}}` | GET if needed | Acquire/reuse the complete response, then return the selected scoped text (`#readable` for HTML Markdown) |
| `find` `{"path": "https://…", "pattern": "…"}` | GET if needed | Return matching text regions for a scoped `read` (glob paths search only already-materialized workspace entries) |
| `send` `{"target": "https://…", "text": "…", "headers"?: {…}}` | POST | Submit the body and stream the response |
| `edit` `{"path": "https://…", "text": "…", "headers"?: {…}}` | PUT | Replace the whole remote resource; a line scope does not apply |
| `kill` `{"path": "https://…"}` | none | Cancel a live acquisition of the address, or forget its stored response |
| `kill` `{"path": "https://…", "remote": true}` | DELETE | Delete the remote resource and stream the response |

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
- Requests with explicit `headers` (for example `{"Accept": "application/json"}` or `{"Content-Type": "application/json"}`) bypass cache reuse.

## WebSocket (`wss://` and `ws://`)

| Tool & arguments | Effect |
| --- | --- |
| `read` `{"path": "wss://host/path"}` | Claim the address, connect, mark `messages` active on `open` (`102`), and stream inbound text frames |
| Second `read` of the same address | Read the retained representation on the existing connection without reconnecting |
| `edit` `{"path": "wss://host/path", "text": "..."}` | Propose one whole text frame through an open connection, sent on acceptance (no ranges) |
| `send` `{"target": "wss://host/path", "text": "..."}` | Propose one whole text frame, sent on acceptance (may follow the opening `read` in the same turn) |
| `kill` `{"path": "wss://host/path"}` | Close or cancel the connection (`404` when no connection exists) |

| Connection state | Meaning | `edit` or directed `send` |
| --- | --- | --- |
| `claimed` | Address reserved while setup runs | `409`; no second connection is created |
| `connecting` | Socket exists but has not emitted `open` | `409`; wait for the active stream event |
| `open` | `open` observed and socket is open | Proposes one whole text frame, sent on acceptance |
| `settling` | Terminal transition owns cleanup | `409`; wait for cleanup before another `read` |

- Close before `open` returns `502`; after `open`, close, cancellation, or error settles the subscription without rewriting the initial `read`.
- Connection identity is `(workspace, protocol, host, port, path, query)`; `messages` is the only channel, text frames only (`415` on binary frames), no automatic reconnection (`read` again after settlement), and no custom request headers.
