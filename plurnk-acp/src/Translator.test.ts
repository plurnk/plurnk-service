import assert from "node:assert/strict";
import test from "node:test";
import type { LogEntryWire } from "@plurnk/plurnk-contracts";
import Translator from "./Translator.ts";

const makeRow = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1,
    worker_id: 7,
    worker_name: "main",
    loop_id: 1,
    loop_seq: 1,
    turn_id: 1,
    turn_seq: 1,
    sequence: 1,
    at: "2026-10-24T00:00:00Z",
    origin: "model",
    source: null,
    op: "READ",
    signal: null,
    scheme: null,
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname: "src/index.ts",
    query: null,
    fragment: null,
    lineMarker: null,
    tx: { op: "READ", target: { kind: "local", path: "src/index.ts" } },
    mimetype_tx: "application/json",
    rx: { status: 200, content: "export const x = 1;\n", mimetype: "text/typescript" },
    mimetype_rx: "application/json",
    status_rx: 200,
    weight: 10,
    attrs: { original: "old", patched: "new", kind: "read" },
    state: "resolved",
    ...overrides,
});

test("{§acp-projection} Translator projects model speech, user arrivals, tool calls with bodyless attrs, reasoning, and usage updates", () => {
    const translator = new Translator({
        sessionId: "1#main",
        workspaceId: 1,
        workerId: 7,
        origin: "http://127.0.0.1:1066",
        historyPageChars: 100,
    });

    // 1. Tool call with diff and bodyless attrs
    const toolUpdates = translator.logEntry({
        entry: makeRow({
            op: "EDIT",
            attrs: { original: "const a = 1;", patched: "const a = 2;", kind: "edit" },
            reasoning: "Thinking about editing src/index.ts",
        }),
    });
    assert.equal(toolUpdates.length, 2, "emits thought chunk followed by tool_call");
    assert.equal(toolUpdates[0]?.update.sessionUpdate, "agent_thought_chunk");
    assert.equal(toolUpdates[1]?.update.sessionUpdate, "tool_call");
    assert.equal(toolUpdates[1]?.update.kind, "edit");
    assert.equal(toolUpdates[1]?.update.status, "completed");
    assert.deepEqual(toolUpdates[1]?.update.locations, [{ path: "src/index.ts" }]);
    assert.ok(toolUpdates[1] !== undefined);
    const plurnkMeta = (toolUpdates[1].update._meta as { plurnk: { attrs: Record<string, unknown> } }).plurnk;
    assert.deepEqual(plurnkMeta.attrs, { kind: "edit" }, "bodies are stripped from _meta.plurnk.attrs");

    // 2. Model speech (SEND response)
    const speechUpdates = translator.logEntry({
        entry: makeRow({
            sequence: 2,
            op: "SEND",
            pathname: null,
            tx: { op: "SEND", aside: "answering", body: "Done updating src/index.ts." },
            rx: { status: 200 },
            attrs: { kind: "response" },
        }),
    });
    assert.equal(speechUpdates.length, 1);
    assert.equal(speechUpdates[0]?.update.sessionUpdate, "agent_message_chunk");
    assert.deepEqual(speechUpdates[0]?.update.content, { type: "text", text: "Done updating src/index.ts." });

    // 3. Large body falls back to resource_link at /acp/entry
    const largeSpeech = translator.logEntry({
        entry: makeRow({
            sequence: 3,
            op: "SEND",
            pathname: null,
            tx: { op: "SEND", body: "x".repeat(250) },
            rx: { status: 200 },
            attrs: { kind: "response" },
        }),
    });
    assert.ok(largeSpeech[0] !== undefined);
    assert.equal((largeSpeech[0].update.content as { type: string }).type, "resource_link");
    assert.match((largeSpeech[0].update.content as { uri: string }).uri, /^http:\/\/127\.0\.0\.1:1066\/acp\/entry\?/u);

    // 4. Packet usage update
    const usage = translator.packet({
        workerId: 7,
        loopId: 1,
        loopSeq: 1,
        packetCount: 2,
        gauge: { curationWeight: 100, curationBudget: 1000, contextTokens: 500, contextCapacity: 8000 },
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.update.sessionUpdate, "usage_update");
    assert.equal(usage[0]?.update.used, 500);
    assert.equal(usage[0]?.update.size, 8000);
});

test("{§acp-session-load} Translator.replay windows history to the newest historyLoops and reports hasMore and beforeLoopSeq", () => {
    const translator = new Translator({
        sessionId: "1#main",
        workspaceId: 1,
        workerId: 7,
        origin: "http://127.0.0.1:1066",
    });
    const rows = [
        makeRow({ id: 1, loop_id: 1, loop_seq: 1, sequence: 1 }),
        makeRow({ id: 2, loop_id: 2, loop_seq: 2, sequence: 1 }),
        makeRow({ id: 3, loop_id: 3, loop_seq: 3, sequence: 1 }),
    ];
    const page1 = Translator.replay(translator, rows, [], { historyLoops: 2 });
    assert.equal(page1.updates.length, 2);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.beforeLoopSeq, 2);

    const page2 = Translator.replay(translator, rows, [], { historyLoops: 2, beforeLoopSeq: page1.beforeLoopSeq ?? undefined });
    assert.equal(page2.updates.length, 1);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.beforeLoopSeq, null);
});
