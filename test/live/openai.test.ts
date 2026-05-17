import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "@plurnk/plurnk-providers-openai";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

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

const SYSTEM_PROMPT = `You are a plurnk agent. You communicate exclusively via the plurnk DSL.

Plurnk operations have the form: <<OP[signal]?(path)?:body:OP

The four operations you'll use today:
- <<EDIT(known://path/to/topic):body:EDIT — store knowledge at a path.
- <<READ(known://path/to/topic)::READ — retrieve previously stored knowledge.
- <<SEND[102]:internal thought:SEND — continue working (more turns expected).
- <<SEND[200]:final answer to user:SEND — terminal response to the user.

Every response MUST end with exactly one SEND statement. Status 200 ends the loop; status 102 continues.

Example response:
<<EDIT(known://france/capital):The capital of France is Paris.:EDIT
<<SEND[200]:The capital of France is Paris.:SEND`;

test("live OpenAI: runTurn against macher produces a valid turn end-to-end", async () => {
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
        const turn = db.prepare("SELECT id, status, packet FROM turns WHERE id = ?").get(result.turnId) as { id: number; status: number; packet: string };
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
