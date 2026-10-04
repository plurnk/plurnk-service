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
    // The surveys are the initialization program; with the preview off there is none and no digest stem for it.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "wire-evidence-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        let requests = 0;
        const provider = new AiSdkProvider({
            model: "wire-evidence", url: "https://example.test/v1/chat/completions",
            fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            contextWindow: 100000, outputBudget: 1000,
            effort: { mode: "off", budget: null }, temperature: null, repeatPenalty: null, retryAttempts: 0,
            rawBody: false,
            // {§provider-native-tool-calls}: ordinary empty-turn recovery follows the warning.
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
            const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Inspect." }] });
            assert.equal(result.result.status, 200);
            assert.equal(result.turnIds.length, 3, "initialization, one empty turn, then the answer");
            const first = result.turnIds[1]!;
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "no provider retry or parser rejection");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: first });
            assert.deepEqual(rows.filter(({ op }) => op === "error").map(({ rx }) => JSON.parse(rx).problem.detail), ["The turn performed no operation."]);
        } finally {
            await db.close();
        }
        assert.equal(requests, 2, "the model recovers on the next ordinary turn");
        Digest.run({ dbPath, digestDir });
        const stems = await digestStems(digestDir);
        const raw = JSON.parse(await readFile(join(digestDir, `${stems[1]}.assistantRaw.json`), "utf8"));
        assert.equal(raw.rawBody, undefined);
        assert.deepEqual(raw.wire.toolCalls, [
            { index: 0, id: "call-1", type: "function", name: "READ", arguments: '{"path":"example.txt"}' },
        ]);
        assert.deepEqual(raw.wire.channels, { refusal: "retained vendor text" });
        assert.equal(await readFile(join(digestDir, `${stems[2]}.assistant.md`), "utf8"), "````KILL\nInspected.\n````");
        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.doesNotMatch(report, /rejected-emissions=/);
        assert.match(await readFile(join(digestDir, `${stems[2]}.user.md`), "utf8"), /native tool calls, but no tools were declared/);
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});
