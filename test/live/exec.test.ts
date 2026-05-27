// Live exec — STRUCTURAL prompts allowed here. The model is explicitly
// told to use the EXEC op shape per plurnk.md; we're testing the
// machinery (parser → engine → exec scheme → spawn → channels → wake)
// against a real provider, not the model's tool-discovery ability.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { PrepMethod } from "../../src/core/Db.ts";
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

const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; live tests require a configured model alias");
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

test("live exec: model emits <<EXEC[sh]:command:EXEC and the spawn captures stdout", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        attachYolo(engine, db);

        const userPrompt = [
            "Two-turn probe.",
            "",
            "If you see an `exec://r-...` entry already in the index with stdout containing",
            "`plurnk-exec-live-ok`, emit:",
            "  <<SEND[200]:plurnk-exec-live-ok:SEND",
            "",
            "Otherwise, emit a single EXEC to run `echo plurnk-exec-live-ok` so that the next turn's",
            "index will have the exec entry. Emit ONLY the EXEC, no SEND yet:",
            "  <<EXEC[sh]:echo plurnk-exec-live-ok:EXEC",
            "",
            "Do not repeat the EXEC once you see the exec://r-... entry in the index.",
        ].join("\n");

        const sessionId = await insertSession(db, `live-exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
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

        const dumpTurns = async (): Promise<void> => {
            for (const turnId of result.turnIds) {
                const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
            }
        };
        if (result.finalStatus !== 200) await dumpTurns();
        assert.equal(result.finalStatus, 200);
        assert.equal(result.hitMaxTurns, false);

        // Verify a real exec entry was created and captured the probe string.
        const execEntryCount = (await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: sessionId, scheme: "exec",
        }))?.n ?? 0;
        assert.ok(execEntryCount >= 1, "at least one exec://r-<id> entry was created");

        // Find the exec entry and verify its stdout captured the probe.
        // We don't know the auto-generated id from outside; list session
        // entries to find any exec://r-<id>.
        type EntryListRow = { scheme: string; pathname: string };
        const allEntries = await (db.test_list_entries_by_session_session_pathname as PrepMethod).all<EntryListRow>({ session_id: sessionId });
        const execEntries = allEntries.filter((e) => e.scheme === "exec");
        let foundProbe = false;
        for (const e of execEntries) {
            const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
                scheme: "exec", pathname: e.pathname,
            });
            if (entryRow === undefined) continue;
            const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
                entry_id: entryRow.id, name: "stdout",
            });
            if ((stdout?.content ?? "").includes("plurnk-exec-live-ok")) {
                foundProbe = true;
                assert.equal(stdout?.state, "closed");
                break;
            }
        }
        if (!foundProbe) {
            await dumpTurns();
            for (const e of execEntries) {
                const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
                    scheme: "exec", pathname: e.pathname,
                });
                if (entryRow === undefined) continue;
                const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
                    entry_id: entryRow.id, name: "stdout",
                });
                console.error(`exec://${e.pathname} stdout: state=${stdout?.state} content=${JSON.stringify(stdout?.content)}`);
            }
        }
        assert.ok(foundProbe, "an exec stdout channel captured the probe string");
    } finally { await db.close(); }
});
