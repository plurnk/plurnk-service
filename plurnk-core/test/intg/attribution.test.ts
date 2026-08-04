// {§attribution-discovery-placeholder}

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";
import { parseDsl } from "./_rpc.ts";

const sendDone = parseDsl("<<PLAN::PLAN\n<<SEND[200]:done:SEND");
const turn = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// Run one turn against a provider whose generate() is shadowed to capture the attributions
// arg, with the scheme registry's discovered-attribution set stubbed to `tags`.
const captureAttributions = async (tags: string[] | null): Promise<string[] | undefined> => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const schemes = new SchemeRegistry();
        if (tags !== null) schemes.attributions = () => [...tags]; // stand in for the discovered set
        const engine = new Engine({ db, schemes });

        const provider = new Mock({ contextWindow: 100000, responses: [turn(sendDone)] });
        let captured: string[] | undefined;
        let seen = false;
        const real = provider.generate.bind(provider);
        // Mock's generate() param type is narrower than the Provider interface (no
        // attributions field), but the engine passes it at runtime — read it through a cast.
        provider.generate = (req) => { captured = (req as { attributions?: string[] }).attributions; seen = true; return real(req); };

        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.ok(seen, "generate() was called");
        return captured;
    } finally { await db.close(); }
};

test("discovered attribution tags are unioned, deduped, sorted, and passed to generate()", async () => {
    // Duplicate across the set + out of order — the wire must be a clean, stable, deduped list.
    const captured = await captureAttributions(["npm:jane", "@acme/widgets", "npm:jane"]);
    assert.deepEqual(captured, ["@acme/widgets", "npm:jane"], "deduped + sorted union reaches the provider");
});

test("no discovered attribution omits the provider wire field", async () => {
    const captured = await captureAttributions(null);
    assert.equal(captured, undefined, "a workspace with no attributing plugins sends no attributions field");
});

test("the loop stores its discovered plugin attribution tags", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-attr-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const schemes = new SchemeRegistry();
        schemes.attributions = () => ["npm:jane", "@acme/widgets"]; // the active plugins' declared tags
        const engine = new Engine({ db, schemes });
        const provider = new Mock({ contextWindow: 100000, responses: [turn(sendDone)] });

        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const row = await db.test_loops_get_attributions.get<{ attributions: string }>({ loop_id: loopId });
        assert.deepEqual(JSON.parse(row!.attributions), ["@acme/widgets", "npm:jane"], "the activity is tagged with its plugins' tags, deduped + sorted");
    } finally { await db.close(); }
});
