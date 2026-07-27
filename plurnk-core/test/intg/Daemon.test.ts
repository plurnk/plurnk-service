import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, makeMockResponse } from "./_rpc.ts";
import { insertWorkspace, insertWorker, insertLoop, insertTurn, openMigrated, viableWindow } from "./_helpers.ts";
import Daemon from "../../src/server/Daemon.ts";
import type { CoreSeam } from "../../src/server/Daemon.ts";
import Dsl from "./dsl.ts";
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
        const workspaces = await daemon.listWorkspaces();
        assert.ok(Array.isArray(workspaces), "the seam answers");
    });
});

test("Daemon boot reconciles documentation for existing workspaces once", async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `boot-docs-${crypto.randomUUID()}`);
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "worker", prefix: "/docs/%" });
        assert.ok(docs.length > 0, "boot publishes the current installed documentation surface into an existing workspace");
        const plurnkWorker = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        assert.ok(plurnkWorker !== undefined, "boot publication is authored by the workspace's reserved plurnk worker");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("workspace.create returns id+name and emits notification", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            const response = await rpcCall(ws, 1, "workspace.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            await flush();
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            const workspaceList = await db.test_list_sessions.all<{ name: string }>();
            assert.ok(workspaceList.some((s) => s.name === "alpha"));
            const run = await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: result.id });
            assert.ok((run?.id ?? 0) > 0);
            // No client loop yet — allocation is lazy (deferred until the
            // first client-origin op). A connection that only ran workspace.*
            // RPCs has nothing to spend a loop sequence on, so loop.run
            // gets sequence=1 instead of 2.
            const loop = await db.test_get_loop_by_run.get<{ id: number }>({ worker_id: run?.id });
            assert.equal(loop, undefined);
        } finally { ws.close(); }
    });
});

test("workspace.create with no name auto-generates a unique name", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create");
            const result = response.result as { id: number; name: string };
            assert.ok(result.name.length > 0);
            assert.match(result.name, /^workspace-/);
        } finally { ws.close(); }
    });
});

test("workspace.create on an already-attached connection re-binds in place (no reject)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const first = await rpcCall(ws, 1, "workspace.create", { name: "first" });
            const second = await rpcCall(ws, 2, "workspace.create", { name: "second" });
            // #196: re-binding is allowed — the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection no longer rejects");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh workspace");
        } finally { ws.close(); }
    });
});

test("workspace.list returns workspaces most-recent-first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        await db.test_sessions_insert_name_only.run({ name: "first" });
        await db.test_sessions_insert_name_only.run({ name: "second" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.list");
            const result = response.result as { workspaces: Array<{ id: number; name: string }> };
            assert.equal(result.workspaces.length, 2);
            const names = result.workspaces.map((s) => s.name).toSorted();
            assert.deepEqual(names, ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("workspace.attach binds to existing workspace", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const existing = await db.test_insert_workspace.get<{ id: number }>({ name: "existing" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: existing?.id });
            const result = response.result as { id: number; name: string };
            assert.equal(result.id, existing?.id);
            assert.equal(result.name, "existing");

            const run = await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: existing?.id });
            assert.ok(run !== undefined);
            // Client loop allocation is lazy. workspace.attach alone doesn't
            // spend a loop sequence; the first op.* would.
            const loop = await db.test_get_loop_by_run.get<{ id: number }>({ worker_id: run?.id });
            assert.equal(loop, undefined);
        } finally { ws.close(); }
    });
});

test("workspace.attach to nonexistent workspace returns -32603", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: 9999 });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /workspace 9999 not found/);
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerName: creates new run with that name", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "name-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerName: "research-task-42" });
            const result = response.result as { id: number; workerId: number; workerName: string };
            assert.equal(result.workerName, "research-task-42");
            const run = await db.test_runs_get_by_session.get<{ id: number; name: string }>({ workspace_id: workspace?.id });
            assert.equal(run?.id, result.workerId);
            assert.equal(run?.name, "research-task-42");
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerName: reuses existing run when name matches", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "reuse-test" });
        const ws1 = await connect(addr);
        try {
            const r1 = await rpcCall(ws1, 1, "workspace.attach", { id: workspace?.id, workerName: "shared-run" });
            const result1 = r1.result as { workerId: number };
            ws1.close();
            const ws2 = await connect(addr);
            try {
                const r2 = await rpcCall(ws2, 1, "workspace.attach", { id: workspace?.id, workerName: "shared-run" });
                const result2 = r2.result as { workerId: number; workerName: string };
                assert.equal(result2.workerId, result1.workerId, "second attach to same workerName reuses the worker id");
                assert.equal(result2.workerName, "shared-run");
                const workerCount = await db.test_runs_count.get<{ n: number }>();
                assert.equal(workerCount?.n, 1, "still only one worker row");
            } finally { ws2.close(); }
        } finally { /* ws1 already closed */ }
    });
});

test("workspace.attach with workerId: reuses that specific run", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "runid-test" });
        const run = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspace?.id, name: "pre-existing" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: run?.id });
            const result = response.result as { workerId: number; workerName: string };
            assert.equal(result.workerId, run?.id);
            assert.equal(result.workerName, "pre-existing");
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerId belonging to different workspace returns -32603", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const sA = await db.test_insert_workspace.get<{ id: number }>({ name: "sA" });
        const sB = await db.test_insert_workspace.get<{ id: number }>({ name: "sB" });
        const runInA = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: sA?.id, name: "in-A" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: sB?.id, workerId: runInA?.id });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /belongs to workspace/);
        } finally { ws.close(); }
    });
});

test("workspace.attach with non-existent workerId returns -32603", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "norun-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: 99999 });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /run 99999 not found/);
        } finally { ws.close(); }
    });
});

test("workspace.attach with both workerId and workerName rejects", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "both-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: 1, workerName: "x" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /workerId OR workerName, not both/);
        } finally { ws.close(); }
    });
});

test("providers.list returns parsed aliases with active marker", async () => {
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const original = { ...process.env };
            try {
                process.env.PLURNK_MODEL_gemma = "openai/macher.gguf";
                process.env.PLURNK_MODEL_opus = "openrouter/anthropic/claude-opus";
                process.env.PLURNK_MODEL = "gemma";
                const response = await rpcCall(ws, 1, "providers.list");
                const result = response.result as {
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean; promptBudget: number | null }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
                // #263/#345 — the active alias carries the enforced prompt budget; an inactive
                // alias is null (provider not instantiated), so the client omits the gauge.
                const budget = 8192 - Number(process.env.PLURNK_PROVIDERS_REASONING_RESERVE) - Number(process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE) - Number(process.env.PLURNK_SERVICE_SAFETY);
                assert.equal(gemma?.promptBudget, budget, "active alias carries the effective prompt budget, not the raw window");
                assert.equal(opus?.promptBudget, null, "inactive alias has no window → null");
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
test("workspace.workers lists runs in the workspace, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "list-runs" });
        await db.test_runs_insert.run({ workspace_id: workspace?.id, name: "first" });
        await db.test_runs_insert.run({ workspace_id: workspace?.id, name: "second" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.workers", { id: workspace?.id });
            const result = response.result as { workers: Array<{ id: number; name: string }> };
            assert.equal(result.workers.length, 2);
            assert.deepEqual(result.workers.map((r) => r.name).toSorted(), ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("multiple connections attaching to same workspace each get their own worker", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "shared" });

        const ws1 = await connect(addr);
        const ws2 = await connect(addr);
        try {
            await rpcCall(ws1, 1, "workspace.attach", { id: workspace?.id });
            await rpcCall(ws2, 1, "workspace.attach", { id: workspace?.id });

            const countAfter = await db.test_runs_count.get<{ n: number }>();
            assert.equal(countAfter?.n, 2);
        } finally { ws1.close(); ws2.close(); }
    });
});

test("workspace/created notification broadcasts to other connected clients", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "workspace/created");

            await rpcCall(creator, 1, "workspace.create", { name: "broadcast-test" });
            await flush();

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally { observer.close(); creator.close(); }
    });
});
test("the client-interface seam — subscribeToEvents delivers workspace-scoped engine events in-process (#355)", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-agui)
    // subscribes here and fans out to its OWN clients, instead of being welded to the WS connections.
    await withDaemon(null, async (_db, daemon, addr) => {
        const received: Array<{ workspaceId: number | null; method: string; params: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { received.push({ workspaceId, method, params }); });
        const ws = await connect(addr);
        try {
            const s = ((await rpcCall(ws, 1, "workspace.create", { name: "seam" })).result as { id: number }).id;
            const isCreated = (e: { method: string; params: unknown }): boolean => e.method === "workspace/created" && (e.params as { id?: number }).id === s;
            await waitFor(() => received, (r) => r.some(isCreated), { timeoutMs: 4000 });
            assert.ok(received.some(isCreated), "the in-process subscriber received the engine event — the emit source is decoupled from the WS fan-out");
            unsubscribe();
            const countAfter = received.length;
            await rpcCall(ws, 2, "workspace.create", { name: "seam-2" });
            await flush();
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — pendingProposals reads a workspace's stopped-world; resolveProposal delegates the decision (#355)", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const workspaceId = await insertWorkspace(db, `prop-seam-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A stopped-world proposal (state='proposed') the module would render as a TOOL_CALL.
        await db.engine_insert_log_entry.get({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, op: "EDIT", suffix: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/x", params: null, fragment: null, lineMarker: null,
            tx: "<<EDIT(worker:///x):body:EDIT", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
            status_rx: 202, tokens: 0, state: "proposed", outcome: null, attrs: "{}",
        });
        const pending = await daemon.pendingProposals(workspaceId);
        assert.equal(pending.length, 1, "the seam reads the workspace's stopped-world proposal");
        assert.equal(pending[0].op, "EDIT");
        assert.equal(pending[0].loopId, loopId);
        // resolveProposal delegates to Engine.resolveProposal — an unknown id throws (no registered waiter),
        // proving the seam routes into the engine's proposal machinery, not a shadow implementation.
        assert.throws(() => daemon.resolveProposal(999999, { decision: "accept" }), /no pending proposal/i, "resolveProposal delegates to the engine");
    });
});

test("the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law (#355)", async () => {
    // The loop-control hook: the module supplies only workspace/run/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    // A window that comfortably holds the packet: this test drives a loop to CONCLUSION and asserts
    // 200, so the full system prompt (law/definition) + the materialized docs must fit the prompt
    // budget. An 8192 mock window left only ~6.8k after reserves — under the packet — so the loop
    // concluded 413, not 200 (#433/#355). This test verifies the seam path, not small-window viability.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("<<SEND[200]:done:SEND", 50),
        makeMockResponse("<<SEND[200]:done again:SEND", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-runloop" })).result as { id: number };
            const events: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

            const docsAtCreation = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: created.id, scheme: "worker", prefix: "/docs/%" });
            assert.ok(docsAtCreation.length > 0, "workspace creation publishes worker://plurnk/docs/*.md before any model worker or loop exists");
            const plurnkWorker = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: created.id, name: "plurnk" });
            assert.ok(plurnkWorker !== undefined);
            const publicationRows = async () => db.test_log_entries_by_run.all<{ op: string; status_rx: number }>({ worker_id: plurnkWorker!.id });
            const publishedCount = (await publicationRows()).length;

            // §machine-processes — loops run in the MODEL run the seam resolves; a client worker is
            // refused loudly (the module's envelope workerId is the client worker — never the loop home).
            const clientWorker = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            await assert.rejects(() => daemon.runLoop({ workspaceId: created.id, workerId: clientWorker.id, prompt: "go" }), /client worker/, "runLoop refuses a client-origin run");
            const modelWorkerId = await daemon.ensureModelWorker(created.id);
            const res = await daemon.runLoop({ workspaceId: created.id, workerId: modelWorkerId, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { result: { status: number } }).result.status, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");

            // The marquee first-turn feature holds on the seam path: workspace creation materialized
            // the teaching docs before the model loop, so FIND(worker://plurnk/docs/**) finds them.
            const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: created.id, scheme: "worker", prefix: "/docs/%" });
            assert.deepEqual(docs, docsAtCreation, "model startup consumes the existing documentation surface without republishing it");

            const second = await daemon.runLoop({ workspaceId: created.id, workerId: modelWorkerId, prompt: "go again" });
            const secondTerminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === second.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((secondTerminals[0].params as { result: { status: number } }).result.status, 200, "reattaching to the workspace runs normally");

            const afterTwoLoops = await publicationRows();
            assert.equal(afterTwoLoops.length, publishedCount, "model loops never repeat workspace documentation publication");
            assert.equal(afterTwoLoops.filter((row) => row.op === "EDIT" && row.status_rx >= 400).length, 0, "workspace documentation publication produces no error rows");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — dispatchAsClient runs a client op through the engine and emits log/entry (#355)", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-dispatch" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });

            // WRITE then READ worker:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "seam" }) });
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildRead({ target: "worker:///x" }) });
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (agui fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — one client action journals every statement in one terminal segment (#616)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-action-journal" })).result as { id: number };
            const worker = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            const before = await db.test_loops_list_ids.all<{ id: number }>({ worker_id: worker.id });

            const results = await daemon.dispatchClientAction({
                workspaceId: created.id,
                workerId: worker.id,
                statements: [
                    Dsl.buildEdit({ target: "worker:///x", content: "one action" }),
                    Dsl.buildRead({ target: "worker:///x" }),
                ],
            });

            assert.deepEqual(results.map((result) => result.status), [201, 200]);
            const after = await db.test_loops_list_ids.all<{ id: number }>({ worker_id: worker.id });
            assert.equal(after.length, before.length + 1, "the action created one journal segment, not one loop per statement");
            const loopId = after[after.length - 1].id;
            const turns = await db.test_list_turns_in_loop.all<{ sequence: number }>({ loop_id: loopId });
            assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2], "each statement remains a distinct ordered journal turn");
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200, "the action segment closes terminally");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — readLog returns a workspace's journal, ownership-verified (#355)", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-workspace invariant proven: a workspace reads only its own runs (core holds it, not the module).
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-read" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "read me" }) });

            const entries = await daemon.readLog({ workspaceId: created.id, workerId: run.id });
            assert.ok(entries.length >= 1, "readLog returned the workspace's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-read-other" })).result as { id: number };
            const otherWorker = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: other.id }))!;
            await assert.rejects(() => daemon.readLog({ workspaceId: created.id, workerId: otherWorker.id }), /not in this workspace/, "readLog refuses a worker outside the workspace — core holds its own invariant");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — the metadata reads surface providers, workspaces, runs, and constraints (#355)", async () => {
    // The render surface beyond the journal: providers+budget, workspaces, runs, and the constraint overlay.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-meta" })).result as { id: number };

            // providers + budget — the active test alias is mocktest, carrying the effective prompt budget.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active!.alias, "mocktest");
            assert.equal(typeof active!.promptBudget, "number", "the active alias carries the effective prompt budget (#345)");

            // workspaces + runs — the created workspace and its client worker are present.
            const workspaces = await daemon.listWorkspaces();
            assert.ok(workspaces.some((s) => s.id === created.id), "listWorkspaces includes the created workspace");
            const workers = await daemon.listWorkers(created.id);
            assert.ok(workers.length >= 1, "listWorkers returns the workspace's client worker");

            // constraints — a fresh workspace carries a clean, empty overlay.
            const constraints = await daemon.listConstraints(created.id);
            assert.deepEqual(constraints, [], "listConstraints is empty on a fresh workspace");

            // prompts + membership effects — thin delegations; assert the wiring resolves cleanly.
            const prompts = await daemon.listPrompts(created.id);
            assert.ok(Array.isArray(prompts), "listPrompts returns the workspace's prompt history");
            const members = await daemon.listMembers(created.id);
            assert.ok(members !== undefined && members !== null, "listMembers resolves the workspace's membership effects");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — workspace lifecycle: create/attach/rename/set-root/constrain (#355)", async () => {
    // Inputs arrive pre-validated at the module's edge; core owns the envelope, the reserved-name +
    // name-uniqueness invariants, membership, and the workspace/created emit. Driven entirely through the seam.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, daemon, _addr) => {
        const events: Array<{ method: string; params: unknown }> = [];
        daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

        // create — with a constraint seeded atomically; returns the envelope + emits workspace/created.
        const env = await daemon.createWorkspace({ name: "seam-life", constraints: [{ effect: "hide", glob: "secret/**" }] });
        assert.ok(env.workspaceId > 0 && env.workerId > 0, "createWorkspace returns the envelope (workspace + client worker)");
        assert.ok(events.some((e) => e.method === "workspace/created" && (e.params as { id?: number }).id === env.workspaceId), "workspace/created emitted on the event source");
        assert.deepEqual(await daemon.listConstraints(env.workspaceId), [{ effect: "hide", glob: "secret/**" }], "the seeded constraint landed atomically with the workspace");

        // attach — core's namespace invariant refuses a reserved worker name; a plain attach returns an envelope.
        await assert.rejects(() => daemon.attachWorkspace({ workspaceId: env.workspaceId, workerName: "plurnk" }), /reserved/, "attachWorkspace refuses a reserved worker name");
        assert.equal((await daemon.attachWorkspace({ workspaceId: env.workspaceId })).workspaceId, env.workspaceId, "attachWorkspace returns an envelope on the same workspace");

        // rename — mutations return the applied value; a name collision is refused. (No root
        // mutation on the seam: the workspace pointer is set at workspace.create or never.)
        assert.equal((await daemon.renameWorkspace(env.workspaceId, "seam-life-2")).name, "seam-life-2");
        await daemon.createWorkspace({ name: "seam-life-other" });
        await assert.rejects(() => daemon.renameWorkspace(env.workspaceId, "seam-life-other"), /already exists/, "renameWorkspace refuses a taken name");

        // constrain / unconstrain roundtrip on the overlay.
        await daemon.constrain(env.workspaceId, "pick", "vendored/x");
        assert.ok((await daemon.listConstraints(env.workspaceId)).some((c) => c.glob === "vendored/x"), "constrain added the overlay entry");
        await daemon.unconstrain(env.workspaceId, "pick", "vendored/x");
        assert.ok(!(await daemon.listConstraints(env.workspaceId)).some((c) => c.glob === "vendored/x"), "unconstrain removed it");
    });
});

test("the client-interface seam — readEntry returns an entry's shape and the #192 incremental slice (#355)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-entry" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "hello world" }) });

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ workspaceId: created.id, target: "worker:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found!;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // #192 incremental slice — that channel's content from an offset; only the delta leaves storage.
            const sliced = (await daemon.readEntry({ workspaceId: created.id, target: "worker:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            assert.equal((await daemon.readEntry({ workspaceId: created.id, target: "worker:///nope" })).status, 404);
            await assert.rejects(() => daemon.readEntry({ workspaceId: created.id, target: "worker:///x", offset: 3 }), /offset requires channel/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — forkWorker branches a worker's log, ownership + name invariants held (#355)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-fork" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "branch me" }) });

            const branch = await daemon.forkWorker({ workspaceId: created.id, workerId: run.id, name: "mybranch" });
            assert.ok(branch.workerId > 0 && branch.workerId !== run.id, "forkWorker created a new run");
            assert.equal(branch.parentWorkerId, run.id, "the branch is lineaged to its parent");
            assert.equal(branch.workerName, "mybranch");

            // invariants: a reserved name and a foreign run are both refused.
            await assert.rejects(() => daemon.forkWorker({ workspaceId: created.id, workerId: run.id, name: "plurnk" }), /reserved/);
            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-fork-other" })).result as { id: number };
            const otherWorker = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: other.id }))!;
            await assert.rejects(() => daemon.forkWorker({ workspaceId: created.id, workerId: otherWorker.id }), /not in workspace/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — hotloadRuntime registers a live tag, dispatchable through the engine (#355)", async () => {
    // The generic module-load hook: a module (agui, for MCP) builds the RegistryEntry with its own
    // driver and hands it here; the kernel knows nothing about the driver. Tested with a stand-in.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-hotload" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;

            daemon.hotloadRuntime(fakeRegistration("seamtag"));
            // the tag is live — EXEC[seamtag] dispatches through the engine to the registered executor.
            const exec = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildExec({ runtime: "seamtag", command: "ping" }) });
            assert.equal(exec.status, 200, "the hotloaded runtime is dispatchable through the seam's dispatch path");

            // one-name-one-owner arbitration flows through the seam: a dup and a reserved name fail-hard.
            assert.throws(() => daemon.hotloadRuntime(fakeRegistration("seamtag")), /already/i, "a dup tag is rejected");
            assert.throws(() => daemon.hotloadRuntime(fakeRegistration("worker")), /reserved/i, "a reserved built-in name is rejected");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — a dispatched EXEC's stdout streams as stream/event on the event source (#355)", async () => {
    // Client-raised parity check: a seam-dispatched exec must emit incremental stream/event, not just
    // the log/entry + stream/concluded. dispatchAsClient routes through engine.dispatch identically to
    // the WS op.exec path; the stream fires via the engine's global streamEventNotify. Pinned so the
    // per-chunk path can't silently regress. (A streaming stub with a DECLARED channel — the exec seeds
    // the executor's channel topology eagerly, so the write appends and the notify fires.)
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.hotloadRuntime({
                decl: { name: "streamtag", glyph: "🔌", example: "", documentation: "" },
                executor: {
                    runtime: "streamtag", glyph: "🔌",
                    get manifest() { return { name: "streamtag", protocol: "streamtag:", channels: { stdout: { mimetype: "text/plain" } }, defaultChannel: "stdout", category: "action", scope: "worker", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
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
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-stream" })).result as { id: number };
            const run = (await db.test_get_run_by_session.get<{ id: number }>({ workspace_id: created.id }))!;
            const events: string[] = [];
            daemon.subscribeToEvents((_s, method) => { events.push(method); });

            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: run.id, statement: Dsl.buildExec({ runtime: "streamtag", command: "go" }) });
            await waitFor(() => events.filter((m) => m === "stream/event"), (s) => s.length > 0, { timeoutMs: 4000 });
            assert.ok(events.filter((m) => m === "stream/event").length > 0, "the exec's stdout arrived as stream/event on the seam — not just log/entry + stream/concluded");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — the boot plug-point hands a registered module a live CoreSeam handle (#355)", async () => {
    // Hook D: register a module before start(); at boot it receives the curated seam and wires itself.
    // "Here's your handle, open your own listener." Proven by driving the live seam from inside the init.
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    try {
        let handed: CoreSeam | null = null;
        let createdInInit: number | null = null;
        daemon.registerModule(async (seam) => {
            handed = seam;
            const env = await seam.createWorkspace({ name: "from-module-init" });
            createdInInit = env.workspaceId;
        });
        await daemon.start();

        assert.ok(handed !== null, "the module init ran at boot with the seam handle");
        assert.ok(createdInInit !== null && createdInInit > 0, "the init drove a LIVE seam — createWorkspace worked during boot");
        const seam = handed as CoreSeam;
        assert.ok((await seam.listWorkspaces()).some((s) => s.id === createdInInit), "the module's seam and the daemon are one live surface");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
