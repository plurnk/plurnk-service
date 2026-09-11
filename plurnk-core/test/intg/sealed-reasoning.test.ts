// {§encrypted-reasoning-carrier} {§agui-encrypted-reasoning} — cross-package
// coverage for original provider evidence, readable delivery, and opaque-state exclusion.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import LogEntry from "../../src/server/logEntry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const BLOB = "gAAAAABqBLOB-SEALED-0123456789";

// Hydrate the real core rows, then feed them to AG-UI in durable order.
const projectThroughAgui = async (db: Db, workerId: number, turnId: number) => {
    const tr = new Translator({ threadId: "xlane", runId: "xlane", modelWorkerId: workerId });
    const refs = await db.test_log_entries_by_worker.all<{ id: number; turn_id: number }>({ worker_id: workerId });
    const events = [];
    for (const { id, turn_id } of refs) {
        if (turn_id !== turnId) continue;
        const row = await LogEntry.fetchLogEntry(db, id);
        events.push(...tr.logEntry({ entry: {
            ...row,
            coordinate: `${row.loop_seq}/${row.turn_seq}/${row.sequence}${row.op === null ? "" : `/${row.op}`}`,
        } as never }));
    }
    return events;
};

test("core preserves opaque state only in provider evidence while readable reasoning reaches AG-UI", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "```SEND\nProgress.\n```\n```TASK\n[{\"content\":\"one\",\"status\":\"in_progress\"}]\n```", reasoning: "readable provider reasoning", reasoningEncrypted: [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }] } },
            { assistant: { content: "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } },
        ] as never });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        const responses = await db.test_model_calls.all<{ response: string }>({ turn_id: t1.turnId });
        const expected = [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }];
        assert.deepEqual(JSON.parse(responses[0]!.response).assistant.reasoningEncrypted, expected);
        const originalPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: t1.turnId }))!.packet);
        assert.equal(originalPacket.assistantRaw, null, "the mock supplied no raw wire response to invent");
        assert.equal(originalPacket.assistant.reasoning, "readable provider reasoning");
        const sources = await db.test_turn_sources.all<{ content: string }>({ worker_id: workerId });
        assert.ok(sources.length > 0);
        assert.ok(sources.every(({ content }) => !content.includes(BLOB)), "sources contain readable text, not opaque state");

        const refs = await db.test_log_entries_by_worker.all<{ id: number; turn_id: number }>({ worker_id: workerId });
        const wires = await Promise.all(refs.filter(({ turn_id }) => turn_id === t1.turnId).map(({ id }) => LogEntry.fetchLogEntry(db, id)));
        for (const op of ["SEND", "TASK"]) {
            assert.equal(wires.find((row) => row.op === op)?.reasoning, "readable provider reasoning",
                `${op} derives readable reasoning from the admitted packet`);
        }
        assert.ok(wires.filter(({ op }) => op !== "SEND" && op !== "TASK").every((wire) => !Object.hasOwn(wire, "reasoning")), "non-conversational rows do not project provider reasoning");

        // 2. Cross-lane conformance: real core rows → hydration → AG-UI Translator.
        const events = await projectThroughAgui(db, workerId, t1.turnId);
        const assistant = events.find((e) => e.type === "TEXT_MESSAGE_START") as { messageId?: string } | undefined;
        assert.ok(assistant?.messageId, "the turn projects its actual SEND assistant message");
        assert.ok(!events.some(({ type }) => type === "REASONING_ENCRYPTED_VALUE"));
        assert.ok(!JSON.stringify(wires).includes(BLOB), "log serialization does not copy provider-only state");
        const replay = new Translator({ threadId: "xlane", runId: "reattach" }).replay(wires);
        assert.ok(!JSON.stringify(replay).includes(BLOB), "reattaching does not imply native reasoning continuation");
        const readable = events.find((e) => e.type === "REASONING_MESSAGE_CONTENT") as { delta?: string } | undefined;
        assert.equal(readable?.delta, "readable provider reasoning", "admitted readable reasoning reaches AG-UI through the derived SEND projection");
        assert.equal(events.filter(({ type }) => type === "REASONING_MESSAGE_CONTENT").length, 1,
            "the same turn's SEND and TASK do not duplicate its reasoning");
        assert.ok(events.findIndex(({ type }) => type === "REASONING_MESSAGE_CONTENT")
            < events.findIndex(({ type }) => type === "TEXT_MESSAGE_START"), "reasoning precedes the first speech");

        // 3. Weight safety: the next packet's render must not contain the blob anywhere.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const packet = (await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId }))!.packet;
        const sections = (JSON.parse(packet) as { sections?: Array<{ content: string }> }).sections ?? [];
        assert.ok(sections.every((s) => !s.content.includes(BLOB)), "no packet section carries the sealed blob — the model never pays for what it cannot read");
        assert.ok(t1.turnId > 0);
    } finally { await db.close(); }
});

test("multiple encrypted-reasoning items remain distinct forensic evidence without collapsing into AG-UI", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-multi-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const A = `${BLOB}-A`, B = `${BLOB}-B`;
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null, reasoningEncrypted: [
                { id: "rs_a", subtype: "message", encrypted: [{ data: A, format: "openai-responses-v1" }] },
                { id: "rs_b", subtype: "message", encrypted: [{ data: B, format: "openai-responses-v1" }] },
            ] } },
        ] as never });
        const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        const calls = await db.test_model_calls.all<{ response: string }>({ turn_id: turn.turnId });
        const list = JSON.parse(calls[0]!.response).assistant.reasoningEncrypted as Array<{ id: string; encrypted: Array<{ data: string }> }>;
        assert.deepEqual(list.map(({ id, encrypted }) => [id, encrypted[0]?.data]), [["rs_a", A], ["rs_b", B]], "provider evidence retains both details distinctly");
        const events = await projectThroughAgui(db, workerId, turn.turnId);
        assert.ok(!events.some((e) => e.type === "REASONING_ENCRYPTED_VALUE"), "the single AG-UI message slot does not select, join, or overwrite multiple values");
    } finally { await db.close(); }
});
