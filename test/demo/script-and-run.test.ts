// Storyline demo: write a small script, then run it, then report what
// came out. This is the canonical "create artifact + execute it"
// workflow — common across real assistant interactions.
//
// User-facing prompt is natural: no `EDIT(...)`, no `EXEC[sh]`, no
// mention of `exec://` or file conventions. Pure intent.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile as readPath } from "node:fs/promises";
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

const SYSTEM_PROMPT = await readPath(PATHS.instructionsSystem, "utf8");

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

test("demo: 'write a script that greets me and run it' — script lands in workspace, runs, model reports the greeting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-demo-script-"));
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        attachYolo(engine, db);
        const sessionId = await insertSession(db, `demo-script-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: workspace });
        const runId = await insertRun(db, sessionId);
        // Specific marker the script must print so we can verify the
        // model actually ran what it created (vs. hallucinating the
        // output). Natural conversational phrasing — no syntax hints.
        const marker = "DEMO-GREETING-9F3A";
        const userPrompt = `Write a tiny bash script that prints the line "${marker}" and run it. Tell me what it printed.`;
        const loopId = await insertLoop(db, runId, 1, userPrompt);
        await (db.engine_set_loop_flags as PrepMethod).run({
            loop_id: loopId, flags: JSON.stringify({ yolo: true }),
        });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
        });
        await exec.idle();

        if (result.finalStatus !== 200) {
            for (const turnId of result.turnIds) {
                const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
            }
        }

        // Outcome assertions:
        //   1. The script file the model wrote lives in the workspace.
        const files = await readdir(workspace).catch(() => [] as string[]);
        const scriptFile = files.find((f) => /\.sh$/.test(f));
        assert.ok(scriptFile, `a *.sh file was created in the workspace; got: ${files.join(", ")}`);

        //   2. That script, when read, contains the marker the user asked for.
        const scriptContent = await readFile(join(workspace, scriptFile!), "utf8");
        assert.match(scriptContent, new RegExp(marker), "script body contains the marker");

        //   3. The model's final SEND[200] reports the marker it observed
        //      from running the script (i.e. the model actually executed it
        //      and read its own output, not hallucinated).
        assert.equal(result.finalStatus, 200, "loop terminated cleanly");
        const lastTurnId = result.turnIds[result.turnIds.length - 1];
        const lastContent = lastTurnId !== undefined ? await lastTurnContent(db, lastTurnId) : "";
        assert.match(lastContent, new RegExp(marker),
            `final reply contains the marker the script printed; got: ${lastContent.slice(0, 200)}`);
    } finally {
        await db.close();
        await rm(workspace, { recursive: true, force: true });
    }
});
