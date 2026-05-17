import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATION_PATTERN = /^\d+_.+\.sql$/;

export default class Migrator {
    #db: DatabaseSync;
    #dir: string;

    constructor({ db, dir }: { db: DatabaseSync; dir: string }) {
        this.#db = db;
        this.#dir = dir;
        this.#ensureMeta();
    }

    #ensureMeta(): void {
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS applied_migrations (
                id         TEXT NOT NULL PRIMARY KEY,
                applied_at TEXT NOT NULL
            ) STRICT, WITHOUT ROWID;
        `);
    }

    async migrate({ signal }: { signal?: AbortSignal } = {}): Promise<{ applied: string[]; skipped: string[] }> {
        const entries = await readdir(this.#dir);
        const files = entries.filter((f) => MIGRATION_PATTERN.test(f)).toSorted();
        const applied: string[] = [];
        const skipped: string[] = [];
        const existsStmt = this.#db.prepare("SELECT 1 FROM applied_migrations WHERE id = ?");
        const insertStmt = this.#db.prepare("INSERT INTO applied_migrations (id, applied_at) VALUES (?, ?)");
        for (const file of files) {
            signal?.throwIfAborted();
            const id = file.replace(/\.sql$/, "");
            if (existsStmt.get(id) !== undefined) { skipped.push(id); continue; }
            const sql = await readFile(join(this.#dir, file), "utf8");
            this.#db.exec("BEGIN");
            try {
                this.#db.exec(sql);
                insertStmt.run(id, new Date().toISOString());
                this.#db.exec("COMMIT");
            } catch (cause) {
                this.#db.exec("ROLLBACK");
                throw new Error(`Migration ${id} failed`, { cause });
            }
            applied.push(id);
        }
        return { applied, skipped };
    }

    listApplied(): { id: string; applied_at: string }[] {
        return this.#db
            .prepare("SELECT id, applied_at FROM applied_migrations ORDER BY id")
            .all() as { id: string; applied_at: string }[];
    }
}
