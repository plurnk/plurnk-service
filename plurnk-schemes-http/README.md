# plurnk-schemes-http

HTTP(S) request/response and WebSocket scheme handlers for the
[plurnk](https://github.com/plurnk/plurnk-service) agent runtime. The package is
authored against the DB-free
[`@plurnk/plurnk-schemes`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes)
`SchemeCtx` contract.

## HTTP operations

| Operation                         | Behavior                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Unscoped `READ(http(s)://…)`      | Fetch or reuse/revalidate a GET representation, then stream the selected response channel |
| Scoped `READ(http(s)://…)<scope>` | Apply the standard entry READ to an already-materialized response without refetching      |
| `FIND(http(s)://…):matcher`       | Materialize an exact URL when required, then use the universal entry query and matcher    |
| `SEND[200](http(s)://…):body:`    | POST the body and stream the response                                                     |
| `EDIT(http(s)://…):body:`         | PUT a whole-resource replacement; line-scoped HTTP edits are invalid                      |
| `KILL(http(s)://…)`               | DELETE the remote resource and stream the response                                        |
| `SEND[499](http(s)://…)`          | Cancel the routed in-flight subscription                                                  |
| `SEND[410](http(s)://…)`          | Delete the local stored response entry                                                    |

A path-pattern FIND surveys already-materialized web entries; it does not crawl
or discover the remote web. Exact FIND and matcher READ share the standard
catalog, matcher evidence, weighting, pagination, and status contract.

## HTTP channels

| Channel  | Content                                                                 |
| -------- | ----------------------------------------------------------------------- |
| `body`   | Text, typed binary marker, SSE data, or readable HTML (default)         |
| `header` | HTTP status line, headers, and package acquisition metadata             |
| `html`   | Faithful HTML used to produce the readable body                         |

A fragmentless operation publishes only `body`; auxiliary channels remain
durable and can be addressed explicitly. Remote HTTP status is stored in
`header`; the PLURNK operation result reports the streaming lifecycle.
Non-textual direct responses preserve a typed empty marker and return `415`;
WebFetcher prunes them because they cannot satisfy a text query.

## Design

- WebFetcher checks automatic byte targets and redirects; direct HTTP,
  Playwright, and WebSocket use their ordinary configured transports.
- Direct GET HTML is rendered through Playwright, projected into `body`, and
  retained faithfully in `html`.
- GET representations carry method and acquisition-time metadata for the
  configured TTL and conditional revalidation path.
- HTTP(S) and WS(S) entry identity retains protocol, authority, path, ordered
  query, and explicit empty query; a fragment selects a channel.
- Handler-owned browser and socket state follows the shared readiness, drain,
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

The Playwright client is included. Provision a compatible local browser
separately, select an external Playwright/CDP endpoint, or disable rendering.
The shipped `.env.defaults` is the canonical operator configuration registry.

## Verify

```sh
npm test
npm run test:intg
```
