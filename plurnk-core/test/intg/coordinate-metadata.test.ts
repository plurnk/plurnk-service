// {§provider-surface-generate}: core supplies the workspace this call serves as ordinary call
// context. Nothing about it reaches a backend (#697).
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { makeMockResponse } from "./_mock.ts";

class CoordMock extends Mock {
    seen: { workspaceId?: string; sessionId?: string; callKind?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; sessionId?: string; callKind?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, sessionId: args.sessionId, callKind: args.callKind };
        return super.generate(args);
    }
}

test("{§provider-surface-generate} generate carries the workspace this call serves, and its durable session identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, sessionId, 5, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "the workspace id, stringified");
        assert.equal(mock.seen.callKind, "emission", "ordinary turns declare the emission output contract");
    } finally { await db.close(); }
});

