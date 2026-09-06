import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";

const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `final-strike-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "report the saved answer");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "worker", pathname: "/answer.md", channel: "body",
        content: "The answer is 42.", mimetype: "text/markdown", state: "static",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const sends = async () => (await db.test_log_entries_by_worker_op_full.all<{
        origin: string; status_rx: number; tx: string; rx: string;
    }>({ worker_id: workerId, op: "SEND" })).filter(({ origin }) => origin === "model");
    return { db, workspaceId, workerId, loopId, engine, sends };
};

const response = (operation: string, disposition = "TERM", body = "The answer is 42.") => ({
    assistant: {
        content: `## PLAN0\n[]\n${operation}\n### SEND0 (${disposition})\n${body}`,
        reasoning: null,
    },
});

for (const { name, operation, maxStrikes } of [
    { name: "READ at zero tolerance", operation: "### READ0 (worker:///answer.md)", maxStrikes: 0 },
    { name: "READ at one strike", operation: "### READ0 (worker:///answer.md)", maxStrikes: 1 },
    { name: "repeated READ", operation: "### READ0 (worker:///answer.md)", maxStrikes: 3 },
    { name: "READ at five strikes", operation: "### READ0 (worker:///answer.md)", maxStrikes: 5 },
    { name: "FIND", operation: "### FIND0 (worker:///answer.md)", maxStrikes: 3 },
    { name: "BARE", operation: "### BARE0\nWhat is six times seven?", maxStrikes: 3 },
]) {
    test(`{§send-final-strike-retrieval}: ${name} concludes at the existing limit without rewriting prior refusals`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
        const attempts = Math.max(1, maxStrikes);
        const emission = response(operation);
        const provider = new Mock({ contextWindow: 100_000, responses: Array.from({ length: attempts + 1 }, () => emission) });
        const childProvider = new Mock({
            contextWindow: 100_000,
            responses: Array.from({ length: attempts }, () => ({ assistant: { content: "42", reasoning: null } })),
        });
        const result = await engine.runLoop({
            provider, childProvider, workspaceId, workerId, loopId, messages: [],
            maxTurns: attempts + 1, maxStrikes,
        });

        assert.equal(result.result.status, 200, "the final retrieval-only completion is accepted, not converted into loop failure");
        assert.equal(result.result.content, "The answer is 42.", "the actual authored conclusion is retained");
        assert.equal(provider.received.length, attempts, "the existing threshold controls the allowance");
        assert.equal(provider.remaining, 1, "completion requires no extra inference");
        assert.deepEqual((await sends()).map(({ status_rx }) => status_rx), [
            ...Array.from({ length: attempts - 1 }, () => 409), 200,
        ]);
        for (const row of (await sends()).slice(0, -1)) {
            assert.equal(JSON.parse(row.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/retrieval-results-unobserved");
        }
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200);
        const finalTurnId = result.turnIds.at(-1);
        assert.ok(finalTurnId !== undefined);
        const turn = await db.test_get_turn.get<{ status: number }>({ id: finalTurnId });
        assert.equal(turn?.status, 200, "durable turn and loop agree with the SEND receipt");
        const programs = await db.test_model_source_rows.all<{ id: number; turn_id: number }>({ worker_id: workerId });
        const program = programs.find(({ turn_id }) => turn_id === finalTurnId);
        assert.ok(program, "the accepted program has its own durable source row");
        const source = await db.test_get_log_entry_by_id.get<{ rx: string }>({ id: program.id });
        assert.equal(JSON.parse(source!.rx).content, emission.assistant.content);
    });
}

test("{§send-final-strike-retrieval}: a clean turn resets the allowance with the ordinary strike streak", async (t) => {
    const { engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const read = "### READ0 (worker:///answer.md)";
    const provider = new Mock({ contextWindow: 100_000, responses: [
        response(read), response(read), response(read, "NEXT"),
        response(read), response(read), response(read),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 7, maxStrikes: 3 });
    assert.equal(result.result.status, 200);
    assert.deepEqual((await sends()).map(({ status_rx }) => status_rx), [409, 409, 102, 409, 409, 200]);
    assert.equal(provider.received.length, 6);
});

for (const kind of ["workers", "streams", "failed-stream-results", "worker-results", "operation-failure"] as const) {
    test(`{§send-final-strike-retrieval}: final-strike TERM remains blocked by ${kind}`, async (t) => {
        const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
        const read = "### READ0 (worker:///answer.md)";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response(read), response(read),
            response(kind === "operation-failure" ? `${read}\n### READ0 (worker:///missing.md)` : read),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
            if (provider.received.length === 2) {
                if (kind === "workers" || kind === "worker-results") {
                    const child = await insertWorker(db, workspaceId, workerId, "child");
                    const childLoop = await insertLoop(db, child, 1, "finish the delegated work");
                    if (kind === "worker-results") {
                        await new LoopLifecycle(db).finish(childLoop, { status: 200, content: "Child result", mimetype: "text/plain" });
                    }
                } else if (kind === "streams" || kind === "failed-stream-results") {
                    const entryId = await seedEntryWithChannel(db, {
                        workspaceId, ownerId: workerId, scheme: "worker", pathname: "/running",
                        channel: "stdout", content: "Working", mimetype: "text/plain", state: "active",
                    });
                    const subscriptionId = await ChannelWrite.openSubscription(db, {
                        workerId, entryId, scheme: "worker", handle: "running", publishedChannel: "stdout",
                    });
                    if (kind === "failed-stream-results") {
                        await ChannelWrite.closeSubscription(db, {
                            subscriptionId,
                            result: Results.failure("executor:fixture", "failed", 500, "Fixture stream failed."),
                        });
                    }
                }
            }
            return generate(args);
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 4, maxStrikes: 3 });
        assert.equal(result.result.status, 500, "the completion allowance cannot discard this obligation or failure");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(provider.received.length, 3);
        const rows = await sends();
        assert.deepEqual(rows.map(({ status_rx }) => status_rx), [409, 409, 409]);
        const problem = JSON.parse(rows.at(-1)!.rx).problem;
        if (kind === "operation-failure") {
            assert.equal(problem.type, "https://problems.plurnk.xyz/engine/dispatcher/unobserved-failures");
            assert.equal(problem.failures, 1);
        } else {
            assert.equal(problem.type, "https://problems.plurnk.xyz/engine/dispatcher/work-remains");
            assert.deepEqual(problem.pending, kind === "streams" || kind === "workers" ? [kind, "receipts"] : ["receipts", kind]);
        }
        const finalTurnId = result.turnIds.at(-1);
        assert.ok(finalTurnId !== undefined);
        assert.equal((await db.test_get_turn.get<{ status: number }>({ id: finalTurnId }))?.status, 102);
    });
}

test("{§send-final-strike-retrieval}: a different loop does not inherit the allowance", async (t) => {
    const { db, engine, workspaceId, workerId, loopId, sends } = await fixture(t);
    const read = "### READ0 (worker:///answer.md)";
    const first = await engine.runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [response(read), response(read)] }),
        workspaceId, workerId, loopId, messages: [], maxTurns: 2, maxStrikes: 3,
    });
    assert.equal(first.result.status, 429);
    const nextLoopId = await insertLoop(db, workerId, 2, "answer again");
    const second = await engine.runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [response(read), response(read), response(read)] }),
        workspaceId, workerId, loopId: nextLoopId, messages: [], maxTurns: 4, maxStrikes: 3,
    });
    assert.equal(second.result.status, 200);
    assert.deepEqual((await sends()).map(({ status_rx }) => status_rx), [409, 409, 409, 409, 200]);
});

test("{§send-final-strike-retrieval}: the final allowance does not turn an idle NEXT into completion", async (t) => {
    const { engine, workspaceId, workerId, loopId } = await fixture(t);
    const read = "### READ0 (worker:///answer.md)";
    const result = await engine.runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [response(read), response(read), response("", "NEXT")] }),
        workspaceId, workerId, loopId, messages: [], maxTurns: 4, maxStrikes: 3,
    });
    assert.equal(result.result.status, 500);
    assert.equal(result.reason, "strike_threshold");
});
