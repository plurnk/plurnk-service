// {§digest-cache-ledger}
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

const prompt = (turn: number): string => PacketWire.packetToWireMessages(packet(turn), new Map())
    .map(({ role, content }) => `${role}\n${content}`)
    .join("\n");

const recordRequests = async (db: Db, turnId: number, usage: Array<{ input: number | null; cached: number | null }>, kind: "emission" | "bare" = "emission"): Promise<number[]> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind, attributions: "[]", model: "mock" });
    if (modelCall === undefined) throw new Error("cache-ledger fixture model call did not open");
    const attempt = kind === "emission"
        ? await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id })
        : undefined;
    if (kind === "emission" && attempt === undefined) throw new Error("cache-ledger fixture attempt did not open");
    const requestIds: number[] = [];
    for (const [index, { input, cached }] of usage.entries()) {
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            inference_call_id: modelCall.id, sequence: index + 1, provider: "provider:mock", model: "mock",
        });
        if (request === undefined) throw new Error("cache-ledger fixture provider request did not open");
        const accounting: ProviderRequestAccounting = {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: {
                ...(input === null ? {} : { inputTokens: input, totalTokens: input + 5 }),
                outputTokens: 5,
                // A null cache read is a provider that reported no cache field at all, not a zero.
                ...(cached === null ? {} : { inputTokenDetails: { cacheReadTokens: cached } }),
                outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
            },
            cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
        };
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
        requestIds.push(request.id);
    }
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({ assistant: { content: "emission", reasoning: null, finishReason: "stop", model: "mock" } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("cache-ledger:fixture")),
        finish_reason: "stop",
        model: "mock",
    });
    if (attempt !== undefined) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
    return requestIds;
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
            requestIds.push(...await recordRequests(db, turnId, [{ input: 100, cached: cacheRead }]));
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
        provider_requests: Array<{ id: number; adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    assert.deepEqual(
        json.provider_requests.map(({ id, adjacentPrefixTokensEstimate, cachedTokens, inputTokens }) => ({ id, adjacentPrefixTokensEstimate, cachedTokens, inputTokens })),
        [
            { id: requestIds[0], adjacentPrefixTokensEstimate: 0, cachedTokens: 0, inputTokens: 100 },
            { id: requestIds[1], adjacentPrefixTokensEstimate: cacheable[1], cachedTokens: 7, inputTokens: 100 },
            { id: requestIds[2], adjacentPrefixTokensEstimate: cacheable[2], cachedTokens: null, inputTokens: 100 },
        ],
    );

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    const turnLines = markdown.split("\n").filter((line) => /^T\d+ \(model turn/u.test(line));
    assert.equal(turnLines.length, 3);
    assert.match(turnLines[0]!, / cost=\$0\.01 cache=0\/100(?: |$)/u, "the denominator is reported input, including the loop's first request");
    assert.match(turnLines[1]!, / cost=\$0\.01 cache=7\/100(?: |$)/u);
    assert.match(turnLines[2]!, / cost=\$0\.01 cache=\?\/100(?: |$)/u, "a provider that reported no cache field reads as ?");
    assert.match(
        markdown,
        /^## Workspace #\d+ — cache-ledger\n\nCache: 7 of 200 reported input tokens read from cache \(3.5%\) over 2 requests · 1 missing input or cache usage \(excluded\)$/mu,
        "the workspace line sums reported requests and names the unreported one apart",
    );
});

test("{§digest-cache-ledger}: measured cache ratios include first requests, cross-loop reuse, retries and missing packets", async () => {
    const dbPath = join(TMP_DIR, `cache-boundaries-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "cache-boundaries");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const first = await insertLoop(db, workerId, 1, "first");
        const turn = await insertPacketTurn(db, first, 1, packet(1), 200);
        await recordRequests(db, turn, [{ input: 100, cached: 80 }, { input: 100, cached: 90 }]);
        const changed: DurablePacket = { ...packet(2), sections: [{ name: "system", slot: "system", header: null, content: "A different prompt", weight: 5 }] };
        await recordRequests(db, await insertPacketTurn(db, first, 2, changed, 200), [{ input: 100, cached: 95 }]);
        const second = await insertLoop(db, workerId, 2, "second");
        await recordRequests(db, await insertPacketTurn(db, second, 1, packet(1), 200), [{ input: 100, cached: 99 }]);
        const missing = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: second, sequence: 2 });
        assert.ok(missing);
        await recordRequests(db, missing.id, [{ input: 100, cached: 60 }]);
        for (const [index, usage] of [
            { input: 100, cached: null }, { input: null, cached: 20 }, { input: null, cached: null }, { input: 0, cached: 0 },
        ].entries()) {
            await recordRequests(db, await insertPacketTurn(db, second, index + 3, packet(1), 200), [usage]);
        }
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-boundaries-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    const requests = json.provider_requests;
    assert.equal(requests.length, 9, "every physical request is accounted, including retries");
    assert.deepEqual(requests.map(({ cachedTokens, inputTokens }) => [cachedTokens, inputTokens]),
        [[80, 100], [90, 100], [95, 100], [99, 100], [60, 100], [null, 100], [20, null], [null, null], [0, 0]]);
    assert.equal(requests[0]!.adjacentPrefixTokensEstimate, 0);
    assert.equal(requests[1]!.adjacentPrefixTokensEstimate, 100);
    assert.ok(requests[2]!.adjacentPrefixTokensEstimate! < 95, "the local prefix estimate is not a cache-read limit");
    assert.equal(requests[3]!.adjacentPrefixTokensEstimate, 0, "a new loop resets only the adjacent-prefix diagnostic");
    assert.equal(requests[4]!.adjacentPrefixTokensEstimate, null, "missing packets affect only the optional prefix estimate");
    assert.ok(requests.every((request) => !Object.hasOwn(request, "cacheableTokens")), "the misleading machine-readable name is retired");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /Cache: 424 of 500 reported input tokens read from cache \(84.8%\) over 6 requests · 3 missing input or cache usage \(excluded\)/u);
    assert.match(markdown, /cache=170\/200/u, "same-turn physical requests sum both measured quantities");
    assert.match(markdown, /cache=99\/100/u);
    assert.match(markdown, /cache=20\/\?/u);
    assert.match(markdown, /cache=0\/0/u, "reported zero remains zero, not missing");
});

test("{§digest-cache-ledger}: BARE usage is measured without borrowing its parent's emission packet", async () => {
    const dbPath = join(TMP_DIR, `cache-bare-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "cache-bare");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertPacketTurn(db, loopId, 1, packet(1), 200);
        await recordRequests(db, turnId, [{ input: 100, cached: 80 }]);
        await recordRequests(db, turnId, [{ input: 20, cached: 5 }], "bare");
        await recordRequests(db, await insertPacketTurn(db, loopId, 2, packet(2), 200), [{ input: 100, cached: 90 }]);
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-bare-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ kind: string; adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    assert.deepEqual(json.provider_requests.map(({ kind, adjacentPrefixTokensEstimate, cachedTokens, inputTokens }) =>
        [kind, adjacentPrefixTokensEstimate, cachedTokens, inputTokens]), [
        ["emission", 0, 80, 100],
        ["bare", null, 5, 20],
        ["emission", null, 90, 100],
    ]);
    assert.match(await readFile(join(digestDir, "digest.md"), "utf8"),
        /Cache: 175 of 220 reported input tokens read from cache \(79.5%\) over 3 requests/u);
});

test("{§digest-cache-ledger}: zero and wholly unreported input have no invented percentage", async () => {
    const dbPath = join(TMP_DIR, `cache-unknown-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        for (const [name, usage] of [
            ["cache-zero", { input: 0, cached: 0 }],
            ["cache-unknown", { input: null, cached: null }],
        ] as const) {
            const workspaceId = await insertWorkspace(db, name);
            const workerId = await insertWorker(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, workerId, 1, "go");
            await recordRequests(db, await insertPacketTurn(db, loopId, 1, packet(1), 200), [usage]);
        }
    } finally { await db.close(); }
    const digestDir = join(TMP_DIR, `cache-unknown-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /cache-zero\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 1 request\n/u);
    assert.match(markdown, /cache-unknown\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 0 requests · 1 missing input or cache usage \(excluded\)/u);
});
