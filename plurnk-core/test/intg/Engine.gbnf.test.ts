import test from "node:test";
import assert from "node:assert/strict";
import { Mock, resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { ChatMessage } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// A Mock that records the grammar handed to generate().
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
            await rpcCall(ws, 1, "workspace.create", { name });
            await runLoopToTerminal(ws, 2, { prompt: "x" });
        } finally { ws.close(); }
    });
};

// {§grammar-enforcement-verified-at-boot}: configuration selects a grammar
// variant per alias; empty or zero disables it.
test("the active alias's GBNF setting wins over the bare fallback", async () => {
    // The daemon test's active alias (whatever the local .env selects) decides via its suffixed
    // knob. Bare is the fallback: GBNF is optional local constrained sampling, so
    // it is unset by default and a local alias opts in with its suffix.
    const dsl = "## SEND1 [200]\nok";
    // Alias-agnostic: resolve the Mock bootstrap's active alias and set ITS GBNF suffix — never a
    // hardcoded name, so this remains valid if the fixture alias changes. The Mock carries no side-table
    // alias, so #grammarConstraint resolves the knob via resolveActiveAlias.
    const alias = resolveActiveAlias(process.env)?.alias ?? "";
    const suffixKey = `PLURNK_PROVIDERS_GBNF_${alias}`;
    const keys = ["PLURNK_PROVIDERS_GBNF", suffixKey];
    const orig = keys.map((k) => process.env[k]);
    try {
        process.env.PLURNK_PROVIDERS_GBNF = "";  // bare unset
        process.env[suffixKey] = "plurnk.gbnf";  // the active alias opts IN
        // Keep the incidental context window above the configured output reserves
        // so this specimen reaches generation and isolates grammar resolution.
        const on = new GrammarCapturingMock({ contextWindow: 1_000_000, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(on, "gbnf-on");
        assert.ok(on.lastGrammar?.includes("root ::="), "the alias suffix → that grammar reaches the provider despite bare being off");

        process.env[suffixKey] = "0";  // the active alias opts OUT
        const off = new GrammarCapturingMock({ contextWindow: 1_000_000, responses: [makeMockResponse(dsl, 10)] });
        await runOneTurn(off, "gbnf-off");
        assert.equal(off.lastGrammar, undefined, "the alias off → no grammar reaches the provider");
    } finally {
        keys.forEach((k, i) => { if (orig[i] === undefined) delete process.env[k]; else process.env[k] = orig[i]!; });
    }
});
