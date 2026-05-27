// Shared scaffolding for demo tests. Each demo is a natural prompt that
// exercises a model+grammar+sysprompt outcome; setup is identical across
// scenarios.

import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

export interface DemoRun {
    db: Db;
    sessionId: number;
    runId: number;
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    lastContent: string;
    lastTurnContent: (turnId: number) => Promise<string>;
}

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; demo tests require a configured model alias");
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const turnContent = async (db: Db, turnId: number): Promise<string> => {
    const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

// Run a demo end-to-end against the configured live provider. Returns
// the bits each demo asserts on plus the db handle the test owns.
// Caller must `await run.db.close()` in finally.
export const runDemo = async (opts: { prompt: string; label: string; maxTurns?: number }): Promise<DemoRun> => {
    const provider = await buildProvider();
    const db = await openMigrated();
    const sessionId = await insertSession(db, `demo-${opts.label}-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, opts.prompt);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: await makeMimetypes(provider) });
    const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");

    const result = await engine.runLoop({
        provider, sessionId, runId, loopId, maxTurns: opts.maxTurns ?? 6,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: opts.prompt },
        ],
    });

    const lastTurnId = result.turnIds[result.turnIds.length - 1];
    const lastContent = lastTurnId !== undefined ? await turnContent(db, lastTurnId) : "";

    return {
        db, sessionId, runId, loopId,
        turnIds: result.turnIds,
        finalStatus: result.finalStatus,
        hitMaxTurns: result.hitMaxTurns,
        lastContent,
        lastTurnContent: (turnId) => turnContent(db, turnId),
    };
};
