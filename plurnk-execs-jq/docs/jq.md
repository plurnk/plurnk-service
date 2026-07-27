# jq

The system `jq` as a runtime: the **body is the jq program**, the **`(target)` is the data source**.

```
<<EXEC[jq]:[1,2,3] | add:EXEC                       inline — no input (-n), the program stands alone
<<EXEC[jq](data.json):.users[].name:EXEC            filter a file
<<EXEC[jq](exec://…#results):.items[]:EXEC          filter a prior op's output
```

An empty body defaults to `.` (identity). Results land on `results` as `application/jsonl` — one compact value per line.

## Deliberate departures from the `jq` CLI (#493)

- **No stdin.** The op grammar has no pipe; `jq`'s read-stdin default maps to `-n` (null input) when no target is given, so an inline program constructs its own input. A file target matches `jq program file` exactly.
- **Compact output is forced (`-c`).** `jq`'s pretty-print default would break the channel's JSONL contract; presentation belongs to the consumer's mimetype pipeline, not the filter.
- **No flag surface.** The body is the program only — `--arg`, `-r`, `-s` and friends are not passable. What flags do is expressible in-language (`-r` → the value is unquoted when READ as text; `--arg` → bind in the program; `-s` → `[inputs]` has no stdin to slurp, pass a file). One surface, no argv parsing.

`jq` reads the ambient environment (`env`, `$ENV`) per its own contract — the consumer's scoped env is honored when provided.

## Errors

A failed program or spawn closes `results` as `errored` with status 500 and an
RFC 9457 Problem carrying jq's own stderr.
