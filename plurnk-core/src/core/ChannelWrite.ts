// Channel-write helpers for streaming schemes. SPEC {§channel-state} (channel state),
// {§subscriptions} (subscription registry), {§notifications} (stream/event notification).
//
// Schemes import these and call them as their connection lifecycle progresses; the
// engine has no stream/transaction abstraction ({§stream-no-engine-transaction-abstraction}).
// Helpers update entry_channels (content / state) and subscriptions, and emit
// stream/event notifications scoped to the entry's workspace via an optional
// callback the daemon wires in.

import type { Db } from "./Db.ts";
import type { LoopFlags, WriterTier } from "./types.ts";
import { Results, type ChannelState, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { Notice } from "@plurnk/plurnk-contracts";
import { renderAddress } from "./plurnk-uri.ts";

// Render metadata, never a read gate — {§channel-state-state-is-metadata}.
export type { ChannelState } from "@plurnk/plurnk-schemes";

// The loop/turn/sequence coordinate of the entry, mirrored onto stream payloads
// so clients read it as fields instead of re-parsing the target URI. The owning
// scheme supplies it because it owns its pathname shape; absent on streams that
// carry no coordinate. {§notifications-stream-event-on-channel-change},
// {§notifications-stream-concluded}
export interface StreamCoordinate {
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

export interface StreamEventPayload {
    entryId: number;
    workerId: number;                // entry owner and read perspective — {§notifications-stream-event-on-channel-change}
    target: string;                // canonical entry URI — {§notifications-stream-event-on-channel-change}
    channel: string;
    state: ChannelState;
    contentLength: number;
    loop_seq?: number;             // entry coordinate, when the scheme has one
    turn_seq?: number;
    sequence?: number;
    mimetype?: string;             // current stored type — {§channel-mimetype}
}

export type StreamEventNotify = (workspaceId: number, event: StreamEventPayload) => void;

// {§worker-lifecycle-wake-liveness} — when a streaming-scheme subscription
// closes, schemes call this so the daemon
// can open a fresh loop in the worker if no loop is currently active —
// otherwise the model would never learn that its long-running command
// finished after it ended the calling loop. Daemon decides whether to
// actually wake based on engine state; the scheme just announces.
export interface WakeWorkerPayload {
    workspaceId: number;
    workerId: number;                // lifecycle worker to wake
    entryOwnerId: number;            // public stream/concluded read perspective
    entryId: number;
    target: string;                // canonical entry URI — {§notifications-stream-concluded}
    subscriptionId: number;
    result: SchemeResult;           // exact universal terminal result
    scheme: string;                // the scheme that owned the subscription
    summary: string;               // model-facing line, e.g. "sh:///1/2/3 completed (exit 0); stdout=N bytes, stderr=M bytes"
    loop_seq?: number;             // entry coordinate, when the scheme has one
    turn_seq?: number;
    sequence?: number;
}

export type WakeWorkerNotify = (payload: WakeWorkerPayload) => void;

// Start/deliver-to a sister worker — the worker:// op family's loop-start primitive
// (spawn/fork/irc; SPEC {§machine-processes}, {§actor-boundary-two-doors} voice
// door). The daemon wires this to Daemon.inject: an active sister folds the
// prompt into its next turn; an idle sister enqueues a fresh loop and a drain
// claims it. spawn/fork create/branch the worker first, then call this to start
// it; irc calls it on an existing sister. Returns the delivery action + the
// loop the prompt landed on. The daemon supplies provider + system prompt; the
// caller (a scheme handler) carries neither.
export type InjectWorkerNotify = (args: {
    workspaceId: number;
    workerId: number;
    prompt: string;
    // WORK/FORK name the spawning loop so the daemon can apply its durable
    // child-provider policy. Other voice-door injections omit it.
    parentLoopId?: number;
    // {§worker-delegation-inherits-flags} — the SENDING loop's flags. Authority flows down the
    // delegation edge: a spawned/forked child's live loop runs with its delegator's flags,
    // or a non-auto child's every side-effecting op proposes into a resolver-less void
    // (300s auto-cancel per attempt — the fan-out wedge). Resume-in-place ignores this
    // (a parked loop keeps its own flags).
    flags?: LoopFlags;
}) => Promise<{ action: "injected_next_turn" | "enqueued_new_loop"; loopId: number }>;

// A branch-tagged WORK/FORK is not an ordinary concurrent spawn. The daemon
// collects every tagged child emitted by one parent turn into a durable,
// serialized Git branch batch and starts those loops only after the turn seals.
export type BranchWorkerNotify = (args: {
    workspaceId: number;
    parentWorkerId: number;
    parentLoopId: number;
    parentTurnId: number;
    op: "WORK" | "FORK";
    name: string;
    branch: string;
    prompt: string;
    flags: LoopFlags;
    origin: WriterTier;
}) => Promise<{ workerId: number; loopId: number }>;

// Branch children may conclude only after restoring the transaction invariant:
// every declared checkout remains on the assigned branch and is clean. A
// returned failure is logged as the SEND outcome, leaving the loop alive to
// repair and commit.
export type BranchCompletionGate = (workerId: number) => Promise<SchemeResult | null>;

// Abort a worker's in-flight work by id — the worker:// op family's KILL primitive
// (terminate). The daemon wires this to Daemon.cancelDrain: aborts the worker's
// signal, so its active loop closes at 499 and any background streams tear down.
// Sync; returns whether there was work. KILL routes through Dispatcher.#handleKill
// (not a scheme handler), so this is an Engine field, never a ctx capability.
export type CancelWorkerNotify = (workerId: number, reason: string) => Promise<void>;
export type CancelDescendantsNotify = (workerId: number, reason: string) => Promise<void>;

export interface NoticePayload {
    loopId: number;
    notice: Notice;
}

export type NoticeNotify = (workspaceId: number, payload: NoticePayload) => void;

interface ChannelMetaRow {
    workspace_id: number;
    workerId: number;
    scheme: string;
    pathname: string;
    state: ChannelState;
    mimetype: string;
    contentLength: number;
}

export default class ChannelWrite {
    static #channelMeta(db: Db) { return db.channel_meta; }
    static #appendStmt(db: Db) { return db.append_to_channel; }
    static #stateStmt(db: Db) { return db.set_channel_state; }
    static #mimetypeStmt(db: Db) { return db.set_channel_mimetype; }
    static #openSubStmt(db: Db) { return db.open_subscription; }
    static #closeSubStmt(db: Db) { return db.close_subscription; }
    static #findActiveStmt(db: Db) { return db.find_active_subscription; }
    static #openSubsForWorkerStmt(db: Db) { return db.find_open_subscriptions_for_worker; }
    static #execTerminalStmt(db: Db) { return db.find_exec_close_status; }

    static #targetUri(scheme: string, pathname: string): string {
        return renderAddress(scheme, pathname);
    }

    // A stream chunk accumulates into the channel's content ({§chunk-accumulation-chunks-accumulate})
    // and fires a stream/event ({§live-updates-stream-event-fires-on-chunk}); the log carries the
    // stream's lifecycle, never per-chunk rows ({§no-chunk-rows-log-captures-lifecycle-only}).
    static async appendToChannel(
        db: Db,
        { entryId, channel, chunk, notify, coordinate, mimetype }: { entryId: number; channel: string; chunk: string; notify?: StreamEventNotify; coordinate?: StreamCoordinate; mimetype?: string },
    ): Promise<void> {
        const result = await ChannelWrite.#appendStmt(db).run({ chunk, entry_id: entryId, channel });
        if (result.changes === 0) return;
        // A dynamic scheme may supply the body's per-call type; persist it only
        // when it changes. {§channel-mimetype}
        if (mimetype !== undefined) await ChannelWrite.#mimetypeStmt(db).run({ mimetype, entry_id: entryId, channel });
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.workspace_id, { entryId, workerId: meta.workerId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength, mimetype: meta.mimetype, ...coordinate });
    }

    // Schemes drive channel state transitions as their connection lifecycle progresses.
    // {§channel-state-schemes-own-state-transitions}
    static async setChannelState(
        db: Db,
        { entryId, channel, state, notify, coordinate }: { entryId: number; channel: string; state: ChannelState; notify?: StreamEventNotify; coordinate?: StreamCoordinate },
    ): Promise<void> {
        const result = await ChannelWrite.#stateStmt(db).run({ state, entry_id: entryId, channel });
        if (result.changes === 0) return;
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.workspace_id, { entryId, workerId: meta.workerId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength, mimetype: meta.mimetype, ...coordinate });
    }

    // The durable half of subscription ownership. Its row identifies what is
    // open; the process-local LiveSubscriptions registry owns the exact callable
    // used by SEND[499] / KILL.
    // {§subscriptions-subscription-registry-routes-cancellation}
    static async openSubscription(
        db: Db,
        { workerId, entryId, scheme, handle, pollSeconds, turnScoped, publishedChannel }: {
            workerId: number; entryId: number; scheme: string; handle: string;
            pollSeconds?: number | null; turnScoped?: boolean; publishedChannel?: string | null;
        },
    ): Promise<number> {
        const row = await ChannelWrite.#openSubStmt(db).get<{ id: number }>({
            worker_id: workerId, entry_id: entryId, scheme, handle,
            poll_seconds: pollSeconds ?? null, turn_scoped: turnScoped ? 1 : 0,
            published_channel: publishedChannel ?? null,
        });
        if (row === undefined) throw new Error("openSubscription: INSERT ... RETURNING produced no row");
        return row.id;
    }

    static async closeSubscription(
        db: Db,
        { subscriptionId, result }: { subscriptionId: number; result: SchemeResult },
    ): Promise<void> {
        Results.assert(result);
        await ChannelWrite.#closeSubStmt(db).run({
            result: JSON.stringify(result),
            status: result.status,
            subscription_id: subscriptionId,
        });
    }

    // Terminal close_status of a finished exec stream, by coordinate pathname —
    // the KILL-on-a-non-running-exec lookup (Exec.kill). null = no closed
    // subscription for that coordinate (unknown exec).
    static async execTerminalStatus(
        db: Db,
        { workspaceId, workerId, scheme, pathname }: { workspaceId: number; workerId: number; scheme: string; pathname: string },
    ): Promise<number | null> {
        const row = await ChannelWrite.#execTerminalStmt(db).get<{ close_status: number }>({
            workspace_id: workspaceId,
            worker_id: workerId,
            scheme,
            pathname,
        });
        return row?.close_status ?? null;
    }

    static async findActiveSubscription(
        db: Db,
        { workerId, entryId }: { workerId: number; entryId: number },
    ): Promise<{ id: number; scheme: string; handle: string } | null> {
        const row = await ChannelWrite.#findActiveStmt(db).get<{ id: number; scheme: string; handle: string }>({ worker_id: workerId, entry_id: entryId });
        return row ?? null;
    }

    // The worker's still-open subscriptions — the registry-routed reap
    // ({§worker-lifecycle-total-reap}). A cancel iterates these durable identities
    // and invokes each exact callable through LiveSubscriptions, so a
    // backgrounded exec is reaped regardless of AbortSignal-listener timing.
    static async findOpenSubscriptionsForWorker(
        db: Db,
        workerId: number,
    ): Promise<Array<{ id: number; scheme: string }>> {
        return ChannelWrite.#openSubsForWorkerStmt(db).all<{ id: number; scheme: string }>({ worker_id: workerId });
    }

    // The worker's open turn-scoped (EXEC `<0>`) subscriptions — reaped at the worker's next pre-turn so a
    // `<0>` stream never survives into the subsequent turn ({§exec-poll}). Any open turn-scoped sub at
    // pre-turn is necessarily from a prior turn (the reap runs before this turn's own spawns).
    static async findOpenTurnScopedSubscriptionsForWorker(
        db: Db,
        workerId: number,
    ): Promise<Array<{ id: number; scheme: string }>> {
        return db.find_open_turn_scoped_subscriptions_for_worker.all<{ id: number; scheme: string }>({ worker_id: workerId });
    }
}
