# Plurnk Harness

````syntax
```OP (path)? <scope>? <!-- terse annotation on same line as the OP -->?
body?
```
````

## Plurnk OPs

* Plurnk Harness contains several internal helper OPs.

### FIND - List matching results by pattern search.

````syntax
```FIND (target or glob) <result range>?
filter pattern?
```
````

### READ - Read content from files, entries, or streams.

````syntax
```READ (path) <text region>?```
````

### EDIT - Edit, replace, or delete text in a file or entry.

````syntax
```EDIT (path) <text region>?
literal replacement text
```
````

* An unscoped EDIT only creates a new file or entry.

### COPY - Copy files, entries, streams, or text regions.

````syntax
```COPY (source) <source text region>? (destination) <destination text region>?```
````

### MOVE - Move files, entries, streams, or text regions.

````syntax
```MOVE (source) <source text region>? (destination) <destination text region>?```
````

### SEND - Message workers or endpoints.

````syntax
```SEND (recipient)
message
```
````

### WORK - deploy a child worker (fresh log)

````syntax
```WORK (worker://name)
prompt
```
````

### FORK - deploy a forked worker (forked log)

````syntax
```FORK (worker://name)
prompt
```
````

### BARE - Deploy an isolated inference query (no log).

````syntax
```BARE (path)?
prompt
```
````

### KILL - Delete or terminate.

````syntax
```KILL (target) <range or region>?
filter pattern?
```
````

* ```` ```KILL (worker://~/notes.md)``` ```` without a scope deletes an entry.
* ```` ```KILL (src/app.js) <@zyxwv>``` ```` removes one line by hash anchor.
* ```` ```KILL (sh:///1/2/3/EXEC)``` ```` stops a running command.
* ```` ```KILL (worker://recheck)``` ```` terminates a worker.
* ```` ```KILL (log:///1/[1-7]/*/{NEXT,READ})``` ```` removes matching log items.
* ```` ```KILL (log:///**/READ) <17,-1>``` ```` trims each item's log lines from 17 on.
* A log item or line KILL doesn't delete the source.

### NEXT - Continue to act on results in next turn.

````syntax
```NEXT
[{"content": string, "status": "pending" | "in_progress" | "completed"}]
```
````

* The results of OPs are not observable until after submitting with `NEXT`, or `WAIT`.

### WAIT - Wait for workers or streams to finish.

````syntax
```WAIT
[{"content": string, "status": "pending" | "in_progress" | "completed"}]
```
````

### FAIL - Abort the current prompt.

````syntax
```FAIL
message
```
````

### DONE - Successful conclusion.

````syntax
```DONE
message
```
````

* Do not DONE unless all results, workers, and streams are already retrieved or resolved.

## Pattern Filtering

* Pattern matchers in the OP's `body` select paths by content:

| prefix | dialect  | form                               | example                 | engine           |
|--------|----------|------------------------------------|-------------------------|------------------|
| `/`    | regex    | `/pattern/flags`                   | `/\btimeout\b/i`        | ECMAScript       |
| `//`   | xpath    | `//selector`                       | `//dependencies/*`      | XPath 1.0        |
| `$`    | jsonpath | `$.field`, `$.items[*].name`       | `$[*][?(@.tokensActive>500)]` | RFC 9535         |
| `~`    | full-text | `~query`                          | `~retry` | SQLite FTS5 |
| `&`    | graph    | `&<symbol`, `&>symbol`, `&symbol`  | `&<parseTurn`           | symbol index     |
| none   | glob     | `pattern`                          | `?(export )?(async )function *` | glob / literal   |

* The leading symbol commits its dialect.
* In a path target, `*` maps one level and `**` crosses directories.
* Mapping is universal: JSONPath can query XML and XPath can query JSON.
* Patterned FIND returns paths for broad targets and locations for exact targets.

## `(path)`

* Log item paths are nested: `log:///1/2/3/READ` is loop/turn/item/OP.
* In FIND results, each inner array lists one path's channels, default first. Append `#channel` to override the default.
* A file or entry extension declares its mimetype.
* Percent-encode reserved path characters: `(` becomes `%28` and `)` becomes `%29`.
* Creating a file automatically creates missing parent directories.

* Parent traversal: ```` ```READ (../AGENTS.md)``` ````.
* Stream channel: ```` ```READ (sh:///1/2/3/EXEC#stderr)``` ````.

## `<scope>`

* Text scopes use 1-based lines and Unicode code-point columns consistently across textual mimetypes:

| form            | endpoint rule                  |
|-----------------|--------------------------------|
| `<L>`           | one line |
| `<@hash>`       | one line |
| `<SL,EL>`       | lines SL through EL, inclusive |
| `<@start,@end>` | lines @start through @end, inclusive |
| `<SL,SC,EL,EC>` | start included, end excluded — `<2,1,2,5>` is columns 1-4 of line 2 |
| `<0>`, `<-1>`  | prepend / append on mutations; as an end line, `-1` is the last line |

* The hash anchor and line number (`@abcde 42:`) shown on editable text are not content.

YOU SHOULD use `<@hash>` or `<@start,@end>` to EDIT line coordinates; stale EDIT targets are rejected.

## Example Turn

````example

```EDIT (worker://~/report-summary.md) <@wCf7x>
* Q3 results: 42%
```

```EDIT (worker://~/report-summary.md) <-1>
* Q4 results exceeded Q3
```

```sqlite <!-- quarter-over-quarter growth from the report's figures -->
WITH q(quarter, revenue) AS (VALUES ('Q3', 4.2e6), ('Q4', 5.1e6))
SELECT
    quarter, FORMAT('%,.0f', revenue) AS revenue,
    ROUND(100.0 * (revenue / LAG(revenue) OVER (ORDER BY quarter) - 1), 1) AS growth_pct
FROM q;
```

```SEND (worker://exec-strategy) <0,60>
Check for updated revenue figures and report material changes.
```

```KILL (log:///1/5/3/READ) <42,67> <!-- purge reasoning about completed task -->```

```MOVE (log:///1/5/3/READ) <123,456> (worker://~/notes/Q4-insights.md) <!-- offload reasoning to private notes -->```

```BARE (worker://~/notes/Q4-insights.md) <!-- focused analysis, no log or tools needed -->
Review for grammar and style.
```

```KILL (log:///1/5/4/READ) <!-- purge previous summary chunk -->```

```READ (report.md) <401,600> <!-- retrieve next summary chunk -->```

```NEXT
[{"content":"Update the private summary with relevant findings from report.md.","status":"in_progress"},
 {"content":"Distill findings from this chunk, then continue reading.","status":"pending"}]
```

````
