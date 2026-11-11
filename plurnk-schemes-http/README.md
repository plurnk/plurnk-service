# plurnk-schemes-http

HTTP(S) request/response and WebSocket scheme handlers for the
[plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The package is
authored against the DB-free
[`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes)
`SchemeCtx` contract.

## HTTP operations

| Operation                                      | Behavior                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `plurnk.read({ path: "http(s)://…" })`         | Fetch or reuse/revalidate a GET representation, then project the selected response channel |
| `plurnk.read({ path: "http(s)://…", range: "…" })` | Apply standard entry scope after the same acquisition/revalidation; scope does not bypass it |
| `plurnk.find({ path: "http(s)://…", pattern: "…" })` | Materialize an exact URL when required, then use the universal entry query and matcher    |
| `plurnk.send({ target: "http(s)://…", text: "…" })` | POST the body and stream the response                                                     |
| `plurnk.edit({ path: "http(s)://…", content: "…" })` | PUT a whole-resource replacement; line-scoped HTTP edits are invalid                      |
| `plurnk.kill({ path: "http(s)://…" })`         | Cancel a live acquisition of the address, or forget its stored response                 |
| `plurnk.kill({ path: "http(s)://…", remote: true })` | DELETE the remote resource and stream the response                                        |

A path-pattern FIND surveys already-materialized web entries; it does not crawl
or discover the remote web. Exact matcher FIND shares the standard flat
location, weighting, pagination, and status contract.

The verbs that change a remote resource — POST, PUT, the remote DELETE, and a
WebSocket frame (EDIT or SEND on an open `ws(s)://` socket) — propose before
anything leaves the process, the same way a subprocess does;
`PLURNK_SERVICE_EFFECT_HOST` decides whether that settles by consent or runs
unattended ({§http-manifest}). GET and the socket open are observation
and are ungated.

## HTTP channels

| Channel  | Content                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `body`   | Original text or binary response; SSE data                                |
| `header` | Origin, acquisition, cache-variant, and projection evidence               |
| `readable` | Curated page Markdown or binary facts/text when a reader supplies them   |

A fragmentless operation publishes only `body`; auxiliary channels remain
durable and can be addressed explicitly. Remote HTTP status is stored in
`header`; the PLURNK operation result reports the selected channel's outcome.
Binary responses retain their bounded original bytes. Ordinary READ returns
hex and, on a supporting model, attaches native media; `#readable` selects
derived facts/text with the same native source. Unknown formats remain
byte-readable. Input above the common binary ceiling returns `413`.

## Design

- WebFetcher checks automatic byte targets and redirects; direct HTTP and
  WebSocket retain their explicit-target authority.
- Generic GETs negotiate origin Markdown first. When the origin returns HTML,
  the installed HTML reader ({§http-lifecycle}) produces `readable`.
- `body`, `header`, and `readable` settle independently. The selected channel
  determines operation success, so the raw server source and evidence remain
  usable when the projection fails.
- GET representations carry method, acquisition-time, and single-variant cache
  evidence; local derivation adds projection identity. Request headers, `Vary`,
  `no-store`, expired freshness, or a reader change prevents reuse; operator TTL
  is a separate ceiling.
- HTTP(S) and WS(S) entry identity retains protocol, authority, path, ordered
  query, and explicit empty query; a fragment selects a channel.
- Handler-owned socket state follows the shared readiness, drain,
  and aggregate-shutdown lifecycle.
- All storage and streaming work uses `SchemeCtx` capabilities.

The same package registers `wss` (with `ws` routing to it) for
workspace-scoped full-duplex connections. See [`docs/wss.md`](docs/wss.md) for
its operation surface and current transport limits.

## Install

Requires Node.js 26 or newer.

```sh
npm i @plurnk/plurnk-schemes-http
plurnk-service start
```

The shipped `.env.defaults` is the canonical operator configuration registry,
and `@plurnk/plurnk-mimetypes-text-html` supplies the local `readable`
projection for HTML responses.

## Verify

```sh
npm test
```

The optional HTTP cache survey
uses the unmodified [http-tests corpus](https://github.com/http-tests/cache-tests).
It is a diagnostic, not a conformance score or part of the test gate.

| Boundary | Current behavior |
| --- | --- |
| Origin lifetime | `s-maxage` overrides `max-age`, then `Expires`; origin age and operator TTL also constrain reuse. |
| Heuristic reuse | Requires an eligible status or explicit permission; errors and partial `206` responses are reacquired. |
| Request headers / `Vary` | Bypass reuse; there is no variant cache. |
| Stale data | Never substituted for failed acquisition; no stale-while-revalidate behavior. |
| Response evidence | Stored headers are not a forwarded HTTP response; no generated `Age` or removed hop-by-hop evidence. |
| Shared-cache directives | `private` and `no-store` prohibit reuse, not retention of acquisition evidence or workspace access. |
