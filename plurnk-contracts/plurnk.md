# Plurnk Harness

## Plurnk Harness Operation Syntax

> [!NOTE]
> OP names a Plurnk operation, registered executor, or enabled MCP service.

`````syntax
````OP (path)? <scope>? {metadata}? <!-- annotation -->?
body?
````
`````

## `(path)`

* Log item paths are nested: `log:///1/2/3/READ` is loop/turn/item/operation.
* In FIND results, each inner array lists one path's channels, default first. Append `#channel` to override the default.
* Percent-encode reserved path characters: `(` becomes `%28` and `)` becomes `%29`.
* Creating a file automatically creates missing parent directories.

## `<scope>`

> [!NOTE]
> Text scopes use 1-based lines and Unicode code-point columns consistently across textual mimetypes:

| form            | endpoint rule                  |
|-----------------|--------------------------------|
| `<L>`           | one line |
| `<@hash>`       | one line |
| `<SL,EL>`       | lines SL through EL, inclusive |
| `<@start,@end>` | lines @start through @end, inclusive |
| `<SL,SC,EL,EC>` | start included, end excluded — `<2,1,2,5>` is columns 1-4 of line 2 |
| `<0>`, `<-1>`  | prepend / append on mutations; as an end line, `-1` is the last line |

> [!CAUTION]
> The hash anchor and line number (`@abcde 42:`) shown on editable text are not content.

> [!TIP]
> YOU SHOULD use `<@hash>` or `<@start,@end>` to EDIT line coordinates; stale EDIT targets are rejected.

## `{metadata}`

> [!NOTE]
> Scheme- or executor-defined options; see its invocation contract.

## `<!-- annotation -->`

> [!NOTE]
> Optional, terse, one-liner description of intent

## Pattern Filtering

* Pattern matchers in the operation's `body` select paths by content:

| prefix | dialect  | form                               | example                 | engine           |
|--------|----------|------------------------------------|-------------------------|------------------|
| `/`    | regex    | `/pattern/flags`                   | `/\btimeout\b/i`        | ECMAScript       |
| `//`   | xpath    | `//selector`                       | `//dependencies/*`      | XPath 1.0        |
| `$`    | jsonpath | `$.field`, `$.items[*].name`       | `$[*][?(@.tokensActive>500)]` | RFC 9535   |
| `~`    | full-text | `~query`                          | `~retry` | SQLite FTS5 |
| `&`    | graph    | `&<symbol`, `&>symbol`, `&symbol`  | `&<parseTurn`           | symbol index     |
| none   | glob     | `pattern`                          | `?(export )?(async )function *` | glob / literal   |

## Plurnk Harness Operations

````FIND (path or glob) <result range>? <!-- list matching results by pattern search -->
filter pattern?
````

````READ (path) <text region>? <!-- read content from files, entries, or streams -->````

````EDIT (path) <text region>? <!-- create a file or entry; use scope to replace existing text -->
literal replacement text
````

````COPY (source) <scope>? (destination) <scope>? <!-- copy files, entries, streams, or text regions -->````

````MOVE (source) <scope>? (destination) <scope>? <!-- move files, entries, streams, or text regions -->````

````SEND (path)? <!-- respond to prompt or message workers or endpoints -->
message
````

> [!IMPORTANT]
> YOU SHOULD use SEND without a `(path)` to respond to the Active Prompt.

````WORK (path)? <!-- deploy a child worker (fresh log) -->
prompt
````

````FORK (path)? <!-- deploy a forked worker (forked log) -->
prompt
````

````BARE <!-- deploy an isolated inference query (no log or tools) -->
prompt
````

````KILL (path) <scope>? <!-- delete or terminate -->
filter pattern?
````

* ````KILL (worker://~/notes.md)```` without a scope deletes an entry.
* ````KILL (src/app.js) <@zyxwv>```` removes one line by hash anchor.
* ````KILL (sh:///1/2/3/sh)```` stops a running command.
* ````KILL (worker://recheck)```` terminates a worker.
* ````KILL (log:///1/[1-7]/*/{TASK,READ})```` removes matching log items.
* ````KILL (log:///**/READ) <17,-1>```` trims each item's log lines from 17 on.

> [!TIP]
> Log curation must target `log:///` items, not their target source paths.

> [!TIP]
> Successful KILL op receipts on log items and lines are not shown.

````TASK <!-- conclude every turn with the current task inventory -->
[{"content": string, "status": "pending" | "waiting" | "in_progress" | "completed" | "failed"}]
````

* `pending`: Task is blocked until another task it depends on is `completed`.
* `waiting`: Task is awaiting an ongoing stream, deployed worker, or external event.
* `in_progress`: Task is active work.
* `completed`: Task has been successfully resolved.
* `failed`: Task has ended unsuccessfully.

> [!IMPORTANT]
> The final turn must leave no unobserved results or unresolved work; all tasks must be "completed" or "failed".
