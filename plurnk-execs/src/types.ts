// Runtime executor contract. Each `@plurnk/plurnk-execs-*` sibling declares
// one or more runtime tags (`sh`, `bash`, `python`, `jq`, …) in
// its `package.json` `plurnk.runtimes[]` block, and provides a BaseExecutor
// subclass implementing the dispatch for those tags.
//
// The framework surface is `BaseExecutor.run()` + `discover()`.

import type { SchemeResult } from "@plurnk/plurnk-schemes";
import type { ClientInteractionRequest, ClientInteractionResolution } from "@plurnk/plurnk-contracts";
import type { PackageAttributions } from "@plurnk/plurnk-meta";
import type { Notice } from "./Notice.ts";

// Channel lifecycle state. Mirrors plurnk-service's per-channel state machine:
// `active` while producing, then a terminal `closed` (clean) or `errored`.
export type ChannelState = "active" | "closed" | "errored";

// A channel an executor declares it writes to ({§executor-channels}).
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
// wake-on-completion machinery, all of which stay in the consumer
// ({§executor-role}). The executor writes output, drives channel state, emits
// notices, and honors `signal`.
export interface ExecArgs {
    // The matched runtime tag. Multi-tag executors branch on it.
    runtime: string;
    // The authored EXEC body; its role comes from the runtime invocation declaration.
    body: string;
    // Process working directory — the workspace workspace. Filesystem-touching
    // runtimes resolve relative paths (including `target`) against it; subprocess
    // runtimes spawn in it. null for logical runtimes that touch no filesystem.
    cwd: string | null;
    // The parsed EXEC `(target)` slot — a referenced file or entry, interpreted
    // according to the runtime's invocation declaration. The framework has
    // already realized its declared literal/path/resource representation.
    // Resolved relative to `cwd`; null when the op names none (bare
    // shell EXEC, inline jq EXEC, and `:memory:` SQLite). Kept distinct from
    // `cwd` so a runtime receives BOTH the workspace and the slot.
    target: string | null;
    // Environment for runtimes that spawn a child process. When set, the child
    // gets EXACTLY this env — the consumer scopes out its own secrets (provider
    // keys, PLURNK_*) so a model-directed `printenv` can't read them
    // ({§exec-env-scoped}). When omitted, the child inherits the host process env
    // (back-compat default). Ignored by in-process runtimes that don't spawn.
    env?: NodeJS.ProcessEnv;
    // Cancellation. Executors must abort in-flight work when this fires.
    signal: AbortSignal;
    // Write a chunk to one of the executor's declared channels. The optional
    // `mimetype` stamps the channel with the REAL per-call output type
    // (`application/json`, `text/markdown`, …); the consumer retypes the channel
    // to it — the channel's declared mimetype is only the pre-run seed. A
    // runtime whose output type varies per call stamps it here; omission keeps
    // the declared seed ({§executor-channels}).
    write: (channel: string, chunk: string, mimetype?: string) => void;
    // Transition a declared channel's lifecycle state.
    setState: (channel: string, state: ChannelState) => void;
    // Emit a transient, nonterminal observation. The scheme routes it to the
    // engine's Notice channel; operation failures belong in the returned
    // ExecResult as RFC 9457 Problem Details.
    emit: (notice: Notice) => void;
    // Await a standard client-owned interaction. Core owns durable identity,
    // reconnect presentation, cancellation, and resolution; the executor owns
    // only its request and interpretation of the returned payload.
    interact: (request: ClientInteractionRequest) => Promise<ClientInteractionResolution>;
    // Optional materialization request ({§executor-entry-sink}). The consumer
    // owns acquisition, storage, tags, announcement, and the returned canonical
    // model-facing address. `content === null` requests consumer-sourced bytes.
    // Rejection means only that materialization failed.
    entry?: (path: string, content: string | null, opts: { tags: string[]; mimetype?: string }) => Promise<string>;
}

// Terminal result of a `run()`. The universal operation-result contract applies
// at this plugin boundary: every failure carries RFC 9457 Problem Details.
// `exitCode` is present only for the subprocess family.
export interface ExecResult extends SchemeResult {
    exitCode?: number;
}

// Side-effect class of an executor invocation, for the consumer's per-runtime
// proposal-gating policy ({§executor-effect}). The executor declares the fact; the
// consumer owns the *policy* (effect → propose/auto map, deployment-tunable):
//   - host  : runs code / mutates the host (subprocess, file-backed sqlite) → propose
//   - read  : observes external state, no host mutation                     → auto
//   - pure  : no observable side effect (sqlite :memory:, transforms)        → auto
export type Effect = "pure" | "read" | "host";

// Environment availability of a runtime, reported by `BaseExecutor.probe()`.
// The consumer probes once at boot per runtime tag and offers the
// model only the available runtimes; `detail` is model-facing — it rides the
// 501 reason for a deliberate attempt at an unavailable runtime, so keep it
// terse and actionable ("python3 not on PATH").
export interface RuntimeAvailability {
    available: boolean;
    detail?: string;
}

export interface RuntimeBodyDecl {
    readonly role: string;
    readonly required: boolean;
}

export type RuntimeTargetKind = "literal" | "path" | "resource";

export interface RuntimeTargetDecl {
    readonly role: string;
    readonly required: boolean;
    readonly kind: RuntimeTargetKind;
    readonly directory?: "cwd";
}

export interface RuntimeInvocationExample {
    readonly body?: string;
    readonly target?: string;
}

interface RuntimeInvocationShape {
    readonly body: RuntimeBodyDecl;
    readonly target?: RuntimeTargetDecl;
    readonly exclusive?: true;
}

export type RuntimeInvocation = RuntimeInvocationShape & (
    | {
        readonly example: RuntimeInvocationExample;
        readonly signature?: never;
    }
    | {
        readonly example?: never;
        readonly signature: string;
    }
);

export interface RuntimeRegisteredTool {
    readonly target: string;
    readonly summary: string;
    readonly invocation: RuntimeInvocation;
    readonly details?: string;
}

export interface RuntimeToolRegistry {
    readonly tools: readonly RuntimeRegisteredTool[];
}

// One discovered runtime tag and the package that provides it.
export interface ExecInfo {
    runtime: string;
    glyph: string;
    summary: string;
    invocation: RuntimeInvocation;
    // Supplemental Markdown for this tag. Empty when omitted. Summary and
    // Invocation remain declaration-owned and are projected by the consumer.
    details: string;
    resourcesPath?: string;
    expandTools?: boolean;
    packageName: string;
    // Published per-tag projection of the package-level attribution declaration.
    // Discovery validates it through {§plugin-attribution} before admission.
    attribution?: string | string[];
}

// One runtime-tag declaration — the shape of a static `plurnk.runtimes[]`
// manifest entry, and the element type a dynamic runtimes hook returns. `name`
// is the canonical tag from {§executor-runtime-declaration}; the rest are the
// manifest fields discover() surfaces onto ExecInfo (a per-tag
// `docs/<tag>.md` file, when present, still wins over inline details).
export interface RuntimeDecl {
    name: string;
    glyph?: string;
    summary: string;
    invocation: RuntimeInvocation;
    details?: string;
    // {§tools-resource-materialization} — the generated-doc root. Absent: the
    // internal skills namespace. Present (MCP families): the tools namespace
    // whose survey exposes every child tool.
    resourcesPath?: string;
    // Expand this runtime's complete tool tree into the turn-0 tools survey;
    // absent, turn 0 lists the family document alone.
    expandTools?: boolean;
}

// Dynamic runtime declaration hook ({§executor-dynamic-runtimes}). Discovery
// imports it only after trust admission. A declared but broken admitted hook is
// fail-hard; a malformed unrelated package manifest is merely not discovered.
export type RuntimesHook = () => RuntimeDecl[] | Promise<RuntimeDecl[]>;

// Runtime tag → provider. Tags are a flat global namespace; collisions are a
// fail-hard install error (see discover()).
export type ExecRegistry = ReadonlyMap<string, ExecInfo>;

export interface Discovery {
    registry: ExecRegistry;
    // Canonical package-level attribution; a multi-tag package appears once.
    packageAttributions: PackageAttributions;
    // Installed exec packages skipped by the PLURNK_PLUGINS_TRUSTED_ONLY trust
    // gate (untrusted third-party): discovered but NOT registered. discover()
    // never crashes on an untrusted package — it returns them here so the
    // consumer can emit a notices note (discover() has no sink of its own).
    skipped: string[];
    // Tags removed by the boot runtime policy ({§executor-policy}): declared but
    // NOT registered, returned so the consumer can note what the operator gated
    // off. Distinct from `skipped` (whole untrusted packages).
    disabled: string[];
}

export interface DiscoverOptions {
    // Scan root; defaults to `process.cwd()`. The scan target is
    // the nearest `<cwd>/node_modules`, including scoped and unscoped packages.
    cwd?: string;
    // Explicit package directories, bypassing the node_modules scan (tests,
    // unusual layouts).
    packageDirs?: string[];
}

// --- Subprocess-family spawn recipe ({§executor-subprocess}) ---------------

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
