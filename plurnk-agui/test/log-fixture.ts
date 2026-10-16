// A log row exactly as core sends it ({§methods-log-entry-wire}): complete, so a fixture carries nothing production
// never sends and lacks nothing production always sends. Its sequence defaults to its id, so distinct rows have distinct
// coordinates ({§methods-log-coordinate}).
import type { LogEntryWire } from "@plurnk/plurnk-contracts";

export const wireRow = (over: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: over.id ?? 1,
    worker_id: 10,
    loop_id: 1,
    loop_seq: 1,
    turn_id: 1,
    turn_seq: 1,
    sequence: over.id ?? 1,
    at: "2026-10-15T00:00:00.000Z",
    origin: "model",
    source: null,
    op: "READ",
    signal: null,
    scheme: null,
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname: null,
    query: null,
    fragment: null,
    lineMarker: null,
    tx: null,
    mimetype_tx: "application/json",
    rx: { status: 200 },
    mimetype_rx: "application/json",
    status_rx: 200,
    weight: 0,
    attrs: {},
    ...over,
});
