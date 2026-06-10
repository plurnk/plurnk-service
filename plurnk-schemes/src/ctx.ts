// Capability context — the DB-free authoring surface for
// `@plurnk/plurnk-schemes-*` siblings (keystone PR-2; design converged on
// plurnk-service#180).
//
// PROBLEM this replaces: today a sibling receives plurnk-service's raw `Db`
// handle on `ctx.db` and reaches straight through it. SPEC §5 forbids a
// third-party scheme from importing `@plurnk/plurnk-service/*` or touching
// the database — so `ctx.db` is the contract, and it's an illegal one. A
// real sibling is therefore unbuildable.
//
// SHAPE: this module exports INTERFACES only. plurnk-service injects a
// db-backed implementation behind them (the existing `scheme-types.ts` seam,
// widened — not new machinery). In-tree schemes keep using `db` directly
// during transition; the cap impl is a thin adapter over the same
// `_entry-*.ts` / `ChannelWrite` helpers, cut over scheme-by-scheme.
//
// FIVE live namespaces decompose what `ctx.db` is used for today:
//   entries / channels / tags / notify  — map 1:1 onto the `_entry-*.ts` +
//     `ChannelWrite` helpers; wrap cleanly.
//   subscriptions                       — the streaming lifecycle
//     (open/notifyChunk/close); design against Exec, the proven
//     two-channel cancel-tested case.
// (No `visibility`: entry-level SHOW/HIDE was removed in plurnk-service's
//  index/visibility teardown — SHOW/HIDE now act on `log://` rows. #180.)
//
// NOT a namespace:
//   proposals   — collapses to "return a ProposalResult (202) + implement
//     applyResolution"; the lifecycle (await/accept/reject, YOLO/noProposals
//     auto-resolvers, timeout) is engine-owned and invisible to the sibling.
//     Lives in the result family ([[results]]) + the optional handler hook
//     below, not as an injected capability.
//   crossScheme — deferred hard. Zero working cross-scheme COPY/MOVE exist
//     to derive the FROM-vs-TO shape from; the first real `known://x` →
//     `file://x.json` forces it. Stubbed as a named placeholder.

import type { WriterTier } from "./types.ts";
import type { ProposalResult, SchemeResult } from "./results.ts";

// Channel streaming-lifecycle state (mirrors plurnk-service's ChannelState /
// grammar ChannelContent.state). Metadata, not an engine gate (SPEC §5.6).
export type ChannelState = "static" | "active" | "closed" | "errored";

// The full entry shape exchanged across CRUD (mirrors plurnk-service's
// EntryData). Channels keyed by name → content + pinned mimetype + state.
export interface EntryData {
    readonly channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    readonly tags: ReadonlyArray<string>;
}

// ── entries ──────────────────────────────────────────────────────────────
// CRUD over the scheme's OWN namespace only. The impl scopes every call to
// the calling scheme; a sibling cannot read or write another scheme's
// entries (SPEC §5). Wraps `_entry-crud.ts`.
export interface EntryCaps {
    read(pathname: string): Promise<{ status: number; entry: EntryData | null }>;
    write(pathname: string, entry: EntryData): Promise<{ status: number; created: boolean; entryId: number | null }>;
    delete(pathname: string): Promise<{ status: number }>;
}

// ── channels ─────────────────────────────────────────────────────────────
// Per-channel content writes + state transitions. `append` and `replace` are
// distinct because channels are append-only content stores (SPEC §5) but
// EDIT replaces; the impl enforces which ops a channel permits. `setState`
// drives the static/active/closed/errored lifecycle the model reads between
// turns. Wraps `ChannelWrite`.
export interface ChannelCaps {
    append(pathname: string, channel: string, content: string): Promise<{ status: number }>;
    replace(pathname: string, channel: string, content: string): Promise<{ status: number }>;
    setState(pathname: string, channel: string, state: ChannelState): Promise<{ status: number }>;
}

// NOTE: there is no `visibility` capability. Entry-level SHOW/HIDE no longer
// exists in plurnk-service — the `visibility` table was removed in the
// index/visibility teardown; SHOW/HIDE now collapse/expand `log://` rows, a
// log-side concern with no entry-visibility for a scheme to set (per
// plurnk-service#180). If a sibling ever needs to influence what the model
// retains, that's a log capability, not an entry one — designed if/when forced.

// ── tags ─────────────────────────────────────────────────────────────────
// Entry-tag add/remove/list. `add`/`remove` are additive/subtractive sets
// (SPEC §6.1 tags-apply-additively). Wraps `entry_tags`.
export interface TagCaps {
    add(pathname: string, tags: ReadonlyArray<string>): Promise<{ status: number }>;
    remove(pathname: string, tags: ReadonlyArray<string>): Promise<{ status: number }>;
    list(pathname: string): Promise<{ status: number; tags: ReadonlyArray<string> }>;
}

// ── notify ───────────────────────────────────────────────────────────────
// Out-of-band, between-turn signal to clients — today's `streamEventNotify`
// hook. NOT model-facing: the model is turn-based and sees channel state at
// the next boundary (SPEC §7.9). `streamEvent` is metadata-only (never
// content).
//
// There is no `wakeRun` here. The run-wake carries subscription-close
// context (entryId / subscriptionId / closeStatus / scheme / summary) that
// only exists at stream completion, so it belongs to `subscriptions.close`,
// which already composites it (channel state + registry close + run wake).
// Only streaming schemes wake a run, and always via close; synchronous entry
// schemes return their turn and never wake. (plurnk-service#180.)
export interface NotifyCaps {
    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void;
}

// ── subscriptions ────────────────────────────────────────────────────────
// The streaming lifecycle (SPEC §7). The hard namespace; designed against
// Exec (the proven two-channel, cancel-tested case — if it serves exec it
// serves http). The registered-vs-content split (registry exists only for
// cancel routing, §7.1; channels carry lifecycle) is REAL and load-bearing
// in the impl, but HIDDEN here: a sibling sees one lifecycle, not two
// substrates.
export interface SubscriptionCaps {
    // Register the subscription for cancel routing and return the signal the
    // sibling should await for teardown. The returned AbortSignal is the run
    // signal COMPOSED WITH this subscription's own teardown — it fires on
    // `loop.cancel` OR local teardown (connection drop). Await this, not
    // ctx.signal (which it subsumes). `handle` is the force-cancel hook the
    // engine's cancel router invokes to tear the subscription down from
    // OUTSIDE (exec's kill handle; http's socket-abort) — the active
    // counterpart to the passive signal.
    open(pathname: string, handle: SubscriptionHandle): Promise<AbortSignal>;

    // FUSED append-and-notify: write the chunk to the named channel AND fire
    // stream/event in one call. Kept composite by contract — a streaming
    // sibling must never have to remember "append, then separately notify."
    notifyChunk(channel: string, chunk: string): Promise<void>;

    // Settle the subscription: set channel state (closed/errored), close the
    // registry row, and fire the run wake ("stream concluded" + summary).
    // `outcome` carries the scheme's summary (exec: exit-code + byte-counts).
    close(reason: "done" | "error", outcome?: string): Promise<void>;
}

// The force-cancel hook a streaming scheme hands to `open`. The engine's
// cancel router invokes it to tear down from outside (SEND[499] → here).
export interface SubscriptionHandle {
    cancel(): void | Promise<void>;
}

// ── crossScheme (DEFERRED) ───────────────────────────────────────────────
// Intentionally empty. Cross-scheme COPY/MOVE is engine-orchestrated over
// CRUD today (SPEC §3.4); whether a sibling needs a FROM/TO capability — and
// its shape — waits for the first real cross-scheme implementation to force
// it. Present as a named placeholder so the slot exists without committing a
// guessed interface.
export interface CrossSchemeCaps {
    readonly _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape";
}

// ── the context ──────────────────────────────────────────────────────────
// Fresh per op-call. A sibling MUST NOT retain it past the handler return
// (SPEC §5). Identity/lifecycle fields carry the engine's per-dispatch
// coordinates; capability namespaces replace raw `db`.
export interface SchemeCtx {
    readonly sessionId: number;
    readonly runId: number;
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
    readonly subscriptions: SubscriptionCaps;
    readonly crossScheme: CrossSchemeCaps;
}

// ── proposals (NOT a capability) ─────────────────────────────────────────
// A side-effecting scheme proposes by RETURNING a ProposalResult (status
// 202) from its op handler — no injected capability. The engine owns the
// resolution lifecycle (await, accept/reject, YOLO/noProposals auto-resolve,
// timeout) and it is invisible to the sibling: on reject the actor sees an
// ordinary 4xx, never the orchestration. The ONLY sibling-side surface is an
// optional handler hook the engine calls when a proposal is accepted, so the
// scheme can apply the deferred side effect.
export interface ProposalAware {
    applyResolution(pathname: string, proposal: ProposalResult, ctx: SchemeCtx): Promise<SchemeResult>;
}
