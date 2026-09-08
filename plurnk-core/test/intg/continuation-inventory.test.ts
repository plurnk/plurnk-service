import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogBody from "../../src/core/LogBody.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§plan-value} empty WAIT joins successfully without discarding or completing its inventory", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const inventory = [{ content: "Report the findings.", status: "pending" }];
        const source = PlurnkParser.frame("WAIT", JSON.stringify(inventory));
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 200, "inventory statuses do not change the empty-join transition");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal?.status, 200);
        assert.equal(terminal?.mimetype, "application/json");
        assert.deepEqual(JSON.parse(terminal?.content as string), inventory, "the parent receives the complete unchanged inventory");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["WAIT"]);
        const wait = rows.find(({ op }) => op === "WAIT")!;
        assert.equal(wait.status_rx, 200);
        assert.deepEqual(JSON.parse(wait.tx).body, inventory);
        const projection = LogBody.resolve({ op: "WAIT", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "application/json");
        assert.deepEqual(JSON.parse(projection.content), inventory);
    } finally { await db.close(); }
});
