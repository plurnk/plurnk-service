# plurnk-schemes-http

HTTP(S) request/response and WebSocket scheme handlers for the
[plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The package is
authored against the DB-free
[`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes)
`SchemeCtx` contract.

## HTTP operations

| Operation                                      | Behavior                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `## READ0 (http(s)://…)`                       | Fetch or reuse/revalidate a GET representation, then stream the selected response channel |
| `## READ0 (http(s)://…) <scope>`               | Apply the standard entry READ to an already-materialized response without refetching      |
| `## FIND0 (http(s)://…)` with matcher body     | Materialize an exact URL when required, then use the universal entry query and matcher    |
| `## SEND0 [200] (http(s)://…)` with body       | POST the body and stream the response                                                     |
| `## EDIT0 (http(s)://…)` with body             | PUT a whole-resource replacement; line-scoped HTTP edits are invalid                      |
| `## KILL0 (http(s)://…)`                       | DELETE the remote resource and stream the response                                        |
| `## SEND0 [499] (http(s)://…)`                 | Cancel the routed in-flight subscription                                                  |
| `## SEND0 [410] (http(s)://…)`                 | Delete the local stored response entry                                                    |

A path-pattern FIND surveys already-materialized web entries; it does not crawl
or discover the remote web. Exact matcher FIND shares the standard flat
location, weighting, pagination, and status contract.

## HTTP channels

| Channel  | Content                                                                    |
| -------- | -------------------------------------------------------------------------- |
| `body`   | Text, derived Unicode, typed binary marker, SSE data, or HTML-page Markdown |
| `header` | Origin, acquisition, materializer, projection, provider, and usage evidence |
| `html`   | Original server-source HTML when the origin supplies it                    |

A fragmentless operation publishes only `body`; auxiliary channels remain
durable and can be addressed explicitly. Remote HTTP status is stored in
`header`; the PLURNK operation result reports the streaming lifecycle.
Binary responses use an installed bounded readable projection when available;
only derived Unicode becomes durable. Otherwise direct operations preserve a
typed empty marker and return `415`, while exact query preparation prunes the
unreadable result from automatic search ingestion. Input above the common
projection ceiling returns `413`.

## Design

- WebFetcher checks automatic byte targets and redirects; direct HTTP and
  WebSocket retain their explicit-target authority.
- Generic GETs negotiate origin Markdown first. When the origin returns HTML,
  configured Tavily produces `body`; otherwise the installed HTML reader is the
  local route. Recoverable Tavily failures use that same reader as a `203`
  recovery floor. Hard provider failures do not silently change producers.
- `body`, `header`, and `html` settle independently. The selected channel
  determines operation success, so raw server source and evidence remain usable
  when body production fails, and a provider body can survive origin transport
  failure without fabricating HTML.
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
To enable Tavily Extract for generic public HTML materialization, set
`TAVILY_API_KEY` in `.env`. Depth and client timeout are controlled by
`PLURNK_SCHEMES_HTTP_TAVILY_DEPTH` and
`PLURNK_SCHEMES_HTTP_TAVILY_TIMEOUT_MS`. Without Tavily,
`@plurnk/plurnk-mimetypes-text-html` supplies the local body.

## Verify

```sh
npm test
```
