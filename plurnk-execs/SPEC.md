# plurnk-execs — Specification

Contract for `@plurnk/plurnk-execs-*` sibling packages — runtime executors that plurnk-service's `exec://` scheme dispatches to. Audience: implementer of a runtime executor. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §6.8, §10). Contract shape settled in plurnk-service#174.

## §1 Role

A runtime executor handles one or more EXEC `runtime` slot values (`sh`, `node`, `python`, `search`, `news`, …). It is a `BaseExecutor` subclass that declares its output channels and implements `run()`; the framework discovers it from its `package.json` `plurnk` block. The consuming scheme owns all I/O and lifecycle machinery (db, channels, subscriptions, AbortController bridging, wake-on-completion) and hands the executor sinks — the executor stays stateless across runs beyond its construction metadata.

The framework ships `SubprocessExecutor` (§4), the concrete `BaseExecutor` for subprocess runtimes (sh/node/python), built on the lower-level `resolveRuntime` / `SpawnArgs` helper. plurnk-service's exec scheme has adopted `SubprocessExecutor`; the discovery-registry + `probe()`/`effect()` consumption is realized in service `0.9.0` (`ExecutorRegistry` boot-discovers and probes siblings; `EffectPolicy` gates the proposal lifecycle).

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

### §2.2 Availability probe

```ts
interface RuntimeAvailability { available: boolean; detail?: string; }

abstract class BaseExecutor {
    async probe(): Promise<RuntimeAvailability> { return { available: true }; }  // default: available
}
```

`probe()` reports whether the runtime's *environment* is usable here — distinct from whether the *package* is installed (`discover()`). Pure / in-process runtimes (node, sqlite) inherit the available default; runtimes depending on an external binary (`python` → `python3 --version`) or config (`search` → `SEARXNG_URL`) override. `SubprocessExecutor` probes its `binary` getter (`null` = always available).

Consumer contract (plurnk-service#181): probe **once at boot, per package** (not per tag — stamp all of a package's tags with the one result), **concurrently under a per-probe timeout**, and **cache**. `probe()` MAY reject; the consumer treats rejection as `{ available: false, detail: <error> }`, so a buggy probe degrades only its runtime. The model is offered a positive list of available runtimes; an attempt at an unavailable one returns **501 carrying `detail`** (so `detail` is model-facing — terse and actionable). A configured default runtime that probes unavailable is a **fail-hard boot error**.

### §2.3 Effect (proposal gating)

```ts
type Effect = "pure" | "read" | "host";

abstract class BaseExecutor {
    effect(target: string | null): Effect { return "host"; }  // default: conservative
}
```

`effect()` classifies an invocation's side effect so the consumer can gate the proposal lifecycle per runtime (service#182). The executor declares the **fact**; the consumer owns the **policy** (an `effect → propose/auto` map, deployment-tunable: default `host → propose`, `read`/`pure → auto`).

- **`host`** — runs code / mutates the host (subprocess; file-backed sqlite) → propose.
- **`read`** — observes external state, no host mutation (search) → auto.
- **`pure`** — no observable side effect (sqlite `:memory:`, transforms) → auto.

`effect()` MUST be **pure, synchronous, and cheap** — it runs on the dispatch hot path at propose time. It classifies the **target only** (known pre-`run()`); it MUST NOT inspect the command (parsing SQL/shell to judge intent is a sandbox-escape footgun) and MUST NOT do I/O. Default `host` is conservative — anything unclassifiable is proposed (fail-safe, the mirror of `probe()`'s fail-open default).

For `exec`, per-runtime `effect()` supersedes the static `Exec.manifest.flags.proposes`. Auto-run (`read`/`pure`) runtimes may run **inline** — synchronous return rather than entry-then-read-next-turn — while still landing the result as a re-readable entry.

### §2.4 Telemetry

Runtime failures are emitted as a grammar `TelemetryEvent` via the `emit` sink (plurnk-service#174 Q3); the scheme routes it to the engine's telemetry buffer — the same path grammar's `parse_error` takes. Events are not encoded into `stderr` (that pollutes program output) nor returned on `ExecResult` (that loses mid-run events).

- `source`: `"exec:<runtime>"` (e.g. `"exec:search"`) or `"scheme:exec"`.
- `kind`: producer-minted, open vocabulary. What the shipped executors actually emit: `SubprocessExecutor` → `spawn_failed` (a failed *start*; a nonzero exit is the program's own result and stays on `stderr`, **not** telemetered); search → `searxng_not_configured` / `searxng_unreachable` / `searxng_timeout` / `searxng_http_<n>` / `external_bang_refused`; sqlite → `sqlite_open_failed` / `sqlite_error`. A cancellation (`signal` abort) is normal flow — **not** emitted.
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

Each runtime package's **default export** is its `BaseExecutor` subclass (also a named export — `export { default as Sh }` / `export { default }`); the consumer instantiates it per matched tag with the tag + glyph from the registry.

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

`resolveRuntime` never throws; consumers gate unknown runtimes with `isKnownRuntime` and return 501 before invoking.

The framework wraps this in **`SubprocessExecutor extends BaseExecutor`** — declares `{ stdout, stderr }` channels and implements `run()` (spawn via `resolveRuntime`, stream into the channels, honor `signal`, `emit` `spawn_failed` on a failed start, return `{ status, exitCode }`). Subclasses with their own interpreter table override the **`protected spawnArgs(runtime, command) → SpawnArgs`** hook (default delegates to `resolveRuntime`) — and so inherit run()'s streaming + process-group abort handling. `SpawnArgs.stdin?` lets filter-style runtimes feed their program/input via stdin (`bc`, `tclsh`; or `""` for an `awk` BEGIN with EOF). On abort it kills the whole **process group** (`detached` spawn + `process.kill(-pid, …)`, SIGTERM→SIGKILL grace) so shell grandchildren can't leak (plurnk-execs#4). The `plurnk-execs-sh` / `-node` / `-python` siblings subclass it and differ only in their claimed `runtimes[]` tags and their `binary` getter (for `probe()`). `isKnownRuntime` / `KNOWN_RUNTIMES` are the legacy 501 gate; the discovery registry + `probe()` supersede them once a consumer wires the registry.

## §5 Consumer surface (plurnk-service)

Per plurnk-service#174/#181/#182, realized in service `0.9.0`, the exec scheme:

1. Boot-discovers executors (`discover()`), `probe()`s each per-package, and offers the model the positive available-runtimes list; an unavailable runtime returns 501 carrying `probe()` `detail`.
2. Resolves the runtime tag to its executor and runs it through `run()`, seeding the exec entry's channels from `executor.channels`.
3. Provides the `write` / `setState` / `emit` sinks bound to its channel-write, channel-state, and engine-telemetry machinery; bridges its AbortController to `args.signal`; maps the `ExecResult` to close-status + wake summary.
4. Gates the proposal lifecycle by `effect(target)` (`EffectPolicy`: `host → propose`, `read`/`pure → auto`), running auto-run runtimes inline (synchronous return) while still landing the result as a re-readable entry.

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
