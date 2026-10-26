// Core-internal operation context. Public scheme handlers receive the
// DB-independent SchemeCtx from @plurnk/plurnk-schemes; this shape remains for
// daemon orchestration and the bundled adapters that own core lifecycle state.

import type { Db } from "./Db.ts";
import type HostPaths from "./HostPaths.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type ResourceBindings from "./ResourceBindings.ts";
import type { ResourceCaps, MessageCaps } from "@plurnk/plurnk-schemes";
import type { StreamEventNotify, WakeSessionNotify, InjectSessionNotify } from "./ChannelWrite.ts";
import type { WriterTier } from "./types.ts";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    Notice,
} from "@plurnk/plurnk-contracts";

// Re-export framework types so existing imports of `scheme-types.ts`
// keep working without callers needing to know the new origin.
export type {
    SchemeManifest,
    WriterTier,
} from "./types.ts";

// Engine constructs this context for its own orchestration. SchemeCtxImpl
// projects it into the public capability contract before invoking an extension.
// Core-owned adapters receive their daemon dependencies separately; this type
// must not escape as an extension API.
// {§membership-auto-add} — the model's universe beyond membership, and the admission a read earns.
// {§membership-auto-add} — a READ or text FIND that reached untracked files proposes their admission: a 202
// the proposal lifecycle settles, whose acceptance admits the files and re-runs the operation.
export type AdmissionProposal = {
    readonly status: 202;
    readonly body: string;
    readonly attrs: { readonly effect: "host"; readonly admission: { readonly files: readonly string[] } };
};

export interface AmbientMembers {
    // Untracked, unignored, unexcluded files under a literal root-relative prefix; none is a member yet.
    candidates(prefix: string | null): Promise<string[]>;
    // The admission proposal for the candidates among these keys, or null when none is a candidate.
    propose(keys: readonly string[]): Promise<AdmissionProposal | null>;
    // Admit these as the Session's own member definitions; the keys admitted come back, with a notice each.
    admit(keys: readonly string[]): Promise<string[]>;
    // A candidate's text for matching and listing only, never stored; `content` is null when it is
    // binary or larger than the matching ceiling.
    text(key: string): Promise<{ content: string | null; mimetype: string } | null>;
}

export interface PlurnkSchemeContext {
    readonly db: Db;
    readonly hostPaths?: HostPaths;
    readonly ambientMembers?: AmbientMembers;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly resourceBindings?: ResourceBindings;
    readonly resources?: ResourceCaps;
    readonly replyToMessage?: MessageCaps["reply"];
    readonly loopId: number;
    readonly turnId: number;
    // The dispatching operation's sequence in its turn: with turnId, the row it writes. Absent outside a dispatch.
    readonly sequence?: number;
    // {§log-mutation-patch} — the operation row an accepted application settles; a scheme keeps what
    // it did (its diff) on that row. Absent outside proposal application.
    readonly logEntryId?: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    // {§actor-boundary-client-operations} — present on a person's client operation: the session whose log its
    // `log:///` addresses read, or null when the person acts for none.
    readonly client?: { readonly contextSessionId: number | null };
    // {§file-delete-revision}: a selected file revision survives composed mutations and approval.
    readonly fileRevision?: string;
    readonly streamEventNotify?: StreamEventNotify;
    readonly wakeSessionNotify?: WakeSessionNotify;
    // Start/deliver-to a sister session — the session:// op family's loop-start primitive
    // (spawn/fork/irc). Engine-populated (daemon-wired to Daemon.inject); absent
    // in bare test fixtures. The session scheme handler fail-hards if absent rather
    // than silently dropping a spawn/irc.
    readonly injectSession?: InjectSessionNotify;
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
    // {§relation-indexed-dialects} — settle the workspace's derivation pump so an indexed
    // dialect answers from a complete index instead of refusing; absent in bare fixtures.
    readonly settleDerivations?: () => Promise<void>;
    // Push a transient Notice. The engine drains it into the next packet's
    // Notices section and broadcasts it through `notice/event`.
    readonly pushNotice?: (notice: Notice) => void;
    // {§owner-interaction-ring} — the asking session's face of the shared reserved tree. Absent in
    // bare fixtures, which register no interaction runtime to hide.
    readonly referenceVisibility?: () => Promise<(pathname: string) => boolean>;
    // Standard client-owned interaction, bound to this exact operation by
    // Engine. Public handlers receive it through SchemeCtx.interactions.
    readonly requestInteraction?: (
        request: ClientInteractionRequest,
        signal?: AbortSignal,
    ) => Promise<ClientInteractionResolution>;
}
