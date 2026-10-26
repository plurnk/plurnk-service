// {§methods-session-create}: a fresh session has an empty history over the same workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { rpcCall, connect, withDaemon, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

test("{§methods-session-name-admission} {§methods-session-create}: fresh named session — empty log, runLoop accepts", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\nhello from thread-2\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;

            // A named, empty, model-origin root.
            const fresh = await daemon.createSession({ workspaceId, name: "Thread_2" });
            assert.equal(fresh.sessionName, "Thread_2", "the client's name IS the session name");
            assert.equal((await daemon.readLog({ workspaceId, sessionId: fresh.sessionId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin), and the full loop settles on that session.
            const terminated: Array<{ loopId: number; result: { status: number } }> = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
            });
            const accepted = await daemon.runLoop({ workspaceId, sessionId: fresh.sessionId, prompt: "start thread 2" });
            assert.ok(accepted.loopId > 0, "runLoop accepts the fresh session");
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId, result }) => loopId === accepted.loopId && result.status === 200),
                { timeoutMs: 8000 },
            );

            // Name invariants mirror forkSession's: plurnk is an ordinary name; unmintable + taken are legible refusals.
            const plurnk = await daemon.createSession({ workspaceId, name: "plurnk" });
            assert.equal(plurnk.sessionName, "plurnk", "the operator may hold a session named plurnk");
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_plurnk" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.name, "_plurnk");
                    assert.equal(error.result.problem.recovery, "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit."); // {§pinned-wording-core}
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_invalid" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.status, 400);
                    assert.equal(error.result.problem.name, "_invalid");
                    assert.equal(error.result.problem.retryable, false);
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "Thread_2" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict");
                    assert.equal(error.result.problem.workspaceId, workspaceId);
                    assert.equal(error.result.problem.name, "Thread_2");
                    assert.equal(error.result.problem.recovery, "Choose another session name."); // {§problems-functionality}
                    return true;
                },
            );
            // Omission mints a distinct session with an opaque name.
            const anon = await daemon.createSession({ workspaceId });
            assert.match(anon.sessionName, /^[a-f0-9]{8}$/, "an unnamed session receives the ordinary opaque name");
        } finally { ws.close(); }
    });
});

test("{§session-auto-name}: concurrent unnamed fresh sessions claim distinct short names", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `threads-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const sessions = await Promise.all(Array.from(
                { length: 8 },
                () => daemon.createSession({ workspaceId }),
            ));
            const names = sessions.map(({ sessionName }) => sessionName);

            assert.equal(new Set(names).size, sessions.length, "every fresh session remains individually addressable");
            for (const name of names) assert.match(name, /^[a-f0-9]{8}$/);
        } finally { ws.close(); }
    });
});

test("{§methods-session-create}: concurrent requests for one name create it once; the others are refused as name-conflict", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `contest-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const parent = await daemon.createSession({ workspaceId, name: "parent" });
            const attempts: Array<[string, () => Promise<unknown>]> = [
                ["create", () => daemon.createSession({ workspaceId, name: "contested" })],
                ["fork", () => daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "branched" })],
            ];
            for (const [label, attempt] of attempts) {
                const settled = await Promise.allSettled(Array.from({ length: 4 }, attempt));
                assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1, `${label}: one request claims the name`);
                for (const outcome of settled) {
                    if (outcome.status === "fulfilled") continue;
                    assert.ok(outcome.reason instanceof OperationFailureError, `${label}: ${String(outcome.reason)}`);
                    assert.equal(outcome.reason.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict", label);
                    assert.equal(outcome.reason.result.problem.status, 409, label);
                }
            }
        } finally { ws.close(); }
    });
});
