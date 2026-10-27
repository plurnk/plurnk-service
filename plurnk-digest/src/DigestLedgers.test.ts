import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRequestCapacity, type ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Digest from "./Digest.ts";
import DigestRender from "./DigestRender.ts";
import type { DigestEvidence, EvidencePacket, EvidenceRows } from "./evidence.ts";
import type { ModelCallRow, ProviderRequestRow, TurnAttemptRow, TurnRow } from "./digest-rows.ts";

const textWeight = (text: string): number => Math.ceil(text.length / 2);

const emptyRows = (overrides: Partial<EvidenceRows> = {}): EvidenceRows => ({
    workspaces: [], sessions: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
    turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
    reasoningRows: [], curationEffects: [], sessionRollupRows: [], opMixRows: [], environmentRows: [],
    searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
    derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
    storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
    ...overrides,
});

const makeEvidence = (rows: Partial<EvidenceRows>, packets = new Map<number, EvidencePacket>()): DigestEvidence => ({
    rows: () => emptyRows(rows),
    packet: (turn) => ({ packet: packets.get(turn.id) ?? null, packetFailure: null }),
    response: () => JSON.stringify({ assistant: { content: "emission", reasoning: null, finishReason: "stop", model: "mock" } }),
    request: () => null,
    reasoning: () => null,
    textWeight,
    [Symbol.dispose]: () => {},
});

const SYSTEM = "You are the analyst. Keep the system prompt byte-identical across turns.";
const LOG = ["1: READ docs/a.md", "2: READ docs/b.md", "3: EDIT docs/a.md"];

const makePacket = (turn: number, systemContent = SYSTEM): EvidencePacket => {
    const userContent = `## Log\n\n${LOG.slice(0, turn).join("\n")}`;
    return {
        assistant: { content: "emission", reasoning: null },
        assistantRaw: null,
        attributions: [],
        attachments: [],
        weight: textWeight(systemContent) + textWeight(userContent),
        budget: null,
        slot: (name) => name === "system" ? systemContent : userContent,
        messages: () => [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
        ],
    };
};

const promptText = (packet: EvidencePacket): string =>
    packet.messages().map(({ role, content }) => `${role}\n${content}`).join("\n");

class LedgerFixtureBuilder {
    turns: TurnRow[] = [];
    modelCalls: ModelCallRow[] = [];
    turnAttempts: TurnAttemptRow[] = [];
    providerRequests: ProviderRequestRow[] = [];
    packets = new Map<number, EvidencePacket>();

    addTurn(loopId: number, sequence: number, packet: EvidencePacket | null, status = 200): number {
        const id = this.turns.length + 1;
        this.turns.push({
            id, loop_id: loopId, sequence, producer: "model", kind: "inference",
            status, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z",
            has_packet: packet === null ? 0 : 1, has_reasoning: 0,
            finish_reason: "stop", model: "mock", meta: "{}", program: "emission", outside: null, packetEchoes: 0,
        });
        if (packet !== null) this.packets.set(id, packet);
        return id;
    }

    addCall(
        workspaceId: number,
        sessionId: number,
        loopId: number,
        turnId: number,
        usages: Array<{ input: number | null; cached: number | null }>,
        kind: "emission" | "bare" = "emission",
    ): number[] {
        const callId = this.modelCalls.length + 1;
        const attemptId = kind === "emission" ? this.turnAttempts.length + 1 : null;
        this.modelCalls.push({
            id: callId, workspace_id: workspaceId, turn_id: turnId, sequence: 1, kind,
            state: "response", failure: null, capacity: null, attributions: "[]",
            finish_reason: "stop", model: "mock", request_model: "mock", response_model: "mock",
            timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z",
            turn_attempt_id: attemptId, accepted: kind === "emission" ? 1 : null, parse_errors: "[]", log_entry_id: null,
        });
        if (attemptId !== null) {
            this.turnAttempts.push({
                id: attemptId, model_call_id: callId, turn_id: turnId, sequence: 1, kind: "emission",
                state: "response", accepted: 1, failure: null, parse_errors: "[]", attributions: "[]",
                finish_reason: "stop", model: "mock", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z",
                request_model: "mock", response_model: "mock",
            });
        }
        const ids: number[] = [];
        for (const [idx, { input, cached }] of usages.entries()) {
            const reqId = this.providerRequests.length + 1;
            const accounting: ProviderRequestAccounting = {
                provider: "provider:mock",
                model: "mock",
                outcome: "response",
                usage: {
                    ...(input === null ? {} : { inputTokens: input, totalTokens: input + 5 }),
                    outputTokens: 5,
                    ...(cached === null ? {} : { inputTokenDetails: { cacheReadTokens: cached } }),
                    outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
                },
                cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
            };
            this.providerRequests.push({
                id: reqId,
                inference_call_id: callId,
                turn_attempt_id: attemptId,
                kind,
                turn_id: turnId,
                loop_id: loopId,
                session_id: sessionId,
                workspace_id: workspaceId,
                sequence: idx + 1,
                provider: "provider:mock",
                model: "mock",
                state: "settled",
                outcome: "response",
                status: 200,
                usage_input: input,
                usage_output: 5,
                usage_total: input === null ? null : input + 5,
                usage_input_no_cache: null,
                usage_input_cache_read: cached,
                usage_input_cache_write: null,
                usage_output_text: 5,
                usage_output_reasoning: 0,
                cost_kind: "estimated",
                cost_amount: "0.01",
                cost_currency: "USD",
                cost_usd_equivalent: "0.01",
                cost_source: "fixture",
                cost_reason: null,
                started_at: "2026-10-12T00:00:00Z",
                completed_at: "2026-10-12T00:00:01Z",
                accounting,
            });
            ids.push(reqId);
        }
        return ids;
    }
}

test("{§digest-forensic-fidelity}: consecutive requests of a loop carry their shared prefix beside the reported cache read", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cache-ledger-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "cache.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const b = new LedgerFixtureBuilder();
    const requestIds: number[] = [];
    for (const [index, cacheRead] of ([0, 7, null] as Array<number | null>).entries()) {
        const turnId = b.addTurn(1, index + 1, makePacket(index + 1));
        requestIds.push(...b.addCall(1, 1, 1, turnId, [{ input: 100, cached: cacheRead }]));
    }
    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "cache-ledger" }],
            sessions: [{ id: 1, workspace_id: 1, name: "analyst", provider_identity: "mock", owner: "_plurnk" }],
            loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null }],
            turns: b.turns,
            modelCalls: b.modelCalls,
            turnAttempts: b.turnAttempts,
            providerRequests: b.providerRequests,
            sessionRollupRows: [{ session_id: 1, loops: 1, turns: 3, last_status: 200 }],
        }, b.packets),
    });

    const p1 = promptText(makePacket(1));
    const p2 = promptText(makePacket(2));
    const p3 = promptText(makePacket(3));
    assert.ok(p2.startsWith(p1) && p3.startsWith(p2), "the fixture prompts grow by extension");
    const cacheable = [0, Math.round((100 * textWeight(p1)) / textWeight(p2)), Math.round((100 * textWeight(p2)) / textWeight(p3))];
    assert.ok(cacheable[1] > 0 && cacheable[1] < 100 && cacheable[2] > 0 && cacheable[2] < 100, "the fixture prefixes are proper shares of the reported input");

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
    assert.match(turnLines[0], / cost=\$0\.01 cache=0\/100(?: |$)/u, "the denominator is reported input, including the loop's first request");
    assert.match(turnLines[1], / cost=\$0\.01 cache=7\/100(?: |$)/u);
    assert.match(turnLines[2], / cost=\$0\.01 cache=\?\/100(?: |$)/u, "a provider that reported no cache field reads as ?");
    assert.match(
        markdown,
        /^## Workspace #\d+ — cache-ledger\n\nCache: 7 of 200 reported input tokens read from cache \(3.5%\) over 2 requests · 1 missing input or cache usage \(excluded\)$/mu,
        "the workspace line sums reported requests and names the unreported one apart",
    );
});

test("{§digest-forensic-fidelity}: measured cache ratios include first requests, cross-loop reuse, retries and missing packets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cache-boundaries-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "cache.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const b = new LedgerFixtureBuilder();
    const t1 = b.addTurn(1, 1, makePacket(1));
    b.addCall(1, 1, 1, t1, [{ input: 100, cached: 80 }, { input: 100, cached: 90 }]);
    const changed = makePacket(2, "A different prompt");
    b.addCall(1, 1, 1, b.addTurn(1, 2, changed), [{ input: 100, cached: 95 }]);
    b.addCall(1, 1, 2, b.addTurn(2, 1, makePacket(1)), [{ input: 100, cached: 99 }]);
    b.addCall(1, 1, 2, b.addTurn(2, 2, null), [{ input: 100, cached: 60 }]);
    for (const [index, usage] of [
        { input: 100, cached: null }, { input: null, cached: 20 }, { input: null, cached: null }, { input: 0, cached: 0 },
    ].entries()) {
        b.addCall(1, 1, 2, b.addTurn(2, index + 3, makePacket(1)), [usage]);
    }

    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "cache-boundaries" }],
            sessions: [{ id: 1, workspace_id: 1, name: "analyst", provider_identity: "mock", owner: "_plurnk" }],
            loops: [
                { id: 1, session_id: 1, sequence: 1, status: 200, prompt: "first", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
                { id: 2, session_id: 1, sequence: 2, status: 200, prompt: "second", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
            ],
            turns: b.turns,
            modelCalls: b.modelCalls,
            turnAttempts: b.turnAttempts,
            providerRequests: b.providerRequests,
            sessionRollupRows: [{ session_id: 1, loops: 2, turns: b.turns.length, last_status: 200 }],
        }, b.packets),
    });

    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        provider_requests: Array<{ adjacentPrefixTokensEstimate: number | null; cachedTokens: number | null; inputTokens: number | null }>;
    };
    const requests = json.provider_requests;
    assert.equal(requests.length, 9, "every physical request is accounted, including retries");
    assert.deepEqual(requests.map(({ cachedTokens, inputTokens }) => [cachedTokens, inputTokens]),
        [[80, 100], [90, 100], [95, 100], [99, 100], [60, 100], [null, 100], [20, null], [null, null], [0, 0]]);
    assert.equal(requests[0].adjacentPrefixTokensEstimate, 0);
    assert.equal(requests[1].adjacentPrefixTokensEstimate, 100);
    assert.ok(requests[2].adjacentPrefixTokensEstimate! < 95, "the local prefix estimate is not a cache-read limit");
    assert.equal(requests[3].adjacentPrefixTokensEstimate, 0, "a new loop resets only the adjacent-prefix diagnostic");
    assert.equal(requests[4].adjacentPrefixTokensEstimate, null, "missing packets affect only the optional prefix estimate");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /Cache: 424 of 500 reported input tokens read from cache \(84.8%\) over 6 requests · 3 missing input or cache usage \(excluded\)/u);
    assert.match(markdown, /cache=170\/200/u, "same-turn physical requests sum both measured quantities");
    assert.match(markdown, /cache=99\/100/u);
    assert.match(markdown, /cache=20\/\?/u);
    assert.match(markdown, /cache=0\/0/u, "reported zero remains zero, not missing");
});

test("{§digest-forensic-fidelity}: BARE usage is measured without borrowing its parent's emission packet", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cache-bare-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "cache.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const b = new LedgerFixtureBuilder();
    const t1 = b.addTurn(1, 1, makePacket(1));
    b.addCall(1, 1, 1, t1, [{ input: 100, cached: 80 }]);
    b.addCall(1, 1, 1, t1, [{ input: 20, cached: 5 }], "bare");
    b.addCall(1, 1, 1, b.addTurn(1, 2, makePacket(2)), [{ input: 100, cached: 90 }]);

    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "cache-bare" }],
            sessions: [{ id: 1, workspace_id: 1, name: "analyst", provider_identity: "mock", owner: "_plurnk" }],
            loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null }],
            turns: b.turns,
            modelCalls: b.modelCalls,
            turnAttempts: b.turnAttempts,
            providerRequests: b.providerRequests,
            sessionRollupRows: [{ session_id: 1, loops: 1, turns: 2, last_status: 200 }],
        }, b.packets),
    });

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

test("{§digest-forensic-fidelity}: zero and wholly unreported input have no invented percentage", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cache-unknown-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "cache.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const b = new LedgerFixtureBuilder();
    b.addCall(1, 1, 1, b.addTurn(1, 1, makePacket(1)), [{ input: 0, cached: 0 }]);
    b.addCall(2, 2, 2, b.addTurn(2, 1, makePacket(1)), [{ input: null, cached: null }]);

    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "cache-zero" }, { id: 2, name: "cache-unknown" }],
            sessions: [
                { id: 1, workspace_id: 1, name: "analyst", provider_identity: "mock-1", owner: "_plurnk" },
                { id: 2, workspace_id: 2, name: "analyst", provider_identity: "mock-2", owner: "_plurnk" },
            ],
            loops: [
                { id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
                { id: 2, session_id: 2, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
            ],
            turns: b.turns,
            modelCalls: b.modelCalls,
            turnAttempts: b.turnAttempts,
            providerRequests: b.providerRequests,
            sessionRollupRows: [
                { session_id: 1, loops: 1, turns: 1, last_status: 200 },
                { session_id: 2, loops: 1, turns: 1, last_status: 200 },
            ],
        }, b.packets),
    });

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /cache-zero\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 1 request\n/u);
    assert.match(markdown, /cache-unknown\n\nCache: 0 of 0 reported input tokens read from cache \(n\/a\) over 0 requests · 1 missing input or cache usage \(excluded\)/u);
});

test("{§digest-forensic-fidelity}: the session summary measures the room the model was shown against the provider's capacity and count", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-room-line-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "room.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const capacityOf = (tokens: number) => assessRequestCapacity({
        contextWindow: 86_016, maxInputTokens: null, maxOutputTokens: null,
        outputBudget: 24_576, outputFloor: 8_602, reasoningBudget: 16_384,
        measurement: { kind: "exact", tokens, source: "llama-server:/v1/chat/completions/input_tokens" },
    });
    const packetAt = (weight: number, budget: number): EvidencePacket => ({
        assistant: { content: "ok", reasoning: null },
        assistantRaw: null,
        attributions: [],
        attachments: [],
        weight,
        budget,
        slot: () => "system",
        messages: () => [{ role: "system", content: "system" }],
    });
    const packets = new Map<number, EvidencePacket>([
        [1, packetAt(91_030, 91_987)],
        [2, packetAt(95_714, 91_987)],
    ]);
    const accounting: ProviderRequestAccounting = {
        provider: "provider:fixture", model: "qwen", outcome: "response",
        usage: { inputTokens: 75_448, outputTokens: 1, totalTokens: 75_449 },
        cost: { kind: "unknown", reason: "fixture" },
    };

    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "room-line" }],
            sessions: [
                { id: 1, workspace_id: 1, name: "bench", provider_identity: "mock-1", owner: "_plurnk" },
                { id: 2, workspace_id: 1, name: "quiet", provider_identity: "mock-2", owner: "_plurnk" },
            ],
            loops: [
                { id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
                { id: 2, session_id: 2, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
            ],
            turns: [
                { id: 1, loop_id: 1, sequence: 20, producer: "model", kind: "inference", status: 102, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "qwen", meta: "{}", program: "ok", outside: null, packetEchoes: 0 },
                { id: 2, loop_id: 1, sequence: 21, producer: "model", kind: "inference", status: 413, timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", has_packet: 1, has_reasoning: 0, finish_reason: null, model: "qwen", meta: "{}", program: "ok", outside: null, packetEchoes: 0 },
            ],
            modelCalls: [
                { id: 1, workspace_id: 1, turn_id: 1, sequence: 1, kind: "emission", state: "response", failure: null, capacity: JSON.stringify(capacityOf(75_448)), attributions: "[]", finish_reason: "stop", model: "qwen", request_model: "qwen", response_model: "qwen", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", turn_attempt_id: 1, accepted: 1, parse_errors: "[]", log_entry_id: null },
                { id: 2, workspace_id: 1, turn_id: 2, sequence: 1, kind: "emission", state: "error", failure: JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 413 }), capacity: JSON.stringify(capacityOf(78_492)), attributions: "[]", finish_reason: null, model: "qwen", request_model: "qwen", response_model: null, timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", turn_attempt_id: 2, accepted: null, parse_errors: "[]", log_entry_id: null },
            ],
            turnAttempts: [
                { id: 1, model_call_id: 1, turn_id: 1, sequence: 1, kind: "emission", state: "response", accepted: 1, failure: null, parse_errors: "[]", attributions: "[]", finish_reason: "stop", model: "qwen", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", request_model: "qwen", response_model: "qwen" },
                { id: 2, model_call_id: 2, turn_id: 2, sequence: 1, kind: "emission", state: "error", accepted: null, failure: JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 413 }), parse_errors: "[]", attributions: "[]", finish_reason: null, model: "qwen", timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", request_model: "qwen", response_model: null },
            ],
            providerRequests: [
                { id: 1, inference_call_id: 1, turn_attempt_id: 1, kind: "emission", turn_id: 1, loop_id: 1, session_id: 1, workspace_id: 1, sequence: 1, provider: "provider:fixture", model: "qwen", state: "settled", outcome: "response", status: 200, usage_input: 75_448, usage_output: 1, usage_total: 75_449, usage_input_no_cache: null, usage_input_cache_read: null, usage_input_cache_write: null, usage_output_text: 1, usage_output_reasoning: 0, cost_kind: "unknown", cost_amount: null, cost_currency: null, cost_usd_equivalent: null, cost_source: null, cost_reason: "fixture", started_at: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", accounting },
            ],
            sessionRollupRows: [
                { session_id: 1, loops: 1, turns: 2, last_status: 413 },
                { session_id: 2, loops: 1, turns: 0, last_status: null },
            ],
        }, packets),
    });

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /^Room: {7}budget up to 124% of capacity · wall estimate -19\.4% to -18\.6% of the count {2}⚠ 1 over the wall the estimate admitted$/mu);
    assert.match(markdown, /^Room: {7}\(no measured requests\)$/mu, "a session without measured requests says so");
});

test("{§digest-forensic-fidelity}: a settled request without usage is named on the Cost line", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-usageless-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "usageless.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "digest");

    const b = new LedgerFixtureBuilder();
    const t1 = b.addTurn(1, 1, makePacket(1));
    b.addCall(1, 1, 1, t1, [{ input: 10, cached: 0 }]);
    const t2 = b.addTurn(1, 2, makePacket(1));
    const erroredAccounting: ProviderRequestAccounting = {
        provider: "provider:mock", model: "mock", outcome: "error", status: 400,
        cost: { kind: "unknown", reason: "the provider response reported no normalized usage" },
    };
    b.modelCalls.push({
        id: 2, workspace_id: 1, turn_id: t2, sequence: 1, kind: "emission", state: "error",
        failure: JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 400 }),
        capacity: null, attributions: "[]", finish_reason: null, model: "mock", request_model: "mock", response_model: null,
        timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z",
        turn_attempt_id: 2, accepted: null, parse_errors: "[]", log_entry_id: null,
    });
    b.turnAttempts.push({
        id: 2, model_call_id: 2, turn_id: t2, sequence: 1, kind: "emission", state: "error",
        accepted: null, failure: JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 400 }),
        parse_errors: "[]", attributions: "[]", finish_reason: null, model: "mock",
        timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z",
        request_model: "mock", response_model: null,
    });
    b.providerRequests.push({
        id: 2, inference_call_id: 2, turn_attempt_id: 2, kind: "emission", turn_id: t2, loop_id: 1, session_id: 1, workspace_id: 1,
        sequence: 1, provider: "provider:mock", model: "mock", state: "settled", outcome: "error", status: 400,
        usage_input: null, usage_output: null, usage_total: null, usage_input_no_cache: null, usage_input_cache_read: null,
        usage_input_cache_write: null, usage_output_text: null, usage_output_reasoning: null,
        cost_kind: "unknown", cost_amount: null, cost_currency: null, cost_usd_equivalent: null, cost_source: null,
        cost_reason: "the provider response reported no normalized usage",
        started_at: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", accounting: erroredAccounting,
    });

    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => makeEvidence({
            workspaces: [{ id: 1, name: "usage-less" }],
            sessions: [{ id: 1, workspace_id: 1, name: "biller", provider_identity: "mock", owner: "_plurnk" }],
            loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null }],
            turns: b.turns,
            modelCalls: b.modelCalls,
            turnAttempts: b.turnAttempts,
            providerRequests: b.providerRequests,
            sessionRollupRows: [{ session_id: 1, loops: 1, turns: 2, last_status: 200 }],
        }, b.packets),
    });

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(
        markdown,
        /Cost: {7}\$0\.01 \+ \? \(incomplete\) \(estimated — catalog rates\) \(\+1 usage-less request — server-side spend unrecorded\)/,
        "the Cost line names the usage-less exchange",
    );
    assert.match(markdown, /input=10\+\? output=5\+\?/);
    const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.equal(digest.workspaces[0].accounting.costUsd, null);
    assert.equal(digest.workspaces[0].accounting.knownCostUsd, "0.01");
});

test("{§digest-forensic-fidelity}: editForm classifies every authored EDIT scope and pattern", () => {
    assert.equal(DigestRender.editForm({ line_marker: null, pattern: "/foo/" }), "pattern");
    assert.equal(DigestRender.editForm({ line_marker: null, pattern: null }), "whole");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: ["abcde"] }), pattern: null }), "hash");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [-1] }), pattern: null }), "append");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [0] }), pattern: null }), "prepend");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [12] }), pattern: null }), "line");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [12, 20] }), pattern: null }), "range");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: ["abcde", 1, 2] }), pattern: null }), "offset");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [5, 1, 5, 1] }), pattern: null }), "insert");
    assert.equal(DigestRender.editForm({ line_marker: JSON.stringify({ marks: [5, 2, 5, 8] }), pattern: null }), "column");
});
