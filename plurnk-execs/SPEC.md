# plurnk-execs — Specification

Contract for `@plurnk/plurnk-execs-*` sibling packages — runtime executors that plurnk-service's `exec://` scheme dispatches to. Audience: implementer of a runtime executor. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §6.8, §10). Contract shape settled in plurnk-service#174.

## §1 Role

A runtime executor handles one or more EXEC `runtime` slot values (`sh`, `node`, `python`, `search`, `news`, …). It is a `BaseExecutor` subclass that declares its output channels and implements `run()`; the framework discovers it from its `package.json` `plurnk` block. The consuming scheme owns all I/O and lifecycle machinery (db, channels, subscriptions, AbortController bridging, wake-on-completion) and hands the executor sinks — the executor stays stateless across runs beyond its construction metadata.

The subprocess runtime-tag → spawn-args mapping (`resolveRuntime` / `SpawnArgs`, §4) predates this contract and is retained: plurnk-service's exec scheme still consumes it on its legacy subprocess path. The migration of subprocess runtimes onto `SubprocessExecutor` is phased and deferred until the first non-subprocess sibling (`plurnk-execs-search`) proves the contract (plurnk-service#174 Q2).

## §2 Executor contract

```ts
abstract class BaseExecutor {
    readonly runtime: string;   // matched tag — "sh" / "search" / "news" / …
    readonly glyph: string;
    constructor(metadata: { runtime: string; glyph: string });

    // Channels this executor writes to; the scheme seeds the exec entry from
    // these (§2.1). Subprocess runtimes declare { stdout, stderr }; search
    // declares { results }.
    abstract get channels(): Readonly<Record<string, ChannelDecl>>;

    abstract run(args: ExecArgs): Promise<ExecResult>;
}

interface ChannelDecl { mimetype: string; defaultState?: ChannelState; }
type ChannelState = "active" | "closed" | "errored";

interface ExecArgs {
    runtime: string;            // matched tag; multi-tag executors branch on it
    command: string;            // EXEC body: shell line / source / search query
    cwd: string | null;         // subprocess working dir; null/ignored for logical runtimes
    signal: AbortSignal;        // cancellation — executors must honor it
    write: (channel: string, chunk: string) => void;          // write a chunk to a declared channel
    setState: (channel: string, state: ChannelState) => void; // drive a declared channel's lifecycle
    emit: (event: TelemetryEvent) => void;                    // emit telemetry/error (§2.2)
}

interface ExecResult {
    status: number;             // 200 ok / 499 aborted / 500 error
    exitCode?: number;          // subprocess family only
}
```

`run()` must not throw for an expected runtime failure: surface it through `emit` + an `errored` channel state + a non-200 `status`.

### §2.1 Channel topology is executor-declared

The executor declares its channels; the consuming scheme seeds the exec entry from `executor.channels` rather than from a static scheme-level manifest (plurnk-service#174 Q1). This keeps channel names honest — `search` exposes `{ results: { mimetype: "application/json" } }`, and the model reads `exec://<coord>/EXEC#results` instead of an overloaded `#stdout`. `write` / `setState` are generic over channel name; writing to an undeclared channel is a contract violation.

### §2.2 Telemetry

Runtime failures are emitted as a grammar `TelemetryEvent` via the `emit` sink (plurnk-service#174 Q3); the scheme routes it to the engine's telemetry buffer — the same path grammar's `parse_error` takes. Events are not encoded into `stderr` (that pollutes program output) nor returned on `ExecResult` (that loses mid-run events).

- `source`: `"exec:<runtime>"` (e.g. `"exec:search"`) or `"scheme:exec"`.
- `kind`: producer-minted — `runtime_not_configured`, `spawn_failed`, `exited_nonzero`, `aborted`, and runtime-specific kinds (search: `searxng_unreachable`, `searxng_http_<n>`).
- `message`: terse, factual. `position`: typically null at the runtime layer.

The envelope is mirrored locally (`TelemetryEvent`, `ContentOffset`, `LogCoordinate`) so the framework needs no `@plurnk/plurnk-grammar` dependency; grammar's `dist/schema/TelemetryEvent.json` is the source of truth.

## §3 Discovery

`discover(options?) → { registry }`. Scans `<cwd>/node_modules/@plurnk/` (or explicit `packageDirs`) for packages declaring `plurnk.kind === "exec"`, and registers each runtime tag from `plurnk.runtimes[]`:

```json
{
    "name": "@plurnk/plurnk-execs-search",
    "plurnk": {
        "kind": "exec",
        "runtimes": [
            { "name": "search", "glyph": "🔎" },
            { "name": "news",   "glyph": "📰" }
        ]
    }
}
```

A package may claim multiple tags backed by one handler. Tags form a **flat global namespace**; `registry` maps tag → `{ runtime, glyph, packageName }`. Unlike plurnk-mimetypes (last-loaded wins), a tag **collision is fail-hard**: two packages claiming the same runtime is an unresolvable install ambiguity the operator must fix.

Each runtime exports its `BaseExecutor` subclass; the consumer instantiates it per matched tag with the tag + glyph from the registry. (Module-export convention for the subclass settles as the first siblings ship.)

## §4 Subprocess helper (legacy path)

`resolveRuntime(runtime, command) → SpawnArgs` and `isKnownRuntime(runtime)` / `KNOWN_RUNTIMES` translate a subprocess runtime tag into `node:child_process.spawn` arguments:

```ts
interface SpawnArgs { cmd: string; args: string[]; useShell: boolean; }
```

| Runtime | Spawn |
|---|---|
| `""` / `"sh"` / `"bash"` | `{ cmd: command, args: [], useShell: true }` |
| `"node"` | `{ cmd: "node", args: ["-e", command], useShell: false }` |
| `"python"` / `"python3"` | `{ cmd: "python3", args: ["-c", command], useShell: false }` |
| any other | `{ cmd: runtime, args: ["-c", command], useShell: false }` (conservative fallback) |

`resolveRuntime` never throws; consumers gate unknown runtimes with `isKnownRuntime` and return 501 before invoking. This surface will fold into `SubprocessExecutor` (a `BaseExecutor` subclass owning spawn/stream/abort) during the deferred subprocess migration; until then plurnk-service's exec scheme consumes it directly for shell/node/python while routing `search` through `run()`.

## §5 Consumer surface (plurnk-service)

Per plurnk-service#174, the exec scheme:

1. Resolves the runtime tag against the discovery registry; routes `search` (and future siblings) through the executor's `run()`.
2. Seeds the exec entry's channels from `executor.channels`.
3. Provides the `write` / `setState` / `emit` sinks bound to its channel-write, channel-state, and engine-telemetry machinery; bridges its AbortController to `args.signal`; maps the `ExecResult` to close-status + wake summary.
4. Keeps the legacy `streamShellCommand` path (via `resolveRuntime`) for subprocess runtimes until the `SubprocessExecutor` migration.

## §6 Forbidden (for siblings)

| ❌ |
|---|
| Database access |
| Imports from `@plurnk/plurnk-service/*` |
| Mutating `ExecArgs` |
| Holding state across `run` calls beyond construction metadata |
| Reading runtime output via `console.*` |
| Ignoring `args.signal` |
| Writing to an undeclared channel |
| Spawning processes outside the runtime's domain (e.g. an HTTP/search runtime spawning subprocesses) |
