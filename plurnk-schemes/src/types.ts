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
    // sister processes/runs and owns no entries (run://: spawn/fork/irc).
    readonly category: "data" | "logging" | "control";
    // Matches grammar's SchemeRegistration.default_scope enum (0.67: `agent`
    // dropped — nothing used it — `run` added for per-run scratch backing
    // `run://`). New schemes default `session`; opt into `run` only for per-run.
    readonly scope: "session" | "run";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
    // Entries land FOLDED, off the ranked manifest surface, by default —
    // discoverable and READable via their address, but not poured into the
    // ranked view the model pays tokens to see. The containment invariant one
    // level up: executor-output streams (`<tag>://…`) declare this so a long run
    // of tool calls doesn't rebuild the flood the receipt exists to kill
    // (service#240). Absent/false → first-class ranked (every existing scheme).
    readonly foldedByDefault?: boolean;
    readonly flags?: SchemeFlagAffinity;
    // Self-doc, mirroring the exec contract: terse pushes, depth pulls (#25).
    //   example — the scheme's terse, HOT-PATH one-liner: it renders in the live
    //     scheme catalogue every turn, so keep it to one canonical line of usage
    //     (e.g. "READ(https://example.com/page)"). Omit → not advertised with a
    //     usage line. Mirrors an execs runtime's `example`.
    //   documentation — the DEEP doc (semantics, channels, edge cases). The
    //     consumer materializes it as a pull-able `plurnk://docs/<name>.md`
    //     entry the model READs on demand; it never hits the hot path. Keep the
    //     hot path terse (example) and let the depth pull (documentation).
    //     Mirrors `ExecInfo.documentation`.
    //   glyph — a display icon (emoji / nerdfont). Omit it and the consumer
    //     renders the scheme `name` in its place (glyph ?? name).
    readonly example?: string;
    readonly documentation?: string;
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
