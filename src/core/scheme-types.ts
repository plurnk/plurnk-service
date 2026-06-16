// Per-call scheme context (DB-coupled). Framework-grade types
// (SchemeManifest, SchemeFlagAffinity, WriterTier, LoopFlags) re-export from
// the in-tree ./types.ts and ./results.ts — folded in from the former
// @plurnk/plurnk-schemes daughter; the uniform contract belongs in the service.

import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { StreamEventNotify, WakeRunNotify, InjectRunNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "./types.ts";
import type { TelemetryEvent } from "./results.ts";

// Re-export framework types so existing imports of `scheme-types.ts`
// keep working without callers needing to know the new origin.
export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "./types.ts";
export { DEFAULT_LOOP_FLAGS } from "./types.ts";

// Shared read-result shape for the in-tree read schemes (Log/File); de-dups the
// per-scheme local copies. `error`/`reason` are optional — set by schemes that
// surface a not-found / denial; matchers fill startLine/matches.
export type SchemeReadResult = {
    status: number;
    content: string | null;
    mimetype: string | null;
    error?: string;
    reason?: string;
    startLine?: number | null;
    matches?: number | null;
};

// Per-call helper. Engine constructs a fresh ctx for every op invocation.
// PlurnkSchemeContext stays in plurnk-service because it carries `db` (the
// concrete Db type) and the notifier hooks.
//
// PR-2 (schemes 0.3.0, ctx.ts) ships the DB-free capability contract —
// SchemeCtx + entries/channels/tags/notify/subscriptions caps — as INTERFACES
// only, so a third-party `@plurnk/plurnk-schemes-*` sibling never has to touch
// db. plurnk-service injects the db-backed impl behind that seam
// (`core/caps/Db*Caps.ts`), one cap at a time, over the same
// _entry-*/ChannelWrite helpers the in-tree schemes use during transition.
// All five caps are wired in SchemeCtxImpl (#180 met) and plurnk-schemes-http
// validates the seam end-to-end; the in-tree schemes still read ctx.db, so
// migrating them onto the caps is the remaining (non-blocking) transition.
// `visibility` is dropped — entry visibility is gone post-teardown
// (OPEN/FOLD is log-only). crossScheme stays the deferred stub until a
// cross-scheme COPY/MOVE forces the FROM/TO shape.
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
    // Start/deliver-to a sister run — the run:// op family's loop-start primitive
    // (spawn/fork/irc). Engine-populated (daemon-wired to Daemon.inject); absent
    // in bare test fixtures. The run scheme handler fail-hards if absent rather
    // than silently dropping a spawn/irc.
    readonly injectRun?: InjectRunNotify;
    readonly mimetypes?: Mimetypes;
    // Boot-discovered runtime executors (tag → probe/effect/run). Engine-
    // populated; absent in bare test fixtures. Exec dispatch fail-hards if
    // absent rather than silently falling back to a default runtime.
    readonly executors?: ExecutorRegistry;
    // Write-time tokenizer (SPEC §tokenomics). Synchronous per the provider
    // contract (§provider-surface). Engine populates it from its configured tokenizer;
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
    // notification. SPEC §telemetry.
    readonly pushTelemetry?: (event: TelemetryEvent) => void;
}
