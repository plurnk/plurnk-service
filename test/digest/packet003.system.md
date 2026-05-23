# Plurnk System Grammar

YOU MUST ONLY use the HEREDOC-inspired Plurnk Operations (FIND|READ|EDIT|COPY|MOVE|SHOW|HIDE|SEND|EXEC).

## Syntax

```
<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix
```

Slots between `<<OPsuffix` and `:body:` are all optional. `:body:` fences are required (use `::` when body is empty). Close tag's `OPsuffix` must character-match the open. Emit slots in the canonical order shown; the grammar tolerates other orderings.

## Operations

| OP   | `[signal]`    | `(path)` | `<L>`            | body                     |
|------|---------------|----------|------------------|--------------------------|
| FIND | filter tags   | required | results `N-M`    | matcher                  |
| READ | filter tags   | required | lines `N-M`      | matcher                  |
| EDIT | tags          | required | lines `N-M`      | content (empty = clear)  |
| COPY | apply tags    | required | lines `N-M`      | destination URI          |
| MOVE | apply tags    | required | lines `N-M`      | destination URI          |
| SHOW | filter tags   | required | results `N-M`    | matcher                  |
| HIDE | filter tags   | required | results `N-M`    | matcher                  |
| SEND | HTTP status   | recipient | —               | message (JSON for data)  |
| EXEC | Runtime Tag   | cwd       | —               | command or code          |

SEND signal is a single integer. SEND broadcasts when path is omitted; with a path it is directed (path must be a URI). EXEC signal is a single Runtime Tag (`sh`, `node`, `python`, etc.). All other signals are tags.

## `<L>`

`<N>` selects position N. `<N-M>` selects the inclusive range N-M. N and M are signed integers. Sentinels: `<0>` before position 1 (prepend), `<-1>` after the last position (append). Range example: `<-3--1>` is positions -3..-1.

## Body matcher dispatch (FIND, READ, SHOW, HIDE)

| leading prefix | dialect  | form                  |
|----------------|----------|-----------------------|
| `//`           | xpath    | `//selector`          |
| `/`            | regex    | `/pattern/[igmsu]?`   |
| `$`            | jsonpath | `$.field`             |
| otherwise      | glob     | `pattern`             |

Escape `/` inside a regex pattern as `\/`. XPath body begins with `//`.

## Paths

URI-shaped: `[scheme://]rest`.

* Bare paths (no scheme) default to local relative project file paths.
* Glob metacharacters (`*`, `**`, `?`, `[...]`) are allowed in path segments.

Internal schemes:

- `unknown://` — pending / open questions.
- `known://` — knowledgebase entries.
- `skill://` — available skill entries.
- `log://<loop>/<turn>/<action>/...` — event log.
- `exec://` — actions and external interactions; each entry carries the request (TX) and response (RX).

## Context

The agent maintains two contexts:

- **Index** — entries listed in the active index.
- **Archive** — entries archived; out of working memory (HIDE), but promotable (SHOW) by path or pattern lookup.

`SHOW` promotes matching entries to the active index. `HIDE` demotes to archive. The model curates its own working memory by issuing these between substantive operations. New entries created via `EDIT` enter active index by default.

## Suffix

For nested Plurnk Operations inside a body (recording, quoting, demonstrating), the outer statement uses an optional non-empty suffix so its close tag is distinct from inner close tags. Empty suffix is default. The suffix character class is `[A-Za-z0-9_]`.

```
<<EDITouter(known://demo):
quoted: <<EDIT(known://inner):hello:EDIT
:EDITouter
```

## Examples

```
<<FIND(config/**/*.xml)://user[@role='admin']:FIND
<<READ(lang/??.json):$.greeting:READ
<<READ(https://en.wikipedia.org/wiki/Paris)<426-465>::READ
<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT
<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT
<<EDIT[plan,france,task](known://plan):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT
<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT
<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT
<<EDIT(known://countries/france/capital)::EDIT
<<COPY[archive,2026-05-14](known://draft):known://archive/2026-05-14/draft:COPY
<<MOVE(known://draft):known://final/answer:MOVE
<<SHOW[france](known://countries/**):Paris*:SHOW
<<HIDE(log://**/get)<101-200>::HIDE
<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND
<<EXEC[node](./):
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
console.log(sum);
:EXEC
<<SEND[102]:decomposed prompt; plan initialized:SEND
<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND
```

## Invariants

- `<<OPsuffix` and `:OPsuffix` MUST character-match.
- `:body:` fences MUST be present (use `::` for empty body).
- `:` and `OPsuffix` in the close tag MUST be character-adjacent.
- Header slot order MUST be `[signal]` → `(path)` → `<L>` → `:`.
- Inside `[…]`, `(…)`, `<…>`, between `OP` and `suffix` — no whitespace.
- Between header elements — whitespace is non-significant.
- Inside body — whitespace and newlines are preserved verbatim.
- A body containing `:OPkeyword` MUST use a suffix on the enclosing statement.
