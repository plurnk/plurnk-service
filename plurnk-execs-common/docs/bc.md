# bc

The body is a `bc` program fed on stdin (a trailing newline is added, so the
last line evaluates). Arbitrary precision: `scale` is set before dividing, or
every quotient is truncated to an integer.

```bc <!-- the body is the program -->
scale=6
22/7
2^64
```

Each expression prints its value on its own line to `#stdout`; `#stderr`
carries parse errors such as `syntax error`, and the exit status is 0 even when
a line failed to parse, so a missing result is explained on `#stderr`. A script
target (`bc (rates.bc)`) runs that file with the body as stdin. Live input
(`[{"stdin": "open"}]`, SEND, `[{"eof": true}]`) is as `node.md` shows.
