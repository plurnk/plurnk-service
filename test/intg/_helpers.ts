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
