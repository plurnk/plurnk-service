import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

for (const capture of [false, true]) {
    test(`{§provider-request-evidence} recovery and digest retain failed output without executing or merging it; capture=${capture}`, async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "failed-request-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const failedContent = "````EDIT (worker:///never.txt)\nMust not execute.\n````";
        let calls = 0;
        const bodies: string[] = [];
        const provider = new AiSdkProvider({
            model: "evidence", url: "https://example.test/v1/chat/completions", streaming: true,
            rawBody: capture, contextWindow: 100_000, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            estimateCost: (usage) => usage === undefined ? { kind: "unknown", reason: "no usage" }
                : { kind: "estimated", amount: { amount: "0.25", currency: "USD" }, source: "fixture rates" },
            fetch: async (_input, init) => {
                calls++;
                bodies.push(String(init?.body));
                return new Response(`data: ${JSON.stringify({
                    id: `request-${calls}`, model: "evidence",
                    choices: [{ index: 0, delta: {
                        content: calls === 1 ? failedContent : "````SEND [200]\nRecovered.\n````",
                        reasoning_content: calls === 1 ? "Partial failed reasoning." : "Fresh reasoning.",
                    }, finish_reason: calls === 1 ? null : "stop" }],
                    ...(calls === 1 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
                })}\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "failed-evidence");
            const workerId = await insertWorker(db, workspaceId, null, "witness");
            const loopId = await insertLoop(db, workerId, 1, "Recover.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 3,
                messages: [{ role: "user", content: "Recover." }] });
            assert.equal(result.result.status, 200);
            assert.equal(calls, 2);
            assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/never.txt", scheme: "worker" }), undefined);
        } finally { await db.close(); }
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(digest.provider_requests.length, 2);
        const [failed, recovered] = await Promise.all(digest.provider_requests.map(async (request: { evidence: string }) =>
            JSON.parse(await readFile(join(digestDir, request.evidence), "utf8"))));
        assert.equal(failed.accounting.outcome, "error");
        assert.equal(failed.accounting.cost.kind, "unknown");
        assert.equal(failed.evidence.content, failedContent);
        assert.equal(failed.evidence.reasoning, "Partial failed reasoning.");
        assert.equal(failed.evidence.rawBody[0].id, "request-1");
        assert.match(failed.evidence.error.message, /without a finish reason/);
        assert.equal(recovered.accounting.outcome, "response");
        assert.equal(recovered.evidence.reasoning, "Fresh reasoning.");
        assert.equal(recovered.evidence.content, "````SEND [200]\nRecovered.\n````");
        assert.equal(digest.workspaces[0].accounting.costUsd, null);
        assert.equal(digest.workspaces[0].accounting.knownCostUsd, "0.25");
        assert.equal(digest.workspaces[0].accounting.usage, null);
        assert.equal(digest.workspaces[0].accounting.knownUsage.inputTokens, 100);
        const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.match(chronology, /Physical request .*requests\/\d+\.md/);
        const failurePage = await readFile(join(digestDir, `requests/${failed.id}.md`), "utf8");
        assert.match(failurePage, /Partial output; this physical request failed/u);
        assert.match(failurePage, /Partial failed reasoning\./u);
        assert.ok(failurePage.includes(failedContent));
        assert.match(failurePage, /without a finish reason/u);
        if (capture) {
            assert.equal(failed.evidence.request.body, bodies[0]);
            assert.equal(recovered.evidence.request.body, bodies[1]);
            assert.ok(failurePage.includes(bodies[0]!));
            assert.match(failurePage, /Exact serialized body/u);
        } else {
            assert.equal(failed.evidence.request, undefined);
            assert.match(failurePage, /Dispatched request body was not retained/u);
        }
        assert.match(failurePage, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.match(failurePage, /unknown/u, "missing usage/cost is not reported as free");
        const recoveredPage = await readFile(join(digestDir, `requests/${recovered.id}.md`), "utf8");
        assert.match(recoveredPage, /Fresh reasoning\./u);
        assert.match(recoveredPage, /Recovered\./u);
        assert.doesNotMatch(recoveredPage, /Partial failed reasoning/u);
    });
}
