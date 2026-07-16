import test from "node:test";
import assert from "node:assert/strict";
import { Mock, resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { ChatMessage } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

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
            await runLoopToTerminal(ws, 2, { prompt: "x" });
        } finally { ws.close(); }
    });
};

// PLURNK_PROVIDERS_GBNF SELECTS the GBNF variant (#189/#225): a variant name
// resolves to that grammar and reaches the provider verbatim; 0/empty → nothing
// does. The service resolves + plumbs it; the provider applies-or-drops per backend.
test("[§gbnf-per-alias] PLURNK_PROVIDERS_GBNF is PER ALIAS — the active alias's suffix wins over the bare fallback (#353)", async () => {
    // The daemon test's active alias (whatever the local .env selects) decides via its suffixed
    // knob. Bare is the fallback: GBNF only helps sampling-constraining backends, so it ships OFF
    // by default and each GBNF-capable alias opts in via a PLURNK_PROVIDERS_GBNF_<alias> suffix.
    const dsl = "<<SEND[200]:ok:SEND";
    // Alias-agnostic: resolve whichever alias the test cascade selected (.env.test's PLURNK_MODEL,
    // over .env's alias defs) and set ITS GBNF suffix — never a hardcoded name, so this holds
    // whatever model the operator's .env/​.env.test cascade names. The Mock carries no side-table
    // alias, so #grammarConstraint resolves the knob via resolveActiveAlias.
    const alias = resolveActiveAlias(process.env)?.alias ?? "";
    const suffixKey = `PLURNK_PROVIDERS_GBNF_${alias}`;
    const keys = ["PLURNK_PROVIDERS_GBNF", suffixKey];
    const orig = keys.map((k) => process.env[k]);
    try {
        process.env.PLURNK_PROVIDERS_GBNF = "";  // bare OFF
        process.env[suffixKey] = "plurnk.gbnf";  // the active alias opts IN
        // Window must clear the bundled generation-envelope floor (REASONING+COMPLETION+SAFETY
        // ≈ 66.5k, plurnk-core/.env.defaults). 8192 fell UNDER it, so the budget derivation threw
        // "window partition contradiction" and the turn died before generate — #grammarConstraint
        // never ran, so lastGrammar was undefined regardless of the alias knob (#433). The window
        // is incidental here; this test verifies grammar RESOLUTION, not the small-window envelope.
        const on = new GrammarCapturingMock({ contextSize: 1_000_000, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(on, "gbnf-on");
        assert.ok(on.lastGrammar?.includes("root ::="), "the alias suffix → that grammar reaches the provider despite bare being off");

        process.env[suffixKey] = "0";  // the active alias opts OUT
        const off = new GrammarCapturingMock({ contextSize: 1_000_000, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(off, "gbnf-off");
        assert.equal(off.lastGrammar, undefined, "the alias off → no grammar reaches the provider");
    } finally {
        keys.forEach((k, i) => { if (orig[i] === undefined) delete process.env[k]; else process.env[k] = orig[i]!; });
    }
});
