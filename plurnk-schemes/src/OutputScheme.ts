// {§executor-scheme-output} Derive an output-scheme manifest from an executor's
// per-tag runtime declaration. An
// executor authors NO SchemeManifest: its `plurnk.runtimes[]` entry already
// carries name / glyph / output-channels, and everything else is the shared
// read-only-output default. So EXEC runtime `sh` gets `sh://` for free, and a multi-tag
// executor derives a distinct manifest per tag.

import type { SchemeManifest } from "./types.ts";

// The slice of an executor's runtime declaration the scheme face needs. Mirrors
// its address, presentation, teaching, and output-channel shape.
export interface RuntimeDecl {
    readonly name: string;                       // the tag → the scheme's URI prefix
    readonly glyph?: string;
    readonly channels: Record<string, string>;   // output channel → seed mimetype
    readonly defaultChannel: string;
    readonly traits?: ReadonlyArray<string>;
}

export default class OutputScheme {
    // {§executor-scheme-output}: read-only model access to plugin-produced data.
    // Per-call output mimetypes override the declared channel seeds at stream time.
    static manifestFromRuntime(decl: RuntimeDecl): SchemeManifest {
        return {
            name: decl.name,
            authority: "owner",
            channels: decl.channels,
            defaultChannel: decl.defaultChannel,
            category: "data",
            entryOwner: "resolved",
            inherit: "none",
            writableBy: ["plugin"],
            volatile: true,
            modelVisible: true,
            folderScopes: true,
            glyph: decl.glyph,
            traits: decl.traits,
        };
    }
}
