// {§question-tool} — the native request-user-input runtime: MCP2-elicitation
// body in, standard ElicitResult out, one shared client-interaction round trip.

import test from "node:test";
import assert from "node:assert/strict";
import QuestionTool, { questionRuntimeDecl } from "./QuestionTool.ts";
import type { ExecArgs } from "@plurnk/plurnk-execs";

const args = (overrides: Partial<ExecArgs>): ExecArgs => ({
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

test("{§question-tool}: the runtime declaration shapes the auto-generated doc", () => {
    assert.equal(questionRuntimeDecl.name, "question");
    assert.match(questionRuntimeDecl.summary, /Ask the user/);
    assert.ok(questionRuntimeDecl.invocation.example?.body !== undefined, "the example teaches a concrete body");
    assert.match(questionRuntimeDecl.details ?? "", /message|requestedSchema/, "the doc teaches the standard field vocabulary");
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
            assert.equal(request.message, "Which branch?");
            assert.deepEqual(request.arguments, {
                message: "Which branch?",
                requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main"] } }, required: ["branch"] },
            });
            assert.deepEqual(request.responseSchema, request.arguments.requestedSchema);
            return { status: "resolved", payload: { action: "accept", content: { branch: "main" } } };
        },
    }));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(writes[0]![1]), { action: "accept", content: { branch: "main" } });
    assert.deepEqual(states, ["results:closed"]);
});

test("{§question-tool}: a cancelled interaction returns the standard cancel action", async () => {
    const writes: Array<[string, string]> = [];
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    const result = await tool.run(args({
        body: JSON.stringify({ message: "Ok?", requestedSchema: { type: "object" } }),
        write: (channel, chunk) => { writes.push([channel, chunk]); },
        interact: async () => ({ status: "cancelled" }),
    }));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(writes[0]![1]), { action: "cancel" });
});

test("{§question-tool}: a malformed body fails with the standard shape steer", async () => {
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    for (const body of ["not json", "{}", JSON.stringify({ message: "", requestedSchema: {} }), JSON.stringify({ message: "hi" })]) {
        const result = await tool.run(args({ body }));
        assert.equal(result.status, 400, `body ${JSON.stringify(body)} refuses`);
        assert.match(result.problem?.type ?? "", /invalid-body/);
    }
});

// {§manifest-flag-affinity} — asking the human IS interaction: the declared
// affinity rides BaseExecutor's synthesized manifest, so the one resolver
// gates dispatch AND directory teaching under noInteraction.
test("{§question-tool}: the synthesized manifest carries requiresInteraction", () => {
    const tool = new QuestionTool({ runtime: "question", glyph: "❓" });
    assert.deepEqual(tool.manifest.flags, { requiresInteraction: true });
});
