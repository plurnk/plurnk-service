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
import { liveSession, liveLoop } from "../_live-harness.ts";

test("live OpenAI: a multi-turn loop drives paris → tokyo → compare to terminal", async () => {
    const s = await liveSession({ name: `live-loop-${crypto.randomUUID()}` });
    try {
        const userPrompt = "Compare the populations of Paris and Tokyo. Approach: this turn, EDIT known:///city/paris/population with Paris's approximate population. Then SEND[102] continuing. On the next turn, EDIT known:///city/tokyo/population. Then SEND[102]. On a final turn, READ both, then SEND[200] with a one-sentence comparison.";
        const { finalStatus, turnIds } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 6 }, { timeoutMs: 240_000 });

        console.log(`\n=== multi-turn run (${turnIds.length} turns, final ${finalStatus}) ===`);
        for (const [i, turnId] of turnIds.entries()) {
            const turn = await (s.db.test_get_turn as PrepMethod).get<{ status: number; packet: string; usage_completion: number }>({ id: turnId });
            const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string } };
            console.log(`\n--- turn ${i + 1} (status ${turn?.status}, ${turn?.usage_completion} tokens) ---`);
            console.log(packet.assistant.content);
        }

        const entries = await (s.db.test_parser_pathnames as PrepMethod).all<{ pathname: string }>();
        console.log("\n=== entries written ===");
        for (const e of entries) console.log(`  known:///${e.pathname}`);

        // Outcome assertions — not just "the loop terminated cleanly," which silently
        // passed for a loop that wrote `paris` five times and never advanced. The task
        // says: paris pop, then tokyo pop, then a comparison. Both city entries must exist.
        const pathnames = entries.map((e) => e.pathname);
        assert.ok(
            pathnames.some((p) => p.includes("paris")),
            `expected a known:///city/paris/* entry; got ${JSON.stringify(pathnames)}`,
        );
        assert.ok(
            pathnames.some((p) => p.includes("tokyo")),
            `expected a known:///city/tokyo/* entry; got ${JSON.stringify(pathnames)} — model never advanced past turn 1`,
        );
        assert.ok(entries.length >= 2, `expected at least 2 distinct entries (paris, tokyo); got ${entries.length}`);
        assert.ok(turnIds.length >= 2, "multi-turn task needs more than 1 turn");
        assert.ok([200, 499].includes(finalStatus), `loop must terminate cleanly; got ${finalStatus}`);
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
