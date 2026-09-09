# bun

The body is TypeScript or JavaScript, run with `bun -e`. A script target runs
that file and receives the body as stdin; `{args=[...]}` passes literal
arguments, readable as `Bun.argv` or `process.argv`.

````bun <!-- the body is the program -->
const file = Bun.file("package.json");
console.log((await file.json()).name);
````

````bun (scripts/build.ts) {args=["--watch=false"]}````

`console.log` streams to `#stdout`, `console.error` to `#stderr`; an uncaught
error or `process.exit(1)` closes with status 500. Prefer `node` unless the
project is a Bun project: node is always present, bun only when the host
has it.
