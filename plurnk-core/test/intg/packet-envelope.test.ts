// {§packet-wire-envelope}
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import PreviousEmission, { type PreviousEmissionView } from "../../src/core/PreviousEmission.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StoredPacket, { type RequestPacket, type StoredPacketSection } from "../../src/core/StoredPacket.ts";
import Turn from "../../src/core/Turn.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const record = (coordinate: string, op: string, body: string): string => `### log:///${coordinate}/${op} · 12\n{"origin":"model"}\n 1:${body}`;
const packet = (records: readonly string[], turn: number | null, loop = 1): RequestPacket => {
    const sections: StoredPacketSection[] = [
        { name: "definition", slot: "system", header: null, content: "the card", weight: 4 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 40 },
    ];
    if (turn !== null) sections.push({ name: "worker", slot: "user", header: "Worker", content: JSON.stringify({ path: "worker://w", parent: null, loop, turn }), weight: 8 });
    sections.push({ name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 1 });
    return { weight: 0, attributions: [], attachments: [], sections };
};

const program = (loop: number, turn: number, inputSequence: number): PreviousEmissionView => ({
    content: "```READ (a.md) <1,-1>\n```", address: `ops://w/${loop}/${turn}`, loop, turn, inputSequence,
});

test("{§packet-wire-envelope}: incoming records precede their program, results follow it, current records close with the indices", () => {
    const records = [
        record("1/1/1", "NOTE", "init"),
        record("1/2/1", "SEND", "message"), record("1/2/2", "READ", "incoming stream"),
        record("1/2/3", "READ", "result"), record("1/2/4", "FIND", "matches"),
        record("1/3/1", "NOTE", "later turn"), record("1/4/1", "SEND", "arrival"),
    ];
    const previous = program(1, 2, 2);
    const source = packet(records, 4);
    const before = structuredClone(source);
    const wire = PacketWire.packetToWireMessages(source, previous);
    assert.deepEqual(wire.map(({ role }) => role), ["system", "user", "user", "assistant", "user", "user", "user"]);
    assert.equal(wire[0]!.content, "the card");
    assert.equal(wire[1]!.content, `## Log\n\n${records[0]}`, "the first turn's records open the log");
    assert.equal(wire[2]!.content, `${records[1]}\n\n${records[2]}`, "incoming SEND and stream READ remain before the program");
    assert.equal(wire[3]!.content, previous.content, "the canonical program alone");
    assert.equal(wire[4]!.content, `${records[3]}\n\n${records[4]}`, "results of that program follow it");
    assert.equal(wire[5]!.content, records[5], "later turns stay after the selected program");
    assert.equal(wire[6]!.content, `${records[6]}\n\n## Worker\n${JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn: 4 })}\n\n## Open Messages\n[]`, "the current turn's records, then the indices");
    const bytes = wire.filter(({ role }) => role === "user").map(({ content }) => content).join("\n\n");
    assert.ok(bytes.includes(records.join("\n\n")), "every log byte is present, in order, across the user messages");
    assert.deepEqual(source, before, "the request evidence is unchanged");

    const cold = PacketWire.packetToWireMessages(packet(records.slice(0, 5), 3), null);
    assert.deepEqual(cold.map(({ role }) => role), ["system", "user", "user", "user"], "no program yet: no assistant message; the clump alone closes");
    assert.equal(cold[3]!.content, `## Worker\n${JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn: 3 })}\n\n## Open Messages\n[]`);

    const flat = PacketWire.packetToWireMessages(packet(records, null), previous);
    assert.equal(flat[3]!.content, previous.content, "removing the Worker block cannot move the program after its results");
    assert.equal(flat.at(-1)!.content, "## Open Messages\n[]");
});

test("{§packet-wire-envelope}: curation and numeric loop/turn boundaries do not relocate or resurrect a program's records", () => {
    const previous = program(2, 10, 2);
    const rows = [record("1/40/1", "NOTE", "old loop"), record("2/9/1", "NOTE", "old turn"), record("2/10/1", "SEND", "input"), record("2/10/3", "READ", "effect"), record("2/11/1", "SEND", "next")];
    for (const kept of [rows, rows.filter((_, i) => i !== 2), rows.filter((_, i) => i !== 3), rows.filter((_, i) => i !== 2 && i !== 3), rows.slice(0, 2), []]) {
        const source = packet(kept, 11, 2);
        const wire = PacketWire.packetToWireMessages(source, previous);
        const at = wire.findIndex(({ role }) => role === "assistant");
        assert.ok(at > 0, "the bounded program remains even when all its rows were curated");
        assert.equal(wire[at]!.content, previous.content);
        for (const row of kept) {
            const index = wire.findIndex(({ role, content }) => role === "user" && content.includes(row));
            assert.ok(index >= 0);
            assert.equal(index < at, rows.indexOf(row) < 3, "numeric coordinates and the recorded input boundary determine placement");
        }
        assert.equal(wire.filter(({ role }) => role === "user").map(({ content }) => content).join("\n\n"), PacketWire.renderSlot(source.sections, "user"), "only current curated bytes are projected");
    }
});

test("{§packet-wire-envelope}: the input boundary comes from saved request items, including a transformed single-item log", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "envelope-inputs");
    const workerId = await insertWorker(db, workspaceId, null, "w");
    for (const loop of [1, 2]) {
        const loopId = await insertLoop(db, workerId, loop);
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const incoming = record(`${loop}/1/7`, "READ", "before inference");
        const source = packet([record(`${loop}/1/2`, "SEND", "input"), incoming], 1, loop);
        if (loop === 1) source.sections = source.sections.map((section) => section.name === "log"
            ? { ...section, items: [record("1/1/2", "SEND", "input"), incoming] } : section);
        await Turn.recordInference(db, turn.id, {
            packet: StoredPacket.stringify(source), sections: StoredPacket.sections(source),
            usageCurationBudget: null, finishReason: null, model: "mock", meta: "{}",
        });
        await Turn.recordSource(db, turn.id, "ops", program(loop, 1, 7).content);
        await Turn.complete(db, turn.id, 102);
        const next = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const resolved = await PreviousEmission.resolve(db, { workspaceId, workerId, turnId: next.id }, undefined);
        assert.equal(resolved?.inputSequence, 7, "the input READ belongs before the program even though it shares its operation family");
        assert.equal(resolved?.address, `ops://w/${loop}/1`);
        assert.deepEqual([resolved?.loop, resolved?.turn], [loop, 1]);
        await Turn.complete(db, next.id, 102);
    }
});

test("{§packet-wire-envelope}: a program that curates its input is still ordered from the original request without restoring that input", async (t) => {
    for (const retainResult of [true, false]) {
        await t.test(retainResult ? "retained result" : "all program rows absent", async (t) => {
            const db = await openMigrated();
            t.after(() => db.close());
            const workspaceId = await insertWorkspace(db, "envelope-curated");
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Curate this original input body.");
            const first = [
                ...(retainResult ? [PlurnkParser.frame("NOTE", "Retained result.")] : []),
                PlurnkParser.frame("KILL (log:///1/2/1/SEND)", null),
            ].join("\n\n");
            const provider = new Mock({ contextWindow: 100000, responses: [
                { assistant: { content: first, reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
                { assistant: { content: PlurnkParser.frame("KILL", "Answer."), reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
            ] });
            const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 2);
            const request = provider.received[1]!;
            const programIndex = request.findIndex(({ role }) => role === "assistant");
            assert.equal(chatMessageText(request[programIndex]!), first);
            const users = request.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
            assert.doesNotMatch(users, /Curate this original input body|### log:\/\/\/1\/2\/1\/SEND/u, "the saved request is evidence of ordering, never a second source of log content");
            if (retainResult) {
                assert.ok(request.findIndex((message) => /### log:\/\/\/1\/2\/\d+\/NOTE\b/u.test(chatMessageText(message))) > programIndex);
            } else {
                assert.doesNotMatch(users, /### log:\/\/\/1\/2\//u);
                assert.ok(programIndex < request.length - 1, "a completely curated turn still puts its program before the current indices");
            }
        });
    }
});

test("{§packet-wire-envelope}: the turn runner sends turn zero's survey, then the worker's last admitted program, as the assistant message", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "envelope");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Answer.");
    const first = `${PlurnkParser.frame("NOTE", "Bearings: nothing read yet; answer next.")}\n${PlurnkParser.frame("WAIT", "")}`;
    const provider = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: first, reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { assistant: { content: PlurnkParser.frame("KILL", "Answer."), reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    const opening = provider.received[0]!;
    const survey = opening.filter((message) => message.role === "assistant");
    assert.equal(survey.length, 1, "the first model request carries turn zero's survey as its assistant message");
    assert.match(chatMessageText(survey[0]!), /^```NOTE\nThis turn surveys tooling and environment\./u, "the survey's program opens the assistant message; nothing precedes the grammar");
    assert.ok(opening.indexOf(survey[0]!) < opening.findIndex((message) => chatMessageText(message).includes("### log:///1/1/")), "the initialization program precedes its survey results");
    assert.equal(opening.at(-1)!.role, "user");
    const second = provider.received[1]!;
    const assistant = second.filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 1, "exactly one assistant message");
    const canonical = PlurnkParser.stringify(PlurnkParser.parse(first).items.filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement").map(({ statement }) => statement));
    assert.equal(chatMessageText(assistant[0]!), canonical, "the previous turn's program as the grammar reads it, alone");
    const programIndex = second.indexOf(assistant[0]!);
    const arrivalIndex = second.findIndex((message) => /### log:\/\/\/1\/2\/\d+\/SEND\b/u.test(chatMessageText(message)));
    const resultIndex = second.findIndex((message) => /### log:\/\/\/1\/2\/\d+\/NOTE\b/u.test(chatMessageText(message)));
    assert.ok(arrivalIndex >= 0 && arrivalIndex < programIndex, "the message available to turn 2 precedes its program");
    assert.ok(resultIndex > programIndex, "turn 2's NOTE result follows the program that produced it");
    assert.equal(second.at(-1)!.role, "user", "the request closes with the clump");
    assert.ok(chatMessageText(second.at(-1)!).includes("## Worker"), "the clump closes the request");
    assert.match(chatMessageText(second.at(-1)!), /"turn":3,"previousEmission":"ops:\/\/[^/"]+\/1\/2"\}/u, "the Worker block names the program the assistant message carries ({§packet-current-turn})");
    const users = second.filter((message) => message.role === "user");
    assert.ok(users.length >= 2, "the log's user messages retain turn boundaries");
    assert.ok(chatMessageText(users[0]!).startsWith("## Log"), "the first log message opens the log");
});

test("{§packet-wire-envelope}: the assistant message is the grammar's reading of the previous program: admitted statements only, no free text", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "envelope-canonical");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Answer.");
    const note = PlurnkParser.frame("NOTE", "Bearings: start.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: `Let me look around first.\n\n${note}\n\nDone for now.`, reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { assistant: { content: "Still thinking, no operation this time.", reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { assistant: { content: PlurnkParser.frame("KILL", "Answer."), reasoning: null }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.ok(provider.received.length >= 3, "the prose-only emission was rejected and rerolled");
    for (const request of provider.received.slice(1)) {
        const assistant = request.filter((message) => message.role === "assistant");
        assert.equal(assistant.length, 1);
        assert.equal(chatMessageText(assistant[0]!), note, "the canonical NOTE alone: the free text around it is gone, and the rejected prose turn never appears");
        assert.ok(request.indexOf(assistant[0]!) < request.findIndex((message) => /### log:\/\/\/1\/2\/\d+\/NOTE\b/u.test(chatMessageText(message))), "the earlier admitted program still precedes its own result after a rejected emission");
        assert.match(chatMessageText(request.at(-1)!), /"previousEmission":"ops:\/\/[^/"]+\/1\/2"\}/u, "the Worker block names the program the slot renders");
    }
});
