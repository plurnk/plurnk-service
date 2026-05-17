import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Migrator from "../../src/core/Migrator.ts";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export const openMigrated = async (): Promise<DatabaseSync> => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    await new Migrator({ db, dir: MIGRATIONS_DIR }).migrate();
    return db;
};

export const insertSession = (db: DatabaseSync, name: string): number => {
    const row = db.prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id").get(name) as { id: number };
    return row.id;
};

export const insertRun = (db: DatabaseSync, sessionId: number, parentRunId: number | null = null): number => {
    const row = db
        .prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?) RETURNING id")
        .get(sessionId, parentRunId) as { id: number };
    return row.id;
};

export const insertLoop = (db: DatabaseSync, runId: number, sequence: number, prompt: string = ""): number => {
    const row = db
        .prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?) RETURNING id")
        .get(runId, sequence, prompt) as { id: number };
    return row.id;
};

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", turn: "", system_requirements: "" },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

export const insertTurn = (db: DatabaseSync, loopId: number, sequence: number, status: number = 200): number => {
    const row = db
        .prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?) RETURNING id")
        .get(loopId, sequence, status, MIN_PACKET) as { id: number };
    return row.id;
};

export const seedEnvelope = (db: DatabaseSync, label: string): {
    sessionId: number; runId: number; loopId: number; turnId: number;
} => {
    const sessionId = insertSession(db, label);
    const runId = insertRun(db, sessionId);
    const loopId = insertLoop(db, runId, 1);
    const turnId = insertTurn(db, loopId, 1);
    return { sessionId, runId, loopId, turnId };
};
