import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Dsl from "./dsl.ts";
import TokenCalibration from "../../src/core/TokenCalibration.ts";
import Turn from "../../src/core/Turn.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import StoredPacket, { type RequestPacket } from "../../src/core/StoredPacket.ts";
import { type EditStatement, type UrlPath, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { Mock, chatMessageText, ProviderError, validateProviderRequestAccounting, type ChatMessage, type MockResponse, AiSdkProvider, type ProviderCost } from "@plurnk/plurnk-providers";
import { completeStmt, noteStmt, urlPath, editStmt, readStmt, findStmt, killStmt } from "./_dsl.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { type Db } from "../../src/core/Db.ts";
import { waitForDb, withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { serverProposals } from "./_approval.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMockResponse } from "./_mock.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "./_context-fit.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { clientRead } from "./_client-read.ts";

describe("tokenomics", () => {
const wsUrlPath = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const wsEditStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: wsUrlPath(pathname), lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `tok-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "p");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, sessionId, loopId, turnId };
};

test("{§tokenomics} EDIT stores entry_channels.weight from the model-agnostic ruler", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        const content = "alpha beta gamma delta";
        const result = await engine.dispatch({
            statement: wsEditStmt("/notes", content),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const ch = await db.tok_channel_weight.get<{ weight: number }>({ entry_id: result.entryId, name: "body" });
        // The write-time stamp is the model-agnostic ruler ({§tokenomics}): ceil(len/2).
        assert.equal(ch?.weight, Math.ceil(content.length / 2));
        assert.ok((ch?.weight ?? 0) > 0, "weight is populated at write");
    } finally { await db.close(); }
});

test("{§tokenomics} dispatched op stores log_entries.weight from its complete canonical log body", async () => {
    const { db, engine, workspaceId, sessionId, loopId, turnId } = await setup();
    try {
        let logEntryId = 0;
        await engine.dispatch({
            statement: wsEditStmt("/x", "hello world"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        });
        assert.ok(logEntryId > 0, "a log entry was written");
        const row = await db.tok_log_weight.get<{ rx: string; weight: number }>({ id: logEntryId });
        const result = JSON.parse(row?.rx ?? "null") as { receipt?: { effect?: { context?: unknown } } };
        const context = result.receipt?.effect?.context;
        assert.equal(typeof context, "string", "the successful EDIT retains its canonical receipt context");
        assert.equal(row?.weight, contentWeight(context as string));
    } finally { await db.close(); }
});

test("{§tokenomics} entry_channels.weight honors an injected ruler override (test seam)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-prov-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 200);
        // Inject a distinctive weight (constant 100) — unmistakably not ceil(len/4).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: () => 100 });
        let logEntryId = 0;
        const result = await engine.dispatch({
            statement: wsEditStmt("/notes", "alpha beta gamma"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        }) as { status: number; entryId: number | null };
        const ch = await db.tok_channel_weight.get<{ weight: number }>({ entry_id: result.entryId, name: "body" });
        assert.equal(ch?.weight, 100, "the write stamp honors the injected weight (test seam); production injects the chars/2 ruler");
        const log = await db.tok_log_weight.get<{ weight: number }>({ id: logEntryId });
        assert.equal(log?.weight, 100, "the same injected ruler weighs canonical log content once");
    } finally { await db.close(); }
});

test("{§tokenomics} below pressure the gauge carries populated tokens and budget fields", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-bud-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { weight: number };
        const budget = packetSection(packet, "budget");
        const state = JSON.parse(budget) as { tokens: number; budget: number; percent: number };
        assert.deepEqual(Object.keys(state), ["tokens", "budget", "percent"], `below pressure the gauge omits the inventory; got: ${budget}`);
        assert.equal(budget.split("\n").length, 1, "the model-facing gauge is one JSON line");
        const usage = state.tokens; const ceiling = state.budget;
        assert.ok(usage > 0, "usage is populated, not zero or a leftover placeholder");
        assert.equal(usage, packet.weight, "displayed usage is the exact persisted request render-weight");
        assert.equal(state.percent, Math.floor(usage * 100 / ceiling), "the share is the gauge's own figures");
        assert.ok(usage < ceiling * 0.8, "the admitted packet stays below pressure");
    } finally { await db.close(); }
});

test("{§tokenomics} context token budget carries active total and maximum without a percent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-pct-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const state = JSON.parse(budget) as { tokens: number; budget: number };
        assert.ok(Number.isSafeInteger(state.tokens) && state.tokens > 0, "active total is a populated integer");
        assert.ok(Number.isSafeInteger(state.budget) && state.budget > 0, "maximum is a populated integer");
        assert.ok(state.tokens < state.budget, "the admitted packet stays below the displayed maximum");
        assert.doesNotMatch(budget, /%/u, "the readout carries no percent — total and maximum make it derivable");
    } finally { await db.close(); }
});

test("{§tokenomics} a packet past the window preserves exact evidence in its terminal Problem", async () => {
    const db = await openMigrated();
    const partitionKeys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previousPartition = partitionKeys.map((key) => process.env[key]);
    try {
        const workspaceId = await insertWorkspace(db, `tok-over-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        // {§tokenomics} — the envelope rides the provider: an
        // 11-token context and a two-token total output budget leave nine input tokens.
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // An 11-token provider context − 2 output tokens → input capacity 9; the packet's own
        // scaffolding alone blows past it.
        const provider = new Mock({ contextWindow: 11, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.equal(result.status, 413, "past the wall, the loop ends rather than ask the window for what it has not got");
        const turn = await db.test_get_turn.get<{ packet: string | null; producer: string; kind: string }>({ id: result.turnId });
        assert.equal(turn?.packet, null, "an over-ceiling candidate is never stored as a model request");
        assert.deepEqual(
            { producer: turn?.producer, kind: turn?.kind },
            { producer: "model", kind: "inference" },
            "the rejected candidate retains its original identity",
        );
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnId });
        const plan = rows.find((row) => row.op === "NOTE" && row.origin === "_plurnk");
        assert.equal(plan, undefined, "admission never manufactures a cleanup note");
        const problem = result.curationFailure?.problem as { tokens?: number; wall?: number; excess?: number } | undefined;
        assert.ok(problem !== undefined, "the terminal owns exact evidence ({§tokenomics})");
        const { tokens, wall, excess } = problem;
        assert.ok(typeof tokens === "number" && typeof wall === "number" && typeof excess === "number");
        assert.ok(tokens > wall, `tokens ${tokens} exceed the wall of ${wall}`);
        assert.equal(excess, tokens - wall, "the excess reconciles exactly");
    } finally {
        partitionKeys.forEach((key, index) => {
            const previous = previousPartition[index];
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        await db.close();
    }
});

test("{§tokenomics} content_hash is a stable per-content identity — identical content, identical hash; no per-model keying", async () => {
    const { contentHash } = await import("../../src/core/content-hash.ts");
    const h = contentHash("same bytes");
    assert.equal(h, contentHash("same bytes"), "deterministic: identical content → identical hash");
    assert.notEqual(h, contentHash("other bytes"), "distinct content → distinct hash");
    assert.match(h, /^[0-9a-f]{64}$/, "a sha256 hex identity");
});

test("{§tokenomics} the loop's latest reported prompt count updates its ceiling without changing cost units", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-cal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reported = 100;
        const charged = { inputTokens: reported, totalTokens: reported };
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] }, usage: charged },
            { assistant: { content: "", reasoning: null, ops: [completeStmt()] }, usage: charged },
        ] });
        const messages = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "U" }];
        const shown: number[] = [];
        const ceilings: number[] = [];
        const weights: number[] = [];
        for (let turn = 1; turn <= 4; turn += 1) {
            const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { weight: number };
            const m = packetSection(packet, "budget").match(/"tokens":\s*(\d+)/);
            assert.ok(m, `turn ${turn} carries a readout`);
            shown.push(Number(m[1]));
            ceilings.push(Number(packetSection(packet, "budget").match(/"budget":\s*(\d+)/)?.[1]));
            weights.push(packet.weight);
        }
        assert.deepEqual(shown, weights, "curation costs retain the raw measured weight before and after calibration");
        assert.equal(ceilings[0], provider.inputCapacity, "before any response the model has no sample: the capacity is the room");
        assert.deepEqual(ceilings.slice(1), weights.slice(0, -1).map((w) => provider.inputCapacity! + w - reported), "each settled response updates the additive offset for the next packet of the loop");
        assert.notEqual(new Set(weights.slice(1)).size, 1, "later packets weigh differently");
    } finally { await db.close(); }
});
});

describe("Engine.budget-enforce", () => {
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([completeStmt("ok")]));

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
const envelope = async (db: Db): Promise<{ workspaceId: number; sessionId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `ge-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    return { workspaceId, sessionId, loopId };
};

test("{§tokenomics} the cold-start ceiling subtracts no additional reserves", async () => {
    const db = await openMigrated();
    try {
        const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const provider = mockAt(9998, [], 10_000);
        const packet = await b.buildRequestPacket({
            workspaceId, sessionId, loopId, provider, currentTurnSeq: 1,
            initialMessages: MESSAGES, gitStatus: null,
        });
        assert.equal(b.curationBudgetFor(packet), 9998, "no usage evidence means a conversion factor of one");
    } finally { await db.close(); }
});

test("{§tokenomics} {§provider-surface} an exact prompt over the reservation but under the wall is admitted with its grant flexed", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        await engine.runTurn({
            provider: mockAt(999_000, [response([noteStmt("continue")])], 1_000_000),
            workspaceId,
            sessionId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (next === undefined) throw new Error("next turn sequence unavailable");
        const probeProvider = mockAt(999_000, [], 1_000_000);
        const probeBuilder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const probe = await probeBuilder.buildRequestPacket({
            initialMessages: MESSAGES,
            workspaceId,
            sessionId,
            loopId,
            currentTurnSeq: next.next,
            provider: probeProvider,
            gitStatus: null,
        });
        const exactChars = PacketWire.packetToWireMessages(probe)
            .reduce((sum, { content }) => sum + content.length, 0);
        const capacity = Math.floor((probe.weight + exactChars) / 2);
        assert.ok(probe.weight < capacity && capacity < exactChars, "fixture separates the curation ruler from provider tokens");

        // {§provider-capacity-admission}: over the reservation, under the wall — the request goes, and the
        // grant is the window's remainder ({§provider-flexed-allowance}), never below the floor.
        const roomy = exactCharAt(capacity, [response([noteStmt("admitted")])]);
        assert.equal(roomy.inputCapacity, capacity);
        assert.ok(roomy.inputWall !== null && roomy.inputWall > exactChars, "a million-token window's wall is far above the exact count");
        const admitted = await engine.runTurn({ provider: roomy, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(admitted.status, 102, "between the reservation and the wall the request is admitted");
        assert.equal(roomy.remaining, 0, "the response was generated");
        const admittedCalls = (await db.test_model_calls.all<{ capacity: string | null }>({ turn_id: admitted.turnId }))
            .map(({ capacity: evidence }) => JSON.parse(evidence ?? "null") as { decision?: string; responseMax?: number; outputFloor?: number; outputBudget?: number } | null);
        assert.ok(admittedCalls.some((evidence) => evidence?.decision === "admit"
            && typeof evidence.responseMax === "number" && typeof evidence.outputBudget === "number" && typeof evidence.outputFloor === "number"
            && evidence.responseMax < evidence.outputBudget && evidence.responseMax >= evidence.outputFloor),
        "the grant is flexed down from the budget and never below the floor");
    } finally { await db.close(); }
});

test("{§tokenomics}: an upstream capacity refusal is the provider's own 413 — one request, no resend, durable evidence", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prompt-capacity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(
            db,
            sessionId,
            1,
            `${PROMPT_CAPACITY_SENTINEL}\n${"large prompt body\n".repeat(3_000)}`,
        );
        const provider = new UpstreamPromptCapacityMock({
            contextWindow: 100_000,
            responses: [response([completeStmt("recovered")])],
        });
        const result = await plainEngine(db).runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });

        assert.equal(result.status, 413, "the provider's own rejection is the turn's outcome");
        assert.equal(result.capacityHardStop, true);
        assert.equal(result.capacityFailure?.problem?.capacityStage, "upstream", "the failure names where it was judged");
        assert.equal(provider.requests.length, 1, "the rejected request is the only physical request: nothing is withheld and resent on the model's behalf");
        assert.equal(provider.remaining, 1, "the queued response is never consumed");
        assert.ok(requestChars(provider.requests[0]) > UpstreamPromptCapacityMock.maxRequestChars);
        assert.ok(provider.requests[0].some((message) => chatMessageText(message).includes(PROMPT_CAPACITY_SENTINEL)), "the arrival rode whole: by the packet's own ruler it fit");

        const calls = await db.test_model_calls.all<{ state: string; capacity: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ state }) => state), ["error"]);
        assert.ok(calls.every(({ capacity }) => capacity !== null), "the logical request retains its request-shaped capacity evidence");
        const attempts = await db.test_turn_attempts.all<{ accepted: number | null }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [null], "the response-less call remains unclassified");
        const requests = await db.test_provider_requests.all<{ outcome: string }>({ turn_id: result.turnId });
        assert.deepEqual(requests.map(({ outcome }) => outcome), ["error"], "the physical request remains a cardinal accounting fact");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const arrival = logEntries(packet).find(({ logPath: path }) => path.endsWith("/SEND"));
        assert.ok(arrival && typeof arrival.body === "string" && arrival.body.includes(PROMPT_CAPACITY_SENTINEL), "the stored request is the request that was sent: the arrival, whole");
        const errors = await db.test_error_rows_for_session.all<{ rx: string }>({ session_id: sessionId });
        assert.equal(errors.length, 1, "the failure is one durable error row");
        assert.equal((JSON.parse(errors[0].rx) as { problem?: { status?: number } }).problem?.status, 413);
    } finally {
        await db.close();
    }
});

test("{§packet-assembly} an estimate defers physical admission to the upstream provider", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
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
        const result = await engine.runLoop({ provider: mock, workspaceId, sessionId, loopId, messages, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 2, "an empirical estimate neither admits nor rejects; the upstream mock receives the request");
        // {§packet-assembly} — the provider measured the envelope PacketWire dispatched: the system
        // slot first, the clump last, and nothing but the model's own program between the user messages.
        const roles = measuredMessages?.map(({ role }) => role) ?? [];
        assert.equal(roles[0], "system");
        assert.equal(roles.at(-1), "user");
        assert.ok(roles.every((role) => role === "system" || role === "user" || role === "assistant"), `unexpected role in ${roles.join(",")}`);
        const errors = await db.test_error_rows_for_session.all<{ rx: string }>({ session_id: sessionId });
        assert.equal(errors.length, 0, "deferred admission is not an error");
    } finally {
        await db.close();
    }
});

test("{§tokenomics} a proven request-token upper bound can authorize provider admission", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = plainEngine(db);
        const mock = Object.assign(mockAt(199_998, [response([completeStmt("recovered")])], 200_000), {
            countPromptTokens: async () => ({
                kind: "upper_bound" as const,
                tokens: 1,
                source: "test:proven-request-bound",
            }),
        });
        const result = await engine.runLoop({ provider: mock, workspaceId, sessionId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.result.status, 200);
        assert.equal(mock.remaining, 0, "the proven bound admits the request to generation");
    } finally {
        await db.close();
    }
});
});

describe("Engine.budget", () => {
test("{§provider-generation-envelope} input capacity subtracts the total output budget once; reasoning is only its subset", async () => {
    const KEYS = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const prev = KEYS.map((k) => process.env[k]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "3000";
    process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "1000";
    const db = await openMigrated();
    try {
        const run = async (contextWindow: number): Promise<string> => {
            const workspaceId = await insertWorkspace(db, `part-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "p");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow, responses: [response([completeStmt("done")])] });
            const r = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            return packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: r.turnId }))!.packet), "budget");
        };
        assert.match(await run(10000), /"budget":7000\b/u, "the total output budget is subtracted once");
        assert.match(await run(5000), /"budget":2000\b/u, "a narrower window retains the same total output budget");
        await assert.rejects(() => run(3000), /must leave positive input capacity/, "an output envelope cannot consume the complete context window");
    } finally {
        KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
        await db.close();
    }
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

test("{§tokenomics} Engine.runTurn: context budget readout carries partition-derived maximum and assembled total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 4000, responses: [response([completeStmt("done")])] });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "go" }],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { weight: number };
        const budget = packetSection(packet, "budget");
        // provider window 4000 − fixture total output budget 1280 = 2720
        assert.match(budget, /"tokens":\s*\d+,"budget":2720\b/u, "state carries the provider-derived maximum and assembled total");
        const usage = Number(/"tokens":\s*(\d+)/.exec(budget)?.[1]);
        assert.ok(usage > 0 && usage < 2720, `active total ${usage} within (0, 2720)`);
        assert.equal(usage, packet.weight, "the model-facing token label projects the exact stored curation weight");
    } finally { await db.close(); }
});

test("{§tokenomics} Core starts curation at provider input capacity without inventing another budget", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const packets = new PacketBuilder({
            db,
            schemes,
            executors: () => undefined,
        });
        const workspaceId = await insertWorkspace(db, `capacity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const build = (provider: Mock) => packets.buildRequestPacket({
            workspaceId, sessionId, loopId, provider, currentTurnSeq: 1, gitStatus: null,
            initialMessages: [{ role: "user", content: "go" }],
        });
        const provider = new Mock({ contextWindow: 1_048_575, responses: [] });
        assert.equal(packets.curationBudgetFor(await build(provider)), provider.inputCapacity);
        assert.equal(provider.inputCapacity, 1_048_575 - 1280);
        assert.equal(provider.reasoningBudget, 256);
        assert.equal(provider.outputBudget, 1280, "reasoning does not add to the total response envelope");

        const unknown = new Mock({ contextWindow: null, responses: [] });
        assert.equal(packets.curationBudgetFor(await build(unknown)), null, "unknown physical capacity remains unknown to curation");
    } finally {
        await db.close();
    }
});
});

describe("budget-stories", () => {
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the provider's effective window — wide enough to hold a fat visible READ
const TINY = 2;         // absolute wall far below any packet → irreducible overflow
const FAT = 4000;       // chars of read-back body — renders into the log, the only lever
const heavy = (chars: number): string => "x".repeat(chars);
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([completeStmt("ok")]));
// A turn that writes a fat entry then READS it back (the read RESULT renders into
// the log — that is the budget pressure) then closes. The EDIT body is free; the
// READ render is not. Repeated n times for multi-turn accumulation.
// A heavy read turn — EDIT a fat entry then READ it back; the READ appears in the next turn's packet
// (that's what makes the next turn fat). It continues — the result is for the next turn
// and therefore cannot be observed in the emission that requested it.
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("workspace", "big"), heavy(chars)), readStmt(urlPath("workspace", "big")), noteStmt("ok")]));

const engineAt = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
const ENVELOPE_KEYS = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
const mockCeiling = (ceiling: number, responses: MockResponse[]): Mock => {
    const prev = ENVELOPE_KEYS.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const m = new Mock({ contextWindow: ceiling + 2, responses });
    ENVELOPE_KEYS.forEach((key, index) => {
        if (prev[index] === undefined) delete process.env[key];
        else process.env[key] = prev[index];
    });
    return m;
};
const envelope = async (db: Db): Promise<{ workspaceId: number; sessionId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `bs-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    return { workspaceId, sessionId, loopId };
};
const packetOf = async (db: Db, turnId: number): Promise<{ weight: number; assistant?: { ops: unknown[] }; packet: object }> => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row!.packet) as { weight: number; assistant?: { ops: unknown[] } };
    return { ...packet, packet };
};
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    const state = JSON.parse(budget.split("\n\n")[0]) as { tokens: number; budget: number };
    const usage = state.tokens;
    const ceiling = state.budget;
    return { ceiling, usage, percent: (usage / ceiling) * 100, free: ceiling - usage };
};
// Two reference measurements on throwaway sessions (deterministic FAT body), so the
// recovery ceilings track the real assembly and never magic numbers:
//   floor    = bare scaffolding (turn 1's pre-emission packet, no prior log)
//   expanded = floor + a fat READ log from the prior turn, all expanded
const measure = async (db: Db): Promise<{ floor: number; expanded: number }> => {
    const { workspaceId, sessionId, loopId } = await envelope(db);
    const wide = engineAt(db);
    const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
    const t1 = await wide.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
    const t2 = await wide.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
    return { floor: (await packetOf(db, t1.turnId)).weight, expanded: (await packetOf(db, t2.turnId)).weight };
};

// 0 — the fattener actually fattens. If this fails every recovery story below is
// vacuous, so it is pinned first.
test("{§tokenomics} budget: a READ result renders into the log and weighs on the next turn's packet", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        assert.ok(expanded > floor + 200, `a fat READ log must add real weight (floor ${floor}, with-fat ${expanded})`);
    } finally { await db.close(); }
});

// 1 — cascade ok: comfortably under budget the overflow recovery is inert, delivered ≤100%.
test("{§tokenomics} budget: under the ceiling the turn delivers and the budget reads at or below 100%", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = engineAt(db);
        // A large EDIT with in-progress inventory fits under the wide ceiling.
        const fatDeliver = [response([editStmt(urlPath("workspace", "big"), heavy(FAT)), noteStmt("ok")])];
        const t = await engine.runTurn({ provider: new Mock({ contextWindow: WINDOW, responses: fatDeliver }), workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t.status, 102, "delivered");
        assert.equal(t.capacityHardStop, false, "no provider-capacity stop under a wide curation budget");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// The wall's Problem owns exact evidence; no request or task is fabricated.
test("{§tokenomics} the irreducible window overflow reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        assert.equal(t.producer, "model", "admission failure does not manufacture a recovery producer");
        const problem = t.curationFailure?.problem as { tokens?: number; wall?: number; excess?: number } | undefined;
        assert.ok(problem !== undefined, "the terminal 413 carries its exact Problem");
        const { tokens, wall, excess } = problem;
        assert.ok(typeof tokens === "number" && typeof wall === "number" && typeof excess === "number");
        assert.ok(tokens > wall, `tokens ${tokens} exceed the wall ${wall} — a real overshoot`);
        assert.equal(excess, tokens - wall, "the Problem's arithmetic closes exactly ({§tokenomics})");
        assert.equal((await db.test_get_turn.get<{ packet: string | null }>({ id: t.turnId }))?.packet, null);
    } finally { await db.close(); }
});

// 11 — provider-derived input capacity governs curation (a real build).
test("{§tokenomics} budget: the provider-derived input capacity is the curation ceiling", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // {§tokenomics}: mockCeiling(10) gives context 12 with
        // a total output budget of 2, deriving input capacity 10. The ordinary
        // curation rail reports that exact derived ceiling before provider I/O.
        const provider = mockCeiling(10, okSends(1));
        const t = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.producer, "model");
        const budget = (t.curationFailure?.problem as { budget?: number } | undefined)?.budget;
        assert.equal(budget, 10, "context 12 − total output budget 2 → input capacity 10 ({§tokenomics})");
        assert.equal(provider.remaining, 1, "curation overflow prevents provider I/O");
    } finally { await db.close(); }
});

test("{§tokenomics} below pressure the model-facing gauge omits its largest inventory (#478)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES });
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        const gauge = JSON.parse(budget) as { tokens: number; budget: number; percent: number };
        assert.ok(gauge.tokens < gauge.budget * 0.8, "this composed packet remains below pressure");
        assert.deepEqual(Object.keys(gauge), ["tokens", "budget", "percent"], "no curation inventory is needed below pressure");
        assert.equal(gauge.percent, Math.floor(gauge.tokens * 100 / gauge.budget), "the share is the gauge's own figures, on every packet");
        assert.equal(budget.split("\n").length, 1, "one JSON line — no warning or mandate follows the object");
        assert.doesNotMatch(budget, /\{\{/, "no placeholder survives");
    } finally { await db.close(); }
});

test("{§tokenomics}: a composed packet's largest inventory points to its dominant visible log body", async () => {
    const db = await openMigrated();
    try {
        const { expanded } = await measure(db);
        const { workspaceId, sessionId, loopId } = await envelope(db);
        const engine = engineAt(db);
        await engine.runTurn({
            provider: new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) }),
            workspaceId, sessionId, loopId, messages: MESSAGES,
        });
        const pressureCeiling = Math.ceil(expanded / 0.85);
        const pressured = await engine.runTurn({
            provider: mockCeiling(pressureCeiling, okSends(1)),
            workspaceId, sessionId, loopId, messages: MESSAGES,
        });
        const stored = await packetOf(db, pressured.turnId);
        const budget = packetSection(stored.packet, "budget");
        const object = JSON.parse(budget.split("\n\n")[0]) as { tokens: number; budget: number; percent: number; largest: Array<{ path: string; tokens: number }> };
        assert.deepEqual(Object.keys(object), ["tokens", "budget", "percent", "largest"], "the share sits after the totals; the inventory follows it");
        assert.equal(object.percent, Math.floor(object.tokens * 100 / object.budget), "the pressured packet's share is the gauge's own, inventory included");
        const inventory = object.largest;
        assert.ok(inventory.length > 0, "the pressure inventory rides inside the JSON object");
        const [largest] = inventory;
        assert.match(largest.path, /^log:\/\/\/\d+\/\d+\/\d+\/[A-Z]+$/u);
        assert.equal(typeof largest.tokens, "number");
        const advised = logEntries(stored.packet).find((row) => row.logPath === largest.path);
        assert.equal(largest.tokens, advised?.tokens, "inventory and receipt use the same complete-row charge");
        assert.equal(typeof advised?.body, "string", "the advised row is currently open in the same packet");
        assert.equal(object.tokens, stored.weight, "conditional advice participates in exact packet accounting");
    } finally { await db.close(); }
});
});

describe("cancellation-accounting", () => {
for (const reported of [false, true]) {
    for (const stop of ["KILL", "shutdown"] as const) {
        test(`{§tokenomics} ${stop} retains cancelled child accounting; reported=${reported} (#971)`, async () => {
            const charge: ProviderCost = {
                kind: "charged", amount: { amount: "0.0123", currency: "USD" }, source: "fixture response",
            };
            let calls = 0;
            const provider = new AiSdkProvider({
                model: "cancellation-witness", url: "https://example.test/v1/chat/completions",
                contextWindow: 100_000, streaming: true,
                fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
                temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 3,
                normalizeCost: (evidence) => evidence.charge as ProviderCost | undefined,
                fetch: async (_url, init) => {
                    calls++;
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                                id: "cancelled-child", model: "cancellation-witness",
                                choices: [{ index: 0, delta: {
                                    reasoning_content: "Still reasoning.",
                                    content: "````EDIT (workspace:///must-not-exist.txt)\nnot authorized after cancellation\n````",
                                }, finish_reason: null }],
                                ...(reported ? {
                                    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, charge,
                                } : {}),
                            })}\n\n`));
                            init?.signal?.addEventListener("abort", () => {
                                controller.error(new DOMException("Request aborted", "AbortError"));
                            }, { once: true });
                        },
                    }), { headers: { "content-type": "text/event-stream" } });
                },
            });
            await withDaemon(provider, async (db, daemon) => {
                const { workspaceId } = await daemon.createWorkspace({ name: `cancellation-${stop}-${reported}` });
                const parent = await namedModelSession(daemon, workspaceId, "main");
                await insertLoop(db, parent, 1, "parent delegation");
                const child = await insertSession(db, workspaceId, parent, "child", "model");
                const observed = Promise.withResolvers<void>();
                const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                    const event = params as { sessionId?: number; phase?: string };
                    if (method === "reasoning/event" && event.sessionId === child && event.phase === "content") observed.resolve();
                });
                try {
                    const task = await daemon.runLoop({ workspaceId, sessionId: child, prompt: "Think about the task." });
                    await observed.promise;
                    if (stop === "KILL") {
                        // The parent's own KILL of its child.
                        const result = await modelOperation(daemon, db, {
                            workspaceId, sessionId: parent,
                            statement: Dsl.parseSingleStatement("````KILL (session://child)\n````"),
                        });
                        assert.equal(result.status, 200);
                    } else {
                        await daemon.stop();
                    }
                    const turns = await waitForDb(
                        () => db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: task.loopId }),
                        (rows) => rows.some(({ kind }) => kind === "inference") && rows.every(({ completed_at }) => completed_at !== null),
                    );
                    const turn = turns.find(({ kind }) => kind === "inference")!;
                    assert.equal(turn.status, 499);
                    const requests = await db.test_provider_requests.all<{
                        state: string; outcome: string; usage_input: number | null; usage_output: number | null;
                        cost_kind: string; cost_amount: string | null; evidence: string;
                    }>({ turn_id: turn.id });
                    assert.equal(requests.length, 1);
                    assert.equal(requests[0].state, "settled");
                    assert.equal(requests[0].outcome, "error");
                    assert.equal(requests[0].usage_input, reported ? 100 : null);
                    assert.equal(requests[0].usage_output, reported ? 10 : null);
                    assert.equal(requests[0].cost_kind, reported ? "charged" : "unknown");
                    assert.equal(requests[0].cost_amount, reported ? "0.0123" : null);
                    const evidence = JSON.parse(requests[0].evidence);
                    assert.equal(evidence.reasoning, "Still reasoning.");
                    assert.match(evidence.content, /must-not-exist.txt/);
                    assert.equal(evidence.rawBody[0].id, "cancelled-child");
                    assert.match(JSON.stringify(evidence.error), /cancel|abort|shutdown/i);
                    const descendants = await daemon.sessionAccounting({ workspaceId, sessionId: parent });
                    assert.equal(descendants.requests.length, 1);
                    assert.equal(descendants.costUsd, reported ? "0.0123" : null);
                    assert.equal(descendants.usage?.inputTokens, reported ? 100 : undefined);
                    assert.deepEqual(descendants, await daemon.engine.sessionAccounting(parent));
                    assert.equal(calls, 1, "cancellation never starts a replacement request");
                    assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/must-not-exist.txt", scheme: "workspace" }), undefined,
                        "a cancelled partial emission never executes");
                    assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: child }), [],
                        "cancellation is lifecycle truth, not a new model-facing provider error");
                } finally {
                    unsubscribe();
                    if (stop === "KILL") await daemon.cancelSession({ workspaceId, sessionId: parent });
                }
            });
        });
    }
}
});

describe("context-admission", () => {
const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const note = (body: string): MockResponse => ({ assistant: { content: `\`\`\`\`NOTE\n${body}\n\`\`\`\``, reasoning: null } });
const PROSE = "Prose runs four characters to a token. ".repeat(100);
const CODE = "{[(<>)]};=".repeat(600);

// The provider's vocabulary: a bracket, a semicolon or an equals sign is a token of its own, anything else
// runs four characters to a token. `charsPerToken` 1 makes every character a token.
const vocabulary = (charsPerToken: 1 | 4) => (text: string): number => {
    let dense = 0;
    for (const char of text) if ("{}()[];=<>".includes(char)) dense++;
    return dense + Math.ceil((text.length - dense) / charsPerToken);
};

class CountingMock extends Mock {
    readonly #script: MockResponse[];
    readonly #count: (text: string) => number;
    constructor(contextWindow: number, script: MockResponse[], count: (text: string) => number) {
        super({ contextWindow, responses: script });
        this.#script = script;
        this.#count = count;
    }

    override async countPromptTokens(prompt: readonly ChatMessage[]) {
        return { kind: "exact" as const, tokens: prompt.reduce((sum, message) => sum + this.#count(chatMessageText(message)), 0), source: "test:vocabulary" };
    }

    // The usage of the next response is the count of the request it answers.
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        const next = this.#script[this.#script.length - this.remaining];
        if (next !== undefined) {
            const { tokens } = await this.countPromptTokens(args.messages);
            next.usage = { inputTokens: tokens, totalTokens: tokens };
        }
        return await super.generate(args);
    }
}

// The room in provider tokens: `capacity` sizes the budget, `wall` admits ({§tokenomics}).
const providerAt = ({ capacity, wall }: { capacity: number; wall: number }, script: MockResponse[], charsPerToken: 1 | 4 = 4): CountingMock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_OUTPUT_FLOOR", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    const floor = 1_000;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(wall + floor - capacity);
        process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = String(floor);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new CountingMock(wall + floor, script, vocabulary(charsPerToken));
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
};
const ROOMY = { capacity: 900_000, wall: 990_000 };

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `context-admission-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    // The next request as it would be built now.
    const probe = async (provider: Mock): Promise<RequestPacket> => {
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        return await builder.buildRequestPacket({
            initialMessages: messages, workspaceId, sessionId, loopId, provider, currentTurnSeq: next!.next, gitStatus: null,
        });
    };
    return { db, workspaceId, sessionId, loopId, engine, probe };
};
const exact = (provider: CountingMock, request: readonly ChatMessage[]) => provider.countPromptTokens(request).then(({ tokens }) => tokens);

test("{§tokenomics} {§tokenomics}: calibrated on prose, unmeasured dense code is budgeted 1:1 above the prior offset; under the wall and over budget, the complete packet and its emission history go whole with the 413 over-budget row", async () => {
    const { db, workspaceId, sessionId, loopId, engine, probe } = await fixture();
    try {
        const roomy = providerAt(ROOMY, [note(PROSE), note(PROSE), note(PROSE), note(CODE)]);
        for (let turn = 0; turn < 4; turn++) await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: roomy });
        const offset = await TokenCalibration.forLoop(db, "mock", loopId);
        assert.ok(offset > 0, "prose turns measured below their character weight");

        const full = await probe(roomy);
        const estimate = TokenCalibration.estimatedTokens(full.weight, offset);
        const exactTokens = await exact(roomy, PacketWire.packetToWireMessages(full));
        const wall = exactTokens + 200;

        const tight = providerAt({ capacity: Math.floor(estimate / 2), wall }, [note("Continuing the review.")]);
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: tight });
        assert.equal(result.status, 102, "the request was sent, not ended");
        assert.equal(tight.received.length, 1, "one inference request");
        assert.ok(await exact(tight, tight.received[0]) <= wall, "what was sent fits the wall by the provider's own count");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const replay = packetSection(packet, "emission-history");
        assert.ok(replay.includes(PROSE) && replay.includes(CODE), "the previous programs stay whole in emission-history");
        const rows = logEntries(packet);
        const notes = rows.filter(({ logPath }) => logPath.endsWith("/NOTE"));
        assert.equal(notes.length, 4, "all four NOTE receipts remain in the log");
        assert.ok(notes.every(({ size }) => size === undefined), "no row is reduced to a size receipt by the daemon");
        assert.equal(rows.filter(({ logPath }) => logPath.endsWith("/error")).length, 1, "{§tokenomics}: the over-budget row rides the request that fits");
        const calls = await db.test_model_calls.all<{ capacity: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ capacity }) => JSON.parse(capacity ?? "null")?.decision), ["admit"], "no refused request reached the provider's generate");
    } finally { await db.close(); }
});

test("{§tokenomics} {§tokenomics}: a request the provider refuses by exact count ends the loop on the window-overflow Problem, and nothing is sent", async () => {
    const { db, workspaceId, sessionId, loopId, engine, probe } = await fixture();
    try {
        // The loop's first response sets its offset on prose; the tight provider counts every character,
        // so the exact count exceeds the wall even when the calibrated estimate sits below it.
        const roomy = providerAt(ROOMY, [note("Reading the evidence.")]);
        await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: roomy });
        assert.ok(await TokenCalibration.forLoop(db, "mock", loopId) > 0);
        const wall = (await probe(roomy)).weight;
        const tight = providerAt({ capacity: wall, wall }, [note("Continuing the review.")], 1);
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: tight });
        assert.equal(result.status, 413);
        assert.equal(result.capacityHardStop, false, "the window's own terminal, not a provider failure");
        assert.equal(result.curationFailure?.problem?.detail, "Context window overflow: the packet exceeds the model's window."); // {§operation-results}
        assert.ok(Number(result.curationFailure?.problem?.tokens) > wall, "the terminal names the provider's exact count over the wall");
        assert.equal(tight.received.length, 0, "no inference request");
        const turn = await db.test_get_turn.get<{ packet: string | null }>({ id: result.turnId });
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
    } finally { await db.close(); }
});
});

describe("context-gauge", () => {
const recordRequest = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    turnId: number,
    input: number,
    options: { kind?: "emission" | "bare"; sequence?: number; capacity?: number } = {},
): Promise<void> => {
    const kind = options.kind ?? "emission";
    const capacity = JSON.stringify({
        decision: "admit",
        contextWindow: (options.capacity ?? 1000) + 1,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: 1,
        reasoningBudget: null,
        inputCapacity: options.capacity ?? 1000,
        prompt: { kind: "exact", tokens: input, source: "context-gauge-fixture" },
    });
    const modelCall = await db.test_context_insert_model_call.get<{ id: number }>({
        turn_id: turnId,
        sequence: options.sequence ?? 1,
        kind,
    });
    if (kind === "emission") {
        await db.test_context_insert_attempt.run({ model_call_id: modelCall!.id });
    }
    await db.test_context_insert_request.run({ model_call_id: modelCall!.id, input });
    await db.test_context_close_model_call.run({
        id: modelCall!.id,
        capacity,
    });
};

test("{§tokenomics} loopUsage.contextTokens is the latest turn's prompt, not the summed total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // Two turns, a context that grows: prompts 100 then 250.
        const first = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: null,
            curation_weight: 10,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: null,
            curation_weight: 20,
        });
        await recordRequest(db, first!.id, 100);
        await recordRequest(db, second!.id, 250);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.usage?.inputTokens, 350, "inputTokens sums across physical requests");
        assert.equal(usage.contextTokens, 250, "contextTokens is the LAST turn's prompt (occupancy)");
    } finally { await db.close(); }
});

test("{§tokenomics} loopUsage.contextTokens ignores later BARE calls while accounting remains cardinal", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-bare-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 8192,
            curation_weight: 20,
        });
        await recordRequest(db, turn!.id, 250);
        await recordRequest(db, turn!.id, 1, { kind: "bare", sequence: 2 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.requests.length, 2);
        assert.equal(usage.accounting.usage?.inputTokens, 251);
        assert.equal(usage.contextTokens, 250, "the gauge describes the emission packet, not the later isolated prompt");
    } finally { await db.close(); }
});

test("{§tokenomics} loopUsage keeps latest-turn curation and physical pairs together across a model switch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-size-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // Turn 1 ran a 49k-window model; turn 2 switched to a 200k-window model.
        const first = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 49152,
            curation_weight: 100,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: 200000,
            curation_weight: 300,
        });
        await recordRequest(db, first!.id, 100, { capacity: 48_000 });
        await recordRequest(db, second!.id, 250, { capacity: 180_000 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.curationWeight, 300);
        assert.equal(usage.curationBudget, 200000);
        assert.equal(usage.contextTokens, 250);
        assert.equal(usage.contextCapacity, 180_000, "physical occupancy and capacity come from the same latest emission call");
    } finally { await db.close(); }
});

test("{§tokenomics} loopUsage.curationBudget is null when provider input capacity is unknown", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-null-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // A provider with unknown input capacity leaves the curation denominator NULL.
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: null,
            curation_weight: 10,
        });
        await recordRequest(db, turn!.id, 100);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.curationBudget, null);
    } finally { await db.close(); }
});

test("{§tokenomics} loopUsage does not reuse an earlier turn's context when the latest provider call never completed", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-failed-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const completed = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 49152,
            curation_weight: 100,
        });
        await recordRequest(db, completed!.id, 100);
        await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: 200000,
            curation_weight: 200,
        });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextTokens, null, "an absent latest exchange remains unknown rather than fabricated zero");
        assert.equal(usage.curationWeight, 200);
        assert.equal(usage.curationBudget, 200000, "curation still describes the latest assembled request");
        assert.equal(usage.contextCapacity, null, "physical capacity does not fall back to an earlier turn");
    } finally { await db.close(); }
});

test("{§tokenomics} loopUsage binds physical usage and capacity to the same latest emission call", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-preflight-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 1000,
            curation_weight: 100,
        });
        await recordRequest(db, turn!.id, 80, { sequence: 1, capacity: 900 });
        const failedCapacity = JSON.stringify({
            decision: "reject",
            contextWindow: 801,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget: 1,
            reasoningBudget: null,
            inputCapacity: 800,
            prompt: { kind: "exact", tokens: 801, source: "context-gauge-fixture" },
        });
        const failed = await db.test_context_insert_failed_model_call.get<{ id: number }>({
            turn_id: turn!.id,
            sequence: 2,
        });
        await db.test_context_fail_model_call.run({ id: failed!.id, capacity: failedCapacity });
        await db.engine_open_turn_attempt.get({ model_call_id: failed!.id });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextTokens, null, "a preflight rejection issued no physical request and does not borrow the prior call's usage");
        assert.equal(usage.contextCapacity, 800, "capacity comes from that same latest rejected call");
        assert.equal(usage.accounting.usage?.inputTokens, 80, "cardinal accounting still retains the earlier physical request");
    } finally { await db.close(); }
});

test("{§tokenomics} runTurn stores provider-derived curation and request-shaped physical capacity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-budget-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 8192, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } }] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }] });
        const usage = await engine.loopUsage(loopId);
        const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
        assert.equal(usage.curationBudget, expected);
        assert.equal(usage.contextCapacity, expected);
        assert.ok((usage.curationWeight ?? 0) > 0);
    } finally { await db.close(); }
});

test("{§tokenomics} providers.list advertises resolved physical input capacity", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "gauge-345" });
            const resp = await rpcCall(ws, 2, "providers.list");
            const result = resp.result as { aliases: Array<{ active: boolean; inputCapacity: number | null }> };
            const active = result.aliases.find((a) => a.active);
            const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
            assert.equal(active?.inputCapacity, expected);
        } finally { ws.close(); }
    });
});
});

describe("demo-context-fit", () => {
test("{§methods-workspace-create} {§packet}: one oversized attachment lands as its first page, cut inside its one long line, and a range READ reaches its answer", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const fixture = await seedAttachmentFixture();
    const content = `Telemetry: ${"sample nominal; ".repeat(12_000)}\nRecovery site: ${fixture.answer}.\n`;
    const provider = new Mock({ contextWindow: 20_000, responses: [
        makeMockResponse("````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
        makeMockResponse(`\`\`\`\`SEND [200]
${fixture.answer}
\`\`\`\``),
    ] });
    try {
        await writeFile(join(fixture.workspace, "incident.txt"), content);
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "oversized-attachment", projectRoot: fixture.workspace });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: ["incident.txt"],
                });
                assert.equal(result.finalStatus, 200);
                const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: result.loopId });
                assert.equal(turns.filter(({ kind }) => kind === "overflow").length, 0, "no recovery turn is manufactured");
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const attachment = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(attachment);
                assert.equal(attachment.status_rx, 200, "the page is an ordinary result");
                const page = JSON.parse(attachment.rx) as { content: string; region?: { startLine: number; endLine: number; endColumn: number } };
                const chars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);
                assert.equal(page.content.length, chars, "the character bound cuts the one long line");
                assert.equal(content.startsWith(page.content), true, "the page is the head of the line");
                assert.equal(page.region?.startLine, 1);
                assert.equal(page.region?.endLine, 1, "the cut is inside line 1 and says so");
                const answer = rows.find((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(answer, "the model's own range READ ran");
                assert.equal(answer.status_rx, 200);
                assert.match((JSON.parse(answer.rx) as { content: string }).content, new RegExp(fixture.answer, "u"), "a range of the same file fits and answers");
                assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), content);
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally { await fixture.cleanup(); }
});

for (const retire of [false, true]) test(`{§tokenomics}: sixteen attachments land whole until the budget runs out, then as receipts, with the READ rows ${retire ? "retired" : "retained"}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const fixture = await seedAttachmentFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("````KILL (log:///**/FIND)````\n````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
            makeMockResponse(`${retire ? "````KILL (log:///**/READ)````\n" : ""}\`\`\`\`SEND [200]
${fixture.answer}
\`\`\`\``),
        ],
    });
    try {
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: "attachments-fit", projectRoot: fixture.workspace });
                assert.equal(created.error, undefined);
                const workspaceId = (created.result as { id: number }).id;
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths,
                     maxTurns: 6,
                }, { timeoutMs: 20_000 });
                assert.equal(result.finalStatus, 200);
                assert.ok(result.modelSessionId);
                const evidence = await assertContextFitEvidence({
                    db, daemon, workspaceId, sessionId: result.modelSessionId,
                    turnIds: result.turnIds ?? [], fixture,
                });
                assert.ok(evidence.landed > 0, "the first attachments fit and landed whole");
                assert.ok(evidence.receipts > 0, "the budget ran out: the rest are receipts");
                assert.equal(evidence.modelTurns, 2, "receipts cost no turn; the model answered in two");
                assert.equal(evidence.receiptActive, !retire);
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const recovered = rows.filter((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.equal(recovered.length, 1, "the model made its own recovery READ");
                assert.equal(recovered[0].status_rx, 200);
                assert.match(JSON.parse(recovered[0].rx).content, new RegExp(fixture.answer, "u"), "the scripted answer is backed by a delivered result");
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
        await fixture.cleanup();
    }
});
});

describe("output-admission", () => {
const messages =[{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });
const providerAt = (capacity: number, responses: MockResponse[]): Mock => {
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new Mock({ contextWindow: 1_000_000, responses });
    } finally {
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
};
const continuing = "````NOTE\nReview the evidence.\n````";

const receipt = (row: Record<string, unknown>): { lines: number; tokens: number; remaining: number; detail: string } => {
    const problem = (row.problem ?? {}) as { detail?: string; lines?: number; tokens?: number; remaining?: number };
    return { lines: Number(problem.lines), tokens: Number(problem.tokens), remaining: Number(problem.remaining), detail: problem.detail ?? "" };
};

// {§packet} — the room a test pins is measured, not guessed: the first packet's weight
// plus the margin the story needs.
const floorWeight = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, sessionId: number, loopId: number): Promise<number> => {
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ initialMessages: messages, workspaceId, sessionId, loopId, provider: providerAt(999_000, []), currentTurnSeq: 1, gitStatus: null });
    return packet.weight;
};
const pageLines = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
const pageChars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);

test("{§packet}: a READ without a scope lands as its first page, bounded by lines and characters, naming the page of the whole; a range READ reaches the rest", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `first-page-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const provider = providerAt(999_000, [
            response(`\`\`\`\`READ (workspace:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`READ (workspace:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 200, "the page is an ordinary result");
        const stored = JSON.parse(read.rx) as { content: string; range: { total: number; returned: [number, number] } };
        const [from, to] = stored.range.returned;
        assert.equal(from, 1);
        assert.ok(to < 600 && to <= pageLines, `the page is bounded: ${to} lines`);
        assert.ok(stored.content.length <= pageChars + 1, "and by characters");
        assert.equal(stored.content, content.split("\n").slice(0, to).join("\n"), "the page is the first lines, cut at a line boundary");
        assert.equal(stored.range.total, 600, "the whole is named beside the page");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const row = logEntries(packet).find((entry) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(entry.logPath))!;
        assert.equal(row.range, `<1,${to}> of 600 lines`, "{§log-wire-format}: one fact, one notation");
        assert.equal(String(row.body).trimEnd().split("\n").length, to, "the row shows exactly the page");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "an explicit scope is exact");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const whole = await clientRead(engine, db, { statement: readStmt(urlPath("workspace", "/large.md"), { marks: [1, -1] }), workspaceId, sessionId });
        assert.equal((whole as { content?: string }).content, content, "`<1,-1>` is the whole thing");
    } finally { await db.close(); }
});

test("{§tokenomics}: a page that does not fit the room lands as the longest prefix of its lines above a 413 receipt naming the lines delivered; the prefix holds the room until the receipt is killed, then a range READ succeeds", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        // A room 1,500 over the floor: the first page (about 8,000) cannot land whole, a few lines can.
        const room = await floorWeight(db, workspaceId, sessionId, loopId) + 1_500;
        const provider = providerAt(room, [
            response(`\`\`\`\`READ (workspace:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`KILL (log:///**/READ)\`\`\`\`\n\`\`\`\`READ (workspace:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413, "the page does not fit the remaining budget");
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { type: string; detail: string; lines: number; tokens: number; remaining: number; delivered: number }; range?: { total: number; returned?: [number, number] } };
        const delivered = stored.problem.delivered;
        assert.ok(Number.isSafeInteger(delivered) && delivered > 0 && delivered < stored.problem.lines, `a prefix of the page fit: ${delivered} of ${stored.problem.lines}`);
        assert.equal(stored.content, `${content.split("\n").slice(0, delivered).join("\n")}\n`, "the row carries the first lines delivered, cut at a line boundary");
        assert.equal(stored.problem.type, "https://problems.plurnk.xyz/engine/context/result-exceeds-budget");
        assert.match(stored.problem.detail, new RegExp(`^${stored.problem.lines} lines, \\d+ tokens; \\d+ tokens remain: ${delivered} lines? delivered; READ a range, or KILL first\\.$`, "u"));
        assert.ok(stored.problem.tokens > stored.problem.remaining, "the page did not fit");
        assert.deepEqual(stored.range?.returned, [1, delivered], "the returned range closes on the last line delivered");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        assert.ok(packet.weight <= room, "the receipt and its prefix fit where the page could not");
        const row = logEntries(packet).find((entry) => entry.status === 413 && /^log:\/\/\/1\/2\/\d+\/READ$/u.test(entry.logPath))!;
        assert.ok(row, "the receipt is a row of the next packet");
        assert.equal(String(row.body).trimEnd().split("\n").length, delivered, "the row shows exactly the lines delivered");
        const facts = receipt(row);
        assert.ok(facts.tokens > 0 && facts.remaining >= 0 && facts.tokens > facts.remaining);
        assert.match(facts.detail, /READ a range, or KILL first/u);
        assert.doesNotMatch(packetSection(packet, "budget"), /WARNING|MUST/u, "{§tokenomics}: the gauge is state, not a mandate");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "{§tokenomics}: the prefix held the room; KILL first, then a range READ takes a piece of what did not fit");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const whole = await clientRead(engine, db, { statement: readStmt(urlPath("workspace", "/large.md"), { marks: [1, -1] }), workspaceId, sessionId });
        assert.equal((whole as { content?: string }).content, content, "the complete result is where it was read from");
    } finally { await db.close(); }
});

test("{§tokenomics}: a READ whose first line does not fit is a bodiless receipt", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-line-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // One line longer than the page's characters: the page is a cut of that line, about 8,000 tokens.
        await seedEntryWithChannel(db, { workspaceId, pathname: "/line.md", content: "evidence ".repeat(4_000) });
        const room = await floorWeight(db, workspaceId, sessionId, loopId) + 1_500;
        const provider = providerAt(room, [response(`\`\`\`\`READ (workspace:///line.md)\`\`\`\`\n${continuing}`)]);
        const turn = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: turn.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413);
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { detail: string; lines: number; delivered?: number } };
        assert.equal(stored.content, null, "not one line fit: the row carries no body");
        assert.equal(stored.problem.delivered, undefined);
        assert.match(stored.problem.detail, /^1 line, \d+ tokens; \d+ tokens remain: READ a range, or KILL first\.$/u);
    } finally { await db.close(); }
});

test("{§tokenomics}: KILL first — the fit measure honours curation within the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-verbs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const filler = Array.from({ length: 100 }, (_, i) => `filler ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        const wanted = Array.from({ length: 100 }, (_, i) => `wanted ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/filler.md", content: filler });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/wanted.md", content: wanted });
        // `<1,-1>` asks for the whole file, so each READ is the whole 14,000 and not its page ({§packet}).
        const provider = providerAt(24_000, [
            response(`\`\`\`\`READ (workspace:///filler.md) <1,-1>\`\`\`\`\n${continuing}`),
            response([
                "````READ (workspace:///wanted.md) <1,-1>````",
                "````KILL (log:///1/*/*/READ)````",
                "````READ (workspace:///wanted.md) <1,-1>````",
                continuing,
            ].join("\n")),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const filled = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: first.turnId })).find((row) => row.op === "READ")!;
        assert.equal(filled.status_rx, 200, "the first file fits an empty room");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const reads = (await db.test_log_entries_by_turn.all<{ sequence: number; op: string; status_rx: number }>({ turn_id: second.turnId }))
            .filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))
            .toSorted((a, b) => a.sequence - b.sequence)
            .map(({ status_rx }) => status_rx);
        assert.deepEqual(reads, [413, 200], "before the KILL the room is full; after it the same READ fits");
    } finally { await db.close(); }
});

test("{§tokenomics}: an impossible window terminates the loop without provider calls or manufactured operations", async () => {
    const db = await openMigrated();
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        const workspaceId = await insertWorkspace(db, `output-floor-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        // An eleven-token window with a two-token output budget: no packet fits it.
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        const provider = new Mock({ contextWindow: 11, responses: [response(continuing)] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, messages, provider, maxTurns: 3 });
        assert.equal(result.result.status, 413);
        assert.equal(result.result.problem?.detail, "Context window overflow: the packet exceeds the model's window."); // {§operation-results}
        assert.equal(result.reason, "token_budget");
        assert.equal(provider.remaining, 1);
        const turn = await db.test_get_turn.get<{ packet: string | null }>({ id: result.turnIds.at(-1)! });
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
        const rows = await db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: result.turnIds.at(-1)! });
        assert.ok(rows.every(({ op }) => !["WAIT", "KILL"].includes(op)), "no recovery disposition or curation program is manufactured");
    } finally {
        await db.close();
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET; else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET; else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
});

test("{§tokenomics}: over budget but under the wall, the packet goes with one 413 row at its head, the gauge shows it over, and authored state is untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-authorship-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const note = "Remember ".repeat(5000);
        const wide = providerAt(999_000, [response(`\`\`\`\`NOTE\n${note}\n\`\`\`\``)]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: wide });
        const before = await db.engine_render_log.all({ session_id: sessionId });
        // A 12,000-token budget inside a million-token window: far over the budget, far under the wall.
        const small = providerAt(12_000, [response(continuing), response(continuing)]);
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: small });
        assert.equal(second.status, 102, "the over-budget packet is submitted, not ended");
        assert.equal(small.remaining, 1, "the provider was asked once");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const gauge = JSON.parse(packetSection(packet, "budget")) as { tokens: number; budget: number };
        assert.ok(gauge.tokens > gauge.budget, `the gauge shows the packet over: ${gauge.tokens} of ${gauge.budget}`);
        const rows = logEntries(packet).filter((row) => row.logPath.endsWith("/error"));
        assert.equal(rows.length, 1, "one row, at the head of the turn");
        const problem = (rows[0].problem ?? {}) as { detail?: string; excess?: number };
        assert.equal(problem.detail, "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn."); // {§operation-results}
        assert.equal(problem.excess, undefined, "{§tokenomics}: the gauge is the one home for the numbers");
        assert.equal(rows[0].origin, "_plurnk");
        const third = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: small });
        const next = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: third.turnId }))!.packet);
        const nextRows = logEntries(next).filter((row) => row.logPath.endsWith("/error"));
        assert.equal(nextRows.length, 1, "shown once: the earlier mandate has retired from the projection; a packet that is still over carries its own (#1097)");
        assert.notEqual(nextRows[0].logPath, rows[0].logPath, "the row in the next packet is that packet's own");
        const minted = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; active: number }>({ turn_id: second.turnId });
        assert.ok(minted.some(({ op, status_rx, active }) => op === "error" && status_rx === 413 && active === 1), "the retired mandate stays durable and active at its coordinate; only the packet projection drops it");
        const after = await db.engine_render_log.all<{ id: number }>({ session_id: sessionId });
        for (const row of before as Array<{ id: number }>) assert.deepEqual(after.find(({ id }) => id === row.id), row, "authored state cannot be removed or folded to manufacture a fit");
        const firstRows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.ok(firstRows.some(({ op, tx }) => op === "NOTE" && JSON.parse(tx).body === note), "the authored NOTE stands whole");
    } finally { await db.close(); }
});

for (const origin of ["client", "_plurnk"] as const) test(`{§tokenomics}: ${origin} output crosses maintenance and loop boundaries whole, result and all`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-origin-${origin}-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const earlier = await Turn.open(db, { loopId, producer: origin, kind: "operation" });
        const content = "result ".repeat(1_000);
        const result = { ...Results.failure("scheme:session", "output-failure", 503, "Connection closed."), content, mimetype: "text/plain", startLine: 1 };
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: earlier.id, sequence: 1, origin,
            source: null, model_call_id: null, op: "READ", scheme: "workspace", pathname: "/result",
            username: null, password: null, hostname: null, port: null, query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json", rx: JSON.stringify(result), mimetype_rx: "application/json",
            status_rx: 503, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await Turn.complete(db, earlier.id, 102);
        const maintenance = await Turn.open(db, { loopId, producer: "_plurnk", kind: "maintenance" });
        await Turn.complete(db, maintenance.id, 200);
        const laterLoop = await insertLoop(db, sessionId, 2);
        const schemes = new SchemeRegistry();
        const provider = providerAt(999_000, [response(continuing)]);
        const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
        await builder.buildRequestPacket({ initialMessages: messages, workspaceId, sessionId, loopId: laterLoop, provider, currentTurnSeq: 1, gitStatus: null });
        const before = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ session_id: sessionId });
        assert.equal(before.find(({ id }) => id === inserted!.id)!.folded, "[]", "speculative construction has no projection effects");
        const next = await new Engine({ db, schemes }).runTurn({ workspaceId, sessionId, loopId: laterLoop, messages, provider });
        assert.equal(provider.remaining, 0);
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const row = logEntries(packet).find(({ logPath: path }) => path === `log:///1/${earlier.sequence}/1/READ`)!;
        assert.equal(row.status, 503, "the actual operation result is not restamped");
        assert.equal((row.problem as { detail: string }).detail, "Connection closed.");
        assert.match(String(row.body), /result result/u, "the retained result arrives whole: nothing is withheld");
        const projected = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ session_id: sessionId });
        assert.equal(projected.find(({ id }) => id === inserted!.id)!.folded, "[]");
        assert.deepEqual(JSON.parse(projected.find(({ id }) => id === inserted!.id)!.rx), result);
    } finally { await db.close(); }
});

test("{§packet}: structured section content directly follows its heading; Git is a NOTE", () => {
    for (const header of ["Errors", "Context", "Open Messages"]) {
        assert.equal(PacketWire.renderSection({ header, content: "[]" }), `## ${header}\n[]`);
    }
    const git = PacketWire.renderGit({ branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
    assert.equal(git, "> [!NOTE]\n> branch `main` — 0 staged, 0 unstaged, 0 untracked");
    assert.equal(PacketWire.renderSection({ header: "Git Status", content: git }), `## Git Status\n\n${git}`);
});
});

describe("packet-calibration", () => {
const messages = [{ role: "system" as const, content: "S" }, { role: "user" as const, content: "review" }];
const outputBudget = Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
const providerAt = (capacity: number | null, responses: MockResponse[] = [], model = "mock"): Mock =>
    new class extends Mock { override get model(): string { return model; } }({
        contextWindow: capacity === null ? null : capacity + outputBudget,
        responses,
    });
const response = (reported = 0): MockResponse => ({
    assistant: { content: "", reasoning: null, ops: [completeStmt("done")] },
    usage: { inputTokens: reported, totalTokens: reported },
});

const fixture = async (t: TestContext, prompt = "review") => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `packet-units-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, prompt);
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const packets = new PacketBuilder({ db, schemes, executors: () => undefined });
    const build = (provider = providerAt(100_000)) => packets.buildRequestPacket({
        workspaceId, sessionId, loopId, provider,
        initialMessages: messages, currentTurnSeq: 10, gitStatus: null,
    });
    return { db, workspaceId, sessionId, loopId, engine, packets, build };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

// The default reported count sits well under the smallest sample packet's weight, so the default
// direction is an enlarging conversion whatever turn zero carries.
const recordSamples = async ({ db, engine }: Fixture, counts = [100, 100, 100], model = "mock") => {
    const workspaceId = await insertWorkspace(db, `sample-source-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "sample");
    const provider = providerAt(100_000, counts.map(response), model);
    const recorded: Array<{ turnId: number; packet: string }> = [];
    for (let sample = 0; sample < counts.length; sample++) {
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(row);
        recorded.push({ turnId: result.turnId, packet: row.packet });
    }
    return { loopId, recorded };
};

const prepareLog = async ({ db, workspaceId, sessionId, loopId, engine }: Fixture) => {
    const turnId = await insertTurn(db, loopId, 1);
    const args = { workspaceId, sessionId, loopId, turnId, origin: "model" as const };
    const target = urlPath("workspace", "/notes.txt");
    const content = "alpha beta gamma ".repeat(2_000);
    const created = await engine.dispatch({ ...args, sequence: 1, statement: editStmt(target, content) });
    assert.equal(created.status, 201);
    let readId = 0;
    const read = await engine.dispatch({
        ...args, sequence: 2, statement: readStmt(target, { marks: [1, -1] }),
        onDispatch: (id) => { readId = id; },
    });
    assert.equal(read.status, 200);
    assert.equal((await engine.dispatch({ ...args, sequence: 3, statement: findStmt(target) })).status, 200);
    assert.equal((await engine.dispatch({
        ...args, sequence: 4, statement: killStmt(urlPath("log", "/1/1/1/EDIT")),
    })).status, 200);
    return { args, content, readId };
};

const budgetOf = (packet: RequestPacket): {
    tokens: number;
    budget: number;
    largest?: Array<{ path: string; tokens: number }>;
} => JSON.parse(packetSection(packet, "budget").split("\n")[0]);

test("{§log-wire-format} non-unit calibration preserves one ruler for READ, FIND, inventory and total", async (t) => {
    const f = await fixture(t);
    await prepareLog(f);
    const uncalibrated = await f.build();
    await recordSamples(f);
    const offset = await TokenCalibration.forLoop(f.db, "mock", f.loopId);
    assert.ok(offset > 0);
    const provider = providerAt(Math.max(1, Math.floor(uncalibrated.weight / 0.85) - offset));
    const packet = await f.build(provider);
    const state = budgetOf(packet);
    const rows = logEntries(packet);
    const read = rows.find(({ logPath: path }) => path === "log:///1/1/2/READ")!;
    assert.ok(read.tokens < state.tokens, "a visible READ cannot outweigh its complete packet");
    assert.equal(state.tokens, packet.weight, "the total retains the measured curation ruler");
    // {§packet-assembly}: each complete message is measured once.
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, message) => sum + contentWeight(message.content), 0));
    assert.equal(state.budget, TokenCalibration.capacity(provider.inputCapacity, offset));
    assert.deepEqual(rows, logEntries(uncalibrated), "neither receipt nor FIND item costs are rewritten by calibration");
    const find = rows.find(({ logPath: path }) => path === "log:///1/1/3/FIND")!;
    assert.ok(Number(find.itemsTokenTotal) > 0, "the FIND witness has real resource accounting");
    assert.ok(state.largest?.some(({ path }) => path === read.logPath), "pressure identifies the dominant body");
    for (const item of state.largest!) {
        const row = rows.find(({ logPath: path }) => path === item.path)!;
        assert.equal(item.tokens, row.tokens, "the same row has the same cost in the pressure inventory");
    }
    assert.equal(f.packets.curationOverflow(packet), null);
});

test("{§tokenomics} {§tokenomics} new shared-model samples cannot resize the cached log or the folded prompt", async (t) => {
    const prompt = "A".repeat(40_000);
    const f = await fixture(t, prompt);
    const provider = providerAt(20_000, [response()]);
    const turn = await f.engine.runTurn({
        ...f, provider, messages: [{ role: "system", content: "S" }, { role: "user", content: prompt }],
    });
    const persisted = (await f.db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet;
    const before = await f.build(provider);
    const arrival = logEntries(before).find(({ logPath: path }) => path.endsWith("/SEND"));
    assert.ok(arrival, "the arrival row is in the packet");
    assert.equal(arrival.body, undefined, "the message did not fit the budget: it landed folded, its row its size and address");
    assert.deepEqual(Object.keys(arrival.size as object).toSorted(), ["lines", "tokens"], "the folded arrival states its size, never a preview");
    await recordSamples(f);
    const after = await f.build(provider);
    assert.notEqual(budgetOf(before).budget, budgetOf(after).budget, "the ceiling uses new model evidence");
    assert.equal(packetSection(after, "log"), packetSection(before, "log"), "all historical rows, including the bounded prompt, stay byte-identical");
    const prefix = (packet: RequestPacket) => PacketWire.packetToWireMessages(packet)
        .map(({ content }) => content.split("## Context")[0]).join("\n");
    assert.equal(prefix(after), prefix(before), "the complete prefix before the volatile budget remains reusable");
    await recordSamples(f, [10_000, 10_000, 10_000, 10_000, 10_000]);
    const tighter = await f.build(provider);
    assert.ok(budgetOf(tighter).budget < budgetOf(before).budget, "a tighter conversion shrinks the room: the inverse direction is exercised too");
    assert.equal(packetSection(tighter, "log"), packetSection(before, "log"), "a shrinking allowance does not resize cached historical content either");
    assert.equal((await f.db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet, persisted, "calibration never rewrites request history");
});

test("{§tokenomics} a loop's latest sample updates its offset; zero counts and other models leave it", async (t) => {
    const f = await fixture(t);
    const { loopId, recorded } = await recordSamples(f, [100, 200, 300, 400, 500, 600, 700]);
    const offset = StoredPacket.parse(recorded.at(-1)!.packet)!.weight - 700;
    assert.equal(await TokenCalibration.forLoop(f.db, "mock", loopId), offset, "the loop's latest response sets its offset");
    assert.equal(await TokenCalibration.forLoop(f.db, "mock", f.loopId), offset, "a loop without its own sample takes the model's latest offset");
    await recordSamples(f, [0, 0, 0]);
    await recordSamples(f, [10_000, 10_000, 10_000], "other-model");
    assert.equal(await TokenCalibration.forLoop(f.db, "mock", f.loopId), offset, "zero counts and other models fix nothing for this model");
    assert.equal(budgetOf(await f.build()).budget, TokenCalibration.capacity(100_000, offset), "a different session consumes the same model evidence");
    const later = await recordSamples(f, [50, 900]);
    const latestLater = StoredPacket.parse(later.recorded.at(-1)!.packet)!.weight - 900;
    assert.equal(await TokenCalibration.forLoop(f.db, "mock", f.loopId), latestLater, "the latest model offset seeds a loop that has none");
    assert.equal(await TokenCalibration.forLoop(f.db, "mock", loopId), offset, "a loop with its own sample keeps its own latest offset");
});

test("{§tokenomics} overflow and attribution copies use the allowance captured at packet build", async (t) => {
    const f = await fixture(t);
    await prepareLog(f);
    const uncalibrated = await f.build();
    const capacity = uncalibrated.weight - 100;
    const provider = providerAt(capacity);
    const before = await f.build(provider);
    const expected = { weight: before.weight, budget: capacity, excess: before.weight - capacity };
    assert.ok(expected.excess > 0);
    await recordSamples(f);
    const after = await f.build(provider);
    assert.equal(f.packets.curationOverflow(after), null, "new packets may use the larger converted allowance");
    assert.deepEqual(f.packets.curationOverflow(before), expected, "new samples do not reinterpret an older candidate");
    assert.deepEqual(f.packets.curationOverflow({ ...before, attributions: [] }), expected);
    assert.equal(f.packets.curationBudgetFor(before), budgetOf(before).budget);
    assert.throws(() => f.packets.curationOverflow({ ...before, sections: [...before.sections] }), /packet was not built by this PacketBuilder/u);
});

test("{§tokenomics} the response cannot retroactively change its own packet allowance or physical usage", async (t) => {
    const f = await fixture(t);
    const { recorded } = await recordSamples(f);
    const priorOffset = await TokenCalibration.forLoop(f.db, "mock", f.loopId);
    const provider = providerAt(50_000, [response(17_000)]);
    const result = await f.engine.runTurn({ ...f, provider, messages });
    const raw = (await f.db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet;
    const packet = StoredPacket.parse(raw)!;
    const state = budgetOf(packet);
    const usage = await f.engine.loopUsage(f.loopId);
    assert.notEqual(await TokenCalibration.forLoop(f.db, "mock", f.loopId), priorOffset, "the loop's response updates the offset for its subsequent packets");
    assert.equal(state.budget, TokenCalibration.capacity(provider.inputCapacity, priorOffset));
    assert.equal(usage.curationBudget, state.budget);
    assert.equal(usage.curationWeight, state.tokens);
    assert.equal(usage.curationWeight, packet.weight);
    assert.equal(usage.contextCapacity, provider.inputCapacity, "physical capacity is not converted");
    assert.equal(usage.contextTokens, 17_000, "reported usage stays provider-token evidence");
    assert.equal(usage.accounting.usage?.inputTokens, 17_000);
    for (const saved of recorded) {
        assert.equal((await f.db.test_get_packet.get<{ packet: string }>({ id: saved.turnId }))!.packet, saved.packet);
    }
});

test("{§tokenomics} failed and rejected provider attempts retain their captured curation pair", async (t) => {
    for (const scenario of ["provider failure", "invalid emissions", "cancellation"] as const) {
        await t.test(scenario, async (t) => {
            const f = await fixture(t);
            await recordSamples(f);
            const offset = await TokenCalibration.forLoop(f.db, "mock", f.loopId);
            const rejected: MockResponse = {
                assistant: { content: "````READ (workspace:///not-an-operation", reasoning: null },
                usage: { inputTokens: 17_000, totalTokens: 17_000 },
            };
            const responses = scenario === "invalid emissions"
                ? Array.from({ length: Number(process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS) }, () => rejected)
                : [];
            const provider = providerAt(50_000, responses);
            const cancellation = new AbortController();
            const reason = new Error("cancel calibration witness");
            if (scenario === "cancellation") {
                t.mock.method(provider, "generate", async () => {
                    cancellation.abort(reason);
                    throw reason;
                });
            }
            const run = f.engine.runTurn({ ...f, provider, messages, signal: cancellation.signal });
            if (scenario === "cancellation") await assert.rejects(run, (error) => error === reason);
            else assert.equal((await run).status, scenario === "invalid emissions" ? 102 : 502);
            const turns = await f.db.test_list_turns_in_loop.all<{ status: number; packet: string }>({ loop_id: f.loopId });
            const attempted = turns.at(-1)!;
            if (scenario === "cancellation") assert.equal(attempted.status, 499);
            const packet = StoredPacket.parse(attempted.packet)!;
            const usage = await f.engine.loopUsage(f.loopId);
            assert.equal("assistant" in packet, false, "no failed or rejected request invents an accepted assistant response");
            assert.equal(usage.curationWeight, packet.weight);
            assert.equal(budgetOf(packet).tokens, packet.weight);
            assert.equal(usage.curationBudget, TokenCalibration.capacity(provider.inputCapacity, offset));
            assert.equal(usage.curationBudget, budgetOf(packet).budget);
        });
    }
});

test("{§log-wire-format} scoped and whole KILL reclaim stable costs without altering source or forensic bytes", async (t) => {
    const f = await fixture(t);
    const { args, content, readId } = await prepareLog(f);
    await recordSamples(f);
    const raw = await f.db.tok_log_weight.get<{ rx: string; weight: number }>({ id: readId });
    const before = await f.build();
    const read = logEntries(before).find(({ logPath: path }) => path === "log:///1/1/2/READ")!;
    assert.equal((await f.engine.dispatch({ ...args, sequence: 5, statement: killStmt(urlPath("log", "/1/1/2/READ"), { marks: [1, -1] }) })).status, 200);
    const trimmed = await f.build();
    const trimmedRead = logEntries(trimmed).find(({ logPath: path }) => path === read.logPath)!;
    assert.equal(trimmedRead.body, undefined);
    const renderedRead = (packet: RequestPacket) => packetSection(packet, "log")
        .split("\n\n").find((row) => row.startsWith(`### ${read.logPath} `))!;
    assert.equal(read.tokens, contentWeight(renderedRead(before)));
    assert.equal(read.tokens - trimmedRead.tokens,
        contentWeight(renderedRead(before)) - contentWeight(renderedRead(trimmed)),
        "the scoped KILL's saving is the actual row-size change, without a conversion multiplier");
    assert.ok(trimmed.weight < before.weight, "the large body removal more than pays for its receipt");
    assert.equal((await f.engine.dispatch({ ...args, sequence: 6, statement: killStmt(urlPath("log", "/1/1/2/READ")) })).status, 200);
    const killed = await f.build();
    assert.equal(logEntries(killed).some(({ logPath: path }) => path === read.logPath), false);
    for (const packet of [before, trimmed, killed]) {
        assert.equal(budgetOf(packet).tokens, packet.weight);
        // {§packet-assembly}: each complete message is measured once.
        assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, message) => sum + contentWeight(message.content), 0));
        assert.equal(budgetOf(packet).budget, budgetOf(before).budget);
    }
    assert.deepEqual(await f.db.tok_log_weight.get({ id: readId }), raw, "curation cannot alter the immutable READ result or its write-time weight");
    const source = await f.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.txt", scheme: "workspace", name: "body" });
    assert.equal(source?.content, content, "log curation does not delete source content");
});

test("{§tokenomics} unknown and unseen-model capacities do not borrow another model's conversion", async (t) => {
    const f = await fixture(t);
    await recordSamples(f);
    const fresh = await f.build(providerAt(25_000, [], "unseen-model"));
    assert.equal(budgetOf(fresh).budget, 25_000);
    assert.equal(budgetOf(fresh).tokens, fresh.weight);
    const unknown = await f.build(providerAt(null));
    const gauge = JSON.parse(packetSection(unknown, "budget")) as { tokens: number; budget?: number; largest?: unknown[] };
    assert.deepEqual(Object.keys(gauge), ["tokens"], "without a capacity the gauge has no budget or pressure inventory to name");
    assert.equal(gauge.tokens, unknown.weight);
    assert.equal(f.packets.curationBudgetFor(unknown), null);
    assert.equal(f.packets.curationOverflow(unknown), null);
});

test("{§tokenomics} a converted zero allowance takes ordinary overflow recovery, not a provider request", async (t) => {
    const f = await fixture(t);
    await recordSamples(f, [10_000, 10_000, 10_000]);
    const provider = providerAt(1);
    const packet = await f.build(provider);
    assert.equal(budgetOf(packet).budget, 0);
    assert.deepEqual(f.packets.curationOverflow(packet), { weight: packet.weight, budget: 0, excess: packet.weight });
    const result = await f.engine.runTurn({ ...f, provider, messages });
    assert.equal(result.status, 413);
    assert.equal(result.curationFailure?.problem?.budget, 0);
    assert.equal(provider.received.length, 0, "no representable curation allowance cannot produce an admitted request");
});

test("{§tokenomics} a loop's budget follows its latest response either way, unaffected by other loops", async (t) => {
    for (const [direction, count] of [["enlarges", 100], ["shrinks", 10_000]] as const) {
        await t.test(direction, async (t) => {
            const f = await fixture(t);
            const provider = providerAt(20_000, [response(count)]);
            assert.equal(budgetOf(await f.build(provider)).budget, 20_000, "with no sample, the capacity is the room");
            const turn = await f.engine.runTurn({ ...f, provider, messages });
            const weight = StoredPacket.parse((await f.db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet)!.weight;
            const calibrated = TokenCalibration.capacity(20_000, weight - count)!;
            assert.equal(calibrated > 20_000, direction === "enlarges", `the response ${direction} the room`);
            const after = await f.build(provider);
            assert.equal(budgetOf(after).budget, calibrated);
            await recordSamples(f, direction === "enlarges" ? [10_000] : [100]);
            assert.equal(budgetOf(await f.build(provider)).budget, calibrated, "another loop's newer sample does not move this loop's room");
            assert.equal(f.packets.curationBudgetFor(after), budgetOf(after).budget, "admission measures the room the model is shown");
        });
    }
});
});

describe("window-unpollable", () => {
test("{§tokenomics} null window + no per-alias knob → NO-CAP: the turn builds unbounded and the gauge omits its headline", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `unpollable-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mock = new Mock({ contextWindow: null, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        const result = await engine.runTurn({ provider: mock, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(result.turnId > 0, "the turn builds unbounded — a probe blip degrades to no-cap, never crashes the loop");
        assert.equal((await engine.loopUsage(loopId)).curationBudget, null, "the client sees no invented allowance when physical capacity is unknown");
        // The gauge omits its active maximum; denominator-independent log measurements remain.
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const budget = packet.sections.find((s) => s.name === "budget");
        assert.ok(budget, "the budget section still ships");
        assert.doesNotMatch(budget.content, /budget/, "no maximum — the window is unbounded, there is no percent to show");
    } finally { await db.close(); }
});
});
