// #391 — the turn COORDINATE rides generate() as first-party metadata (Plurnk-Session-Id/Loop/Turn),
// the authoritative session/loop/turn hierarchy the endpoint flywheel keys on. The daemon owns the
// value; providers stamps the header (same split as Run-Id #26). This pins that core passes it, and
// that `loop` is the loop's SEQUENCE (the coordinate) — never the DB id, which they diverge to prove.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, viableWindow } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class CoordMock extends Mock {
    seen: { sessionId?: string; loop?: number; turn?: number } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { sessionId?: string; loop?: number; turn?: number }): ReturnType<Mock["generate"]> {
        this.seen = { sessionId: args.sessionId, loop: args.loop, turn: args.turn };
        return super.generate(args);
    }
}

test("[#391] generate carries the turn coordinate — session id + loop/turn SEQUENCE, not the db id", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `coord-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, runId, 5, "go");
        assert.notEqual(loopId, 5, "the loop's db id and its sequence diverge for this pin");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await engine.runTurn({ provider: mock, sessionId, runId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.sessionId, String(sessionId), "Plurnk-Session-Id — the session id, stringified");
        assert.equal(mock.seen.loop, 5, "Plurnk-Loop — the loop's SEQUENCE (coordinate), not its db id");
        assert.equal(mock.seen.turn, 1, "Plurnk-Turn — the sequence of the turn being generated");
    } finally { await db.close(); }
});
