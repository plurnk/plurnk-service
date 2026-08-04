import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import PacketWire from "../../src/core/packet-wire.ts";
import type { StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// Plugin packet control: a trusted scheme rewrites the engine's default section
// list through transformSections — the in-process seam that lets a third-party
// plugin add / remove / reorder packet sections without forking the engine. The
// client wire never reaches the packet; this does.
test("plugin packet control: a scheme adds, removes, and reorders packet sections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-plugin-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const schemes = new SchemeRegistry();
        // A third-party plugin: prepend its own section, drop the kernel's budget.
        schemes.register("demo", {
            manifest: {
                name: "demo",
                channels: {},
                defaultChannel: "",
                category: "control",
                writableBy: ["plugin"],
                volatile: false,
                modelVisible: false,
            },
            transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] {
                return [
                    { name: "demo", slot: "user", header: "Demo Plugin", content: "hello from the plugin" },
                    ...sections.filter((s) => s.name !== "budget"),
                ];
            },
        });
        const engine = new Engine({ db, schemes });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);

        // ADD: the plugin's section is in the packet, carrying its content.
        assert.equal(packetSection(packet, "demo"), "hello from the plugin");
        const demo = (packet.sections as StoredPacketSection[]).find((section) => section.name === "demo");
        assert.ok(demo !== undefined);
        assert.equal(demo.tokens, rulerCount(PacketWire.renderSection(demo)), "core assigns the durable render-weight");
        // REMOVE: the kernel's budget section is gone.
        assert.equal(packetSection(packet, "budget"), "");
        // REORDER: the plugin's section leads the user slot.
        const userOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "user").map((s) => s.name);
        assert.equal(userOrder[0], "demo", "plugin section leads the user slot");
        assert.ok(!userOrder.includes("budget"), "budget removed from the user slot");
    } finally { await db.close(); }
});

test("plugin packet control: duplicate section names fail at the owning scheme boundary", async () => {
    const schemes = new SchemeRegistry();
    schemes.register("broken", {
        manifest: {
            name: "broken",
            channels: {},
            defaultChannel: "",
            category: "control",
            writableBy: ["plugin"],
            volatile: false,
            modelVisible: false,
        },
        transformSections(): PacketSectionDraft[] {
            return [
                { name: "duplicate", slot: "user", header: null, content: "first" },
                { name: "duplicate", slot: "user", header: null, content: "second" },
            ];
        },
    });

    await assert.rejects(
        schemes.transformSections([]),
        /scheme 'broken' transformSections result has duplicate section name 'duplicate'/,
    );
});
