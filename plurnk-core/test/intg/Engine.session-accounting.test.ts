// {§methods-session-accounting} — a session's spend since it began: every settled request on any loop
// it or a descendant ran, nested delegation included; never an unrelated session's.
import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { insertLoop, insertTurn, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

const spend = async (db: Db, loopId: number, sequence: number, inputTokens: number, costUsd: string): Promise<void> => {
    const turnId = await insertTurn(db, loopId, sequence, 200);
    const call = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "mock" });
    if (call === undefined) throw new Error("fixture model call did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({ inference_call_id: call.id, sequence: 1, provider: "provider:mock", model: "mock" });
    if (request === undefined) throw new Error("fixture provider request did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock", model: "mock", outcome: "response",
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
        cost: { kind: "estimated", amount: { amount: costUsd, currency: "USD" }, source: "fixture" },
    };
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
};

test("{§methods-session-accounting}: the session's own and its descendants' settled spend since it began, and nothing else", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "session-spend");
        const parent = await insertSession(db, workspaceId, null, "parent", "model");
        const child = await insertSession(db, workspaceId, parent, "child", "model");
        const grandchild = await insertSession(db, workspaceId, child, "grandchild", "model");
        const stranger = await insertSession(db, workspaceId, null, "stranger", "model");
        const idle = await insertSession(db, workspaceId, null, "idle", "model");
        // An earlier delegation of the same child: still this session's tree, still its spend.
        const earlier = await insertLoop(db, child, 1, "earlier");
        await spend(db, earlier, 1, 1000, "1.00");
        const parentLoop = await insertLoop(db, parent, 1, "delegate");
        await spend(db, parentLoop, 1, 500, "0.50");
        const childLoop = await insertLoop(db, child, 2, "child work");
        await spend(db, childLoop, 1, 100, "0.10");
        await spend(db, childLoop, 2, 200, "0.20");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild work");
        await spend(db, grandchildLoop, 1, 40, "0.04");
        const strangerLoop = await insertLoop(db, stranger, 1, "unrelated");
        await spend(db, strangerLoop, 1, 7000, "7.00");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const accounting = await engine.sessionAccounting(parent);
        assert.equal(accounting.requests.length, 5, "its own request and every descendant's, the older delegation included");
        assert.equal(accounting.usage?.inputTokens, 1840, "the stranger's 7000 never counts");
        assert.equal(accounting.costUsd, "1.84");

        const own = await engine.loopUsage(parentLoop);
        assert.equal(own.accounting.usage?.inputTokens, 500, "one loop's own accounting keeps its meaning");

        const leaf = await engine.sessionAccounting(grandchild);
        assert.equal(leaf.usage?.inputTokens, 40, "a session without descendants reports its own");
        const none = await engine.sessionAccounting(idle);
        assert.equal(none.requests.length, 0);
        assert.equal(none.costUsd, "0", "nothing spent projects explicit zero");
    } finally { await db.close(); }
});
