// Loop start writes plurnk://prompt/<loop_id> as a system-origin EDIT.
// The current loop's prompt entry is FOISTED out of packet.system.index
// render (its content is materialized in packet.user.prompt instead).
// Previous loops' prompt entries stay in the index, addressable by the
// model — they can READ or HIDE them.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Mock from "../../src/providers/Mock.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map() },
    tokenize: async (text) => Math.ceil(text.length / 4),
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "what is the capital of france?");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: makeMimetypes() });
    return { db, engine, sessionId, runId, loopId };
};

test("loop start creates plurnk://prompt/<loop_id> entry as a system-origin EDIT", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [{
                assistant: { content: "", reasoning: null, ops: [] },
                assistantRaw: {},
            }],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const entry = await (db.test_get_entry_by_path as PrepMethod).get<{ id: number }>({
            session_id: sessionId, scheme: "plurnk", pathname: `prompt/${loopId}/1`,
        });
        assert.ok(entry !== undefined, "plurnk://prompt/<loop_id> entry exists");
        const body = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entry.id, name: "body" }))?.content;
        assert.equal(body, "what is the capital of france?");
    } finally { await db.close(); }
});

test("current loop's prompt entry is foisted out of packet.system.index", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [{
                assistant: { content: "", reasoning: null, ops: [] },
                assistantRaw: {},
            }],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            system: { index: Array<{ scheme: string | null; pathname: string }> };
        };
        const promptInIndex = packet.system.index.find((e) => e.scheme === "plurnk" && e.pathname === `prompt/${loopId}`);
        assert.equal(promptInIndex, undefined, "current loop's prompt entry NOT in index render");
    } finally { await db.close(); }
});

test("previous loops' prompt entries stay in packet.system.index", async () => {
    const { db, engine, sessionId, runId, loopId: loop1Id } = await setup();
    try {
        // First loop: writes plurnk://prompt/<loop1Id> entry.
        const provider1 = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [] }, assistantRaw: {} }],
        });
        await engine.runTurn({ provider: provider1, sessionId, runId, loopId: loop1Id, messages: [] });

        // Second loop: writes plurnk://prompt/<loop2Id>. From loop2's
        // perspective, loop1's prompt entry is "previous" and should appear
        // in the index render.
        const loop2Id = await insertLoop(db, runId, 2, "second prompt");
        const provider2 = new Mock({
            contextSize: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [] }, assistantRaw: {} }],
        });
        const result = await engine.runTurn({ provider: provider2, sessionId, runId, loopId: loop2Id, messages: [] });

        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            system: { index: Array<{ scheme: string | null; pathname: string }> };
        };
        // Loop1's prompt entries (any turn slot) should remain in the index
        // when loop2 renders; loop2's own prompt entries are foisted out.
        const loop1InIndex = packet.system.index.find((e) => e.scheme === "plurnk" && e.pathname.startsWith(`prompt/${loop1Id}/`));
        const loop2InIndex = packet.system.index.find((e) => e.scheme === "plurnk" && e.pathname.startsWith(`prompt/${loop2Id}/`));
        assert.ok(loop1InIndex !== undefined, "loop1's prompt is visible to loop2");
        assert.equal(loop2InIndex, undefined, "loop2's own prompt is foisted out");
    } finally { await db.close(); }
});
