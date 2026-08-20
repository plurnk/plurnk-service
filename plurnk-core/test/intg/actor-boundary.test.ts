// SPEC {§actor-boundary} — the actor boundary (isolation by worker, two doors, self-hosting).
// Composed coverage for structural log isolation, the environment/voice doors,
// and ordinary runtime-owned operations through the reserved plurnk worker.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", annotation: null, delimiter: "", signal: null, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

test("two workers in one workspace both write the same shared entry — no lock", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { workerId, loopId, turnId };
        };
        const a = await spawn();
        const b = await spawn();
        const target = urlPath("worker", "/shared.md");
        const resultA = await engine.dispatch({ statement: editStmt(target, "from worker A"), workspaceId, workerId: a.workerId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const resultB = await engine.dispatch({ statement: editStmt(target, "from worker B", fullReplace), workspaceId, workerId: b.workerId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // Wild west = both writers succeed (no lock rejects the second). A creates
        // the shared entry (201), B updates it (200); neither is a 409/lock refusal.
        assert.ok([200, 201].includes(resultA.status), `worker A's write to the shared entry succeeds (got ${resultA.status})`);
        assert.ok([200, 201].includes(resultB.status), `worker B's write to the SAME entry also succeeds — no mutual exclusion (got ${resultB.status})`);
    } finally { db.close(); }
});

test("a packet renders one worker's log; a sibling worker's log is absent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { workerId, loopId, turnId };
        };
        // Two sibling workers in one workspace — e.g. the model worker and a client worker.
        const a = await spawn();
        const b = await spawn();
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/from-a.md"), "a"), workspaceId, workerId: a.workerId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/from-b.md"), "b"), workspaceId, workerId: b.workerId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // Worker A's packet is rendered from worker A's log alone.
        const packetA = await db.engine_render_log.all<{ pathname: string }>({ worker_id: a.workerId });
        assert.ok(packetA.some((r) => r.pathname.includes("from-a")), "worker A's own log renders in its packet");
        assert.ok(packetA.every((r) => !r.pathname.includes("from-b")), "sibling worker B's log never enters worker A's packet — invisibility is by worker, no origin filter");
    } finally { db.close(); }
});

test("origin is attribution (provenance), never read to hide a row at render", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        // A CLIENT-origin row living IN this worker must still render: the renderer
        // scopes by worker, never hides by origin.
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/in-worker.md"), "x"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client" });
        const packet = await db.engine_render_log.all<{ pathname: string; origin: string }>({ worker_id: workerId });
        const row = packet.find((r) => r.pathname.includes("in-worker"));
        assert.ok(row !== undefined, "an in-worker row renders regardless of origin");
        assert.equal(row!.origin, "client", "origin is carried as attribution, not consumed to hide the row");
    } finally { db.close(); }
});

// {§actor-boundary-two-doors} is a REAL test now in Engine.env-delta.test.ts (both doors —
// state-via-delta + message-via-inject). The stale "voice door unbuilt" stub is retired: the
// voice door (inject), and IRC through it, resume parked workers in place under
// {§methods-loop-run-fold-consistency}.

// The voice door (inject) and the negative (a delta must not wake) are locked here;
// the stream-status door — a slept (202) loop's stream concluding RESUMES it in place,
// an active loop folds the conclusion into its next turn — is locked in
// Daemon.exec-wake.test.ts. Together they discharge {§actor-boundary-passive-wake}'s two-trigger contract.
test("an idle worker wakes on an inject (voice), never on a delta (a sibling's shared-entry edit)", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [
        makeMockResponse("## SEND0 [200]\nfirst done", 10),
        makeMockResponse("## SEND0 [200]\nwoke done", 10),
        makeMockResponse("## SEND0 [200]\nextra", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "passive-wake" });
            // Run a loop to completion → the model worker is now IDLE (one loop).
            const ran = await runLoopToTerminal(ws, 2, { prompt: "first", flags: { auto: true } });
            const { loopId } = ran as { loopId: number };
            const modelWorkerId = (await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId }))!.worker_id;
            const loopsIdle = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: modelWorkerId }))!.n;

            // A delta: a client op.edit runs in the connection's own client worker — a
            // sibling of the model worker ({§connection-lifecycle}) — touching a shared entry.
            // This is the environment door; it must NOT wake the idle model worker.
            await rpcCall(ws, 3, "op.edit", { target: "worker:///shared.md", content: "a sibling edit — ambient, not addressed to the model worker" });
            const loopsAfterDelta = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: modelWorkerId }))!.n;
            assert.equal(loopsAfterDelta, loopsIdle, "a delta (sibling shared-entry edit) does NOT wake the idle worker — no new loop enqueued");

            // The VOICE door: inject a prompt into the same idle worker → it wakes, a fresh
            // loop is enqueued on the model worker.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW — wake up" });
            assert.equal((injected.result as { action: string }).action, "enqueued_new_loop", "an inject (voice) wakes the idle worker");
            const loopsAfterInject = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: modelWorkerId }))!.n;
            assert.equal(loopsAfterInject, loopsIdle + 1, "the inject enqueued exactly one new loop — the wake the delta did not cause");
        } finally { ws.close(); }
    });
});

test("runtime-owned entry work uses the durable plurnk worker and an ephemeral loop", async () => {
    // The AGENTS stunt ({§turn0-agents-stunt}) is operation-shaped runtime work,
    // so it uses DispatchAsPlurnk. The EDIT belongs to the reserved worker's
    // fresh loop; the model reaches only the resulting shared entry through
    // its own READ.
    const dir = await mkdtemp(join(tmpdir(), "plurnk-selfhost-"));
    await writeFile(join(dir, "AGENTS.md"), "# Self-hosting\nThe runtime is an actor.\n", "utf8");
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "selfhost", projectRoot: dir })).result as { id: number }).id;
                const { loopId } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number };
                const modelWorkerId = (await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId }))!.worker_id;

                // 1. The reserved plurnk worker exists, is distinct from the model worker, and OWNS the
                //    materializing EDIT — an ordinary actor doing ops, not the engine writing privileged.
                const plurnkWorker = (await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" }))!;
                assert.ok(plurnkWorker !== undefined, "the reserved plurnk worker exists for runtime-owned operations");
                assert.notEqual(plurnkWorker.id, modelWorkerId, "the plurnk worker is a sibling actor, distinct from the model worker");
                const plurnkLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: plurnkWorker.id });
                const plurnkLoopStatus = await db.test_get_loop_status.get<{ status: number }>({ id: plurnkLoop?.id });
                assert.equal(plurnkLoopStatus?.status, 200, "the runtime actor's ephemeral loop is terminal after its batch");
                const plurnkLog = await db.engine_render_log.all<{ op: string; scheme: string; pathname: string; origin: string }>({ worker_id: plurnkWorker.id });
                const matEdit = plurnkLog.find((r) => r.op === "EDIT" && r.scheme === "worker" && r.pathname === "/agents.md");
                assert.ok(matEdit !== undefined, "the materializing EDIT is IN the plurnk worker's log — an op, not a privileged engine pathway");
                assert.equal(matEdit!.origin, "_plurnk", "the op is attributed to the plurnk actor (origin=_plurnk)");

                // 2. The model worker's log NEVER carries that EDIT — isolation by worker holds; nothing privileged leaked in.
                const modelLog = await db.engine_render_log.all<{ op: string; scheme: string; pathname: string; status_rx: number }>({ worker_id: modelWorkerId });
                assert.ok(!modelLog.some((r) => r.op === "EDIT" && r.scheme === "worker" && r.pathname === "/agents.md"), "the model worker never sees the plurnk actor's EDIT — only the resulting entry, through the env door");

                // 3. The environment door: the model worker reaches the entry the plurnk actor produced (a 200 READ),
                //    exactly as it reaches any sibling's edit to the shared filesystem. Dogfooding, not a back channel.
                const docRead = modelLog.find((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/agents.md");
                assert.ok(docRead !== undefined && docRead.status_rx === 200, "the model worker reaches the plurnk actor's entry through the shared filesystem (env door)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
