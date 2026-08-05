// #391 — the turn COORDINATE rides generate() as first-party metadata (Plurnk-Workspace-Id/Loop/Turn),
// the authoritative workspace/loop/turn hierarchy the endpoint flywheel keys on. The daemon owns the
// value; providers stamps the header (same split as Worker-Id #26). This pins that core passes it, and
// that `loop` is the loop's SEQUENCE (the coordinate) — never the DB id, which they diverge to prove.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, viableWindow } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class CoordMock extends Mock {
    seen: { workspaceId?: string; loop?: number; turn?: number; workerId?: string; primaryWorkerId?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; loop?: number; turn?: number; workerId?: string; primaryWorkerId?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, loop: args.loop, turn: args.turn, workerId: args.workerId, primaryWorkerId: args.primaryWorkerId };
        return super.generate(args);
    }
}

test("[#391] generate carries the turn coordinate — workspace id + loop/turn SEQUENCE, not the db id", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, workerId, 5, "go");
        assert.notEqual(loopId, 5, "the loop's db id and its sequence diverge for this pin");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, workerId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "Plurnk-Workspace-Id — the workspace id, stringified");
        assert.equal(mock.seen.loop, 5, "Plurnk-Loop — the loop's SEQUENCE (coordinate), not its db id");
        assert.equal(mock.seen.turn, 1, "Plurnk-Turn — the sequence of the turn being generated");
    } finally { await db.close(); }
});

test("generate carries primaryWorkerId — a spawned child's differs from its Worker-Id; the root's equals it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `primary-meta-${crypto.randomUUID()}`);
        const root = await insertWorker(db, workspaceId, null, "root");
        const child = await insertWorker(db, workspaceId, root, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // The PRIMARY (root) worker: Worker-Primary == Worker-Id (pin 2 — always stamped, self-equal).
        const rootLoop = await insertLoop(db, root, 1, "go");
        const m1 = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await engine.runTurn({ provider: m1, workspaceId, workerId: root, loopId: rootLoop, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(m1.seen.primaryWorkerId, String(root), "the primary's own turn stamps Worker-Primary");
        assert.equal(m1.seen.primaryWorkerId, m1.seen.workerId, "Worker-Primary == Worker-Id on the primary — the endpoint routes it to the strong model");

        // A SPAWNED child: Worker-Primary is the ROOT, != its own Worker-Id (endpoint routes it cheap).
        const childLoop = await insertLoop(db, child, 1, "go");
        const m2 = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await engine.runTurn({ provider: m2, workspaceId, workerId: child, loopId: childLoop, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(m2.seen.primaryWorkerId, String(root), "a spawned child carries the ROOT as Worker-Primary");
        assert.notEqual(m2.seen.primaryWorkerId, m2.seen.workerId, "Worker-Primary != Worker-Id on a spawn — routed to the cheap model");
    } finally { await db.close(); }
});
