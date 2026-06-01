// Per-call scheme context (DB-coupled). Framework-grade types
// (SchemeManifest, SchemeFlagAffinity, WriterTier, LoopFlags) re-export
// from @plurnk/plurnk-schemes so plurnk-service stays the single import
// point for in-tree schemes.

import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { StreamEventNotify, WakeRunNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "@plurnk/plurnk-schemes";
import type { TelemetryEvent } from "@plurnk/plurnk-schemes";

// Re-export framework types so existing imports of `scheme-types.ts`
// keep working without callers needing to know the new origin.
export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "@plurnk/plurnk-schemes";
export { DEFAULT_LOOP_FLAGS } from "@plurnk/plurnk-schemes";

// Per-call helper. Engine constructs a fresh ctx for every op invocation.
// PlurnkSchemeContext stays in plurnk-service because it carries `db`
// (the concrete Db type) and the notifier hooks. A future v1 namespaced
// surface (entries / channels / visibility / tags / subscriptions /
// proposals / crossScheme / notify) moves to plurnk-schemes when
// third-party plugin schemes are an actual concern.
export interface PlurnkSchemeContext {
    readonly db: Db;
    readonly sessionId: number;
    readonly runId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly streamEventNotify?: StreamEventNotify;
    readonly wakeRunNotify?: WakeRunNotify;
    readonly mimetypes?: Mimetypes;
    // Write-time tokenizer (SPEC §14.2). Synchronous per the provider
    // contract (§2.1). Engine populates it from its configured tokenizer;
    // the entry/log write helpers count content tokens through it at write
    // time and store the count on entry_channels.tokens / log_entries.tokens.
    // Optional like the other engine-populated capabilities (absent in bare
    // test fixtures) — the write helpers fail-hard if a write is attempted
    // without it rather than silently storing 0.
    readonly tokenize?: (text: string) => number;
    // Push a TelemetryEvent into the loop's telemetry buffer. Closes over
    // sessionId + loopId so the scheme just provides the event payload.
    // Wired by Engine to #pushTelemetry → fans out to the next packet's
    // user.telemetry.errors[] AND the live `telemetry/event` client
    // notification. SPEC §15.1.
    readonly pushTelemetry?: (event: TelemetryEvent) => void;
}
