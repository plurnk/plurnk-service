// {§provider-request-accounting} Provider reasoning usage persists as cardinal request and digest evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Digest from "../../src/digest/Digest.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("output reasoning usage is persisted and exposed by the digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-usage-reasoning-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, `ur-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const resp: MockResponse = {
            assistant: { content: "", reasoning: "thought hard", ops: [sendStmt(200, null, "done")] },
            usage: {
                inputTokens: 100,
                outputTokens: 57,
                totalTokens: 157,
                inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0 },
                outputTokenDetails: { textTokens: 20, reasoningTokens: 37 },
            },
        };
        const provider = new Mock({ contextWindow: 100000, responses: [resp] });
        const r = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const requests = await db.test_provider_requests.all<{
            usage_output: number;
            usage_output_text: number;
            usage_output_reasoning: number;
        }>({ turn_id: r.turnId });
        assert.deepEqual(requests.map(({ usage_output, usage_output_text, usage_output_reasoning }) => ({
            usage_output,
            usage_output_text,
            usage_output_reasoning,
        })), [{
            usage_output: 57,
            usage_output_text: 20,
            usage_output_reasoning: 37,
        }]);
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ accounting: { usage: { outputTokenDetails: { reasoningTokens: number } } } }>;
        };
        assert.match(markdown, /input=100 output=57 reasoning=37 cache-read=0/);
        assert.equal(json.turns.at(-1)?.accounting.usage.outputTokenDetails.reasoningTokens, 37,
            "the packet-bearing model turn retains reasoning usage after packetless initialization");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
