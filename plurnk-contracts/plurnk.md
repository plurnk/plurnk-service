# Plurnk Operation Protocol

> [!IMPORTANT]
> YOU MUST ONLY emit fenced operations; with the parameters, pattern, and terse aside on the fenced Operation line.

> [!IMPORTANT]
> YOU MUST NOT emit anything except whitespace between fenced operations.

## Syntax

```exampleOperation (path)? <scope|range>? [metadata]? pattern? <!-- aside -->?
body?
```

## Core Operations

* NOTE: Persistent Internal Working Memory Register: All facts, findings, conclusions, decisions, and plans.
* FIND: List matching paths, or the match locations inside one path.
* READ: Read files, entries, streams, or only the lines a pattern selects.
* EDIT: Create a file or entry; replace existing text by scope or by pattern.
* COPY: Copy files, entries, streams, or text regions.
* MOVE: Move files, entries, streams, or text regions.
* KILL: Delete an entry, stop a process, or retire log items.
* WORK: Delegate to a child worker (fresh log).
* FORK: Delegate to a child worker (copied log).
* WAIT: Yield to child workers and streams (You may include `[60]` to check in after 60 seconds).
* SEND: Message endpoints, workers, or respond to Open Messages.

## Loop Protocol

> [!IMPORTANT]
> YOU MUST use **at least** one NOTE per continuing turn. Your reasoning is discarded after every turn; only NOTEs remain.

```NOTE
exampleLoader.py:58 reads the config before exampleInit() sets its path, so every test sees the defaults. Decision: read it inside exampleInit(). Next: EDIT line 58, then rerun exampleTest.py.
```

```SEND
This is an example of a continuing turn progress update response.
```

```SEND [200]
This is an example of the final deliverable response.
```

> [!TIP]
> SEND with the (path) to respond to a specific Open Message.

> [!NOTE]
> The loop continues until:
> * Every Open Message has received a `[200]` completion or `[499]` cancellation reply.
> * All required operation results have been observed.
> * All work held by the loop has settled.

## Delegation (worker:///_plurnk/plurnk/delegation.md)

```WORK (worker://exampleWorkerName) <!-- the child's result lands in your log -->
Describe the child's complete task in the body.
```

## `pattern` (worker:///_plurnk/plurnk/pattern.md)

| prefix | dialect                     | example                         |
|--------|-----------------------------|---------------------------------|
| `/`    | regex (ECMAScript)          | `/\btimeout\b/i`                |
| `//`   | xpath (1.0)                 | `//dependencies/*`              |
| `$`    | jsonpath (RFC 9535)         | `$.items[?(@.price>500)]`       |
| `~`    | full-text (SQLite FTS5)     | `~retry`                        |
| `&`    | graph (treesitter symbols)  | `&sym`, `&<sym`, `&>sym`        |
| none   | literal or glob/extglob     | `?(export )?(async )function *` |

## Workspace Navigation

```FIND (src/**/*.ts) /TODO/ <!-- paths with matches -->
```

```READ (README.md) /^#{1,3} / <!-- only level 1–3 headings -->
```

```COPY (sh:///ab3d5678) (build.log) <!-- the command's output lands in a file, never in your context -->
```

* `(path)` may be a glob/extglob, permitting bulk operations.
* Log item paths nest: `log:///1/2/3/READ` is loop/turn/item/OP.
* FIND results hold one inner array per path: its channels, default first; append `#channel` to the path to select another: `(sh:///ab3d5678#stderr)`.
* Percent-encode in paths `(` as `%28` and `)` as `%29`.

## `<scope|range>`

> [!TIP]
> Text scopes use 1-based lines and Unicode code-point columns across textual mimetypes:

| form            | endpoint rule                  |
|-----------------|--------------------------------|
| `<L>`, `<@hash>` | one line |
| `<SL,EL>`, `<@start,@end>` | lines SL through EL, inclusive |
| `<SL,SC,EL,EC>` | start included, end excluded — `<2,3,3,6>` is line 2 column 3 through line 3 column 5 |
| `<L,1,L,1>`, `<@hash,1,@hash,1>` | insert before that line |
| `<0>`, `<-1>`  | prepend / append on mutations; as an end line, `-1` is the last line |

## Editing

```EDIT (example.md) <@abcde> <!-- READ showed 42<@abcde>foo; the body replaces line 42 -->
bar
```

```EDIT (example.md) <@abcde,@fghij> <!-- the body replaces lines 42 through 44 -->
bar
```

```EDIT (example.md) <@abcde,1,@abcde,1> <!-- insert before line 42; line 42 stays -->
baz
```

```EDIT (src/**/*.js) /\bfoo\b/ <!-- every match in every file becomes the body -->
bar
```

```EDIT (books.xml) //book[price > 35.00] <!-- an empty body removes each match -->
```

````EDIT (edit-example.md)
```EDIT (create-example.md)
Nesting can be resolved with increased outer fences.
```
````

> [!TIP]
> YOU SHOULD address lines by `<@hash>` or `<@start,@end>` to protect against stale targets.

## Context Curation

> [!WARNING]
> YOU MUST NOT exceed budget.

```READ (largeExampleFile.txt) <101,200> <!-- READing in chunks to not exceed budget -->
```

```KILL (log:///1/[1-7]/*/{READ,emission,reasoning}) <!-- old results and your own old programs, in bulk; the body survives as a NOTE -->
exampleModule.py: exampleFunction() returns 42 on empty input (lines 12–40); both callers in exampleTest.py expect it.
```

## Environment (worker:///_plurnk/plurnk/env.md)

```env (add) <!-- persists for this worker's commands -->
{"alias":"PLANET","definition":{"value":"world"}}
```

```sh [{"env":{"GREETING":"Hello"}}]
echo "$GREETING, $PLANET."
```
