// {§digest-cache-ledger} — every provider request carries the prefix it shared with the previous
// request of its loop, in the packet's own token estimate, beside what the provider reported.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { testArtifactPath } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import type { Db } from "../../src/core/Db.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";

const TMP_DIR = testArtifactPath("core");
const SYSTEM = "You are the analyst. Keep the system prompt byte-identical across turns.";
const LOG = ["1: READ docs/a.md", "2: READ docs/b.md", "3: EDIT docs/a.md"];

// Turn N's packet: the fixed system section plus a log that grows by one line per turn.
const packet = (turn: number): DurablePacket => ({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: SYSTEM, weight: contentWeight(SYSTEM) },
        { name: "log", slot: "user", header: "Log", content: LOG.slice(0, turn).join("\n"), weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
});

const prompt = (turn: number): string => {
    const { sections } = packet(turn);
    return `${PacketWire.renderSlot(sections, "system")}${PacketWire.renderSlot(sections, "user")}`;
};

const recordRequest = async (db: Db, turnId: number, cacheReadTokens: number | null): Promise<number> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "mock" });
    if (modelCall === undefined) throw new Error("cache-ledger fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id });
    if (attempt === undefined) throw new Error("cache-ledger fixture attempt did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id, sequence: 1, provider: "provider:mock", model: "mock",
    });
    if (request === undefined) throw new Error("cache-ledger fixture provider request did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock",
        model: "mock",
        outcome: "response",
        usage: {
            inputTokens: 100,
            outputTokens: 5,
            totalTokens: 105,
            // A null cache read is a provider that reported no cache field at all, not a zero.
            ...(cacheReadTokens === null ? {} : { inputTokenDetails: { noCacheTokens: 100 - cacheReadTokens, cacheReadTokens } }),
            outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
        },
        cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
    };
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({ assistant: { content: "emission", reasoning: null, finishReason: "stop", model: "mock" } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("cache-ledger:fixture")),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
    return request.id;
};

test("{§digest-cache-ledger}: consecutive requests of a loop carry their shared prefix beside the reported cache read", async () => {
    const dbPath = join(TMP_DIR, `cache-ledger-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    const requestIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "cache-ledger");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1, "go");
        const cacheReads: Array<number | null> = [0, 7, null];
        for (const [index, cacheRead] of cacheReads.entries()) {
            const turnId = await insertPacketTurn(db, loopId, index + 1, packet(index + 1), 200);
            requestIds.push(await recordRequest(db, turnId, cacheRead));
        }
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `cache-ledger-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });

    // Turn N+1's prompt extends turn N's, so the shared prefix is turn N's whole prompt.
    assert.ok(prompt(2).startsWith(prompt(1)) && prompt(3).startsWith(prompt(2)), "the fixture prompts grow by extension");
    // The prefix's share of the packet estimate, applied to the reported input of 100 tokens.
    const cacheable = [0, Math.round((100 * contentWeight(prompt(1))) / contentWeight(prompt(2))), Math.round((100 * contentWeight(prompt(2))) / contentWeight(prompt(3)))];
    assert.ok(cacheable[1]! > 0 && cacheable[1]! < 100 && cacheable[2]! > 0 && cacheable[2]! < 100, "the fixture prefixes are proper shares of the reported input");

    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ id: number; cacheableTokens: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    assert.deepEqual(
        json.provider_requests.map(({ id, cacheableTokens, cachedTokens, inputTokens }) => ({ id, cacheableTokens, cachedTokens, inputTokens })),
        [
            { id: requestIds[0], cacheableTokens: 0, cachedTokens: 0, inputTokens: 100 },
            { id: requestIds[1], cacheableTokens: cacheable[1], cachedTokens: 7, inputTokens: 100 },
            { id: requestIds[2], cacheableTokens: cacheable[2], cachedTokens: null, inputTokens: 100 },
        ],
    );

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    const turnLines = markdown.split("\n").filter((line) => /^T\d+ \(model turn/u.test(line));
    assert.equal(turnLines.length, 3);
    assert.match(turnLines[0]!, / cost=\$0\.01 cache=0\/0(?: |$)/u, "the loop's first request shares nothing with a predecessor");
    assert.match(turnLines[1]!, new RegExp(` cost=\\$0\\.01 cache=7/${cacheable[1]}(?: |$)`, "u"));
    assert.match(turnLines[2]!, new RegExp(` cost=\\$0\\.01 cache=\\?/${cacheable[2]}(?: |$)`, "u"), "a provider that reported no cache field reads as ?");
    const pct = Math.round((100 * 7) / cacheable[1]!);
    assert.match(
        markdown,
        new RegExp(`^## Workspace #\\d+ — cache-ledger\\n\\nCache: 7 of ${cacheable[1]} cacheable tokens reported \\(${pct}%\\) over 2 requests · 1 unreported \\(cached=\\?\\)$`, "mu"),
        "the workspace line sums reported requests and names the unreported one apart",
    );
});
