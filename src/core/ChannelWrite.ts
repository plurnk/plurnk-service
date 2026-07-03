// Channel-write helpers for streaming schemes. SPEC §channel-state (channel state),
// §subscriptions (subscription registry), §notifications (stream/event notification).
//
// Schemes import these and call them as their connection lifecycle progresses; the
// engine has no stream/transaction abstraction (§stream-no-engine-transaction-abstraction).
// Helpers update entry_channels (content / state) and subscriptions, and emit
// stream/event notifications scoped to the entry's session via an optional
// callback the daemon wires in.

import type { Db, PrepMethod } from "./Db.ts";
import type { LoopFlags } from "./types.ts";
import { renderAddress } from "./plurnk-uri.ts";

export type ChannelState = "static" | "active" | "closed" | "errored"; // render metadata, never a read gate — §channel-state-state-is-metadata

// The loop/turn/sequence coordinate of the entry, mirrored onto stream payloads
// so clients read it as fields instead of re-parsing the exec URI's trailing
// segments (#224). The owning scheme supplies it — it owns its pathname shape;
// absent on streams that carry no coordinate.
export interface StreamCoordinate {
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

export interface StreamEventPayload {
    entryId: number;
    target: string;                // the entry's URI (`scheme://pathname`) — so clients route without an entryId→URI lookup (#179)
    channel: string;
    state: ChannelState;
    contentLength: number;
    loop_seq?: number;             // #224 — the entry's coordinate (see StreamCoordinate)
    turn_seq?: number;
    sequence?: number;
    mimetype?: string;             // #226 — the channel's current stored mimetype (a streaming scheme may retype it per call)
}

export type StreamEventNotify = (sessionId: number, event: StreamEventPayload) => void;

// Wake-on-completion (rummy parallel: stream/completed wake:true). When a
// streaming-scheme subscription closes, schemes call this so the daemon
// can open a fresh loop in the run if no loop is currently active —
// otherwise the model would never learn that its long-running command
// finished after it ended the calling loop. Daemon decides whether to
// actually wake based on engine state; the scheme just announces.
export interface WakeRunPayload {
    sessionId: number;
    runId: number;
    entryId: number;
    target: string;                // the entry's URI (`scheme://pathname`) — #179
    subscriptionId: number;
    closeStatus: number;          // 200 (clean) | 500 (error) | 499 (aborted)
    scheme: string;                // the scheme that owned the subscription
    summary: string;               // model-facing one-liner: "exec:///x completed (exit 0); stdout=N bytes, stderr=M bytes"
    loop_seq?: number;             // #224 — the entry's coordinate (see StreamCoordinate)
    turn_seq?: number;
    sequence?: number;
}

export type WakeRunNotify = (payload: WakeRunPayload) => void;

// Start/deliver-to a sister run — the run:// op family's loop-start primitive
// (spawn/fork/irc; SPEC §machine-processes, §actor-boundary-two-doors voice
// door). The daemon wires this to Daemon.inject: an active sister folds the
// prompt into its next turn; an idle sister enqueues a fresh loop and a drain
// claims it. spawn/fork create/branch the run first, then call this to start
// it; irc calls it on an existing sister. Returns the delivery action + the
// loop the prompt landed on. The daemon supplies provider + system prompt; the
// caller (a scheme handler) carries neither.
export type InjectRunNotify = (args: {
    sessionId: number;
    runId: number;
    prompt: string;
    // §run-delegation-inherits-flags — the SENDING loop's flags. Authority flows down the
    // delegation edge: a spawned/forked child's live loop runs with its delegator's flags,
    // or a non-YOLO child's every side-effecting op proposes into a resolver-less void
    // (300s auto-cancel per attempt — the fan-out wedge). Resume-in-place ignores this
    // (a parked loop keeps its own flags).
    flags?: LoopFlags;
}) => Promise<{ action: "injected_next_turn" | "enqueued_new_loop"; loopId: number }>;

// Abort a run's in-flight work by id — the run:// op family's KILL primitive
// (terminate). The daemon wires this to Daemon.cancelDrain: aborts the run's
// signal, so its active loop closes at 499 and any background streams tear down.
// Sync; returns whether there was work. KILL routes through Dispatcher.#handleKill
// (not a scheme handler), so this is an Engine field, never a ctx capability.
export type CancelRunNotify = (runId: number) => boolean;

// Telemetry event fan-out. TelemetryChannel.push fires this for every
// TelemetryEvent (parse_error, strike, cycle, sudden_death, no_ops,
// max_commands_exceeded, action_failure) it pushes to a loop's buffer.
// Daemon broadcasts as `telemetry/event` scoped to the loop's session.
// Same envelope on both ends: the model sees it on the next packet's
// telemetry.errors[]; the client sees it live. SPEC §telemetry.
export interface TelemetryEventPayload {
    loopId: number;
    event: object;                 // TelemetryEvent per @plurnk/plurnk-grammar
}

export type TelemetryEventNotify = (sessionId: number, payload: TelemetryEventPayload) => void;

interface ChannelMetaRow {
    session_id: number;
    scheme: string | null;
    pathname: string;
    state: ChannelState;
    mimetype: string;
    contentLength: number;
}

export default class ChannelWrite {
    static #channelMeta(db: Db): PrepMethod { return db.channel_meta as PrepMethod; }
    static #appendStmt(db: Db): PrepMethod { return db.append_to_channel as PrepMethod; }
    static #stateStmt(db: Db): PrepMethod { return db.set_channel_state as PrepMethod; }
    static #mimetypeStmt(db: Db): PrepMethod { return db.set_channel_mimetype as PrepMethod; }
    static #openSubStmt(db: Db): PrepMethod { return db.open_subscription as PrepMethod; }
    static #closeSubStmt(db: Db): PrepMethod { return db.close_subscription as PrepMethod; }
    static #findActiveStmt(db: Db): PrepMethod { return db.find_active_subscription as PrepMethod; }
    static #openSubsForRunStmt(db: Db): PrepMethod { return db.find_open_subscriptions_for_run as PrepMethod; }
    static #execTerminalStmt(db: Db): PrepMethod { return db.find_exec_close_status as PrepMethod; }

    // The entry's target URI for stream notifications (#179). A NULL scheme is
    // a filesystem entry (the file scheme stores scheme=NULL), so it decodes to
    // file:///.
    static #targetUri(scheme: string | null, pathname: string): string {
        return renderAddress(scheme === null ? "file" : scheme, pathname);
    }

    // A stream chunk accumulates into the channel's content (§chunk-accumulation-chunks-accumulate)
    // and fires a stream/event (§live-updates-stream-event-fires-on-chunk); the log carries the
    // stream's lifecycle, never per-chunk rows (§no-chunk-rows-log-captures-lifecycle-only).
    static async appendToChannel(
        db: Db,
        { entryId, channel, chunk, notify, coordinate, mimetype }: { entryId: number; channel: string; chunk: string; notify?: StreamEventNotify; coordinate?: StreamCoordinate; mimetype?: string },
    ): Promise<void> {
        const result = await ChannelWrite.#appendStmt(db).run({ chunk, entry_id: entryId, channel });
        if (result.changes === 0) return;
        // #226 — a streaming scheme labels the channel with the body's per-call
        // type (http's Content-Type varies per fetch). Conditional UPDATE: only
        // writes when it changed, so labelling every chunk is a steady-state no-op.
        if (mimetype !== undefined) await ChannelWrite.#mimetypeStmt(db).run({ mimetype, entry_id: entryId, channel });
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.session_id, { entryId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength, mimetype: meta.mimetype, ...coordinate });
    }

    // Schemes drive channel state transitions as their connection lifecycle progresses.
    // §channel-state-schemes-own-state-transitions
    static async setChannelState(
        db: Db,
        { entryId, channel, state, notify, coordinate }: { entryId: number; channel: string; state: ChannelState; notify?: StreamEventNotify; coordinate?: StreamCoordinate },
    ): Promise<void> {
        const result = await ChannelWrite.#stateStmt(db).run({ state, entry_id: entryId, channel });
        if (result.changes === 0) return;
        // §semantic-fts-at-write — a stream's accumulated BODY content becomes keyword-searchable
        // the moment the channel settles (closed/errored), not a pump-pass later. Body only: the
        // FTS row is per-ENTRY (rowid = entry id) and the fusion's keyword half is the body's.
        if ((state === "closed" || state === "errored") && channel === "body") {
            const row = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel });
            if (row !== undefined) {
                const body = await (db.read_channel_content as PrepMethod).get<{ content: string }>({ entry_id: entryId, channel });
                if (body !== undefined) {
                    await (db.fts_delete as PrepMethod).run({ entry_id: entryId });
                    if (body.content.length > 0) await (db.fts_insert as PrepMethod).run({ entry_id: entryId, content: body.content });
                }
            }
        }
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.session_id, { entryId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength, mimetype: meta.mimetype, ...coordinate });
    }

    // The subscription registry — open/find/close — is how a stream's cancellation
    // (SEND[499] / KILL) routes to the right live subscription. §subscriptions-subscription-registry-routes-cancellation
    static async openSubscription(
        db: Db,
        { runId, entryId, scheme, handle, pollSeconds, turnScoped }: { runId: number; entryId: number; scheme: string; handle: string; pollSeconds?: number | null; turnScoped?: boolean },
    ): Promise<number> {
        const row = await ChannelWrite.#openSubStmt(db).get<{ id: number }>({ run_id: runId, entry_id: entryId, scheme, handle, poll_seconds: pollSeconds ?? null, turn_scoped: turnScoped ? 1 : 0 });
        if (row === undefined) throw new Error("openSubscription: INSERT ... RETURNING produced no row");
        return row.id;
    }

    static async closeSubscription(
        db: Db,
        { subscriptionId, status }: { subscriptionId: number; status: number },
    ): Promise<void> {
        await ChannelWrite.#closeSubStmt(db).run({ status, subscription_id: subscriptionId });
    }

    // Terminal close_status of a finished exec stream, by coordinate pathname —
    // the KILL-on-a-non-running-exec lookup (Exec.kill). null = no closed
    // subscription for that coordinate (unknown exec).
    static async execTerminalStatus(
        db: Db,
        { sessionId, pathname }: { sessionId: number; pathname: string },
    ): Promise<number | null> {
        const row = await ChannelWrite.#execTerminalStmt(db).get<{ close_status: number }>({ session_id: sessionId, pathname });
        return row?.close_status ?? null;
    }

    static async findActiveSubscription(
        db: Db,
        { runId, entryId }: { runId: number; entryId: number },
    ): Promise<{ id: number; scheme: string; handle: string } | null> {
        const row = await ChannelWrite.#findActiveStmt(db).get<{ id: number; scheme: string; handle: string }>({ run_id: runId, entry_id: entryId });
        return row ?? null;
    }

    // The run's still-open subscriptions — the registry-routed reap
    // (§run-lifecycle-total-reap). A cancel iterates these and aborts each via the
    // owning scheme, so a backgrounded exec is reaped regardless of in-process
    // AbortSignal-listener timing (R1): the registry is the source of truth, the
    // signal an optimization.
    static async findOpenSubscriptionsForRun(
        db: Db,
        runId: number,
    ): Promise<Array<{ id: number; scheme: string }>> {
        return ChannelWrite.#openSubsForRunStmt(db).all<{ id: number; scheme: string }>({ run_id: runId });
    }

    // The run's open turn-scoped (EXEC `<0>`) subscriptions — reaped at the run's next pre-turn so a
    // `<0>` stream never survives into the subsequent turn (§exec-poll). Any open turn-scoped sub at
    // pre-turn is necessarily from a prior turn (the reap runs before this turn's own spawns).
    static async findOpenTurnScopedSubscriptionsForRun(
        db: Db,
        runId: number,
    ): Promise<Array<{ id: number; scheme: string }>> {
        return (db.find_open_turn_scoped_subscriptions_for_run as PrepMethod).all<{ id: number; scheme: string }>({ run_id: runId });
    }
}
