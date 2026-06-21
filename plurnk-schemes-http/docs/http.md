# http(s)://

Fetch a web page — or any URL. `READ` runs the page in a real headless browser
and hands you its **main content as clean markdown**: the article text with
navigation, ads, cookie banners, and page chrome stripped out. You don't ask
for markdown — you READ the URL and read what comes back.

## Ops

- `READ(http(s)://…)` — fetch the URL. An HTML page is first rendered with
  headless Chromium, so JavaScript-built pages come back **fully hydrated**, not
  as an empty shell. Streaming: returns `102` immediately and the content lands
  on the entry, ready to read.
- `SEND[200](http(s)://…)` — request with a body (POST); the response comes back
  the same way. A POST is never browser-rendered (it can't be replayed as a
  navigation) — you get the raw response.
- `SEND[410](http(s)://…)` — delete the cached entry.
- `SEND[499](http(s)://…)` — cancel an in-flight fetch/render.

## What a fetched page gives you

Reading a fetched HTML page returns its **readable content as markdown** — the
main content extracted, the chrome discarded. That is the default; there is no
flag, suffix, or target-mimetype to request it. The page's raw form and metadata
are also on the entry, on named channels you can read explicitly:

- **`body`** — the raw rendered HTML (`text/html`): the final post-hydration DOM,
  exactly as the browser serialized it after scripts ran. Read this when you
  need the literal markup rather than the readable prose. Select it with a URI
  fragment: `READ(http(s)://…#body)`.
- **`header`** (`text/plain`) — the response status line and headers.
  `READ(http(s)://…#header)`.

A **non-HTML** URL (JSON, an image, a PDF, …) is not rendered: its raw bytes
stream straight onto `body` under their real `Content-Type`, and that — not
markdown — is what you read.

## Where the markdown comes from

This scheme's job ends at the rendered page: it runs the page in a real browser
and delivers the final HTML. Turning that HTML into readable markdown is the
runtime's automatic projection of *any* `text/html` content — the identical
result you'd get reading a local `.html` file. http never cleans, extracts, or
markdownifies; the readable markdown is simply what reading HTML yields.

## Status codes

`102` streaming · `499` cancelled · `502` upstream or render failure.
