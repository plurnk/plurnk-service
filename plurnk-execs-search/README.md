# @plurnk/plurnk-execs-search

Web search runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Dispatches `## EXEC0 [search]` with a query body to a [SearXNG](https://docs.searxng.org/) instance and returns a compact digest of results (`title` / `url` / `snippet`).

The first non-subprocess `@plurnk/plurnk-execs-*` sibling, built on the [plurnk-execs](https://github.com/plurnk/plurnk-service/tree/main/plurnk-execs) framework.

## Runtime tags

Each tag maps to a SearXNG search category (`categories=`):

| Tag            | Glyph | Category     |
| -------------- | ----- | ------------ |
| `search`       | 🔎    | general      |
| `images`       | 🖼    | images       |
| `videos`       | 🎬    | videos       |
| `news`         | 📰    | news         |
| `map`          | 🗺    | map          |
| `music`        | 🎵    | music        |
| `it`           | 💻    | it           |
| `science`      | 🔬    | science      |
| `social`       | 💬    | social media |
| `downloadable` | 📥    | files        |

Engine, language, and time-range selection ride the query string via SearXNG's native `!bang` and `:lang` syntax (for example, body `!gh node streams`). External bangs (`!!`) are refused — they redirect rather than return results.

## Configuration (environment)

Every tunable is an **optional env override** — no code default hides a magic number (suggested values ship in this package's `.env.defaults`).

| Variable                            | Required | Behavior when unset                                                                            |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `PLURNK_EXECS_SEARCH_SEARXNG_URL`   | yes      | Search is unavailable. URL userinfo, when present, supplies redacted HTTP Basic credentials.   |
| `PLURNK_EXECS_SEARCH_LANGUAGE`      | no       | SearXNG default.                                                                               |
| `PLURNK_EXECS_SEARCH_ENGINES`       | no       | SearXNG enabled engines.                                                                       |
| `PLURNK_EXECS_SEARCH_LIMIT`         | no       | `.env.defaults` supplies 12 candidates.                                                        |
| `PLURNK_EXECS_SEARCH_TIMEOUT`       | no       | Consumer cancellation is the primary deadline; this is an extra local ceiling in milliseconds. |
| `PLURNK_EXECS_SEARCH_SAFESEARCH`    | no       | Instance default; accepted values are `0`, `1`, or `2`.                                        |
| `PLURNK_EXECS_SEARCH_SNIPPET`       | no       | Snippets are unbounded.                                                                        |
| `PLURNK_EXECS_SEARCH_QUERY_PREVIEW` | no       | `.env.defaults` supplies 120 characters for error facts.                                       |
| `PLURNK_EXECS_SEARCH_RAW`           | no       | Truthy emits capped upstream result rows and skips projection and prefetch for debugging.      |

Page-fetch knobs belong to the consumer and schemes-http because the executor
does not fetch result pages ({§executor-entry-sink}).

## Page prefetch

The executor emits the digest but never fetches. It hands each unique candidate
URL to `entry(url, null, { tags: [slug] })`; the consumer acquires,
MIME-projects, and materializes the `https://` entry behind its own URL check.
Generic public HTML becomes Tavily Markdown when the HTTP scheme is configured
for Tavily; otherwise the installed HTML reader supplies the local projection
floor.

- **Materialized:** `entry()` resolves — the row carries `materialized: true`; its body lives in the ordinary HTTP entry.
- **Unavailable body:** `entry()` rejects for any reason — the row is omitted from the model-facing digest.
- **No sink:** every candidate rides the digest and the `materialized` field is omitted because no verdict exists.

Discovery membership and rank belong to SearXNG. Plurnk does not rerank or
judge result quality; it only removes rows whose pages did not materialize,
preserving the upstream order of the survivors.

## Output

Writes a compact ranked digest—`{ title, url, snippet, materialized? }` per
result, plus `publishedDate` when present—as JSON to `#results` under the
emitted `search://`-family address ({§executor-output-address}). The digest is
bounded by `PLURNK_EXECS_SEARCH_LIMIT`; successful page bodies live in
materialized HTTP entries rather than this stream. Every emitted row names an
ordinary readable entry.

Search is a `read` effect, so it bypasses proposal review and still returns
through the ordinary background stream path ({§executor-effect}).

Failures return RFC 9457 Problems in the terminal operation result. Bounded
aggregate acquisition progress remains a transient Notice.

## Tests

`test:lint`, `test:unit`.
