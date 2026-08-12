# node

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it's always available (no PATH probe).

## Environment

The same scoped environment as `sh`: the daemon's own secrets (`PLURNK_*`, provider keys) are stripped, so `process.env` inside the snippet sees the project's environment, not plurnk's.

## Output

Whatever the snippet writes to stdout streams to `#stdout`; stderr streams to
`#stderr`. Both are text under the emitted `node:///<loop>/<turn>/<sequence>`
address. To return structured data, use `console.log(JSON.stringify(value))`
and READ that address. A thrown error exits nonzero (status 500) with its stack
on stderr.

## Working directory

Runs in the workspace project root by default. `## EXEC0 [node] (./dir)` sets the
working directory; relative module and filesystem paths resolve against it.
