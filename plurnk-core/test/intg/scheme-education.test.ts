// {§schemes-directory} A real stored packet keeps language teaching separate
// from the terse installed-resource directory and its pull documentation.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("resource directory: the packet's `schemes` section is a terse directory after policy; the catalogue left the definition", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `scheme-edu-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const registry = new SchemeRegistry();
        registry.register("glyph-test", {
            manifest: {
                name: "glyph-test",
                channels: { body: "text/plain" },
                defaultChannel: "body",
                category: "data",
                entryOwner: "commons",
                inherit: "none",
                writableBy: ["model"],
                volatile: false,
                modelVisible: true,
                glyph: "GLYPH_MUST_STAY_CLIENT_SIDE",
                example: "## READ0 (glyph-test:///example)",
            },
        });
        const engine = new Engine({ db, schemes: registry });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });

        const { turnId } = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        const definition = packetSection(packet, "definition");
        const schemes = packetSection(packet, "schemes");
        assert.equal(packet.sections.find((section: { name: string }) => section.name === "schemes")?.header, "Resources");

        // The definition is JUST plurnk.md now — the catalogue left the hot path.
        assert.match(definition, /PLURNK_MD/, "definition carries the operator's plurnk.md");
        assert.doesNotMatch(definition, /worker:\/\/\//, "the resource catalogue is NOT in the definition anymore");

        // The `schemes` section is the terse directory: worker's canonical example, no inline doc-link.
        assert.ok(schemes.startsWith("```plurnk"), "the resource directory is a fenced plurnk catalogue, not bullets");
        assert.match(schemes, /## EDIT0 \(worker:\/\/\/notes\.md\)\nInvestigation notes\./, "the directory lists `worker` with its canonical example section");
        assert.doesNotMatch(schemes, /\(docs:/, "no inline doc-link — skills are discovered through worker://~/skills/**");
        assert.doesNotMatch(schemes, /Channels: |Writable by: /, "the verbose channel/writableBy prose is gone from the hot path");
        assert.match(schemes, /glyph-test:\/\/\/example/, "the scheme's ordinary example remains teachable");
        assert.doesNotMatch(schemes, /GLYPH_MUST_STAY_CLIENT_SIDE/, "client display metadata never enters model teaching");

        // Stable policy intervenes after definition; the resource directory follows it.
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.equal(sysOrder.includes("tools"), false, "executable discovery does not recreate a hot-path tools section");
        assert.equal(sysOrder.indexOf("schemes"), sysOrder.indexOf("system-policy") + 1, "the resource directory follows privileged policy");
    } finally {
        await db.close();
    }
});
