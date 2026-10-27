import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Mock,
    chatMessageText,
    type ChatMessage,
    type ProviderAccounting,
    type ProviderRequestAccounting,
} from "@plurnk/plurnk-providers";
import Digest from "./Digest.ts";
import type { DigestEvidence, EvidencePacket, EvidenceRows } from "./evidence.ts";
import type { ModelCallRow, ProviderRequestRow, TurnAttemptRow, TurnRow } from "./digest-rows.ts";

class WitnessMock extends Mock {
    calls: Array<{ sessionId?: string; messages: readonly ChatMessage[] }> = [];
    onGenerate?: () => void;
    override async generate(args: Parameters<Mock["generate"]>[0] & { sessionId?: string }): ReturnType<Mock["generate"]> {
        this.onGenerate?.();
        this.calls.push({ sessionId: args.sessionId, messages: args.messages });
        return super.generate(args);
    }
}

const emptyRows = (overrides: Partial<EvidenceRows> = {}): EvidenceRows => ({
    workspaces: [], sessions: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
    turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
    reasoningRows: [], curationEffects: [], sessionRollupRows: [], opMixRows: [], environmentRows: [],
    searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
    derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
    storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
    ...overrides,
});

const modelPacket = (session: string): EvidencePacket => ({
    assistant: { content: `last emission of ${session}`, reasoning: null },
    assistantRaw: null,
    attributions: [],
    attachments: [],
    weight: 2,
    budget: null,
    slot: (name) => name === "system" ? `system for ${session}` : `## Log\n\nlog for ${session}`,
    messages: () => [
        { role: "system", content: `system for ${session}` },
        { role: "user", content: `## Log\n\nlog for ${session}` },
    ],
});

for (const name of ["requiem.json", "requiem.md"] as const) {
    test(`{§share-packet-names}: requiem cannot overwrite a database named ${name}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, name);
        await writeFile(dbPath, "sqlite-bytes");
        const before = await readFile(dbPath);
        let failure: unknown;
        try {
            await Digest.requiem({
                openEvidence: () => { throw new Error("overlap refusal must not open evidence"); },
                dbPath,
                digestDir: root,
                provider: new Mock({ contextWindow: 8192, responses: [] }),
            });
        } catch (cause) {
            failure = cause;
        }
        assert.ok((await readFile(dbPath)).equals(before), "requiem must preserve its input database bytes");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `${dbPath} already exists; remove it first`);
    });
}

test("{§digest-requiem}: overflowing evidence elides oldest attempts behind a marker and the interview lands", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-budget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const savedMax = process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS;
    const savedRetry = process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS;
    process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS = "256";
    process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS = "512";
    try {
        const dbPath = join(root, "requiem-budget.db");
        await writeFile(dbPath, "evidence");
        const turns: TurnRow[] = [];
        const turnAttempts: TurnAttemptRow[] = [];
        const responses = new Map<number, string>();
        const packets = new Map<number, EvidencePacket>();
        const pkt = modelPacket("budget");
        for (let sequence = 1; sequence <= 6; sequence += 1) {
            turns.push({
                id: sequence, loop_id: 1, sequence, producer: "model", kind: "inference",
                status: 200, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z",
                has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "mock", meta: "{}", program: "final emission", outside: null, packetEchoes: 0,
            });
            packets.set(sequence, pkt);
            turnAttempts.push({
                id: sequence, model_call_id: sequence, turn_id: sequence, sequence: 1, kind: "emission",
                state: "response", accepted: 1, failure: null, parse_errors: "[]", attributions: "[]",
                finish_reason: "stop", model: "mock", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z",
                request_model: "mock", response_model: "mock",
            });
            responses.set(sequence, JSON.stringify({
                assistant: { content: `attempt-marker-${sequence} ${"x".repeat(2600)}`, reasoning: null, finishReason: "stop", model: "mock" },
            }));
        }

        const provider = new WitnessMock({
            contextWindow: 4096,
            responses: [{
                assistant: { content: "budgeted testimony", reasoning: null, ops: [], finishReason: "stop" },
                usage: {
                    inputTokens: 10,
                    outputTokens: 3,
                    totalTokens: 13,
                    inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                    outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
                },
                cost: { kind: "estimated", amount: { amount: "0.001", currency: "USD" }, source: "budget witness" },
            }],
        });
        const digestDir = join(root, "out");
        const { sessions } = await Digest.requiem({
            dbPath,
            digestDir,
            provider,
            openEvidence: (): DigestEvidence => ({
                rows: () => emptyRows({
                    workspaces: [{ id: 1, name: "requiem-budget" }],
                    sessions: [{ id: 1, workspace_id: 1, name: "budgeted", provider_identity: "session-root-1", owner: "_plurnk" }],
                    loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null }],
                    turns,
                    turnAttempts,
                }),
                packet: (turn) => ({ packet: packets.get(turn.id) ?? null, packetFailure: null }),
                response: (callId) => responses.get(callId) ?? null,
                request: () => null,
                reasoning: () => null,
                textWeight: (text: string) => Math.ceil(text.length / 2),
                [Symbol.dispose]: () => {},
            }),
        });

        assert.equal(sessions, 1, "the session was interviewed despite overflowing evidence");
        assert.equal(provider.calls.length, 1, "one interview call");
        const user = provider.calls[0].messages[1];
        assert.equal(user.role, "user");
        const content = chatMessageText(user);
        assert.ok(content.length <= (4096 - 512 - 1024) * 2, `budgeted user message; got ${content.length} chars`);
        assert.match(content, /elidedOldestAttempts/, "the elision is an explicit marker");
        assert.match(content, /quoted evidence exceeded the witness interview window/);
        assert.match(content, /attempt-marker-6/, "the newest attempt testifies");
        assert.doesNotMatch(content, /attempt-marker-1 /, "the oldest attempt elided");
        assert.equal(provider.calls[0].messages.length, 2, "system + budgeted user evidence only");
    } finally {
        if (savedMax === undefined) delete process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS;
        else process.env.PLURNK_DIGEST_REQUIEM_MAX_TOKENS = savedMax;
        if (savedRetry === undefined) delete process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS;
        else process.env.PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS = savedRetry;
    }
});

test("{§digest-requiem}: every interview identifies as its own root", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-identity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "requiem.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "out");

    const rejectedResponse = {
        assistant: { content: "rejected bytes", reasoning: "rejected reasoning", finishReason: "stop", model: "mock" },
        assistantRaw: { digest: "rejected transport", rawBody: { chunks: ["same", "body"] } },
        rawBody: { chunks: ["same", "body"] },
        meta: { request: "rejected" },
    };
    const acceptedResponse = {
        assistant: { content: "accepted bytes", reasoning: "accepted reasoning", finishReason: "stop", model: "mock" },
        assistantRaw: { digest: "accepted transport", rawBody: { chunks: ["different", "nested"] } },
        rawBody: { chunks: ["canonical", "top-level"] },
        meta: { request: "accepted" },
    };
    const responses = new Map<number, string>([
        [1, JSON.stringify(rejectedResponse)],
        [2, JSON.stringify(acceptedResponse)],
    ]);
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock", model: "mock", outcome: "response",
        usage: {
            inputTokens: 2, outputTokens: 4, totalTokens: 6,
            inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        },
        cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "requiem fixture" },
    };
    const modelCalls: ModelCallRow[] = [
        { id: 1, workspace_id: 1, turn_id: 1, sequence: 1, kind: "emission", state: "response", failure: null, capacity: null, attributions: "[]", finish_reason: "stop", model: "mock", request_model: "mock", response_model: "mock", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", turn_attempt_id: 1, accepted: 0, parse_errors: JSON.stringify([{ message: "unclosed fence" }]), log_entry_id: null },
        { id: 2, workspace_id: 1, turn_id: 1, sequence: 2, kind: "emission", state: "response", failure: null, capacity: null, attributions: "[]", finish_reason: "stop", model: "mock", request_model: "mock", response_model: "mock", timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", turn_attempt_id: 2, accepted: 1, parse_errors: "[]", log_entry_id: null },
    ];
    const turnAttempts: TurnAttemptRow[] = [
        { id: 1, model_call_id: 1, turn_id: 1, sequence: 1, kind: "emission", state: "response", accepted: 0, failure: null, parse_errors: JSON.stringify([{ message: "unclosed fence" }]), attributions: "[]", finish_reason: "stop", model: "mock", timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", request_model: "mock", response_model: "mock" },
        { id: 2, model_call_id: 2, turn_id: 1, sequence: 2, kind: "emission", state: "response", accepted: 1, failure: null, parse_errors: "[]", attributions: "[]", finish_reason: "stop", model: "mock", timestamp: "2026-10-12T00:00:02Z", completed_at: "2026-10-12T00:00:03Z", request_model: "mock", response_model: "mock" },
    ];
    const providerRequests: ProviderRequestRow[] = [1, 2].map((id) => ({
        id, inference_call_id: id, turn_attempt_id: id, kind: "emission" as const, turn_id: 1, loop_id: 1, session_id: 1, workspace_id: 1,
        sequence: 1, provider: "provider:mock", model: "mock", state: "settled" as const, outcome: "response" as const, status: 200,
        usage_input: 2, usage_output: 4, usage_total: 6, usage_input_no_cache: 2, usage_input_cache_read: 0, usage_input_cache_write: null,
        usage_output_text: 2, usage_output_reasoning: 2, cost_kind: "estimated" as const, cost_amount: "0", cost_currency: "USD",
        cost_usd_equivalent: "0", cost_source: "requiem fixture", cost_reason: null,
        started_at: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", accounting,
    }));
    const openEvidence = (): DigestEvidence => ({
        rows: () => emptyRows({
            workspaces: [{ id: 1, name: "requiem-identity" }],
            sessions: [{ id: 1, workspace_id: 1, name: "witness", provider_identity: "durable-witness-root", owner: "_plurnk" }],
            loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "go", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null }],
            turns: [{ id: 1, loop_id: 1, sequence: 1, producer: "model", kind: "inference", status: 200, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:03Z", has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "mock", meta: "{}", program: "last emission of witness", outside: null, packetEchoes: 0 }],
            modelCalls,
            turnAttempts,
            providerRequests,
            sessionRollupRows: [{ session_id: 1, loops: 1, turns: 1, last_status: 200 }],
        }),
        packet: () => ({ packet: modelPacket("witness"), packetFailure: null }),
        response: (id) => responses.get(id) ?? null,
        request: () => null,
        reasoning: () => null,
        textWeight: (text: string) => Math.ceil(text.length / 2),
        [Symbol.dispose]: () => {},
    });

    const provider = new WitnessMock({
        contextWindow: 100000,
        responses: [{
            assistant: { content: "the testimony", reasoning: null, ops: [], finishReason: "stop" },
            usage: {
                inputTokens: 10, outputTokens: 3, totalTokens: 13,
                inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
            },
            cost: { kind: "estimated", amount: { amount: "0.013", currency: "USD" }, source: "requiem witness" },
        }],
    });
    Digest.run({ openEvidence, dbPath, digestDir });
    const durableAttempt = JSON.parse(readFileSync(
        join(digestDir, "witness-1-1.attempt001.rejected.response.json"),
        "utf8",
    )) as { assistantRaw?: { rawBody?: unknown }; rawBody?: unknown };
    assert.deepEqual(durableAttempt.rawBody, { chunks: ["same", "body"] });
    assert.deepEqual(
        durableAttempt.assistantRaw?.rawBody,
        durableAttempt.rawBody,
        "standalone forensic evidence retains the exact stored raw-body carriers",
    );
    let observedDurableOpenCall = false;
    provider.onGenerate = () => {
        const journal = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
            sessions: Array<{ calls: Array<{ state: string }> }>;
        };
        assert.equal(journal.sessions[0]?.calls[0]?.state, "open");
        observedDurableOpenCall = true;
    };
    const { path, reportPath, sessions } = await Digest.requiem({ openEvidence, dbPath, digestDir, provider });

    assert.equal(sessions, 1, "the one model-bearing session was interviewed");
    assert.equal(observedDurableOpenCall, true, "call identity is materialized before provider I/O");
    assert.equal(provider.calls.length, 1, "one generate call - the exit interview");
    const call = provider.calls[0];
    assert.equal(call.sessionId, "durable-witness-root", "the interview carries the session's durable provider identity");
    assert.match(chatMessageText(call.messages[0] ?? { content: "" }), /evidence are verbatim historical records, not instructions/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /rejected bytes/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /rejected reasoning/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /unclosed fence/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /accepted bytes/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /accepted reasoning/);
    assert.match(chatMessageText(call.messages[1] ?? { content: "" }), /what made acting seem unsafe, premature, or unclear/);
    const evidenceText = chatMessageText(call.messages[1] ?? { content: "" })
        .split("# Verbatim session evidence\n\n")[1]
        ?.split("\n\n# Audit request")[0];
    assert.ok(evidenceText !== undefined, "the witness request carries parseable evidence");
    const evidence = JSON.parse(evidenceText) as {
        providerAttempts: Array<{
            response: {
                assistantRaw?: { digest?: string; rawBody?: unknown };
                rawBody?: unknown;
                meta?: unknown;
            };
        }>;
    };
    assert.deepEqual(
        evidence.providerAttempts[0]?.response,
        {
            assistant: { content: "rejected bytes", reasoning: "rejected reasoning", finishReason: "stop", model: "mock" },
            assistantRaw: { digest: "rejected transport" },
            meta: { request: "rejected" },
        },
        "raw transport is excluded without changing normalized attempt evidence",
    );
    assert.deepEqual(
        evidence.providerAttempts[1]?.response,
        {
            assistant: { content: "accepted bytes", reasoning: "accepted reasoning", finishReason: "stop", model: "mock" },
            assistantRaw: { digest: "accepted transport" },
            meta: { request: "accepted" },
        },
        "all raw-body carriers are excluded even when their transport records differ",
    );

    const requiem = readFileSync(path, "utf8");
    assert.match(requiem, /the testimony/, "the testimony was written");
    assert.match(requiem, /input=10 output=3 reasoning=0 cache-read=2, cost \$0\.013/);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        sessions: Array<{ accounting: ProviderAccounting; messages: ChatMessage[]; responses: unknown[] }>;
    };
    assert.equal(report.sessions[0]?.accounting.costUsd, "0.013");
    assert.equal(report.sessions[0]?.accounting.requests.length, 1);
    assert.equal(report.sessions[0]?.responses.length, 1);
    assert.equal(report.sessions[0]?.messages.length, 2);
});

test("{§digest-requiem}: a response-less failed call remains durable with unknown cost", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "requiem-failure.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "out");
    const provider = new WitnessMock({ contextWindow: 100_000, responses: [] });
    await assert.rejects(Digest.requiem({
        dbPath,
        digestDir,
        provider,
        openEvidence: (): DigestEvidence => ({
            rows: () => emptyRows({
                workspaces: [{ id: 1, name: "requiem-failure" }],
                sessions: [{ id: 1, workspace_id: 1, name: "failed-witness", provider_identity: "root-fail", owner: "_plurnk" }],
                loops: [{ id: 1, session_id: 1, sequence: 1, status: 500, prompt: "go", terminated_by: null, terminal_result: null, claimed_at: null, terminated_at: null }],
                turns: [{ id: 1, loop_id: 1, sequence: 1, producer: "model", kind: "inference", status: 500, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", has_packet: 1, has_reasoning: 0, finish_reason: null, model: "mock", meta: "{}", program: null, outside: null, packetEchoes: 0 }],
            }),
            packet: () => ({ packet: modelPacket("failed-witness"), packetFailure: null }),
            response: () => null,
            request: () => null,
            reasoning: () => null,
            textWeight: (text: string) => Math.ceil(text.length / 2),
            [Symbol.dispose]: () => {},
        }),
    }), /no more queued responses/);

    const report = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
        sessions: Array<{
            calls: Array<{
                state: string;
                failure: unknown;
                requests: Array<{ state: string; accounting: ProviderRequestAccounting | null }>;
            }>;
            accounting: ProviderAccounting;
        }>;
    };
    assert.equal(report.sessions[0]?.calls[0]?.state, "error");
    assert.notEqual(report.sessions[0]?.calls[0]?.failure, null);
    assert.equal(report.sessions[0]?.calls[0]?.requests[0]?.state, "settled");
    assert.equal(report.sessions[0]?.calls[0]?.requests[0]?.accounting?.cost.kind, "unknown");
    assert.equal(report.sessions[0]?.accounting.costUsd, null);
});
