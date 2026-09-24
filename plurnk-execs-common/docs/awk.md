# awk

The body is the AWK program, passed as the one positional argument with an
empty stdin: with no input file it only runs `BEGIN` blocks. Input files are
named in `[{"args": [...]}]`; a script target runs that file and receives the
body as stdin. Working directory, environment, channels and exit status are the
executor family's (`sh.md`); `exit 1` in the program closes with status 500.

```awk [{"args": ["data.csv"]}] <!-- the body is the program -->
BEGIN { FS = "," }
NR > 1 { total += $3 }
END { printf "rows=%d total=%.2f\n", NR - 1, total }
```

```awk (tools/summarize.awk) <!-- the script runs; the body is its stdin -->
alpha,1
beta,2
```

Live input (`[{"stdin": "open"}]`, SEND, `[{"eof": true}]`) is as `node.md`
shows.
