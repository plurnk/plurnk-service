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
    // data: entry-bearing content. logging: log:// rows. control: addresses
    // sister processes/runs and owns no entries (worker://: spawn/fork/irc).
    readonly category: "data" | "logging" | "control";
    // Matches grammar's SchemeRegistration.default_scope enum (0.67: `agent`
    // dropped — nothing used it — `worker` added for per-worker scratch backing
    // `worker://`). New schemes default `workspace`; opt into `worker` only for per-worker.
    readonly scope: "workspace" | "worker";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
    // A trailing slash on READ denotes a collection scope only when declared.
    // Explicit globs and matcher bodies remain queries everywhere. Absent/false
    // means `/` is ordinary resource syntax and dispatches directly.
    readonly folderScopes?: boolean;
    // Entries land FOLDED, off the ranked manifest surface (READable by address,
    // not poured into the ranked view). Absent/false → first-class ranked.
    // Full contract + containment rationale: SPEC §manifest (foldedByDefault).
    readonly foldedByDefault?: boolean;
    readonly flags?: SchemeFlagAffinity;
    // Self-doc, mirroring the exec contract: terse pushes, depth pulls (#25).
    // example = terse hot-path usage line (rendered every turn); documentation =
    // deep doc the consumer materializes as a pull-able plurnk://docs/<name>.md;
    // glyph = display icon (consumer renders `glyph ?? name`). Field-by-field
    // contract: SPEC §manifest-self-doc.
    readonly example?: string;
    readonly documentation?: string;
    readonly glyph?: string;
    // Value persisted to `entries.scheme`, which may legitimately differ from the
    // addressing `name`. Resolution: `storedScheme === undefined ? name :
    // storedScheme`; explicit `null` persists BARE (File: bare paths, scheme
    // NULL, routing name "file"). Full contract: SPEC §manifest (storedScheme).
    readonly storedScheme?: string | null;
}

export interface LoopFlags {
    readonly mode: "ask" | "act";
    readonly auto: boolean;
    readonly noWeb: boolean;
    readonly noInteraction: boolean;
    readonly noProposals: boolean;
}

export const DEFAULT_LOOP_FLAGS: LoopFlags = Object.freeze({
    mode: "act",
    auto: false,
    noWeb: false,
    noInteraction: false,
    noProposals: false,
});
