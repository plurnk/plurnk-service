# node

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it's always available (no PATH probe).

## Environment

The same scoped environment as `sh`: the daemon's own secrets (`PLURNK_*`, provider keys) are stripped, so `process.env` inside the snippet sees the project's environment, not plurnk's.

## Output

Whatever the snippet writes to stdout streams to the `stdout` channel (stderr → `stderr`); both are text. To return structured data, `console.log(JSON.stringify(x))` and `READ` it back. A thrown error exits non-zero (status 500) with the stack on `stderr`.

## Working directory

Runs in the session project root by default; `EXEC[node](./dir):…` sets cwd, and relative `import` / `require` / `fs` paths resolve against it.
