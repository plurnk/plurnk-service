import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, makeMockResponse } from "./_rpc.ts";
import { insertSession, insertRun, insertLoop, insertTurn, openMigrated } from "./_helpers.ts";
import Daemon from "../../src/server/Daemon.ts";
import type { CoreSeam } from "../../src/server/Daemon.ts";
import Dsl from "../../src/server/dsl.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";

// A stand-in registration in the booth-window shape (execs-mcp installServer's hotload struct):
// framework types only — decl + executor + the driver's probe result. The kernel wraps the
// RegistryEntry itself; registration needs no live driver (the scheme face reads lazily at dispatch).
const fakeRegistration = (tag: string) => ({
    decl: { name: tag, glyph: "🔌", example: `<<EXEC[${tag}]:?:EXEC`, documentation: "" },
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() { return { name: tag } as unknown as never; },
        get defaultChannel() { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    availability: { available: true, detail: "fake" },
});
import { Mock } from "@plurnk/plurnk-providers";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

test("Daemon: listenerless boot — the seam is live with no socket bound (#364)", async () => {
    await withDaemon(null, async (_db, daemon, _addr) => {
        // No port, no listener — the seam itself is the surface. A basic seam read proves boot.
        const sessions = await daemon.listSessions();
        assert.ok(Array.isArray(sessions), "the seam answers");
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
            const events: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

            // §machine-processes — loops run in the MODEL run the seam resolves; a client run is
            // refused loudly (the module's envelope runId is the client run — never the loop home).
            const clientRun = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            await assert.rejects(() => daemon.runLoop({ sessionId: created.id, runId: clientRun.id, prompt: "go" }), /client run/, "runLoop refuses a client-origin run");
            const modelRunId = await daemon.ensureModelRun(created.id);
            const res = await daemon.runLoop({ sessionId: created.id, runId: modelRunId, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { finalStatus?: number }).finalStatus, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");

            // The marquee first-turn feature holds on the seam path: runLoop materialized the
            // teaching docs BEFORE the loop, so the turn-1 FIND(plurnk://docs/**) foist finds them.
            // (The gap that shipped: agui-driven sessions started docless and the foist reported 0.)
            const docs = await (db.test_entries_by_scheme_prefix as PrepMethod).all<{ pathname: string }>({ session_id: created.id, scheme: "plurnk", prefix: "/docs/%" });
            assert.ok(docs.length > 0, "runLoop materialized plurnk://docs/*.md — the discovery foist has something to find");
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
            await assert.rejects(() => daemon.readLog({ sessionId: created.id, runId: otherRun.id }), /not in this session/, "readLog refuses a run outside the session — core holds its own invariant");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — the metadata reads surface providers, sessions, runs, and constraints (#355)", async () => {
    // The render surface beyond the journal: providers+budget, sessions, runs, and the constraint overlay.
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-meta" })).result as { id: number };

            // providers + budget — the active test alias is mocktest, carrying the effective prompt budget.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active!.alias, "mocktest");
            assert.equal(typeof active!.contextSize, "number", "the active alias carries the effective prompt budget (#345)");

            // sessions + runs — the created session and its client run are present.
            const sessions = await daemon.listSessions();
            assert.ok(sessions.some((s) => s.id === created.id), "listSessions includes the created session");
            const runs = await daemon.listRuns(created.id);
            assert.ok(runs.length >= 1, "listRuns returns the session's client run");

            // constraints — a fresh session carries a clean, empty overlay.
            const constraints = await daemon.listConstraints(created.id);
            assert.deepEqual(constraints, [], "listConstraints is empty on a fresh session");

            // prompts + membership effects — thin delegations; assert the wiring resolves cleanly.
            const prompts = await daemon.listPrompts(created.id);
            assert.ok(Array.isArray(prompts), "listPrompts returns the session's prompt history");
            const members = await daemon.listMembers(created.id);
            assert.ok(members !== undefined && members !== null, "listMembers resolves the session's membership effects");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — session lifecycle: create/attach/rename/set-root/constrain (#355)", async () => {
    // Inputs arrive pre-validated at the module's edge; core owns the envelope, the reserved-name +
    // name-uniqueness invariants, membership, and the session/created emit. Driven entirely through the seam.
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, daemon, _addr) => {
        const events: Array<{ method: string; params: unknown }> = [];
        daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

        // create — with a constraint seeded atomically; returns the envelope + emits session/created.
        const env = await daemon.createSession({ name: "seam-life", constraints: [{ effect: "hide", glob: "secret/**" }] });
        assert.ok(env.sessionId > 0 && env.runId > 0, "createSession returns the envelope (session + client run)");
        assert.ok(events.some((e) => e.method === "session/created" && (e.params as { id?: number }).id === env.sessionId), "session/created emitted on the event source");
        assert.deepEqual(await daemon.listConstraints(env.sessionId), [{ effect: "hide", glob: "secret/**" }], "the seeded constraint landed atomically with the session");

        // attach — core's namespace invariant refuses a reserved run name; a plain attach returns an envelope.
        await assert.rejects(() => daemon.attachSession({ sessionId: env.sessionId, runName: "plurnk" }), /reserved/, "attachSession refuses a reserved run name");
        assert.equal((await daemon.attachSession({ sessionId: env.sessionId })).sessionId, env.sessionId, "attachSession returns an envelope on the same session");

        // set-root + rename — mutations return the applied value; a name collision is refused.
        assert.equal(await daemon.setProjectRoot(env.sessionId, "/tmp/seam-root"), "/tmp/seam-root");
        assert.equal((await daemon.renameSession(env.sessionId, "seam-life-2")).name, "seam-life-2");
        await daemon.createSession({ name: "seam-life-other" });
        await assert.rejects(() => daemon.renameSession(env.sessionId, "seam-life-other"), /taken/, "renameSession refuses a taken name");

        // constrain / unconstrain roundtrip on the overlay.
        await daemon.constrain(env.sessionId, "pick", "vendored/x");
        assert.ok((await daemon.listConstraints(env.sessionId)).some((c) => c.glob === "vendored/x"), "constrain added the overlay entry");
        await daemon.unconstrain(env.sessionId, "pick", "vendored/x");
        assert.ok(!(await daemon.listConstraints(env.sessionId)).some((c) => c.glob === "vendored/x"), "unconstrain removed it");
    });
});

test("the client-interface seam — readEntry returns an entry's shape and the #192 incremental slice (#355)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-entry" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildEdit({ target: "known:///x", content: "hello world" }) });

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ sessionId: created.id, target: "known:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found!;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // #192 incremental slice — that channel's content from an offset; only the delta leaves storage.
            const sliced = (await daemon.readEntry({ sessionId: created.id, target: "known:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            assert.equal((await daemon.readEntry({ sessionId: created.id, target: "known:///nope" })).status, 404);
            await assert.rejects(() => daemon.readEntry({ sessionId: created.id, target: "known:///x", offset: 3 }), /offset requires channel/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — forkRun branches a run's log, ownership + name invariants held (#355)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-fork" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildEdit({ target: "known:///x", content: "branch me" }) });

            const branch = await daemon.forkRun({ sessionId: created.id, runId: run.id, name: "mybranch" });
            assert.ok(branch.runId > 0 && branch.runId !== run.id, "forkRun created a new run");
            assert.equal(branch.parentRunId, run.id, "the branch is lineaged to its parent");
            assert.equal(branch.runName, "mybranch");

            // invariants: a reserved name and a foreign run are both refused.
            await assert.rejects(() => daemon.forkRun({ sessionId: created.id, runId: run.id, name: "plurnk" }), /reserved/);
            const other = (await rpcCall(ws, 2, "session.create", { name: "seam-fork-other" })).result as { id: number };
            const otherRun = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: other.id }))!;
            await assert.rejects(() => daemon.forkRun({ sessionId: created.id, runId: otherRun.id }), /not in session/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — hotloadRuntime registers a live tag, dispatchable through the engine (#355)", async () => {
    // The generic module-load hook: a module (agui, for MCP) builds the RegistryEntry with its own
    // driver and hands it here; the kernel knows nothing about the driver. Tested with a stand-in.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-hotload" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;

            daemon.hotloadRuntime(fakeRegistration("seamtag"));
            // the tag is live — EXEC[seamtag] dispatches through the engine to the registered executor.
            const exec = await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildExec({ runtime: "seamtag", command: "ping" }) });
            assert.equal(exec.status, 200, "the hotloaded runtime is dispatchable through the seam's dispatch path");

            // one-name-one-owner arbitration flows through the seam: a dup and a reserved name fail-hard.
            assert.throws(() => daemon.hotloadRuntime(fakeRegistration("seamtag")), /already/i, "a dup tag is rejected");
            assert.throws(() => daemon.hotloadRuntime(fakeRegistration("known")), /reserved/i, "a reserved built-in name is rejected");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — a dispatched EXEC's stdout streams as stream/event on the event source (#355)", async () => {
    // Client-raised parity check: a seam-dispatched exec must emit incremental stream/event, not just
    // the log/entry + stream/concluded. dispatchAsClient routes through engine.dispatch identically to
    // the WS op.exec path; the stream fires via the engine's global streamEventNotify. Pinned so the
    // per-chunk path can't silently regress. (A streaming stub with a DECLARED channel — the exec seeds
    // the executor's channel topology eagerly, so the write appends and the notify fires.)
    await withDaemon(new Mock({ contextSize: 8192, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.hotloadRuntime({
                decl: { name: "streamtag", glyph: "🔌", example: "", documentation: "" },
                executor: {
                    runtime: "streamtag", glyph: "🔌",
                    get manifest() { return { name: "streamtag", protocol: "streamtag:", channels: { stdout: { mimetype: "text/plain" } }, defaultChannel: "stdout", category: "action", scope: "run", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
                    get defaultChannel() { return "stdout"; },
                    get channels() { return { stdout: { mimetype: "text/plain" } }; },
                    effect: () => "read",
                    probe: async () => ({ available: true, detail: "fake" }),
                    run: async (args: { write: (c: string, x: string, m: string) => void; setState: (c: string, s: string) => void }) => {
                        args.write("stdout", "alpha\n", "text/plain");
                        args.write("stdout", "beta\n", "text/plain");
                        args.setState("stdout", "closed");
                        return { status: 200, exitCode: 0 };
                    },
                } as unknown as Executor,
                availability: { available: true, detail: "fake" },
            });
            const created = (await rpcCall(ws, 1, "session.create", { name: "seam-stream" })).result as { id: number };
            const run = (await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: created.id }))!;
            const events: string[] = [];
            daemon.subscribeToEvents((_s, method) => { events.push(method); });

            await daemon.dispatchAsClient({ sessionId: created.id, runId: run.id, statement: Dsl.buildExec({ runtime: "streamtag", command: "go" }) });
            await waitFor(() => events.filter((m) => m === "stream/event"), (s) => s.length > 0, { timeoutMs: 4000 });
            assert.ok(events.filter((m) => m === "stream/event").length > 0, "the exec's stdout arrived as stream/event on the seam — not just log/entry + stream/concluded");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — the boot plug-point hands a registered module a live CoreSeam handle (#355)", async () => {
    // Hook D: register a module before start(); at boot it receives the curated seam and wires itself.
    // "Here's your handle, open your own listener." Proven by driving the live seam from inside the init.
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: new Mock({ contextSize: 8192, responses: [] }) });
    try {
        let handed: CoreSeam | null = null;
        let createdInInit: number | null = null;
        daemon.registerModule(async (seam) => {
            handed = seam;
            const env = await seam.createSession({ name: "from-module-init" });
            createdInInit = env.sessionId;
        });
        await daemon.start({ host: "127.0.0.1", port: 0 });

        assert.ok(handed !== null, "the module init ran at boot with the seam handle");
        assert.ok(createdInInit !== null && createdInInit > 0, "the init drove a LIVE seam — createSession worked during boot");
        const seam = handed as CoreSeam;
        assert.ok((await seam.listSessions()).some((s) => s.id === createdInInit), "the module's seam and the daemon are one live surface");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
