// {§packet-wire-envelope} — the packet's bytes under the roles the model was tuned on: the log one
// user message per completed turn, the worker's previous program alone as the one assistant
// message, the current turn's records and the status clump closing.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { RequestPacket, StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const record = (coordinate: string, op: string, body: string): string => `### log:///${coordinate}/${op} · 12\n{"origin":"model"}\n 1:${body}`;
const packet = (records: readonly string[], turn: number | null): RequestPacket => {
    const sections: StoredPacketSection[] = [
        { name: "definition", slot: "system", header: null, content: "the card", weight: 4 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 40 },
    ];
    if (turn !== null) sections.push({ name: "worker", slot: "user", header: "Worker", content: JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn }), weight: 8 });
    sections.push({ name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 1 });
    return { weight: 0, attributions: [], attachments: [], sections };
};

test("{§packet-wire-envelope}: the log splits by turn, the previous program is the assistant message, the current turn closes with the clump", () => {
    const records = [record("1/1/1", "NOTE", "init"), record("1/2/1", "READ", "a"), record("1/2/2", "FIND", "b"), record("1/3/1", "SEND", "arrival")];
    const previous = "```READ (a.md) <1,-1>\n```";
    const wire = PacketWire.packetToWireMessages(packet(records, 3), previous);
    assert.deepEqual(wire.map(({ role }) => role), ["system", "user", "user", "assistant", "user"]);
    assert.equal(wire[0]!.content, "the card");
    assert.equal(wire[1]!.content, `## Log\n\n${records[0]}`, "the first turn's records open the log");
    assert.equal(wire[2]!.content, `${records[1]}\n\n${records[2]}`, "one message per completed turn, records joined as in the packet");
    assert.equal(wire[3]!.content, previous, "the previous program, verbatim and alone");
    assert.equal(wire[4]!.content, `${records[3]}\n\n## Worker\n${JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn: 3 })}\n\n## Open Messages\n[]`, "the current turn's records, then the clump");
    const bytes = wire.filter(({ role }) => role === "user").map(({ content }) => content).join("\n\n");
    assert.ok(bytes.includes(records.join("\n\n")), "every log byte is present, in order, across the user messages");

    const cold = PacketWire.packetToWireMessages(packet(records.slice(0, 3), 3), null);
    assert.deepEqual(cold.map(({ role }) => role), ["system", "user", "user", "user"], "no program yet: no assistant message; the clump alone closes");
    assert.equal(cold[3]!.content, `## Worker\n${JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn: 3 })}\n\n## Open Messages\n[]`);

    const flat = PacketWire.packetToWireMessages(packet(records, null), previous);
    assert.deepEqual(flat.map(({ role }) => role), ["system", "user", "user", "user", "assistant", "user"], "without a Worker block no turn is current: every group precedes the program");
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
    assert.equal(opening.at(-1)!.role, "user");
    const second = provider.received[1]!;
    const assistant = second.filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 1, "exactly one assistant message");
    assert.equal(chatMessageText(assistant[0]!), first, "the previous turn's program, verbatim and alone");
    assert.equal(second.at(-1)!.role, "user", "the request closes with the clump");
    assert.ok(chatMessageText(second.at(-1)!).includes("## Worker"), "the clump closes the request");
    const users = second.filter((message) => message.role === "user");
    assert.ok(users.length >= 2, "the log arrives one user message per completed turn before the program");
    assert.ok(chatMessageText(users[0]!).startsWith("## Log"), "the first log message opens the log");
});
