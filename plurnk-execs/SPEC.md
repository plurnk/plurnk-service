# plurnk-execs — Specification

Contract for `@plurnk/plurnk-execs-*` sibling packages — runtime executors that plurnk-service's `exec://` scheme dispatches to. Audience: implementer of a runtime executor. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §6.8, §10).

## §1 Role

A runtime executor handles one or more EXEC `runtime` slot values. Today plurnk-service's `Exec` scheme hardcodes the runtime → spawn-args mapping for shell / node / python; this repo exports the same logic as `resolveRuntime`. The forward-spec is plugin discovery (one runtime per sibling); v0 ships the hardcoded path.

## §2 v0 surface

`resolveRuntime(runtime: string, command: string) → SpawnArgs`:

```ts
interface SpawnArgs {
    cmd: string;
    args: string[];
    useShell: boolean;
}
```

Maps:

| Runtime | Spawn |
|---|---|
| `""` / `"sh"` / `"bash"` | `{ cmd: command, args: [], useShell: true }` |
| `"node"` | `{ cmd: "node", args: ["-e", command], useShell: false }` |
| `"python"` / `"python3"` | `{ cmd: "python3", args: ["-c", command], useShell: false }` |
| any other | `{ cmd: runtime, args: ["-c", command], useShell: false }` (conservative fallback) |

`resolveRuntime` never throws. Consumers gate unknown runtimes with `isKnownRuntime(runtime)` and return 501 from the scheme before invoking.

`KNOWN_RUNTIMES` is the v0 hardcoded set; equivalent to the union of mapped runtimes above except the conservative fallback.

## §3 Forward-spec — plugin discovery

The full constellation pattern (mirroring `plurnk-mimetypes`):

```json
{
    "name": "@plurnk/plurnk-execs-<runtime>",
    "plurnk": {
        "kind": "exec",
        "runtimes": [
            { "name": "sh", "glyph": "🐚" },
            { "name": "bash", "glyph": "🐚" }
        ]
    }
}
```

Each sibling registers one or more runtime tags. Plurnk-service scans `node_modules/@plurnk/*` at boot, finds `plurnk.kind === "exec"` packages, registers their handlers. Collision on runtime name: fail-hard.

Each runtime exports a `BaseExecutor` subclass (or equivalent) with `run(args) → Promise<ExecResult>`. Args shape, result shape, AbortSignal handling — all settle as the first sub-siblings ship (`plurnk-execs-sh` would be canonical).

Sub-siblings expected: `plurnk-execs-sh` (default subprocess), `plurnk-execs-node`, `plurnk-execs-python`, `plurnk-execs-search` (web search).

## §4 Consumer surface (plurnk-service today)

The `exec` scheme in plurnk-service:

1. Calls `isKnownRuntime(runtime)` — returns 501 if false.
2. Calls `resolveRuntime(runtime, command)` to get `SpawnArgs`.
3. Passes args to `node:child_process.spawn` and manages the subprocess lifecycle (channels, AbortController, subscription registry, wake-on-completion).

Steps 1–2 are this repo's surface. Step 3 stays in the `exec` scheme. The plug-in discovery future (§3) will absorb step 3's invocation into the executor interface, but for v0 the scheme owns the spawn/streaming machinery and consumes this repo only for the runtime-tag translation.

## §5 Forbidden (for future siblings)

| ❌ |
|---|
| Database access |
| Imports from `@plurnk/plurnk-service/*` |
| Mutating arguments |
| Holding state across `run` calls beyond config |
| Reading runtime output via `console.*` |
| Ignoring cancellation signals |
| Spawning processes outside the runtime's domain (e.g. an HTTP runtime spawning subprocesses) |
