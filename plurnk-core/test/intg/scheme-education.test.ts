// {§schemes-directory} A real stored packet keeps language teaching separate
// from the terse installed-scheme directory and its pull documentation.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("scheme directory: the packet's `schemes` section is a terse directory below tools; the catalogue left the definition", async () => {
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
                writableBy: ["model"],
                volatile: false,
                modelVisible: true,
                glyph: "GLYPH_MUST_STAY_CLIENT_SIDE",
                example: "<<READ(glyph-test:///example)::READ",
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

        // The definition is JUST plurnk.md now — the catalogue left the hot path.
        assert.match(definition, /PLURNK_MD/, "definition carries the operator's plurnk.md");
        assert.doesNotMatch(definition, /worker:\/\/\//, "the scheme catalogue is NOT in the definition anymore");

        // The `schemes` section is the terse directory: worker's canonical example, no inline doc-link.
        assert.ok(schemes.startsWith("```plurnk"), "the schemes directory is a fenced plurnk catalog, not bullets");
        assert.match(schemes, /<<EDIT\(worker:\/\/\/notes\.md\)/, "the directory lists `worker` with its canonical example one-liner");
        assert.doesNotMatch(schemes, /\(docs:/, "no inline doc-link — docs are discovered through worker://plurnk/docs/**");
        assert.doesNotMatch(schemes, /Channels: |Writable by: /, "the verbose channel/writableBy prose is gone from the hot path");
        assert.match(schemes, /glyph-test:\/\/\/example/, "the scheme's ordinary example remains teachable");
        assert.doesNotMatch(schemes, /GLYPH_MUST_STAY_CLIENT_SIDE/, "client display metadata never enters model teaching");

        // Order: the static prefix is definition → tools → schemes (tools sits right below the grammar).
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.deepEqual(sysOrder.slice(0, 3), ["definition", "tools", "schemes"], "tools sits right below the grammar; the scheme directory follows");
    } finally {
        await db.close();
    }
});
