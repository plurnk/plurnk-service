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
| `PLURNK_EXECS_SEARCH_SEARXNG_URL` | **yes** | search is unavailable — base URL of the instance (`/search` must allow `format=json`) |
| `PLURNK_EXECS_SEARCH_LANGUAGE` | no | SearXNG's own default |
| `PLURNK_EXECS_SEARCH_LIMIT` | no | keep all results (else a client-side cap) |
| `PLURNK_EXECS_SEARCH_TIMEOUT` | no | the consumer's signal is the deadline (SPEC §2.5); this is an extra ceiling (ms) |
| `PLURNK_EXECS_SEARCH_SAFESEARCH` | no | instance default — `0` / `1` / `2` |
| `PLURNK_EXECS_SEARCH_SNIPPET` | no | snippet unbounded (else max chars per result snippet) |
| `PLURNK_EXECS_SEARCH_RAW` | no | digest mode; truthy → verbatim SearXNG payload, prefetch skipped (debug) |

The page-fetch knobs (per-page timeout, redirect hops) moved to the consumer with the fetch — the executor no longer fetches result pages (SPEC §2.6, ruling #5); schemes-http owns the prefetch and its `PLURNK_SCHEMES_HTTP_*` knobs.

## The dead-row prefetch (plurnk-execs#18, SPEC §2.6)

The executor emits the digest but **never fetches** (ruling #5). It hands each unique candidate url to the consumer's `ExecArgs.entry()` sink as a **prefetch request** — `entry(url, null, { tags: [slug] })`, content consumer-sourced — and the consumer (schemes-http) fetches, renders, and materializes the `https://` entry behind its own SSRF/redirect guards (schemes-http's guarded fetch, #456):

- **Survivor:** `entry()` resolves — the row rides the digest; its body lives in the materialized entry (a folded row carrying path + tokens).
- **Pruned:** `entry()` rejects (unreachable / guard-refused / empty) — the row is dropped. *Listed = fetchable.* Zero dead rows by construction.
- **No sink:** older consumers degrade gracefully — every candidate rides the digest, unpruned.

## Output

Writes a compact **digest of survivors only** — `{ title, url, snippet }` per result (plus `publishedDate` when present), capped by `PLURNK_EXECS_SEARCH_LIMIT` — as JSON to the `results` channel. Zero dead rows by construction. The digest is the model's chooser context and rides OPEN (a few KB by design — the raw SearXNG payload was ~10–20× that and blew budgets, plurnk-execs#17); page bodies live in the materialized entries, never the packet. The model reads `exec://<coord>/EXEC#results`, then READs / `~`-queries the entries it picks.

Failures emit a `TelemetryEvent` (`source: "exec:<tag>"`): `searxng_not_configured`, `searxng_unreachable`, `searxng_timeout`, `searxng_http_<n>`, `external_bang_refused`.

## Tests

`test:lint`, `test:unit`.
