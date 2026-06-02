# @plurnk/plurnk-execs-search

Web search runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Dispatches an `<<EXEC[search]:pie recipes:EXEC` op to a [SearXNG](https://docs.searxng.org/) instance and returns its native JSON results.

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

| Var | Required | Default | Notes |
|---|---|---|---|
| `PLURNK_EXECS_SEARCH_SEARXNG_URL` | yes | — | base URL of the SearXNG instance (its `/search` endpoint must allow `format=json`) |
| `PLURNK_EXECS_SEARCH_LANGUAGE` | no | `en` | |
| `PLURNK_EXECS_SEARCH_LIMIT` | no | `12` | results kept |
| `PLURNK_EXECS_SEARCH_TIMEOUT` | no | `10000` | request timeout (ms) |
| `PLURNK_EXECS_SEARCH_SAFESEARCH` | no | instance default | `0` / `1` / `2` |

## Output

Writes the SearXNG `results` array (sliced to the limit, native shape verbatim) as JSON to the `results` channel. The model reads `exec://<coord>/EXEC#results`.

Failures emit a `TelemetryEvent` (`source: "exec:<tag>"`): `searxng_not_configured`, `searxng_unreachable`, `searxng_timeout`, `searxng_http_<n>`, `external_bang_refused`.

## Tests

`test:lint`, `test:unit`.
