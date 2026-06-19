// SPEC §tools — the # Plurnk System Tools capability sheet. Render-side
// placement (above Requirements) + omit-when-empty, and the PLAN contributor's
// PLURNK_PLAN gating end-to-end through a built packet.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("[§tools-capability-sheet] # Plurnk System Tools renders above Requirements; omitted when the list is empty", () => {
    // Section list with a parameterized tools body (empty body ⇒ section omitted).
    const userSections = (tools: string) => [
        { name: "prompt", slot: "user", header: "Plurnk System User Prompt", content: "go", tokens: 0 },
        { name: "tools", slot: "user", header: "Plurnk System Tools", content: tools, tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "Conclude with SEND.", tokens: 0 },
    ];
    const withTools = PacketWire.renderSlot(userSections("- `<<PLAN:...:PLAN` — plan first."), "user");
    assert.match(withTools, /# Plurnk System Tools\n\n- `<<PLAN/, "Tools section carries its capability line");
    const toolsIdx = withTools.indexOf("# Plurnk System Tools");
    const reqIdx = withTools.indexOf("# Plurnk System Requirements");
    assert.ok(toolsIdx > -1 && reqIdx > toolsIdx, "Tools renders above Requirements");

    const noTools = PacketWire.renderSlot(userSections(""), "user");
    assert.doesNotMatch(noTools, /# Plurnk System Tools/, "no Tools header when nothing is enabled");
});

test("[§requirements-plan-gated] the plan directive is a REQUIREMENT when PLURNK_PLAN=1 — not in the optional tools sheet", async () => {
    const prev = process.env.PLURNK_PLAN;
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tools-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const reply = () => new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const userOf = async (turnId: number): Promise<{ tools: string; system_requirements: string }> => {
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
            const packet = JSON.parse(row!.packet);
            return { tools: packetSection(packet, "tools"), system_requirements: packetSection(packet, "requirements") };
        };

        process.env.PLURNK_PLAN = "1";
        const on = await engine.runTurn({ provider: reply(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const onUser = await userOf(on.turnId);
        assert.match(onUser.system_requirements, /<<PLAN/, "plan directive is in the requirements when PLURNK_PLAN=1");
        assert.ok(!onUser.tools.includes("<<PLAN"), "plan directive is NOT in the optional tools sheet");

        process.env.PLURNK_PLAN = "0";
        const off = await engine.runTurn({ provider: reply(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(!/<<PLAN/.test((await userOf(off.turnId)).system_requirements), "plan directive absent from requirements when PLURNK_PLAN≠1");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_PLAN; else process.env.PLURNK_PLAN = prev;
        await db.close();
    }
});
