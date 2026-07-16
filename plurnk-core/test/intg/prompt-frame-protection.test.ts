// #382 — the task prompt is FRAME, not curatable memory. Three guards, the run43 lesson:
// a weak model in a housekeeping turn folded its own task auto-READ and lost the plot.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { foldStmt, editStmt } from "./_dsl.ts";
import type { ParsedPath, KillStatement } from "@plurnk/plurnk-grammar";
const killStmt = (target: ParsedPath): KillStatement => ({ op: "KILL", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } });

const urlLog = (raw: string) => ({ kind: "url" as const, raw, scheme: "log", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^log:\/\/\//, ""), params: {}, fragment: null });
const urlKnown = (raw: string) => ({ kind: "url" as const, raw, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^known:\/\/\//, ""), params: {}, fragment: null });

async function seedPromptWorker(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `frame-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // turn 1 runs the prompt foist (EDIT + auto-READ of plurnk://prompt/1/1)
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [{ op: "SEND", suffix: "", signal: 102, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } }] } }] }),
        workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "Improve the module loader so require() stays deterministic." }],
    });
    const curationTurn = await insertTurn(db, loopId, 2, 102); // curation happens on a later turn (run43: turn 4)
    return { workspaceId, workerId, loopId, engine, curationTurn };
}

test("[§prompt-fold-illegal] a FOLD of the prompt auto-READ is refused with the KILL steer (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        // the prompt auto-READ is at coordinate 1/1/3 (foist EDIT=2, READ=3)
        const r = await engine.dispatch({ statement: foldStmt(urlLog("log:///1/1/3/READ")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 403, "folding the task prompt is illegal");
        assert.match(String(r.error), /FOLD a user prompt.*KILL/s, "the steer names KILL as the deliberate path");
        // the prompt row stays expanded — the frame survives
        const exp = await (db.test_prompt_expanded as PrepMethod).get<{ expanded: number }>({});
        assert.equal(exp?.expanded, 1, "the prompt auto-READ is still open after the refused fold");
    } finally { await db.close(); }
});

test("[§prompt-fold-illegal] KILL of the prompt is still allowed — deliberate curation preserved (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/1/3/READ")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.ok(r.status < 400, `KILL of the prompt succeeds (deliberate) — got ${r.status}`);
    } finally { await db.close(); }
});

test("[§grinder-errors-exempt] the grinder never folds the prompt frame — even on overflow (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await seedPromptWorker(db);
        // Fire the grinder's fold directly (as enforceBudget does on overflow) against turn 1.
        const t1 = await (db.test_turn_id_by_seq as PrepMethod).get<{ id: number }>({ loop_id: loopId, sequence: 1 });
        await (db.engine_grinder_fold_newest_turn as PrepMethod).run({ loop_id: loopId, turn_id: t1!.id });
        const exp = await (db.test_prompt_expanded as PrepMethod).get<{ expanded: number }>({});
        assert.equal(exp?.expanded, 1, "the grinder skipped the prompt — the task frame survives its reclamation");
    } finally { await db.close(); }
});

test("[§prompt-run-qualified] sister runs' turn-1 prompts land at DISTINCT addresses — no clobber (#382 fault-1)", async () => {
    // run43: exactly two writes hit /prompt/1/1 — the model run's task foist and a WORK-spawned
    // worker's — and the worker's DESTROYED the parent's task. Run-qualified paths keep one
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

        const bodyAt = async (workerId: number) => (await (db.drain_get_all_prompt_bodies_for_loop as PrepMethod).all<{ content: string; pathname: string }>({ pattern: `/prompt/${workerId}/1/%` }));
        const parentRows = await bodyAt(parentWorker);
        const workerRows = await bodyAt(childWorker);
        assert.equal(parentRows.length, 1, "the parent's prompt entry exists at its run-qualified address");
        assert.equal(workerRows.length, 1, "the worker's prompt entry exists at ITS run-qualified address");
        assert.equal(parentRows[0].content, "the parent task", "the worker's turn-1 foist did not clobber the parent's task");
        assert.equal(workerRows[0].content, "the worker task");
        assert.notEqual(parentRows[0].pathname, workerRows[0].pathname, "two runs, two addresses — one filesystem, collision-free coordinates");
    } finally { await db.close(); }
});

test("OPEN/FOLD are recorded in the DB but suppressed from the packet render (#382)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId, engine, curationTurn } = await seedPromptWorker(db);
        // seed a genuine non-prompt row (a known:// note), then fold IT so the success records
        await engine.dispatch({ statement: editStmt(urlKnown("known:///scratch"), "note"), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: foldStmt(urlLog("log:///1/2/1/EDIT")), workspaceId, workerId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        const dbRow = await (db.test_count_op as PrepMethod).get<{ n: number }>({ op: "FOLD" });
        assert.ok((dbRow?.n ?? 0) >= 1, "the FOLD is recorded in the DB (forensics)");
        const rendered = await (db.engine_render_log as PrepMethod).all<{ op: string }>({ worker_id: workerId });
        assert.ok(!rendered.some((r) => r.op === "FOLD" || r.op === "OPEN"), "no OPEN/FOLD row reaches the packet render");
    } finally { await db.close(); }
});
