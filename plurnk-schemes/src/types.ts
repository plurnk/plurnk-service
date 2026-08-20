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
}

export interface SchemeManifest {
    readonly name: string;                       // addressing/routing identity (the URI prefix)
    readonly channels: Record<string, string>;  // channel name → mimetype; empty = dynamic per-call
    // The channel selected for an unqualified read. Dynamic-channel schemes may
    // name it without declaring a fixed mimetype; empty means no default.
    readonly defaultChannel: string;
    // data: entry-bearing content. logging: log:// rows. control: addresses
    // sister workers and owns no entries (worker://: spawn/fork/irc).
    readonly category: "data" | "logging" | "control";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
    // A trailing slash on FIND or READ denotes a collection scope only when declared.
    // Explicit globs and matcher bodies remain queries everywhere. Absent/false
    // means `/` is ordinary resource syntax and dispatches directly.
    readonly folderScopes?: boolean;
    // True only when EDIT accepts the shared textual <scope> contract. Core
    // then lowers rendered line anchors to numeric coordinates before dispatch.
    readonly textEditScopes?: boolean;
    // True when the scheme's stable textual representations publish and accept
    // shared line anchors without claiming EDIT support. textEditScopes also
    // implies this capability.
    readonly lineAnchors?: boolean;
    // Entries land FOLDED, off the ranked manifest surface (READable by address,
    // not poured into the ranked view). Absent/false → first-class ranked.
    // Full contract + containment rationale: SPEC {§manifest} (foldedByDefault).
    readonly foldedByDefault?: boolean;
    readonly flags?: SchemeFlagAffinity;
    // Self-doc: terse pushes, depth pulls ({§manifest-self-doc}).
    // example = concise hot-path operation example set; documentation =
    // deep doc the consumer materializes at worker://plurnk/skills/plurnk/<name>.md.
    // Field-by-field contract: {§manifest-self-doc}.
    readonly example?: string;
    readonly documentation?: string;
    // Opaque client presentation metadata. It is deliberately absent from
    // model-facing scheme teaching; clients choose rendering and fallback.
    readonly glyph?: string;
    // Value persisted to `entries.scheme`, which may differ from the addressing
    // `name`. Absent defaults to `name`; identity components are never null.
    readonly storedScheme?: string;
}

// Loop flags are part of the public PLURNK request/proposal contract. This
// framework re-exports their contracts-owned definition for compatibility.
export type { LoopFlags } from "@plurnk/plurnk-contracts";
export { DEFAULT_LOOP_FLAGS } from "@plurnk/plurnk-contracts";
