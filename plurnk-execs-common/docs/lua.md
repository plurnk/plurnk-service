# lua

For continuing input, launch with `{stdin=open}`, then SEND exact text to the
returned execution address; `{eof=true}` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is Lua code, run with `lua -e`. A script target runs that file and
receives the body as stdin; `{args=[...]}` passes literal script arguments,
readable through the `arg` table.

````lua <!-- the body is the program -->
local t = { 3, 1, 2 }
table.sort(t)
print(table.concat(t, ","))
````

````lua (scripts/lint.lua) {args=["src/main.lua"]}
````

`print` streams to `#stdout`, `io.stderr:write` to `#stderr`; `error(...)`
or `os.exit(1)` closes with status 500. The standalone interpreter is the
host's `lua` on PATH; project modules resolve through its ordinary
`package.path` from the working directory.
