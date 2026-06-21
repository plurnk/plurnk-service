# http(s)://

Fetch a URL. An HTML page is rendered with headless Chromium and its
final post-hydration DOM is delivered as the `body` channel (text/html);
non-HTML bodies stream raw with their real Content-Type.

- `READ(http(s)://…)` — fetch + stream the body (102 Processing).
- `SEND[200](…)` — POST a body, stream the response.
- `SEND[410](…)` — delete the cached entry.
- `SEND[499](…)` — cancel an in-flight fetch/render.

Status: 102 streaming · 499 cancelled · 502 upstream/render failure.
