import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import ModelCall from "../../src/core/ModelCall.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";

test("{§digest-navigation}: pending, rejected and retired evidence remains distinguishable and navigable", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "request-states-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const rejectedContent = "````EDIT (a.txt)\nunterminated";
    const reasoning = "## Heading in reasoning\n```text\nliteral\n```\n";
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "request-states");
        const workerId = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, workerId, 1, "inspect attempts");
        const turnId = await insertPacketTurn(db, loopId, 1, {
            weight: 0, sections: [{ name: "prompt", slot: "user", header: null, content: "Inspect.", weight: 0 }],
            attributions: [],
        });
        for (const state of ["rejected", "pending", "bare", "unadmitted"] as const) {
            const call = await ModelCall.open(db, { turnId, kind: state === "bare" ? "bare" : "emission", attributions: [], model: "fixture" });
            const attempt = state === "bare" ? undefined
                : await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            const settle = await call.observeRequest({ provider: "fixture", model: "fixture" });
            if (state === "pending" || state === "bare") continue;
            const accounting: ProviderRequestAccounting = {
                provider: "fixture", model: "fixture", outcome: "response",
                cost: { kind: "unknown", reason: "fixture has no billing evidence" },
            };
            await settle(accounting, { content: rejectedContent, reasoning });
            await call.observeResponse({
                assistant: { content: rejectedContent, reasoning, model: "fixture", finishReason: "stop" },
                assistantRaw: null, accounting: [accounting], capacity: testDeferredProviderCapacity(),
            });
            assert.ok(attempt);
            if (state === "rejected") await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 0, parse_errors: '[{"message":"Unclosed operation fence"}]' });
        }
    } finally { await db.close(); }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const request = await readFile(join(digestDir, "witness-1-1.request.md"), "utf8");
    assert.match(request, /\| emission 1 \| rejected \| response \|/u);
    assert.match(request, /\| emission 2 \| not admitted \| pending \|/u);
    assert.match(request, /\| bare 3 \| not an emission \| pending \|/u);
    assert.match(request, /\| emission 4 \| not admitted \| response \|/u);
    assert.match(request, /### Emission attempt 4: unadmitted/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt004.unadmitted.assistant.md"), "utf8"), rejectedContent);
    assert.match(request, /Unclosed operation fence/u);
    assert.match(request, /\[Exact output\]\(witness-1-1\.attempt001\.rejected\.assistant\.md\)/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt001.rejected.assistant.md"), "utf8"), rejectedContent);
    const failurePage = await readFile(join(digestDir, "requests/1.md"), "utf8");
    assert.match(failurePage, /provider returned a response, but Plurnk rejected its emission/u);
    assert.match(failurePage, /Unclosed operation fence/u);
    assert.ok(failurePage.includes(rejectedContent));
    const pendingPage = await readFile(join(digestDir, "requests/2.md"), "utf8");
    assert.match(pendingPage, /Request is unsettled; accounting is not yet available/u);
    assert.match(pendingPage, /No settled response evidence is retained/u);
    assert.doesNotMatch(pendingPage, /admitted response|Partial output/u);
    const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
    assert.ok(chronology.includes(reasoning));
    assert.ok(chronology.includes("````text\n" + reasoning + "\n````"), "reasoning cannot swallow the following attempt heading");
    for (const file of await readdir(digestDir, { recursive: true })) {
        if (!(file.endsWith(".request.md") || file.startsWith("requests/") && file.endsWith(".md") || file === "digest.md")) continue;
        const page = (await readFile(join(digestDir, file), "utf8")).replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gmu, "");
        for (const [, target] of page.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
            await access(join(digestDir, dirname(file), target!));
        }
    }

    const retiring = await openMigrated(dbPath);
    try {
        await retiring.retention_retire_responses.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
        await retiring.retention_retire_packets.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
    } finally { await retiring.close(); }
    const retiredDir = join(dir, "retired-digest");
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: retiredDir });
    assert.match(await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8"), /Response evidence is not retained/u);
    const retiredRequest = await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8");
    assert.match(retiredRequest, /No input message sections are retained/u);
    assert.doesNotMatch(retiredRequest, /## \d+\. (?:system|user)/u, "retired input is not an empty request");
    await assert.rejects(access(join(retiredDir, "witness-1-1.wire.json")), { code: "ENOENT" });
    await assert.rejects(access(join(retiredDir, "witness-1-1.user.md")), { code: "ENOENT" });
    assert.match(await readFile(join(retiredDir, "reasoning.md"), "utf8"), /response evidence is not retained; readable reasoning availability is unknown/u);
    await assert.rejects(access(join(retiredDir, "witness-1-1.attempt001.rejected.assistant.md")), { code: "ENOENT" }, "retired output cannot become a fabricated empty emission");
    assert.ok((await readFile(join(retiredDir, "requests/1.md"), "utf8")).includes(rejectedContent), "retiring normalized responses does not erase physical-request evidence");
});
