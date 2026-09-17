import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const frame = PlurnkParser.frame;
const response = (content: string, reasoning: string | null = null) => ({
    assistant: { content, reasoning },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const [name, first, detail] of [
    ["note-only continuation", frame("NOTE", "Consider the next step."), null],
    ["empty wait", frame("WAIT", ""), "Nothing is in flight. Continuing."],
    ["message-only continuation", frame("SEND", "First message."), null],
    ["empty note", frame("NOTE", ""), null],
    ["scoped wait", frame("WAIT <60>", ""), "WAIT takes no scope. WAIT joins live work; to wake later with nothing in flight, add a rule with the schedule family."],
] as const) {
    test(`{§wait-obligation-matrix} ${name} continues without losing its operations`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "explicit-lifecycle");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [response(first), response(frame("DONE", "Answer."))] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 2,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, "Answer.");
        assert.equal(provider.received.length, 2);
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string; status_rx: number }>({ loop_id: loopId });
        if (detail !== null) {
            assert.equal(rows.filter(({ rx }) => {
                const result = JSON.parse(rx);
                return (result.problem?.detail ?? result.detail) === detail;
            }).length, 1, "one durable correction, not duplicated grammar and runtime errors");
            assert.match(JSON.stringify(provider.received[1]), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        assert.equal(rows.filter(({ op }) => op === "DONE").length, 1, "no disposition is invented for initialization or omission");
    });
}

test("{§join-blocking-collect} a not-ready READ continues until an explicit WAIT joins the child", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "independent-join");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Advance while the child works.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, childId, 1, "Child work.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (worker://child)", "")), response(frame("WAIT", "Await the child.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 1,
    });
    assert.equal(result.result.status, 202);
    assert.equal(provider.received.length, 2);
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
    assert.equal(await new LoopLifecycle(db).status(loopId), 202);
});

for (const [op, status] of [["DONE", 200], ["FAIL", 499]] as const) {
    test(`{§loop-response-messages} ${op} keeps the last delivered message despite its curation`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "response-evidence");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer, then tidy up.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame("SEND", "The answer.")),
            response(`${frame("KILL (log:///1/2/*/SEND)", "")}\n${frame(op, "")}`),
        ] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
        assert.equal(result.result.status, status);
        assert.equal(result.result.content, "The answer.");
        assert.equal((await new LoopLifecycle(db).result(loopId))?.content, "The answer.");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
        assert.ok(rows.some(({ op, status_rx }) => op === "KILL" && status_rx === 200));
        assert.equal(provider.received.length, 2, "final housekeeping requires no extra inference");
        if (op === "FAIL") assert.equal(result.result.problem?.detail, "The model abandoned the work.");
        else assert.equal(result.result.problem, undefined);
    });
}

test("{§loop-response-messages} a terminal response supersedes earlier delivered SENDs", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "response-last-message");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "What is the codename?");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("SEND", "The codename is Bumblebee.")),
        response(frame("DONE", "The codename is phoenix.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, "The codename is phoenix.");
    assert.equal((await new LoopLifecycle(db).result(loopId))?.content, "The codename is phoenix.");
    const messages = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId });
    assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The codename is Bumblebee.", "The codename is phoenix."]);
});

test("{§completion-defers-to-results} an observed cleanup failure does not invalidate completed work", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "cleanup-outcome");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Deliver the project brief.");
    const brief = "Codename: phoenix. Host: db.internal. TODO: add error handling.";
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("SEND", brief), "The requested project brief is ready."),
        response(`${frame("KILL (reasoning:///1/2) <1,-1>", "")}\n${frame("DONE", "")}`),
        response(frame("DONE", "")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
    const denied = rows.find(({ op }) => op === "KILL");
    assert.equal(denied?.status_rx, 403);
    assert.equal(JSON.parse(denied!.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
    assert.equal(rows.find(({ op, rx }) => op === "DONE" && /failed in the same turn/.test(rx))?.status_rx, 102);
    assert.equal(provider.received.length, 3);
    assert.equal(result.result.status, 200);
    assert.equal(result.result.problem, undefined);
    assert.equal(result.result.content, brief);
});

test("{§loop-response-messages} cancellation preserves delivered messages but not WAIT text", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "response-cancellation");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Wait after the update.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, childId, 1, "Live child work the wait joins.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(`${frame("SEND", "Update delivered.")}\n${frame("WAIT", "Await the child.")}`)] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 202);
    const lifecycle = new LoopLifecycle(db);
    const cancelled = await lifecycle.cancelTree(workerId, "operator request", true);
    const own = cancelled.loops.find(({ loopId: id }) => id === loopId);
    assert.ok(own);
    assert.equal(own.result.status, 499);
    assert.equal(own.result.content, "Update delivered.");
    assert.equal((await lifecycle.result(loopId))?.content, "Update delivered.");
    assert.equal(own.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
});

for (const [op, parentStatus, childStatus] of [["DONE", 202, 102], ["FAIL", 499, 499]] as const) {
    test(`{§completion-joins-live-work} ${op} ${op === "DONE" ? "joins" : "cancels"} a live child`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "live-child");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Wait for the delegated result.");
        const childId = await insertWorker(db, workspaceId, workerId, "child");
        const childLoopId = await insertLoop(db, childId, 1, "Finish delegated work.");
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelDescendants: async () => { await lifecycle.cancelTree(workerId, "parent failed", false); } });
        const provider = new Mock({ contextWindow: 100000, responses: [response(frame(op, ""))] });
        const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
        assert.equal(result.status, parentStatus);
        assert.equal(await lifecycle.status(loopId), parentStatus);
        assert.equal(await lifecycle.status(childLoopId), childStatus);
    });
}

test("{§loop-response-messages} blank DONE completes silently", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "silent-completion");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Do the work.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(frame("DONE", ""))] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content ?? null, null);
});

test("{§note-value} writing about failure in NOTE does not declare failure", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "notes-not-control");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Try both approaches.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("NOTE", "First approach failed.\nTry the second approach.")),
        response(frame("DONE", "Second approach succeeded.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal(result.result.content, "Second approach succeeded.");
});
