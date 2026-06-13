// Hydrate a log_entries row for the wire. Re-parses JSON-encoded columns
// (signal, params, lineMarker, tx, rx) so the client receives
// structured values, not opaque strings.

import type { Db, PrepMethod } from "../core/Db.ts";

export interface LogEntryWire {
    id: number;
    run_id: number;
    loop_id: number;
    loop_seq: number;
    turn_id: number;
    turn_seq: number;
    sequence: number;
    at: string;
    origin: string;
    op: string;
    suffix: string;
    signal: unknown;
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    params: unknown;
    fragment: string | null;
    lineMarker: unknown;
    tx: unknown;
    mimetype_tx: string;
    rx: unknown;
    mimetype_rx: string;
    status_rx: number;
    tokens: number;
}

export default class LogEntry {
    static #parseJsonOrNull(v: unknown): unknown {
        if (v === null || v === undefined) return null;
        if (typeof v !== "string") return v;
        return JSON.parse(v);
    }

    static async fetchLogEntry(db: Db, id: number): Promise<LogEntryWire> {
        const row = await (db.log_entry_by_id as PrepMethod).get<Record<string, unknown>>({ id });
        if (row === undefined) throw new Error(`log_entries row ${id} not found`);
        return {
            id: row.id as number,
            run_id: row.run_id as number,
            loop_id: row.loop_id as number,
            loop_seq: row.loop_seq as number,
            turn_id: row.turn_id as number,
            turn_seq: row.turn_seq as number,
            sequence: row.sequence as number,
            at: row.at as string,
            origin: row.origin as string,
            op: row.op as string,
            suffix: row.suffix as string,
            signal: LogEntry.#parseJsonOrNull(row.signal),
            scheme: row.scheme as string | null,
            username: row.username as string | null,
            password: row.password as string | null,
            hostname: row.hostname as string | null,
            port: row.port as number | null,
            pathname: row.pathname as string | null,
            params: LogEntry.#parseJsonOrNull(row.params),
            fragment: row.fragment as string | null,
            lineMarker: LogEntry.#parseJsonOrNull(row.lineMarker),
            tx: LogEntry.#parseJsonOrNull(row.tx),
            mimetype_tx: row.mimetype_tx as string,
            rx: LogEntry.#parseJsonOrNull(row.rx),
            mimetype_rx: row.mimetype_rx as string,
            status_rx: row.status_rx as number,
            tokens: row.tokens as number,
        };
    }
}
