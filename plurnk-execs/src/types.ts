// Runtime executor contract. Each `@plurnk/plurnk-execs-*` sibling declares
// one or more runtime tags (`sh`, `bash`, `python`, `search`, `news`, …) in
// its `package.json` `plurnk.runtimes[]` block, and provides a BaseExecutor
// subclass implementing the dispatch for those tags.
//
// The framework surface is `BaseExecutor.run()` + `discover()`. The runtime
// tag → spawn-args translator (`SpawnArgs` / `resolveRuntime`) is retained as
// a subprocess-family helper: plurnk-service's exec scheme still consumes it
// on its legacy subprocess path until the deferred SubprocessExecutor
// migration (service#174 Q2). See SPEC.md.

import type { TelemetryEvent } from "./TelemetryEvent.ts";

// Channel lifecycle state. Mirrors plurnk-service's per-channel state machine:
// `active` while producing, then a terminal `closed` (clean) or `errored`.
export type ChannelState = "active" | "closed" | "errored";

// A channel an executor declares it writes to. The consuming scheme seeds the
// exec entry from these declarations (service#174 Q1) rather than from a
// static scheme-level manifest — so `search` honestly exposes a `results`
// channel instead of overloading `stdout`.
export interface ChannelDecl {
    mimetype: string;
    defaultState?: ChannelState;
}

// Metadata the framework injects into a BaseExecutor at construction: the
// matched runtime tag and its display glyph, sourced from the package's
// `plurnk.runtimes[]` entry.
export interface ExecutorMetadata {
    runtime: string;
    glyph: string;
}

// Arguments passed to `BaseExecutor.run()`. The executor is handed sinks —
// never the db, subscription registry, AbortController bridging, or
// wake-on-completion machinery, all of which stay in the consuming scheme
// (service#174). The executor writes output, drives channel state, emits
// telemetry, and honors `signal`.
export interface ExecArgs {
    // The matched runtime tag. Multi-tag executors branch on it (e.g. the
    // search sibling maps `news`/`images` → SearXNG `categories=`).
    runtime: string;
    // The EXEC op body: a shell line, source to interpret, or a search query.
    command: string;
    // Process working directory — the session workspace. Filesystem-touching
    // runtimes resolve relative paths (including `target`) against it; subprocess
    // runtimes spawn in it. null for logical runtimes (search) that touch no
    // filesystem.
    cwd: string | null;
    // The parsed EXEC `(target)` slot — a referenced resource, interpreted
    // **per-runtime** (plurnk-execs#15). Each executor maps `(target, command)`
    // onto its own tool's CLI; the framework passes both raw and parses neither:
    //   - a *data* runtime reads `target` as the input and `command` as the
    //     program — jq `(file):filter`, sqlite `(db):SQL`, wasm `(module):…`;
    //   - an *executable* runtime runs `target` as the program and `command` as
    //     its **stdin** — sh `(cmdline):stdin`, python `(script):stdin`.
    // Resolved relative to `cwd`; null when the op names none (bare
    // `EXEC[sh]:…`, inline `EXEC[jq]:…`, `:memory:` sqlite). Kept distinct from
    // `cwd` so a runtime receives BOTH the workspace and the slot.
    target: string | null;
    // Environment for runtimes that spawn a child process. When set, the child
    // gets EXACTLY this env — the consumer scopes out its own secrets (provider
    // keys, PLURNK_*) so a model-directed `printenv` can't read them
    // (plurnk-execs#8). When omitted, the child inherits the host process env
    // (back-compat default). Ignored by in-process runtimes that don't spawn.
    env?: NodeJS.ProcessEnv;
    // Cancellation. Executors must abort in-flight work when this fires.
    signal: AbortSignal;
    // Write a chunk to one of the executor's declared channels. The optional
    // `mimetype` stamps the channel with the REAL per-call output type
    // (`application/json`, `text/markdown`, …); the consumer retypes the channel
    // to it — the channel's declared mimetype is only the pre-fetch seed. The
    // consumer's output-stream index/slicer (service#240) dispatches on this, so
    // an executor whose output type is known or varies per call (sqlite → JSON,
    // an MCP tool → whatever it returns) stamps it; omit it and the channel keeps
    // its declared seed.
    write: (channel: string, chunk: string, mimetype?: string) => void;
    // Transition a declared channel's lifecycle state.
    setState: (channel: string, state: ChannelState) => void;
    // Emit a telemetry/error event. The scheme routes it to the engine's
    // telemetry buffer (service#174 Q3).
    emit: (event: TelemetryEvent) => void;
}

// Terminal result of a `run()`. `status` follows the scheme's close-status
// convention (200 ok / 499 aborted / 500 error). `exitCode` is present only
// for the subprocess family.
export interface ExecResult {
    status: number;
    exitCode?: number;
}

// Side-effect class of an executor invocation, for the consumer's per-runtime
// proposal-gating policy (service#182). The executor declares the *fact*; the
// consumer owns the *policy* (effect → propose/auto map, deployment-tunable):
//   - host  : runs code / mutates the host (subprocess, file-backed sqlite) → propose
//   - read  : observes external state, no host mutation (search)            → auto
//   - pure  : no observable side effect (sqlite :memory:, transforms)        → auto
export type Effect = "pure" | "read" | "host";

// Environment availability of a runtime, reported by `BaseExecutor.probe()`.
// The consumer probes once at boot (per package, not per tag) and offers the
// model only the available runtimes; `detail` is model-facing — it rides the
// 501 reason for a deliberate attempt at an unavailable runtime, so keep it
// terse and actionable ("python3 not on PATH").
export interface RuntimeAvailability {
    available: boolean;
    detail?: string;
}

// One discovered runtime tag and the package that provides it.
export interface ExecInfo {
    runtime: string;
    glyph: string;
    // A one-line, self-documenting usage example for this tag, surfaced verbatim
    // in the consumer's `# Plurnk System Tools` capability sheet so the model
    // sees the syntax + what the tag does without a separate prose description
    // (e.g. `EXEC[search]:france population:EXEC`). Empty when the manifest
    // entry omits it. Kept to one line — the hot-path sheet is token-sensitive;
    // the generic `(target)` slot is documented once at the op level, not here.
    example: string;
    // Full markdown documentation for this tag — the flags, modes, and gotchas
    // the one-line `example` can't carry. The depth a consumer can serve on
    // demand, separate from the always-on `example` (progressive disclosure).
    // Empty when omitted. execs owns this field; HOW it reaches the model is the
    // consumer's concern, not specified by the contract.
    documentation: string;
    packageName: string;
    // Raw `plurnk.attribution` (string | string[]) from the package's manifest —
    // the credit a consumer unions onto the model call when this package's tags
    // are active (plurnk-service#249). Package-level: every tag of a package
    // carries the same value. `undefined` when the package omits it. Surfaced
    // raw — the consumer owns the reservation policy (e.g. `@plurnk/`-scoped
    // attribution only from `@plurnk/` packages).
    attribution?: string | string[];
}

// One runtime-tag declaration — the shape of a static `plurnk.runtimes[]`
// manifest entry, and the element type a dynamic runtimes hook returns. `name`
// is the tag; the rest are the optional manifest fields discover() surfaces
// onto ExecInfo (a per-tag `docs/<tag>.md` file, when present, still wins over
// an inline `documentation`).
export interface RuntimeDecl {
    name: string;
    glyph?: string;
    example?: string;
    documentation?: string;
}

// A dynamic runtimes hook. A package that can't enumerate its tags at publish
// time — the MCP bridge is the motivating case, its tags are the per-deployment
// servers an operator configures in the environment (plurnk-execs#10) —
// declares `plurnk.runtimesModule` (a path, relative to the package dir) INSTEAD
// of a static `plurnk.runtimes[]`, pointing at a module whose `runtimes` export
// (or default export) is this function. discover() imports and calls it at scan
// time, but only AFTER the trust gate — an untrusted package's hook is never
// executed. The hook reads its own config from the environment and returns the
// same decls a static manifest would. Throwing is FAIL-HARD: a declared but
// broken hook is a trusted-package contract violation, surfaced not swallowed
// (unlike a malformed third-party package.json, which discover() skips).
export type RuntimesHook = () => RuntimeDecl[] | Promise<RuntimeDecl[]>;

// Runtime tag → provider. Tags are a flat global namespace; collisions are a
// fail-hard install error (see discover()).
export type ExecRegistry = ReadonlyMap<string, ExecInfo>;

export interface Discovery {
    registry: ExecRegistry;
    // Installed exec packages skipped by the PLURNK_PLUGINS_TRUSTED_ONLY trust
    // gate (untrusted third-party): discovered but NOT registered. discover()
    // never crashes on an untrusted package — it returns them here so the
    // consumer can emit a telemetry note (discover() has no sink of its own).
    skipped: string[];
}

export interface DiscoverOptions {
    // Scan root; defaults to `process.cwd()`. The scan target is
    // `<cwd>/node_modules/@plurnk/`.
    cwd?: string;
    // Explicit package directories, bypassing the node_modules scan (tests,
    // unusual layouts).
    packageDirs?: string[];
}

// --- Subprocess-family helper (legacy path; see module header) -------------

export interface SpawnArgs {
    /** Command to invoke (e.g. "node", "python3", or — when useShell — the raw command). */
    cmd: string;
    /** Args passed to the command. */
    args: string[];
    /** When true, the command is interpreted as a shell line (cmd is the whole line, args ignored). */
    useShell: boolean;
    /**
     * When set, written to the child's stdin which is then closed. For filter-style
     * runtimes that read their program/input from stdin (`bc`, `tclsh`) or that need
     * EOF with no input (`awk` BEGIN-only). Omitted = stdin left at its default.
     */
    stdin?: string;
}

/**
 * Translate a runtime tag + command string into spawn args for `node:child_process.spawn`.
 *
 * Runtimes:
 *   - `""` / `"sh"` / `"bash"`           → shell-mode invocation of the command
 *   - `"node"`                          → `node -e <command>`
 *   - `"python"` / `"python3"`          → `python3 -c <command>`
 *   - any other (unknown) runtime tag    → conservative `<runtime> -c <command>` fallback
 *
 * Consumers check `isKnownRuntime(runtime)` before calling to enforce a 501 boundary
 * on unconfigured runtimes; this function never throws.
 */
export type RuntimeResolver = (runtime: string, command: string, target?: string | null) => SpawnArgs;
