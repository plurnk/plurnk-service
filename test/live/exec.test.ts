// Live exec end-to-end against the configured PLURNK_MODEL.
// Structural prompt — instructs the model exactly which ops to emit so
// the test exercises plumbing (proposal → applyResolution → spawn →
// channel growth → wake-on-completion) rather than model reasoning.

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

test("live exec: model emits EDIT(exec://x) and the spawn captures stdout end-to-end", async () => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        attachYolo(engine, db);

        const sessionId = await insertSession(db, `live-exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "Run echo and report");
        await (db.engine_set_loop_flags as PrepMethod).run({
            loop_id: loopId, flags: JSON.stringify({ yolo: true }),
        });

        const userPrompt = [
            "Two-step probe. Look at the index BEFORE deciding what to emit.",
            "",
            "If exec://probe is NOT in the index yet: emit ONLY",
            "  <<EDIT(exec://probe):echo plurnk-exec-ok:EDIT",
            "",
            "If exec://probe IS already in the index (look for it under # Plurnk System Index — it will have a stdout channel): emit ONLY",
            "  <<SEND[200]:saw plurnk-exec-ok:SEND",
            "",
            "Do NOT emit the EDIT again once exec://probe exists. Check the index each turn.",
        ].join("\n");

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 8,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
        });
        await exec.idle();

        // Diagnostic: dump turn-by-turn assistant content + the rendered
        // user-section content the model was shown each turn.
        if (result.finalStatus !== 200) {
            for (const turnId of result.turnIds) {
                const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as {
                    assistant?: { content?: string };
                    system?: { index?: object[]; log?: object[] };
                };
                console.error(`--- turn ${turnId} status=${row?.status} ---`);
                console.error("  index count:", packet.system?.index?.length ?? 0);
                console.error("  log count:", packet.system?.log?.length ?? 0);
                console.error("  index:", JSON.stringify(packet.system?.index ?? [], null, 2).slice(0, 600));
                console.error("  log:", JSON.stringify(packet.system?.log ?? [], null, 2).slice(0, 600));
                console.error("  assistant:", (packet.assistant?.content ?? "").slice(0, 400));
            }
        }

        assert.equal(result.finalStatus, 200, "loop terminated on SEND[200]");
        assert.equal(result.hitMaxTurns, false, "didn't hit the safety cap");

        // Channel content reflects the captured output.
        const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "probe",
        });
        assert.ok(entryRow, "exec://probe entry exists");
        const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.state, "closed");
        assert.match(stdout?.content ?? "", /plurnk-exec-ok/, "stdout captured the probe string");

        // Subscription closed cleanly.
        const sub = await (db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200);
    } finally { await db.close(); }
});
