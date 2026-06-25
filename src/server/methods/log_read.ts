// log.read — return recent log entries filterable by loop / turn / since-id,
// scoped to the connection's attached session. SPEC §methods.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";
import LogEntry from "../logEntry.ts";
import type { LogEntryWire } from "../logEntry.ts";

interface Params {
    runId?: number;
    loopId?: number;
    turnId?: number;
    sinceId?: number;
    limit?: number;
    // #271 — target by DISPLAY coordinate (loop_seq/turn_seq/op-sequence) instead of
    // DB ids; a full triple resolves the single entry behind a `L/T/S` waterfall line.
    loopSeq?: number;
    turnSeq?: number;
    sequence?: number;
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
            loop_seq: typeof filters.loopSeq === "number" ? filters.loopSeq : null,
            turn_seq: typeof filters.turnSeq === "number" ? filters.turnSeq : null,
            sequence: typeof filters.sequence === "number" ? filters.sequence : null,
            limit,
        });
        const entries: LogEntryWire[] = [];
        for (const r of rows) entries.push(await LogEntry.fetchLogEntry(db, r.id));
        return entries;
    }

    static register(registry: MethodRegistry): void {
        registry.registerMethod("log.read", { // §methods-log-read
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("log.read requires an attached session");
                const p = params as Params;
                // Default to the connection's own run; an explicit runId targets any
                // run in the session — the MODEL run for a conversation client (#214, §machine-processes-model-run-readable) —
                // ownership-verified so a client can't read a run outside its session.
                let runId = ctx.session.runId;
                if (typeof p.runId === "number" && p.runId !== runId) {
                    const target = await (ctx.db.envelope_get_run_by_id as PrepMethod).get<{ session_id: number }>({ id: p.runId });
                    if (target === undefined) throw new Error(`run ${p.runId} not found`);
                    if (target.session_id !== ctx.session.sessionId) throw new Error(`run ${p.runId} is not in this session`);
                    runId = p.runId;
                }
                const entries = await LogReadMethod.#fetchLogEntries(ctx.db, runId, p);
                return { status: 200, entries };
            },
            description: "Read recent log entries from the attached session, optionally filtered. Pass the full display coordinate (loopSeq+turnSeq+sequence) to resolve the single entry behind an `L/T/S` waterfall line — the full shape (tx + rx), no client-side fetch-all+match (#271).",
            params: {
                runId: "number? — read another run in this session (the model run for a conversation client); defaults to the connection's own run",
                loopId: "number? — filter to one loop",
                turnId: "number? — filter to one turn (within whatever loop)",
                sinceId: "number? — return entries with id > sinceId (for incremental fetch)",
                loopSeq: "number? — filter by loop display ordinal (the L in L/T/S)",
                turnSeq: "number? — filter by turn display ordinal (the T in L/T/S)",
                sequence: "number? — filter by op display ordinal (the S in L/T/S); loopSeq+turnSeq+sequence together target one entry",
                limit: "number? — max entries to return (default 100, max 1000)",
            },
            requiresInit: true,
        });
    }
}
