import assert from "node:assert/strict";
import test from "node:test";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

for (const partial of [false, true]) {
    test(`{§emission-history} {§log-kill-scope}: ${partial ? "trimming" : "retiring"} a NOTE never resurrects its complete body in replay`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "note-curation");
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Retain the useful finding.");
        const first = PlurnkParser.frame("NOTE", "Obsolete line.\nStill useful.");
        const second = PlurnkParser.frame("NOTE", "Another finding.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            `${first}\n\n${second}`,
            PlurnkParser.frame(`KILL (log:///1/2/3/NOTE)${partial ? " <1>" : ""}`, null),
            PlurnkParser.frame("SEND [200]", "Done."),
        ].map((content) => ({ assistant: { content, reasoning: null } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(result.result.status, 200);
        const before = provider.received[1]!;
        assert.deepEqual(before.filter(({ role }) => role === "assistant").map(chatMessageText), [`${first}\n\n${second}`], "the turn's NOTEs replay together");
        const after = provider.received[2]!;
        assert.deepEqual(after.filter(({ role }) => role === "assistant").map(chatMessageText), [second]);
        const user = after.filter(({ role }) => role === "user").map(chatMessageText).join("\n");
        assert.doesNotMatch(user, /Obsolete line\./u);
        assert.match(user, /### log:\/\/\/1\/2\/4\/NOTE · \d+/u, "the other NOTE retains its own curation handle");
        if (partial) {
            assert.match(user, /### log:\/\/\/1\/2\/3\/NOTE[^\n]*\n[^\n]*\n2:Still useful\./u);
        } else {
            assert.doesNotMatch(user, /### log:\/\/\/1\/2\/3\/NOTE|Still useful\./u);
        }
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source!.content, `${first}\n\n${second}`, "curation never rewrites source evidence");
    });
}
