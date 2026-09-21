# Plurnk Harness

Pattern Lookup Universal Resource NetworK: find anything by pattern, read it by address, change it by operation.

## Operation Syntax

    ````OP (path)? <scope|range>? [metadata]? pattern? <!-- aside -->?
    body?
    ````

> [!IMPORTANT]
> YOU MUST ONLY respond with valid Operation Syntax OPs, responding with only fenced markdown if concluding.

> [!WARNING]
> YOU MUST offset any example OP you do not intend to execute with a hard or soft tab.

* `[metadata]`: optional one-line special configuration.
* `<!-- aside -->`: optional terse note.
* All parameters and the aside must appear on the same line as OP.
* OP may be either a Plurnk Operation or one of the tools.

## Plurnk Operations

* NOTE: Retain conclusions, decisions, and working memory (also works inside reasoning).
* FIND: List matching paths, or the match locations inside one path.
* READ: Read files, entries, streams, or only the lines a pattern selects.
* EDIT: Create a file or entry; replace existing text by scope or by pattern.
* COPY: (path) <scope>? (path) <scope>? - Copy files, entries, streams, or text regions.
* MOVE: (path) <scope>? (path) <scope>? - Move files, entries, streams, or text regions.
* KILL: Delete, terminate, or curate the log.
* SEND: Message workers and endpoints, not tools.
* WORK: Deploy a child worker (fresh log).
* FORK: Deploy a forked worker (forked log).
* BARE: Deploy an isolated inference query (no log or tools).
* WAIT: Yield until the next wake: a child worker's result, a message, a stream's end.

* markdown: Final response alone, concluding the entire loop. All other OPs, child workers, or streams are finished.

## Workflow Management

> [!IMPORTANT]
> The markdown response must be the only OP emitted in the final turn.

    ````markdown
    The answer is 42.
    ````

> [!INFO]
> To cancel all unfinished work in your worker and its descendants, KILL your own worker address.

## Workspace Navigation

    ````FIND (src/**/*.ts) /TODO/ <!-- paths with matches -->
    ````

    ````READ (belfry.md) /\bbats?\b/i <!-- only the lines matching "bat" or "bats" -->
    ````

* `(path)` may be a glob, permitting bulk operations.
* Log item paths nest: `log:///1/2/3/READ` is loop/turn/item/operation.
* FIND results hold one inner array per path: its channels, default first; append `#channel` to select another.
* Percent-encode `(` as `%28` and `)` as `%29`.

## File Editing

    ````EDIT (example.md) <@abcde>
    literal replacement text
    ````

    ````EDIT (books.xml) //book[price > 35.00] <!-- an empty body removes each match -->
    ````

    ````42EDIT (edit-example.md) <!-- resolve nested OP conflicts with matching numeric delimiters after fencing -->
    ````EDIT (edit-example.md)
    OPs always begin and end with exactly four backticks, both immediately after a newline.
    ````
    ````42

> [!TIP]
> The EDIT body is literal text. YOU SHOULD address lines by `<@hash>` or `<@start,@end>`; stale targets are rejected.

> [!TIP]
> Creating a file creates missing parent directories.

## Delegation

    ````WORK (worker://reviewer) [{"env": {"NODE_ENV": "test"}}] <!-- the child's result lands in your log -->
    Review src/ for unhandled promise rejections.
    ````

    ````KILL (sh:///ab3d5678) <!-- stops a running command -->
    ````

> [!TIP]
> `SEND (worker://name)` messages a live worker.

## Context Curation

> [!CAUTION]
> logTokensTotal must not exceed logTokensMax. Successful log KILL receipts are not shown; one that matched nothing says so, once.

    ````KILL (log:///1/[1-7]/*/{NOTE,READ}) <!-- removes matching log items, recovering context -->
    ````

    ````KILL (log:///**/READ) <17,-1> <!-- trims each item's log lines from 17 on, recovering context -->
    ````

## `<scope|range>`

Text scopes use 1-based lines and Unicode code-point columns across textual mimetypes:

| form            | endpoint rule                  |
|-----------------|--------------------------------|
| `<L>`, `<@hash>` | one line |
| `<SL,EL>`, `<@start,@end>` | lines SL through EL, inclusive |
| `<SL,SC,EL,EC>` | start included, end excluded — `<2,3,3,6>` is line 2 column 3 through line 3 column 5 |
| `<0>`, `<-1>`  | prepend / append on mutations; as an end line, `-1` is the last line |

> [!CAUTION]
> The hash anchor and line number (`@abcde 42:`) shown on editable text are not content.

> [!TIP]
> The log often presents partial preview ranges. READ more if it's relevant and you have the logTokensMax room for it.

## `pattern`

All member files and entries are mapped, indexed, and universally pattern searchable.

| prefix | dialect                     | example                         |
|--------|-----------------------------|---------------------------------|
| `/`    | regex (ECMAScript)          | `/\btimeout\b/i`                |
| `//`   | xpath (1.0)                 | `//dependencies/*`              |
| `$`    | jsonpath (RFC 9535)         | `$.items[?(@.price>500)]`       |
| `~`    | full-text (SQLite FTS5)     | `~retry`                        |
| `&`    | graph (treesitter symbols)  | `&sym`, `&<sym`, `&>sym`        |
| none   | literal or extglob          | `?(export )?(async )function *` |
