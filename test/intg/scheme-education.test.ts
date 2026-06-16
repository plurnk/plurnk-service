// Scheme education (grammar#239 item 7). grammar 0.49+ teaches grammar/dialects
// only — NOT the scheme catalogue — so the service injects SchemeRegistry.teach()
// into the packet's system section at packet-time. This pins that a real model
// turn's stored packet carries the catalogue (the `## Schemes` heading + a known
// scheme) appended AFTER the plurnk.md system definition.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("scheme education: the turn packet's system_definition carries the scheme catalogue after plurnk.md", async () => {
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

        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
        const system_definition = (JSON.parse(row!.packet) as { system: { system_definition: string } }).system.system_definition;

        assert.match(system_definition, /## Schemes/, "system_definition carries the scheme catalogue heading");
        assert.match(system_definition, /### `known:\/\/\//, "the catalogue teaches the `known` scheme");
        assert.match(system_definition, /Channels: .+\(default: .+\)\. Writable by: /, "each scheme summarizes channels + default + who-can-write from its manifest");

        const mdIdx = system_definition.indexOf("PLURNK_MD");
        const schemesIdx = system_definition.indexOf("## Schemes");
        assert.ok(mdIdx > -1 && schemesIdx > mdIdx, "plurnk.md system definition comes first, the catalogue is appended after it");
    } finally {
        await db.close();
    }
});
