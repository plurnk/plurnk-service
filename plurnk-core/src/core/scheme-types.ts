// Core-internal operation context. Public scheme handlers receive the
// DB-independent SchemeCtx from @plurnk/plurnk-schemes; this shape remains for
// daemon orchestration and the bundled adapters that own core lifecycle state.

import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { StreamEventNotify, WakeWorkerNotify, InjectWorkerNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "./types.ts";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    Notice,
} from "@plurnk/plurnk-contracts";

// Re-export framework types so existing imports of `scheme-types.ts`
// keep working without callers needing to know the new origin.
export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "./types.ts";
export { DEFAULT_LOOP_FLAGS } from "./types.ts";

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
    // Stable write-time curation weight ({§tokenomics}).
    // Engine populates it with Core's model-independent content ruler;
    // entry/log helpers store it on entry_channels.weight / log_entries.weight.
    // Optional like the other engine-populated capabilities (absent in bare
    // test fixtures) — the write helpers fail-hard if a write is attempted
    // without it rather than silently storing 0.
    readonly weigh?: (text: string) => number;
    // A scheme's default channel — the manifest keys channels by addressable URI (note 4):
    // default → the bare entry path, non-default → path#channel. Engine wires the registry;
    // absent → "body" (correct for body-default entries, e.g. test ctxs without exec).
    readonly defaultChannelFor?: (scheme: string) => string;
    // Push a transient Notice. The engine drains it into the next packet's
    // Notices section and broadcasts it through `notice/event`.
    readonly pushNotice?: (notice: Notice) => void;
    // Standard client-owned interaction, bound to this exact operation by
    // Engine. Public handlers receive it through SchemeCtx.interactions.
    readonly requestInteraction?: (
        request: ClientInteractionRequest,
    ) => Promise<ClientInteractionResolution>;
}
