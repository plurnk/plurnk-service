import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§provider-wire-emission}: blank emissions retain their wire channels through persistence and digest", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "wire-evidence-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    let requests = 0;
    const provider = new AiSdkProvider({
        model: "wire-evidence", url: "https://example.test/v1/chat/completions",
        fetchTimeoutMs: 1000, operationTimeoutMs: 3000, firstContentTimeoutMs: 1000,
        contextWindow: 100000, outputBudget: 1000,
        reasoning: { mode: "off", budget: null }, temperature: null, repeatPenalty: null, retryAttempts: 0,
        rawBody: false,
        fetch: async () => {
            requests += 1;
            return new Response(`data: ${JSON.stringify({
                id: "blank-tools", model: "wire-evidence",
                choices: [{ index: 0, delta: {
                    tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "READ", arguments: '{"path":"example.txt"}' } }],
                    refusal: "retained vendor text",
                }, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 10, completion_tokens: 13, total_tokens: 23 },
            })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "wire-evidence");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1, "inspect");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Inspect." }] });
    } finally {
        await db.close();
    }
    assert.equal(requests, 1);
    Digest.run({ dbPath, digestDir });
    const raw = JSON.parse(await readFile(join(digestDir, "packet001.assistantRaw.json"), "utf8"));
    assert.equal(await readFile(join(digestDir, "packet001.assistant.md"), "utf8"), "");
    assert.equal(raw.rawBody, undefined);
    assert.deepEqual(raw.wire.toolCalls, [
        { index: 0, id: "call-1", type: "function", name: "READ", arguments: '{"path":"example.txt"}' },
    ]);
    assert.deepEqual(raw.wire.channels, { refusal: "retained vendor text" });
    const report = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(report, /wire: .*tool call READ\(/);
    assert.match(report, /refusal: retained vendor text/);
});
