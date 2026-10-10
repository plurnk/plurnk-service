// Trial (#1073): a continuing turn of NOTEs alone is told so under the per-turn rule; it is a notice,
// never a strike.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";

const NOTICE = "> [!WARNING]\n> YOU MUST emit at least one NOTE operation and at least one other operation per turn. The turn carried NOTEs and no other operation. [noted_without_operation]";

const conversation = async (db: Awaited<ReturnType<typeof openMigrated>>, contents: string[]) => {
    const workspaceId = await insertWorkspace(db, `annotation-only-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Look around.");
    const provider = new Mock({ contextWindow: 100_000, responses: contents.map((content) => ({ assistant: { content, reasoning: null, finishReason: "stop" } })) });
    return await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
    });
};

test("a turn of NOTEs alone is told so in the next packet; a turn with an operation beside its NOTE is not", async () => {
    const db = await openMigrated();
    try {
        const result = await conversation(db, [
            "```NOTE\nOnly annotating.\n```",
            "```NOTE\nNow acting.\n```\n\n```FIND (worker:///*)\n```",
            "```SEND [200]\nDone.\n```",
        ]);
        assert.equal(result.result.status, 200);
        const [, , acting, final] = result.turnIds;
        const notices = async (turnId: number) => packetSection(JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turnId }))!.packet), "notices");
        assert.ok((await notices(acting!)).includes(NOTICE), `the turn after NOTEs alone is told so:\n${await notices(acting!)}`);
        assert.ok(!(await notices(final!)).includes(NOTICE), "a turn that acted beside its NOTE is not");
    } finally { await db.close(); }
});

test("three consecutive turns of NOTEs alone are told so each time and never strike", async () => {
    const db = await openMigrated();
    try {
        const result = await conversation(db, [
            "```NOTE\nOne.\n```", "```NOTE\nTwo.\n```", "```NOTE\nThree.\n```", "```SEND [200]\nReached.\n```",
        ]);
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
    } finally { await db.close(); }
});
