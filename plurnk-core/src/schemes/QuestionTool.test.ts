// {§question-tool} — the native request-user-input runtime: MCP2-elicitation
// body in, standard ElicitResult out, one shared client-interaction round trip.

import test from "node:test";
import assert from "node:assert/strict";
import QuestionTool, { questionRegisteredTool } from "./QuestionTool.ts";
import type { ExecArgs } from "@plurnk/plurnk-execs";

const args = (overrides: Partial<ExecArgs>): ExecArgs => ({
    metadata: null,
    runtime: "question",
    body: "",
    cwd: null,
    target: null,
    signal: new AbortController().signal,
    write: () => {},
    setState: () => {},
    emit: () => {},
    interact: async () => { throw new Error("unexpected interact"); },
    ...overrides,
});

test("{§question-tool}: the registered tool declaration shapes the auto-generated doc", () => {
    assert.equal(questionRegisteredTool.target, "question");
    assert.match(questionRegisteredTool.summary, /Ask the user/);
    assert.ok(questionRegisteredTool.invocation.inputSchema !== undefined, "the invocation carries its input schema");
    assert.match(questionRegisteredTool.details ?? "", /message|requestedSchema/, "the doc teaches the standard field vocabulary");
    assert.deepEqual(questionRegisteredTool.traits, ["interaction"]);
});

test("{§question-tool}: an answered question writes the standard ElicitResult", async () => {
    const writes: Array<[string, string]> = [];
    const states: string[] = [];
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    const result = await tool.run(args({
        body: JSON.stringify({
            message: "Which branch?",
            requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main"] } }, required: ["branch"] },
        }),
        write: (channel, chunk) => { writes.push([channel, chunk]); },
        setState: (channel, state) => { states.push(`${channel}:${state}`); },
        interact: async (request) => {
            assert.equal(request.toolName, "question");
            assert.equal(request.mode, "form");
            assert.equal(request.message, "Which branch?");
            assert.deepEqual(request.requestedSchema, {
                type: "object",
                properties: { branch: { type: "string", enum: ["main"] } },
                required: ["branch"],
            });
            return { action: "accept", content: { branch: "main" } };
        },
    }));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(writes[0][1]), { action: "accept", content: { branch: "main" } });
    assert.deepEqual(states, ["results:closed"]);
});

test("{§question-tool}: answer fields named action or content remain answer data", async () => {
    const writes: string[] = [];
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    const answer = { action: "cancel", content: "literal answer" };
    const result = await tool.run(args({
        body: JSON.stringify({ message: "Describe the action.", requestedSchema: {
            type: "object", properties: { action: { type: "string" }, content: { type: "string" } },
        } }),
        write: (_channel, chunk) => writes.push(chunk),
        interact: async () => ({ action: "accept", content: answer }),
    }));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(writes.join("")), { action: "accept", content: answer });
});

test("{§question-tool}: a cancelled or declined interaction returns the standard action", async () => {
    for (const action of ["cancel", "decline"] as const) {
        const writes: Array<[string, string]> = [];
        const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
        const result = await tool.run(args({
            body: JSON.stringify({ message: "Ok?", requestedSchema: { type: "object" } }),
            write: (channel, chunk) => { writes.push([channel, chunk]); },
            interact: async () => ({ action }),
        }));
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(writes[0][1]), { action });
    }
});

test("{§question-tool}: a malformed body fails with the standard shape steer", async () => {
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    for (const body of ["not json", "{}", JSON.stringify({ message: "", requestedSchema: {} }), JSON.stringify({ message: "hi" })]) {
        const result = await tool.run(args({ body }));
        assert.equal(result.status, 400, `body ${JSON.stringify(body)} refuses`);
        assert.match(result.problem?.type ?? "", /invalid-body/);
    }
});

// Asking the human is an interaction capability; the runtime declares that
// trait once for admission and packet filtering.
test("{§question-tool}: the synthesized manifest carries the interaction trait", () => {
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    assert.deepEqual(tool.manifest.traits, ["interaction"]);
});
