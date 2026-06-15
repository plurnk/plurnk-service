import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { ChatMessage } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

// A Mock that records the grammar handed to generate() — the one thing #189
// plumbs that the stock Mock drops (it destructures only `signal`).
class GrammarCapturingMock extends Mock {
    lastGrammar: string | undefined = undefined;
    async generate(args: { messages: ChatMessage[]; signal?: AbortSignal; grammar?: string }) {
        this.lastGrammar = args.grammar;
        return super.generate(args);
    }
}

const runOneTurn = async (mock: Mock, name: string): Promise<void> => {
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name });
            await rpcCall(ws, 2, "loop.run", { prompt: "x" });
        } finally { ws.close(); }
    });
};

// PLURNK_PROVIDERS_GBNF SELECTS the GBNF variant (#189/#225): a variant name
// resolves to that grammar and reaches the provider verbatim; 0/empty → nothing
// does. The service resolves + plumbs it; the provider applies-or-drops per backend.
test("PLURNK_PROVIDERS_GBNF gates whether the plurnk grammar reaches generate() (#189)", async () => {
    const dsl = "<<SEND[200]:ok:SEND";
    const orig = process.env.PLURNK_PROVIDERS_GBNF;
    try {
        process.env.PLURNK_PROVIDERS_GBNF = "plurnk-strict.gbnf";
        const on = new GrammarCapturingMock({ contextSize: 8192, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(on, "gbnf-on");
        assert.ok(on.lastGrammar?.includes("root ::="), "a variant name → that grammar reaches the provider");

        process.env.PLURNK_PROVIDERS_GBNF = "0";
        const off = new GrammarCapturingMock({ contextSize: 8192, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(off, "gbnf-off");
        assert.equal(off.lastGrammar, undefined, "disabled → no grammar reaches the provider");
    } finally {
        if (orig === undefined) delete process.env.PLURNK_PROVIDERS_GBNF;
        else process.env.PLURNK_PROVIDERS_GBNF = orig;
    }
});
