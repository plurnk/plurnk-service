// Shared types for the scheme extension surface. See SCHEMES.md.

export type WriterTier = "model" | "client" | "system" | "plugin";

export interface SchemeFlagAffinity {
    readonly excludedInAsk?: boolean;        // scheme excluded when mode === "ask"
    readonly requiresWeb?: boolean;           // scheme excluded when noWeb
    readonly requiresInteraction?: boolean;   // scheme excluded when noInteraction
    readonly proposes?: boolean;              // scheme excluded when noProposals
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

export const DEFAULT_LOOP_FLAGS: LoopFlags = {
    mode: "act",
    yolo: false,
    noWeb: false,
    noInteraction: false,
    noProposals: false,
};
