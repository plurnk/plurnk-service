import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { contentWeight } from "../../src/core/content-weight.ts";

const frame = PlurnkParser.frame;
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });

test("{§emission-history} {§paired-receipt}: each content operation precedes its result without duplicating its request", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "paired-operations");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Write, inspect, and answer.");
    const edit = frame("EDIT (worker:///memo.txt)", "Unique replacement.");
    const read = frame("READ (worker:///memo.txt) <!-- inspect -->", null);
    const note = frame("NOTE", "An authored memory.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say([edit, read, note].join("\n\n"), frame("NOTE", "Reasoning is not content.")),
        say(frame("SEND [200]", "Done.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    const request = provider.received[1]!;
    assert.deepEqual(request.filter(({ role }) => role === "assistant").map(chatMessageText), [edit, read, note]);
    for (const [index, message] of request.entries()) {
        if (message.role !== "assistant") continue;
        assert.equal(request[index + 1]!.role, "user");
        const receipt = chatMessageText(request[index + 1]!);
        assert.match(receipt, /^### log:\/\/\/1\/2\/\d+\/(?:EDIT|READ|NOTE) · \d+/u);
        assert.doesNotMatch(receipt, /"aside"|→ worker:\/\/\/memo.txt/u);
        if (chatMessageText(message) === note) assert.doesNotMatch(receipt, /An authored memory/u);
        if (chatMessageText(message) === edit || chatMessageText(message) === read) assert.match(receipt, /Unique replacement\./u, "landed edit windows and READ output are returned evidence, not suppressed request bodies");
        const record = receipt.split("\n\n")[0]!;
        assert.equal(Number(/ · (\d+)/u.exec(record)![1]), contentWeight(record) + contentWeight(chatMessageText(message)), "the curation charge owns the complete operation and receipt once");
    }
    assert.match(request.filter(({ role }) => role === "user").map(chatMessageText).join("\n"), /Reasoning is not content\./u);
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source!.content, [edit, read, note].join("\n\n"));
});

test("{§retrieval-annotation}: failed retrievals retain their annotations independently, without promoting reasoning into content", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "failed-annotation");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Inspect the available evidence.");
    const source = frame("READ (worker:///absent.txt)", "/not-a-pattern/");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(source, frame("READ (worker:///also-absent.txt)", "Reasoning annotation.")),
        say(frame("SEND [200]", "Neither resource exists.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    const request = provider.received[1]!;
    assert.deepEqual(request.filter(({ role }) => role === "assistant").map(chatMessageText), [frame("NOTE", "/not-a-pattern/"), frame("READ (worker:///absent.txt)", null)]);
    const user = request.filter(({ role }) => role === "user").map(chatMessageText).join("\n");
    assert.match(user, /Reasoning annotation\./u);
    assert.match(user, /also-absent\.txt/u);
    assert.doesNotMatch(user, /not-a-pattern/u);
    assert.equal([...user.matchAll(/"status":404/gu)].length >= 2, true);
    const notes = await db.test_log_entries_by_worker_op_full.all<{ tx: string }>({ worker_id: workerId, op: "NOTE" });
    assert.ok(notes.some(({ tx }) => JSON.parse(tx).body === "/not-a-pattern/"));
});

test("{§emission-history} {§bulk-resource-targeting}: one glob replay owns concrete receipts, including failures", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "paired-fanout");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Inspect the notes.");
    const glob = frame("READ (worker:///case-*.txt)", null);
    const missing = frame("READ (worker:///absent.txt)", null);
    const copy = frame("COPY (worker:///case-a.*) (worker:///copy.txt)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say([frame("EDIT (worker:///case-a.txt)", "First."), frame("EDIT (worker:///case-b.txt)", "Second.")].join("\n\n")),
        say(`${glob}\n\n${missing}\n\n${copy}`), say(frame("SEND [200]", "The missing note was absent.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    const request = provider.received[2]!;
    const index = request.findIndex((message) => message.role === "assistant" && chatMessageText(message) === glob);
    assert.notEqual(index, -1);
    assert.equal(request.filter((message) => message.role === "assistant" && chatMessageText(message) === glob).length, 1);
    assert.match(chatMessageText(request[index + 1]!), /case-a\.txt[\s\S]*First\.[\s\S]*case-b\.txt[\s\S]*Second\./u);
    const failed = request.findIndex((message) => message.role === "assistant" && chatMessageText(message) === missing);
    assert.notEqual(failed, -1);
    assert.match(chatMessageText(request[failed + 1]!), /"status":404/u);
    const copied = request.findIndex((message) => message.role === "assistant" && chatMessageText(message) === copy);
    assert.notEqual(copied, -1);
    assert.match(chatMessageText(request[copied + 1]!), /^### log:\/\/\/1\/3\/\d+\/COPY → worker:\/\/\/case-a\.txt → worker:\/\/\/copy\.txt/u, "resolved transfer operands are new result facts");
});
