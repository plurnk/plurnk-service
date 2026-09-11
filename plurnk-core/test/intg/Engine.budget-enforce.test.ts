// SPEC {§context-output-admission} — the budget overflow recovery. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import { chatMessageText } from "@plurnk/plurnk-providers";
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, ProviderError, validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { ChatMessage, MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, logEntries } from "./_helpers.ts";
import { dispositionStmt } from "./_dsl.ts";
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([dispositionStmt("completed", "ok")]));

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

const plainEngine = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
class DeferredCapacityMock extends Mock {
    override async countPromptTokens() {
        return {
            kind: "estimate" as const,
            tokens: 1,
            source: "test:deferred-capacity",
            detail: "fixture deliberately leaves physical admission to the upstream mock",
        };
    }
}

class ExactCharCapacityMock extends Mock {
    override async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "exact" as const,
            tokens: messages.reduce((sum, { content }) => sum + content.length, 0),
            source: "test:exact-chars",
        };
    }
}

const PROMPT_CAPACITY_SENTINEL = "prompt-capacity-recovery-witness";
const requestChars = (messages: readonly ChatMessage[]): number => messages.reduce((total, message) => total + chatMessageText(message).length, 0);
class UpstreamPromptCapacityMock extends Mock {
    static readonly maxRequestChars = 30_000;
    readonly requests: ChatMessage[][] = [];

    override async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "estimate" as const,
            tokens: messages.reduce((sum, message) => sum + Math.ceil(chatMessageText(message).length / 2), 0),
            source: "test:upstream-capacity-oracle",
            detail: "fixture leaves final capacity judgment to the upstream provider",
        };
    }

    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        this.requests.push(args.messages.map((message) => ({ ...message })));
        if (requestChars(args.messages) > UpstreamPromptCapacityMock.maxRequestChars) {
            const capacity = await this.assessRequestCapacity(args.messages, args.maxOutputTokens);
            const accounting = validateProviderRequestAccounting({
                provider: "provider:mock",
                model: this.model,
                outcome: "error",
                status: 413,
                cost: { kind: "unknown", reason: "upstream rejected the request before generation" },
            });
            const settle = await args.observeRequest?.({ provider: "provider:mock", model: this.model });
            await settle?.(accounting);
            throw new ProviderError(
                "mock",
                "capacity_exceeded",
                "Upstream rejected the projected prompt body as too large.",
                {
                    accounting: [accounting],
                    capacity,
                    extensions: { capacityStage: "upstream" },
                },
            );
        }
        return super.generate(args);
    }
}

const mockAt = (
    capacity: number,
    responses: MockResponse[],
    window = 4096,
    deferPhysicalAdmission = false,
): Mock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(Math.max(1, window - Math.min(capacity, window - 1)));
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const ProviderClass = deferPhysicalAdmission ? DeferredCapacityMock : Mock;
    const provider = new ProviderClass({ contextWindow: window, responses });
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
    });
    return provider;
};
const exactCharAt = (capacity: number, responses: MockResponse[], window = 1_000_000): ExactCharCapacityMock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(window - capacity);
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const provider = new ExactCharCapacityMock({ contextWindow: window, responses });
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
    });
    return provider;
};
const envelope = async (db: Db): Promise<{ workspaceId: number; workerId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `ge-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    return { workspaceId, workerId, loopId };
};

test("{§tokenomics-window-partition} the cold-start ceiling subtracts no additional reserves", async () => {
    const db = await openMigrated();
    try {
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const { workspaceId, workerId, loopId } = await envelope(db);
        const provider = mockAt(9998, [], 10_000);
        const packet = await b.buildRequestPacket({
            workspaceId, workerId, loopId, provider, currentTurnSeq: 1,
            initialMessages: MESSAGES, gitStatus: null,
        });
        assert.equal(b.curationBudgetFor(packet), 9998, "no usage evidence means a conversion factor of one");
    } finally { await db.close(); }
});

test("an exact provider overflow remains distinct from curation admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await engine.runTurn({
            provider: mockAt(999_000, [response([dispositionStmt("in_progress", "continue")])], 1_000_000),
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (next === undefined) throw new Error("next turn sequence unavailable");
        const probeProvider = mockAt(999_000, [], 1_000_000);
        const probe = await new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined }).buildRequestPacket({
            initialMessages: MESSAGES,
            workspaceId,
            workerId,
            loopId,
            currentTurnSeq: next.next,
            provider: probeProvider,
            gitStatus: null,
        });
        const exactChars = PacketWire.packetToWireMessages(probe)
            .reduce((sum, { content }) => sum + content.length, 0);
        const capacity = Math.floor((probe.weight + exactChars) / 2);
        assert.ok(probe.weight < capacity && capacity < exactChars, "fixture separates the curation ruler from provider tokens");

        const provider = exactCharAt(capacity, [response([dispositionStmt("completed", "unreachable")])]);
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(result.status, 413);
        assert.equal(result.capacityHardStop, true);
        assert.equal(provider.remaining, 1, "exact preflight rejection consumes no generated response");
        const turnId = result.turnId;
        const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
        const packet = JSON.parse(row!.packet) as Record<string, unknown>;
        assert.equal("assistant" in packet, false, "terminal capacity failure preserves only the attempted request");
        const errRow = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const failure = errRow
            .map((row) => JSON.parse(row.rx) as {
                problem?: {
                    type?: string;
                    status?: number;
                    detail?: string;
                    capacityStage?: string;
                    capacity?: {
                        decision?: string;
                        inputCapacity?: number;
                        prompt?: { kind?: string; tokens?: number; source?: string };
                    };
                    retryable?: boolean;
                };
            })
            .findLast((row) => row.problem?.type?.endsWith("/capacity-exceeded") === true)
            ?.problem;
        assert.ok(failure !== undefined);
        assert.equal(failure.status, 413);
        assert.equal(failure.retryable, false);
        assert.equal(failure.capacityStage, "preflight");
        assert.equal(failure.capacity?.decision, "reject");
        assert.equal(failure.capacity?.inputCapacity, capacity);
        assert.equal(failure.capacity?.prompt?.kind, "exact");
        assert.ok((failure.capacity?.prompt?.tokens ?? 0) > capacity);
        assert.equal(failure.capacity?.prompt?.source, "test:exact-chars");
        assert.match(failure.detail ?? "", /exceeds its exact input capacity/);
        const calls = await db.test_model_calls.all<{ capacity: string | null }>({ turn_id: turnId });
        assert.ok(calls.length >= 1 && calls.every(({ capacity }) => capacity !== null), "every failed logical request retains its request-shaped capacity evidence");
    } finally { await db.close(); }
});

test("an upstream 413 withholds the automatic prompt body and retries without spending an emission attempt", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prompt-capacity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(
            db,
            workerId,
            1,
            `${PROMPT_CAPACITY_SENTINEL}\n${"large prompt body\n".repeat(10_000)}`,
        );
        const provider = new UpstreamPromptCapacityMock({
            contextWindow: 100_000,
            responses: [response([dispositionStmt("completed", "recovered")])],
        });
        const result = await plainEngine(db).runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 1, "only the completed response consumes a grammar-emission attempt");
        assert.equal(provider.remaining, 0, "capacity recovery consumes the one queued model response exactly once");
        assert.equal(provider.requests.length, 2, "one rejected physical request is followed by one changed request");
        assert.ok(requestChars(provider.requests[0]) > UpstreamPromptCapacityMock.maxRequestChars);
        assert.ok(requestChars(provider.requests[1]) <= UpstreamPromptCapacityMock.maxRequestChars, "withholding the automatic prompt body makes the request fit");
        assert.ok(provider.requests[1].some((message) => chatMessageText(message).includes(PROMPT_CAPACITY_SENTINEL)), "the ordinary prompt READ preview survives automatic-prompt withholding");

        const calls = await db.test_model_calls.all<{ state: string; capacity: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ state }) => state), ["error", "response"]);
        assert.ok(calls.every(({ capacity }) => capacity !== null), "both logical requests retain request-shaped capacity evidence");
        const attempts = await db.test_turn_attempts.all<{ accepted: number | null }>({ turn_id: result.turnId });
        assert.deepEqual(
            attempts.map(({ accepted }) => accepted),
            [null, 1],
            "the response-less call remains unclassified and only the completed exchange is admitted",
        );
        const requests = await db.test_provider_requests.all<{ outcome: string }>({ turn_id: result.turnId });
        assert.deepEqual(requests.map(({ outcome }) => outcome), ["error", "response"], "both physical requests remain cardinal accounting facts");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const entries = logEntries(packet);
        assert.equal(entries.find(({ path }) => String(path).endsWith("/prompt"))?.body, undefined);
        assert.match(String(entries.find(({ path, target }) => String(path).endsWith("/READ") && String(target).startsWith("prompt://"))?.body), new RegExp(PROMPT_CAPACITY_SENTINEL));
        assert.match(packetSection(packet, "errors"), /"status":413,"path":"log:\/\/\/[^"]+\/error"/, "the recovered rejection remains visible to the model");
    } finally {
        await db.close();
    }
});

test("an estimate defers physical admission to the upstream provider", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const messages = [MESSAGES[0], { role: "user" as const, content: "漢".repeat(256) }];
        let measuredMessages: readonly { role: string; content: string }[] | undefined;
        const mock = Object.assign(mockAt(199_998, okSends(3), 200_000), {
            countPromptTokens: async (candidate: readonly { role: string; content: string }[]) => {
                measuredMessages = candidate;
                return {
                    kind: "estimate" as const,
                    tokens: Math.ceil(candidate.reduce((sum, message) => sum + message.content.length, 0) / 2),
                    source: "heuristic:chars2",
                    detail: "request framing and serving vocabulary are unknown",
                };
            },
        });
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 2, "an empirical estimate neither admits nor rejects; the upstream mock receives the request");
        assert.deepEqual(
            measuredMessages?.map(({ role }) => role),
            ["system", "user"],
            "the provider measured the same two rendered slots dispatched by PacketWire",
        );
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.equal(errors.length, 0, "deferred admission is not an error");
    } finally {
        await db.close();
    }
});

test("a proven request-token upper bound can authorize provider admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const mock = Object.assign(mockAt(199_998, [response([dispositionStmt("completed", "recovered")])], 200_000), {
            countPromptTokens: async () => ({
                kind: "upper_bound" as const,
                tokens: 1,
                source: "test:proven-request-bound",
            }),
        });
        const result = await engine.runLoop({ provider: mock, workspaceId, workerId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 0, "the proven bound admits the request to generation");
    } finally {
        await db.close();
    }
});
