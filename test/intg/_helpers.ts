import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Db, PrepMethod } from "../../src/core/Db.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "migrations");

export const openMigrated = async (): Promise<Db> => {
    const db = (await SqlRite.open({
        path: ":memory:",
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
    })) as unknown as Db;
    return db;
};

export const insertSession = async (db: Db, name: string): Promise<number> => {
    const row = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertSession: insert returned no row");
    return row.id;
};

export const insertRun = async (db: Db, sessionId: number, parentRunId: number | null = null): Promise<number> => {
    const row = await (db.test_insert_run as PrepMethod).get<{ id: number }>({
        session_id: sessionId, parent_run_id: parentRunId,
    });
    if (row === undefined) throw new Error("insertRun: insert returned no row");
    return row.id;
};

export const insertLoop = async (db: Db, runId: number, sequence: number, prompt: string = ""): Promise<number> => {
    const row = await (db.test_insert_loop as PrepMethod).get<{ id: number }>({
        run_id: runId, sequence, prompt,
    });
    if (row === undefined) throw new Error("insertLoop: insert returned no row");
    return row.id;
};

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", turn: "", system_requirements: "" },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

export const insertTurn = async (db: Db, loopId: number, sequence: number, status: number = 200): Promise<number> => {
    const row = await (db.test_insert_turn as PrepMethod).get<{ id: number }>({
        loop_id: loopId, sequence, status, packet: MIN_PACKET,
    });
    if (row === undefined) throw new Error("insertTurn: insert returned no row");
    return row.id;
};

export const seedEnvelope = async (db: Db, label: string): Promise<{
    sessionId: number; runId: number; loopId: number; turnId: number;
}> => {
    const sessionId = await insertSession(db, label);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    return { sessionId, runId, loopId, turnId };
};

// Seed an entry with one channel + visibility row, bypassing scheme handlers.
// Used by tests that need precise DB state for render / visibility / streaming
// assertions.
export const seedEntryWithChannel = async (
    db: Db,
    opts: {
        sessionId: number;
        runId?: number;
        scheme?: string;
        pathname?: string;
        channel?: string;
        content?: string;
        mimetype?: string;
        state?: "static" | "active" | "closed" | "errored";
        indexed?: 0 | 1;
    },
): Promise<number> => {
    const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
        session_id: opts.sessionId,
        scheme: opts.scheme ?? "known",
        pathname: opts.pathname ?? "x",
    });
    if (entry === undefined) throw new Error("seedEntryWithChannel: insert returned no row");
    await (db.test_seed_channel as PrepMethod).run({
        entry_id: entry.id,
        name: opts.channel ?? "body",
        content: opts.content ?? "",
        mimetype: opts.mimetype ?? "text/plain",
        state: opts.state ?? "static",
    });
    if (opts.runId !== undefined) {
        await (db.test_seed_visibility as PrepMethod).run({
            run_id: opts.runId,
            entry_id: entry.id,
            channel: opts.channel ?? "body",
            indexed: opts.indexed ?? 1,
        });
    }
    return entry.id;
};
