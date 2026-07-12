import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

const MEMORY = ":memory:";

// Resolve the EXEC (target) slot to a db path: a relative target resolves
// against cwd (the workspace, plurnk-execs#15); null — or an explicit
// `:memory:` — means no file target → an ephemeral in-memory db.
const dbPath = (cwd: string | null, target: string | null): string => {
    if (target === null || target === MEMORY) return MEMORY;
    return isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target);
};

// node:sqlite can return bigint for large integers; stringify them so the
// JSON output is always serializable.
const jsonReplacer = (_key: string, value: unknown): unknown =>
    (typeof value === "bigint" ? value.toString() : value);

// In-process SQLite executor (a logical runtime, not subprocess). Runs one SQL
// statement via node:sqlite against the EXEC target db — defaulting to an
// ephemeral `:memory:` when no target is given — and writes the result to the
// `results` channel as application/json, ready for the jsonpath body-matcher.
//
//   <<EXEC[sqlite]:SELECT * FROM users:EXEC          → :memory: (ephemeral)
//   <<EXEC[sqlite](./app.db):SELECT * FROM users:EXEC → ./app.db (persistent)
//
// Row-returning statements (SELECT, RETURNING, PRAGMA) write an array of row
// objects; mutations write `{ changes, lastInsertRowid }`. The query/mutation
// split is decided by `columns()` — never by parsing the SQL.
//
// NOTE: `effect()` (per-runtime proposal gating; :memory:→pure, file→host) is
// pending the contract addition in plurnk-service#182 and lands when that does.
export default class Sqlite extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Always available — node:sqlite is a Node 25 builtin, in-process.
    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "node:sqlite" };
    }

    // :memory: (and no target) is pure; a file-backed db mutates the host.
    // Classified by the target only — never by inspecting the SQL.
    override effect(target: string | null): Effect {
        return target === null || target === MEMORY ? "pure" : "host";
    }

    async run({ command, cwd, target, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        // node:sqlite is fully synchronous — no await point to interrupt mid-query —
        // so the only place to honor an abort is before the work starts (SPEC §6).
        // Matters for a file-backed (host) statement: a cancel/KILL that lands first
        // must not still mutate the db.
        if (signal.aborted) { setState("results", "errored"); return { status: 499 }; }
        const path = dbPath(cwd, target);
        const sql = command.trim();
        const fail = (kind: string, message: string): ExecResult => {
            emit({ source: "exec:sqlite", kind, message });
            setState("results", "errored");
            return { status: 500 };
        };

        let db: DatabaseSync;
        try {
            db = new DatabaseSync(path);
        } catch (err) {
            return fail("sqlite_open_failed", `cannot open database '${path}': ${(err as Error).message}`);
        }
        try {
            const stmt = db.prepare(sql);
            // Non-empty columns ⇒ a row-returning statement; empty ⇒ a mutation.
            const output: unknown = stmt.columns().length > 0 ? stmt.all() : stmt.run();
            write("results", JSON.stringify(output, jsonReplacer));
            setState("results", "closed");
            return { status: 200 };
        } catch (err) {
            return fail("sqlite_error", `${(err as Error).message}; db='${path}'`);
        } finally {
            db.close();
        }
    }
}
