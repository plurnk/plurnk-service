import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const op = PlurnkParser.frame;
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const tail = (text: string): string => text.split("\n\n## Previous Emission\n\n")[1] ?? "";

test("{§previous-emission}: the complete previous program closes one user message; sources, receipts and prefix remain intact", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-whole");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Edit, inspect, and reply.");
    const body = "Actual replacement.\n```NOTE\nA literal nested example, not an operation.\n```\nLast line.";
    const first = [op("EDIT (worker:///memo.md)", body), op("NOTE", "Content memory."), op("WAIT <0>", null)].join("\n\n");
    const second = op("READ (worker:///memo.md)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(first, op("NOTE", "Reasoning memory.")),
        say(second), say(op("KILL", "Finished.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const result = await engine.runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    for (const request of provider.received) assert.deepEqual(request.map(({ role }) => role), ["system", "user"]);
    const [opening, afterEdit, afterRead] = provider.received.map((request) => chatMessageText(request[1]!));
    assert.doesNotMatch(opening!, /## Previous Emission/u);
    assert.equal(tail(afterEdit!), first, "all content operations and every body, including nested fences, survive unchanged");
    assert.equal(tail(afterRead!), second, "the tail is replaced, not accumulated");
    assert.doesNotMatch(tail(afterEdit!), /Reasoning memory/u, "reasoning operations stay in their channel");
    const record = afterEdit!.split("\n\n").find((text) => /^### log:\/\/\/1\/2\/\d+\/emission/u.test(text))!;
    assert.ok(record);
    assert.ok(afterRead!.includes(record), "aging the replay never changes the old record's bytes or weight");
    assert.equal(Number(/ · (\d+)/u.exec(record)![1]), contentWeight(record), "the row charges only itself");
    const reads = await db.test_log_entries_by_worker_op_full.all<{ rx: string }>({ worker_id: workerId, op: "READ" });
    assert.ok(reads.some(({ rx }) => (JSON.parse(rx) as { content?: string }).content === body), "the actual EDIT wrote the full replacement");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "the immutable source is untouched");
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ workspaceId, workerId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(packet, "previous-emission"), op("KILL", "Finished."), "reply bodies are not special-cased away");
    assert.equal(packet.weight, contentWeight(PacketWire.renderSlot(packet.sections, "system")) + contentWeight(PacketWire.renderSlot(packet.sections, "user")), "the tail is charged exactly once");
    const nextLoop = await insertLoop(db, workerId, 2, "A new request.");
    const next = await builder.buildRequestPacket({ workspaceId, workerId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(next, "previous-emission"), "", "a new loop does not inherit a prior loop's tail");
});

for (const [name, content, reasoning, expected] of [
    ["runtime refusal", op("READ (worker:///missing.md)", null), null, op("READ (worker:///missing.md)", null)],
    ["syntax failure after a valid operation", `${op("NOTE", "admitted")}\n\n\`\`\`READ (unclosed`, null, ""],
    ["reasoning-only turn", "", op("NOTE", "Only reasoning."), ""],
    ["empty turn", "", null, ""],
] as const) {
    test(`{§previous-emission}: ${name} is evaluated on the immediate turn, never an older program`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, name);
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const first = op("NOTE", "OLDER PROGRAM");
        const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(content, reasoning), say(op("KILL", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(provider.received.length, 3);
        assert.equal(tail(chatMessageText(provider.received[1]![1]!)), first);
        assert.equal(tail(chatMessageText(provider.received[2]![1]!)), expected);
    });
}

test("{§previous-emission} {§context-own-rows-fit}: the wall omits the entire replay before any result body, then decides afresh", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-wall");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Retain these observations.");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    const body = Array.from({ length: 1500 }, (_, i) => `Durable observation ${i + 1}.`).join("\n");
    const first = op("NOTE", body);
    const wide = new Mock({ contextWindow: 200000, responses: [say(first)] });
    await engine.runTurn({ workspaceId, workerId, loopId, provider: wide, messages: [] });
    const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
    const args = { workspaceId, workerId, loopId, currentTurnSeq: 3, provider: wide, initialMessages: [], gitStatus: null };
    const full = await builder.buildRequestPacket(args);
    const without = await builder.buildRequestPacket({ ...args, omitPreviousEmission: true });
    assert.equal(PacketWire.sectionContent(full, "previous-emission"), first);
    assert.equal(PacketWire.sectionContent(full, "log"), PacketWire.sectionContent(without, "log"));
    const wall = Math.floor((full.weight + without.weight) / 2);
    const small = op("NOTE", "New observation.");
    const limited = new class extends Mock {
        override get inputWall(): number { return wall; }
    }({ contextWindow: 200000, responses: [say(small), say(op("KILL", "Done."))] });
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    const request = limited.received[0]!;
    assert.equal(tail(chatMessageText(request[1]!)), "");
    assert.match(chatMessageText(request[1]!), /Durable observation 1500\./u, "all result lines survive the optional replay");
    assert.doesNotMatch(chatMessageText(request[1]!), /"size":|\[REDACTED\]|preview|omitted/u, "no result suppression or replay placeholder");
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    assert.equal(tail(chatMessageText(limited.received[1]![1]!)), small, "the next turn can replay a smaller program");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "omission never rewrites the source");
});

test("{§previous-emission}: an exhausted rejected turn does not revive the preceding admitted program", async (t) => {
    const limit = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = "1";
    t.after(() => {
        if (limit === undefined) delete process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
        else process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = limit;
    });
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-rejected");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Work.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(op("NOTE", "Old admitted program.")),
        say(`### log:///1/2/9/READ\nInvented receipt.\n\n${op("NOTE", "Rejected program.")}`),
        say(op("KILL", "Done.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const args = { workspaceId, workerId, loopId, provider, messages: [] };
    await engine.runTurn(args);
    const rejected = await engine.runTurn(args);
    assert.equal(rejected.emissionExhausted, true);
    await engine.runTurn(args);
    assert.equal(provider.received.length, 3);
    assert.equal(tail(chatMessageText(provider.received[2]![1]!)), "");
});
