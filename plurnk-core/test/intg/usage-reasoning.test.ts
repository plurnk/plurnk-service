// #321 — usage.reasoning persists per turn (from providers#28): the reasoning-token count was
// the one usage field the turn row dropped, so cost/telemetry couldn't see reasoning spend.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("usage.reasoning is persisted on the turn row", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ur-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const resp: MockResponse = { assistant: { content: "", reasoning: "thought hard", ops: [sendStmt(200, null, "done")], usage: { prompt: 100, completion: 20, reasoning: 37, cached: 0, total: 157 } } };
        const provider = new Mock({ contextWindow: 100000, responses: [resp] });
        const r = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const turn = await db.test_get_turn.get<{ usage_reasoning: number; usage_completion: number }>({ id: r.turnId });
        assert.equal(turn?.usage_reasoning, 37, "the reasoning token count round-trips to the turn row");
        assert.equal(turn?.usage_completion, 20, "completion is unaffected");
    } finally { await db.close(); }
});
