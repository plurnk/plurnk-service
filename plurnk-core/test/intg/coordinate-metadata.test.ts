// {§provider-surface-generate}: core supplies the workspace this call serves as ordinary call
// context. Nothing about it reaches a backend (#697 retired the first-party header channel).
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, viableWindow } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class CoordMock extends Mock {
    seen: { workspaceId?: string; workerId?: string; callKind?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; workerId?: string; callKind?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, workerId: args.workerId, callKind: args.callKind };
        return super.generate(args);
    }
}

test("generate carries the workspace this call serves, and its durable worker identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, workerId, 5, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, workerId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "the workspace id, stringified");
        assert.equal(mock.seen.callKind, "emission", "ordinary turns declare the emission output contract");
    } finally { await db.close(); }
});

