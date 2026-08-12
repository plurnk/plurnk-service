import { isAbsolute, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { BaseExecutor, ErrorDetail, renderJsonResult, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

const MEMORY = ":memory:";

// Resolve the EXEC (target) slot to a db path: a relative target resolves
// against cwd ({§executor-sinks}); null — or an explicit
// `:memory:` — means no file target → an ephemeral in-memory db.
const dbPath = (cwd: string | null, target: string | null): string => {
    if (target === null || target === MEMORY) return MEMORY;
    return isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target);
};

// node:sqlite can return bigint for large integers; stringify them so the
// JSON output is always serializable.
const jsonReplacer = (_key: string, value: unknown): unknown =>
    (typeof value === "bigint" ? value.toString() : value);

// SQL line (`-- …`) and block (`/* … */`) comments, for judging whether a
// post-statement tail holds real SQL or just trivia.
const stripComments = (sql: string): string =>
    sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

// In-process SQLite executor (a logical runtime, not subprocess). Runs one SQL
// statement via node:sqlite against the EXEC target db — defaulting to an
// ephemeral `:memory:` when no target is given — and writes the result to the
// `results` channel as application/json, ready for the jsonpath body-matcher.
//
//   ## EXEC1 [sqlite]\nSELECT * FROM users          → :memory: (ephemeral)
//   ## EXEC1 [sqlite] (./app.db)\nSELECT * FROM users → ./app.db (persistent)
//
// Row-returning statements (SELECT, RETURNING, PRAGMA) write an array of row
// objects; mutations write `{ changes, lastInsertRowid }`. The query/mutation
// split is decided by `columns()` — never by parsing the SQL.
//
export default class Sqlite extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Always available in the package's supported Node >=26 runtime.
    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "node:sqlite" };
    }

    // :memory: (and no target) is pure; a file-backed db mutates the host.
    // Classified by the target only — never by inspecting the SQL.
    override effect(target: string | null): Effect {
        return target === null || target === MEMORY ? "pure" : "host";
    }

    async run({ command, cwd, target, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        // node:sqlite is fully synchronous — no await point to interrupt mid-query —
        // so the only place to honor an abort is before the work starts
        // ({§executor-cancellation}).
        // Matters for a file-backed (host) statement: a cancel/KILL that lands first
        // must not still mutate the db.
        if (signal.aborted) {
            setState("results", "errored");
            return Results.failure(
                "executor:sqlite",
                "cancelled",
                499,
                "SQLite execution was cancelled.",
                {},
                {
                    stage: "execution",
                    retryable: false,
                },
            );
        }
        const path = dbPath(cwd, target);
        const sql = command.trim();
        const errorPreview = ErrorDetail.configuredLimit();
        const fail = (
            kind: string,
            message: string,
            status = 500,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:sqlite",
                kind,
                status,
                message,
                {},
                {
                    database: path,
                    ...extensions,
                },
            );
        };
        if (errorPreview === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:sqlite");
        }

        let db: DatabaseSync;
        try {
            db = new DatabaseSync(path);
        } catch (err) {
            return fail(
                "sqlite-open-failed",
                `SQLite could not open '${path}': ${ErrorDetail.preview(err, errorPreview)}`,
                500,
                {
                    stage: "open",
                    recovery: "Use an accessible SQLite database target.",
                },
            );
        }
        let stmt: StatementSync;
        try {
            stmt = db.prepare(sql);
        } catch (err) {
            db.close();
            return fail(
                "sqlite-invalid-statement",
                `SQLite could not prepare the statement: ${ErrorDetail.preview(err, errorPreview)}`,
                400,
                {
                    stage: "prepare",
                    recovery: "Correct the SQL statement.",
                    retryable: false,
                },
            );
        }
        try {
            // One statement per op is the contract (the results channel is one JSON
            // doc) — but SQLite's prepare compiles only the FIRST statement and
            // silently ignores the rest, so a sqlite3-CLI-style script would
            // partially execute under a 200. sourceSQL is the compiled
            // statement's own text: any real SQL left after it is a dropped tail —
            // fail-hard, never truncate silently. Trailing whitespace/comments pass.
            const tail = stripComments(sql.slice(stmt.sourceSQL.length)).trim();
            if (tail !== "") {
                return fail("sqlite-multi-statement",
                    "SQLite execution accepts exactly one statement, but the command contains a second statement.",
                    400,
                    {
                        stage: "prepare",
                        rejectedTail: ErrorDetail.preview(tail, errorPreview),
                        recovery: "Run each SQL statement in a separate operation.",
                        retryable: false,
                    });
            }
            // Non-empty columns ⇒ a row-returning statement; empty ⇒ a mutation.
            const output: unknown = stmt.columns().length > 0 ? stmt.all() : stmt.run();
            write("results", renderJsonResult(output, jsonReplacer));
            setState("results", "closed");
            return { status: 200 };
        } catch (err) {
            return fail(
                "sqlite-error",
                `SQLite could not execute the statement: ${ErrorDetail.preview(err, errorPreview)}`,
                500,
                {
                    stage: "execution",
                },
            );
        } finally {
            db.close();
        }
    }
}
