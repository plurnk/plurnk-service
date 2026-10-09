import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { inspectSql, scanKind } from "./sql-report.mjs";

const exec = promisify(execFile);

const fixture = async (run) => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-sql-report-test-"));
    const path = join(folder, "workload.db");
    const db = SqlRiteCore.openDb({ path });
    SqlRiteCore.initDb(db);
    try {
        db.exec("CREATE TABLE facts (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO facts VALUES (1, 'one'), (2, 'two'); PRAGMA user_version=7;");
        await run({ path, db, folder });
    } finally {
        db.close();
        await rm(folder, { recursive: true, force: true });
    }
};

test("{§db-query-report} plans mutations but measures only read queries on a consistent private snapshot", async () => {
    await fixture(async ({ path, db, folder }) => {
        const source = join(folder, "queries.sql");
        await writeFile(source, `-- PREP: read_fact
SELECT body, sha256(body) AS hash FROM facts WHERE id=:id;
-- PREP: remove_facts
DELETE FROM facts;
-- PREP: empty_read
SELECT body FROM facts WHERE id=-1;
-- PREP: registered_functions
SELECT content_weight(body), glob_match(body, '*'), body REGEXP 'o', uuid() FROM facts;
`);
        const before = await readFile(path);
        const report = await inspectSql(path, [
            { statement: "read_fact", parameters: { id: 1 } },
            { statement: "remove_facts", parameters: {} },
            { statement: "empty_read", parameters: {} },
            { statement: "registered_functions", parameters: {} },
        ], folder);
        assert.equal(report.database.schemaVersion, 7, "report does not migrate the snapshot");
        assert.equal(report.plans.length, 4);
        assert.ok(report.plans.every((row) => row.error === undefined));
        assert.match(report.plans.find((row) => row.statement === "read_fact").plan[0].detail, /SEARCH facts USING INTEGER PRIMARY KEY/);
        assert.equal(report.measurements[0].rows, 1, "uncheckpointed source rows survive the snapshot");
        assert.ok(report.measurements[0].milliseconds >= 0);
        assert.ok(report.measurements[0].plan.length > 0, "a measured query retains its bound plan");
        assert.match(report.measurements[1].error, /readonly database/i);
        assert.equal(report.measurements[1].rows, undefined, "a rejected measurement is not zero rows");
        assert.equal(report.measurements[2].rows, 0);
        assert.equal(report.measurements[3].rows, 2, "a refused mutation cannot change later observations");
        assert.equal(db.prepare("SELECT count(*) AS n FROM facts").get().n, 2);
        assert.deepEqual(await readFile(path), before, "source database bytes stay intact");
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
    });
});

test("{§db-query-report} missing schema and invalid specimens remain visible failures", async () => {
    await fixture(async ({ path, folder }) => {
        await writeFile(join(folder, "queries.sql"), "-- PREP: absent\nSELECT body FROM missing_table;\n");
        const report = await inspectSql(path, [{ statement: "unknown", parameters: {} }], folder);
        assert.match(report.plans[0].error, /no such table: missing_table/);
        assert.match(report.measurements[0].error, /unknown PREP: unknown/);
        await assert.rejects(inspectSql(path, [{ statement: "absent" }], folder), /parameters must be an object/);
        await assert.rejects(inspectSql(path, {}, folder), /specimens must be an array/);
        await assert.rejects(inspectSql(join(folder, "missing.db"), [], folder), /no database/);
    });
});

test("{§db-query-report} scan hints distinguish named base tables from indexed, virtual, and unresolved scans", () => {
    const schema = new Map([["facts", "table"], ["visible_facts", "view"]]);
    assert.equal(scanKind("SCAN facts", schema), "table");
    assert.equal(scanKind("SCAN facts USING COVERING INDEX by_body", schema), "indexed");
    assert.equal(scanKind("SCAN fts VIRTUAL TABLE INDEX 0:M1", schema), "virtual");
    assert.equal(scanKind("SCAN visible_facts", schema), "view");
    assert.equal(scanKind("SCAN f", schema), "unresolved");
    assert.equal(scanKind("SCAN (subquery-1)", schema), "unresolved");
    assert.equal(scanKind("SEARCH facts USING INTEGER PRIMARY KEY", schema), null);
});

test("{§db-query-report} real function definitions are used, not planner stubs", async () => {
    await fixture(async ({ path, folder }) => {
        await writeFile(join(folder, "queries.sql"), `-- PREP: exact_function
SELECT body FROM facts WHERE sha256(body)=:hash;
`);
        const report = await inspectSql(path, [{
            statement: "exact_function",
            parameters: { hash: createHash("sha256").update("two").digest("hex") },
        }], folder);
        assert.equal(report.measurements[0].rows, 1);
    });
});

test("{§db-query-report} CLI retains failed measurements and exits nonzero instead of reporting success", async () => {
    await fixture(async ({ path, folder }) => {
        const specimens = join(folder, "specimens.json");
        await writeFile(specimens, JSON.stringify([{ statement: "unknown_query", parameters: {} }]));
        await assert.rejects(exec(process.execPath, [
            "--conditions=plurnk-dev", join(import.meta.dirname, "sql-report.mjs"), path, specimens,
        ]), (error) => {
            assert.equal(error.code, 1);
            const report = JSON.parse(error.stdout);
            assert.equal(report.database.schemaVersion, 7);
            assert.equal(report.measurements[0].error, "unknown PREP: unknown_query");
            assert.ok(report.plans.some((plan) => plan.error !== undefined));
            return true;
        });
        await assert.rejects(exec(process.execPath, ["--conditions=plurnk-dev", join(import.meta.dirname, "sql-report.mjs")]), (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /usage: report:sql <database.db>/);
            assert.equal(error.stdout, "");
            return true;
        });
    });
});
