# http(s)://

`READ(http(s)://…)` — fetch a URL. HTML is rendered (headless browser, post-JS)
and returned as **markdown by default** (main content; nav/ads/chrome stripped).
Non-HTML returns raw bytes under its `Content-Type`.

Channels:

- `#body` — raw rendered HTML (`text/html`): `READ(http(s)://…#body)`
- `#header` — response status line + headers (`text/plain`)

Ops:

- `SEND[200](http(s)://…)` — POST a body; raw response (never rendered).
- `SEND[410](http(s)://…)` — delete the entry.
- `SEND[499](http(s)://…)` — cancel an in-flight fetch.

Status: `102` streaming · `499` cancelled · `502` upstream/render failure.
