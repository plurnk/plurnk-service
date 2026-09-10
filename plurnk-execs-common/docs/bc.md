# bc

For continuing input, launch with `{stdin=open}`, then SEND exact text to the
returned execution address; `{eof=true}` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is a `bc` program fed on stdin (a trailing newline is added, so the last
line evaluates). Arbitrary precision: set `scale` before dividing, or every
quotient is truncated to an integer.

````bc <!-- the body is the program -->
scale=6
22/7
2^64
````

Each expression prints its value on its own line to `#stdout`; `#stderr`
carries parse errors such as `syntax error`. The exit status is 0 even when
a line failed to parse, so read `#stderr` when a result is missing. A script
target (````` ````bc (rates.bc) `````) runs that file with the body as stdin.
Use bc for exact decimal or big-integer arithmetic; for anything with strings,
loops over data, or JSON, reach for `awk`, `node`, or `sh`.
