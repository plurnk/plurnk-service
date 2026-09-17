import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { lastReply, openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";

const frame = PlurnkParser.frame;
const response = (...program: string[]) => ({ assistant: { content: program.join("\n\n"), reasoning: null } });
const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `observe-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1, "Report the saved answer.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "worker", pathname: "/answer.md", channel: "body",
        content: "The answer is 42.", mimetype: "text/markdown", state: "static",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        cancelWorker: async (id, reason) => { await new LoopLifecycle(db).cancelTree(id, reason, true); },
    });
    return { db, workspaceId, workerId, loopId, engine };
};

for (const [op, maxStrikes] of [["READ (worker:///answer.md)", 0], ["READ (worker:///answer.md)", 1],
    ["READ (worker:///answer.md)", 3], ["FIND (worker:///answer.md)", 3], ["BARE", 3]] as const) {
    test(`{§completion-defers-to-results} ${op}, tolerance ${maxStrikes}: observe the result without repeating the answer`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId } = await fixture(t);
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame(op, op === "BARE" ? "What is six times seven?" : null), frame("SEND", "The answer is 42.")),
            response(frame("NOTE", "The result confirms the answer.")),
        ] });
        const childProvider = new Mock({ contextWindow: 100000, responses: [response("42")] });
        const result = await engine.runLoop({ provider, childProvider, workspaceId, workerId, loopId, messages: [], maxTurns: 3, maxStrikes });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "The answer is 42.");
        assert.equal(provider.received.length, 2);
        assert.match(JSON.stringify(provider.received[1]), /42/, "the observation packet contains the result");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
        const authored = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(authored.map(({ op }) => op), [op.split(" ")[0], "SEND", "NOTE"], "no synthetic terminal operation");
        assert.equal(authored.find(({ op }) => op === "SEND")?.status_rx, 200, "reply delivery is not deferred");
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), [102, 200]);
    });
}

test("{§loop-response-messages} observation permits a corrected reply", async (t) => {
    const { db, engine, workspaceId, workerId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (worker:///answer.md)", null), frame("SEND", "The answer is 41.")),
        response(frame("SEND", "Correction: the answer is 42.")),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Correction: the answer is 42.");
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 41.", "Correction: the answer is 42."]);
});

for (const target of ["log:///999/*/*", "worker:///answer.md"]) {
    test(`{§send-premature-terminate} successful KILL ${target} does not impose an observation turn`, async (t) => {
        const { engine, workspaceId, workerId, loopId } = await fixture(t);
        const provider = new Mock({ contextWindow: 100000, responses: [response(frame(`KILL (${target})`, null), frame("SEND", "Finished."))] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 1 });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 1);
    });
}

test("{§send-premature-terminate} curation cannot turn a same-turn READ into an observed result", async (t) => {
    const { engine, workspaceId, workerId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [response(
        frame("READ (worker:///answer.md)", null), frame("KILL (log:///**/READ)", null), frame("SEND", "Finished."),
    )] });
    const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
    assert.equal(turn.status, 102);
    assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [["READ", 200], ["KILL", 200], ["SEND", 200]]);
});

test("{§completion-defers-to-results} repeated work costs observations, not ceremony strikes", async (t) => {
    const { db, engine, workspaceId, workerId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (worker:///answer.md)", null), frame("SEND", "The answer is 42.")),
        response(frame("FIND (worker:///answer.md)", null)),
        response(frame("NOTE", "Confirmed.")),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 4, maxStrikes: 1 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
});

for (const kind of ["workers", "streams", "failed-stream-results", "late-failed-stream-results", "worker-results", "operation-failure", "kill-failure"] as const) {
    test(`{§completion-defers-to-results} ${kind} arriving after packet assembly prevents premature conclusion`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId } = await fixture(t);
        const live = kind === "workers" || kind === "streams";
        const operation = kind === "operation-failure" ? "READ (worker:///missing.md)" : kind === "kill-failure" ? "KILL (worker:///missing.md)" : "NOTE";
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame("READ (worker:///answer.md)", null), frame("SEND", "The answer is 42.")),
            response(frame(operation, null)), response(frame("NOTE", "Observed the result.")),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
            if (provider.received.length === 1) {
                if (kind === "workers" || kind === "worker-results") {
                    const child = await insertWorker(db, workspaceId, workerId, "child");
                    const childLoop = await insertLoop(db, child, 1, "Delegated work.");
                    if (kind === "worker-results") await new LoopLifecycle(db).finish(childLoop, { status: 200, content: "Child result", mimetype: "text/plain" });
                } else if (["streams", "failed-stream-results", "late-failed-stream-results"].includes(kind)) {
                    const count = kind === "late-failed-stream-results" ? 9 : 1;
                    for (let index = 0; index < count; index++) {
                        const path = `/stream-${index}`;
                        const entryId = await seedEntryWithChannel(db, { workspaceId, authority: "alice", scheme: "worker", pathname: path,
                            channel: "stdout", content: "Working", mimetype: "text/plain", state: "active" });
                        const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "worker", handle: path, publishedChannel: "stdout" });
                        if (kind !== "streams") await ChannelWrite.closeSubscription(db, { subscriptionId,
                            result: index === count - 1 ? Results.failure("executor:fixture", "failed", 500, "Fixture stream failed.") : { status: 200 },
                        });
                    }
                }
            }
            return generate(args);
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 5 });
        assert.equal(result.result.status, live ? 202 : 200);
        assert.equal(provider.received.length, live ? 2 : 3);
        if (!live) assert.match(JSON.stringify(provider.received[2]), kind === "worker-results" ? /Child result/ : kind.endsWith("stream-results") ? /Fixture stream failed/ : /404/);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), live ? [102, 202] : [102, 102, 200]);
    });
}

test("{§worker-cancel-trigger} explicit scope cancellation does not wait for result observation", async (t) => {
    const { engine, db, workspaceId, workerId, loopId } = await fixture(t);
    const childId = await insertWorker(db, workspaceId, workerId, "child");
    const childLoop = await insertLoop(db, childId, 1, "Still working.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(frame("READ (worker:///missing.md)", null),
        frame("SEND", "Stopping the work."), frame("KILL (worker://alice)", null))] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Stopping the work.");
    assert.equal(await new LoopLifecycle(db).status(childLoop), 499);
    assert.equal(provider.received.length, 1);
});
