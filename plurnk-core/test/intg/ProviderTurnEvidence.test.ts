import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Turn from "../../src/core/Turn.ts";
import ModelCall from "../../src/core/ModelCall.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Mock,
    type InputModality,
    type MockResponse,
    type Provider,
    type ProviderRequestAccounting,
    type ProviderResponse,
} from "@plurnk/plurnk-providers";
import { insertLoop, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { testProviderCapacity, viableWindow, testDeferredProviderCapacity } from "./_provider.ts";
import { completeStmt } from "./_dsl.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import { type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import { type Db } from "../../src/core/Db.ts";
import { connect, rpcCall, withDaemon, rpcProblem } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";

describe("attribution", () => {
// {§emission-admission}
const response = (content: string): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    assistantRaw: null,
});

const invalid = response("````READ (workspace:///unframed-prose");
const valid = response("\n````SEND\ndone\n````");
const canonical = (...tags: string[]): string[] => [...new Set(tags)].toSorted();

test("{§emission-admission} each emission attempt composes opaque family hooks and records exactly what it composed", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const sessionIdentity = await db.test_sessions_get_provider_identity.get<{ provider_identity: string }>({ id: sessionId });
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const contexts: ExtensionAttributionContext[] = [];

        const schemes = new SchemeRegistry();
        schemes.attributions = ({ attempt }) => ["shared", `scheme:${attempt}`];
        const executors = new ExecutorRegistry(new Map());
        executors.attributions = ({ attempt }) => ["shared", `executor:${attempt}`];
        const mimetypes = new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map(), packageAttributions: new Map(), skipped: [] },
        });
        mimetypes.attributions = async ({ attempt }) => ["shared", `mimetype:${attempt}`];

        const provider = new Mock({ contextWindow: 100_000, responses: [invalid, valid] });
        const providerWithAttribution = provider as Mock & {
            attributions?: (context: ExtensionAttributionContext) => readonly string[];
        };
        providerWithAttribution.attributions = (context) => {
            contexts.push(context);
            return ["shared", `provider:${context.attempt}`];
        };
        const engine = new Engine({ db, schemes, mimetypes });
        engine.setExecutors(executors);
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const first = canonical("shared", "scheme:1", "executor:1", "mimetype:1", "provider:1");
        const second = canonical("shared", "scheme:2", "executor:2", "mimetype:2", "provider:2");
        assert.deepEqual(contexts, [
            {
                workspaceId: String(workspaceId),
                sessionId: sessionIdentity?.provider_identity,
                loop: 1,
                turn: 2,
                attempt: 1,
            },
            {
                workspaceId: String(workspaceId),
                sessionId: sessionIdentity?.provider_identity,
                loop: 1,
                turn: 2,
                attempt: 2,
            },
        ], "extensions receive only the exact provider-attempt coordinates");

        const attempts = await db.test_turn_attempts.all<{ sequence: number; attributions: string }>({
            turn_id: result.turnId,
        });
        assert.deepEqual(
            attempts.map(({ sequence, attributions }) => ({ sequence, attributions: JSON.parse(attributions) })),
            [
                { sequence: 1, attributions: first },
                { sequence: 2, attributions: second },
            ],
            "attempt evidence retains each exact composed set",
        );

        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { attributions: string[] };
        assert.deepEqual(packet.attributions, second, "the turn request retains the latest attempted set");
        assert.deepEqual(
            await engine.loopAttributions(loopId),
            canonical(...first, ...second),
            "loop reporting derives its union from exact request evidence",
        );
    } finally {
        await db.close();
    }
});

test("{§emission-admission} an empty folksonomy omits the provider field but persists the exact empty request set", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100_000, responses: [valid] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        assert.deepEqual((JSON.parse(row!.packet) as { attributions: string[] }).attributions, []);
        assert.deepEqual(await engine.loopAttributions(loopId), []);
    } finally {
        await db.close();
    }
});
});

describe("client-settings", () => {
test("{§operation-results} workspace.create refuses an empty client id", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "workspace.create", { name: "bad-client", settings: { client: "" } });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(problem.field, "settings.client");
            assert.equal(problem.recovery, "Provide the client identifier."); // {§operation-results}
        } finally { ws.close(); }
    });
});
});

describe("coordinate-metadata", () => {
// {§provider-surface}: core supplies the workspace this call serves as ordinary call context.
class CoordMock extends Mock {
    seen: { workspaceId?: string; sessionId?: string; callKind?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; sessionId?: string; callKind?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, sessionId: args.sessionId, callKind: args.callKind };
        return super.generate(args);
    }
}

test("{§provider-surface} generate carries the workspace this call serves, and its durable session identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, sessionId, 5, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "the workspace id, stringified");
        assert.equal(mock.seen.callKind, "emission", "ordinary turns declare the emission output contract");
    } finally { await db.close(); }
});
});

describe("meta-passthrough", () => {
// {§provider-surface}: provider metadata reaches the client through loop usage
// as an opaque, unenforced blob.
class MetaProvider implements Provider {
    #base: Mock;
    #meta: Record<string, unknown>;
    constructor(meta: Record<string, unknown>) {
        this.#base = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        this.#meta = meta;
    }
    get contextWindow(): number | null { return this.#base.contextWindow; }
    get maxInputTokens(): number | null { return this.#base.maxInputTokens; }
    get maxOutputTokens(): number | null { return this.#base.maxOutputTokens; }
    get outputBudget(): number | null { return this.#base.outputBudget; }
    get reasoningBudget(): number | null { return this.#base.reasoningBudget; }
    get supportedEfforts() { return this.#base.supportedEfforts; }
    get inputCapacity(): number | null { return this.#base.inputCapacity; }
    get outputFloor(): number | null { return this.#base.outputFloor; }
    get inputWall(): number | null { return this.#base.inputWall; }
    get model(): string { return this.#base.model; }
    get inputModalities(): ReadonlySet<InputModality> { return this.#base.inputModalities; }
    countPromptTokens(...args: Parameters<Mock["countPromptTokens"]>): ReturnType<Mock["countPromptTokens"]> {
        return this.#base.countPromptTokens(...args);
    }
    assessRequestCapacity(...args: Parameters<Mock["assessRequestCapacity"]>): ReturnType<Mock["assessRequestCapacity"]> {
        return this.#base.assessRequestCapacity(...args);
    }
    async generate(args: Parameters<Mock["generate"]>[0]): Promise<ProviderResponse> {
        return { ...(await this.#base.generate(args)), meta: this.#meta };
    }
}

test("{§provider-surface} a provider's opaque meta blob rides through to the loop usage payload, unenforced", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const meta = { balance: { amount: "0.000123456789", currency: "XMR" }, vendorWhatever: { nested: true }, future: "field we never coded for" };
        await engine.runTurn({ provider: new MetaProvider(meta), workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        // Forwarded verbatim — including fields the service has never heard of (the honest passthrough).
        assert.deepEqual(usage.meta, meta, "the provider's whole meta blob reaches the loop payload, byte-for-byte");
        assert.deepEqual((usage.meta as { balance: object }).balance, meta.balance, "provider metadata is reachable by the client");
    } finally { await db.close(); }
});

test("{§provider-surface} no provider meta → empty {} (never null, never fabricated)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // A plain Mock returns no `meta`.
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        assert.deepEqual(usage.meta, {}, "absent provider meta surfaces as {}, so the client renders nothing");
    } finally { await db.close(); }
});
});

describe("operator-grammar", () => {
// {§provider-instantiation} across a real core turn: an
// operator's GBNF file reaches the provider verbatim, unrelated alias settings never leak, an
// unreadable grammar fails instead of running unconstrained, and the turn records
// transport as evidence (#588).
const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const usage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 1 },
};

const staticProvider = (response: Omit<ProviderResponse, "accounting" | "capacity">): Provider => ({
    model: "fake",
    inputModalities: new Set<InputModality>(),
    contextWindow: 100000,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget: 1,
    reasoningBudget: null,
    supportedEfforts: ["off", "adaptive", "low", "medium", "high"],
    inputCapacity: 99999,
    inputWall: null,
    outputFloor: null,
    constrainsOutput: true,
    generate: async ({ messages, observeRequest }) => {
        const accounting = {
            provider: "provider:fake",
            model: "fake",
            outcome: "response",
            usage,
            cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "rail fixture" },
        } as const;
        const settle = await observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return { ...response, accounting: [accounting], capacity: testProviderCapacity(messages, 100000) };
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
    assessRequestCapacity: async (messages) => testProviderCapacity(messages, 100000),
});

// A Mock that RECORDS what generate receives — the end of the chain, observed directly.
const recordingProvider = (): { provider: Provider; calls: Array<{ grammar?: string }> } => {
    const calls: Array<{ grammar?: string }> = [];
    const base = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: "````SEND\nok\n````", reasoning: null } },
    ] });
    // plain delegation — a Proxy breaks Mock's private-field getters (#contextWindow via Reflect)
    const provider = {
        get contextWindow() { return base.contextWindow; },
        get maxInputTokens() { return base.maxInputTokens; },
        get maxOutputTokens() { return base.maxOutputTokens; },
        get outputBudget() { return base.outputBudget; },
        get reasoningBudget() { return base.reasoningBudget; },
        get supportedEfforts() { return base.supportedEfforts; },
        get inputModalities() { return base.inputModalities; },
        get inputCapacity() { return base.inputCapacity; },
        get inputWall() { return base.inputWall; },
        get outputFloor() { return base.outputFloor; },
        get model() { return base.model; },
        countPromptTokens: (...args: Parameters<Mock["countPromptTokens"]>) => base.countPromptTokens(...args),
        assessRequestCapacity: (...args: Parameters<Mock["assessRequestCapacity"]>) => base.assessRequestCapacity(...args),
        generate: (args: { grammar?: string }) => { calls.push({ grammar: args.grammar }); return base.generate(args as never); },
    } as unknown as Provider;
    return { provider, calls };
};

const envelope = async (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const workspaceId = await insertWorkspace(db, `rail-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    return { workspaceId, sessionId, loopId };
};

test("{§provider-instantiation} the operator's grammar file text reaches generate through a real turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railprobe";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railprobe");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(calls.length, 1, "one generate call");
        assert.equal(calls[0].grammar, 'root ::= "PROBE-RAIL"\n', "the grammar FILE TEXT arrived at the provider, verbatim");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("{§provider-instantiation} an alias-free provider ignores unrelated suffixed grammars and uses the global configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_someotheralias";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        // Remove the active selector so this provider is explicitly alias-free.
        const modelKeys = Object.keys(process.env).filter((k) => k.startsWith("PLURNK_MODEL"));
        const savedModels = modelKeys.map((k) => [k, process.env[k]] as const);
        for (const k of modelKeys) delete process.env[k];
        try {
            const { provider, calls } = recordingProvider();
            ProviderInstantiate.registerConfigurationScope(provider, null);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const { workspaceId, sessionId, loopId } = await envelope(db);
            await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
            assert.equal(calls.length, 1);
            assert.equal(calls[0].grammar, undefined, "another alias's grammar is not a global fallback");
        } finally { for (const [k, v] of savedModels) process.env[k] = v; }
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

for (const path of ["/nonexistent/rail/never-here.gbnf", `missing-${crypto.randomUUID()}.gbnf`]) test(`{§provider-instantiation} unreadable ${path} fails before inference`, async () => {
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railbroken";
    const prior = process.env[key];
    try {
        process.env[key] = path;
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railbroken");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 }),
            { code: "ENOENT" },
        );
        assert.equal(calls.length, 0, "unreadable grammar never falls back to unconstrained inference");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
    }
});

test("{§provider-instantiation} a filename in the daemon working directory reaches the provider verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const previousCwd = process.cwd();
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railnamed";
    const prior = process.env[key];
    try {
        const grammar = 'root ::= "LOCAL-GRAMMAR"\n';
        await writeFile(join(dir, "local.gbnf"), grammar);
        process.chdir(dir);
        process.env[key] = "local.gbnf";
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railnamed");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.deepEqual(calls, [{ grammar }]);
    } finally {
        process.chdir(previousCwd);
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§provider-instantiation} the turn records whether the grammar reached the wire, and grades nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "evidence.gbnf");
    await writeFile(gbnfPath, 'root ::= "anything the operator wrote"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_evidencebox";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        // The emission does not match the grammar at all; nothing in the service cares.
        const content = "````SEND\ndone\n````";
        const transported = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: true },
        });
        ProviderInstantiate.registerConfigurationScope(transported, "evidencebox");
        const t1 = await engine.runTurn({ provider: transported, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        const meta1 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t1.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta1.railsAttached, "client", "transport evidence is recorded");
        assert.deepEqual(Object.keys(meta1), ["railsAttached"], "the turn records transport evidence and nothing else");

        const withheld = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: false },
        });
        ProviderInstantiate.registerConfigurationScope(withheld, "evidencebox");
        const t2 = await engine.runTurn({ provider: withheld, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
        const meta2 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t2.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta2.railsAttached, "withheld", "a provider that did not send it says so, and the turn still completes");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});
});

describe("provider-accounting", () => {
// {§provider-request-accounting}: normalized physical requests are the only
// accounting authority; every broader total is an exact derived projection.
test("{§provider-surface} model evidence cannot be orphaned or replaced by a fabricated terminal state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `model-specialization-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "specialization");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const call = await ModelCall.open(db, {
            turnId: turn.id, kind: "emission", attributions: [], model: "fixture/generation-model",
        });
        await assert.rejects(
            db.test_delete_model_call_specialization.run({ id: call.id }),
            /cannot be deleted independently/u,
        );
        await assert.rejects(
            db.test_terminalize_inference_call_without_evidence.run({ id: call.id, state: "response" }),
            /terminal state requires specialization evidence/u,
        );
        assert.equal((await db.test_workspaces_delete.run({ id: workspaceId })).changes, 1);
        assert.deepEqual(await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }), []);
    } finally { await db.close(); }
});

const openRequest = async (
    db: Db,
    loopId: number,
    turnSequence: number,
    accounting: ProviderRequestAccounting,
): Promise<void> => {
    const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
    assert.equal(turn.sequence, turnSequence);
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turn.id,
        kind: "emission",
        attributions: "[]",
        model: accounting.model,
    });
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall!.id,
    });
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall!.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request!.id, accounting),
    );
    assert.equal(settled.changes, 1);
    if (accounting.outcome === "response") {
        await db.engine_observe_model_call_response.run({
            id: modelCall!.id,
            native_inputs: "[]",
            response: JSON.stringify({ assistant: { content: "fixture" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("accounting:fixture")),
            finish_reason: "stop",
            model: accounting.model,
        });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt!.id,
            accepted: 1,
            parse_errors: "[]",
        });
    } else {
        await db.engine_fail_model_call.run({
            id: modelCall!.id,
            failure: JSON.stringify({ status: 502, problem: { status: 502 } }),
            capacity: null,
        });
    }
    await Turn.recordInference(db, turn.id, {
        packet: JSON.stringify({ weight: 0, attributions: [] }),
        sections: "[]",
        usageCurationBudget: null,
        finishReason: accounting.outcome === "response" ? "stop" : null,
        model: accounting.model,
        meta: "{}",
    });
    await Turn.complete(db, turn.id, accounting.outcome === "response" ? 200 : 502);
};

const fixture = async (): Promise<{
    db: Db;
    loopId: number;
}> => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `money-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "account");
    return { db, loopId };
};

test("{§provider-request-accounting} loop accounting adds decimal strings exactly without denormalized rollups", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            cost: {
                kind: "estimated",
                amount: { amount: "0.1", currency: "USD" },
                source: "fixture rate",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "response",
            usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
            cost: {
                kind: "charged",
                amount: { amount: "0.2", currency: "USD" },
                source: "fixture charge",
            },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.3");
        assert.deepEqual(accounting.usage, {
            inputTokens: 30,
            outputTokens: 5,
            totalTokens: 35,
        });
        assert.equal(accounting.requests.length, 2);
    } finally {
        await db.close();
    }
});

test("{§provider-request-accounting} one unknown request makes the total unknown without erasing its known subtotal", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            cost: {
                kind: "charged",
                amount: { amount: "4.25", currency: "USD" },
                source: "direct charge",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "error",
            cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, null, "the unknown request is not free");
        assert.equal(accounting.knownCostUsd, "4.25", "received price evidence survives separately");
        assert.equal(accounting.requests[0]?.cost.kind, "charged");
        assert.equal(accounting.requests[1]?.cost.kind, "unknown");
    } finally {
        await db.close();
    }
});

test("{§provider-request-accounting} the baseline has no floating-point or denormalized accounting columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-money-schema-"));
    const path = join(dir, "plurnk.db");
    const db = await openMigrated(path);
    try {
        const tableInfo = (table: string): Promise<Array<{ name: string; type: string }>> =>
            db.test_provider_accounting_table_info.all({ table });
        for (const table of [
            "workspaces",
            "sessions",
            "turns",
            "inference_calls",
            "model_calls",
            "turn_attempts",
        ]) {
            assert.equal(
                (await tableInfo(table)).some(({ name }) => name.startsWith("usage_") || name === "cost_usd"),
                table === "turns",
                `${table} has no accounting rollup (turns retains only usage_curation_budget)`,
            );
        }
        assert.deepEqual(
            (await tableInfo("turns")).filter(({ name }) => name.startsWith("usage_")).map(({ name }) => name),
            ["usage_curation_budget"],
        );
        assert.equal(
            (await tableInfo("provider_requests")).some(({ type }) => type === "REAL"),
            false,
            "money is stored as canonical TEXT, never REAL",
        );
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});
