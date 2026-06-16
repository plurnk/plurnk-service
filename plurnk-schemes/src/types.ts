// Framework-grade types shared by every `@plurnk/plurnk-schemes-*` sibling
// and its consumer (plurnk-service).
//
// Notably absent from this surface: `PlurnkSchemeContext`. The full per-call
// context shape (which includes the database handle, channel-write notifier,
// wake-on-completion notifier, etc.) is plurnk-service-coupled and lives
// in the consumer. Sister schemes consume the parts of ctx the engine
// supplies them per dispatch; this repo ships only the manifest + flag
// types every sibling needs to declare itself.

export type WriterTier = "model" | "client" | "plurnk" | "plugin";

export interface SchemeFlagAffinity {
    readonly excludedInAsk?: boolean;        // excluded when mode === "ask"
    readonly requiresWeb?: boolean;           // excluded when noWeb
    readonly requiresInteraction?: boolean;   // excluded when noInteraction
    readonly proposes?: boolean;              // excluded when noProposals
}

export interface SchemeManifest {
    readonly name: string;                       // addressing/routing identity (the URI prefix)
    readonly channels: Record<string, string>;  // channel name → mimetype; empty = dynamic per-call
    readonly defaultChannel: string;             // empty when channels is empty
    readonly category: "data" | "logging";
    readonly scope: "agent" | "session";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
    readonly flags?: SchemeFlagAffinity;
    // Self-doc for the model's packet listing. Terse by design — DEEP docs do
    // NOT live here; they are a markdown the model reads on demand at
    // `plurnk://schemes/<name>.md` (the consumer serves it). Keep the manifest a
    // one-line teaser; the prose lives in the doc.
    //   example — one self-documenting usage line, surfaced verbatim, MAY carry
    //     a short trailing explanation after the snippet (e.g.
    //     "READ(https://example.com/page) — fetch a URL; HTML is rendered to its
    //     final DOM"); omit it and the scheme isn't advertised with a usage
    //     line. Mirrors an execs runtime's `example`.
    //   glyph — a display icon (emoji / nerdfont). Omit it and the consumer
    //     renders the scheme `name` in its place (glyph ?? name).
    readonly example?: string;
    readonly glyph?: string;
    // The value persisted to `entries.scheme` for this scheme's rows, which can
    // legitimately differ from the addressing `name`. Resolution:
    //   storedScheme === undefined ? name : storedScheme
    // Absent → defaults to `name` (every existing manifest unchanged). An
    // explicit `null` is honored: the scheme persists BARE (e.g. File renders
    // bare paths like `src/foo.ts`; its `entries.scheme` stays NULL while its
    // routing name is `"file"`). Lets the shared entry helpers scope queries by
    // the persisted scheme. A bare-persisting sibling declares this once here
    // instead of threading `null` through every helper call site.
    readonly storedScheme?: string | null;
}

export interface LoopFlags {
    readonly mode: "ask" | "act";
    readonly yolo: boolean;
    readonly noWeb: boolean;
    readonly noInteraction: boolean;
    readonly noProposals: boolean;
}

export const DEFAULT_LOOP_FLAGS: LoopFlags = Object.freeze({
    mode: "act",
    yolo: false,
    noWeb: false,
    noInteraction: false,
    noProposals: false,
});
