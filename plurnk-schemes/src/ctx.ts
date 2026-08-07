// Stable context for trusted `@plurnk/plurnk-schemes-*` extensions. This is a
// semantic compatibility boundary, not a sandbox: installed Node.js plugins
// already have host-process authority. The interfaces keep extension code
// independent of database schemas and private service modules while the
// consumer injects their implementation.

import type { WriterTier } from "./types.ts";
import type { EditStatement, FindStatement, ReadStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import type { MatchEvidence, SchemeResult } from "./Results.ts";
import type { EditBatchReceipt, EditBatchResult } from "./edit-receipt.ts";
// Channel streaming-lifecycle state. Metadata, not an engine gate
// (service SPEC {§channel-state}).
export type TerminalChannelState = "closed" | "errored";
export type ChannelState = "static" | "active" | TerminalChannelState;

// Entry write shape. Omitting state selects the consumer's `static` default.
export interface EntryData {
    readonly channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    readonly tags: ReadonlyArray<string>;
}

// Entry read shape. Lifecycle is part of the stored channel representation,
// not private database metadata, so successful reads never omit it.
export interface StoredEntryData {
    readonly channels: Record<string, { content: string; mimetype: string; state: ChannelState }>;
    readonly tags: ReadonlyArray<string>;
}

export type EntryOwner = "commons" | "worker";

// A client-facing address resolves to the pathname stored by this scheme and a
// semantic owner. The consumer alone lowers that owner to its persistence key.
export interface EntryAddress {
    readonly pathname: string;
    readonly owner: EntryOwner;
}

export interface EntryEditResult extends EditBatchResult {
    readonly entryId: number | null;
    readonly channel: string | null;
}

export interface EntryReadResult extends SchemeResult {
    readonly content: string | null;
    readonly mimetype: string | null;
    readonly channel: string | null;
    readonly startLine?: number | null;
    readonly region?: TextRegion;
    readonly matches?: ReadonlyArray<MatchEvidence>;
    readonly reason?: string;
    readonly awaitWorker?: string;
}

export interface EntryCatalogItem {
    readonly path: string;
    readonly seconds?: number;
    readonly tags?: ReadonlyArray<string>;
    readonly channels: Readonly<Record<string, { mimetype: string; tokens: number; lines: number }>>;
    readonly matches?: ReadonlyArray<MatchEvidence>;
}

export interface EntryMatch {
    readonly pathname: string;
    readonly matches: ReadonlyArray<MatchEvidence>;
}

export interface EntryFindResult extends SchemeResult {
    readonly content: string | null;
    readonly mimetype: string | null;
    readonly results: ReadonlyArray<EntryCatalogItem>;
    readonly itemsTokenTotal: number;
    readonly pathnames: ReadonlyArray<string>;
    readonly matches: ReadonlyArray<EntryMatch>;
    readonly omittedItems?: number;
    readonly maximumItems?: number;
}

export interface EntryOperationCaps {
    editBatch(statements: readonly EditStatement[], owner?: EntryOwner): Promise<EntryEditResult>;
    read(statement: ReadStatement, owner?: EntryOwner): Promise<EntryReadResult>;
    find(statement: FindStatement, owner?: EntryOwner): Promise<EntryFindResult>;
    send(statement: SendStatement, owner?: EntryOwner): Promise<SchemeResult>;
}

// ── entries ──────────────────────────────────────────────────────────────
// Direct storage over the scheme's own namespace plus the standard PLURNK
// entry-op implementation. A scheme may use these semantics or implement an
// op itself.
export interface EntryStorageReadResult extends SchemeResult {
    readonly entry: StoredEntryData | null;
}

export interface EntryStorageWriteResult extends SchemeResult {
    readonly created: boolean;
    readonly entryId: number | null;
}

export interface EntryCaps {
    readonly operations: EntryOperationCaps;
    read(pathname: string, owner?: EntryOwner): Promise<EntryStorageReadResult>;
    write(pathname: string, entry: EntryData, owner?: EntryOwner): Promise<EntryStorageWriteResult>;
    delete(pathname: string, owner?: EntryOwner, channel?: string): Promise<SchemeResult>;
}

// ── channels ─────────────────────────────────────────────────────────────
// Per-channel content writes + state transitions. `append` and `replace` are
// distinct because channels are append-only content stores (service SPEC: channel semantics) but
// EDIT replaces; the impl enforces which ops a channel permits. `setState`
// drives the static/active/closed/errored lifecycle the model reads between
// turns. Wraps `ChannelWrite`.
export interface ChannelCaps {
    append(pathname: string, channel: string, content: string): Promise<SchemeResult>;
    replace(pathname: string, channel: string, content: string): Promise<SchemeResult>;
    setState(pathname: string, channel: string, state: ChannelState): Promise<SchemeResult>;
}

// NOTE: there is no `visibility` capability. Entry-level SHOW/HIDE no longer
// exists in plurnk-service — the `visibility` table was removed in the
// index/visibility teardown; SHOW/HIDE now collapse/expand `log://` rows, a
// log-side concern with no entry-visibility for a scheme to set ({§capability-ctx}).
// If a sibling ever needs to influence what the model
// retains, that's a log capability, not an entry one — designed if/when forced.

// ── tags ─────────────────────────────────────────────────────────────────
// Entry-tag add/remove/list. `add`/`remove` are additive/subtractive sets
// (service SPEC: tags apply additively). Wraps `entry_tags`.
export interface TagListResult extends SchemeResult {
    readonly tags: ReadonlyArray<string>;
}

export interface TagCaps {
    add(pathname: string, tags: ReadonlyArray<string>): Promise<SchemeResult>;
    remove(pathname: string, tags: ReadonlyArray<string>): Promise<SchemeResult>;
    list(pathname: string): Promise<TagListResult>;
}

// ── notify ───────────────────────────────────────────────────────────────
// Out-of-band, between-turn signal to clients — today's `streamEventNotify`
// hook. NOT model-facing: the model is turn-based and sees channel state at
// the next boundary (service SPEC: between-turn notify). `streamEvent` is metadata-only (never
// content).
//
// There is no `wakeWorker` here. The worker wake carries subscription-close
// context (entryId / subscriptionId / exact result / scheme / summary) that
// only exists at stream completion, so it belongs to `subscriptions.close`,
// which already composites it (channel state + registry close + worker wake).
// Only streaming schemes wake a worker, and always via close; synchronous entry
// schemes return their turn and never wake ({§scheme-subscriptions}).
export interface NotifyCaps {
    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void;
}

// ── projection ───────────────────────────────────────────────────────────
// Ask the consumer's configured mimetype family for the model-facing text
// projection of acquired content. Network schemes acquire source representations; they do
// not select or instantiate the reader family. Keeping that reader capability
// on the consumer makes direct READ and executor-prefetch use the same
// configured projection instead of shipping raw HTML down one path. A returned
// object is a present projection even when content is empty; null alone means
// the requested projection is absent.
export interface ProjectedText {
    content: string;
    mimetype: string;
    sourceMimetype: string;
    projectionIdentity: string;
}

export interface ProjectionCaps {
    readable(content: string, mimetype: string): Promise<ProjectedText | null>;
    readableBytes(chunks: AsyncIterable<Uint8Array>, mimetype: string): Promise<ProjectedText | null>;
    identity(mimetype: string): Promise<string>;
    isBinary(mimetype: string): Promise<boolean>;
}

// ── subscriptions ────────────────────────────────────────────────────────
// The one retainable capability returned by subscription acquisition. It is
// still the composed AbortSignal used by existing streaming schemes, while its
// methods bound all post-return work to this exact durable subscription.
export interface StreamSubscription extends AbortSignal {
    // FUSED append-and-notify: write the chunk to the named channel AND fire
    // stream/event in one call. Optional `mimetype` retypes the channel to the
    // content's actual per-call type ({§scheme-subscriptions}).
    notifyChunk(channel: string, chunk: string, mimetype?: string): Promise<void>;

    // Settle the subscription: validate and persist the exact universal
    // operation result, set channel state, and fire the worker wake.
    close(
        result: SchemeResult,
        summary?: string,
        channelStates?: Readonly<Record<string, TerminalChannelState>>,
    ): Promise<void>;
}

// The streaming lifecycle (service SPEC: streaming). The registered-vs-content
// split is hidden here: a sibling acquires and retains one lifecycle object,
// not the consumer's persistence substrates or its per-dispatch context.
// The inherited methods are operation-scoped compatibility forwarders to the
// exact StreamSubscription returned by open; only that returned object may be
// retained after the handler returns ({§scheme-ctx-lifetime}).
export interface SubscriptionCaps extends Pick<StreamSubscription, "notifyChunk" | "close"> {
    // Register the subscription for cancel routing and return the signal the
    // sibling should await for teardown. The returned AbortSignal is the worker
    // signal COMPOSED WITH this subscription's own teardown — it fires on
    // `loop.cancel` OR local teardown (connection drop). Await this, not
    // ctx.signal (which it subsumes). `handle` is the force-cancel hook the
    // engine's cancel router invokes to tear the subscription down from
    // OUTSIDE (exec's kill handle; http's socket-abort) — the active
    // counterpart to the passive signal.
    open(pathname: string, handle: SubscriptionHandle, options?: {
        // Persist every channel the producer writes, but publish live stream
        // events only for this selected channel. A fragmentless multi-channel
        // READ passes its manifest default here; auxiliary/raw channels remain
        // implementation detail unless explicitly addressed.
        publishedChannel?: string;
    }): Promise<StreamSubscription>;
}

// The force-cancel hook a streaming scheme hands to `open`. The engine's
// cancel router invokes it to tear down from outside (SEND[499] → here).
export interface SubscriptionHandle {
    cancel(): void | Promise<void>;
}

// ── the context ──────────────────────────────────────────────────────────
// Fresh per op-call. A sibling MUST NOT retain it past the handler return
// ({§scheme-ctx-lifetime}). Identity/lifecycle fields carry the engine's per-dispatch
// coordinates; capability namespaces replace raw `db`.
export interface SchemeCtx {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    // Run-scoped abort. Streaming schemes await the composed signal from
    // `subscriptions.open` instead, which subsumes this.
    readonly signal: AbortSignal | undefined;

    readonly entries: EntryCaps;
    readonly channels: ChannelCaps;
    readonly tags: TagCaps;
    readonly notify: NotifyCaps;
    readonly projection: ProjectionCaps;
    readonly subscriptions: SubscriptionCaps;
}

// ── proposals (NOT a capability) ─────────────────────────────────────────
// A side-effecting scheme proposes by RETURNING a ProposalResult (status
// 202) from its op handler — no injected capability. The engine owns the
// resolution lifecycle (await, accept/reject, auto/noProposals auto-resolve,
// timeout) and it is invisible to the sibling: on reject the actor sees an
// ordinary 4xx, never the orchestration. The ONLY sibling-side surface is an
// optional handler hook the engine calls when a proposal is accepted. Its
// request carries the persisted scheme attrs and resolver-approved body; its
// result reports the applied outcome.
export interface ProposalApplyRequest {
    readonly attrs: object;
    readonly body?: string;
}

export interface ProposalApplyResult extends SchemeResult {
    readonly outcome?: string;
    readonly body?: string;
    readonly result?: object;
    readonly editReceipt?: EditBatchReceipt | null;
}

export interface ProposalAware {
    applyResolution(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;
}
