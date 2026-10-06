// {§executor-module-slice} — what a daemon module contributes to the executor family: runtimes, each
// an executor with its declaration, availability and optional scheme facet. The base module
// contract is `@plurnk/plurnk-modules` ({§module-seam-slices}).
import type { RuntimeSchemeFacet, SchemeManifest } from "@plurnk/plurnk-schemes";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecInput,
    ExecPreparation,
    ExecResult,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimeToolRegistry,
} from "./types.ts";

// The executor surface a host binds to: the contract, not the framework's class identity. Under
// {§executor-scheme-output} the executor is also the scheme face for its output, so it exposes
// `manifest` (named by its tag) and `defaultChannel`.
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
    // ({§executor-probe}). Optional and ignore-safe.
    probe(signal?: AbortSignal): Promise<RuntimeAvailability>;
    // One pure classification of the consumer-canonical logical target
    // ({§executor-effect}); authored body text is never an admission input.
    effect(target: string | null): Effect;
    toolRegistry?(): RuntimeToolRegistry;
}

// One runtime a module contributes, published under its namespace owner ({§plugin-namespace-arbitration}).
export interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}
