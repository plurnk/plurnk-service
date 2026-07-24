# http(s)://

Fetch a URL. HTML is rendered (headless browser, post-JS) and returned as
**markdown by default** (main content; nav/ads/chrome stripped). Non-HTML
returns its readable content under the response `Content-Type`. Every request
streams its response: status `102` now, then an ordinary fragmentless READ
returns the sanitized body. Auxiliary transport/archive channels are never
presented by default.

Re-reading a URL **revalidates** it: the prior fetch's validators (`ETag`/
`Last-Modified`) go out on the next READ, and if the page is unchanged the
stored copy is served without re-rendering — always fresh, but cheap when
nothing changed. Within the operator's freshness window a re-read serves the
stored copy directly, skipping even that check. You just READ again; there's
no cache flag to manage.

The HTTP method is the **op**:

- `READ(http(s)://…)` — GET.
- `SEND[200](http(s)://…):body:` — POST the body.
- `EDIT(http(s)://…):body:` — PUT the body (replaces the whole resource; no `<L>`).
- `KILL(http(s)://…)` — DELETE the resource.

The ordinary URL is the model-facing markdown for HTML, or readable response
content for other textual types. Diagnostic channels require explicit access:

- `#html` — faithful rendered DOM for HTML (`text/html`)
- `#header` — response status line + headers (`text/plain`)

Request headers ride **inside the target** as trailing `{Key: value}` blocks —
one header per block, so a value may contain commas/colons:

```
READ(https://api.example.com/v1/me{Authorization: Bearer TOKEN}{Accept: application/json})
EDIT(https://api.example.com/v1/thing/42{Authorization: Bearer TOKEN}{Content-Type: application/json}):{"done":true}:
```

Percent-encode `)`, `<`, and `}` inside a header value (the path-encoding rule).

Host handling: a GitHub `…/blob/…` URL is fetched as its `raw.githubusercontent.com`
source (line-navigable, exact) rather than the JS code-viewer page — so
`READ(https://github.com/owner/repo/blob/main/src/x.ts)` returns the file's source.

Cancel / cache:

- `SEND[499](http(s)://…)` — cancel an in-flight request (abort the fetch).
- `SEND[410](http(s)://…)` — drop the locally cached copy, forcing the next READ
  to full-fetch instead of revalidate. A local cache drop, **not** an HTTP
  DELETE — use `KILL` to DELETE the remote resource.

The `SEND[code]` is loop disposition (`102`/`200`/…), never the HTTP status —
the real `2xx`/`4xx` comes back in `#header`.

Status: `102` streaming · `499` cancelled · `502` upstream/render failure.

For a persistent, bidirectional connection, see the `wss://` scheme.
