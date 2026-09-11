# deno

For continuing input, launch with `{stdin=open}`, then SEND exact text to the
returned execution address; `{eof=true}` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is TypeScript or JavaScript, run with `deno eval` (permissions are
Deno's defaults for `eval`; import what you need from the project or a URL).
A script target runs that file and receives the body as stdin;
`{args=[...]}` passes literal arguments, readable as `Deno.args`.

````deno <!-- the body is the program -->
const versions: Record<string, string> = Deno.version;
console.log(JSON.stringify(versions));
````

````deno (scripts/check.ts) {args=["--strict"]}
````

`console.log` streams to `#stdout`, `console.error` to `#stderr`; an uncaught
error or `Deno.exit(1)` closes with status 500. Prefer `node` when the task
does not need Deno specifically: node is always present, deno only when the
host has it.
