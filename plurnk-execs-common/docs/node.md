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

Runs in the workspace project root by default — `(.)` names it explicitly, or
the daemon's own cwd in a workspace without one. The target is a cwd or a
script, never a command: a directory target sets the working directory; a
script target runs that JavaScript file and receives the body as stdin; anything
else is refused before anything runs. Relative module and filesystem paths
resolve against the selected working directory. The receipt always names it.
