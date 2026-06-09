import type { ChannelDecl, Effect, ExecArgs, ExecResult, ExecutorMetadata, RuntimeAvailability } from "./types.ts";

// Base class for runtime executors (parallel to plurnk-mimetypes' BaseHandler).
// A `@plurnk/plurnk-execs-*` sibling subclasses this and implements `run()`.
// The framework instantiates one executor per matched runtime tag, injecting
// the tag + glyph from the package's `plurnk.runtimes[]` manifest entry.
//
// The consuming scheme owns all I/O and lifecycle machinery (db, channels,
// subscriptions, AbortController bridging, wake-on-completion). The executor
// receives sinks via ExecArgs and nothing more — it stays stateless across
// runs beyond its construction metadata (SPEC §5).
export default abstract class BaseExecutor {
    readonly runtime: string;
    readonly glyph: string;

    constructor({ runtime, glyph }: ExecutorMetadata) {
        this.runtime = runtime;
        this.glyph = glyph;
    }

    // Channels this executor writes to. The consuming scheme seeds the exec
    // entry from this declaration (service#174 Q1): subprocess runtimes
    // declare `{ stdout, stderr }`; the search sibling declares `{ results }`.
    // Implemented as a getter so executors may branch on `this.runtime` when a
    // tag dictates a different shape; most return a constant map.
    abstract get channels(): Readonly<Record<string, ChannelDecl>>;

    // Execute the command. Write output to the declared channels via
    // `args.write`, drive their lifecycle via `args.setState`, emit telemetry
    // on failure via `args.emit`, and honor `args.signal`. Resolve with the
    // terminal status; never throw for an expected runtime failure — surface
    // it through `emit` + an errored channel state and a non-200 `status`.
    abstract run(args: ExecArgs): Promise<ExecResult>;

    // Whether this runtime's execution environment is usable in the current
    // deployment. Default: available (pure / in-process runtimes — e.g. node,
    // sqlite, where the daemon itself satisfies the dependency). Subclasses
    // that depend on an external binary or external config override.
    //
    // The consumer probes once at boot, per package, runs probes concurrently
    // under a per-probe timeout, and caches the result. Unlike `run()`, this
    // MAY reject — the consumer treats a rejection as `{ available: false }` —
    // but returning a crafted `{ available: false, detail }` for an expected
    // miss gives a better model-facing reason than a raw error.
    async probe(): Promise<RuntimeAvailability> {
        return { available: true };
    }

    // Side-effect class of an invocation against `target` (the parsed EXEC
    // target — what run() receives as cwd), for the consumer's proposal-gating
    // policy (service#182). MUST be pure, synchronous, and cheap — it runs on
    // the dispatch hot path at propose time: classify the target only, NEVER
    // the command (parsing SQL/shell to judge intent is a sandbox-escape
    // footgun). Default `host` is the conservative, fail-safe end — anything we
    // can't classify is treated as host code-execution and proposed.
    effect(_target: string | null): Effect {
        return "host";
    }
}
