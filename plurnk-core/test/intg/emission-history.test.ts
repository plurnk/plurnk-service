import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const op = PlurnkParser.frame;
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const previousProgram = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");
const withHistory = async (mode: string, fn: () => Promise<void>): Promise<void> => {
    const name = "PLURNK_SERVICE_EMISSION_HISTORY";
    const previous = process.env[name];
    process.env[name] = mode;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};

for (const mode of ["none", "latest", "all"]) {
    test(`{§emission-history}: ${mode} retains complete content programs without changing execution or source evidence`, async () => withHistory(mode, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `history-${mode}`);
            const workerId = await insertWorker(db, workspaceId, null, "writer");
            const loopId = await insertLoop(db, workerId, 1, "Edit, inspect, and reply.");
            const first = op("EDIT (worker:///memo.md)", "Actual replacement.\nLast line.");
            const second = op("READ (worker:///memo.md)", null);
            const final = op("SEND [200]", "Done.");
            const provider = new Mock({ contextWindow: 100000, responses: [
                say(first, op("NOTE", "Reasoning memory.")), say(second), say(final),
            ] });
            const schemes = new SchemeRegistry();
            const result = await new Engine({ db, schemes }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "retention neither executes programs again nor changes the loop");
            assert.equal(previousProgram(provider.received[0]!), "");
            assert.equal(previousProgram(provider.received[1]!), mode === "none" ? "" : first);
            assert.equal(previousProgram(provider.received[2]!), mode === "none" ? "" : mode === "latest" ? second : `${first}\n\n${second}`);
            const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
            assert.equal(source?.content, first, "automatic retention never changes addressable evidence");
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const packet = await builder.buildRequestPacket({ workspaceId, workerId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(packet)), mode === "none" ? "" : mode === "latest" ? final : [first, second, final].join("\n\n"));
            assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
            const nextLoop = await insertLoop(db, workerId, 2, "New request.");
            const next = await builder.buildRequestPacket({ workspaceId, workerId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(next)), "", "retention is scoped to the current loop");
        } finally { await db.close(); }
    }));
}

test("{§emission-history}: all retains older eligible programs across a reasoning-only turn and a syntax failure", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-eligibility");
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const first = op("NOTE", "Complete content memory.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(first), say("", op("NOTE", "Reasoning memory.")),
            say(`${op("NOTE", "Partial program.")}\n\n\`\`\`READ (unclosed`),
            say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        for (const request of provider.received.slice(1)) assert.equal(previousProgram(request), first);
    } finally { await db.close(); }
}));

test("{§emission-history}: retiring an emission removes only that program, not its source", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-curation");
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const first = op("NOTE", "First content memory.");
        const second = op("NOTE", "Second content memory.");
        const curate = op("KILL (log:///1/2/*/emission)", null);
        const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(second), say(curate), say(op("SEND [200]", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        assert.equal(previousProgram(provider.received[2]!), `${first}\n\n${second}`);
        assert.equal(previousProgram(provider.received[3]!), `${second}\n\n${curate}`);
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source?.content, first);
    } finally { await db.close(); }
}));

test("{§emission-history}: the complete previous program separates log and footer; sources, receipts and prefix remain intact", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-whole");
    const workerId = await insertWorker(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, workerId, 1, "Edit, inspect, and reply.");
    const body = "Actual replacement.\n```NOTE\nA literal nested example, not an operation.\n```\nLast line.";
    const first = [op("EDIT (worker:///memo.md)", body), op("NOTE", "Content memory."), op("WAIT [0]", null)].join("\n\n");
    const second = op("READ (worker:///memo.md)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(first, op("NOTE", "Reasoning memory.")),
        say(second), say(op("SEND [200]", "Finished.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const result = await engine.runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.deepEqual(provider.received[0]!.map(({ role }) => role), ["system", "user"]);
    for (const request of provider.received.slice(1)) {
        assert.deepEqual(request.map(({ role }) => role), ["system", "user", "assistant", "user"]);
        assert.match(chatMessageText(request[1]!), /^## Log\n/u);
        assert.match(chatMessageText(request[3]!), /^## Worker\n/u);
    }
    const [opening, afterEdit, afterRead] = provider.received.map((request) => chatMessageText(request[1]!));
    assert.doesNotMatch(opening!, /## Previous Emission/u);
    assert.equal(previousProgram(provider.received[1]!), first, "all content operations and every body, including nested fences, survive unchanged");
    assert.equal(previousProgram(provider.received[2]!), second, "the program is replaced, not accumulated");
    assert.doesNotMatch(previousProgram(provider.received[1]!), /Reasoning memory/u, "reasoning operations stay in their channel");
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
    assert.equal(PacketWire.sectionContent(packet, "emission-history"), op("SEND [200]", "Finished."), "reply bodies are not special-cased away");
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0), "each message is charged exactly once");
    const nextLoop = await insertLoop(db, workerId, 2, "A new request.");
    const next = await builder.buildRequestPacket({ workspaceId, workerId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(next, "emission-history"), "", "a new loop does not inherit a prior loop's tail");
});

for (const [name, content, reasoning, expected] of [
    ["runtime refusal", op("READ (worker:///missing.md)", null), null, op("READ (worker:///missing.md)", null)],
    ["syntax failure after a valid operation", `${op("NOTE", "admitted")}\n\n\`\`\`READ (unclosed`, null, ""],
    ["reasoning-only turn", "", op("NOTE", "Only reasoning."), ""],
    ["empty turn", "", null, ""],
] as const) {
    test(`{§emission-history}: ${name} is evaluated on the immediate turn, never an older program`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, name);
        const workerId = await insertWorker(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, workerId, 1, "Work.");
        const first = op("NOTE", "OLDER PROGRAM");
        const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(content, reasoning), say(op("SEND [200]", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(provider.received.length, 3);
        assert.equal(previousProgram(provider.received[1]!), first);
        assert.equal(previousProgram(provider.received[2]!), expected);
    });
}

for (const mode of ["latest", "all"]) test(`{§emission-history} {§context-own-rows-fit}: the wall omits ${mode} replay whole before any result body, then decides afresh`, async (t) => withHistory(mode, async () => {
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
    const without = await builder.buildRequestPacket({ ...args, omitEmissionHistory: true });
    assert.equal(PacketWire.sectionContent(full, "emission-history"), first);
    assert.equal(PacketWire.sectionContent(full, "log"), PacketWire.sectionContent(without, "log"));
    const wall = Math.floor((full.weight + without.weight) / 2);
    const small = op("NOTE", "New observation.");
    const limited = new class extends Mock {
        override get inputWall(): number { return wall; }
    }({ contextWindow: 200000, responses: [say(small), say(op("SEND [200]", "Done."))] });
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    const request = limited.received[0]!;
    assert.equal(previousProgram(request), "");
    assert.deepEqual(request.map(({ role }) => role), ["system", "user"], "whole-program omission rejoins log and footer");
    assert.match(chatMessageText(request[1]!), /Durable observation 1500\./u, "all result lines survive the optional replay");
    assert.doesNotMatch(chatMessageText(request[1]!), /"size":|\[REDACTED\]|preview|omitted/u, "no result suppression or replay placeholder");
    await engine.runTurn({ workspaceId, workerId, loopId, provider: limited, messages: [] });
    assert.equal(previousProgram(limited.received[1]!), mode === "latest" ? small : "", "latest can fit anew; all remains too large and is never selectively redacted");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, worker_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "omission never rewrites the source");
}));

for (const mode of ["latest", "all"]) test(`{§emission-history}: ${mode} never replays an exhausted rejected turn`, async (t) => withHistory(mode, async () => {
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
        say(op("SEND [200]", "Done.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const args = { workspaceId, workerId, loopId, provider, messages: [] };
    await engine.runTurn(args);
    const rejected = await engine.runTurn(args);
    assert.equal(rejected.emissionExhausted, true);
    await engine.runTurn(args);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[2]!), mode === "all" ? op("NOTE", "Old admitted program.") : "");
}));
