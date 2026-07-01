import test, { afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "./Sqlite.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: string | undefined;
    states: string[];
    events: TelemetryEvent[];
}

const run = async (command: string, target: string | null = null, cwd: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime: "sqlite", command, cwd, target,
        signal: new AbortController().signal,
        write: (_channel, chunk) => { out = (out ?? "") + chunk; },
        setState: (_channel, state) => states.push(state),
        emit: (event) => events.push(event),
    };
    const result = await new Sqlite({ runtime: "sqlite", glyph: "🗃" }).run(args);
    return { result, out, states, events };
};

// Unique temp db path per use; cleaned up after each test.
let dbPath: string | null = null;
const tempDb = (): string => (dbPath = join(tmpdir(), `execs-sqlite-${process.hrtime.bigint()}.db`));
afterEach(async () => { if (dbPath) { await rm(dbPath, { force: true }); dbPath = null; } });

test("manifest declares the sqlite runtime tag", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["sqlite"]);
    // #7: the tag carries a one-line self-documenting example for the tools sheet
    // — a file-target db, since the sysprompt already shows a naked :memory: form.
    assert.equal(pkg.plurnk.runtimes[0].example, "<<EXEC[sqlite](./app.db):SELECT count(*) FROM users:EXEC");
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

test("a relative target resolves the db against cwd, not the process dir (#15)", async () => {
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

test("SQL error → sqlite_error telemetry, errored channel, 500", async () => {
    const { result, states, events } = await run("SELECT * FROM does_not_exist");
    assert.equal(result.status, 500);
    assert.equal(events[0].source, "exec:sqlite");
    assert.equal(events[0].kind, "sqlite_error");
    assert.equal(states.at(-1), "errored");
});

test("syntax error → sqlite_error, 500", async () => {
    const { result, events } = await run("SELEKT oops");
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "sqlite_error");
});

// SPEC §6 — must honor args.signal. sqlite is synchronous, so a pre-aborted
// signal is honored at entry: the file-backed mutation never runs (the db file
// is never created), and the channel closes errored with 499.
test("pre-aborted signal → 499 errored, file mutation skipped", async () => {
    const path = tempDb();
    const ac = new AbortController();
    ac.abort();
    const states: string[] = [];
    let wrote = false;
    const args: ExecArgs = {
        runtime: "sqlite", command: "CREATE TABLE t (x)", cwd: null, target: path,
        signal: ac.signal,
        write: () => { wrote = true; },
        setState: (_channel, state) => states.push(state),
        emit: () => {},
    };
    const result = await new Sqlite({ runtime: "sqlite", glyph: "🗃" }).run(args);
    assert.equal(result.status, 499);
    assert.equal(wrote, false);
    assert.deepEqual(states, ["errored"]);
    await assert.rejects(readFile(path), { code: "ENOENT" });
});
