// {§completion-defers-to-results} {§send-premature-terminate} — the observation barrier: a
// terminal claimed over settled results defers one packet and never strikes; a completion over
// live work joins it ({§completion-joins-live-work}); an abandonment takes the same look, then
// cancels live work.
import WorkerName from "../../src/core/WorkerName.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";

const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `defer-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "report the saved answer");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "worker", pathname: "/answer.md", channel: "body",
        content: "The answer is 42.", mimetype: "text/markdown", state: "static",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const sends = async () => await db.test_disposition_rows_for_worker.all<{
        status_rx: number; tx: string; rx: string;
    }>({ worker_id: workerId });
    return { db, workspaceId, workerId, loopId, engine, sends };
};

const response = (operation: string, status = "completed", body = "The answer is 42.") => ({
    assistant: {
        content: [operation, PlurnkParser.frame("SEND", body),
            PlurnkParser.frame("TASK", JSON.stringify([{ content: "Report the answer.", status }]))].join("\n"),
        reasoning: null,
    },
});

type Deferral = { status: number; detail?: string; problem?: unknown; attrs?: Record<string, unknown> };

for (const { name, operation, maxStrikes } of [
    { name: "READ at zero tolerance", operation: "```READ (worker:///answer.md)```", maxStrikes: 0 },
    { name: "READ at one strike", operation: "```READ (worker:///answer.md)```", maxStrikes: 1 },
    { name: "READ", operation: "```READ (worker:///answer.md)```", maxStrikes: 3 },
    { name: "FIND", operation: "```FIND (worker:///answer.md)```", maxStrikes: 3 },
    { name: "BARE", operation: "```BARE\nWhat is six times seven?\n```", maxStrikes: 3 },
]) {
    test(`{§completion-defers-to-results}: ${name} beside a completion defers one packet, then the same TASK completes without a strike`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
        const provider = new Mock({ contextWindow: 100_000, responses: [response(operation), {
            assistant: { content: PlurnkParser.frame("TASK", '[{"content":"Report the answer.","status":"completed"}]'), reasoning: null },
        }] });
        const childProvider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "42", reasoning: null } }] });
        const result = await engine.runLoop({
            provider, childProvider, workspaceId, workerId, loopId, messages: [], maxTurns: 3, maxStrikes,
        });
        assert.equal(result.result.status, 200, "the deferred completion concludes on the next packet");
        assert.equal(result.result.content, "The answer is 42.", "the answer is delivered once");
        assert.equal(provider.received.length, 2, "one packet to observe, then the same TASK completes");
        assert.equal(provider.remaining, 0);
        const rows = await sends();
        assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 200]);
        const deferral = JSON.parse(rows[0]!.rx) as Deferral;
        assert.equal(deferral.problem, undefined, "a deferral carries no Problem");
        assert.deepEqual(deferral.attrs, { pending: ["receipts"] });
        assert.match(deferral.detail ?? "", /^Completion deferred until .+ reached a packet\. It is in this packet\. If your final response has already been sent and these results require no further work or response revision, submit only TASK\.$/);
        assert.ok(JSON.stringify(provider.received[1]).includes(deferral.detail!), "the model receives the conditional TASK-only guidance beside the results");
        const messages = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; tx: string }>({ loop_id: loopId });
        assert.deepEqual(messages.filter(({ op }) => op === "SEND").map(({ status_rx, tx }) => [status_rx, JSON.parse(tx).body.raw]),
            [[200, "The answer is 42."]], "TASK-only completion preserves the answer without delivering a second SEND");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200);
        const finalTurnId = result.turnIds.at(-1);
        assert.ok(finalTurnId !== undefined);
        assert.equal((await db.test_get_turn.get<{ status: number }>({ id: finalTurnId }))?.status, 200, "durable turn and loop agree with the SEND receipt");
    });
}

test("{§loop-response-messages}: deferred completion permits a revised answer after observing the result", async (t) => {
    const { db, engine, workspaceId, workerId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100_000, responses: [
        response("```READ (worker:///answer.md)```", "completed", "The answer is 41."),
        response("", "completed", "Correction: the answer is 42."),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, "Correction: the answer is 42.");
    assert.equal(provider.received.length, 2);
    assert.ok(JSON.stringify(provider.received[1]).includes("If your final response has already been sent and these results require no further work or response revision, submit only TASK."));
    const messages = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; tx: string }>({ loop_id: loopId });
    assert.deepEqual(messages.filter(({ op }) => op === "SEND").map(({ status_rx, tx }) => [status_rx, JSON.parse(tx).body.raw]),
        [[200, "The answer is 41."], [200, "Correction: the answer is 42."]],
        "a necessary correction is still delivered; TASK-only is conditional, not enforced");
});

for (const target of ["log:///999/*/*", "worker:///answer.md"]) {
    test(`{§send-premature-terminate}: KILL ${target} permits completion on the first attempt`, async (t) => {
        const { engine, workspaceId, workerId, loopId, sends } = await fixture(t);
        const provider = new Mock({ contextWindow: 100_000, responses: [response(`\`\`\`KILL (${target})\`\`\``)] });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 1, maxStrikes: 3,
        });
        assert.equal(result.result.status, 200, "successful KILL is permitted on the first completion attempt");
        assert.equal(provider.received.length, 1);
        assert.deepEqual((await sends()).map(({ status_rx }) => status_rx), [200]);
    });
}

test("{§send-premature-terminate}: successful KILL does not exempt a same-turn READ from observation", async (t) => {
    const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const provider = new Mock({ contextWindow: 100_000, responses: [response("```READ (worker:///answer.md)```\n```KILL (worker:///answer.md)```")] });
    const result = await engine.runLoop({
        provider, workspaceId, workerId, loopId, messages: [], maxTurns: 1, maxStrikes: 3,
    });
    assert.equal(result.result.status, 429, "the READ still needs an observation packet; the turn ceiling ends the loop first");
    const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
    assert.ok(rows.some(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200));
    assert.ok(rows.some(({ op, origin, status_rx }) => op === "KILL" && origin === "model" && status_rx === 200), "the source entry was actually deleted after the READ");
    const dispositions = await sends();
    assert.deepEqual(dispositions.map(({ status_rx }) => status_rx), [102]);
    assert.deepEqual((JSON.parse(dispositions[0]!.rx) as Deferral).attrs, { pending: ["receipts"] });
});

test("{§completion-defers-to-results}: repeated early claims cost packets, never strikes", async (t) => {
    const { engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const read = "```READ (worker:///answer.md)```";
    const provider = new Mock({ contextWindow: 100_000, responses: [
        response(read), response(read), response(read, "in_progress"), response(read), response(""),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 6, maxStrikes: 1 });
    assert.equal(result.result.status, 200, "at one strike any refusal would have ended the loop; deferrals never struck");
    assert.deepEqual((await sends()).map(({ status_rx }) => status_rx), [102, 102, 102, 102, 200]);
    assert.equal(provider.received.length, 5);
});

for (const kind of ["workers", "streams", "failed-stream-results", "late-failed-stream-results", "worker-results", "operation-failure", "kill-failure"] as const) {
    const live = kind === "workers" || kind === "streams";
    test(`{§completion-defers-to-results}: a completion over ${kind} ${live ? "joins it: the loop parks without a strike" : "defers one packet, then completes"}`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
        const read = "```READ (worker:///answer.md)```";
        const second = kind === "operation-failure" ? "```READ (worker:///missing.md)```" : kind === "kill-failure" ? "```KILL (worker:///missing.md)```" : "";
        const provider = new Mock({ contextWindow: 100_000, responses: live
            ? [response(read), response("")]
            : [response(read), response(second), response("")] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
            // The obligation lands during the second call: after that turn's packet, before its TASK.
            if (provider.received.length === 1) {
                if (kind === "workers" || kind === "worker-results") {
                    const child = await insertWorker(db, workspaceId, workerId, "child");
                    const childLoop = await insertLoop(db, child, 1, "finish the delegated work");
                    if (kind === "worker-results") {
                        await new LoopLifecycle(db).finish(childLoop, { status: 200, content: "Child result", mimetype: "text/plain" });
                    }
                } else if (kind === "streams" || kind === "failed-stream-results" || kind === "late-failed-stream-results") {
                    if (kind === "late-failed-stream-results") {
                        for (let index = 0; index < 8; index++) {
                            const pathname = `/completed-${index}`;
                            const entryId = await seedEntryWithChannel(db, {
                                workspaceId, authority: await WorkerName.forId(db, workerId), scheme: "worker", pathname,
                                channel: "stdout", content: "Done", mimetype: "text/plain", state: "active",
                            });
                            const subscriptionId = await ChannelWrite.openSubscription(db, {
                                workerId, entryId, scheme: "worker", handle: pathname, publishedChannel: "stdout",
                            });
                            await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
                        }
                    }
                    const entryId = await seedEntryWithChannel(db, {
                        workspaceId, authority: await WorkerName.forId(db, workerId), scheme: "worker", pathname: "/running",
                        channel: "stdout", content: "Working", mimetype: "text/plain", state: "active",
                    });
                    const subscriptionId = await ChannelWrite.openSubscription(db, {
                        workerId, entryId, scheme: "worker", handle: "running", publishedChannel: "stdout",
                    });
                    if (kind === "failed-stream-results" || kind === "late-failed-stream-results") {
                        await ChannelWrite.closeSubscription(db, {
                            subscriptionId,
                            result: Results.failure("executor:fixture", "failed", 500, "Fixture stream failed."),
                        });
                    }
                }
            }
            return generate(args);
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 5, maxStrikes: 3 });
        const rows = await sends();
        const finalTurnId = result.turnIds.at(-1);
        assert.ok(finalTurnId !== undefined);
        if (live) {
            assert.equal(result.result.status, 202, "a completion over live work joins it: the loop parks until the work settles");
            assert.equal(provider.received.length, 2);
            assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 202]);
            const join = JSON.parse(rows.at(-1)!.rx) as Deferral;
            assert.equal(join.problem, undefined, "a join carries no Problem and no strike");
            assert.deepEqual(join.attrs, { waiting: -1, pending: [kind] });
            assert.equal(join.detail, kind === "workers"
                ? "Completion joined: child workers were still running. The loop waited, and what concluded is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK."
                : "Completion joined: an execution was still running. The loop waited, and what concluded is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 202, "parked on the live obligation, like a waiting inventory");
            return;
        }
        assert.equal(result.result.status, 200, "the settled result is shown, then the same TASK completes");
        assert.equal(provider.received.length, 3);
        assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 102, 200]);
        const deferral = JSON.parse(rows[1]!.rx) as Deferral;
        assert.equal(deferral.problem, undefined, "a deferral carries no Problem and no strike");
        if (kind === "operation-failure" || kind === "kill-failure") {
            assert.deepEqual(deferral.attrs, { failures: 1 });
            assert.equal(deferral.detail, "Completion deferred: 1 operation failed in the same turn. The failure is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
        } else if (kind === "worker-results") {
            assert.deepEqual(deferral.attrs, { pending: ["worker-results"] });
            assert.equal(deferral.detail, "Completion deferred until a child worker's result reached a packet. It is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
        } else {
            assert.deepEqual(deferral.attrs, { pending: ["receipts", "failed-stream-results"] });
            assert.equal(deferral.detail, "Completion deferred until a failed execution result and operation receipts reached a packet. They are in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
        }
        assert.equal((await db.test_get_turn.get<{ status: number }>({ id: finalTurnId }))?.status, 200);
    });
}

test("{§completion-defers-to-results}: an abandonment over a settled result takes the same look, then abandons without waiting for live work", async (t) => {
    const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const child = await insertWorker(db, workspaceId, workerId, "child");
    await insertLoop(db, child, 1, "delegated work that never finishes");
    const provider = new Mock({ contextWindow: 100_000, responses: [
        response("```READ (worker:///answer.md)```", "failed", "I could not finish."),
        response("", "failed", "I could not finish."),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 3, maxStrikes: 3 });
    assert.equal(result.result.status, 499, "the second abandonment concludes although a child is still live");
    assert.equal(result.result.content, "I could not finish.", "the last message rides the failure terminal");
    assert.equal(provider.received.length, 2);
    const rows = await sends();
    assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 499]);
    const deferral = JSON.parse(rows[0]!.rx) as Deferral;
    assert.equal(deferral.problem, undefined, "an abandonment deferral carries no Problem and no strike");
    assert.equal(deferral.detail, "Abandonment deferred until READ reached a packet. It is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
    assert.deepEqual(deferral.attrs, { pending: ["receipts"] });
    assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 499);
});

test("{§completion-defers-to-results}: an abandonment over a same-turn failure defers with the failure count", async (t) => {
    const { engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const provider = new Mock({ contextWindow: 100_000, responses: [
        response("```READ (worker:///missing.md)```", "failed", "Nothing to report."),
        response("", "failed", "Nothing to report."),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 3, maxStrikes: 1 });
    assert.equal(result.result.status, 499);
    const rows = await sends();
    assert.deepEqual(rows.map(({ status_rx }) => status_rx), [102, 499]);
    const deferral = JSON.parse(rows[0]!.rx) as Deferral;
    assert.deepEqual(deferral.attrs, { failures: 1 });
    assert.equal(deferral.detail, "Abandonment deferred: 1 operation failed in the same turn. The failure is in this packet. If your final response has already been sent and these results require no further work or response revision, submit only TASK.");
});
