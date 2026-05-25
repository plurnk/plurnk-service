import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";

// Test helper: build a PlurnkSchemeContext with sensible defaults. Override
// any field via the argument. Tests that don't exercise db ops can omit it
// (File.read, etc); the unset slot is a tripwire — any unexpected db access
// crashes with a clear TypeError.
export const makeSchemeCtx = (overrides: Partial<PlurnkSchemeContext> = {}): PlurnkSchemeContext => ({
    db: undefined as unknown as Db,
    sessionId: 0,
    runId: 0,
    loopId: 0,
    turnId: 0,
    writer: "model",
    signal: undefined,
    ...overrides,
});

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "migrations");
const TMP_DIR = resolve(PROJECT_ROOT, "test/intg/.tmp");

// File-backed per-test DB so on-disk consumers (digest tool, future
// forensics) exercise the same artifacts the suite produces. `:memory:`
// hid a column-rename regression in bin/digest.js for an unknown number
// of PRs. Per-test UUID filenames eliminate parallel collisions; close()
// is hooked to unlink the file and its WAL sidecars on teardown so the
// .tmp/ dir stays clean across runs.
export const openMigrated = async (): Promise<Db> => {
    await mkdir(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, `db-${crypto.randomUUID()}.db`);
    const db = (await SqlRite.open({
        path: dbPath,
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
    })) as unknown as Db;
    const originalClose = db.close.bind(db);
    db.close = async () => {
        await originalClose();
        await Promise.all([
            rm(dbPath, { force: true }),
            rm(`${dbPath}-wal`, { force: true }),
            rm(`${dbPath}-shm`, { force: true }),
        ]);
    };
    return db;
};

export const insertSession = async (db: Db, name: string): Promise<number> => {
    const row = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertSession: insert returned no row");
    return row.id;
};

let runCounter = 0;
export const insertRun = async (db: Db, sessionId: number, parentRunId: number | null = null, name?: string): Promise<number> => {
    const row = await (db.test_insert_run as PrepMethod).get<{ id: number }>({
        session_id: sessionId, name: name ?? `run-test-${++runCounter}-${Math.random().toString(36).slice(2, 8)}`, parent_run_id: parentRunId,
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
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", telemetry: { budget: "", errors: [] }, system_requirements: "" },
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
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
