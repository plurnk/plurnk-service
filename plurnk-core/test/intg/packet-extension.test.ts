import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import PacketWire from "../../src/core/packet-wire.ts";
import type { StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_db.ts";
import { packetSection } from "./_packet.ts";

// Extension packet control: a trusted scheme rewrites the engine's default section
// list through transformSections — the in-process seam that lets a third-party
// extension add / remove / reorder packet sections without forking the engine. The
// client wire never reaches the packet; this does.
test("extension packet control: a scheme adds, removes, and reorders packet sections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-extension-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const schemes = new SchemeRegistry();
        const inspected: PacketSectionDraft[][] = [];
        // A third-party extension: prepend its own section, drop the kernel's budget.
        schemes.register("demo", {
            manifest: {
                name: "demo",
                channels: {},
                defaultChannel: "",
                category: "control",
                writableBy: [],
                volatile: false,
                modelVisible: false,
            },
            transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] {
                inspected.push(structuredClone(sections));
                return [
                    { name: "demo", slot: "user", header: "Demo Extension", content: "hello from the extension" },
                    ...sections.filter((s) => s.name !== "budget"),
                ];
            },
        });
        const engine = new Engine({ db, schemes });
        // {§emission-history}: the transform receives each turn's operations before their results.
        const programs = [
            `${PlurnkParser.frame("EDIT (worker:///memo.md)", "Kept whole.")}\n\n${PlurnkParser.frame("NOTE", "Wrote the memo.")}`,
            `${PlurnkParser.frame("READ (worker:///memo.md)", null)}\n\n${PlurnkParser.frame("NOTE", "Read it back.")}`,
            PlurnkParser.frame("SEND [200]", "Done."),
        ];
        const provider = new Mock({ contextWindow: 100000, responses: programs.map((content) => ({ assistant: { content, reasoning: null } })) });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);

        // ADD: the extension's section is in the packet, carrying its content.
        assert.equal(packetSection(packet, "demo"), "hello from the extension");
        const demo = (packet.sections as StoredPacketSection[]).find((section) => section.name === "demo");
        assert.ok(demo !== undefined);
        assert.equal(demo.weight, contentWeight(PacketWire.renderSection(demo)), "core assigns the durable render-weight");
        // REMOVE: the kernel's budget section is gone.
        assert.equal(packetSection(packet, "budget"), "");
        // REORDER: the extension's section leads the user slot.
        const userOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "user").map((s) => s.name);
        assert.equal(userOrder[0], "demo", "extension section leads the user slot");
        assert.ok(!userOrder.includes("budget"), "budget removed from the user slot");
        for (let turn = 0; turn < 2; turn++) await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const chronological = inspected.find((sections) => sections.filter(({ slot }) => slot === "assistant").length === 2);
        assert.ok(chronological, "the transform receives the complete interpolated history");
        const expected = programs.slice(0, 2);
        assert.deepEqual(chronological.filter(({ slot }) => slot === "assistant").map(({ content }) => content), expected);
        for (const [index, section] of chronological.entries()) {
            if (section.slot !== "assistant") continue;
            const receipt: PacketSectionDraft = chronological[index + 1]!;
            assert.equal(receipt.slot, "user");
            assert.match(receipt.content, /^### log:\/\/\/\d+\/\d+\/\d+\/(?:EDIT|READ) · \d+/u, "every turn is followed by its receipts");
        }
        assert.equal(provider.received.length, 3);
        const last = provider.received[2]!;
        assert.deepEqual(last.filter(({ role }) => role === "assistant").map(chatMessageText), expected);
        assert.match(chatMessageText(last[3]!), /^### log:\/\/\/1\/2\/\d+\/EDIT/u, "transformed packets retain the chronological result boundary");
        assert.doesNotMatch(last.map(chatMessageText).join("\n"), /## Context\n/u, "the transform still removes the requested section");
    } finally { await db.close(); }
});

test("extension packet control: duplicate section names fail at the owning scheme boundary", async () => {
    const schemes = new SchemeRegistry();
    schemes.register("broken", {
        manifest: {
            name: "broken",
            channels: {},
            defaultChannel: "",
            category: "control",
            writableBy: [],
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
