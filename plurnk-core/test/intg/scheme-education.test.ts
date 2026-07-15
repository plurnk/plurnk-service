// Scheme directory (grammar#239 item 7 + the docs-catalog work). grammar 0.49+
// teaches grammar/dialects only — NOT the scheme set — so the service advertises
// what schemes exist at packet-time. The verbose per-scheme prose moved OUT of the
// hot path into pull docs (plurnk://docs/<name>.md); the packet's `schemes` section
// (its own section below tools — definition is now plurnk.md only) carries a terse
// directory: each scheme's canonical `example` one-liner, no inline doc-link (docs are
// FIND(plurnk://docs/**)-discovered, #270), mirroring the exec tools sheet. This pins that
// shape on a real model turn's stored packet.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("[§schemes-directory] scheme directory: the packet's `schemes` section is a terse directory below tools; the catalogue left the definition", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `scheme-edu-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });

        const { turnId } = await engine.runTurn({
            provider, sessionId, runId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId }))!.packet);
        const definition = packetSection(packet, "definition");
        const schemes = packetSection(packet, "schemes");

        // The definition is JUST plurnk.md now — the catalogue left the hot path.
        assert.match(definition, /PLURNK_MD/, "definition carries the operator's plurnk.md");
        assert.doesNotMatch(definition, /known:\/\/\//, "the scheme catalogue is NOT in the definition anymore");

        // The `schemes` section is the terse directory: known's canonical example, no inline doc-link.
        assert.ok(schemes.startsWith("```plurnk"), "the schemes directory is a fenced plurnk catalog (#436), not bullets");
        assert.match(schemes, /<<EDIT\(known:\/\/\/plan\.md\)/, "the directory lists `known` with its canonical example one-liner");
        assert.doesNotMatch(schemes, /\(docs:/, "no inline doc-link — docs are FIND(plurnk://docs/**)-discovered (#270)");
        assert.doesNotMatch(schemes, /Channels: |Writable by: /, "the verbose channel/writableBy prose is gone from the hot path");

        // Order: the static prefix is definition → tools → schemes (tools sits right below the grammar).
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.deepEqual(sysOrder.slice(0, 3), ["definition", "tools", "schemes"], "tools sits right below the grammar; the scheme directory follows");
    } finally {
        await db.close();
    }
});
