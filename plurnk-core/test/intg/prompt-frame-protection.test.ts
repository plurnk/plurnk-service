// Prompt frames are ordinary curatable log memory. The automatic grinder preserves the current
// frame, but an explicit OPEN/FOLD request follows the universal log-curation state machine.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { foldStmt, editStmt, openStmt } from "./_dsl.ts";
import type { ParsedPath, KillStatement } from "@plurnk/plurnk-contracts";
const killStmt = (target: ParsedPath): KillStatement => ({ op: "KILL", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } });

const urlLog = (raw: string) => ({ kind: "url" as const, raw, scheme: "log", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^log:\/\/\//, ""), query: null, fragment: null });
const urlKnown = (raw: string) => ({ kind: "url" as const, raw, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^worker:\/\/\//, ""), query: null, fragment: null });

async function seedPromptWorker(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `frame-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // Turn 1 publishes one first-class prompt row at prompt:///1/1.
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [{ op: "SEND", suffix: "", signal: 102, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } }] } }] }),
        workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "Improve the module loader so require() stays deterministic." }],
    });
    const curationTurn = await insertTurn(db, loopId, 2, 102); // curation happens on a later turn (run43: turn 4)
    return { workspaceId, workerId, loopId, engine, curationTurn };
}

test("an explicit FOLD of the prompt row is ordinary curation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        // The turn-0 model exemplar is row 1; the prompt is row 2.
        const r = await engine.dispatch({ statement: foldStmt(urlLog("log:///1/1/2/prompt")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 200, "the valid prompt log row folds like every other open row");
        assert.equal((r as { matched?: number }).matched, 1);
        const exp = await db.test_prompt_expanded.get<{ expanded: number }>({});
        assert.equal(exp?.expanded, 0, "the explicit curation request is honored");
    } finally { await db.close(); }
});

test("the prompt row can be folded and opened again", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        const folded = await engine.dispatch({ statement: foldStmt(urlLog("log:///1/1/2/prompt")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(folded.status, 200, "FOLD of the frame body is legal");
        const opened = await engine.dispatch({ statement: openStmt(urlLog("log:///1/1/2/prompt")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.equal(opened.status, 200, "OPEN restores the ordinary prompt projection");
        const exp = await db.test_prompt_expanded.get<{ expanded: number }>({});
        assert.equal(exp?.expanded, 1, "the frame survives the round trip");
    } finally { await db.close(); }
});

test("prior and current loop prompts share the same explicit curation contract", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, engine } = await seedPromptWorker(db);
        // A second loop takes over the frame; loop 1's prompt becomes curatable history.
        const loop2 = await insertLoop(db, workerId, 2, "the next task");
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [{ op: "SEND", suffix: "", signal: 102, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } }] } }] }),
            workspaceId, workerId, loopId: loop2, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the next task" }],
        });
        const curationTurn = await insertTurn(db, loop2, 2, 102);
        const stale = await engine.dispatch({ statement: foldStmt(urlLog("log:///1/1/2/prompt")), workspaceId, workerId, loopId: loop2, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(stale.status, 200, "the old loop's prompt folds");
        assert.equal((stale as { matched?: number }).matched, 1, "the fold matched the stale prompt row - not a vacuous zero-match 200");
        // Loop 2 has no turn-0 exemplar, so its prompt is row 1.
        const current = await engine.dispatch({ statement: foldStmt(urlLog("log:///2/1/1/prompt")), workspaceId, workerId, loopId: loop2, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.equal(current.status, 200, "the current prompt folds under the same valid-entry contract");
    } finally { await db.close(); }
});

test("KILL of the prompt is still allowed — deliberate curation preserved (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/1/2/prompt")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.ok(r.status < 400, `KILL of the prompt succeeds (deliberate) — got ${r.status}`);
    } finally { await db.close(); }
});

test("the grinder never folds the prompt frame — even on overflow (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await seedPromptWorker(db);
        // Fire the grinder's fold directly (as enforceBudget does on overflow) against turn 1.
        const t1 = await db.test_turn_id_by_seq.get<{ id: number }>({ loop_id: loopId, sequence: 1 });
        const before = await db.engine_render_log.all<{
            loop_seq: number;
            turn_seq: number;
            sequence: number;
            op: string;
            scheme: string | null;
            expanded: number;
        }>({ worker_id: workerId });
        await db.engine_grinder_fold_newest_turn({ loop_id: loopId, turn_id: t1!.id });
        const exp = await db.test_prompt_expanded.get<{ expanded: number }>({});
        assert.equal(exp?.expanded, 1, "the grinder skipped the prompt — the task frame survives its reclamation");

        const expected = before
            .filter((row) => row.expanded === 1 && row.op !== "error" && row.op !== "PLAN" && row.scheme !== "prompt")
            .map((row) => `${row.loop_seq}/${row.turn_seq}/${row.sequence}`)
            .sort();
        const overflowTags = (await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: workerId }))
            .filter(({ tag }) => tag === "overflow")
            .map(({ coordinate }) => coordinate)
            .sort();
        assert.deepEqual(overflowTags, expected, "the grinder tags exactly the rows it folds as overflow");
    } finally { await db.close(); }
});

test("sister workers' turn-1 prompts are DISTINCT rows at the same coordinate — owner-keyed, no clobber (#382 fault-1)", async () => {
    // run43: exactly two writes hit /1/1 — the model worker's task foist and a WORK-spawned
    // worker's — and the worker's DESTROYED the parent's task. Owner-keyed rows keep one
    // filesystem with collision-free coordinates (/proc/<pid>-style).
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `frame-sisters-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mkProvider = () => new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [{ op: "SEND", suffix: "", signal: 102, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } }] } }] });
        const parentWorker = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parentWorker, 1, "the parent task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, workerId: parentWorker, loopId: parentLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the parent task" }] });
        const childWorker = await insertWorker(db, workspaceId);
        const workerLoop = await insertLoop(db, childWorker, 1, "the worker task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, workerId: childWorker, loopId: workerLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the worker task" }] });

        const bodyAt = async (workerId: number) => (await db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({ owner_id: workerId, pattern: "/1/%" }));
        const parentRows = await bodyAt(parentWorker);
        const workerRows = await bodyAt(childWorker);
        assert.equal(parentRows.length, 1, "the parent's prompt entry exists at its worker-qualified address");
        assert.equal(workerRows.length, 1, "the worker's prompt entry exists at ITS worker-qualified address");
        assert.equal(parentRows[0].content, "the parent task", "the worker's turn-1 foist did not clobber the parent's task");
        assert.equal(workerRows[0].content, "the worker task");
        assert.equal(parentRows[0].pathname, workerRows[0].pathname, "one coordinate — the owner column carries the identity ({§entry-owner})");
    } finally { await db.close(); }
});

test("OPEN/FOLD are recorded in the DB but suppressed from the packet render (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        // seed a genuine non-prompt row (a worker:/// note), then fold IT so the success records
        await engine.dispatch({ statement: editStmt(urlKnown("worker:///scratch"), "note"), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: foldStmt(urlLog("log:///1/2/1/EDIT")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        const dbRow = await db.test_count_op.get<{ n: number }>({ op: "FOLD" });
        assert.ok((dbRow?.n ?? 0) >= 1, "the FOLD is recorded in the DB (forensics)");
        const rendered = await db.engine_render_log.all<{ op: string }>({ worker_id: workerId });
        assert.ok(!rendered.some((r) => r.op === "FOLD" || r.op === "OPEN"), "no OPEN/FOLD row reaches the packet render");
    } finally { await db.close(); }
});

test("a successful KILL of a log item is suppressed from the render; a KILL of a non-log target renders (#561)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        // Two seeds: a worker:/// note (a real artifact) and a log row to curate. KILL each.
        await engine.dispatch({ statement: editStmt(urlKnown("worker:///scratch"), "note"), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        // KILL the log EDIT row just written (a LOG item) — the run61 tombstone case.
        const logKill = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/EDIT")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.ok(logKill.status < 400, `KILL of the log item succeeds — got ${logKill.status}`);
        // KILL the worker:/// note (a WORLD mutation, not log housekeeping).
        const noteKill = await engine.dispatch({ statement: killStmt(urlKnown("worker:///scratch")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 3, origin: "model" });
        assert.ok(noteKill.status < 400, `KILL of the note succeeds — got ${noteKill.status}`);

        const killCount = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.ok((killCount?.n ?? 0) >= 2, "both KILLs are recorded in the DB (forensics)");

        const rendered = await db.engine_render_log.all<{ op: string; scheme: string | null }>({ worker_id: workerId });
        const killRows = rendered.filter((r) => r.op === "KILL");
        assert.ok(!killRows.some((r) => r.scheme === "log"), "the successful log-item KILL tombstone is suppressed from the render");
        assert.ok(killRows.some((r) => r.scheme === "worker"), "the KILL of the worker:// note — a world mutation — still renders");
    } finally { await db.close(); }
});
