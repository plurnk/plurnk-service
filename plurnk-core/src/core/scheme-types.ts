// Core-internal operation context. Public scheme handlers receive the
// DB-independent SchemeCtx from @plurnk/plurnk-schemes; this shape remains for
// daemon orchestration and the bundled adapters that own core lifecycle state.

import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { StreamEventNotify, WakeWorkerNotify, InjectWorkerNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "./types.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import type { PacketSection } from "./packet-wire.ts";
import type { SchemeResultBase } from "./results.ts";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";

// Re-export framework types so existing imports of `scheme-types.ts`
// keep working without callers needing to know the new origin.
export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "./types.ts";
export { DEFAULT_LOOP_FLAGS } from "./types.ts";

// Shared read-result shape for the core-owned read schemes (Log/File); de-dups the
// per-scheme local copies. Problems carry failures; matchers fill startLine/matches.
export type SchemeReadResult = SchemeResultBase & {
    content: string | null;
    mimetype: string | null;
    reason?: string;
    startLine?: number | null;
    region?: TextRegion;
    matches?: ReadonlyArray<MatchEvidence>;
    // {§join-blocking-collect} (#354) — a READ(worker://running-child) sets this to the worker name it is
    // blocked on; the dispatcher arms a join so the turn's bare SEND[102] parks (the blocking collect).
    awaitWorker?: string;
};

// Engine constructs this context for its own orchestration. SchemeCtxImpl
// projects it into the public capability contract before invoking a plugin.
// Core-owned adapters receive their daemon dependencies separately; this type
// must not escape as an extension API.
export interface PlurnkSchemeContext {
    readonly db: Db;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly streamEventNotify?: StreamEventNotify;
    readonly wakeWorkerNotify?: WakeWorkerNotify;
    // Start/deliver-to a sister worker — the worker:// op family's loop-start primitive
    // (spawn/fork/irc). Engine-populated (daemon-wired to Daemon.inject); absent
    // in bare test fixtures. The worker scheme handler fail-hards if absent rather
    // than silently dropping a spawn/irc.
    readonly injectWorker?: InjectWorkerNotify;
    readonly mimetypes?: Mimetypes;
    // Boot-discovered runtime executors (tag → probe/effect/run). Engine-
    // populated; absent in bare test fixtures. Exec dispatch fail-hards if
    // absent rather than silently falling back to a default runtime.
    readonly executors?: ExecutorRegistry;
    // Write-time tokenizer (SPEC {§tokenomics}). Synchronous per the provider
    // contract ({§provider-surface}). Engine populates it from its configured tokenizer;
    // the entry/log write helpers count content tokens through it at write
    // time and store the count on entry_channels.tokens / log_entries.tokens.
    // Optional like the other engine-populated capabilities (absent in bare
    // test fixtures) — the write helpers fail-hard if a write is attempted
    // without it rather than silently storing 0.
    readonly tokenize?: (text: string) => number;
    // A scheme's default channel — the manifest keys channels by addressable URI (note 4):
    // default → the bare entry path, non-default → path#channel. Engine wires the registry;
    // absent → "body" (correct for body-default entries, e.g. test ctxs without exec).
    readonly defaultChannelFor?: (scheme: string | null) => string;
    // Push a transient Notice. The engine drains it into the next packet's
    // Notices section and broadcasts it through `notice/event`.
    readonly pushNotice?: (notice: Notice) => void;
}

// {§scheme-packet-transform} {§packet-plugin-transform}. #73 owns removal of
// this duplicate core declaration and the draft/measured type distinction.
export interface PacketSectionTransformer {
    transformSections(sections: PacketSection[]): PacketSection[] | Promise<PacketSection[]>;
}
