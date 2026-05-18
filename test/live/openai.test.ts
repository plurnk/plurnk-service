import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import MimetypeRegistry from "../../src/core/MimetypeRegistry.ts";
import TextMarkdown from "@plurnk/plurnk-mimetypes-text-markdown";
import type { PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

// Tests that bypass Daemon (constructing Engine directly) miss the plugin
// discovery scan; register text/markdown explicitly here so the index
// renderer uses TextMarkdown.preview instead of falling back to verbatim.
const makeMimetypes = (): MimetypeRegistry => {
    const r = new MimetypeRegistry();
    r.register(new TextMarkdown());
    return r;
};

const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) {
        throw new Error(
            "PLURNK_MODEL not set. Live tests require a configured model alias:\n" +
            "  PLURNK_MODEL_<alias>=<provider>/<model>\n" +
            "  PLURNK_MODEL=<alias>\n" +
            "Plus provider-specific env (OPENAI_BASE_URL etc).",
        );
    }
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null despite resolveActiveAlias succeeding");
    return provider;
};

test("live OpenAI: runLoop multi-turn against macher — model drives loop to terminal", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `live-loop-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "Build up knowledge across turns then compare");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

        const userPrompt = "Compare the populations of Paris and Tokyo. Approach: this turn, EDIT known://city/paris/population with Paris's approximate population. Then SEND[102] continuing. On the next turn, EDIT known://city/tokyo/population. Then SEND[102]. On a final turn, READ both, then SEND[200] with a one-sentence comparison.";

        const start = Date.now();
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 6,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
        });
        const elapsed = Date.now() - start;

        console.log(`\n=== multi-turn run (${result.turnIds.length} turns, final ${result.finalStatus}, ${elapsed}ms wall) ===`);
        for (const [i, turnId] of result.turnIds.entries()) {
            const turn = await (db.test_get_turn as PrepMethod).get<{ status: number; packet: string; usage_completion: number }>({ id: turnId });
            const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string; reasoning: string | null } };
            console.log(`\n--- turn ${i + 1} (status ${turn?.status}, ${turn?.usage_completion} tokens, ${packet.assistant.reasoning?.length ?? 0} reasoning chars) ---`);
            console.log(packet.assistant.content);
        }

        const entries = await (db.test_parser_pathnames as PrepMethod).all<{ pathname: string }>();
        console.log("\n=== entries written ===");
        for (const e of entries) console.log(`  known://${e.pathname}`);

        assert.ok(result.turnIds.length >= 1, "at least one turn ran");
        assert.ok([200, 499].includes(result.finalStatus), "loop terminated cleanly");
    } finally { await db.close(); }
});

test("live OpenAI: runTurn single-shot smoke", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `live-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "What is the capital of France?");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });

        const result = await engine.runTurn({
            provider,
            sessionId, runId, loopId,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: "What is the capital of France? Store the answer under known://france/capital and reply with a single SEND[200] message containing the answer." },
            ],
        });

        console.log("turn status:", result.status);
        console.log("op statuses:", result.statuses);

        const turn = await (db.test_get_turn as PrepMethod).get<{ id: number; loop_id: number; sequence: number; status: number; usage_completion: number; packet: string }>({ id: result.turnId });
        const packetPreview = JSON.parse(turn?.packet ?? "{}") as { assistant: { reasoning: string | null; content: string } };
        console.log("system prompt tokens (approx chars/4):", Math.ceil(SYSTEM_PROMPT.length / 4));
        console.log("completion tokens (from provider):", turn?.usage_completion);
        console.log("reasoning length (chars):", packetPreview.assistant.reasoning?.length ?? 0);
        console.log("content length (chars):", packetPreview.assistant.content.length);
        assert.ok((turn?.id ?? 0) >= 1, "turn row should exist");
        assert.ok((turn?.status ?? 0) >= 100 && (turn?.status ?? 0) <= 599, "turn status in HTTP range");

        const logCount = (await (db.test_count_log_entries_by_turn as PrepMethod).get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.ok((logCount ?? 0) > 0, "at least one op was dispatched");

        const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string; ops: unknown[] }; system: { system_definition: string }; user: { prompt: string } };
        assert.ok(packet.assistant.content.length > 0, "model emitted non-empty content");
        assert.equal(packet.assistant.ops.length, result.statuses.length, "ops count matches dispatched statuses");
        assert.equal(packet.system.system_definition, SYSTEM_PROMPT);

        console.log("---\nmodel emitted:");
        console.log(packet.assistant.content);
        console.log("---\nentries written:");
        const entries = await (db.test_parser_entries_first as PrepMethod).all<{ scheme: string; pathname: string }>();
        for (const e of entries) console.log(`  ${e.scheme}://${e.pathname}`);
    } finally { await db.close(); }
});
