# plurnk-schemes-http

HTTP(S) request/response and WebSocket scheme handlers for the
[plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The package is
authored against the DB-free
[`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes)
`SchemeCtx` contract.

## HTTP operations

| Operation                                      | Behavior                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ```` ```READ (http(s)://…) ````                       | Fetch or reuse/revalidate a GET representation, then project the selected response channel |
| ```` ```READ (http(s)://…) <scope> ````               | Apply standard entry scope after the same acquisition/revalidation; scope does not bypass it |
| ```` ```FIND (http(s)://…) [{"pattern": "…"}] ````     | Materialize an exact URL when required, then use the universal entry query and matcher    |
| ```` ```SEND (http(s)://…) ```` with body             | POST the body and stream the response                                                     |
| ```` ```EDIT (http(s)://…) ```` with body             | PUT a whole-resource replacement; line-scoped HTTP edits are invalid                      |
| ```` ```KILL (http(s)://…) ````                       | Cancel a live acquisition of the address, or forget its stored response                 |
| ```` ```KILL (http(s)://…) [{"remote": true}] ````                 | DELETE the remote resource and stream the response                                        |

A path-pattern FIND surveys already-materialized web entries; it does not crawl
or discover the remote web. Exact matcher FIND shares the standard flat
location, weighting, pagination, and status contract.

## HTTP channels

| Channel  | Content                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `body`   | Original text or binary response; SSE data                                |
| `header` | Origin, acquisition, materializer, projection, provider, and usage evidence |
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
  a selected materializer plugin ({§http-materializer-plugins}) produces
  `readable`; otherwise the installed HTML reader is the local route. Recoverable
  materializer failures use that same reader as a `203` recovery floor. Hard
  provider failures do not silently change producers.
- `body`, `header`, and `readable` settle independently. The selected channel
  determines operation success, so the raw server source and evidence remain
  usable when the projection fails, and a provider's Markdown can survive origin
  transport failure without fabricating HTML.
- GET representations carry method, acquisition-time, and single-variant cache
  metadata; HTML adds materializer-route evidence, and local derivation adds
  projection identity. Request metadata, `Vary`, `no-store`, expired freshness,
  or a materializer/reader change prevents reuse; operator TTL is a separate
  ceiling. Stale page composites are fully reacquired rather than restored by
  an origin `304`.
- HTTP(S) and WS(S) entry identity retains protocol, authority, path, ordered
  query, and explicit empty query; a fragment selects a channel.
- Handler-owned socket state follows the shared readiness, drain,
  and aggregate-shutdown lifecycle.
- All storage and streaming work uses `SchemeCtx` capabilities rather than a
  raw database handle.

The same package registers `wss` (with `ws` routing to it) for
workspace-scoped full-duplex connections. See [`docs/wss.md`](docs/wss.md) for
its operation surface and current transport limits.

## Install

Requires Node.js 26 or newer.

```sh
npm i @plurnk/plurnk-schemes-http
plurnk start
```

The shipped `.env.defaults` is the canonical operator configuration registry.
To select a page-materializer plugin for generic public HTML materialization,
install it and set `PLURNK_SCHEMES_HTTP_MATERIALIZER=<id>` in `.env` (the
`@plurnk/plurnk-schemes-http-tavily` showcase plugin supplies `tavily-extract`).
Without a selection, `@plurnk/plurnk-mimetypes-text-html` supplies the local
`readable` projection.

## Verify

```sh
npm test
```

The optional [HTTP cache survey](https://repo.possumtech.com/plurnk/plurnk-service/issues/674)
uses the unmodified [http-tests corpus](https://github.com/http-tests/cache-tests).
Its adapter, case results, exclusions, and open questions are retained in the
issue, not added to the test gate. It is a diagnostic, not a conformance score.

| Boundary | Current behavior |
| --- | --- |
| Origin lifetime | `max-age`, `Expires`, and origin age constrain reuse alongside the operator TTL. |
| Heuristic reuse | Requires an eligible status or explicit permission; errors and partial `206` responses are reacquired. |
| Request headers / `Vary` | Bypass reuse; there is no variant cache. |
| Stale data | Never substituted for failed acquisition; no stale-while-revalidate behavior. |
| Response evidence | Stored headers are not a forwarded HTTP response; no generated `Age` or removed hop-by-hop evidence. |
| Shared-cache directives | `s-maxage` is not interpreted; `private` does not prohibit workspace-local reuse. The survey tracks the unresolved private/shared-cache classification. |
