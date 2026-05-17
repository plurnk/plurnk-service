// log.read — return recent log entries filterable by loop / turn / since-id,
// scoped to the connection's attached session. SPEC §13.5.

import type { DatabaseSync } from "node:sqlite";
import type MethodRegistry from "../MethodRegistry.ts";
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

const fetchLogEntries = (db: DatabaseSync, runId: number, filters: Params): LogEntryWire[] => {
    const conditions: string[] = ["run_id = ?"];
    const params: number[] = [runId];

    if (typeof filters.loopId === "number") {
        conditions.push("loop_id = ?");
        params.push(filters.loopId);
    }
    if (typeof filters.turnId === "number") {
        conditions.push("turn_id = ?");
        params.push(filters.turnId);
    }
    if (typeof filters.sinceId === "number") {
        conditions.push("id > ?");
        params.push(filters.sinceId);
    }

    const limit = Math.min(typeof filters.limit === "number" ? filters.limit : DEFAULT_LIMIT, MAX_LIMIT);

    const sql = `SELECT id FROM log_entries WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit) as Array<{ id: number }>;
    return rows.map((r) => fetchLogEntry(db, r.id));
};

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("log.read", {
        handler: async (params, ctx) => {
            if (ctx.session === null) throw new Error("log.read requires an attached session");
            const p = (params ?? {}) as Params;
            const entries = fetchLogEntries(ctx.db, ctx.session.runId, p);
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
