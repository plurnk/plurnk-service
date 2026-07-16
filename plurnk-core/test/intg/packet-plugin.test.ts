import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { PacketSection } from "../../src/core/packet-wire.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// Plugin packet control: a trusted scheme rewrites the engine's default section
// list through transformSections — the in-process seam that lets a third-party
// plugin add / remove / reorder packet sections without forking the engine. The
// client wire never reaches the packet; this does.
test("[§packet-plugin-transform] plugin packet control: a scheme adds, removes, and reorders packet sections", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `pkt-plugin-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const schemes = new SchemeRegistry();
        // A third-party plugin: prepend its own section, drop the kernel's budget.
        schemes.register("demo", {
            transformSections(sections: PacketSection[]): PacketSection[] {
                return [
                    { name: "demo", slot: "user", header: "Demo Plugin", content: "hello from the plugin", tokens: 0 },
                    ...sections.filter((s) => s.name !== "budget"),
                ];
            },
        });
        const engine = new Engine({ db, schemes });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet);

        // ADD: the plugin's section is in the packet, carrying its content.
        assert.equal(packetSection(packet, "demo"), "hello from the plugin");
        // REMOVE: the kernel's budget section is gone.
        assert.equal(packetSection(packet, "budget"), "");
        // REORDER: the plugin's section leads the user slot.
        const userOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "user").map((s) => s.name);
        assert.equal(userOrder[0], "demo", "plugin section leads the user slot");
        assert.ok(!userOrder.includes("budget"), "budget removed from the user slot");
    } finally { await db.close(); }
});
