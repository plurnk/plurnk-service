# node

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it
is always available (no PATH probe).

```node <!-- the body is the snippet -->
const os = require("node:os");
console.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }));
```

`node (tool.js)` runs that JavaScript file and receives the body as stdin;
`[{"args": ["--format","json"]}]` passes literal script arguments, also for
`worker://` and `skill://` targets. Relative imports resolve from the script;
ordinary relative filesystem paths resolve from the working directory.
Environment, working directory, channels, first page, exit status and lifetime
are the executor family's, as `sh.md` states. Stdout is text, so structured
output is serialized (`console.log(JSON.stringify(value))`); a thrown error
exits nonzero (status 500) with its stack on stderr.

## Live input

`[{"stdin": "open"}]` keeps stdin open for later SENDs to the receipt's execution
address. Without it, initial input ends with EOF as usual.

```node [{"stdin": "open"}]
process.stdin.on("data", chunk => process.stdout.write(chunk));
```

Using the address returned by that invocation (here `node:///ab3d5678`):

```SEND (node:///ab3d5678)
hello

```

The blank line before the closing fence supplies a newline after `hello`.
SEND adds no newline of its own. Its receipt acknowledges pipe delivery, not
program completion. READ that same address to inspect stdout while it runs.

```SEND (node:///ab3d5678) [{"eof": true}]
```

EOF closes stdin, not the process. KILL terminates the execution. Any worker
in the workspace can send input to the same execution address.
