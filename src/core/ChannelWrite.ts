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
    subscriptionId: number;
    closeStatus: number;          // 200 (clean) | 500 (error) | 499 (aborted)
    scheme: string;                // the scheme that owned the subscription
    summary: string;               // model-facing one-liner: "exec://x completed (exit 0); stdout=N bytes, stderr=M bytes"
}

export type WakeRunNotify = (payload: WakeRunPayload) => void;

interface ChannelMetaRow {
    session_id: number;
    state: ChannelState;
    contentLength: number;
}

const channelMeta = (db: Db) => db.channel_meta as PrepMethod;
const appendStmt = (db: Db) => db.append_to_channel as PrepMethod;
const stateStmt = (db: Db) => db.set_channel_state as PrepMethod;
const openSubStmt = (db: Db) => db.open_subscription as PrepMethod;
const closeSubStmt = (db: Db) => db.close_subscription as PrepMethod;
const findActiveStmt = (db: Db) => db.find_active_subscription as PrepMethod;

export const appendToChannel = async (
    db: Db,
    { entryId, channel, chunk, notify }: { entryId: number; channel: string; chunk: string; notify?: StreamEventNotify },
): Promise<void> => {
    const result = await appendStmt(db).run({ chunk, entry_id: entryId, channel });
    if (result.changes === 0) return;
    if (notify === undefined) return;
    const meta = await channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
    if (meta === undefined) return;
    notify(meta.session_id, { entryId, channel, state: meta.state, contentLength: meta.contentLength });
};

export const setChannelState = async (
    db: Db,
    { entryId, channel, state, notify }: { entryId: number; channel: string; state: ChannelState; notify?: StreamEventNotify },
): Promise<void> => {
    const result = await stateStmt(db).run({ state, entry_id: entryId, channel });
    if (result.changes === 0) return;
    if (notify === undefined) return;
    const meta = await channelMeta(db).get<ChannelMetaRow>({ entry_id: entryId, channel });
    if (meta === undefined) return;
    notify(meta.session_id, { entryId, channel, state: meta.state, contentLength: meta.contentLength });
};

export const openSubscription = async (
    db: Db,
    { runId, entryId, scheme, handle }: { runId: number; entryId: number; scheme: string; handle: string },
): Promise<number> => {
    const row = await openSubStmt(db).get<{ id: number }>({ run_id: runId, entry_id: entryId, scheme, handle });
    if (row === undefined) throw new Error("openSubscription: INSERT ... RETURNING produced no row");
    return row.id;
};

export const closeSubscription = async (
    db: Db,
    { subscriptionId, status }: { subscriptionId: number; status: number },
): Promise<void> => {
    await closeSubStmt(db).run({ status, subscription_id: subscriptionId });
};

export const findActiveSubscription = async (
    db: Db,
    { runId, entryId }: { runId: number; entryId: number },
): Promise<{ id: number; scheme: string; handle: string } | null> => {
    const row = await findActiveStmt(db).get<{ id: number; scheme: string; handle: string }>({ run_id: runId, entry_id: entryId });
    return row ?? null;
};
