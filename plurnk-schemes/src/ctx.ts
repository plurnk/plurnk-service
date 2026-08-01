// Stable context for trusted `@plurnk/plurnk-schemes-*` extensions. This is a
// semantic compatibility boundary, not a sandbox: installed Node.js plugins
// already have host-process authority. The interfaces keep extension code
// independent of database schemas and private service modules while the
// consumer injects their implementation.

import type { WriterTier } from "./types.ts";
import type { EditStatement, FindStatement, ReadStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import type { MatchEvidence, SchemeResult } from "./Results.ts";
import type { EditBatchResult } from "./edit-receipt.ts";
// Channel streaming-lifecycle state (mirrors plurnk-service's ChannelState /
// grammar ChannelContent.state). Metadata, not an engine gate (service SPEC: channel lifecycle state).
export type ChannelState = "static" | "active" | "closed" | "errored";

// The full entry shape exchanged across CRUD (mirrors plurnk-service's
// EntryData). Channels keyed by name → content + pinned mimetype + state.
export interface EntryData {
    readonly channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    readonly tags: ReadonlyArray<string>;
}

export type EntryOwner = "commons" | "worker";

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
    readonly entry: EntryData | null;
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
// log-side concern with no entry-visibility for a scheme to set (per
// plurnk-service#180). If a sibling ever needs to influence what the model
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
// There is no `wakeWorker` here. The run-wake carries subscription-close
// context (entryId / subscriptionId / exact result / scheme / summary) that
// only exists at stream completion, so it belongs to `subscriptions.close`,
// which already composites it (channel state + registry close + run wake).
// Only streaming schemes wake a worker, and always via close; synchronous entry
// schemes return their turn and never wake. (plurnk-service#180.)
export interface NotifyCaps {
    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void;
}

// ── projection ───────────────────────────────────────────────────────────
// Ask the consumer's configured mimetype family for the model-facing text
// projection of acquired content. Network schemes acquire bytes/DOM; they do
// not select or instantiate the reader family. Keeping that reader capability
// on the consumer makes direct READ and executor-prefetch use the same
// configured projection instead of shipping raw HTML down one path.
export interface ProjectionCaps {
    readable(content: string, mimetype: string): Promise<{ content: string; mimetype: string } | null>;
}

// ── subscriptions ────────────────────────────────────────────────────────
// The streaming lifecycle (service SPEC: streaming). The hard namespace; designed against
// Exec (the proven two-channel, cancel-tested case — if it serves exec it
// serves http). The registered-vs-content split (registry exists only for
// cancel routing — service SPEC; channels carry lifecycle) is REAL and load-bearing
// in the impl, but HIDDEN here: a sibling sees one lifecycle, not two
// substrates.
export interface SubscriptionCaps {
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
    }): Promise<AbortSignal>;

    // FUSED append-and-notify: write the chunk to the named channel AND fire
    // stream/event in one call. Kept composite by contract — a streaming
    // sibling must never have to remember "append, then separately notify."
    //
    // Optional `mimetype` retypes the channel to the content's actual per-call
    // type. A streaming body's type is often known only at stream time (an http
    // body is JSON / PNG / HTML by response Content-Type); the manifest's
    // channel mimetype is just the pre-fetch seed default. Pass it STATELESSLY
    // on every chunk — the impl writes only when it differs from the stored
    // label, so steady-state is a no-op, and the type lands welded to the first
    // content byte (correct before any mid-stream read). Omit it and the channel
    // keeps its seeded type (exec and non-typing schemes never pass it). Welding
    // the label to the chunk is deliberate: there is no separate set-type call to
    // forget or mis-order. (plurnk-service#226.)
    notifyChunk(channel: string, chunk: string, mimetype?: string): Promise<void>;

    // Settle the subscription: validate and persist the exact universal
    // operation result, set channel state, and fire the worker wake ("stream
    // concluded" + summary). The summary is presentation; it never substitutes
    // for the structured terminal result.
    close(result: SchemeResult, summary?: string): Promise<void>;
}

// The force-cancel hook a streaming scheme hands to `open`. The engine's
// cancel router invokes it to tear down from outside (SEND[499] → here).
export interface SubscriptionHandle {
    cancel(): void | Promise<void>;
}

// ── the context ──────────────────────────────────────────────────────────
// Fresh per op-call. A sibling MUST NOT retain it past the handler return
// (SPEC §forbidden). Identity/lifecycle fields carry the engine's per-dispatch
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
}

export interface ProposalAware {
    applyResolution(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;
}
