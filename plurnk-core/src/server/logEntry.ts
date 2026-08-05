// Hydrate a log_entries row for the wire. Re-parses JSON-encoded columns
// (signal, lineMarker, tx, rx, attrs) so the client receives
// structured values, not opaque strings.

import type { Db } from "../core/Db.ts";

// Every log entry carries its logical coordinate — loop_seq/turn_seq/sequence — so the
// client renders ordering without re-deriving it from DB keys. {§methods-log-coordinate}
// A type alias, not an interface: a serialized wire bag must satisfy index-signature
// consumers (Record<string, unknown>), which TypeScript grants aliases but not interfaces.
export type LogEntryWire = {
    id: number;
    worker_id: number;
    loop_id: number;
    loop_seq: number;
    turn_id: number;
    turn_seq: number;
    sequence: number;
    at: string;
    origin: string;
    source: string | null;
    op: string;
    suffix: string;
    signal: unknown;
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    query: string | null;
    fragment: string | null;
    lineMarker: unknown;
    tx: unknown;
    mimetype_tx: string;
    rx: unknown;
    mimetype_rx: string;
    status_rx: number;
    tokens: number;
    attrs: unknown;
};

export default class LogEntry {
    static #parseJsonOrNull(v: unknown): unknown {
        // "" is the actionless-row sentinel for "no statement" (error/model rows store tx="");
        // JSON.parse("") throws, so an empty string is no-value → null, like NULL itself.
        if (v === null || v === undefined || v === "") return null;
        if (typeof v !== "string") return v;
        return JSON.parse(v);
    }

    static async fetchLogEntry(db: Db, id: number): Promise<LogEntryWire> {
        const row = await db.log_entry_by_id.get<Record<string, unknown>>({ id });
        if (row === undefined) throw new Error(`log_entries row ${id} not found`);
        return {
            id: row.id as number,
            worker_id: row.worker_id as number,
            loop_id: row.loop_id as number,
            loop_seq: row.loop_seq as number,
            turn_id: row.turn_id as number,
            turn_seq: row.turn_seq as number,
            sequence: row.sequence as number,
            at: row.at as string,
            origin: row.origin as string,
            source: row.source as string | null,
            op: row.op as string,
            suffix: row.suffix as string,
            signal: LogEntry.#parseJsonOrNull(row.signal),
            scheme: row.scheme as string | null,
            username: row.username as string | null,
            password: row.password as string | null,
            hostname: row.hostname as string | null,
            port: row.port as number | null,
            pathname: row.pathname as string | null,
            query: row.query as string | null,
            fragment: row.fragment as string | null,
            lineMarker: LogEntry.#parseJsonOrNull(row.lineMarker),
            tx: LogEntry.#parseJsonOrNull(row.tx),
            mimetype_tx: row.mimetype_tx as string,
            rx: LogEntry.#parseJsonOrNull(row.rx),
            mimetype_rx: row.mimetype_rx as string,
            status_rx: row.status_rx as number,
            tokens: row.tokens as number,
            attrs: LogEntry.#parseJsonOrNull(row.attrs),
        };
    }
}
