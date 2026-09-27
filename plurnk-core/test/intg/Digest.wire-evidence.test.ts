import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { digestStems } from "./_packet.ts";

test("{§provider-wire-emission}: blank emissions retain their wire channels through persistence and digest", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "wire-evidence-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    let requests = 0;
    const provider = new AiSdkProvider({
        model: "wire-evidence", url: "https://example.test/v1/chat/completions",
        fetchTimeoutMs: 1000, operationTimeoutMs: 3000, firstContentTimeoutMs: 1000,
        contextWindow: 100000, outputBudget: 1000,
        effort: { mode: "off", budget: null }, temperature: null, repeatPenalty: null, retryAttempts: 0,
        rawBody: false,
        // {§provider-output-dropped}: a tool-call finish is re-issued; the second attempt answers in text.
        fetch: async () => {
            requests += 1;
            if (requests > 1) {
                return new Response(`data: ${JSON.stringify({
                    id: "text", model: "wire-evidence",
                    choices: [{ index: 0, delta: { content: "````KILL\nInspected.\n````" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
                })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            }
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
    assert.equal(requests, 2, "the tool-call finish is re-issued once and the text attempt concludes");
    Digest.run({ dbPath, digestDir });
    const stems = await digestStems(digestDir);
    // The rejected attempt keeps its wire channels as evidence; the retried attempt is the turn's emission.
    const rejected = JSON.parse(await readFile(join(digestDir, `${stems[1]}.attempt001.rejected.response.json`), "utf8"));
    assert.equal(rejected.assistantRaw.rawBody, undefined);
    assert.deepEqual(rejected.assistantRaw.wire.toolCalls, [
        { index: 0, id: "call-1", type: "function", name: "READ", arguments: '{"path":"example.txt"}' },
    ]);
    assert.deepEqual(rejected.assistantRaw.wire.channels, { refusal: "retained vendor text" });
    assert.equal(await readFile(join(digestDir, `${stems[1]}.assistant.md`), "utf8"), "````KILL\nInspected.\n````");
    const report = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(report, /rejected-emissions=1\/2/);
    assert.match(report, /ended the response with tool calls although no tools were declared/);
});
