# awk

For continuing input, launch with `{stdin=open}`, then SEND exact text to the
returned execution address; `{eof=true}` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is the AWK program, passed as the one positional argument with an
empty stdin: with no input file it only runs `BEGIN` blocks. To process data,
name the file(s) in `{args=[...]}`, or run a script target and feed it the body
as stdin.

````awk {args=["data.csv"]} <!-- the body is the program -->
BEGIN { FS = "," }
NR > 1 { total += $3 }
END { printf "rows=%d total=%.2f\n", NR - 1, total }
````

````awk (tools/summarize.awk) <!-- the script runs; the body is its stdin -->
alpha,1
beta,2
````

Output goes to `#stdout`, diagnostics to `#stderr`; `exit 1` in the program
closes with status 500. `{cwd=<directory>}` selects the working directory
for relative file arguments. AWK is the right tool for column arithmetic and
line reshaping over text; for JSON use `jq`, for anything else `node` or `sh`.
