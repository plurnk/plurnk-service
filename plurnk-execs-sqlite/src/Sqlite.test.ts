import test, { afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "./Sqlite.ts";
import { ERROR_DETAIL_LIMIT } from "@plurnk/plurnk-execs";
import type { ExecArgs, ExecResult, Notice } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: string | undefined;
    states: string[];
    events: Notice[];
}

const run = async (command: string, target: string | null = null, cwd: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: Notice[] = [];
    const args: ExecArgs = {
        runtime: "sqlite", body: command, cwd, target,
        signal: new AbortController().signal,
        write: (_channel, chunk) => { out = (out ?? "") + chunk; },
        setState: (_channel, state) => states.push(state),
        emit: (event) => events.push(event),
        interact: async () => ({ status: "cancelled" }),
    };
    const result = await new Sqlite({ runtime: "sqlite", glyph: "🗃" }).run(args);
    return { result, out, states, events };
};

// Unique temp db path per use; cleaned up after each test.
let dbPath: string | null = null;
const originalErrorPreview = process.env[ERROR_DETAIL_LIMIT];
const tempDb = (): string => (dbPath = join(tmpdir(), `execs-sqlite-${process.hrtime.bigint()}.db`));
afterEach(async () => {
    if (dbPath) {
        await rm(dbPath, { force: true });
        dbPath = null;
    }
    if (originalErrorPreview === undefined) delete process.env[ERROR_DETAIL_LIMIT];
    else process.env[ERROR_DETAIL_LIMIT] = originalErrorPreview;
});

test("manifest declares the sqlite runtime tag", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["sqlite"]);
    assert.deepEqual(pkg.plurnk.runtimes[0].invocation, {
        body: { role: "SQL statement", required: true },
        target: { role: "SQLite database", required: false, kind: "path" },
        example: { target: "app.db", body: "SELECT 1;" },
    });
});

test("declares a results channel (application/json)", () => {
    assert.deepEqual(new Sqlite({ runtime: "sqlite", glyph: "🗃" }).channels, {
        results: { mimetype: "application/json" },
    });
});

test("probe: always available via node:sqlite", async () => {
    assert.deepEqual(await new Sqlite({ runtime: "sqlite", glyph: "🗃" }).probe(), {
        available: true, detail: "node:sqlite",
    });
});

test("effect: :memory:/no-target → pure; file → host (target-classified)", () => {
    const ex = new Sqlite({ runtime: "sqlite", glyph: "🗃" });
    assert.equal(ex.effect(null), "pure");
    assert.equal(ex.effect(":memory:"), "pure");
    assert.equal(ex.effect("./app.db"), "host");
});

test("SELECT against default :memory: → rows as JSON, channel closed, 200", async () => {
    const { result, out, states, events } = await run("SELECT 1 AS one, 'hi' AS two");
    assert.deepEqual(result, { status: 200 });
    assert.deepEqual(JSON.parse(out!), [{ one: 1, two: "hi" }]);
    assert.deepEqual(states, ["closed"]);
    assert.equal(events.length, 0);
});

test("a relative target resolves the database against cwd, not the process dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "execs-sqlite-cwd-"));
    try {
        // relative target + cwd → the db file must land inside cwd (the workspace),
        // not the daemon's process dir. Resolves solely via cwd.
        const create = await run("CREATE TABLE t(x)", "app.db", dir);
        assert.equal(create.result.status, 200);
        assert.deepEqual(await readdir(dir), ["app.db"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("mutation round-trip against a file db: CREATE, INSERT (changes), SELECT (rows)", async () => {
    const db = tempDb();
    const create = await run("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", db);
    assert.equal(create.result.status, 200);

    const insert = await run("INSERT INTO t(name) VALUES ('alice')", db);
    assert.equal(insert.result.status, 200);
    assert.deepEqual(JSON.parse(insert.out!), { changes: 1, lastInsertRowid: 1 });

    const select = await run("SELECT * FROM t", db);
    assert.deepEqual(JSON.parse(select.out!), [{ id: 1, name: "alice" }]);
});

test("invalid SQL reference -> durable prepare Problem, errored channel, 400", async () => {
    const { result, states, events } = await run("SELECT * FROM does_not_exist");
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/sqlite/sqlite-invalid-statement");
    assert.match(result.problem?.detail ?? "", /does_not_exist/);
    assert.equal(result.problem?.recovery, "Correct the SQL statement.");
    assert.equal(events.length, 0);
    assert.equal(states.at(-1), "errored");
});

test("syntax error -> sqlite_invalid_statement, 400", async () => {
    const { result, events } = await run("SELEKT oops");
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/sqlite/sqlite-invalid-statement");
    assert.match(result.problem?.detail ?? "", /near "SELEKT"/);
    assert.equal(result.problem?.recovery, "Correct the SQL statement.");
    assert.equal(events.length, 0);
});

// SQLite prepare compiles only the first statement; a sqlite3-CLI-style
// script would partially execute under a 200. The contract is one statement per
// op, ENFORCED: a real SQL tail fails hard instead of silently dropping.
test("multi-statement script → sqlite_multi_statement, 400, nothing truncated silently", async () => {
    const { result, events, states } = await run("CREATE TABLE t(x); INSERT INTO t VALUES(1)");
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/sqlite/sqlite-multi-statement");
    assert.match(result.problem?.detail ?? "", /exactly one statement/);
    assert.equal(result.problem?.rejectedTail, "INSERT INTO t VALUES(1)");
    assert.equal(result.problem?.recovery, "Run each SQL statement in a separate operation.");
    assert.equal(events.length, 0);
    assert.equal(states.at(-1), "errored");
});

test("the configured error preview bounds rejected SQL facts", async () => {
    process.env[ERROR_DETAIL_LIMIT] = "6";
    const { result } = await run("SELECT 1; SECOND LONG STATEMENT");

    assert.equal(result.status, 400);
    assert.equal(result.problem?.rejectedTail, "SECOND...");
});

test("an invalid error preview is an exact configuration Problem", async () => {
    process.env[ERROR_DETAIL_LIMIT] = "-2";
    const { result } = await run("SELECT 1");

    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/sqlite/invalid-configuration");
    assert.equal(result.problem?.configuration, ERROR_DETAIL_LIMIT);
    assert.equal(result.problem?.stage, "configuration");
});

test("a trailing semicolon and trailing comments are NOT a second statement", async () => {
    const semi = await run("SELECT 1 AS one;");
    assert.equal(semi.result.status, 200);
    const comment = await run("SELECT 1 AS one; -- done\n/* trailing block */");
    assert.equal(comment.result.status, 200);
});

// {§executor-cancellation} requires honoring args.signal. sqlite is synchronous, so a pre-aborted
// signal is honored at entry: the file-backed mutation never runs (the db file
// is never created), and the channel closes errored with 499.
test("pre-aborted signal → 499 errored, file mutation skipped", async () => {
    const path = tempDb();
    const ac = new AbortController();
    ac.abort();
    const states: string[] = [];
    let wrote = false;
    const args: ExecArgs = {
        runtime: "sqlite", body: "CREATE TABLE t (x)", cwd: null, target: path,
        signal: ac.signal,
        write: () => { wrote = true; },
        setState: (_channel, state) => states.push(state),
        emit: () => {},
        interact: async () => ({ status: "cancelled" }),
    };
    const result = await new Sqlite({ runtime: "sqlite", glyph: "🗃" }).run(args);
    assert.equal(result.status, 499);
    assert.equal(wrote, false);
    assert.deepEqual(states, ["errored"]);
    await assert.rejects(readFile(path), { code: "ENOENT" });
});
