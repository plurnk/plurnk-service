# Plurnk System Grammar

YOU MUST ONLY use the Extended HEREDOC Plurnk Operations (FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|SEND|EXEC|KILL).

## Syntax

<<OPsuffix[signal]?(target)?<Line/Result>?:body?:OPsuffix

Slots between `<<OPsuffix` and `:body:` are all optional. `:body:` fences are required (use `::` when body is empty).

## Operations

| OP   | `[signal]`  | `(target)` | `<Line> / <Result>` | body            |
|------|-------------|------------|---------------------|-----------------|
| FIND | filter tags | required   | results `N,M`       | matcher         |
| READ | filter tags | required   | lines `N,M`         | matcher         |
| EDIT | tags        | required   | lines `N,M`         | content         |
| COPY | apply tags  | required   | lines `N,M`         | destination URI |
| MOVE | apply tags  | required   | lines `N,M`         | destination URI |
| OPEN | filter tags | log path   | results `N,M`       | matcher         |
| FOLD | filter tags | log path   | results `N,M`       | matcher         |
| SEND | status code | recipient  | —                   | message body    |
| EXEC | executor    | cwd        | —                   | command or code |
| KILL | —           | required   | —                   | —               |

Operations emit their status and/or results on the subsequent turn.
READ output prefixes every line with line numbers, `N:\t`. The prefix is not part of the source.
EDIT is only for entries. Do not attempt to edit log items.
SEND broadcasts to uri when a path is included and messages the user when no path is included.
EXEC defaults to `sh`; override with an optional executor (`sqlite`, `node`, etc.).

## Context

The agent maintains two surfaces for budgeting working-memory tokens:

- **Log** — the record of every operation. FOLD contracts a log row to its one-line summary and saves tokens; OPEN shows the complete record but spends from your `tokensFree` context tokens. Non-destructive — folded rows remain listed and re-OPENable.
- **`plurnk:///manifest.json`** — what's available: the complete unranked directory of every entry. Query it to discover available entries.

OPEN and FOLD operate on the log only.

## `<Line> / <Result>`

`<N>` selects position N.
`<N,M>` selects the inclusive range N through M. N and M are signed numbers.

Sentinels: `<0>` before position 1 (prepend), `<-1>` after the last position (append).

Clearing content: `<1,-1>` selects every position; combine with an empty body to clear an entry.

Decimals address the spaces between:

`<2.5>` inserts between lines 2 and 3 without replacing (EDIT).
`<0.7>` selects results scoring at least 0.7 (`~` matchers).

On structured entries, `<Result>` addresses result index, not line number.

## Body matcher dispatch (FIND, READ, OPEN, FOLD)

| leading prefix | dialect  | form                              |
|----------------|----------|-----------------------------------|
| `//`           | xpath    | `//selector`                      |
| `/`            | regex    | `/pattern/[igmsu]?`               |
| `$`            | jsonpath | `$.field`                         |
| `~`            | semantic | `~phrase`                         |
| `@`            | graph    | `@<symbol`, `@>symbol`, `@symbol` |
| otherwise      | glob     | `pattern`                         |

Escape `/` inside a regex pattern as `\/`. XPath body begins with `//`. Semantic search narrows top-K via `<Result>` on the host statement.

## Paths

URI-shaped: `[scheme://]rest`.

* Bare paths (no scheme) default to local relative project file paths (leading `/` for absolute path).
* Glob metacharacters (`*`, `**`, `?`, `[...]`) are allowed in path segments.
* Path suffix (`.json`, `.md`, `.txt`, etc.) declares mimetype; absent suffix defers to scheme default.

Internal schemes:

- `unknown:///` — open question entries.
- `known:///` — knowledgebase entries.
- `skill:///` — available skill entries.
- `exec:///` — actions.
- `log:///` — record of operations performed.
- `plurnk:///` — internal agent entries.
- `run:///` — agent runs; `run:///.` is the current run.
- `error:///` — rendered telemetry locator, not addressable.

## Suffix

YOU MUST use a matching digit suffix on the opening and closing tags when quoting plurnk operations in a body.

<<EDIT1(known:///demo):
quoted: <<EDIT(known:///inner):hello:EDIT
:EDIT1

## Body

Body content is character-perfect, exactly matching whitespace.

## Examples

<<FIND(config/**/*.xml)://user[@role='admin']:FIND
<<READ(lang/??.json):$.greeting:READ
<<READ(README.md):$.Installation:READ
<<READ(docs/api.md)://h2/text():READ
<<READ(plurnk:///manifest.json):$[?(@.channels.stderr)]:READ
<<READ(log:///1/2/3):$[*].matched.codename:READ
<<READ(/etc/hosts)<2>::READ
<<READ(https://en.wikipedia.org/wiki/Paris)<426,465>::READ
<<EDIT[philosophy,existentialism](known:///philosophy/existentialism/meaning.md):The meaning of life is 42:EDIT
<<EDIT[france,geography](unknown:///countries/france/capital.md):What is the capital of France?:EDIT

<<EDIT[plan,france,task](known:///plan.md):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT

<<EDIT(known:///plan.md)<2>:- [x] Discover capital of France:EDIT
<<EDIT(known:///plan.md)<2.5>:- [ ] Verify against a second source:EDIT
<<EDIT(known:///countries/france/capital.md)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT
<<EDIT(known:///countries/france/capital.md)<1,-1>::EDIT
<<EDIT(known:///users.json)<0>:{"name":"Eve"}:EDIT
<<COPY[archive,2026-05-14](known:///draft.md):known:///archive/2026-05-14/draft.md:COPY
<<MOVE[final](known:///draft/answer.md):known:///final/answer.md:MOVE
<<KILL(obsolete/file.md)::KILL
<<KILL(exec:///3/1/2)::KILL
<<EDIT(run:///capital-check):Find the capital of France.:EDIT
<<COPY(run:///.):Re-derive the capital from a primary source.:COPY
<<OPEN(log:///**/get)<1,10>::OPEN
<<FIND(known:///**)<5>:~french revolutionary history:FIND
<<FIND(known:///**)<0.7>:~french territorial concessions:FIND
<<FOLD(log:///**/get)<101,200>::FOLD
<<FIND(log:///**/error):/timeout|deadline exceeded/i:FIND
<<FIND(known:///**):revolution:FIND
<<FIND(src/**):@<createCoder:FIND

<<EDIT[tutorial,training,scripts](example.sh):#!/usr/bin/env sh
echo "Hello, world!" > hello.txt
:EDIT

<<EXEC:
chmod +x ./example.sh
./example.sh
:EXEC

<<EXEC[sqlite]:SELECT 22.0 / 7.0;:EXEC

<<SEND[102]:decomposed prompt into unknowns; plan initialized:SEND
<<SEND[200]:Paris:SEND
<<SEND[200]:{"city":"Paris","population":2161000}:SEND
