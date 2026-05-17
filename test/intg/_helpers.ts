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
