import LogBody from "./LogBody.ts";
import { execRouteOf } from "../schemes/exec-runtime.ts";

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
        if (op === "EXEC") {
            const tx = LogEntryProjection.#decode(row.tx, "tx");
            const executor = tx !== null && typeof tx === "object"
                ? (tx as { executor?: unknown }).executor : undefined;
            if (executor !== null && (typeof executor !== "string" || executor.length === 0)) {
                throw new TypeError("An executor log row requires its durable submitted executor.");
            }
            return execRouteOf({ executor, target: null }).runtime;
        }
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
