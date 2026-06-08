// Framework-grade types shared by every `@plurnk/plurnk-schemes-*` sibling
// and its consumer (plurnk-service).
//
// Notably absent from this surface: `PlurnkSchemeContext`. The full per-call
// context shape (which includes the database handle, channel-write notifier,
// wake-on-completion notifier, etc.) is plurnk-service-coupled and lives
// in the consumer. Sister schemes consume the parts of ctx the engine
// supplies them per dispatch; this repo ships only the manifest + flag
// types every sibling needs to declare itself.

export type WriterTier = "model" | "client" | "system" | "plugin";

export interface SchemeFlagAffinity {
    readonly excludedInAsk?: boolean;        // excluded when mode === "ask"
    readonly requiresWeb?: boolean;           // excluded when noWeb
    readonly requiresInteraction?: boolean;   // excluded when noInteraction
}

export interface SchemeManifest {
    readonly name: string;
    readonly channels: Record<string, string>;  // channel name → mimetype; empty = dynamic per-call
    readonly defaultChannel: string;             // empty when channels is empty
    readonly category: "data" | "logging";
    readonly scope: "agent" | "session";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
    readonly flags?: SchemeFlagAffinity;
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
