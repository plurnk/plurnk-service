// Channel-write helpers for streaming schemes. SPEC §5.6 (channel state),
// §7.1 (subscription registry), §13.6 (stream/event notification).
//
// Schemes import these and call them as their connection lifecycle progresses.
// Helpers update entry_channels (content / state) and subscriptions, and emit
// stream/event notifications scoped to the entry's session via an optional
// callback the daemon wires in.

import type { DatabaseSync } from "node:sqlite";

export type ChannelState = "static" | "active" | "closed" | "errored";

export interface StreamEventPayload {
    entryId: number;
    channel: string;
    state: ChannelState;
    contentLength: number;
}

// Daemon provides this callback so helpers can broadcast stream/event without
// knowing about WebSocket plumbing. Signature: notify the session containing
// the entry.
export type StreamEventNotify = (sessionId: number, event: StreamEventPayload) => void;

interface ChannelLookupRow {
    session_id: number;
    state: ChannelState;
    contentLength: number;
}

const lookupChannelMeta = (db: DatabaseSync, entryId: number, channel: string): ChannelLookupRow | null => {
    const row = db
        .prepare("SELECT e.session_id, ec.state, length(ec.content) AS contentLength FROM entry_channels ec JOIN entries e ON e.id = ec.entry_id WHERE ec.entry_id = ? AND ec.name = ?")
        .get(entryId, channel) as { session_id: number; state: ChannelState; contentLength: number } | undefined;
    return row ?? null;
};

/**
 * Append content to a channel. Emits stream/event if notify is provided.
 * Channel must exist (no-op + return if not). Caller is responsible for
 * having created the channel via the scheme's write path.
 */
export const appendToChannel = (
    db: DatabaseSync,
    { entryId, channel, chunk, notify }: { entryId: number; channel: string; chunk: string; notify?: StreamEventNotify },
): void => {
    const result = db
        .prepare("UPDATE entry_channels SET content = content || ? WHERE entry_id = ? AND name = ?")
        .run(chunk, entryId, channel);
    if (result.changes === 0) return;
    if (notify === undefined) return;
    const meta = lookupChannelMeta(db, entryId, channel);
    if (meta === null) return;
    notify(meta.session_id, { entryId, channel, state: meta.state, contentLength: meta.contentLength });
};

/**
 * Transition a channel's state. SPEC §5.6 — state is metadata, schemes own
 * transitions, engine doesn't gate on state.
 */
export const setChannelState = (
    db: DatabaseSync,
    { entryId, channel, state, notify }: { entryId: number; channel: string; state: ChannelState; notify?: StreamEventNotify },
): void => {
    const result = db
        .prepare("UPDATE entry_channels SET state = ? WHERE entry_id = ? AND name = ?")
        .run(state, entryId, channel);
    if (result.changes === 0) return;
    if (notify === undefined) return;
    const meta = lookupChannelMeta(db, entryId, channel);
    if (meta === null) return;
    notify(meta.session_id, { entryId, channel, state: meta.state, contentLength: meta.contentLength });
};

/**
 * Register an active subscription. Returns the subscription id. Caller stores
 * the id for the eventual closeSubscription call. Throws on duplicate active
 * subscription per (run, entry) — partial unique index enforces SPEC §7.1.
 */
export const openSubscription = (
    db: DatabaseSync,
    { runId, entryId, scheme, handle }: { runId: number; entryId: number; scheme: string; handle: string },
): number => {
    const row = db
        .prepare("INSERT INTO subscriptions (run_id, entry_id, scheme, handle) VALUES (?, ?, ?, ?) RETURNING id")
        .get(runId, entryId, scheme, handle) as { id: number };
    return row.id;
};

/**
 * Close an active subscription. Status is the final HTTP-style code (200
 * clean, 499 cancel, 5xx error). Idempotent: closing an already-closed
 * subscription is a no-op.
 */
export const closeSubscription = (
    db: DatabaseSync,
    { subscriptionId, status }: { subscriptionId: number; status: number },
): void => {
    db.prepare(
        "UPDATE subscriptions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), close_status = ? WHERE id = ? AND closed_at IS NULL",
    ).run(status, subscriptionId);
};

/**
 * Look up the active subscription for a (run, entry). Used by cancellation
 * routing when SEND[499](path) arrives: the engine finds the active sub,
 * tells the scheme to tear down via the handle.
 */
export const findActiveSubscription = (
    db: DatabaseSync,
    { runId, entryId }: { runId: number; entryId: number },
): { id: number; scheme: string; handle: string } | null => {
    const row = db
        .prepare("SELECT id, scheme, handle FROM subscriptions WHERE run_id = ? AND entry_id = ? AND closed_at IS NULL")
        .get(runId, entryId) as { id: number; scheme: string; handle: string } | undefined;
    return row ?? null;
};
