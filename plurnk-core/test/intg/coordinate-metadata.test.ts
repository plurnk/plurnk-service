// {§provider-surface-generate} {§lifecycle-terms}: core supplies the authoritative turn coordinate to
// generate(); providers owns its first-party header transport. `loop` is the loop sequence, never its
// database id; the fixture deliberately makes those values diverge.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, viableWindow } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class CoordMock extends Mock {
    seen: { workspaceId?: string; loop?: number; turn?: number; workerId?: string; primaryWorkerId?: string; callKind?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; loop?: number; turn?: number; workerId?: string; primaryWorkerId?: string; callKind?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, loop: args.loop, turn: args.turn, workerId: args.workerId, primaryWorkerId: args.primaryWorkerId, callKind: args.callKind };
        return super.generate(args);
    }
}

test("generate carries the workspace/loop/turn coordinate, using loop sequence rather than database id", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, workerId, 5, "go");
        assert.notEqual(loopId, 5, "the loop's db id and its sequence diverge for this pin");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, workerId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "Plurnk-Workspace-Id — the workspace id, stringified");
        assert.equal(mock.seen.loop, 5, "Plurnk-Loop — the loop's SEQUENCE (coordinate), not its db id");
        assert.equal(mock.seen.turn, 2, "Plurnk-Turn — initialization is the first real turn, so the first inference is turn 2");
        assert.equal(mock.seen.callKind, "emission", "ordinary turns declare the emission output contract");
    } finally { await db.close(); }
});

test("generate carries primaryWorkerId — a spawned child's differs from its Worker-Id; the root's equals it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `primary-meta-${crypto.randomUUID()}`);
        const root = await insertWorker(db, workspaceId, null, "root");
        const child = await insertWorker(db, workspaceId, root, "child");
        const rootIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: root });
        const childIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: child });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // The PRIMARY (root) worker: Worker-Primary == Worker-Id (pin 2 — always stamped, self-equal).
        const rootLoop = await insertLoop(db, root, 1, "go");
        const m1 = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await engine.runTurn({ provider: m1, workspaceId, workerId: root, loopId: rootLoop, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(m1.seen.workerId, rootIdentity?.provider_identity, "the provider sees the root's durable opaque identity, not its local row id");
        assert.equal(m1.seen.primaryWorkerId, rootIdentity?.provider_identity, "the primary's own turn stamps Worker-Primary");
        assert.equal(m1.seen.primaryWorkerId, m1.seen.workerId, "Worker-Primary == Worker-Id on the primary — the endpoint routes it to the strong model");

        // A SPAWNED child: Worker-Primary is the ROOT, != its own Worker-Id (endpoint routes it cheap).
        const childLoop = await insertLoop(db, child, 1, "go");
        const m2 = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await engine.runTurn({ provider: m2, workspaceId, workerId: child, loopId: childLoop, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(m2.seen.workerId, childIdentity?.provider_identity, "the child carries its own durable provider identity");
        assert.equal(m2.seen.primaryWorkerId, rootIdentity?.provider_identity, "a spawned child carries the ROOT as Worker-Primary");
        assert.notEqual(m2.seen.primaryWorkerId, m2.seen.workerId, "Worker-Primary != Worker-Id on a spawn — routed to the cheap model");
    } finally { await db.close(); }
});
