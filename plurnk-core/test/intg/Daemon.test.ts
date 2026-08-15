import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, makeMockResponse } from "./_rpc.ts";
import { insertWorkspace, insertWorker, insertLoop, insertTurn, openMigrated, seedEntryWithChannel, viableWindow } from "./_helpers.ts";
import Daemon from "../../src/server/Daemon.ts";
import type { CoreSeam } from "../../src/server/Daemon.ts";
import Dsl from "./dsl.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { Validator, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const lateWakeFailures: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]): void => {
    const rendered = args.map(String).join(" ");
    if (/wake-on-completion/.test(rendered)) lateWakeFailures.push(rendered);
    else consoleError(...args);
};
test.after(() => {
    console.error = consoleError;
    assert.deepEqual(
        lateWakeFailures,
        [],
        "the real daemon/EXEC teardown path leaves no wake task beyond database ownership",
    );
});

// A stand-in registration in the daemon-module setup shape:
// framework types only — decl + executor + the driver's probe result. The kernel wraps the
// RegistryEntry itself; registration needs no live driver (the scheme face reads lazily at dispatch).
const fakeRegistration = (tag: string) => ({
    namespaceOwner: "daemon test module",
    decl: {
        name: tag,
        glyph: "🔌",
        invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
        documentation: "",
    },
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { results: "application/json" },
                defaultChannel: "results",
                category: "data",
                writableBy: ["plugin"],
                volatile: true,
                modelVisible: true,
            } as never;
        },
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

const rpcProblem = (response: RpcResponse): ProblemDetails => {
    const result = Validator.assertOperationResult(response.result as OperationResult);
    assert.ok(result.problem !== undefined);
    return result.problem;
};

const rejectedProblem = async (run: () => Promise<unknown> | unknown): Promise<ProblemDetails> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};

test("Daemon: listenerless boot — the seam is live with no socket bound", async () => {
    await withDaemon(null, async (_db, daemon, _addr) => {
        // No port, no listener — the seam itself is the surface. A basic seam read proves boot.
        const workspaces = await daemon.listWorkspaces();
        assert.ok(Array.isArray(workspaces), "the seam answers");
    });
});

test("Daemon composes deterministic scheme and MIME display capabilities for clients", async () => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes({
        discovery: {
            registry: { byExtension: new Map(), byFilename: new Map() },
            handlers: new Map([
                ["text/plain", {
                    mimetype: "text/plain",
                    glyph: "📄",
                    packageName: "@plurnk/plurnk-mimetypes-text-plain",
                    projectionRevision: "test-1",
                    extensions: [".txt"],
                    binary: false,
                    source: "package" as const,
                }],
                ["application/x-unmarked", {
                    mimetype: "application/x-unmarked",
                    glyph: "",
                    packageName: "@acme/mimetype-unmarked",
                    projectionRevision: "test-1",
                    extensions: [],
                    binary: false,
                    source: "package" as const,
                }],
            ]),
            skipped: [],
        },
    });
    const daemon = new Daemon({ db, provider: null, mimetypes });
    daemon.schemes.register("figma", {
        manifest: {
            name: "figma",
            channels: { body: "application/json" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            glyph: "󰕧",
        },
    });
    try {
        const capabilities = await daemon.listClientDisplayCapabilities();
        Validator.assertClientDisplayCapabilities(capabilities);
        assert.deepEqual(
            capabilities.filter((capability) => capability.kind === "scheme"),
            [
                { kind: "scheme", scheme: "figma", display: { glyph: "󰕧" } },
                { kind: "scheme", scheme: "file", display: {} },
                { kind: "scheme", scheme: "log", display: {} },
                { kind: "scheme", scheme: "prompt", display: {} },
                { kind: "scheme", scheme: "skill", display: {} },
                { kind: "scheme", scheme: "worker", display: {} },
            ],
        );
        assert.deepEqual(
            capabilities.filter((capability) => capability.kind === "mimetype"),
            [
                { kind: "mimetype", mimetype: "application/x-unmarked", display: {} },
                { kind: "mimetype", mimetype: "text/plain", display: { glyph: "📄" } },
            ],
        );
        assert.equal(
            capabilities.some((capability) => capability.kind === "scheme" && capability.scheme === "exec"),
            false,
            "the internal EXEC implementation is not advertised as an addressable URI scheme",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("Daemon boot reports mimetype packages withheld by the shared trust gate", async () => {
    const db = await openMigrated();
    const discovery = {
        registry: { byExtension: new Map<string, string>(), byFilename: new Map<string, string>() },
        handlers: new Map(),
        skipped: ["@acme/acme-mime-private"],
    };
    const daemon = new Daemon({
        db,
        provider: null,
        mimetypes: new Mimetypes({ discovery }),
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(" ")); };
    try {
        await daemon.start();
        assert.ok(
            warnings.some((warning) => /mimetype discovery.*@acme\/acme-mime-private.*untrusted.*not registered/.test(warning)),
            "the composed host names the package and trust decision",
        );
    } finally {
        console.warn = originalWarn;
        await daemon.stop();
        await db.close();
    }
});

test("Daemon: module actions register once during setup and invoke through CoreSeam", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    daemon.registerModule({
        setup: (seam) => {
            assert.throws(
                () => seam.registerModuleAction("", async () => ({})),
                /action name must not be empty/,
            );
            seam.registerModuleAction("example.inspect", async (params) => {
                calls.push(params);
                return { inspected: params.target };
            });
            assert.throws(
                () => seam.registerModuleAction("example.inspect", async () => ({})),
                /module action 'example\.inspect' is already registered/,
            );
        },
    });
    try {
        await daemon.start();
        assert.deepEqual(daemon.listModuleActions(), ["example.inspect"]);
        assert.deepEqual(
            await daemon.invokeModuleAction("example.inspect", { target: "sample" }),
            { inspected: "sample" },
        );
        assert.deepEqual(calls, [{ target: "sample" }]);
        await assert.rejects(
            () => daemon.invokeModuleAction("missing", {}),
            /module action 'missing' is not registered/,
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
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

            const workspaceList = await db.test_list_workspaces.all<{ name: string }>();
            assert.ok(workspaceList.some((s) => s.name === "alpha"));
            const clientWorker = await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: result.id });
            assert.ok((clientWorker?.id ?? 0) > 0);
            // No client loop yet — allocation is lazy (deferred until the
            // first client-origin op). A connection that only ran workspace.*
            // RPCs has nothing to spend a loop sequence on, so loop.run
            // gets sequence=1 instead of 2.
            const loop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: clientWorker?.id });
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
            // {§methods-rebind}: re-binding is allowed; the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection no longer rejects");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh workspace");
        } finally { ws.close(); }
    });
});

test("workspace.list returns workspaces most-recent-first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        await db.test_workspaces_insert_name_only.run({ name: "first" });
        await db.test_workspaces_insert_name_only.run({ name: "second" });

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

            const clientWorker = await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: existing?.id });
            assert.ok(clientWorker !== undefined);
            // Client loop allocation is lazy. workspace.attach alone doesn't
            // spend a loop sequence; the first op.* would.
            const loop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: clientWorker?.id });
            assert.equal(loop, undefined);
        } finally { ws.close(); }
    });
});

test("workspace.attach to nonexistent workspace returns an exact Problem", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: 9999 });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/workspace/workspace-not-found");
            assert.equal(problem.status, 404);
            assert.equal(problem.workspaceId, 9999);
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerName: creates a new worker with that name", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "name-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerName: "research-task-42" });
            const result = response.result as { id: number; workerId: number; workerName: string };
            assert.equal(result.workerName, "research-task-42");
            const worker = await db.test_workers_get_by_workspace.get<{ id: number; name: string }>({ workspace_id: workspace?.id });
            assert.equal(worker?.id, result.workerId);
            assert.equal(worker?.name, "research-task-42");
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerName: reuses existing worker when name matches", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "reuse-test" });
        const ws1 = await connect(addr);
        try {
            const r1 = await rpcCall(ws1, 1, "workspace.attach", { id: workspace?.id, workerName: "shared-worker" });
            const result1 = r1.result as { workerId: number };
            ws1.close();
            const ws2 = await connect(addr);
            try {
                const r2 = await rpcCall(ws2, 1, "workspace.attach", { id: workspace?.id, workerName: "shared-worker" });
                const result2 = r2.result as { workerId: number; workerName: string };
                assert.equal(result2.workerId, result1.workerId, "second attach to same workerName reuses the worker id");
                assert.equal(result2.workerName, "shared-worker");
                const workerCount = await db.test_workers_count.get<{ n: number }>();
                assert.equal(workerCount?.n, 1, "still only one worker row");
            } finally { ws2.close(); }
        } finally { /* ws1 already closed */ }
    });
});

test("workspace.attach with workerId: reuses that specific worker", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "runid-test" });
        const worker = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspace?.id, name: "pre-existing" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: worker?.id });
            const result = response.result as { workerId: number; workerName: string };
            assert.equal(result.workerId, worker?.id);
            assert.equal(result.workerName, "pre-existing");
        } finally { ws.close(); }
    });
});

test("workspace.attach with workerId belonging to different workspace returns an exact Problem", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const sA = await db.test_insert_workspace.get<{ id: number }>({ name: "sA" });
        const sB = await db.test_insert_workspace.get<{ id: number }>({ name: "sB" });
        const runInA = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: sA?.id, name: "in-A" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: sB?.id, workerId: runInA?.id });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.workerId, runInA?.id);
            assert.equal(problem.workspaceId, sB?.id);
            assert.equal(problem.actualWorkspaceId, sA?.id);
        } finally { ws.close(); }
    });
});

test("workspace.attach with non-existent workerId returns an exact Problem", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "norun-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: 99999 });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/worker-not-found");
            assert.equal(problem.status, 404);
            assert.equal(problem.workerId, 99999);
        } finally { ws.close(); }
    });
});

test("workspace.attach with both workerId and workerName rejects", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "both-test" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: workspace?.id, workerId: 1, workerName: "x" });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/worker-selector-conflict");
            assert.equal(problem.status, 400);
            assert.equal(problem.workerId, 1);
            assert.equal(problem.workerName, "x");
            assert.equal(problem.retryable, false);
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
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean; inputCapacity: number | null }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
                const capacity = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
                assert.equal(gemma?.inputCapacity, capacity, "the active alias carries provider-derived input capacity");
                assert.equal(opus?.inputCapacity, null, "an inactive alias has no instantiated capacity");
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
test("workspace.workers lists workers in the workspace, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "list-workers" });
        await db.test_workers_insert.run({ workspace_id: workspace?.id, name: "first" });
        await db.test_workers_insert.run({ workspace_id: workspace?.id, name: "second" });
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

            const countAfter = await db.test_workers_count.get<{ n: number }>();
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
test("the client-interface seam — subscribeToEvents delivers workspace-scoped engine events in-process", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-agui)
    // subscribes here and owns its client fan-out; core has no transport connections.
    await withDaemon(null, async (_db, daemon, addr) => {
        const received: Array<{ workspaceId: number | null; method: string; params: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { received.push({ workspaceId, method, params }); });
        const ws = await connect(addr);
        try {
            const s = ((await rpcCall(ws, 1, "workspace.create", { name: "seam" })).result as { id: number }).id;
            const isCreated = (e: { method: string; params: unknown }): boolean => e.method === "workspace/created" && (e.params as { id?: number }).id === s;
            await waitFor(() => received, (r) => r.some(isCreated), { timeoutMs: 4000 });
            assert.ok(received.some(isCreated), "the in-process subscriber received the engine event without core owning transport fan-out");
            unsubscribe();
            const countAfter = received.length;
            await rpcCall(ws, 2, "workspace.create", { name: "seam-2" });
            await flush();
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("the client-interface seam does not manufacture a resolver from an ownerless durable row", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const workspaceId = await insertWorkspace(db, `prop-seam-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "EDIT", suffix: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/x", query: null, fragment: null, lineMarker: null,
            tx: "## EDIT0 (worker:///x)\nbody", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
            status_rx: 202, weight: 0, state: "proposed", outcome: null, attrs: "{}",
        });
        assert.ok(row !== undefined);
        const pending = await daemon.pendingProposals(workspaceId);
        assert.deepEqual(pending, [], "persistence without this process's lifecycle owner is not a stopped world");
        const problem = await rejectedProblem(() => daemon.resolveProposal(row.id, { decision: "accept" }));
        assert.equal(problem.type, "https://problems.plurnk.dev/proposal/resolution/proposal-not-pending");
        assert.equal(problem.status, 409);
        assert.equal(problem.logEntryId, row.id);
    });
});

test("the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law", async () => {
    // The loop-control hook: the module supplies only workspace/worker/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    // A window that comfortably holds the packet: this test drives a loop to CONCLUSION and asserts
    // 200, so the full system prompt (law/definition) + the materialized docs must fit the prompt
    // budget. This test verifies the seam path, not small-window viability
    // ({§tokenomics-window-partition}).
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("## SEND0 [200]\ndone", 50),
        makeMockResponse("## SEND0 [200]\ndone again", 50),
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
            const docEdits = await db.test_log_entries_by_worker_op_full.all<{ tx: string }>({ worker_id: plurnkWorker!.id, op: "EDIT" });
            assert.ok(docEdits.length > 0, "documentation publication dispatches structural EDIT statements");
            for (const { tx } of docEdits) {
                const statement = JSON.parse(tx) as unknown;
                assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
                assert.deepEqual((statement as { position?: unknown }).position, { line: 0, column: 0 });
            }
            const publicationRows = async () => db.test_log_entries_by_worker.all<{ op: string; status_rx: number }>({ worker_id: plurnkWorker!.id });
            const publishedCount = (await publicationRows()).length;

            // {§machine-processes} — loops run in the model worker the seam resolves; a client worker is
            // refused loudly (the module's envelope workerId is the client worker — never the loop home).
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            const problem = await rejectedProblem(() => daemon.runLoop({
                workspaceId: created.id,
                workerId: clientWorker.id,
                prompt: "go",
            }));
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/model-worker-required");
            assert.equal(problem.status, 409);
            assert.equal(problem.workerId, clientWorker.id);
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

test("the client-interface seam — dispatchAsClient runs a client op through the engine and emits log/entry", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-dispatch" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });

            // WRITE then READ worker:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "seam" }) });
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildRead({ target: "worker:///x" }) });
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (agui fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — one client action journals every statement in one terminal segment", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-action-journal" })).result as { id: number };
            const worker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
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

test("the client-interface seam — readLog returns a workspace's journal, ownership-verified", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-workspace invariant proven: a workspace reads only its own workers (core holds it, not the module).
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-read" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "read me" }) });

            const entries = await daemon.readLog({ workspaceId: created.id, workerId: clientWorker.id });
            assert.ok(entries.length >= 1, "readLog returned the workspace's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-read-other" })).result as { id: number };
            const otherWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: other.id }))!;
            const problem = await rejectedProblem(() => daemon.readLog({
                workspaceId: created.id,
                workerId: otherWorker.id,
            }));
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — metadata reads surface providers, workspaces, workers, and constraints", async () => {
    // The render surface beyond the journal: providers+budget, workspaces, workers, and the constraint overlay.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-meta" })).result as { id: number };

            // providers + capacity — the active test alias is mocktest, carrying derived input capacity.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active!.alias, "mocktest");
            assert.equal(typeof active!.inputCapacity, "number", "the active alias carries resolved input capacity");

            // workspaces + workers — the created workspace and its client worker are present.
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

test("the client-interface seam — workspace lifecycle: create/attach/rename/set-root/constrain", async () => {
    // {§methods-workspace-create}: the module decodes its protocol; core owns semantic validation,
    // the envelope, name invariants, membership, and workspace/created.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (_db, daemon, _addr) => {
        const events: Array<{ method: string; params: unknown }> = [];
        daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

        // create — with a constraint seeded atomically; returns the envelope + emits workspace/created.
        const env = await daemon.createWorkspace({ name: "seam-life", constraints: [{ effect: "hide", glob: "secret/**" }] });
        assert.ok(env.workspaceId > 0 && env.workerId > 0, "createWorkspace returns the envelope (workspace + client worker)");
        assert.deepEqual(
            Object.keys(env).toSorted(),
            ["projectRoot", "workerId", "workerName", "workspaceId", "workspaceName"],
            "{§methods-rebind} #64: the envelope carries workspace/client-worker identity only",
        );
        assert.ok(events.some((e) => e.method === "workspace/created" && (e.params as { id?: number }).id === env.workspaceId), "workspace/created emitted on the event source");
        assert.deepEqual(await daemon.listConstraints(env.workspaceId), [{ effect: "hide", glob: "secret/**" }], "the seeded constraint landed atomically with the workspace");

        // attach — core's namespace invariant refuses reserved and non-mintable worker names;
        // a plain attach returns an envelope.
        await assert.rejects(() => daemon.attachWorkspace({ workspaceId: env.workspaceId, workerName: "plurnk" }), /reserved/, "attachWorkspace refuses a reserved worker name");
        const invalidWorkerName = await rejectedProblem(() =>
            daemon.attachWorkspace({ workspaceId: env.workspaceId, workerName: "bad_name" }));
        assert.equal(invalidWorkerName.type, "https://problems.plurnk.dev/daemon/worker/name-invalid");
        assert.equal(invalidWorkerName.status, 400);
        assert.equal(invalidWorkerName.name, "bad_name");
        assert.equal(invalidWorkerName.retryable, false);
        const attached = await daemon.attachWorkspace({ workspaceId: env.workspaceId });
        assert.equal(attached.workspaceId, env.workspaceId, "attachWorkspace returns an envelope on the same workspace");
        assert.deepEqual(
            Object.keys(attached).toSorted(),
            ["projectRoot", "workerId", "workerName", "workspaceId", "workspaceName"],
            "{§methods-rebind} #64: attach does not fabricate conversation or action-loop binding",
        );

        // rename — mutations return the applied value; a name collision is refused. (No root
        // mutation on the seam: the workspace pointer is set at workspace.create or never.)
        assert.equal((await daemon.renameWorkspace(env.workspaceId, "seam-life-2")).name, "seam-life-2");
        await daemon.createWorkspace({ name: "seam-life-other" });
        const renameProblem = await rejectedProblem(() =>
            daemon.renameWorkspace(env.workspaceId, "seam-life-other"));
        assert.equal(renameProblem.type, "https://problems.plurnk.dev/daemon/workspace/name-conflict");
        assert.equal(renameProblem.status, 409);
        assert.equal(renameProblem.name, "seam-life-other");

        // constrain / unconstrain roundtrip on the overlay.
        await daemon.constrain(env.workspaceId, "pick", "vendored/x");
        assert.ok((await daemon.listConstraints(env.workspaceId)).some((c) => c.glob === "vendored/x"), "constrain added the overlay entry");
        await daemon.unconstrain(env.workspaceId, "pick", "vendored/x");
        assert.ok(!(await daemon.listConstraints(env.workspaceId)).some((c) => c.glob === "vendored/x"), "unconstrain removed it");
    });
});

test("the client-interface seam — readEntry returns an entry's shape and incremental channel slice", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-entry" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "hello world" }) });

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ workspaceId: created.id, workerId: clientWorker.id, target: "worker:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found!;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // {§methods-entry-read}: an offset returns only that channel's remaining content.
            const sliced = (await daemon.readEntry({ workspaceId: created.id, workerId: clientWorker.id, target: "worker:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            const missing = await daemon.readEntry({ workspaceId: created.id, workerId: clientWorker.id, target: "worker:///nope" });
            assert.equal(missing.status, 404);
            assert.ok("problem" in missing);
            assert.equal(missing.problem.type, "https://problems.plurnk.dev/daemon/entry/entry-not-found");
            assert.equal(missing.problem.target, "worker:///nope");
            const offset = await daemon.readEntry({ workspaceId: created.id, workerId: clientWorker.id, target: "worker:///x", offset: 3 });
            assert.equal(offset.status, 400);
            assert.ok("problem" in offset);
            assert.equal(offset.problem.type, "https://problems.plurnk.dev/daemon/entry/offset-channel-required");
            assert.equal(offset.problem.recovery, "Select the channel to read from the offset.");

            const commons = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: created.id, name: "commons" });
            assert.ok(commons !== undefined);
            const networkEntry = await db.crud_insert_workspace_entry.get<{ id: number }>({
                workspace_id: created.id,
                owner_id: commons.id,
                scheme: "https",
                pathname: "/example.org:8443/x?b=2&a=1&a=3",
            });
            assert.ok(networkEntry !== undefined);
            await db.crud_write_channel.run({
                entry_id: networkEntry.id,
                name: "body",
                content: "network body",
                mimetype: "text/plain",
                weight: 2,
                content_hash: null,
                state: "static",
            });
            const network = await daemon.readEntry({
                workspaceId: created.id,
                workerId: clientWorker.id,
                target: "https://example.org:8443/x?b=2&a=1&a=3#body",
            });
            assert.equal(network.status, 200);
            assert.equal(network.entry?.target, "https://example.org:8443/x?b=2&a=1&a=3");
            assert.equal(network.entry?.channels.body.content, "network body");

            const userinfo = await daemon.readEntry({
                workspaceId: created.id,
                workerId: clientWorker.id,
                target: "https://alice:secret@example.org:8443/x?b=2&a=1&a=3",
            });
            assert.equal(userinfo.status, 400);
            assert.ok("problem" in userinfo);
            assert.equal(userinfo.problem.type, "https://problems.plurnk.dev/daemon/entry/userinfo-not-allowed");
            assert.doesNotMatch(JSON.stringify(userinfo), /alice|secret/);
        } finally { ws.close(); }
    });
});

test("the client-interface seam — forkWorker branches a worker's log, ownership + name invariants held", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-fork" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildEdit({ target: "worker:///x", content: "branch me" }) });

            const branch = await daemon.forkWorker({ workspaceId: created.id, workerId: clientWorker.id, name: "mybranch" });
            assert.ok(branch.workerId > 0 && branch.workerId !== clientWorker.id, "forkWorker created a new worker");
            assert.equal(branch.parentWorkerId, clientWorker.id, "the branch is lineaged to its parent");
            assert.equal(branch.workerName, "mybranch");

            // invariants: a reserved name and a foreign worker are both refused.
            await assert.rejects(() => daemon.forkWorker({ workspaceId: created.id, workerId: clientWorker.id, name: "plurnk" }), /reserved/);
            const invalidName = await rejectedProblem(() => daemon.forkWorker({
                workspaceId: created.id,
                workerId: clientWorker.id,
                name: "bad_name",
            }));
            assert.equal(invalidName.type, "https://problems.plurnk.dev/daemon/worker/name-invalid");
            assert.equal(invalidName.status, 400);
            assert.equal(invalidName.name, "bad_name");
            assert.equal(invalidName.retryable, false);
            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-fork-other" })).result as { id: number };
            const otherWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: other.id }))!;
            const problem = await rejectedProblem(() => daemon.forkWorker({
                workspaceId: created.id,
                workerId: otherWorker.id,
            }));
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/worker/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("the module setup seam registers a live tag, dispatchable through the engine", async () => {
    // The generic module-load hook builds the RegistryEntry with its own
    // driver and hands it here; the kernel knows nothing about the driver. Tested with a stand-in.
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-module" })).result as { id: number };
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;

            await assert.rejects(
                () => daemon.registerRuntime({ ...fakeRegistration("ownerless"), namespaceOwner: " " }),
                /namespaceOwner must be a non-empty string/,
            );
            assert.equal(daemon.schemes.has("ownerless"), false, "invalid ownership cannot claim a scheme");
            await daemon.registerRuntime(fakeRegistration("seamtag"));
            // the tag is live — EXEC[seamtag] dispatches through the engine to the registered executor.
            const exec = await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildExec({ runtime: "seamtag", command: "ping" }) });
            assert.equal(exec.status, 200, "the module runtime is dispatchable through the seam's dispatch path");

            // one-name-one-owner arbitration flows through the seam: a dup and a reserved name fail-hard.
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("seamtag")), /already/i, "a dup tag is rejected");
            await assert.rejects(() => daemon.registerRuntime(fakeRegistration("worker")), /reserved/i, "a reserved built-in name is rejected");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — a dispatched EXEC's stdout streams as stream/event on the event source", async () => {
    // Client-raised parity check: a seam-dispatched exec must emit incremental stream/event, not just
    // the log/entry + stream/concluded. dispatchAsClient routes through engine.dispatch identically to
    // the WS op.exec path; the stream fires via the engine's global streamEventNotify. Pinned so the
    // per-chunk path can't silently regress. (A streaming stub with a DECLARED channel — the exec seeds
    // the executor's channel topology eagerly, so the write appends and the notify fires.)
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await daemon.registerRuntime({
                namespaceOwner: "stream test module",
                decl: {
                    name: "streamtag",
                    glyph: "🔌",
                    invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
                    documentation: "",
                },
                executor: {
                    runtime: "streamtag", glyph: "🔌",
                    get manifest() { return { name: "streamtag", channels: { stdout: "text/plain" }, defaultChannel: "stdout", category: "data", writableBy: ["plugin"], volatile: true, modelVisible: true } as never; },
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
            const clientWorker = (await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: created.id }))!;
            const events: string[] = [];
            daemon.subscribeToEvents((_s, method) => { events.push(method); });

            await daemon.dispatchAsClient({ workspaceId: created.id, workerId: clientWorker.id, statement: Dsl.buildExec({ runtime: "streamtag", command: "go" }) });
            await waitFor(() => events.filter((m) => m === "stream/event"), (s) => s.length > 0, { timeoutMs: 4000 });
            assert.ok(events.filter((m) => m === "stream/event").length > 0, "the exec's stdout arrived as stream/event on the seam — not just log/entry + stream/concluded");
        } finally { ws.close(); }
    });
});

test("the client-interface seam — the boot plug-point hands a registered module a live CoreSeam handle", async () => {
    // Hook D: register a module before start(); at boot it receives the curated seam and wires itself.
    // "Here's your handle, open your own listener." Proven by driving the live seam from inside the init.
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    try {
        let handed: CoreSeam | null = null;
        let createdInInit: number | null = null;
        daemon.registerModule({
            start: async (seam) => {
                handed = seam;
                const env = await seam.createWorkspace({ name: "from-module-init" });
                createdInInit = env.workspaceId;
            },
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

test("module lifecycle orders setup, start, listener close, and module close", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    const events: string[] = [];
    daemon.registerModule({
        setup: async () => {
            events.push("setup");
        },
        start: async () => {
            events.push("start");
            return {
                close: async () => {
                    events.push("listener-close");
                },
            };
        },
        close: async () => {
            events.push("module-close");
        },
    });
    try {
        await daemon.start();
        assert.deepEqual(events, ["setup", "start"]);
        await daemon.stop();
        assert.deepEqual(events, [
            "setup",
            "start",
            "listener-close",
            "module-close",
        ]);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("Daemon.stop disposes its owned mimetypes after derivations exactly once", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const events: string[] = [];
    let disposals = 0;
    const originalDrain = daemon.engine.drainDerivations.bind(daemon.engine);
    daemon.engine.drainDerivations = async (): Promise<void> => {
        await originalDrain();
        events.push("derivations-drained");
    };
    const ownedMimetypes = daemon.mimetypes;
    const originalDispose = ownedMimetypes.dispose.bind(ownedMimetypes);
    ownedMimetypes.dispose = async (): Promise<void> => {
        disposals += 1;
        events.push("mimetypes-disposed");
        await originalDispose();
    };
    try {
        await daemon.stop();
        assert.equal(disposals, 0, "pre-start stop acquires and releases nothing");
        await daemon.start();
        await daemon.stop();
        await daemon.stop();
        assert.equal(disposals, 1, "repeated stop does not repeat owned teardown");
        assert.deepEqual(events, ["derivations-drained", "mimetypes-disposed"]);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mimetype-owned-lifecycle}: Daemon.stop cancels nonresponsive planning and embedding before derivation drain", async (t) => {
    const priorEmbedDisable = process.env.PLURNK_SERVICE_EMBED_DISABLE;
    process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";
    t.after(() => {
        if (priorEmbedDisable === undefined) delete process.env.PLURNK_SERVICE_EMBED_DISABLE;
        else process.env.PLURNK_SERVICE_EMBED_DISABLE = priorEmbedDisable;
    });
    for (const blockedPhase of ["planning", "embedding"] as const) {
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider: null });
        let release = () => {};
        try {
            await daemon.start();
            const workspaceId = await insertWorkspace(db, `stop-${blockedPhase}-${crypto.randomUUID()}`);
            const pathname = `/${blockedPhase}-blocked.md`;
            await seedEntryWithChannel(db, {
                workspaceId,
                pathname,
                content: `shutdown must not wait forever for ${blockedPhase}`,
                mimetype: "text/markdown",
            });
            let entered!: () => void;
            const blocked = new Promise<void>((resolve) => { entered = resolve; });
            daemon.mimetypes.embedderInfo = async () => ({
                dimension: 2,
                contextWindow: 128,
                countTokens: async (_text, options) => {
                    if (blockedPhase !== "planning") return 8;
                    return new Promise((resolve, reject) => {
                        entered();
                        release = () => resolve(8);
                        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
                    });
                },
                model: "stub@shutdown",
            });
            daemon.mimetypes.embedBatch = async (texts, options) => {
                if (blockedPhase !== "embedding") {
                    return texts.map(() => new Uint8Array(new Float32Array([1, 0]).buffer));
                }
                return new Promise((resolve, reject) => {
                    entered();
                    release = () => resolve(texts.map(() => new Uint8Array(new Float32Array([1, 0]).buffer)));
                    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
                });
            };

            const warm = daemon.engine.warmWorkspaceDerivations(workspaceId);
            void warm.catch(() => {});
            await blocked;
            const stop = daemon.stop();
            let timer;
            const outcome = await Promise.race<"fulfilled" | "rejected" | "pending">([
                stop.then(
                    () => "fulfilled" as const,
                    () => "rejected" as const,
                ),
                new Promise<"pending">((resolve) => {
                    timer = setTimeout(() => resolve("pending"), 2_000);
                }),
            ]);
            clearTimeout(timer);
            if (outcome === "pending") release();
            await Promise.allSettled([warm, stop]);

            assert.equal(outcome, "fulfilled", `shutdown cancels nonresponsive ${blockedPhase}`);
            const [entry] = await db.test_entries_with_hash_by_scheme_prefix.all<{
                pathname: string;
                deep_hash: string | null;
            }>({ workspace_id: workspaceId, scheme: "worker", prefix: pathname });
            const counts = await db.test_derivation_state_counts.get<{
                building: number;
                complete: number;
            }>({});
            assert.deepEqual(
                { deep_hash: entry?.deep_hash, ...counts },
                { deep_hash: null, building: 1, complete: 0 },
                `${blockedPhase} cancellation leaves the interrupted artifact unattached and retryable`,
            );
        } finally {
            release();
            await daemon.stop();
            await db.close();
        }
    }
});

test("Daemon.stop leaves constructor-injected mimetypes caller-owned", async () => {
    const db = await openMigrated();
    const injected = new Mimetypes({
        discovery: {
            registry: { byExtension: new Map(), byFilename: new Map() },
            handlers: new Map(),
            skipped: [],
        },
    });
    let disposals = 0;
    const originalDispose = injected.dispose.bind(injected);
    injected.dispose = async (): Promise<void> => {
        disposals += 1;
        await originalDispose();
    };
    const daemon = new Daemon({ db, provider: null, mimetypes: injected });
    try {
        await daemon.start();
        await daemon.stop();
        assert.equal(disposals, 0, "the daemon does not destroy caller-owned state");
        assert.equal((await injected.classify("text/plain")).binary, false, "caller-owned state remains usable");
        await injected.dispose();
        assert.equal(disposals, 1, "the caller retains explicit teardown authority");
    } finally {
        await daemon.stop();
        await injected.dispose();
        await db.close();
    }
});

test("daemon shutdown preserves module and scheme lifecycle failures in one aggregate", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    daemon.registerModule({
        async close() { throw new Error("module close failed"); },
    });
    daemon.mimetypes.dispose = async () => { throw new Error("mimetype dispose failed"); };
    daemon.schemes.register("broken-close", {
        manifest: {
            name: "broken-close",
            channels: { body: "text/plain" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        },
        async close() { throw new Error("scheme close failed"); },
    });
    try {
        await daemon.start();
        await assert.rejects(
            () => daemon.stop(),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "daemon shutdown failed");
                assert.deepEqual(
                    error.errors.map((cause) => String(cause)),
                    [
                        "Error: module close failed",
                        "Error: mimetype dispose failed",
                        "Error: scheme close failed",
                    ],
                );
                return true;
            },
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("a module that acquires resources during setup is closed when later setup fails", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 8192,
            responses: [],
        }),
    });
    let closed = false;
    daemon.registerModule({
        setup: async () => {
            throw new Error("setup failed");
        },
        close: async () => {
            closed = true;
        },
    });
    try {
        await assert.rejects(() => daemon.start(), /setup failed/);
        await daemon.stop();
        assert.equal(closed, true, "setup-acquired resources are not leaked after boot failure");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
