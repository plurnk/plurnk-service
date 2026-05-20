// Demo test. Natural human-style prompt, outcome assertions. Unlike live
// tests (which use structural prompts directing specific machinery), demo
// tests validate that model + sysprompt + grammar together produce useful
// behavior on plain questions. A failure here indicts the model/sysprompt
// trio, not the engine.
//
// SPEC §0.7 test taxonomy. Run via `npm run test:demo`; requires
// PLURNK_MODEL configured per .env.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) {
        throw new Error("PLURNK_MODEL not set. Demo tests require a configured model alias.");
    }
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

test("demo: 'What is the capital of France?' — model produces a useful outcome", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `demo-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "What is the capital of France?");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: await makeMimetypes(provider) });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 5,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: "What is the capital of France?" },
            ],
        });

        // Outcome assertions: what mattered TO THE USER who asked.
        //
        // 1. The loop terminated cleanly. The model didn't get stuck or fail.
        assert.equal(result.finalStatus, 200, "model terminated with SEND[200]");
        assert.equal(result.hitMaxTurns, false, "didn't hit the safety cap");

        // 2. The user got an answer. Last turn's assistant content should
        //    mention Paris (case-insensitive).
        const lastTurnId = result.turnIds[result.turnIds.length - 1];
        const lastTurn = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: lastTurnId });
        const lastPacket = JSON.parse(lastTurn?.packet ?? "{}") as { assistant: { content: string } };
        const content = lastPacket.assistant.content;
        assert.match(content, /paris/i, "model's reply mentions Paris");

        // 3. Diagnostic — log what the model emitted so failures are
        //    investigable. Demo tests are for learning what models do.
        console.log(`\n=== demo: ${result.turnIds.length} turns, status ${result.finalStatus} ===`);
        for (const [i, turnId] of result.turnIds.entries()) {
            const turn = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnId });
            const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string } };
            console.log(`turn ${i + 1}:`);
            console.log(packet.assistant.content);
        }
    } finally { await db.close(); }
});
