import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, SendStatement } from "@plurnk/plurnk-grammar";
import Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: null, lineMarker: null,
    body: { raw: body, json: null }, position: { line: 1, column: 1 },
});

const editStmt = (path: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    path: { kind: "url", raw: `known://${path}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${path}`, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const response = (content: string, ops: MockResponse["assistant"]["ops"]): MockResponse => ({
    assistant: { tokens: 0, content, ops, reasoning: null },
});

test("Mock.provider: contextSize exposed", () => {
    const mock = new Mock({ contextSize: 200000, responses: [] });
    assert.equal(mock.contextSize, 200000);
});

test("Mock.provider: returns queued responses in order", async () => {
    const r1 = response("first", [editStmt("a", "1")]);
    const r2 = response("second", [editStmt("b", "2")]);
    const mock = new Mock({ contextSize: 100, responses: [r1, r2] });
    const a = await mock.generate({ prompt: "anything" });
    const b = await mock.generate({ prompt: "anything" });
    assert.equal(a.assistant.content, "first");
    assert.equal(b.assistant.content, "second");
});

test("Mock.provider: exhausted queue throws", async () => {
    const mock = new Mock({ contextSize: 100, responses: [response("only", [])] });
    await mock.generate({ prompt: "x" });
    await assert.rejects(() => mock.generate({ prompt: "y" }), /Mock provider exhausted/);
});

test("Mock.provider: assistant shape carries content + ops + reasoning + tokens", async () => {
    const r: MockResponse = {
        assistant: {
            tokens: 42,
            content: "<<SEND[200]:done:SEND",
            ops: [sendStmt(200, "done")],
            reasoning: "thought about it",
        },
    };
    const mock = new Mock({ contextSize: 100, responses: [r] });
    const result = await mock.generate({ prompt: "x" });
    assert.equal(result.assistant.tokens, 42);
    assert.equal(result.assistant.content, "<<SEND[200]:done:SEND");
    assert.equal(result.assistant.ops.length, 1);
    assert.equal(result.assistant.ops[0]?.op, "SEND");
    assert.equal(result.assistant.reasoning, "thought about it");
});

test("Mock.provider: prompt is ignored — same input doesn't influence output", async () => {
    const mock = new Mock({
        contextSize: 100,
        responses: [response("alpha", []), response("alpha", [])],
    });
    const a = await mock.generate({ prompt: "completely different" });
    const b = await mock.generate({ prompt: "completely different" });
    assert.equal(a.assistant.content, "alpha");
    assert.equal(b.assistant.content, "alpha");
});

test("Mock.provider: assistantRaw defaults to null; explicit value is passed through", async () => {
    const r1: MockResponse = { assistant: { tokens: 0, content: "x", ops: [], reasoning: null } };
    const r2: MockResponse = { assistant: { tokens: 0, content: "y", ops: [], reasoning: null }, assistantRaw: { vendor: "anthropic", id: "msg_123" } };
    const mock = new Mock({ contextSize: 100, responses: [r1, r2] });
    const a = await mock.generate({ prompt: "" });
    const b = await mock.generate({ prompt: "" });
    assert.equal(a.assistantRaw, null);
    assert.deepEqual(b.assistantRaw, { vendor: "anthropic", id: "msg_123" });
});

test("Mock.provider: remaining count tracks unconsumed responses", async () => {
    const mock = new Mock({
        contextSize: 100,
        responses: [response("a", []), response("b", []), response("c", [])],
    });
    assert.equal(mock.remaining, 3);
    await mock.generate({ prompt: "" });
    assert.equal(mock.remaining, 2);
    await mock.generate({ prompt: "" });
    await mock.generate({ prompt: "" });
    assert.equal(mock.remaining, 0);
});

test("Mock.provider: empty ops array is valid (model emitting no operations)", async () => {
    const mock = new Mock({ contextSize: 100, responses: [response("", [])] });
    const result = await mock.generate({ prompt: "" });
    assert.deepEqual(result.assistant.ops, []);
});

test("Mock.provider: multi-op response (the typical loop turn)", async () => {
    const ops = [
        editStmt("a", "1"),
        editStmt("b", "2"),
        sendStmt(102, "continuing"),
    ];
    const content = "<<EDIT(known://a):1:EDIT\n<<EDIT(known://b):2:EDIT\n<<SEND[102]:continuing:SEND";
    const mock = new Mock({ contextSize: 100, responses: [response(content, ops)] });
    const result = await mock.generate({ prompt: "" });
    assert.equal(result.assistant.ops.length, 3);
    assert.deepEqual(result.assistant.ops.map((o) => o.op), ["EDIT", "EDIT", "SEND"]);
});
