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
    ["empty note", frame("NOTE", ""), null],
    ["scoped wait", frame("WAIT <60>", ""), "WAIT takes no scope; scheduled delivery uses the schedule family."],
] as const) {
    test(`{§wait-obligation-matrix} ${name} continues without losing its operations`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "explicit-lifecycle");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [response(first), response(frame("SEND", "Answer."))] });
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
        assert.equal(rows.filter(({ op, origin }) => origin === "model" && op === "SEND").length, 1);
        assert.ok(rows.every(({ op }) => !["DONE", "FAIL"].includes(op)), "no terminal operation is invented");
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

for (const [cancel, status] of [[false, 200], [true, 499]] as const) {
    test(`{§loop-response-messages} ${cancel ? "cancellation" : "completion"} keeps the last delivered message despite its curation`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "response-evidence");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Answer, then tidy up.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(`${frame("FIND (worker:///*)", "")}\n${frame("SEND", "The answer.")}`),
            response(`${frame("KILL (log:///1/2/*/SEND)", "")}\n${cancel ? frame("KILL (worker://alice)", "") : frame("NOTE", "Result observed.")}`),
        ] });
        const lifecycle = new LoopLifecycle(db);
        const result = await new Engine({ db, schemes: new SchemeRegistry(), cancelWorker: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
        assert.equal(result.result.status, status);
        assert.equal(result.result.content, "The answer.");
        assert.equal((await new LoopLifecycle(db).result(loopId))?.content, "The answer.");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
        assert.ok(rows.some(({ op, status_rx }) => op === "KILL" && status_rx === 200));
        assert.equal(provider.received.length, 2, "final housekeeping requires no extra inference");
        if (cancel) assert.match(result.result.problem?.detail ?? "", /killed via worker/);
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
        response(`${frame("SEND", "The codename is Bumblebee.")}\n${frame("SEND", "The codename is phoenix.")}`),
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
        response(`${frame("SEND", brief)}\n${frame("KILL (reasoning:///1/2) <1,-1>", "")}`, "The requested project brief is ready."),
        response(frame("NOTE", "The read-only source cannot be removed; the brief is unchanged.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
    const denied = rows.find(({ op }) => op === "KILL");
    assert.equal(denied?.status_rx, 403);
    assert.equal(JSON.parse(denied!.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
    assert.ok(JSON.stringify(provider.received[1]).includes("writer-forbidden"), "the failed cleanup reaches a later packet");
    assert.equal(provider.received.length, 2);
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

for (const [cancel, parentStatus, childStatus] of [[false, 202, 102], [true, 499, 499]] as const) {
    test(`{§completion-joins-live-work} ${cancel ? "scope cancellation cancels" : "answered work joins"} a live child`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "live-child");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Wait for the delegated result.");
        const childId = await insertWorker(db, workspaceId, workerId, "child");
        const childLoopId = await insertLoop(db, childId, 1, "Finish delegated work.");
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } });
        const provider = new Mock({ contextWindow: 100000, responses: [response(frame(cancel ? "KILL (worker://alice)" : "SEND", ""))] });
        const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
        assert.equal(result.status, parentStatus);
        assert.equal(await lifecycle.status(loopId), parentStatus);
        assert.equal(await lifecycle.status(childLoopId), childStatus);
    });
}

test("{§loop-response-messages} an empty reply still answers the open message", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "silent-completion");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Do the work.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(frame("SEND", ""))] });
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
        response(frame("SEND", "Second approach succeeded.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal(result.result.content, "Second approach succeeded.");
});
