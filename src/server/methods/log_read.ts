// log.read — return recent log entries filterable by loop / turn / since-id,
// scoped to the connection's attached session. SPEC §13.5.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";
import LogEntry from "../logEntry.ts";
import type { LogEntryWire } from "../logEntry.ts";

interface Params {
    loopId?: number;
    turnId?: number;
    sinceId?: number;
    limit?: number;
}

export default class LogReadMethod {
    static #DEFAULT_LIMIT = 100;
    static #MAX_LIMIT = 1000;

    static async #fetchLogEntries(db: Db, runId: number, filters: Params): Promise<LogEntryWire[]> {
        const limit = Math.min(typeof filters.limit === "number" ? filters.limit : LogReadMethod.#DEFAULT_LIMIT, LogReadMethod.#MAX_LIMIT);
        const rows = await (db.log_read_recent_ids as PrepMethod).all<{ id: number }>({
            run_id: runId,
            loop_id: typeof filters.loopId === "number" ? filters.loopId : null,
            turn_id: typeof filters.turnId === "number" ? filters.turnId : null,
            since_id: typeof filters.sinceId === "number" ? filters.sinceId : null,
            limit,
        });
        const entries: LogEntryWire[] = [];
        for (const r of rows) entries.push(await LogEntry.fetchLogEntry(db, r.id));
        return entries;
    }

    static register(registry: MethodRegistry): void {
        registry.registerMethod("log.read", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("log.read requires an attached session");
                const p = (params ?? {}) as Params;
                const entries = await LogReadMethod.#fetchLogEntries(ctx.db, ctx.session.runId, p);
                return { status: 200, entries };
            },
            description: "Read recent log entries from the attached session, optionally filtered.",
            params: {
                loopId: "number? — filter to one loop",
                turnId: "number? — filter to one turn (within whatever loop)",
                sinceId: "number? — return entries with id > sinceId (for incremental fetch)",
                limit: "number? — max entries to return (default 100, max 1000)",
            },
            requiresInit: true,
        });
    }
}
