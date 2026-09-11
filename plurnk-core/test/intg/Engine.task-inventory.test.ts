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
const response = (content: string, reasoning: string | null = null) => ({
    assistant: { content, reasoning },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const [name, first, detail, strikes] of [
    ["inventory-only continuation", task("in_progress"), null, 0],
    ["pending-only inventory", task("pending"), "Pending tasks remain. Review their dependencies.", 0],
    ["empty untimed wait", task("waiting"), "Nothing is in flight and no timed or polled wait is set. Continuing.", 0],
    ["missing inventory", send("First message."), null, 0],
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
        assert.equal(rows.filter(({ op }) => op === "TASK").length, name === "missing inventory" ? 2 : 3,
            "initialization and authored TASKs retain their rows; omission adds none");
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

for (const [statuses, expectedStatus] of [
    [["completed"], 200],
    [["failed"], 499],
    [["failed", "failed"], 499],
    [["completed", "failed"], 200],
    [["failed", "completed"], 200],
] as const) {
    test(`{§loop-response-messages} ${statuses.join(" + ")} preserves every targetless SEND despite curation`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "response-evidence");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Answer in two parts.");
        const inventory = statuses.map((status, index) => ({ content: `Task ${index + 1}`, status }));
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(`${send("First.")}\n${task("in_progress")}`),
            response(`\`\`\`KILL (log:///1/2/*/SEND)\`\`\`\n${send("Second.")}\n\`\`\`TASK\n${JSON.stringify(inventory)}\n\`\`\``),
        ] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3,
        });
        assert.equal(result.result.status, expectedStatus);
        assert.equal(result.result.content, "First.\n\nSecond.");
        assert.equal((await new LoopLifecycle(db).result(loopId))?.content, "First.\n\nSecond.");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; tx: string }>({ loop_id: loopId });
        assert.ok(rows.some(({ op, status_rx }) => op === "KILL" && status_rx === 200), "the earlier SEND was actually curated");
        assert.deepEqual(JSON.parse(rows.findLast(({ op }) => op === "TASK")!.tx).body, inventory,
            "the loop outcome does not rewrite individual task outcomes");
        assert.equal(provider.received.length, 2, "final housekeeping requires no extra inference");
        if (expectedStatus === 499) assert.equal(result.result.problem?.detail, "All tasks in the final inventory failed.");
        else assert.equal(result.result.problem, undefined);
    });
}

test("{§task-inventory-intent} an observed cleanup failure does not invalidate completed work", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "cleanup-outcome");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Deliver the project brief.");
    const inventory = [
        { content: "Read the project codename.", status: "completed" },
        { content: "Read the database host and TODO.", status: "completed" },
        { content: "Deliver the project brief.", status: "completed" },
        { content: "Clean up reasoning log item.", status: "failed" },
    ];
    const brief = "Codename: phoenix. Host: db.internal. TODO: add error handling.";
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`${send(brief)}\n${task("in_progress")}`, "The requested project brief is ready."),
        response(`\`\`\`KILL (reasoning:///1/2/1) <1,-1>\`\`\`\n${task("completed")}`),
        response(`\`\`\`TASK\n${JSON.stringify(inventory)}\n\`\`\``),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4,
    });
    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; tx: string; rx: string }>({ loop_id: loopId });
    const denied = rows.find(({ op }) => op === "KILL");
    assert.equal(denied?.status_rx, 403, "the read-only reasoning source remains protected");
    assert.equal(JSON.parse(denied!.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
    assert.ok(rows.some(({ op, status_rx }) => op === "TASK" && status_rx === 409),
        "the failed operation still requires observation before completion");
    assert.equal(provider.received.length, 3);
    assert.equal(result.result.status, 200);
    assert.equal(result.result.problem, undefined);
    assert.equal(result.result.content, brief, "the earlier delivered answer survives the recovery turn");
    assert.equal(await new LoopLifecycle(db).status(loopId), 200);
    assert.deepEqual(JSON.parse(rows.findLast(({ op }) => op === "TASK")!.tx).body, inventory);
});

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

test("{§send-premature-terminate} mixed terminal outcomes cannot abandon a live child", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "mixed-outcomes-live-child");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Wait for the delegated result.");
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    const childLoopId = await insertLoop(db, childId, 1, "Finish the delegated work.");
    const inventory = [
        { content: "Prepare the report.", status: "completed" },
        { content: "Optional check failed.", status: "failed" },
    ];
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`\`\`\`TASK\n${JSON.stringify(inventory)}\n\`\`\``),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
        workspaceId, workerId, loopId, provider, messages: [],
    });
    assert.equal(result.status, 102);
    assert.equal(result.steerStruck, true);
    assert.equal(await new LoopLifecycle(db).status(loopId), 102);
    assert.equal(await new LoopLifecycle(db).status(childLoopId), 102, "a mixed inventory does not cancel its child");
    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
    const refused = rows.findLast(({ op }) => op === "TASK");
    assert.equal(refused?.status_rx, 409);
    assert.equal(JSON.parse(refused!.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/work-remains");
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
