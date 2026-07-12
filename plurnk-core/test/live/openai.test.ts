// Live OpenAI-surface coverage: a multi-turn loop the model drives to terminal,
// and a single-shot store-and-reply. Both run through the REAL prod loop (loop.run
// via the daemon — liveSession + liveLoop), so they exercise the path production
// runs, not a hand-built engine. Packet-shape invariants (definition leads with the
// sysprompt, ops==statuses) are asserted deterministically in the intg tier
// (packet-assembled, scheme-education); here we assert the LIVE outcome — the model
// drives the loop to a clean terminal and the right entries land in the db.

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop, seedEntry } from "../_live-harness.ts";

test("live OpenAI: a multi-turn loop consumes a fold-back result and concludes with it", async () => {
    const s = await liveSession({ name: `live-loop-${crypto.randomUUID()}` });
    try {
        // The multi-turn mechanics test, epistemically airtight: a RANDOM secret the model cannot
        // know or infer from the packet, retrievable only by READ — whose result folds back on the
        // NEXT turn (under rails the grammar itself makes a same-turn conclude unsampleable after a
        // retrieval). So a correct conclusion PROVES the loop: turn N retrieves, turn N+1 consumes.
        // One natural sentence, no ops spelled, no turn choreography (the contract-tier doctrine).
        const secret = crypto.randomUUID().slice(0, 8);
        await seedEntry(s.db, s.sessionId, { pathname: "vault/code.md", content: `the access code is ${secret}` });
        const userPrompt = "What is the access code stored at known:///vault/code.md? Tell me in one sentence.";
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 6 }, { timeoutMs: 240_000 });

        console.log(`\n=== multi-turn run (${turnIds.length} turns, final ${finalStatus}) ===`);
        for (const [i, turnId] of turnIds.entries()) {
            const turn = await (s.db.test_get_turn as PrepMethod).get<{ status: number; packet: string; usage_completion: number }>({ id: turnId });
            const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string } };
            console.log(`\n--- turn ${i + 1} (status ${turn?.status}, ${turn?.usage_completion} tokens) ---`);
            console.log(packet.assistant.content);
        }

        assert.ok(turnIds.length >= 2, "the fold-back forces the loop: the READ result arrives next packet, so a correct answer needs a second turn");
        assert.ok([200, 499].includes(finalStatus), `loop must terminate cleanly; got ${finalStatus}`);
        assert.ok(lastContent.includes(secret), `the conclusion carries the seeded secret '${secret}' — proof the fold-back was consumed; got: ${lastContent.slice(0, 200)}`);
    } finally { await s.cleanup(); }
});

test("live OpenAI: a single-shot store-and-reply terminates cleanly", async () => {
    const s = await liveSession({ name: `live-smoke-${crypto.randomUUID()}` });
    try {
        const userPrompt = "What is the capital of France? Store the answer under known:///france/capital and reply with a single SEND[200] message containing the answer.";
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 4 }, { timeoutMs: 240_000 });

        assert.ok([200, 499].includes(finalStatus), `single-shot store-and-reply terminates cleanly; got ${finalStatus}`);
        assert.ok(turnIds.length >= 1, "at least one turn ran");
        assert.ok(lastContent.length > 0, "model emitted non-empty content");

        // The answer was stored where the prompt asked. Use the unbounded pathname query —
        // test_parser_entries_first is a LIMIT-1 helper (parser_roundtrip's single-entry world)
        // and against a multi-entry session DB only ever returns the first-inserted doc.
        const pathnames = (await (s.db.test_parser_pathnames as PrepMethod).all<{ pathname: string }>()).map((e) => e.pathname);
        assert.ok(
            pathnames.some((p) => /france|capital/.test(p)),
            `the answer was stored under known:///france/capital; got ${JSON.stringify(pathnames)}`,
        );
    } finally { await s.cleanup(); }
});
