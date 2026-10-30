// Runtime executor contract. Each `@plurnk/plurnk-execs-*` sibling declares
// one or more runtime tags (`sh`, `js`, `python3`, …) in
// its `package.json` `plurnk.runtimes[]` block, and provides a BaseExecutor
// subclass implementing the dispatch for those tags.
//
// The framework surface is `BaseExecutor.run()` + `discover()`.

import type { ChannelProducerResult, RuntimeSchemeFacet, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    ContentOffset,
    JsonSchema,
    LogCoordinate,
    Notice,
} from "@plurnk/plurnk-contracts";
import type { PackageAttributions } from "@plurnk/plurnk-meta";

export type { ContentOffset, LogCoordinate, Notice };
export type NoticeLevel = Notice["level"];

// Channel lifecycle state. Mirrors plurnk-service's per-channel state machine:
// `active` while producing, then a terminal `closed` (clean) or `errored`.
export type ChannelState = "active" | "closed" | "errored";

// A channel an executor declares it writes to ({§executor-contract}).
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
    // The authored fence body; its role comes from the runtime invocation declaration.
    body: string;
    // Ordered raw header blocks owned by this executor, never the source scheme.
    metadata: readonly string[] | null;
    // Process working directory — the workspace workspace. Filesystem-touching
    // runtimes resolve relative paths (including `target`) against it; subprocess
    // runtimes spawn in it. null for logical runtimes that touch no filesystem.
    cwd: string | null;
    // The parsed `(target)` slot — a referenced file or entry, interpreted
    // according to the runtime's invocation declaration. The framework has
    // already realized its declared literal/path/resource representation.
    // Resolved relative to `cwd`; null when the op names none (e.g., an inline
    // shell or js fence). Kept distinct from
    // `cwd` so a runtime receives BOTH the workspace and the slot.
    target: string | null;
    // Environment for runtimes that spawn a child process. When set, the child
    // gets EXACTLY this env — the consumer scopes out its own secrets (provider
    // keys, PLURNK_*) so a model-directed `printenv` can't read them
    // ({§execution-output-identity}). When omitted, the child inherits the host process env
    // (back-compat default). Ignored by in-process runtimes that don't spawn.
    env?: NodeJS.ProcessEnv;
    // Cancellation. Executors must abort in-flight work when this fires.
    signal: AbortSignal;
    // Write a chunk to one of the executor's declared channels. The optional
    // `mimetype` stamps the channel with the REAL per-call output type
    // (`application/json`, `text/markdown`, …); the consumer retypes the channel
    // to it — the channel's declared mimetype is only the pre-run seed. A
    // runtime whose output type varies per call stamps it here; omission keeps
    // the declared seed ({§executor-contract}).
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
    interact: (request: ClientInteractionRequest, signal?: AbortSignal) => Promise<ClientInteractionResolution>;
    // Optional materialization request ({§executor-output-address}). The consumer
    // owns acquisition, storage, tags, announcement, and the returned canonical
    // model-facing address. `content === null` requests consumer-sourced bytes.
    // Rejection means only that materialization failed.
    entry?: (path: string | null, content: string | Uint8Array | null, opts: { mimetype?: string; name?: string }) => Promise<string>;
}

export type ExecInput = Pick<ExecArgs, "runtime" | "body" | "metadata" | "cwd" | "target">;

// Preparation owns option validation; the consumer retains the effective cwd.
export interface ExecPreparation extends SchemeResult {
    readonly cwd?: string | null;
}

// Terminal result of a `run()`. The universal operation-result contract applies
// at this extension boundary: every failure carries RFC 9457 Problem Details.
// `exitCode` is present only for subprocess executors; `page` only when a tool result
// is a full page ({§executor-results}).
export interface ExecResult extends ChannelProducerResult {
    exitCode?: number;
    page?: { readonly size: number; readonly returned: number };
}

// Side-effect class of an executor invocation, for the consumer's per-runtime
// proposal-gating policy ({§executor-results}). The executor declares the fact; the
// consumer owns the *policy* (effect → propose/auto map, deployment-tunable):
//   - host  : runs code / mutates the host (subprocess, mutating tools)     → propose
//   - read  : observes external state, no host mutation                     → auto
//   - pure  : no observable side effect (pure transforms)                   → auto
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
    // {§executor-discovery}: the media type the body must be well-formed in, when it has one.
    readonly mimetype?: string;
}

// `script`: a resource that must be an existing local script file (or a materialized data-scheme
// address); a directory or an absent path is refused before anything spawns.
export type RuntimeTargetKind = "literal" | "path" | "resource" | "script";

export interface RuntimeTargetDecl {
    readonly role: string;
    readonly required: boolean;
    readonly kind: RuntimeTargetKind;
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
        readonly inputSchema?: never;
    }
    | {
        readonly example?: never;
        readonly signature: string;
        readonly inputSchema?: never;
    }
    | {
        readonly example?: never;
        readonly signature?: never;
        readonly inputSchema: JsonSchema;
    }
);

export interface RuntimeRegisteredTool {
    readonly target: string;
    readonly summary: string;
    readonly invocation: RuntimeInvocation;
    readonly details?: string;
    readonly definition?: Readonly<Record<string, unknown>>;
    readonly traits?: readonly string[];
}

export interface RuntimeToolRegistry {
    readonly tools: readonly RuntimeRegisteredTool[];
}

// A fixed capability description stays authored. A runtime with a finite tool registry may
// instead derive its one-line orientation from the exact effective registry,
// so policy filtering cannot leave denied tool names in model teaching.
export type RuntimeSummaryDecl = string | { readonly from: "tools"; readonly description?: string };

// One discovered runtime tag and the package that provides it.
export interface ExecInfo {
    runtime: string;
    glyph: string;
    summary: RuntimeSummaryDecl;
    invocation: RuntimeInvocation;
    // Supplemental Markdown for this tag. Empty when omitted. Summary and
    // Invocation remain declaration-owned and are projected by the consumer.
    details: string;
    resourcesPath?: string;
    packageName: string;
}

// One runtime-tag declaration — the shape of a static `plurnk.runtimes[]`
// manifest entry, and the element type a dynamic runtimes function returns. `name`
// is the canonical tag from {§executor-discovery}; the rest are the
// manifest fields discover() surfaces onto ExecInfo (a per-tag
// `docs/<tag>.md` file, when present, still wins over inline details).
export interface RuntimeDecl {
    name: string;
    glyph?: string;
    summary: RuntimeSummaryDecl;
    invocation: RuntimeInvocation;
    details?: string;
    // {§tools-resource-materialization} — the generated-doc root. Absent: the
    // internal skills namespace. Present (MCP servers): the tools namespace
    // whose survey exposes every child tool.
    resourcesPath?: string;
}

// Dynamic runtime declaration function ({§executor-discovery}). Discovery
// imports it only after trust admission. A declared but broken admitted function is
// fail-hard; a malformed unrelated package manifest is merely not discovered.
export type RuntimesFunction = () => RuntimeDecl[] | Promise<RuntimeDecl[]>;

// Runtime tag → provider. Tags are a flat global namespace; collisions are a
// fail-hard install error (see discover()).
export type ExecRegistry = ReadonlyMap<string, ExecInfo>;

export interface Discovery {
    registry: ExecRegistry;
    // Canonical package-level attribution; a multi-tag package appears once.
    packageAttributions: PackageAttributions;
    // Installed exec packages skipped by the PLURNK_EXTENSIONS_TRUSTED_ONLY trust
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

// --- Subprocess spawn recipe ({§executor-subprocess}) ----------------------

export interface SpawnArgs {
    /** Command to invoke (e.g. "node", "python3", or — when useShell — the raw command). */
    cmd: string;
    /** Args passed to the command. */
    args: string[];
    /** When true, the command is interpreted as a shell line (cmd is the whole line, args ignored). */
    useShell: boolean;
    /**
     * When set, written to the child's stdin which is then closed. Omitted = stdin left at its default.
     */
    stdin?: string;
}

// {§executor-role} — what a daemon module contributes to the exec kind: runtimes, each
// an executor with its declaration, availability and optional scheme facet. The base module
// contract is `@plurnk/plurnk-modules` ({§module-seam-slices}).
export interface Executor {
    readonly runtime: string;
    readonly glyph: string;
    get manifest(): SchemeManifest;
    get defaultChannel(): string;
    get channels(): Readonly<Record<string, ChannelDecl>>;
    readonly publishedChannel?: string | null;
    prepare?(input: ExecInput): Promise<ExecPreparation>;
    run(args: ExecArgs): Promise<ExecResult>;
    // The host aborts on resolve or timeout so probe work is reaped immediately
    // ({§executor-results}). Optional and ignore-safe.
    probe(signal?: AbortSignal): Promise<RuntimeAvailability>;
    // One pure classification of the consumer-canonical logical target
    // ({§executor-results}); authored body text is never an admission input.
    effect(target: string | null): Effect;
    toolRegistry?(workspaceId?: number): RuntimeToolRegistry;
    forContext?(workspaceId: number, sessionId: number): Executor;
}

// One runtime a module contributes, published under its namespace owner ({§core-extension-composition}).
export interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

// {§executor-role} — the seam slice for modules that register in-process runtimes or MCP tool servers at setup.
export interface RuntimeRegistrationSeam {
    registerRuntime(registration: RuntimeRegistration): void | Promise<void>;
    registerRuntimes(registrations: readonly RuntimeRegistration[]): void | Promise<void>;
}
