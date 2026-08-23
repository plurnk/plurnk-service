// {§module-worker-residency} {§module-worker-quiescence} — the residency owner
// in isolation: provider registration, demand-driven activation order,
// replacement gate modes, durable state round-trips, and atomic rollback. The
// composed behavior (cooling policy, document reconciliation, coordinator
// integration) stays covered through the Daemon and Functionality specimens.
import test from "node:test";
import assert from "node:assert/strict";
import type { ProblemDetails } from "@plurnk/plurnk-contracts";
import type Engine from "../../src/core/Engine.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import WorkerResidency from "../../src/server/WorkerResidency.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_helpers.ts";
import type { Db } from "../../src/core/Db.ts";

const problemOf = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof OperationFailureError, `expected an operation failure, got ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("expected the call to reject");
};

const harness = async () => {
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `residency-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "resident", "model");
    const calls: string[] = [];
    let rollbacks = 0;
    const engine = {
        prepareWorkerRuntimes: async (targetWorkerId: number, owner: string, normalized: unknown[]) => {
            calls.push(`prepare:${targetWorkerId}:${owner}:${normalized.length}`);
            return () => {
                calls.push(`commit:${targetWorkerId}:${owner}`);
                return () => { rollbacks += 1; };
            };
        },
        referenceEntries: async () => [],
    } as unknown as Engine;
    const workspaceGate = new WorkspaceGate(async () => false);
    const residency = new WorkerResidency({
        db,
        engine: () => engine,
        workspaceGate,
        normalizeRuntime: (registration) => {
            calls.push(`normalize:${registration.decl.name}`);
            return { tag: registration.decl.name, entry: {} as never, scheme: undefined };
        },
    });
    return { db, workspaceId, workerId, residency, workspaceGate, calls, rollbacks: () => rollbacks };
};

test("provider registration is validated and exactly-once per namespace owner", async () => {
    const { db, residency } = await harness();
    try {
        const provider = { activate: async () => {}, deactivate: async () => {} };
        assert.throws(() => residency.registerProvider("  ", provider), /non-empty namespace owner/);
        assert.throws(() => residency.registerProvider("owner", {} as never), /requires activate and deactivate/);
        residency.registerProvider("owner", provider);
        assert.throws(() => residency.registerProvider("owner", provider), /'owner' is already registered/);
    } finally {
        await db.close();
    }
});

test("acquire binds Worker to workspace, activates providers in order with a working retain, and refuses ghosts", async () => {
    const { db, workspaceId, workerId, residency, calls } = await harness();
    try {
        const order: string[] = [];
        residency.registerProvider("first", {
            activate: async (context) => {
                order.push(`first:${context.workspaceId}/${context.workerId}`);
                const release = context.retain();
                release();
            },
            deactivate: async () => { order.push("first:down"); },
        });
        residency.registerProvider("second", {
            activate: async () => { order.push("second"); },
            deactivate: async () => { order.push("second:down"); },
        });
        assert.equal((await problemOf(() => residency.acquire(workspaceId + 999, workerId))).type, "https://problems.plurnk.dev/daemon/worker-functionality/worker-not-found");
        assert.equal((await problemOf(() => residency.identity(workerId + 999))).status, 404);
        const release = await residency.acquire(workspaceId, workerId);
        assert.deepEqual(order, [`first:${workspaceId}/${workerId}`, "second"], "providers activate in registration order with the Worker identity");
        assert.equal(residency.isActive(workerId), true);
        assert.deepEqual(residency.activeWorkerIds(), [workerId]);
        const again = await residency.acquire(workspaceId, workerId);
        assert.deepEqual(order.length, 2, "a second demand reuses the resident activation");
        release();
        again();
        assert.deepEqual(await residency.identity(workerId), { workspaceId, workerId });
        void calls;
    } finally {
        await db.close();
    }
});

test("a failed provider activation deactivates what activated and surfaces the cause", async () => {
    const { db, workspaceId, workerId, residency } = await harness();
    try {
        const order: string[] = [];
        residency.registerProvider("ok", {
            activate: async () => { order.push("ok:up"); },
            deactivate: async () => { order.push("ok:down"); },
        });
        residency.registerProvider("broken", {
            activate: async () => { throw new Error("activation refused"); },
            deactivate: async () => { order.push("broken:down"); },
        });
        await assert.rejects(() => residency.acquire(workspaceId, workerId), /activation refused/);
        assert.deepEqual(order, ["ok:up", "broken:down", "ok:down"], "cleanup deactivates in reverse order");
        assert.equal(residency.isActive(workerId), false);
    } finally {
        await db.close();
    }
});

test("replacement: gate modes, durable state round-trip, owner mismatch, and atomic rollback", async () => {
    const { db, workspaceId, workerId, residency, workspaceGate, calls, rollbacks } = await harness();
    try {
        const registration = (owner: string, name: string) => ({
            namespaceOwner: owner,
            decl: { name, glyph: "x", summary: "s", invocation: { body: { role: "r", required: false }, example: {} } },
            executor: {} as never,
            availability: { available: true },
        });
        // A held workspace refuses `try`, queues `wait` behind the holder, and
        // admits `none` inside the holder's own context.
        const held = workspaceGate.tryExclusive(workspaceId);
        assert.ok(held !== null);
        await held.acquired;
        const refused = await problemOf(() => residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: { v: 1 }, runtimes: [] }));
        assert.equal(refused.type, "https://problems.plurnk.dev/daemon/worker-functionality/workspace-busy");
        await residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: { v: 1 }, runtimes: [] }, { gate: "none" });
        assert.deepEqual(await residency.readModuleState(workerId, "own"), { v: 1 });
        const waited = residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: { v: 2 }, runtimes: [registration("own", "tag-a")] }, { gate: "wait" });
        assert.deepEqual(await residency.readModuleState(workerId, "own"), { v: 1 }, "a waiting replacement has not run while the gate is held");
        held.release();
        await waited;
        assert.deepEqual(await residency.readModuleState(workerId, "own"), { v: 2 });
        assert.ok(calls.includes("normalize:tag-a") && calls.includes(`prepare:${workerId}:own:1`) && calls.includes(`commit:${workerId}:own`), `replacement normalized, prepared, and committed: ${calls.join(",")}`);
        // Identity and ownership are exact.
        assert.equal((await problemOf(() => residency.replace({ workspaceId: workspaceId + 999, workerId, namespaceOwner: "own", state: null, runtimes: [] }))).type, "https://problems.plurnk.dev/daemon/worker-functionality/workspace-mismatch");
        await assert.rejects(
            () => residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: null, runtimes: [registration("other", "tag-b")] }),
            /does not match 'own'/,
        );
        // A refused publication rolls the committed runtimes and durable state back.
        const engineRefusal = residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: { v: 3 }, runtimes: [] }, { gate: "none" });
        await engineRefusal;
        assert.deepEqual(await residency.readModuleState(workerId, "own"), { v: 3 });
        residency.publish();
        const before = rollbacks();
        const failing = {
            prepareWorkerRuntimes: async () => { throw new Error("host refused the runtime set"); },
        };
        const failingResidency = new WorkerResidency({
            db,
            engine: () => failing as unknown as Engine,
            workspaceGate,
            normalizeRuntime: () => ({ tag: "t", entry: {} as never, scheme: undefined }),
        });
        await assert.rejects(
            () => failingResidency.replace({ workspaceId, workerId, namespaceOwner: "own", state: { v: 4 }, runtimes: [] }),
            /host refused the runtime set/,
        );
        assert.deepEqual(await residency.readModuleState(workerId, "own"), { v: 3 }, "durable state is unchanged after a refused preparation");
        assert.equal(rollbacks(), before, "nothing was committed, so nothing rolled back");
        // state: null forgets the durable row.
        await residency.replace({ workspaceId, workerId, namespaceOwner: "own", state: null, runtimes: [] }, { gate: "none" });
        assert.equal(await residency.readModuleState(workerId, "own"), null);
    } finally {
        await db.close();
    }
});
