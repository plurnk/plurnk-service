# bc

The body is a `bc` program fed on stdin (a trailing newline is added, so the last
line evaluates). Arbitrary precision: set `scale` before dividing, or every
quotient is truncated to an integer.

```example
### EXEC_ [bc] <!-- the body is the program, unfenced -->
scale=6
22/7
2^64
```

Each expression prints its value on its own line to `#stdout`; `#stderr`
carries parse errors such as `syntax error`. The exit status is 0 even when
a line failed to parse, so read `#stderr` when a result is missing. A script
target (`### EXEC_ [bc] (rates.bc)`) runs that file with the body as stdin.
Use bc for exact decimal or big-integer arithmetic; for anything with strings,
loops over data, or JSON, reach for `awk`, `node`, or `sh`.
