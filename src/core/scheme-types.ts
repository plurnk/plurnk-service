// Shared types for the scheme extension surface. See SCHEMES.md.

export type WriterTier = "model" | "client" | "system" | "plugin";

export interface SchemeManifest {
    readonly name: string;
    readonly channels: Record<string, string>;  // channel name → mimetype; empty = dynamic per-call
    readonly defaultChannel: string;             // empty when channels is empty
    readonly category: "data" | "logging";
    readonly scope: "agent" | "session";
    readonly writableBy: ReadonlyArray<WriterTier>;
    readonly volatile: boolean;
    readonly modelVisible: boolean;
}
