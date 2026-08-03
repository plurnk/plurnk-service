import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import Envelope from "../../src/server/envelope.ts";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, KillStatement, PlanStatement, OpenStatement, FoldStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { target: ParsedPath }): ReadStatement => ({
    op: "READ", suffix: "",
    signal: null,
    target: opts.target,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

const killStmt = (opts: { target: ParsedPath; body?: string | null }): KillStatement => ({
    op: "KILL", suffix: "",
    signal: null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const planStmt = (opts: { body?: string | null }): PlanStatement => ({
    op: "PLAN", suffix: "",
    signal: null,
    target: null,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const openStmt = (opts: { target: ParsedPath | null; tags?: string[] }): OpenStatement => ({
    op: "OPEN", suffix: "", signal: opts.tags ?? null, target: opts.target,
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

const foldStmt = (opts: { target: ParsedPath; tags?: string[] }): FoldStatement => ({
    op: "FOLD", suffix: "", signal: opts.tags ?? null, target: opts.target,
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("Engine.dispatch: KILL against worker:/// permanently deletes the entry (200, then READ 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/obsolete/note"), body: "stale" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/obsolete/note") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200);
        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("worker", "/obsolete/note") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("worker:///x (authority form) folds to the same entry as worker:///x", async () => {
    const { db, engine, env } = await setup();
    try {
        // create via the path form: skill:///config.json => /config.json
        await engine.dispatch({
            statement: editStmt({ target: urlPath("skill", "/config.json"), body: "host=db.internal" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        // worker:///config.json => authority "config.json", empty path; #extractTarget folds it to /config.json,
        // the same entry the path form created. Without the fold the authority drops to "" and this 404s.
        const authForm: UrlPath = { kind: "url", raw: "skill://config.json", scheme: "skill", username: null, password: null, hostname: "config.json", port: null, pathname: "", query: null, fragment: null };
        const read = await engine.dispatch({
            statement: readStmt({ target: authForm }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL on a nonexistent entry returns 404", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/never/existed") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

test("Engine.dispatch: the KILL body annotation survives into the log row's tx (even on a 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/gone"), body: "superseded — see /final" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("KILL log_entry not found");
        assert.equal(log.op, "KILL");
        const tx = JSON.parse(log.tx) as { body: string | null };
        assert.equal(tx.body, "superseded — see /final");
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL against a non-running exec:/// returns 404 (nothing to kill)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("exec", "/sh/1/1/2") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

// {§model-entry-log-curation}
test("Engine.dispatch preserves log KILL's missing-coordinate failure", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/0") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "plurnk",
        });
        assert.equal(kill.status, 404, "a missing log coordinate remains not found");
    } finally { await db.close(); }
});

test("model-origin KILL passes the log write gate and erases the addressed row", async () => {
    const { db, engine, env } = await setup();
    try {
        // A real model-origin row at coordinate /1/1/1 (loop seq 1, turn seq 1, sequence 1).
        const plan = await engine.dispatch({
            statement: planStmt({ body: "obsolete goals to curate away" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "the model is authorized to erase its log item");
        const gone = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(gone.status, 404, "a second KILL proves the row was erased");
    } finally { await db.close(); }
});

test("Engine.dispatch: PLAN is a logged no-op (200) whose intended goals survive into the log row's tx", async () => {
    const { db, engine, env } = await setup();
    try {
        const plan = await engine.dispatch({
            statement: planStmt({ body: "capital of France is unknown; FIND before READ" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("PLAN log_entry not found");
        assert.equal(log.op, "PLAN");
        const tx = JSON.parse(log.tx) as { body: string | null };
        assert.equal(tx.body, "capital of France is unknown; FIND before READ");
    } finally { await db.close(); }
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, env };
};

test("Engine.dispatch: targetless OPEN[tag] routes to the log owner", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: planStmt({ body: "retain this working set" }),
            ...env, sequence: 1, origin: "model",
        });
        const folded = await engine.dispatch({
            statement: foldStmt({ target: urlPath("log", "/1/1/1"), tags: ["working-set"] }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(folded.status, 200);
        const before = await db.test_get_log_expanded.get<{ expanded: number }>({
            worker_id: env.workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(before?.expanded, 0);

        const opened = await engine.dispatch({
            statement: openStmt({ target: null, tags: ["working-set"] }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(opened.status, 200);
        assert.equal((opened as { matched?: number }).matched, 1);
        const after = await db.test_get_log_expanded.get<{ expanded: number }>({
            worker_id: env.workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(after?.expanded, 1);
    } finally { await db.close(); }
});

test("Engine.dispatch: an external scheme cannot acquire OPEN by defining an open method", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let invoked = false;
    class Trap {
        static manifest = {
            name: "trap", channels: {}, defaultChannel: "",
            category: "data" as const, scope: "workspace" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async open() { invoked = true; return { status: 200 }; }
    }
    schemes.register("trap", new Trap());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: openStmt({ target: urlPath("trap", "/x") }),
            ...env, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        assert.equal(result.problem?.operation, "OPEN");
        assert.equal(result.problem?.scheme, "trap");
        assert.equal(invoked, false);
    } finally { await db.close(); }
});

test("Engine.dispatch: EDIT against worker:/// routes to Worker.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/france/capital"), body: "Paris", tags: ["france"] }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entryId = (result as unknown as { entryId: number }).entryId;
        assert.ok(entryId >= 1);
        const entry = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: entryId });
        assert.equal(entry?.pathname, "/france/capital");
    } finally { await db.close(); }
});

test("Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{
            worker_id: number; loop_id: number; turn_id: number; sequence: number;
            origin: string; op: string; suffix: string; signal: string | null;
            scheme: string | null; pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("log_entry not found");
        assert.equal(log.worker_id, env.workerId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.sequence, 1);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(log.suffix, "");
        assert.equal(log.signal, null);
        assert.equal(log.scheme, "worker");
        assert.equal(log.pathname, "/x");
        assert.equal(log.mimetype_tx, "application/json");
        assert.equal(log.mimetype_rx, "application/json");
        assert.equal(log.status_rx, 201);
        const tx = JSON.parse(log.tx) as { op: string };
        assert.equal(tx.op, "EDIT");
        const rx = JSON.parse(log.rx) as { status: number };
        assert.equal(rx.status, 201);
    } finally { await db.close(); }
});

test("Engine.dispatch: READ against worker:/// routes to Worker.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/r"), body: "value" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("worker", "/r") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { await db.close(); }
});

test("Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("wiki", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 501);
        assert.equal(log?.scheme, "wiki");
    } finally { await db.close(); }
});

test("Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            op: "EDIT", suffix: "", signal: null, target: null, lineMarker: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string | null; pathname: string | null }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 400);
        assert.equal(log?.scheme, null);
        assert.equal(log?.pathname, null);
    } finally { await db.close(); }
});

test("Engine.dispatch: multiple actions in one turn — log_entries sequence UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/a"), body: "1" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/b"), body: "2" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; pathname: string }>({ turn_id: env.turnId });
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.sequence, 1);
        assert.equal(rows[0]?.pathname, "/a");
        assert.equal(rows[1]?.sequence, 2);
        assert.equal(rows[1]?.pathname, "/b");
    } finally { await db.close(); }
});

test("Engine.dispatch: signal serialized to JSON in log", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/tagged"), tags: ["france", "europe"], body: "Paris" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ signal: string }>({ turn_id: env.turnId });
        assert.deepEqual(JSON.parse(log?.signal ?? "null"), ["france", "europe"]);
    } finally { await db.close(); }
});

test("Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        for (const [i, origin] of (["model", "client", "plurnk", "plugin"] as const).entries()) {
            await engine.dispatch({
                statement: editStmt({ target: urlPath("worker", `/o${i}`), body: "x" }),
                workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
                sequence: i + 1, origin,
            });
        }
        const rows = await db.test_log_entries_by_turn.all<{ origin: string; sequence: number }>({ turn_id: env.turnId });
        assert.deepEqual(rows.map((r) => r.origin), ["model", "client", "plurnk", "plugin"]);
    } finally { await db.close(); }
});

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy or dispatch
// returns 403 without invoking the handler.

test("Engine.dispatch: a writer outside writableBy is rejected 403 without invoking the handler", async () => {
    const { db, engine, env } = await setup();
    try {
        // worker://'s writableBy is ['model','client','plurnk'] — a plugin-origin EDIT 403s at the gate.
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "plugin",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/writer-forbidden");
        assert.equal(result.problem?.writer, "plugin");
        assert.equal(result.problem?.scheme, "worker");
        assert.deepEqual(result.problem?.allowedWriters, ["model", "client", "plurnk"]);
        // 403 still writes a log row
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 403);
        assert.equal(log?.scheme, "worker");
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT log:/// clears the gate but 501s — Log's handler surface (kill only) is the op-level truth", async () => {
    // {§model-entry-log-curation} admits the model through Log's writableBy for its KILL curation
    // lever; every other mutating op still lands on a handler Log doesn't expose (no edit) → 501,
    // matching plurnk.md's "Do not attempt to edit log items."
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "op-level refusal (no edit handler), not the writer gate");
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT prompt:/// rejected with 403 (engine/client own the task frames)", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("prompt", "/1/1"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT worker://plurnk/ is 403 — only the kernel authors its surface ({})", async () => {
    const { db, engine, env } = await setup();
    try {
        await Owner.commonsId(db, env.workspaceId); // ensure reserved rows resolvable
        await Envelope.ensurePlurnkWorker(db, env.workspaceId);
        const result = await engine.dispatch({
            statement: editStmt({ target: { kind: "url", raw: "worker://plurnk/docs/log.md", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/docs/log.md", query: null, fragment: null }, body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "a named space takes no model writes — the kernel surface included");
    } finally { await db.close(); }
});

test("Engine.dispatch: model READ log:/// is NOT gated by writableBy (read-side op)", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log scheme has no read() handler yet, so this returns 501 — proves
        // the writableBy gate did NOT intercept (would have returned 403).
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("log", "/x") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: plurnk EDIT log:/// is allowed by writableBy", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log has no edit() handler — so this returns 501 (not 403) when allowed.
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "plurnk",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: an instance manifest enforces writableBy like a static manifest", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let invoked = false;
    class Dynamic {
        get manifest() {
            return {
                name: "dynamic",
                channels: {},
                defaultChannel: "",
                category: "data" as const,
                scope: "workspace" as const,
                writableBy: ["plugin" as const],
                volatile: false,
                modelVisible: true,
            };
        }
        async editBatch() {
            invoked = true;
            return { status: 200 };
        }
    }
    schemes.register("dynamic", new Dynamic());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("dynamic", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(invoked, false, "the handler is not invoked after its manifest denies the writer");
    } finally { await db.close(); }
});

test("Engine.dispatch: model SEND with null path (broadcast) is NOT gated", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: { op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } },
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// SPEC {§scheme-surface} / plurnk-schemes#1: action-entry-as-outcome — scheme-handler
// exceptions finalize the action-entry at 500, not bubble up.

test("Engine.dispatch: scheme handler that throws → action-entry at status 500 (action-entry-as-outcome)", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class Boom {
        static manifest = {
            name: "boom", channels: {}, defaultChannel: "",
            category: "data" as const, scope: "workspace" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch() { throw new Error("scheme handler deliberately threw"); }
    }
    schemes.register("boom", new Boom());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boom", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.detail, "The 'boom' scheme did not produce an EDIT result.");
        assert.equal(result.problem?.stage, "scheme-dispatch");
        assert.equal(result.problem?.scheme, "boom");
        assert.equal(result.problem?.operation, "EDIT");
        assert.doesNotMatch(JSON.stringify(result), /scheme handler deliberately threw/);
        // action-entry preserved at status 500 with error in rx
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; rx: string; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 500);
        assert.equal(log?.scheme, "boom");
        const rx = JSON.parse(log?.rx ?? "{}");
        assert.equal(rx.status, 500);
        assert.equal(rx.problem.detail, "The 'boom' scheme did not produce an EDIT result.");
        assert.doesNotMatch(log?.rx ?? "", /scheme handler deliberately threw/);
    } finally { await db.close(); }
});

test("Engine.dispatch: non-Error throw becomes the same generic contract Problem", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class BoomString {
        static manifest = {
            name: "boomstr", channels: {}, defaultChannel: "",
            category: "data" as const, scope: "workspace" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch(): Promise<never> { throw "raw string thrown"; }
    }
    schemes.register("boomstr", new BoomString());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boomstr", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-handler-threw");
        assert.equal(result.problem?.detail, "The 'boomstr' scheme did not produce an EDIT result.");
        assert.doesNotMatch(JSON.stringify(result), /raw string thrown/);
    } finally { await db.close(); }
});

test("Engine.dispatch: COPY rejects a non-entry destination at resource resolution", async () => {
    const { db, engine, env } = await setup();
    try {
        // Source first: model creates an entry in worker:///.
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/src"), body: "v" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        // Attempt copy worker:///src → log:///dst — destination scheme rejects.
        const result = await engine.dispatch({
            statement: {
                op: "COPY", suffix: "", signal: null,
                target: urlPath("worker", "/src"),
                lineMarker: null,
                body: { target: urlPath("log", "/dst"), lineMarker: null },
                position: { line: 1, column: 1 },
            },
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.dev/engine/dispatcher/entry-operation-unsupported",
        );
        assert.equal(result.problem?.scheme, "log");
        assert.equal(result.problem?.category, "logging");
    } finally { await db.close(); }
});
