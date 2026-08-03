import { OutputScheme } from "@plurnk/plurnk-schemes";
import type { SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, ExecutorMetadata, RuntimeAvailability } from "./types.ts";

// Base class for runtime executors (parallel to plurnk-mimetypes' BaseHandler).
// A `@plurnk/plurnk-execs-*` sibling subclasses this and implements `run()`.
// The framework instantiates one executor per matched runtime tag, injecting
// the tag + glyph from the package's `plurnk.runtimes[]` manifest entry.
//
// The consuming scheme owns all I/O and lifecycle machinery (db, channels,
// subscriptions, AbortController bridging, wake-on-completion). The executor
// receives sinks via ExecArgs and nothing more — it stays stateless across
// runs beyond its construction metadata ({§executor-role}).
export default abstract class BaseExecutor implements SchemeHandler {
    readonly runtime: string;
    readonly glyph: string;

    constructor({ runtime, glyph }: ExecutorMetadata) {
        this.runtime = runtime;
        this.glyph = glyph;
    }

    // Output addressing: the executor produces and the consumer reads
    // ({§executor-output-address}).
    // The executor is a PRODUCER. Its output streams (via run()'s write/setState)
    // into a consumer-held log entry addressed at `<tag>://<coord>`; every READ /
    // FIND over that entry is the consumer's uniform machinery, identical across
    // every tag. The executor's only scheme-facing job is to
    // DECLARE the output scheme's manifest — derived from the runtime decl via
    // schemes' `manifestFromRuntime`, which is the sole reason it conforms to
    // SchemeHandler. It serves no read: BaseExecutor implements no read/find and
    // none is wired downstream — no sibling overrides them, and orientation is
    // model-pulled (the model queries the entry), never an executor-built digest.
    get manifest(): SchemeManifest {
        return OutputScheme.manifestFromRuntime({
            name: this.runtime,
            glyph: this.glyph,
            channels: Object.fromEntries(
                Object.entries(this.channels).map(([name, decl]) => [name, decl.mimetype]),
            ),
            defaultChannel: this.defaultChannel,
        });
    }

    // The channel a bare `READ <tag>://<coord>` resolves to. Defaults to the
    // first declared channel; subprocess runtimes override to `stdout`.
    get defaultChannel(): string {
        return Object.keys(this.channels)[0] ?? "";
    }

    // Channels this executor writes to. The consuming scheme seeds the exec
    // entry from this declaration ({§executor-channels}): subprocess runtimes
    // declare `{ stdout, stderr }`; the search sibling declares `{ results }`.
    // Implemented as a getter so executors may branch on `this.runtime` when a
    // tag dictates a different shape; most return a constant map.
    abstract get channels(): Readonly<Record<string, ChannelDecl>>;

    // Execute the command. Write output to the declared channels via
    // `args.write`, drive their lifecycle via `args.setState`, emit transient
    // observations via `args.emit`, and honor `args.signal`. Resolve with the
    // universal operation result; every expected runtime failure carries an
    // RFC 9457 Problem and never relies on a Notice for failure truth.
    abstract run(args: ExecArgs): Promise<ExecResult>;

    // Whether this runtime's execution environment is usable in the current
    // deployment. Default: available (pure / in-process runtimes — e.g. node,
    // sqlite, where the daemon itself satisfies the dependency). Subclasses
    // that depend on an external binary or external config override.
    //
    // The consumer probes once at boot, per runtime tag, runs probes concurrently
    // under a per-probe timeout, and caches the result. Unlike `run()`, this
    // MAY reject — the consumer treats a rejection as `{ available: false }` —
    // but returning a crafted `{ available: false, detail }` for an expected
    // miss gives a better model-facing reason than a raw error.
    //
    // `signal` carries the consumer's per-probe deadline/cancellation. An
    // override that spawns a child (or opens a connection) MUST hand it to that
    // child so a resolved or timed-out probe REAPS it at once — otherwise an
    // in-flight `--version` write can EPIPE after the host tears down
    // ({§executor-probe}). Optional and ignore-safe: a probe that spawns nothing
    // needs nothing.
    async probe(_signal?: AbortSignal): Promise<RuntimeAvailability> {
        return { available: true };
    }

    // Side-effect class of an invocation against `target` (the parsed EXEC
    // `(target)` slot — the same value run() receives as `args.target`), for the
    // consumer's proposal-gating
    // policy ({§executor-effect}). MUST be pure, synchronous, and cheap — it runs on
    // the dispatch hot path at propose time: classify the target only, NEVER
    // the command (parsing SQL/shell to judge intent is a sandbox-escape
    // footgun). Default `host` is the conservative, fail-safe end — anything we
    // can't classify is treated as host code-execution and proposed.
    effect(_target: string | null): Effect {
        return "host";
    }
}
