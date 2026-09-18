import LogBody from "./LogBody.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

interface LogEntryProjectionRow {
    readonly origin?: unknown;
    readonly op?: unknown;
    readonly attrs?: unknown;
    readonly tx?: unknown;
}

// {§log-coordinate-hierarchy}: one model-facing identity for a durable row,
// independent of the dispatch type retained in storage.
export default class LogEntryProjection {
    static #decode(value: unknown, field: string): unknown {
        if (typeof value !== "string") return value;
        try {
            return JSON.parse(value) as unknown;
        } catch (cause) {
            throw new TypeError(`A durable log row carries malformed ${field} JSON.`, { cause });
        }
    }

    static op(row: LogEntryProjectionRow): string | null {
        const op = typeof row.op === "string" && row.op.length > 0 ? row.op : null;
        const attrs = LogEntryProjection.#decode(row.attrs, "attrs");
        const materializedEntry = row.origin === "_plurnk" && op === "EDIT"
            && attrs !== null && typeof attrs === "object"
            && (attrs as { kind?: unknown }).kind === "entry_materialized";
        return materializedEntry ? "READ" : op;
    }

    static leaf(row: LogEntryProjectionRow): string {
        const op = LogEntryProjection.op(row);
        // An execution row's leaf is its runtime: the op as written.
        if (isExecutionOp(op)) return op;
        // {§loop-answer} a prose answer is stored as the SEND that delivers it, but it is not a SEND
        // the model wrote: it is addressed as an answer.
        if (op === "SEND" && (LogEntryProjection.#decode(row.attrs, "attrs") as { answer?: unknown } | null)?.answer === "prose") return "answer";
        if (op !== null) return op;
        LogBody.actionlessKind({ op, attrs: row.attrs });
        return "attempt";
    }

    static base(coordinate: string): string {
        return coordinate.replace(/^(\/?\d+\/\d+\/\d+)\/[^/]*$/, "$1");
    }

    static coordinate(coordinate: string, row: LogEntryProjectionRow): string {
        const base = LogEntryProjection.base(coordinate);
        return `${base}/${LogEntryProjection.leaf(row)}`;
    }

    static accepts(suffix: string | null, row: LogEntryProjectionRow): boolean {
        if (suffix === null) return true;
        return suffix.toLocaleLowerCase("en-US")
            === LogEntryProjection.leaf(row).toLocaleLowerCase("en-US");
    }

}
