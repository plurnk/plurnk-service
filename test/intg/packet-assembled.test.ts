// Assembled-packet regression coverage — the backbone the invisible-catalog bug
// exposed as missing. Isolated render-fn tests (packet-wire.test.ts) green while
// the ASSEMBLED packet shipped a query with no results, because nothing asserted
// the full system+user message a real turn produces. These tests run a real turn
// (Mock provider), read the stored turns.packet, and assert section content —
// catching section-level + assembly regressions the unit tests can't.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel, packetSection, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string }> }> =>
    JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId }))!.packet);

test("[§render-rule-find-renders-result] assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    process.env.PLURNK_MANIFEST_ITEMS = "-1"; // foist the full per-scheme catalog at turn 0
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `pkt-backbone-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what do I have?"); // run's first loop → foist fires (#269)
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(known:///**) renders its RESULT into the
        // log (§render-rule-find-renders-result) — the model SEES the catalog rows, not just
        // its own echoed query. The invisible-catalog bug rendered only `<<FIND(...)::FIND`.
        assert.match(log, /known:\/\/\/note\.md/, "the foisted catalog FIND renders the entry into the packet's log");
        assert.match(log, /"op":"FIND"/, "the catalog foist appears as a FIND op in the log");

        // Section presence + order: system definition → schemes → log; requirements last in user.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system").filter((n) => ["definition", "schemes", "log"].includes(n)), ["definition", "schemes", "log"], "system slot order: definition → schemes → log");
        const usr = slot("user");
        assert.equal(usr[usr.length - 1], "requirements", "requirements lands last in the user slot");
        assert.match(packetSection(packet, "catalog"), /known/, "the catalog tally names the known scheme");
        assert.ok(packetSection(packet, "requirements").length > 0, "requirements section carries content");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});
