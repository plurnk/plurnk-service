import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

test("Daemon: start binds to ephemeral port and reports the address", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        assert.equal(addr.host, "127.0.0.1");
        assert.ok(addr.port > 0);
    });
});

test("Daemon: ping returns empty result without requiring init", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "ping");
            assert.deepEqual(response.result, {});
            assert.equal(response.error, undefined);
        } finally { ws.close(); }
    });
});

test("Daemon: discover returns catalog", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { protocolVersion: string; methods: Record<string, unknown>; notifications: Record<string, unknown> };
            assert.equal(cat.protocolVersion, "0.1.0");
            assert.ok(cat.methods.ping !== undefined);
            assert.ok(cat.methods.discover !== undefined);
            assert.ok(cat.methods["session.create"] !== undefined);
            assert.ok(cat.methods["session.list"] !== undefined);
            assert.ok(cat.methods["session.attach"] !== undefined);
            assert.ok(cat.notifications["session/created"] !== undefined);
        } finally { ws.close(); }
    });
});

test("Daemon: unknown method returns -32601 method-not-found", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "nonexistent.method");
            assert.equal(response.error?.code, -32601);
        } finally { ws.close(); }
    });
});

test("Daemon: malformed JSON returns -32700 parse-error", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const messagePromise = new Promise<RpcResponse>((resolve) => {
                ws.once("message", (data) => {
                    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
                    resolve(JSON.parse(text) as RpcResponse);
                });
            });
            ws.send("this is not json");
            const response = await messagePromise;
            assert.equal(response.id, null);
            assert.equal(response.error?.code, -32700);
        } finally { ws.close(); }
    });
});

test("session.create returns id+name and emits notification", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "session/created");
            const response = await rpcCall(ws, 1, "session.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            await flush();
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            const sessionList = await (db.test_list_sessions as PrepMethod).all<{ name: string }>();
            assert.ok(sessionList.some((s) => s.name === "alpha"));
            const run = await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: result.id });
            assert.ok((run?.id ?? 0) > 0);
            // No client loop yet — allocation is lazy (deferred until the
            // first client-origin op). A connection that only ran session.*
            // RPCs has nothing to spend a loop sequence on, so loop.run
            // gets sequence=1 instead of 2.
            const loop = await (db.test_get_loop_by_run as PrepMethod).get<{ id: number }>({ run_id: run?.id });
            assert.equal(loop, undefined);
        } finally { ws.close(); }
    });
});

test("session.create with no name auto-generates a unique name", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.create");
            const result = response.result as { id: number; name: string };
            assert.ok(result.name.length > 0);
            assert.match(result.name, /^session-/);
        } finally { ws.close(); }
    });
});

test("session.create rejects when already attached", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "first" });
            const response = await rpcCall(ws, 2, "session.create", { name: "second" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /already has a session/);
        } finally { ws.close(); }
    });
});

test("session.list returns sessions most-recent-first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        await (db.test_sessions_insert_name_only as PrepMethod).run({ name: "first" });
        await (db.test_sessions_insert_name_only as PrepMethod).run({ name: "second" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.list");
            const result = response.result as { sessions: Array<{ id: number; name: string }> };
            assert.equal(result.sessions.length, 2);
            const names = result.sessions.map((s) => s.name).toSorted();
            assert.deepEqual(names, ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("session.attach binds to existing session", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const existing = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "existing" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: existing?.id });
            const result = response.result as { id: number; name: string };
            assert.equal(result.id, existing?.id);
            assert.equal(result.name, "existing");

            const run = await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: existing?.id });
            assert.ok(run !== undefined);
            // Client loop allocation is lazy. session.attach alone doesn't
            // spend a loop sequence; the first op.* would.
            const loop = await (db.test_get_loop_by_run as PrepMethod).get<{ id: number }>({ run_id: run?.id });
            assert.equal(loop, undefined);
        } finally { ws.close(); }
    });
});

test("session.attach to nonexistent session returns -32603", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: 9999 });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /session 9999 not found/);
        } finally { ws.close(); }
    });
});

test("session.attach with runName: creates new run with that name", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "name-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: session?.id, runName: "research-task-42" });
            const result = response.result as { id: number; runId: number; runName: string };
            assert.equal(result.runName, "research-task-42");
            const run = await (db.test_runs_get_by_session as PrepMethod).get<{ id: number; name: string }>({ session_id: session?.id });
            assert.equal(run?.id, result.runId);
            assert.equal(run?.name, "research-task-42");
        } finally { ws.close(); }
    });
});

test("session.attach with runName: reuses existing run when name matches", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "reuse-test" });
        const ws1 = await connect(addr);
        try {
            const r1 = await rpcCall(ws1, 1, "session.attach", { id: session?.id, runName: "shared-run" });
            const result1 = r1.result as { runId: number };
            ws1.close();
            const ws2 = await connect(addr);
            try {
                const r2 = await rpcCall(ws2, 1, "session.attach", { id: session?.id, runName: "shared-run" });
                const result2 = r2.result as { runId: number; runName: string };
                assert.equal(result2.runId, result1.runId, "second attach to same runName reuses the run id");
                assert.equal(result2.runName, "shared-run");
                const runCount = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
                assert.equal(runCount?.n, 1, "still only one run row");
            } finally { ws2.close(); }
        } finally { /* ws1 already closed */ }
    });
});

test("session.attach with runId: reuses that specific run", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "runid-test" });
        const run = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: session?.id, name: "pre-existing" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: session?.id, runId: run?.id });
            const result = response.result as { runId: number; runName: string };
            assert.equal(result.runId, run?.id);
            assert.equal(result.runName, "pre-existing");
        } finally { ws.close(); }
    });
});

test("session.attach with runId belonging to different session returns -32603", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const sA = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "sA" });
        const sB = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "sB" });
        const runInA = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: sA?.id, name: "in-A" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: sB?.id, runId: runInA?.id });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /belongs to session/);
        } finally { ws.close(); }
    });
});

test("session.attach with non-existent runId returns -32603", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "norun-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: session?.id, runId: 99999 });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /run 99999 not found/);
        } finally { ws.close(); }
    });
});

test("session.attach with both runId and runName rejects", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "both-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: session?.id, runId: 1, runName: "x" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /runId OR runName, not both/);
        } finally { ws.close(); }
    });
});

test("providers.list returns parsed aliases with active marker", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const original = { ...process.env };
            try {
                process.env.PLURNK_MODEL_gemma = "openai/macher.gguf";
                process.env.PLURNK_MODEL_opus = "openrouter/anthropic/claude-opus";
                process.env.PLURNK_MODEL = "gemma";
                const response = await rpcCall(ws, 1, "providers.list");
                const result = response.result as {
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
            } finally {
                // Restore env so other tests aren't polluted.
                for (const k of Object.keys(process.env)) {
                    if (!(k in original)) delete process.env[k];
                }
                Object.assign(process.env, original);
            }
        } finally { ws.close(); }
    });
});

test("loop.run with unknown alias returns clear error", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "alias-test" });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.attach", { id: session?.id });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "hi", alias: "nonexistent-alias-xyz" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /unknown alias 'nonexistent-alias-xyz'/);
        } finally { ws.close(); }
    });
});

test("session.runs lists runs in the session, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "list-runs" });
        await (db.test_runs_insert as PrepMethod).run({ session_id: session?.id, name: "first" });
        await (db.test_runs_insert as PrepMethod).run({ session_id: session?.id, name: "second" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.runs", { id: session?.id });
            const result = response.result as { runs: Array<{ id: number; name: string }> };
            assert.equal(result.runs.length, 2);
            assert.deepEqual(result.runs.map((r) => r.name).toSorted(), ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("multiple connections attaching to same session each get their own run", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "shared" });

        const ws1 = await connect(addr);
        const ws2 = await connect(addr);
        try {
            await rpcCall(ws1, 1, "session.attach", { id: session?.id });
            await rpcCall(ws2, 1, "session.attach", { id: session?.id });

            const countAfter = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
            assert.equal(countAfter?.n, 2);
        } finally { ws1.close(); ws2.close(); }
    });
});

test("session/created notification broadcasts to other connected clients", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "session/created");

            await rpcCall(creator, 1, "session.create", { name: "broadcast-test" });
            await flush();

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally { observer.close(); creator.close(); }
    });
});

test("client loop status transitions to 200 on clean disconnect (after a client op spawns the loop)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        const response = await rpcCall(ws, 1, "session.create", { name: "lifecycle" });
        const result = response.result as { id: number };
        const run = await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: result.id });

        // No loop yet — allocation is lazy.
        assert.equal(await (db.test_get_loop_by_run as PrepMethod).get({ run_id: run?.id }), undefined);

        // First op lazily creates the client loop.
        await rpcCall(ws, 2, "op.edit", { target: "known://x", content: "y" });
        const loop = await (db.test_get_loop_by_run as PrepMethod).get<{ id: number }>({ run_id: run?.id });
        const loopId = loop!.id;

        let status = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(status, 102);

        ws.close();
        await new Promise((r) => setTimeout(r, 50));

        status = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(status, 200);
    });
});
