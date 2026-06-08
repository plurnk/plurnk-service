// Channel-write helpers for streaming schemes. SPEC §5.6 (channel state),
// §7.1 (subscription registry), §13.6 (stream/event notification).
//
// Schemes import these and call them as their connection lifecycle progresses.
// Helpers update entry_channels (content / state) and subscriptions, and emit
// stream/event notifications scoped to the entry's session via an optional
// callback the daemon wires in.

import type { Db, PrepMethod } from "./Db.ts";

export type ChannelState = "static" | "active" | "closed" | "errored";

export interface StreamEventPayload {
    entryId: number;
    target: string;                // the entry's URI (`scheme://pathname`) — so clients route without an entryId→URI lookup (#179)
    channel: string;
    state: ChannelState;
    contentLength: number;
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
    summary: string;               // model-facing one-liner: "exec://x completed (exit 0); stdout=N bytes, stderr=M bytes"
}

export type WakeRunNotify = (payload: WakeRunPayload) => void;

// Telemetry event fan-out. Engine.#pushTelemetry fires this for every
// TelemetryEvent (parse_error, strike, cycle, sudden_death, no_ops,
// max_commands_exceeded, action_failure) it pushes to a loop's buffer.
// Daemon broadcasts as `telemetry/event` scoped to the loop's session.
// Same envelope on both ends: the model sees it on the next packet's
// telemetry.errors[]; the client sees it live. SPEC §15.1.
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
    contentLength: number;
}

export default class ChannelWrite {
    static #channelMeta(db: Db): PrepMethod { return db.channel_meta as PrepMethod; }
    static #appendStmt(db: Db): PrepMethod { return db.append_to_channel as PrepMethod; }
    static #stateStmt(db: Db): PrepMethod { return db.set_channel_state as PrepMethod; }
    static #openSubStmt(db: Db): PrepMethod { return db.open_subscription as PrepMethod; }
    static #closeSubStmt(db: Db): PrepMethod { return db.close_subscription as PrepMethod; }
    static #findActiveStmt(db: Db): PrepMethod { return db.find_active_subscription as PrepMethod; }

    // The entry's target URI for stream notifications (#179). A NULL scheme is
    // a filesystem entry (the file scheme stores scheme=NULL), so it decodes to
    // file://.
    static #targetUri(scheme: string | null, pathname: string): string {
        return `${scheme === null ? "file" : scheme}://${pathname}`;
    }

    static async appendToChannel(
        db: Db,
        { entryId, channel, chunk, notify }: { entryId: number; channel: string; chunk: string; notify?: StreamEventNotify },
    ): Promise<void> {
        const result = await ChannelWrite.#appendStmt(db).run({ chunk, entry_id: entryId, channel });
        if (result.changes === 0) return;
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.session_id, { entryId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength });
    }

    static async setChannelState(
        db: Db,
        { entryId, channel, state, notify }: { entryId: number; channel: string; state: ChannelState; notify?: StreamEventNotify },
    ): Promise<void> {
        const result = await ChannelWrite.#stateStmt(db).run({ state, entry_id: entryId, channel });
        if (result.changes === 0) return;
        if (notify === undefined) return;
        const meta = await ChannelWrite.#channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
        if (meta === undefined) return;
        notify(meta.session_id, { entryId, target: ChannelWrite.#targetUri(meta.scheme, meta.pathname), channel, state: meta.state, contentLength: meta.contentLength });
    }

    static async openSubscription(
        db: Db,
        { runId, entryId, scheme, handle }: { runId: number; entryId: number; scheme: string; handle: string },
    ): Promise<number> {
        const row = await ChannelWrite.#openSubStmt(db).get<{ id: number }>({ run_id: runId, entry_id: entryId, scheme, handle });
        if (row === undefined) throw new Error("openSubscription: INSERT ... RETURNING produced no row");
        return row.id;
    }

    static async closeSubscription(
        db: Db,
        { subscriptionId, status }: { subscriptionId: number; status: number },
    ): Promise<void> {
        await ChannelWrite.#closeSubStmt(db).run({ status, subscription_id: subscriptionId });
    }

    static async findActiveSubscription(
        db: Db,
        { runId, entryId }: { runId: number; entryId: number },
    ): Promise<{ id: number; scheme: string; handle: string } | null> {
        const row = await ChannelWrite.#findActiveStmt(db).get<{ id: number; scheme: string; handle: string }>({ run_id: runId, entry_id: entryId });
        return row ?? null;
    }
}
