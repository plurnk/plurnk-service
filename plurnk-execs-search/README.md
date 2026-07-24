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

Every tunable is an **optional env override** — no code default hides a magic number (suggested values ship in this package's `.env.defaults`).

| Var | Required | Behavior if unset |
|---|---|---|
| `PLURNK_EXECS_SEARCH_SEARXNG_URL` | **yes** | search is unavailable — base URL of the instance (`/search` must allow `format=json`); URL userinfo is sent as HTTP Basic auth and redacted from diagnostics |
| `PLURNK_EXECS_SEARCH_LANGUAGE` | no | SearXNG's own default |
| `PLURNK_EXECS_SEARCH_LIMIT` | no | keep all results (else a client-side cap) |
| `PLURNK_EXECS_SEARCH_TIMEOUT` | no | the consumer's signal is the deadline (SPEC §2.5); this is an extra ceiling (ms) |
| `PLURNK_EXECS_SEARCH_SAFESEARCH` | no | instance default — `0` / `1` / `2` |
| `PLURNK_EXECS_SEARCH_SNIPPET` | no | snippet unbounded (else max chars per result snippet) |
| `PLURNK_EXECS_SEARCH_RAW` | no | digest mode; truthy → verbatim SearXNG payload, prefetch skipped (debug) |

The page-fetch knobs (per-page timeout, redirect hops) moved to the consumer with the fetch — the executor no longer fetches result pages (SPEC §2.6, ruling #5); schemes-http owns the prefetch and its `PLURNK_SCHEMES_HTTP_*` knobs.

## Page prefetch (plurnk-execs#18, service#596, SPEC §2.6)

The executor emits the digest but **never fetches** (ruling #5). It hands each unique candidate url to the consumer's `ExecArgs.entry()` sink as a **prefetch request** — `entry(url, null, { tags: [slug] })`, content consumer-sourced — and the consumer acquires, MIME-projects, and materializes the `https://` entry behind its own SSRF/redirect guards. Useful server-rendered HTML is projected directly; guarded browser rendering is attempted only when that model-facing projection is empty:

- **Materialized:** `entry()` resolves — the row carries `materialized: true`; its body lives in the ordinary HTTP entry.
- **Unavailable body:** `entry()` rejects (unreachable / guard-refused / empty) — the discovery row remains in rank order with `materialized: false`.
- **No sink:** every candidate rides the digest and the `materialized` field is omitted because no verdict exists.

Discovery membership and rank belong to SearXNG. Page fetchability is optional
enrichment and must never remove or reorder a result: many authoritative news
origins reject automated fetches while their title, URL, and snippet remain
valid search evidence.

## Output

Writes a compact ranked digest — `{ title, url, snippet, materialized? }` per
result (plus `publishedDate` when present), capped by
`PLURNK_EXECS_SEARCH_LIMIT` — as JSON to the `results` channel. The digest is
the model's chooser context and rides OPEN (a few KB by design — the raw
SearXNG payload was ~10–20× that and blew budgets, plurnk-execs#17); successful
page bodies live in materialized HTTP entries, never the packet. The model can
answer from discovery evidence, READ a materialized page, or select another
source when `materialized` is false.

Failures emit a `TelemetryEvent` (`source: "exec:<tag>"`): `searxng_not_configured`, `searxng_unreachable`, `searxng_timeout`, `searxng_http_<n>`, `external_bang_refused`.

## Tests

`test:lint`, `test:unit`.
