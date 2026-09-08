# jq

The system `jq` as a runtime: the **body is the jq program**, the **`(target)` is the data source**.

```example
### EXEC_ [jq]
[1,2,3] | add

### EXEC_ [jq] (data.json)
.users[].name

### EXEC_ [jq] (sqlite:///1/2/3/EXEC#results)
.[] | .name
```

The first form has no input and uses `-n`. The second filters a file. The third
filters the result stream at the emitted SQLite address.

An empty body defaults to `.` (identity). Results land on `#results` as
`application/jsonl`—one compact value per line—under the emitted `jq://`
address.

## Deliberate departures from the `jq` CLI

- **No stdin.** The op grammar has no pipe; `jq`'s read-stdin default maps to `-n` (null input) when no target is given, so an inline program constructs its own input. A file target matches `jq program file` exactly.
- **Compact output is forced (`-c`).** `jq`'s pretty-print default would break the channel's JSONL contract; presentation belongs to the consumer's mimetype pipeline, not the filter.
- **No flag surface.** The body is a jq program, not CLI arguments; options such as `--arg`, `-r`, and `-s` are not accepted here.

`jq` reads the ambient environment (`env`, `$ENV`) per its own contract — the consumer's scoped env is honored when provided.

## Errors

A failed program or spawn closes `results` as `errored` with status 500 and an
RFC 9457 Problem carrying jq's own stderr.
