import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogBody from "../../src/core/LogBody.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { holdChild, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

for (const header of ["WAIT", "WAIT (sh:///missing) <60,60> [{\"timeout\":42}]"]) {
    test(`{§park-202-only} {§wait-obligation-matrix} ${header} parks on the actual live child, not the decoration`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-obligations");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Await the child.");
        await holdChild(db, workspaceId, workerId);
        const source = [PlurnkParser.frame(header, "Await results."), PlurnkParser.frame("NOTE", "The child is checking.")].join("\n\n");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        assert.equal(await new LoopLifecycle(db).status(loopId), 202);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["NOTE", 200], ["WAIT", 202]], "WAIT still settles after its sibling");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; rx: string }>({ turn_id: result.turnId });
        const wait = rows.find(({ op }) => op === "WAIT");
        assert.ok(wait);
        const tx = JSON.parse(wait.tx);
        assert.equal(tx.target?.raw ?? null, header === "WAIT" ? null : "sh:///missing");
        assert.equal(tx.lineMarker, null);
        assert.equal(tx.metadata, null);
        assert.equal(tx.body, "Await results.");
        assert.equal(JSON.parse(wait.rx).problem, undefined);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
    });
}

test("{§park-202-only} {§wait-obligation-matrix} WAIT retains literal prose without inventing a response", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const body = "Report the findings.";
        const source = PlurnkParser.frame("WAIT", body);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "absence of live work does not complete a waiting task");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal, null, "no deliverable is manufactured from a wait");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["WAIT"]);
        const wait = rows.find(({ op }) => op === "WAIT")!;
        assert.equal(wait.status_rx, 102);
        assert.equal(JSON.parse(wait.rx).detail, "Nothing is in flight. Continuing.");
        assert.equal(JSON.parse(wait.tx).body, body);
        const projection = LogBody.resolve({ op: "WAIT", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "text/plain");
        assert.equal(projection.content, body);
    } finally { await db.close(); }
});
