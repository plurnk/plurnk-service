import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogBody from "../../src/core/LogBody.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§plan-value} a waiting inventory remains nonterminal when nothing is in flight", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const inventory = [{ content: "Report the findings.", status: "waiting" }];
        const source = PlurnkParser.frame("TASK", JSON.stringify(inventory));
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "absence of live work does not complete a waiting task");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal, null, "no deliverable is manufactured from the task inventory");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op), ["TASK"]);
        const wait = rows.find(({ op }) => op === "TASK")!;
        assert.equal(wait.status_rx, 102);
        assert.equal(JSON.parse(wait.rx).detail, "Nothing is in flight and no timed or polled wait is set. Continuing.");
        assert.deepEqual(JSON.parse(wait.tx).body, inventory);
        const projection = LogBody.resolve({ op: "TASK", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "application/json");
        assert.deepEqual(JSON.parse(projection.content), inventory);
    } finally { await db.close(); }
});
