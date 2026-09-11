# jq

The system `jq` as a runtime: the **body is the jq program**, the **`(target)` is the data source**.

````jq
[1,2,3] | add
````

````jq (data.json)
.users[].name
````

````jq (sqlite:///ab3d5678#results)
.[] | .name
````

The first form has no input and uses `-n`. The second filters a file. The third
filters the result stream at the emitted SQLite address.

An empty body defaults to `.` (identity). Results land on `#results` as
`application/jsonl`—one compact value per line—under the emitted `jq://`
address.

## Deliberate departures from the `jq` CLI

- **Batch by default.** Without a target, `-n` supplies null input; a file target filters that file. `[{"stdin": "open"}]` instead waits for JSON values sent to the running invocation. A target plus open stdin reads the file first, then stdin, as `jq program file -` does.
- **Compact output is forced (`-c`).** `jq`'s pretty-print default would break the channel's JSONL contract; presentation belongs to the consumer's mimetype pipeline, not the filter.
- **No flag surface.** The body is a jq program, not CLI arguments; options such as `--arg`, `-r`, and `-s` are not accepted here.

`jq` reads the ambient environment (`env`, `$ENV`) per its own contract — the consumer's scoped env is honored when provided.

## Live input

````jq [{"stdin": "open"}]
.value * 2
````

Use the returned stream address, here `jq:///c4e56789`. A SEND body is input
JSON, not another jq program; this example closes stdin after sending its value:

````SEND (jq:///c4e56789) [{"eof": true}]
{"value":21}
````

Without `[{"eof": true}]`, include an actual trailing newline to delimit each JSON
value. Open-input output is unbuffered. READ the same address for results;
SEND acknowledges only input delivery. KILL remains execution cancellation.

## Errors

A failed program or spawn closes `results` as `errored` with status 500 and an
RFC 9457 Problem carrying jq's own stderr.
