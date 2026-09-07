import assert from "node:assert/strict";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace, seedEntry } from "../_live-harness.ts";

test("{§bare-inference} live: delegate two isolated questions and consume their answers", async (t) => {
    const s = await liveWorkspace({ name: `live-bare-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "country-question.md", content: "What is the capital of France?" });
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, {
            prompt: "Use two separate BARE calls: give one worker:///country-question.md as its prompt resource, and ask the other for the capital of Germany using an inline prompt. Then report both answers.",
            maxTurns: 6,
        }, { signal: t.signal });

        assert.equal(finalStatus, 200, "the parent concludes after receiving both inference results");
        assert.match(lastContent, /\bBerlin\b/i, "the conclusion includes the German capital");
        assert.match(lastContent, /\bParis\b/i, "the conclusion includes the French capital");

        const calls = (await Promise.all(turnIds.map((turnId) =>
            s.db.test_model_calls.all<{ kind: string; state: string; log_entry_id: number | null }>({ turn_id: turnId }),
        ))).flat().filter(({ kind }) => kind === "bare");
        assert.equal(calls.length, 2, "two actual isolated provider calls served the requested delegation");
        assert.ok(calls.every(({ state }) => state === "response"), "both BARE calls returned provider responses");
        assert.ok(calls.every(({ log_entry_id }) => log_entry_id !== null), "both responses have ordinary durable log receipts");
        const rows = (await Promise.all(turnIds.map((turnId) =>
            s.db.test_log_entries_by_turn.all<{ op: string | null; pathname: string | null }>({ turn_id: turnId }),
        ))).flat();
        assert.ok(rows.some(({ op, pathname }) => op === "BARE" && pathname?.endsWith("country-question.md")), "a BARE actually used the prompt resource");
    } finally {
        await s.cleanup();
    }
});
