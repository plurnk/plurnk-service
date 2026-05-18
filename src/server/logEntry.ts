// Hydrate a log_entries row for the wire. Re-parses JSON-encoded columns
// (signal, target_params, lineMarker, tx, rx) so the client receives
// structured values, not opaque strings.

import type { Db, PrepMethod } from "../core/Db.ts";

export interface LogEntryWire {
    id: number;
    run_id: number;
    loop_id: number;
    turn_id: number;
    action_index: number;
    at: string;
    origin: string;
    op: string;
    suffix: string;
    signal: unknown;
    target_scheme: string | null;
    target_username: string | null;
    target_password: string | null;
    target_hostname: string | null;
    target_port: number | null;
    target_pathname: string | null;
    target_params: unknown;
    target_fragment: string | null;
    lineMarker: unknown;
    tx: unknown;
    mimetype_tx: string;
    rx: unknown;
    mimetype_rx: string;
    status_rx: number;
    tokens: number;
}

const parseJsonOrNull = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return v;
    return JSON.parse(v);
};

export const fetchLogEntry = async (db: Db, id: number): Promise<LogEntryWire> => {
    const row = await (db.log_entry_by_id as PrepMethod).get<Record<string, unknown>>({ id });
    if (row === undefined) throw new Error(`log_entries row ${id} not found`);
    return {
        id: row.id as number,
        run_id: row.run_id as number,
        loop_id: row.loop_id as number,
        turn_id: row.turn_id as number,
        action_index: row.action_index as number,
        at: row.at as string,
        origin: row.origin as string,
        op: row.op as string,
        suffix: row.suffix as string,
        signal: parseJsonOrNull(row.signal),
        target_scheme: row.target_scheme as string | null,
        target_username: row.target_username as string | null,
        target_password: row.target_password as string | null,
        target_hostname: row.target_hostname as string | null,
        target_port: row.target_port as number | null,
        target_pathname: row.target_pathname as string | null,
        target_params: parseJsonOrNull(row.target_params),
        target_fragment: row.target_fragment as string | null,
        lineMarker: parseJsonOrNull(row.lineMarker),
        tx: parseJsonOrNull(row.tx),
        mimetype_tx: row.mimetype_tx as string,
        rx: parseJsonOrNull(row.rx),
        mimetype_rx: row.mimetype_rx as string,
        status_rx: row.status_rx as number,
        tokens: row.tokens as number,
    };
};
