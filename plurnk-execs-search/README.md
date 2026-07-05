# @plurnk/plurnk-execs-search

Web search runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Dispatches an `<<EXEC[search]:pie recipes:EXEC` op to a [SearXNG](https://docs.searxng.org/) instance and returns a compact digest of results (`title` / `url` / `snippet`).

The first non-subprocess `@plurnk/plurnk-execs-*` sibling, built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework.

## Runtime tags

Each tag maps to a SearXNG search category (`categories=`):

| Tag | Glyph | Category |
|---|---|---|
| `search` | 🔎 | general |
| `images` | 🖼 | images |
| `videos` | 🎬 | videos |
| `news` | 📰 | news |
| `map` | 🗺 | map |
| `music` | 🎵 | music |
| `it` | 💻 | it |
| `science` | 🔬 | science |
| `social` | 💬 | social media |
| `downloadable` | 📥 | files |

Engine, language, and time-range selection ride the query string via SearXNG's native `!bang` and `:lang` syntax (e.g. `<<EXEC[search]:!gh node streams:EXEC`). External bangs (`!!`) are refused — they redirect rather than return results.

## Configuration (environment)

Every tunable is an **optional env override** — no code default hides a magic number (suggested values live in the consuming service's `.env.example`).

| Var | Required | Behavior if unset |
|---|---|---|
| `PLURNK_EXECS_SEARCH_SEARXNG_URL` | **yes** | search is unavailable — base URL of the instance (`/search` must allow `format=json`) |
| `PLURNK_EXECS_SEARCH_LANGUAGE` | no | SearXNG's own default |
| `PLURNK_EXECS_SEARCH_LIMIT` | no | keep all results (else a client-side cap) |
| `PLURNK_EXECS_SEARCH_TIMEOUT` | no | the consumer's signal is the deadline (SPEC §2.5); this is an extra ceiling (ms) |
| `PLURNK_EXECS_SEARCH_SAFESEARCH` | no | instance default — `0` / `1` / `2` |
| `PLURNK_EXECS_SEARCH_SNIPPET` | no | snippet unbounded (else max chars per result snippet) |
| `PLURNK_EXECS_SEARCH_RAW` | no | digest mode; truthy → emit the verbatim SearXNG payload (debug) |

## Output

Writes a compact **digest** — `{ title, url, snippet }` per result (plus `publishedDate` when present), capped by `PLURNK_EXECS_SEARCH_LIMIT` — as JSON to the `results` channel. The raw SearXNG payload is ~10–20× its information content (`template`, engine internals, scores, `parsed_url` — noise the model can't use), and folding a full 68KB response back into the prompt can blow the budget (plurnk-execs#17); the digest is a few KB. Set `PLURNK_EXECS_SEARCH_RAW=1` for the verbatim payload. The model reads `exec://<coord>/EXEC#results`.

Failures emit a `TelemetryEvent` (`source: "exec:<tag>"`): `searxng_not_configured`, `searxng_unreachable`, `searxng_timeout`, `searxng_http_<n>`, `external_bang_refused`.

## Tests

`test:lint`, `test:unit`.
