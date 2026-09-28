// {§methods-worker-descendants} — a worker's descendants' spend on this delegation: every
// settled request on a loop a descendant ran after the worker's loop, nested delegation included;
// never the worker's own loop, an unrelated worker, or a descendant's loop older than the delegation.
import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
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

test("{§methods-worker-descendants}: the descendant tree's settled spend after the worker's loop, and nothing else", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "descendants");
        const parent = await insertWorker(db, workspaceId, null, "parent", "model");
        const child = await insertWorker(db, workspaceId, parent, "child", "model");
        const grandchild = await insertWorker(db, workspaceId, child, "grandchild", "model");
        const stranger = await insertWorker(db, workspaceId, null, "stranger", "model");
        // An earlier delegation of the same child: before the parent's current loop, so not this one.
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
        const accounting = await engine.descendantAccounting(parent, parentLoop);
        assert.equal(accounting.requests.length, 3, "child's two requests and the grandchild's one");
        assert.equal(accounting.usage?.inputTokens, 340, "nested delegation counts; the parent's own 500, the stranger's 7000 and the older 1000 do not");
        assert.equal(accounting.costUsd, "0.34");

        const own = await engine.loopUsage(parentLoop);
        assert.equal(own.accounting.usage?.inputTokens, 500, "the worker's own loop accounting keeps its meaning");

        const none = await engine.descendantAccounting(parent, null);
        assert.equal(none.requests.length, 0);
        assert.equal(none.costUsd, "0", "no loop, no delegation: the empty set projects explicit zero");
        const leaf = await engine.descendantAccounting(grandchild, grandchildLoop);
        assert.equal(leaf.requests.length, 0, "a worker without descendants has nothing to report");
    } finally { await db.close(); }
});
