import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, makeMockResponse } from "./_rpc.ts";
import { insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";
import Dsl from "../../src/server/dsl.ts";
import { Mock } from "@plurnk/plurnk-providers";

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

test("[§discovery-discover] Daemon: discover returns catalog", async () => {
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

test("[§errors-error-codes] Daemon: unknown method returns -32601 method-not-found", async () => {
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

test("[§methods-rebind] session.create on an already-attached connection re-binds in place (no reject)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const first = await rpcCall(ws, 1, "session.create", { name: "first" });
            const second = await rpcCall(ws, 2, "session.create", { name: "second" });
            // #196: re-binding is allowed — the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection no longer rejects");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh session");
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

test("[§methods-session-attach] session.attach binds to existing session", async () => {
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
    await withDaemon(new Mock({ contextSize: 8192, responses: [] }), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const original = { ...process.env };
            try {
                process.env.PLURNK_MODEL_gemma = "openai/macher.gguf";
                process.env.PLURNK_MODEL_opus = "openrouter/anthropic/claude-opus";
                process.env.PLURNK_MODEL = "gemma";
                const response = await rpcCall(ws, 1, "providers.list");
                const result = response.result as {
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean; contextSize: number | null }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
                // #263/#345 — the active alias carries the EFFECTIVE prompt budget (window minus the
                // partition reserves — one denominator meaning on every surface, never the raw KV);
                // an inactive alias is null (provider not instantiated) so the client omits the gauge.
                const budget = 8192 - Number(process.env.PLURNK_SERVICE_REASONING) - Number(process.env.PLURNK_SERVICE_ASSISTANT) - Number(process.env.PLURNK_SERVICE_SAFETY);
                assert.equal(gemma?.contextSize, budget, "active alias carries the effective prompt budget, not the raw window");
                assert.equal(opus?.contextSize, null, "inactive alias has no window → null");
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

test("loop.run with unknown alias returns a clear, case-fold-aware error", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "alias-test" });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.attach", { id: session?.id });
            // Request an UPPERCASE alias (guaranteed-unconfigured): the suggestion must lowercase
            // it (aliases case-fold), never echo PLURNK_MODEL_ZQX — the misdirection that read to
            // the owner as "capitalizing my aliases".
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "hi", alias: "ZQX" });
            assert.equal(response.error?.code, -32603);
            const msg = response.error?.message ?? "";
            assert.match(msg, /unknown alias 'ZQX'/, "echoes the requested alias verbatim");
            assert.match(msg, /PLURNK_MODEL_zqx\b/, "suggests the case-folded (lowercase) key");
            assert.doesNotMatch(msg, /PLURNK_MODEL_ZQX/, "never the uppercased key — casing is not the cause");
            assert.match(msg, /case-fold/, "tells the operator casing isn't the issue");
            assert.match(msg, /the daemon knows:/, "lists the daemon's known aliases to expose an env gap");
        } finally { ws.close(); }
    });
});

test("loop.run accepts a client-resolved provider/model, instantiated with the daemon's keys", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const session = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name: "client-model" });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.attach", { id: session?.id });
            // Malformed: needs the '<provider>/<model>' shape (same split as the env knob).
            const bad = await rpcCall(ws, 2, "loop.run", { prompt: "hi", model: "noslash" });
            assert.equal(bad.error?.code, -32603);
            assert.match(bad.error?.message ?? "", /model must be '<provider>\/<model>'/);
            // Well-formed but unknown provider: the client-resolved path reaches instantiation
            // (proving it bypassed the daemon's alias lookup) and fails clearly on the missing package.
            const unknown = await rpcCall(ws, 3, "loop.run", { prompt: "hi", model: "nope-xyz/some-model" });
            assert.equal(unknown.error?.code, -32603);
            assert.match(unknown.error?.message ?? "", /@plurnk\/plurnk-providers-nope-xyz.*not installed/);
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
        await rpcCall(ws, 2, "op.edit", { target: "known:///x", content: "y" });
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

test("the client-interface seam — subscribeToEvents delivers session-scoped engine events in-process (#355)", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-agui)
    // subscribes here and fans out to its OWN clients, instead of being welded to the WS connections.
    await withDaemon(null, async (_db, daemon, addr) => {
        const received: Array<{ sessionId: number | null; method: string; params: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((sessionId, method, params) => { received.push({ sessionId, method, params }); });
        const ws = await connect(addr);
        try {
            const s = ((await rpcCall(ws, 1, "session.create", { name: "seam" })).result as { id: number }).id;
            const isCreated = (e: { method: string; params: unknown }): boolean => e.method === "session/created" && (e.params as { id?: number }).id === s;
            await waitFor(() => received, (r) => r.some(isCreated), { timeoutMs: 4000 });
            assert.ok(received.some(isCreated), "the in-process subscriber received the engine event — the emit source is decoupled from the WS fan-out");
            unsubscribe();
            const countAfter = received.length;
            await rpcCall(ws, 2, "session.create", { name: "seam-2" });
            await flush();
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — pendingProposals reads a session's stopped-world; resolveProposal delegates the decision (#355)", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const sessionId = await insertSession(db, `prop-seam-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A stopped-world proposal (state='proposed') the module would render as a TOOL_CALL.
        await (db.engine_insert_log_entry as PrepMethod).get({
            run_id: runId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, op: "EDIT", suffix: "", signal: null,
            scheme: "known", username: null, password: null, hostname: null, port: null,
            pathname: "/x", params: null, fragment: null, lineMarker: null,
            tx: "<<EDIT(known:///x):body:EDIT", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
            status_rx: 202, tokens: 0, state: "proposed", outcome: null, attrs: "{}",
        });
        const pending = await daemon.pendingProposals(sessionId);
        assert.equal(pending.length, 1, "the seam reads the session's stopped-world proposal");
        assert.equal(pending[0].op, "EDIT");
        assert.equal(pending[0].loopId, loopId);
        // resolveProposal delegates to Engine.resolveProposal — an unknown id throws (no registered waiter),
        // proving the seam routes into the engine's proposal machinery, not a shadow implementation.
        assert.throws(() => daemon.resolveProposal(999999, { decision: "accept" }), /no pending proposal/i, "resolveProposal delegates to the engine");
    });
});

test("the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law (#355)", async () => {
    // The loop-control hook: the module supplies only session/run/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-runloop" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            const events: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

            const res = await daemon.runLoop({ sessionId: created.id, runId: run.id, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { finalStatus?: number }).finalStatus, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — dispatchAsClient runs a client op through the engine and emits log/entry (#355)", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-dispatch" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });

            // WRITE then READ known:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildEdit({ target: "known:///x", content: "seam" }) });
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildRead({ target: "known:///x" }) });
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (agui fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — readLog returns a session's journal, ownership-verified (#355)", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-session invariant proven: a session reads only its own runs (core holds it, not the module).
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-read" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildEdit({ target: "known:///x", content: "read me" }) });

            const entries = await daemon.readLog({ sessionId: created.id, runId: run.id });
            assert.ok(entries.length >= 1, "readLog returned the session's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "session.create", { name: "seam-read-other" })).result as { id: number };
            const otherRun = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: other.id }))!;
            await assert.rejects(() => daemon.readLog({ sessionId: created.id, runId: otherRun.id }), /not in session/, "readLog refuses a run outside the session — core holds its own invariant");
        } finally { ws.close(); }
    });
});
