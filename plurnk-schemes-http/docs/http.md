# http(s)://

Fetch a URL. HTML is rendered (headless browser, post-JS) and returned as
**markdown by default** (main content; nav/ads/chrome stripped). Non-HTML
returns raw bytes under its `Content-Type`. Every request streams its response:
status `102` now, the body/header channels fill, you READ the entry next turn.

The HTTP method is the **op**:

- `READ(http(s)://…)` — GET.
- `SEND[200](http(s)://…):body:` — POST the body.
- `EDIT(http(s)://…):body:` — PUT the body (replaces the whole resource; no `<L>`).
- `KILL(http(s)://…)` — DELETE the resource.

Channels:

- `#body` — response body (rendered HTML as `text/html`, else raw under its `Content-Type`)
- `#header` — response status line + headers (`text/plain`)

Request headers ride **inside the target** as trailing `{Key: value}` blocks —
one header per block, so a value may contain commas/colons:

```
READ(https://api.example.com/v1/me{Authorization: Bearer TOKEN}{Accept: application/json})
EDIT(https://api.example.com/v1/thing/42{Authorization: Bearer TOKEN}{Content-Type: application/json}):{"done":true}:
```

Percent-encode `)`, `<`, and `}` inside a header value (the path-encoding rule).

Cancel / cache:

- `SEND[499](http(s)://…)` — cancel an in-flight request (abort the fetch).
- `SEND[410](http(s)://…)` — delete the locally cached response entry. This is a
  cache drop, **not** an HTTP DELETE — use `KILL` to DELETE the remote resource.

The `SEND[code]` is loop disposition (`102`/`200`/…), never the HTTP status —
the real `2xx`/`4xx` comes back in `#header`.

Status: `102` streaming · `499` cancelled · `502` upstream/render failure.
