import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { Share } from "@plurnk/plurnk-digest";
import { sqlFunctionPaths } from "../src/core/sql-functions.ts";

const sourceDirectory = resolve(import.meta.dirname, "../src");
const failure = (error) => ({ error: error instanceof Error ? error.message : String(error) });

// {§db-query-report}: these are conservative hints, not a SQL parser or a verdict.
export const scanKind = (detail, schema) => {
    const scan = /^SCAN (\S+)/u.exec(detail);
    if (scan === null) return null;
    if (/VIRTUAL TABLE/u.test(detail)) return "virtual";
    if (/USING (?:COVERING )?INDEX/u.test(detail)) return "indexed";
    return schema.get(scan[1]) ?? "unresolved";
};

const validateSpecimens = (specimens) => {
    if (!Array.isArray(specimens)) throw new Error("SQL specimens must be an array");
    for (const specimen of specimens) {
        if (typeof specimen?.statement !== "string" || specimen.statement.length === 0) {
            throw new Error("each SQL specimen must name a PREP statement");
        }
        if (specimen.parameters === null || typeof specimen.parameters !== "object" || Array.isArray(specimen.parameters)) {
            throw new Error(`${specimen.statement}: parameters must be an object`);
        }
    }
};

const queryPlan = (db, sql, parameters) => {
    const query = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    return parameters === undefined ? query.all() : query.all(SqlRiteCore.jsonify(parameters));
};

// {§db-query-report}: no daemon, migrations, INIT blocks, automatic corpus selection, or writes to evidence.
export const inspectSql = async (path, specimens = [], directory = sourceDirectory) => {
    validateSpecimens(specimens);
    const chunks = SqlRiteCore.loadChunks({ dir: directory }).PREP;
    const registry = new Map(chunks.map((chunk) => [chunk.name, chunk]));
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-sql-report-"));
    try {
        const copy = join(scratch, "plurnk.db");
        Share.snapshot(path, copy);
        using db = SqlRiteCore.openDb({ path: copy });
        SqlRiteCore.initDb(db);
        await SqlRiteCore.registerFunctions(db, sqlFunctionPaths);
        db.exec("PRAGMA query_only = ON;");
        const schema = new Map(db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view')").all().map(({ name, type }) => [name, type]));
        const plans = [...registry.values()].map(({ name, sql }) => {
            try {
                const plan = queryPlan(db, sql);
                const scans = plan.flatMap(({ id, detail }) => {
                    const kind = scanKind(detail, schema);
                    return kind === null ? [] : [{ id, kind, detail }];
                });
                return { statement: name, plan, scans };
            } catch (error) {
                return { statement: name, ...failure(error) };
            }
        });
        const measurements = specimens.map(({ statement, parameters }) => {
            try {
                const chunk = registry.get(statement);
                if (chunk === undefined) throw new Error(`unknown PREP: ${statement}`);
                const plan = queryPlan(db, chunk.sql, parameters);
                const query = db.prepare(chunk.sql);
                if (chunk.bigint) query.setReadBigInts(true);
                const bound = SqlRiteCore.jsonify(parameters);
                const start = performance.now();
                const rows = query.iterate(bound).reduce((count) => count + 1, 0);
                return { statement, parameters, plan, rows, milliseconds: performance.now() - start };
            } catch (error) {
                return { statement, parameters, ...failure(error) };
            }
        });
        return {
            database: {
                source: resolve(path),
                schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
                sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get().version,
            },
            plans,
            measurements,
        };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [path, specimensPath, ...extra] = process.argv.slice(2);
        if (path === undefined || extra.length > 0) throw new Error("usage: report:sql <database.db> [specimens.json]");
        const specimens = specimensPath === undefined ? [] : JSON.parse(await readFile(specimensPath, "utf8"));
        const report = await inspectSql(path, specimens);
        console.log(JSON.stringify(report, null, 2));
        if ([...report.plans, ...report.measurements].some((row) => row.error !== undefined)) process.exitCode = 1;
    } catch (error) {
        console.error(`SQL report unavailable: ${failure(error).error}`);
        process.exitCode = 1;
    }
}
