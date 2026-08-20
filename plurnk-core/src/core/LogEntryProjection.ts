interface LogEntryProjectionRow {
    readonly origin?: unknown;
    readonly op?: unknown;
    readonly attrs?: unknown;
}

// One owner for the model-facing identity of a durable log row. Storage keeps
// the event that happened; this projection names the operation the model can
// perform against the resulting row.
export default class LogEntryProjection {
    static #attrs(value: unknown): unknown {
        if (typeof value !== "string") return value;
        try {
            return JSON.parse(value) as unknown;
        } catch (cause) {
            throw new TypeError("A durable log row carries malformed attrs JSON.", { cause });
        }
    }

    static op(row: LogEntryProjectionRow): string | null {
        const op = typeof row.op === "string" && row.op.length > 0 ? row.op : null;
        const attrs = LogEntryProjection.#attrs(row.attrs);
        const materializedEntry = row.origin === "_plurnk" && op === "EDIT"
            && attrs !== null && typeof attrs === "object"
            && (attrs as { kind?: unknown }).kind === "entry_materialized";
        return materializedEntry ? "READ" : op;
    }

    static base(coordinate: string): string {
        return coordinate.replace(/\/[A-Za-z]*$/, "");
    }

    static coordinate(coordinate: string, row: LogEntryProjectionRow): string {
        const base = LogEntryProjection.base(coordinate);
        const op = LogEntryProjection.op(row);
        return op === null ? base : `${base}/${op}`;
    }

    static accepts(suffix: string | null, row: LogEntryProjectionRow): boolean {
        if (suffix === null) return true;
        const op = LogEntryProjection.op(row);
        return op !== null && suffix.toLocaleLowerCase("en-US") === op.toLocaleLowerCase("en-US");
    }
}
