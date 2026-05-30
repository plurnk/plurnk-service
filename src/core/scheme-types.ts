// Per-call scheme context (DB-coupled). Framework-grade types
// (SchemeManifest, SchemeFlagAffinity, WriterTier, LoopFlags) re-export
// from @plurnk/plurnk-schemes so plurnk-service stays the single import
// point for in-tree schemes.

import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { StreamEventNotify, WakeRunNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "@plurnk/plurnk-schemes";

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
}
