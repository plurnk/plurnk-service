// Shared types for the scheme extension surface. See SCHEMES.md.

import type { Db } from "./Db.ts";
import type { StreamEventNotify, WakeRunNotify } from "./ChannelWrite.ts";

export type WriterTier = "model" | "client" | "system" | "plugin";

// Per-call helper. Engine constructs a fresh ctx for every op invocation.
// SCHEMES.md §4 describes a richer namespaced surface (entries / channels /
// visibility / tags / subscriptions / proposals / crossScheme / notify); v0
// bundles the per-call params into a flat struct. The namespaced API lands
// in v1 when third-party plugin schemes are an actual concern.
export interface PlurnkSchemeContext {
    readonly db: Db;
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    // Optional `stream/event` notifier. Daemon-constructed engines wire
    // this to broadcast to WS clients; bare engines (intg tests) leave it
    // undefined and channel writes happen silently. Schemes pass this
    // straight to appendToChannel / setChannelState.
    readonly streamEventNotify?: StreamEventNotify;
    // Optional wake-on-completion notifier. Streaming schemes (exec, future
    // SSE/WS) call this when a subscription closes. Daemon decides whether
    // to actually open a new loop based on engine state (active-loop check).
    // intg tests can pass a stub to assert the call payload.
    readonly wakeRunNotify?: WakeRunNotify;
}

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
