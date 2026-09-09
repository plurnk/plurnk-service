# node

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it's always available (no PATH probe).

````node <!-- the body is the snippet -->
const os = require("node:os");
console.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }));
````

## Environment

The same scoped environment as `sh`: the daemon's own secrets (`PLURNK_*`, provider keys) are stripped, so `process.env` inside the snippet sees the project's environment, not plurnk's.

## Output

Whatever the snippet writes to stdout streams to `#stdout`; stderr streams to
`#stderr`. Both are text under the receipt's `stream` address, such as
`node:///1/2/3/EXEC`. On completion, the harness adds a READ of each channel's
first page (up to 16 lines). READ the stream address for additional lines;
the log READ holds only its recorded page. To return structured data, use
`console.log(JSON.stringify(value))`. A thrown error exits nonzero (status 500)
with its stack on stderr.

## Working directory

Runs in the workspace project root by default, or the daemon's own cwd in a
workspace without one; a `{cwd=<directory>}` block on the opening fence line selects
another. The target is a script, never a command or a directory:
````` ````node (tool.js) ````` runs that JavaScript file and receives the body as
stdin. `{args=["--format","json"]}` passes literal script arguments, also for
`worker://` and `skill://` targets. Relative imports resolve from the script;
ordinary relative filesystem paths resolve from cwd. The receipt names cwd
when it differs from the project root.
