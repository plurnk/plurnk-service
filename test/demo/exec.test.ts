// Demo: natural prompt asking the model to run a shell command and
// report what it observed. Outcome assertion (the model produces a
// useful answer that includes the captured output), not op shapes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { attachYolo } from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; demo tests require a configured model alias");
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

const lastTurnContent = async (db: Db, turnId: number): Promise<string> => {
    const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

test("demo: 'run a command and tell me the output' — model uses exec, sees stdout, reports back", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        attachYolo(engine, db);

        const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");
        // Natural-ish: user describes intent, doesn't dictate the ops.
        // Model has to recognize exec:// is the right tool, then read
        // the channel to see what came out.
        const userPrompt = [
            "Run `echo demo-output-marker` and then SEND[200] with the string that was printed to stdout.",
            "",
            "The exec scheme captures shell output: write the command in an EDIT to exec://<some-id>,",
            "and the next turn's index will show the entry with stdout content. Look for the marker there.",
        ].join("\n");

        const sessionId = await insertSession(db, `demo-exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        // loop.prompt is what packet.user.prompt sources from via the
        // per-turn foist (drain+inject paradigm); pass the actual prompt
        // here, not a label.
        const loopId = await insertLoop(db, runId, 1, userPrompt);
        await (db.engine_set_loop_flags as PrepMethod).run({
            loop_id: loopId, flags: JSON.stringify({ yolo: true }),
        });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 8,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
        });
        await exec.idle();

        if (result.finalStatus !== 200 || !(await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: sessionId, scheme: "exec",
        }))?.n) {
            for (const turnId of result.turnIds) {
                const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
            }
        }

        assert.equal(result.finalStatus, 200, "model terminated cleanly");
        assert.equal(result.hitMaxTurns, false);

        const lastTurnId = result.turnIds[result.turnIds.length - 1];
        const lastContent = lastTurnId !== undefined ? await lastTurnContent(db, lastTurnId) : "";
        assert.match(lastContent, /demo-output-marker/,
            `model's final reply should reference the captured stdout; got: ${lastContent.slice(0, 200)}`);

        // Receipt: some exec entry exists (model chooses the pathname
        // since we didn't dictate it). The regex above already proves
        // the model saw the output; this confirms the spawn ran.
        const entryCount = (await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: sessionId, scheme: "exec",
        }))?.n ?? 0;
        assert.ok(entryCount >= 1, `expected ≥1 exec entry, got ${entryCount}`);
    } finally { await db.close(); }
});
