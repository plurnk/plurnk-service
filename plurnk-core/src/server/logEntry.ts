// Hydrate a log_entries row for the wire. Re-parses JSON-encoded columns
// (signal, lineMarker, tx, rx, attrs) so the client receives
// structured values, not opaque strings.

import type { LogEntryWire } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";

// One `log_entries` row as `log_entry_by_id` and `log_entries_recent` select it: the columns the wire carries, the
// JSON ones still encoded, and the hydration columns the statement derives ({§methods-readable-reasoning},
// {§methods-invocation}, {§methods-answering}).
export interface LogEntryRow {
    readonly id: number;
    readonly session_id: number;
    readonly session_name: string;
    readonly loop_id: number;
    readonly loop_seq: number;
    readonly turn_id: number;
    readonly turn_seq: number;
    readonly sequence: number;
    readonly at: string;
    readonly origin: string;
    readonly source: string | null;
    readonly op: string | null;
    readonly signal: string | null;
    readonly scheme: string | null;
    readonly username: string | null;
    readonly password: string | null;
    readonly hostname: string | null;
    readonly port: number | null;
    readonly pathname: string | null;
    readonly query: string | null;
    readonly fragment: string | null;
    readonly lineMarker: string | null;
    readonly tx: string | null;
    readonly mimetype_tx: string;
    readonly rx: string | null;
    readonly mimetype_rx: string;
    readonly status_rx: number;
    readonly weight: number;
    readonly attrs: string | null;
    readonly state: LogEntryWire["state"];
    readonly reasoning: string | null;
    readonly reasoning_model_call_id: number | null;
    readonly reasoning_request_sequence: number | null;
    readonly invocation: string | null;
    readonly answering: string | null;
}

export default class LogEntry {
    static #parseJsonOrNull(v: string | null): unknown {
        // "" is the actionless-row sentinel for "no statement" (error and
        // actionless source rows store tx="");
        // JSON.parse("") throws, so an empty string is no-value → null, like NULL itself.
        if (v === null || v === "") return null;
        return JSON.parse(v);
    }

    static async fetchLogEntry(db: Db, id: number): Promise<LogEntryWire> {
        const row = await db.log_entry_by_id.get<LogEntryRow>({ id });
        if (row === undefined) throw new Error(`log_entries row ${id} not found`);
        return LogEntry.wire(row);
    }

    // One hydrated row, as log_entry_by_id and log_entries_recent both select it.
    static wire(row: LogEntryRow): LogEntryWire {
        return {
            id: row.id,
            session_id: row.session_id,
            session_name: row.session_name,
            loop_id: row.loop_id,
            loop_seq: row.loop_seq,
            turn_id: row.turn_id,
            turn_seq: row.turn_seq,
            sequence: row.sequence,
            at: row.at,
            origin: row.origin,
            source: row.source,
            op: row.op,
            signal: LogEntry.#parseJsonOrNull(row.signal),
            scheme: row.scheme,
            username: row.username,
            password: row.password,
            hostname: row.hostname,
            port: row.port,
            pathname: row.pathname,
            query: row.query,
            fragment: row.fragment,
            lineMarker: LogEntry.#parseJsonOrNull(row.lineMarker),
            tx: LogEntry.#parseJsonOrNull(row.tx),
            mimetype_tx: row.mimetype_tx,
            rx: LogEntry.#parseJsonOrNull(row.rx),
            mimetype_rx: row.mimetype_rx,
            status_rx: row.status_rx,
            weight: row.weight,
            attrs: LogEntry.#parseJsonOrNull(row.attrs),
            state: row.state,
            ...(row.reasoning === null ? {} : {
                reasoning: row.reasoning,
                ...(row.reasoning_model_call_id === null ? {} : { reasoning_model_call_id: row.reasoning_model_call_id }),
                ...(row.reasoning_request_sequence === null ? {} : { reasoning_request_sequence: row.reasoning_request_sequence }),
            }),
            ...(row.invocation === null ? {} : { invocation: row.invocation }),
            ...(row.answering === null ? {} : { answering: row.answering }),
        };
    }
}
