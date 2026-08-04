// Derive an output-scheme manifest from an executor's per-tag runtime
// declaration — the executor-is-a-scheme RFC (schemes#20 / service#240). An
// executor authors NO SchemeManifest: its `plurnk.runtimes[]` entry already
// carries name / example / output-channels, and everything else is the shared
// read-only-output default. So `EXEC[sh]` gets `sh://` for free, and a multi-tag
// executor (search/news/images) derives a distinct manifest per tag.

import type { SchemeManifest } from "./types.ts";

// The slice of an executor's runtime declaration the scheme face needs. Mirrors
// its address, teaching, and output-channel shape; executor presentation stays
// on the executor surface.
export interface RuntimeDecl {
    readonly name: string;                       // the tag → the scheme's URI prefix
    readonly example?: string;
    readonly channels: Record<string, string>;   // output channel → seed mimetype
    readonly defaultChannel: string;
}

export default class OutputScheme {
    // The read-only-output default. An executor-scheme is a read-VIEW over
    // produced output: model never writes it (`writableBy: ["plugin"]`), it
    // re-runs to new output (`volatile`), it lives folded off the ranked surface
    // (`foldedByDefault`), and its body is `data`, not control/logging. The
    // per-call output mimetype overrides the channel seed at stream time
    // (`notifyChunk` mimetype) — the declared channels here are placeholders.
    static manifestFromRuntime(decl: RuntimeDecl): SchemeManifest {
        return {
            name: decl.name,
            channels: decl.channels,
            defaultChannel: decl.defaultChannel,
            category: "data",
            writableBy: ["plugin"],
            volatile: true,
            modelVisible: true,
            folderScopes: true,
            foldedByDefault: true,
            example: decl.example,
        };
    }
}
