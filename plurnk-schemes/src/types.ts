// Framework-grade types shared by every `@plurnk/plurnk-schemes-*` sibling
// and its consumer (plurnk-service).
//
// Notably absent from this surface: `PlurnkSchemeContext`. The full per-call
// context shape (which includes the database handle, channel-write notifier,
// wake-on-completion notifier, etc.) is plurnk-service-coupled and lives
// in the consumer. Sister schemes consume the parts of ctx the engine
// supplies them per dispatch; this repo ships only the manifest types every
// sibling needs to declare itself.

export type WriterTier = "model" | "client" | "_plurnk" | "plugin";

// URI-authority disposition for an addressed scheme. Namespace is the stable
// default for ordinary entry trees: an authored authority folds into the
// pathname. Resource preserves authority as a durable entry coordinate.
export type SchemeAuthority = "namespace" | "resource";

export interface EntryCoordinate {
    readonly authority: string;
    readonly pathname: string;
}

interface SchemeManifestBase {
    readonly name: string;                       // addressing/routing identity (the URI prefix)
    readonly authority?: SchemeAuthority;        // absent = namespace
    readonly channels: Record<string, string>;  // channel name → mimetype; empty = dynamic per-call
    // The channel selected for an unqualified read. Dynamic-channel schemes may
    // name it without declaring a fixed mimetype; empty means no default.
    readonly defaultChannel: string;
    // data: entry-bearing content. logging: log:// rows. control: addresses
    // sister workers and owns no entries (worker://: spawn/fork/irc).
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
    // True when the handler owns the opaque `{metadata}` modifier. Core
    // preserves ordered blocks but never interprets their contents.
    readonly metadataModifier?: boolean;
    // True when the scheme's stable textual representations publish and accept
    // shared line anchors without claiming EDIT support. textEditScopes implies
    // publication only where the addressed resource authorizes model writes.
    readonly lineAnchors?: boolean;
    // General policy facts consumed by CapabilitySelector.trait. The scheme
    // declares facts only; it never interprets policy or named modes.
    readonly traits?: ReadonlyArray<string>;
    // Discoverable reference material ({§manifest-self-doc}).
    readonly documentation?: string;
    // Opaque client presentation metadata. It is deliberately absent from
    // model-facing scheme teaching; clients choose rendering and fallback.
    readonly glyph?: string;
    // Value persisted to `entries.scheme`, which may differ from the addressing
    // `name`. Absent defaults to `name`; identity components are never null.
    readonly storedScheme?: string;
}

export type SchemeManifest = SchemeManifestBase & (
    { readonly category: "data" }
    | { readonly category: "logging" }
    | { readonly category: "control" }
);
