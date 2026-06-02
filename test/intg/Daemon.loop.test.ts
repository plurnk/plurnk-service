import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

test("[§13.5-loop-run] loop.run with mock provider runs a model turn and persists entries", async () => {
    const dsl = "<<EDIT(known://france/capital):Paris:EDIT\n<<SEND[200]:Paris is the capital.:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 142)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "loop-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "what is the capital of france?" });
            const result = response.result as { loopId: number; turnIds: number[]; finalStatus: number; hitMaxTurns: boolean };
            assert.equal(result.finalStatus, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds.length, 1);

            const entryCount = (await (db.test_count_entries as PrepMethod).get<{ n: number }>())?.n;
            // known://france/capital + plurnk://prompt/<loop_id> + plurnk://manifest.json
            assert.equal(entryCount, 3);
        } finally { ws.close(); }
    });
});

test("loop.run streams log/entry notifications during execution", async () => {
    const dsl = "<<EDIT(known://x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "session.create", { name: "stream-test" });
            await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            await flush();

            const captured = logEntries();
            assert.equal(captured.length, 2);
            const first = captured[0] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const second = captured[1] as { entry: { op: string; status_rx: number } };
            assert.equal(second.entry.op, "SEND");
            assert.equal(second.entry.status_rx, 200);
        } finally { ws.close(); }
    });
});

test("loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "<<EDIT(known://x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "session.create", { name: "term-test" });
            await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            await flush();

            const captured = terminated();
            assert.equal(captured.length, 1);
            const params = captured[0] as { loopId: number; finalStatus: number; hitMaxTurns: boolean };
            assert.equal(params.finalStatus, 200);
            assert.equal(params.hitMaxTurns, false);
        } finally { ws.close(); }
    });
});

test("loop.run without provider returns 501", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; error?: string };
            assert.equal(result.status, 501);
        } finally { ws.close(); }
    });
});

test("loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /non-empty params\.prompt/);
        } finally { ws.close(); }
    });
});

test("loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "<<EDIT(known://x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    const mock = new Mock({ contextSize: 8192, responses });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "maxturns-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "iterate", maxTurns: 3 });
            const result = response.result as { finalStatus: number; hitMaxTurns: boolean; turnIds: number[] };
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 499);
            assert.equal(result.turnIds.length, 3);
        } finally { ws.close(); }
    });
});

test("discover catalog includes loop.run and loop/terminated", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, { longRunning?: boolean }>; notifications: Record<string, unknown> };
            assert.ok(cat.methods["loop.run"] !== undefined);
            assert.equal(cat.methods["loop.run"].longRunning, true);
            assert.ok(cat.notifications["loop/terminated"] !== undefined);
        } finally { ws.close(); }
    });
});
