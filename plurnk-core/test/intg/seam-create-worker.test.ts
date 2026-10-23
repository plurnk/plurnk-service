// {§methods-worker-create}: a fresh worker has an empty history over the same workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { rpcCall, connect, withDaemon, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

test("{§methods-worker-name-admission} {§methods-worker-create}: fresh named worker — empty log, runLoop accepts", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\nhello from thread-2\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;

            // A named, empty, model-origin root.
            const fresh = await daemon.createWorker({ workspaceId, name: "Thread_2" });
            assert.equal(fresh.workerName, "Thread_2", "the client's name IS the worker name");
            assert.equal((await daemon.readLog({ workspaceId, workerId: fresh.workerId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin), and the full loop settles on that worker.
            const terminated: Array<{ loopId: number; result: { status: number } }> = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
            });
            const accepted = await daemon.runLoop({ workspaceId, workerId: fresh.workerId, prompt: "start thread 2" });
            assert.ok(accepted.loopId > 0, "runLoop accepts the fresh worker");
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId, result }) => loopId === accepted.loopId && result.status === 200),
                { timeoutMs: 8000 },
            );

            // Name invariants mirror forkWorker's: plurnk is an ordinary name; unmintable + taken are legible refusals.
            const plurnk = await daemon.createWorker({ workspaceId, name: "plurnk" });
            assert.equal(plurnk.workerName, "plurnk", "the operator may hold a worker named plurnk");
            await assert.rejects(
                () => daemon.createWorker({ workspaceId, name: "_plurnk" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/name-invalid");
                    assert.equal(error.result.problem.name, "_plurnk");
                    assert.equal(error.result.problem.recovery, "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit."); // {§pinned-wording-core}
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createWorker({ workspaceId, name: "_invalid" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/name-invalid");
                    assert.equal(error.result.problem.status, 400);
                    assert.equal(error.result.problem.name, "_invalid");
                    assert.equal(error.result.problem.retryable, false);
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createWorker({ workspaceId, name: "Thread_2" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/name-conflict");
                    assert.equal(error.result.problem.workspaceId, workspaceId);
                    assert.equal(error.result.problem.name, "Thread_2");
                    assert.equal(error.result.problem.recovery, "Choose another worker name."); // {§problems-functionality}
                    return true;
                },
            );
            // Omission mints a distinct worker with an opaque name.
            const anon = await daemon.createWorker({ workspaceId });
            assert.match(anon.workerName, /^[a-f0-9]{8}$/, "an unnamed worker receives the ordinary opaque name");
        } finally { ws.close(); }
    });
});

test("{§worker-auto-name}: concurrent unnamed fresh workers claim distinct short names", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `threads-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const workers = await Promise.all(Array.from(
                { length: 8 },
                () => daemon.createWorker({ workspaceId }),
            ));
            const names = workers.map(({ workerName }) => workerName);

            assert.equal(new Set(names).size, workers.length, "every fresh worker remains individually addressable");
            for (const name of names) assert.match(name, /^[a-f0-9]{8}$/);
        } finally { ws.close(); }
    });
});

test("{§methods-worker-create}: concurrent requests for one name create it once; the others are refused as name-conflict", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `contest-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const parent = await daemon.createWorker({ workspaceId, name: "parent" });
            const attempts: Array<[string, () => Promise<unknown>]> = [
                ["create", () => daemon.createWorker({ workspaceId, name: "contested" })],
                ["fork", () => daemon.forkWorker({ workspaceId, workerId: parent.workerId, name: "branched" })],
            ];
            for (const [label, attempt] of attempts) {
                const settled = await Promise.allSettled(Array.from({ length: 4 }, attempt));
                assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1, `${label}: one request claims the name`);
                for (const outcome of settled) {
                    if (outcome.status === "fulfilled") continue;
                    assert.ok(outcome.reason instanceof OperationFailureError, `${label}: ${String(outcome.reason)}`);
                    assert.equal(outcome.reason.result.problem.type, "https://problems.plurnk.xyz/daemon/worker/name-conflict", label);
                    assert.equal(outcome.reason.result.problem.status, 409, label);
                }
            }
        } finally { ws.close(); }
    });
});
