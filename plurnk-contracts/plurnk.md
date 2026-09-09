# Plurnk Harness

## Plurnk Operation Syntax

> [!WARNING]
> YOU MUST use at least three backticks for code fences, with longer outer fences when nesting.

### FIND - List matching results by pattern search.

```FIND (target or glob) <result range>?
filter pattern?
```

### READ - Read content from files, entries, or streams.

```READ (path) <text region>?```

### EDIT - Edit, replace, or delete text in a file or entry.

```EDIT (path) <text region>?
literal replacement text
```

> [!CAUTION]
> An unscoped EDIT only creates a new file or entry.

### COPY - Copy files, entries, streams, or text regions.

```COPY (source) <source text region>? (destination) <destination text region>?```

### MOVE - Move files, entries, streams, or text regions.

```MOVE (source) <source text region>? (destination) <destination text region>?```

### SEND - Message workers or endpoints.

```SEND (recipient)
message
```

> [!NOTE]
> A SEND without a recipient is a response to the Active Prompt.

### WORK - deploy a child worker (fresh log)

```WORK (worker://name)
prompt
```

### FORK - deploy a forked worker (forked log)

```FORK (worker://name)
prompt
```

### BARE - Deploy an isolated inference query (no log).

```BARE (path)?
prompt
```

### KILL - Delete or terminate.

```KILL (target) <range or region>?
filter pattern?
```

* ```KILL (worker://~/notes.md)``` without a scope deletes an entry.
* ```KILL (src/app.js) <@zyxwv>``` removes one line by hash anchor.
* ```KILL (sh:///1/2/3/EXEC)``` stops a running command.
* ```KILL (worker://recheck)``` terminates a worker.
* ```KILL (log:///1/[1-7]/*/{TASK,READ})``` removes matching log items.
* ```KILL (log:///**/READ) <17,-1>``` trims each item's log lines from 17 on.

> [!TIP]
> A log item or line KILL doesn't delete the source.

> [!TIP]
> Successful KILL op receipts on log items and lines are not shown.

### TASK - End the turn with the current task inventory.

```TASK
[{"content": string, "status": "pending" | "waiting" | "in_progress" | "completed" | "failed"}]
```

* `pending`: Task is blocked until another task it depends on is `completed`.
* `waiting`: Task is awaiting an ongoing stream, deployed worker, or external event.
* `in_progress`: Task is active work.
* `completed`: Task has been successfully resolved.
* `failed`: Task has ended unsuccessfully.

> [!IMPORTANT]
> The final turn may only contain SEND and TASK operations, with all tasks either "completed" or "failed".

## Pattern Filtering

* Pattern matchers in the OP's `body` select paths by content:

| prefix | dialect  | form                               | example                 | engine           |
|--------|----------|------------------------------------|-------------------------|------------------|
| `/`    | regex    | `/pattern/flags`                   | `/\btimeout\b/i`        | ECMAScript       |
| `//`   | xpath    | `//selector`                       | `//dependencies/*`      | XPath 1.0        |
| `$`    | jsonpath | `$.field`, `$.items[*].name`       | `$[*][?(@.tokensActive>500)]` | RFC 9535   |
| `~`    | full-text | `~query`                          | `~retry` | SQLite FTS5 |
| `&`    | graph    | `&<symbol`, `&>symbol`, `&symbol`  | `&<parseTurn`           | symbol index     |
| none   | glob     | `pattern`                          | `?(export )?(async )function *` | glob / literal   |

> [!TIP]
> In a path target, `*` maps one level and `**` crosses directories.

## `(path)`

* Log item paths are nested: `log:///1/2/3/READ` is loop/turn/item/OP.
* In FIND results, each inner array lists one path's channels, default first. Append `#channel` to override the default.
* A file or entry extension declares its mimetype.
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
