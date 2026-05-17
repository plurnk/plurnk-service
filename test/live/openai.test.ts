import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import OpenAI from "@plurnk/plurnk-providers-openai";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYSTEM_PROMPT = await readFile(resolve(PROJECT_ROOT, "instructions-system.md"), "utf8");

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined) {
        throw new Error(
            `${name} is not set. Live tests require the OpenAI cascade configured:\n` +
            `  OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_CONTEXT_SIZE, OPENAI_FETCH_TIMEOUT_MS, OPENAI_THINK\n` +
            `  Copy .env.example to .env, or export the vars in your shell.`,
        );
    }
    return value;
};

const buildProvider = (): OpenAI => new OpenAI({
    baseUrl: requireEnv("OPENAI_BASE_URL"),
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: requireEnv("OPENAI_MODEL"),
    contextSize: Number(requireEnv("OPENAI_CONTEXT_SIZE")),
    fetchTimeoutMs: Number(requireEnv("OPENAI_FETCH_TIMEOUT_MS")),
    think: requireEnv("OPENAI_THINK") === "1",
});

test("live OpenAI: runLoop multi-turn against macher — model drives loop to terminal", async () => {
    const provider = buildProvider();
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, `live-loop-${crypto.randomUUID()}`);
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1, "Build up knowledge across turns then compare");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

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
            const turn = db.prepare("SELECT status, packet, usage_completion FROM turns WHERE id = ?").get(turnId) as { status: number; packet: string; usage_completion: number };
            const packet = JSON.parse(turn.packet) as { assistant: { content: string; reasoning: string | null } };
            console.log(`\n--- turn ${i + 1} (status ${turn.status}, ${turn.usage_completion} tokens, ${packet.assistant.reasoning?.length ?? 0} reasoning chars) ---`);
            console.log(packet.assistant.content);
        }

        const entries = db.prepare("SELECT scheme, pathname FROM entries ORDER BY pathname").all() as { scheme: string; pathname: string }[];
        console.log("\n=== entries written ===");
        for (const e of entries) console.log(`  ${e.scheme}://${e.pathname}`);

        // Loose assertions — model behavior is stochastic. We care about:
        assert.ok(result.turnIds.length >= 1, "at least one turn ran");
        assert.ok([200, 499].includes(result.finalStatus), "loop terminated cleanly");
    } finally { db.close(); }
});

test("live OpenAI: runTurn single-shot smoke", async () => {
    const provider = buildProvider();
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, `live-${crypto.randomUUID()}`);
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1, "What is the capital of France?");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

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

        // Turn was inserted
        const turn = db.prepare("SELECT id, status, packet, usage_completion FROM turns WHERE id = ?").get(result.turnId) as { id: number; status: number; packet: string; usage_completion: number };
        const packetPreview = JSON.parse(turn.packet) as { assistant: { reasoning: string | null; content: string } };
        console.log("system prompt tokens (approx chars/4):", Math.ceil(SYSTEM_PROMPT.length / 4));
        console.log("completion tokens (from provider):", turn.usage_completion);
        console.log("reasoning length (chars):", packetPreview.assistant.reasoning?.length ?? 0);
        console.log("content length (chars):", packetPreview.assistant.content.length);
        assert.ok(turn.id >= 1, "turn row should exist");
        assert.ok(turn.status >= 100 && turn.status <= 599, "turn status in HTTP range");

        // Log entries exist (one per dispatched op)
        const logCount = (db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE turn_id = ?").get(result.turnId) as { n: number }).n;
        assert.ok(logCount > 0, "at least one op was dispatched");

        // Packet contains the assistant content
        const packet = JSON.parse(turn.packet) as { assistant: { content: string; ops: unknown[] }; system: { system_definition: string }; user: { prompt: string } };
        assert.ok(packet.assistant.content.length > 0, "model emitted non-empty content");
        assert.equal(packet.assistant.ops.length, result.statuses.length, "ops count matches dispatched statuses");
        assert.equal(packet.system.system_definition, SYSTEM_PROMPT);

        // Print what the model said for visibility
        console.log("---");
        console.log("model emitted:");
        console.log(packet.assistant.content);
        console.log("---");
        console.log("entries written:");
        const entries = db.prepare("SELECT scheme, pathname FROM entries").all() as { scheme: string; pathname: string }[];
        for (const e of entries) console.log(`  ${e.scheme}://${e.pathname}`);
    } finally { db.close(); }
});
