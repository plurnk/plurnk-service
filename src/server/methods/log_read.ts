// log.read — return recent log entries filterable by loop / turn / since-id,
// scoped to the connection's attached session. SPEC §13.5.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";
import { fetchLogEntry } from "../logEntry.ts";
import type { LogEntryWire } from "../logEntry.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface Params {
    loopId?: number;
    turnId?: number;
    sinceId?: number;
    limit?: number;
}

const fetchLogEntries = async (db: Db, runId: number, filters: Params): Promise<LogEntryWire[]> => {
    const limit = Math.min(typeof filters.limit === "number" ? filters.limit : DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await (db.log_read_recent_ids as PrepMethod).all<{ id: number }>({
        run_id: runId,
        loop_id: typeof filters.loopId === "number" ? filters.loopId : null,
        turn_id: typeof filters.turnId === "number" ? filters.turnId : null,
        since_id: typeof filters.sinceId === "number" ? filters.sinceId : null,
        limit,
    });
    const entries: LogEntryWire[] = [];
    for (const r of rows) entries.push(await fetchLogEntry(db, r.id));
    return entries;
};

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("log.read", {
        handler: async (params, ctx) => {
            if (ctx.session === null) throw new Error("log.read requires an attached session");
            const p = (params ?? {}) as Params;
            const entries = await fetchLogEntries(ctx.db, ctx.session.runId, p);
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
};
