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

const run = async (command: string, cwd: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime: "sqlite", command, cwd,
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
    // #7: the tag carries a one-line self-documenting example for the tools sheet.
    assert.equal(pkg.plurnk.runtimes[0].example, "EXEC[sqlite]:SELECT count(*) FROM users:EXEC");
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

test("directory cwd (consumer project_root default) → :memory:, no file written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "execs-sqlite-root-"));
    try {
        const { result, out, states, events } = await run("SELECT 1 AS one", dir);
        assert.deepEqual(result, { status: 200 });
        assert.deepEqual(JSON.parse(out!), [{ one: 1 }]);
        assert.deepEqual(states, ["closed"]);
        assert.equal(events.length, 0);
        // :memory: is ephemeral — the directory must stay empty (no db file).
        assert.deepEqual(await readdir(dir), []);
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
