// End-to-end: a fat prompt over PLURNK_PROMPT_PREVIEW_CHARS renders as the pointer PLACEHOLDER in
// the built packet's Active User Prompts section (no inlined body) — while the full body stays intact
// at its plurnk://prompt/<loop>/<seq> entry. The cap is model-context (what replays each turn); the
// database entry is never truncated (the full body is always recoverable by READ/OPEN).

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("[prompt-preview] a fat prompt renders capped in the packet but stays whole at its entry", async () => {
    const prev = process.env.PLURNK_PROMPT_PREVIEW_CHARS;
    process.env.PLURNK_PROMPT_PREVIEW_CHARS = "50";
    const db = await openMigrated();
    try {
        const fullPrompt = "DESCRIBE ".repeat(40); // 360 chars, well over the 50-char cap
        const sessionId = await insertSession(db, `prompt-preview-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, fullPrompt);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });

        const { turnId } = await engine.runTurn({
            provider, sessionId, runId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: fullPrompt }],
        });

        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
        const userPrompt = packetSection(JSON.parse(row!.packet), "prompt");

        assert.ok(userPrompt.length < fullPrompt.length, "the rendered prompt is capped below the full body");
        assert.doesNotMatch(userPrompt, /DESCRIBE DESCRIBE/, "the over-cap body is NOT inlined");
        assert.match(userPrompt, /^\[ Prompt exceeds preview limit\. Full content: plurnk:\/\/prompt\/\d+\/\d+ \]$/, "the over-cap prompt renders the pointer placeholder");

        // The database entry is NEVER truncated — the full body is recoverable by READ.
        const entry = await (db.drain_get_latest_prompt_body_for_loop as PrepMethod).get<{ content: string }>({ pattern: `/prompt/${loopId}/%` });
        assert.equal(entry!.content, fullPrompt, "the prompt entry retains the full, untruncated body");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_PROMPT_PREVIEW_CHARS; else process.env.PLURNK_PROMPT_PREVIEW_CHARS = prev;
    }
});
