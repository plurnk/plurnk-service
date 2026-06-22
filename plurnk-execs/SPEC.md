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

`discover(options?) → { registry }`. Scans **every installed package** under `<cwd>/node_modules` — scope-agnostic (scoped and unscoped) — for those declaring `plurnk.kind === "exec"`, and registers each runtime tag from `plurnk.runtimes[]`. The scan is deliberately not limited to `@plurnk/*`: a **third party** can publish an executor under their own scope (`@acme/acme-execs-foo`) and have it discovered with no involvement from this project. (For the batteries-included set, an aggregator package — `@plurnk/plurnk-execs-all` — depends on the framework's daughters flat so one install surfaces them all; the framework itself stays contract-only.)

```json
{
    "name": "@plurnk/plurnk-execs-search",
    "plurnk": {
        "kind": "exec",
        "runtimes": [
            { "name": "search", "glyph": "🔎", "example": "<<EXEC[search]:france population:EXEC", "documentation": "# search\n\n`!bang` / `:lang` ride the query…" },
            { "name": "news",   "glyph": "📰" }
        ]
    }
}
```

A package may claim multiple tags backed by one handler. Tags form a **flat global namespace**; `registry` maps tag → `{ runtime, glyph, example, documentation, packageName, attribution? }`. Unlike plurnk-mimetypes (last-loaded wins), a tag **collision is fail-hard**: two packages claiming the same runtime is an unresolvable install ambiguity the operator must fix.

Each entry's optional **`attribution`** is the package's raw `plurnk.attribution` (`string | string[]`) — credit a consumer unions onto the model call when the package's tags are active (plurnk-service#249). It's **package-level** (every tag of a package carries the same value) and surfaced **raw**: the consumer owns the reservation policy (e.g. `@plurnk/`-scoped attribution only from `@plurnk/`-scoped packages). `undefined` when the package omits it.

Each entry's optional **`example`** is a one-line, self-documenting usage example surfaced **verbatim** by the consumer in its `# Plurnk System Tools` capability sheet so the model learns the tag's syntax + purpose in one line instead of a separate prose description (plurnk-execs#7). It MUST be the **complete canonical op, `<<`-delimited** — `<<EXEC[tag]:body:EXEC` (or `<<EXEC[tag](target):body:EXEC`) — because the consumer renders it verbatim into the sheet; an example missing the `<<` opener teaches the model a malformed op. Defaults to `""` when omitted. Kept to a single line on purpose — the sheet is hot-path and token-sensitive; the generic `(target)` slot is documented once at the op level, not repeated per tag.

Each entry's optional **`documentation`** is full markdown — the flags, modes, and gotchas the one-liner can't carry. It is the depth a consumer can serve on demand, separate from the always-on `example` (progressive disclosure). The **source of truth is a `docs/<tag>.md` file** in the package (the docs convention; ship it via `files`), which `discover()` reads into `documentation`; the inline `documentation` manifest field is the fallback when no file ships. Defaults to `""`. The execs contract is the two fields; **how** the consumer surfaces them to the model — an in-context one-liner, the full doc fetched when the model wants it — is the consumer's (plurnk-service's) concern, not specified here.

### §3.1 Dynamic runtimes (per-deployment tags)

A package whose tags are not known at publish time — the MCP bridge is the motivating case, where each tag is a per-deployment MCP **server** an operator configures in the environment (plurnk-execs#10) — declares **`plurnk.runtimesModule`** (a path, relative to the package dir) **instead of** a static `plurnk.runtimes[]`:

```json
{
    "name": "@plurnk/plurnk-execs-mcp",
    "plurnk": { "kind": "exec", "runtimesModule": "./dist/runtimes.js" }
}
```

The module's **`runtimes`** export (or its default export) is a hook `() => RuntimeDecl[] | Promise<RuntimeDecl[]>` returning the same decls a static manifest would (`{ name, glyph?, example?, documentation? }`). `discover()` imports and calls it at scan time and registers the result exactly as if the decls were static (a `docs/<tag>.md` file still wins over an inline `documentation`, though dynamic tags rarely ship one). The hook reads its own config from the environment — it must be cheap and **must not** depend on network reachability (that is `probe()`'s job, per server, at boot).

Two guarantees frame the hook:

- **Trust-gated execution.** The hook is imported **only for trusted packages** — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate (below) runs *before* the import, so an untrusted package's code is never executed. This is the same in-process-trust posture executors already carry (their `run()` is trusted host code); dynamic discovery just extends it to scan time.
- **Fail-hard on a broken hook.** An unloadable module, a missing/non-function export, or a non-array return is a **contract violation by a trusted package** (its own packaging or config) and throws with the cause attached — surfaced, not swallowed. This is deliberately stricter than a malformed third-party `package.json`, which `discover()` silently skips: a package that *declares* a hook owns making it work.

`runtimes[]` and `runtimesModule` are mutually exclusive; if both are present the **static array wins** and the hook is never loaded.

**Trust gate.** `discover()` honors the host's **`PLURNK_PLUGINS_TRUSTED_ONLY`** env var (plurnk-service#229) — the one posture decided once and enforced across every scope-agnostic discovery surface (schemes/mimetypes/providers/execs). Unset/`""`/`0` → off: every installed package registers (no regression). Any value → on: `@plurnk/*` is always trusted, plus a comma-separated allowlist of additionally-trusted package names (`1` = on with zero third-party). An untrusted package is **discovered but not registered** — never a crash — and returned in **`Discovery.skipped`** (package names) so the consumer can emit a telemetry note (`discover()` has no sink of its own). The policy mirrors plurnk-service's `PluginTrust.isTrusted`; it's duplicated, not shared, since it can't cross the package boundary.

Each runtime package's **default export** is its `BaseExecutor` subclass (also a named export — `export { default as Sh }` / `export { default }`); the consumer instantiates it per matched tag with the tag + glyph from the registry.

### §3.2 Activation (Active / Available)

Discovery answers *what is installed/configured*; **activation** answers *what is offered to the model right now*. They are distinct axes and must not be conflated — `discover()` stays static truth, activation is a runtime overlay the consumer owns on top of it (plurnk-execs#10). This generalizes across the **shared exec/scheme namespace**: a registered capability is a tag claimed once that is both `EXEC[tag]` and `tag://`, and activation operates on it whichever family it came from. MCP is not a category here — it is one *route* for registering a capability (alongside package discovery and env), so its tags activate by the same rules as any other.

**Two states, no third.** A registered capability is **Active** (in the `# Plurnk System Tools` sheet, dispatchable) or **Available** (registered, inert). "Disabled" is the *verb* (Active→Available), not a state. The consumer's capability sheet surfaces two buckets:

- **Tools Active** — the full one-line `example` each (the hot-path teaching cost).
- **Tools Available** — name + glyph + `attribution` each (a word, not a line).

This split *is* the progressive disclosure that bounds the sheet: N available servers cost N words, not N lines.

**Default-activation rule** (the consumer applies it; execs supplies the signals — `packageName` scope, source route, `attribution`):

| Source route | Trust | Default |
|---|---|---|
| Installed package (boot discovery) | first-party (`@plurnk/*`) | **Active** |
| Installed package (boot discovery) | third-party | **Available** |
| Env-declared (e.g. `PLURNK_MCP_<server>`, model-alias style) | — | **Available** |
| Runtime hotload (`/mcp`, gated — below) | — | **Active** on add |

The principle: *Active = the operator unambiguously committed this capability ON* (installed a first-party package; explicitly hotloaded). Configuring connection details (env) or installing a third-party package is the lighter act → Available, opt-in. Mirrors `PLURNK_MODEL_*` — declare many aliases, activate a subset.

**Reachability is orthogonal.** Whether a capability is Active/Available (activation) is independent of whether it is reachable/unreachable (the §2.2 `probe()` health flag). A configured MCP server that is down is *Available but unreachable*. Do not overload "available" across the two axes.

**Capability vs substrate.** enable/disable targets **capability** tags only (execs and executor-backed schemes). Core **substrate** schemes (`file://`, the addressing/ops ground) are always-active and never toggleable — `/disable file` must not be able to brick the address space. For an executor-backed scheme, `disable` gates *new production*; existing `tag://` entries stay READable (reads are pure).

**Security — one gate, on introduction not activation.** `enable` / `disable` are **not** trust-gated: a client (and the model itself) may freely activate any *registered* capability. This is safe because the registered set is operator-bounded — only env-declared or package-installed capabilities exist — *unless* the single daemon gate **`PLURNK_MCP_INSTALL`** (default off) opens the runtime-hotload route, permitting *arbitrary* tooling to be **added**. Gate the introduction of capabilities, never their activation. The trust gate (§3) still bounds *registration*; activation rides on top of an already-trusted set.

Execs owns none of the overlay machinery — the live Active/Available state, the `/enable` `/disable` `/mcp` commands, and the gate enforcement are the consumer's (plurnk-service#240). Execs' contribution is the static signals above and (for the hotload route) an MCP executor that accepts a runtime-injected server config and re-checks `PLURNK_MCP_INSTALL` at its connect path (defense in depth).

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

The framework wraps this in **`SubprocessExecutor extends BaseExecutor`** — declares `{ stdout, stderr }` channels and implements `run()` (spawn via `resolveRuntime`, stream into the channels, honor `signal`, `emit` `spawn_failed` on a failed start, return `{ status, exitCode }`). Subclasses with their own interpreter table override the **`protected spawnArgs(runtime, command) → SpawnArgs`** hook (default delegates to `resolveRuntime`) — and so inherit run()'s streaming + process-group abort handling. `SpawnArgs.stdin?` lets filter-style runtimes feed their program/input via stdin (`bc`, `tclsh`; or `""` for an `awk` BEGIN with EOF). On abort it kills the whole **process group** (`detached` spawn + `process.kill(-pid, …)`, SIGTERM→SIGKILL grace) so shell grandchildren can't leak (plurnk-execs#4). The `plurnk-execs-common` sibling subclasses it — claiming the whole subprocess set (sh/bash/node/python plus detected host interpreters) via a recipe table behind a `spawnArgs()` / `probe()` override. `isKnownRuntime` / `KNOWN_RUNTIMES` are the legacy 501 gate; the discovery registry + `probe()` supersede them once a consumer wires the registry.

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
