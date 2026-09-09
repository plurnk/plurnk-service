import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const task = (status: string, scope = "") => `\`\`\`TASK${scope}\n${JSON.stringify([{ content: "Address the prompt.", status }])}\n\`\`\``;
const send = (body: string, target = "") => `\`\`\`SEND${target}\n${body}\n\`\`\``;
const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const [name, first, detail, strikes] of [
    ["inventory-only continuation", task("in_progress"), null, 0],
    ["pending-only inventory", task("pending"), "Pending tasks remain. Review their dependencies.", 0],
    ["empty untimed wait", task("waiting"), "Nothing is in flight and no timed or polled wait is set. Continuing.", 0],
    ["missing inventory", send("First message."), "No tasks were supplied. Submit a nonempty TASK inventory.", 1],
    ["empty inventory", "```TASK\n[]\n```", "No tasks were supplied. Submit a nonempty TASK inventory.", 1],
    ["blank inventory", "```TASK```", "No tasks were supplied. Submit a nonempty TASK inventory.", 1],
    ["non-waiting timing", task("in_progress", " <60>"), "Wait timing was not applied because no waiting intent was selected.", 0],
    ["plain task text", "```TASK\nConsider the next step.\n```", null, 0],
] as const) {
    test(`{§wait-obligation-matrix} ${name} continues without losing its operations`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "task-inventory");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(first), response(`${send("Answer.")}\n${task("completed")}`),
        ] });
        const seenStrikes: Array<number | undefined> = [];
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", (args: Parameters<Mock["generate"]>[0]) => {
            seenStrikes.push(args.strikes);
            return generate(args);
        });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 2,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, name === "missing inventory" ? "First message.\n\nAnswer." : "Answer.");
        assert.deepEqual(seenStrikes, [0, strikes]);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; status_rx: number }>({ loop_id: loopId });
        if (detail !== null) {
            assert.equal(rows.filter(({ rx }) => {
                const result = JSON.parse(rx);
                return (result.problem?.detail ?? result.detail) === detail;
            }).length, 1, "one durable correction, not duplicated grammar and runtime errors");
            assert.match(JSON.stringify(provider.received[1]), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
                "the corrective fact actually reaches the next model packet");
        }
        assert.equal(rows.filter(({ op }) => op === "TASK").length, 3, "initialization and both model turns retain their TASK rows");
    });
}

test("{§join-blocking-collect} a not-ready READ does not override an in_progress inventory", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "independent-join");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Advance while the child works.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, childId, 1, "Child work.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`\`\`\`READ (worker://child)\`\`\`\n${task("in_progress")}`),
        response(task("waiting")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 1,
    });
    assert.equal(result.result.status, 202);
    assert.equal(provider.received.length, 2, "only the explicitly waiting inventory parks");
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
    assert.equal(await new LoopLifecycle(db).status(loopId), 202);
});

for (const terminal of ["completed", "failed"] as const) {
    test(`{§loop-response-messages} ${terminal} preserves every targetless SEND despite curation`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "response-evidence");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer in two parts.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(`${send("First.")}\n${task("in_progress")}`),
            response(`\`\`\`KILL (log:///1/2/*/SEND)\`\`\`\n${send("Second.")}\n${task(terminal)}`),
        ] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3,
        });
        assert.equal(result.result.status, terminal === "completed" ? 200 : 499);
        assert.equal(result.result.content, "First.\n\nSecond.");
        assert.equal((await new LoopLifecycle(db).result(loopId))?.content, "First.\n\nSecond.");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
        assert.ok(rows.some(({ op, status_rx }) => op === "KILL" && status_rx === 200), "the earlier SEND was actually curated");
        if (terminal === "failed") assert.equal(result.result.problem?.detail, "The task inventory ended with failed items.");
    });
}

test("{§loop-response-messages} cancellation preserves delivered messages but not TASK text", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "response-cancellation");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Wait after the update.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`${send("Update delivered.")}\n${task("waiting", " <60>")}`),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2,
    });
    assert.equal(result.result.status, 202);
    const lifecycle = new LoopLifecycle(db);
    const cancelled = await lifecycle.cancelTree(workerId, "operator request", true);
    assert.equal(cancelled.loops.length, 1);
    assert.equal(cancelled.loops[0].result.status, 499);
    assert.equal(cancelled.loops[0].result.content, "Update delivered.");
    assert.equal((await lifecycle.result(loopId))?.content, "Update delivered.");
    assert.equal(cancelled.loops[0].result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
});

test("{§loop-response-messages} completion without SEND does not invent an answer from task text", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "silent-completion");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Do the work.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(task("completed"))] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 2,
    });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content ?? null, null);
});

test("{§task-inventory-intent} a failed sibling does not terminate independently actionable work", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "mixed-outcomes");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Try both approaches.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response('```TASK\n[{"content":"First approach failed.","status":"failed"},{"content":"Try the second approach.","status":"in_progress"}]\n```'),
        response(`${send("Second approach succeeded.")}\n${task("completed")}`),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3,
    });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal(result.result.content, "Second approach succeeded.");
});
