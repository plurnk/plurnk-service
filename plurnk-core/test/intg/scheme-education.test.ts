// {§schemes-directory} Resource orientation uses ordinary discoverable references.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("{§schemes-directory}: stored packets carry language and policy without an injected resource catalogue", async () => {
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
                documentation: "# Glyph test\n\n## Summary\n\nDiscover glyph-test resources.\n\n### READ0 (glyph-test:///example)",
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
        assert.match(definition, /PLURNK_MD/, "definition carries the operator's plurnk.md");
        const system = packet.sections.filter((section: { slot: string }) => section.slot === "system");
        assert.deepEqual(system.map((section: { name: string }) => section.name), ["definition", "system-policy"]);
        assert.doesNotMatch(JSON.stringify(system), /glyph-test|GLYPH_MUST_STAY_CLIENT_SIDE/, "neither references nor client glyphs are injected");
        const reference = (await engine.referenceEntries(workspaceId, workerId))
            .find(({ pathname }) => pathname === "/_plurnk/plurnk/glyph-test.md");
        assert.match(reference?.content ?? "", /### READ0 \(glyph-test:\/\/\/example\)/, "the example remains available in its pull reference without a separate manifest example");
    } finally {
        await db.close();
    }
});
