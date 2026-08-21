import test from "node:test";
import { strict as assert } from "node:assert";
import Pool from "./Pool.ts";
import { ProviderError } from "./errors.ts";
import type { PromptTokenMeasurement, Provider, ProviderResponse } from "./types.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { effectiveInputCapacity } from "./capacity.ts";

test.afterEach(() => { resetEmittedWarnings(); });

const RESP: ProviderResponse = {
    assistant: {
        content: "ok",
        reasoning: null,
        finishReason: "stop",
        model: "gemma",
    },
    assistantRaw: null,
    accounting: [{
        provider: "provider:test",
        model: "gemma",
        outcome: "response",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { kind: "unknown", reason: "test fixture has no cost" },
    }],
    capacity: {
        decision: "admit",
        contextWindow: 48_000,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: 12_000,
        reasoningBudget: null,
        inputCapacity: 36_000,
        prompt: { kind: "exact", tokens: 0, source: "test:exact" },
    },
};

type FakeOpts = {
    model?: string; window?: number | null; servedModel?: string;
    constrainsOutput?: boolean; requiresOutputBudget?: boolean;
    maxInputTokens?: number | null; maxOutputTokens?: number | null;
    outputBudget?: number | null; reasoningBudget?: number | null;
    tokenize?: boolean; throws?: Error;
    promptMeasurement?: PromptTokenMeasurement;
};
// A fake backend that records which workers it served, and optionally throws.
const backend = (opts: FakeOpts = {}) => {
    const served: string[] = [];
    const b: Provider = {
        model: opts.model ?? "gemma",
        contextWindow: opts.window === undefined ? 48000 : opts.window,
        maxInputTokens: opts.maxInputTokens ?? null,
        maxOutputTokens: opts.maxOutputTokens ?? null,
        outputBudget: opts.outputBudget ?? null,
        reasoningBudget: opts.reasoningBudget ?? null,
        supportedReasoningPolicies: ["off", "adaptive", "low", "medium", "high"],
        inputCapacity: effectiveInputCapacity({
            contextWindow: opts.window === undefined ? 48_000 : opts.window,
            maxInputTokens: opts.maxInputTokens ?? null,
            outputBudget: opts.outputBudget ?? null,
        }),
        ...(opts.servedModel !== undefined ? { servedModel: opts.servedModel } : {}),
        ...(opts.constrainsOutput !== undefined ? { constrainsOutput: opts.constrainsOutput } : {}),
        ...(opts.requiresOutputBudget !== undefined ? { requiresOutputBudget: opts.requiresOutputBudget } : {}),
        ...(opts.tokenize ? { tokenize: async (t: string) => [t.length] } : {}),
        countPromptTokens: async (messages) => opts.promptMeasurement ?? ({
            kind: "exact",
            tokens: messages.reduce((sum, { content }) => sum + content.length, 0),
            source: "test:exact",
        }),
        assessRequestCapacity: async (messages, maxOutputTokens) => ({
            decision: "admit",
            contextWindow: opts.window === undefined ? 48_000 : opts.window,
            maxInputTokens: opts.maxInputTokens ?? null,
            maxOutputTokens: opts.maxOutputTokens ?? null,
            outputBudget: maxOutputTokens ?? opts.outputBudget ?? null,
            reasoningBudget: opts.reasoningBudget ?? null,
            inputCapacity: null,
            prompt: opts.promptMeasurement ?? {
                kind: "exact",
                tokens: messages.reduce((sum, { content }) => sum + content.length, 0),
                source: "test:exact",
            },
        }),
        generate: async (args: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> => {
            served.push(args.workerId);
            if (opts.throws !== undefined) throw opts.throws;
            return RESP;
        },
    };
    return { b, served };
};
const netErr = () => new ProviderError("provider:x", "network_failure", "down", { status: 503 });
const authErr = () => new ProviderError("provider:x", "unauthorized", "no key", { status: 401 });
const interruptedErr = () => new ProviderError("provider:x", "resource_interrupted", "generation interrupted");
const gen = (p: Pool, workerId: string, extra: Record<string, unknown> = {}) =>
    p.generate({ messages: [], workerId, ...extra } as Parameters<Provider["generate"]>[0]);

// --- construction / homogeneity ---

test("Pool: empty backend list is rejected", () => {
    assert.throws(() => new Pool([]), /at least one backend/);
});

test("Pool: mixed models are rejected at construction (heterogeneous blend is not a pool)", () => {
    assert.throws(() => new Pool([backend({ model: "gemma" }).b, backend({ model: "grok" }).b]), /interchangeable/);
});

// --- surface aggregation ---

test("Pool: contextWindow is the safe floor (min) across backends", () => {
    assert.equal(new Pool([backend({ window: 48000 }).b, backend({ window: 32000 }).b]).contextWindow, 32000);
});

test("Pool: any unknown (null) window makes the pool null - no improvised cap", () => {
    assert.equal(new Pool([backend({ window: 48000 }).b, backend({ window: null }).b]).contextWindow, null);
});

test("Pool: physical limits and budgets aggregate to independent safe floors", () => {
    const big = backend({ window: 48000, maxInputTokens: 40_000, maxOutputTokens: 16_000, outputBudget: 12_000, reasoningBudget: 4_800 }).b;
    const small = backend({ window: 32000, maxInputTokens: 24_000, maxOutputTokens: 12_000, outputBudget: 8_000, reasoningBudget: 3_200 }).b;
    const p = new Pool([big, small]);
    assert.equal(p.contextWindow, 32000);
    assert.equal(p.maxInputTokens, 24_000);
    assert.equal(p.maxOutputTokens, 12_000);
    assert.equal(p.outputBudget, 8_000);
    assert.equal(p.reasoningBudget, 3_200);
});

test("Pool: capabilities aggregate conservatively (constrainsOutput all-true, requiresOutputBudget any-true)", () => {
    assert.equal(new Pool([backend({ constrainsOutput: true }).b, backend({ constrainsOutput: true }).b]).constrainsOutput, true);
    assert.equal(new Pool([backend({ constrainsOutput: true }).b, backend({ constrainsOutput: false }).b]).constrainsOutput, undefined);
    assert.equal(new Pool([backend({ requiresOutputBudget: false }).b, backend({ requiresOutputBudget: true }).b]).requiresOutputBudget, true);
    assert.equal(new Pool([backend({}).b]).requiresOutputBudget, undefined);
});

test("Pool: servedModel is the common id, undefined when they differ", () => {
    assert.equal(new Pool([backend({ servedModel: "g.gguf" }).b, backend({ servedModel: "g.gguf" }).b]).servedModel, "g.gguf");
    assert.equal(new Pool([backend({ servedModel: "g.gguf" }).b, backend({ servedModel: "h.gguf" }).b]).servedModel, undefined);
});

test("Pool: tokenize is exposed iff every backend has it", () => {
    assert.equal(typeof new Pool([backend({ tokenize: true }).b, backend({ tokenize: true }).b]).tokenize, "function");
    assert.equal(new Pool([backend({ tokenize: true }).b, backend({ tokenize: false }).b]).tokenize, undefined);
});

test("Pool: prompt counting delegates conservatively to its backends", async () => {
    const p = new Pool([backend().b]);
    assert.deepEqual(await p.countPromptTokens([{ role: "user", content: "abcd" }]), {
        kind: "exact", tokens: 4, source: "pool:test:exact",
    });
});

test("Pool: prompt evidence is conservative across every routable backend", async () => {
    const exact = backend({ promptMeasurement: { kind: "exact", tokens: 8, source: "test:a" } }).b;
    const larger = backend({ promptMeasurement: { kind: "exact", tokens: 11, source: "test:b" } }).b;
    assert.deepEqual(await new Pool([exact, larger]).countPromptTokens([]), {
        kind: "upper_bound", tokens: 11, source: "pool:test:a,test:b",
    });

    const estimate = backend({ promptMeasurement: {
        kind: "estimate", tokens: 3, source: "heuristic:chars2", detail: "unknown framing",
    } }).b;
    assert.deepEqual(await new Pool([exact, estimate]).countPromptTokens([]), {
        kind: "estimate",
        tokens: 8,
        source: "pool:test:a,heuristic:chars2",
        detail: "at least one interchangeable backend has only an estimate: unknown framing",
    });

    const unavailable = backend({ promptMeasurement: {
        kind: "unavailable", source: "test:none", detail: "counter offline",
    } }).b;
    assert.deepEqual(await new Pool([exact, unavailable]).countPromptTokens([]), {
        kind: "unavailable",
        source: "pool:test:a,test:none",
        detail: "at least one interchangeable backend cannot measure the request: counter offline",
    });
});

test("Pool: request capacity uses the smallest complete backend envelope", async () => {
    const prompt = { kind: "exact", tokens: 11, source: "test:exact" } as const;
    const narrowInput = backend({ window: 100, outputBudget: 90, promptMeasurement: prompt }).b;
    const narrowContext = backend({ window: 50, outputBudget: 10, promptMeasurement: prompt }).b;
    const pool = new Pool([narrowInput, narrowContext]);

    assert.equal(pool.inputCapacity, 10);
    const capacity = await pool.assessRequestCapacity([]);
    assert.equal(capacity.contextWindow, 50);
    assert.equal(capacity.outputBudget, 10);
    assert.equal(capacity.inputCapacity, 10, "independent minima do not synthesize a nonexistent 40-token envelope");
    assert.equal(capacity.decision, "reject");
});

// --- dispatch: round-robin + affinity ---

test("Pool: NEW workers round-robin across backends", async () => {
    const b0 = backend(), b1 = backend(), b2 = backend();
    const p = new Pool([b0.b, b1.b, b2.b]);
    await gen(p, "w1"); await gen(p, "w2"); await gen(p, "w3"); await gen(p, "w4");
    assert.deepEqual(b0.served, ["w1", "w4"]); // 0, then wraps at 3 % 3
    assert.deepEqual(b1.served, ["w2"]);
    assert.deepEqual(b2.served, ["w3"]);
});

test("Pool: a worker STICKS to its backend across turns (KV-cache affinity)", async () => {
    const b0 = backend(), b1 = backend();
    const p = new Pool([b0.b, b1.b]);
    await gen(p, "w1"); await gen(p, "w2"); await gen(p, "w1"); await gen(p, "w1");
    assert.deepEqual(b0.served, ["w1", "w1", "w1"]); // w1 always backend 0
    assert.deepEqual(b1.served, ["w2"]);
});

// --- dispatch: overflow ---

test("Pool: a backend-availability failure overflows to a healthy sibling and re-sticks", async () => {
    const down = backend({ throws: netErr() }), up = backend();
    const p = new Pool([down.b, up.b]);
    await gen(p, "w1");                     // w1 -> backend 0 (down) -> overflow to backend 1 (up)
    assert.deepEqual(down.served, ["w1"]);
    assert.deepEqual(up.served, ["w1"]);
    await gen(p, "w1");                     // re-stuck: w1 now routes straight to backend 1
    assert.deepEqual(down.served, ["w1"]);  // NOT hit again
    assert.deepEqual(up.served, ["w1", "w1"]);
});

test("Pool: a terminal (auth) failure does NOT overflow", async () => {
    const bad = backend({ throws: authErr() }), other = backend();
    const p = new Pool([bad.b, other.b]);
    await assert.rejects(() => gen(p, "w1"), /no key/);
    assert.deepEqual(bad.served, ["w1"]);
    assert.deepEqual(other.served, []);     // never tried - auth fails the same on a peer
});

test("#161: Pool does not overflow a resource-interrupted attempt and discard its evidence", async () => {
    const interrupted = backend({ throws: interruptedErr() }), other = backend();
    const pool = new Pool([interrupted.b, other.b]);
    await assert.rejects(
        () => gen(pool, "w1"),
        (error: unknown) => error instanceof ProviderError && error.kind === "resource_interrupted",
    );
    assert.deepEqual(interrupted.served, ["w1"]);
    assert.deepEqual(other.served, []);
});

test("Pool: whole fleet unavailable throws the last error, each backend tried once", async () => {
    const a = backend({ throws: netErr() }), b = backend({ throws: netErr() });
    const p = new Pool([a.b, b.b]);
    await assert.rejects(() => gen(p, "w1"), (e: unknown) => e instanceof ProviderError && e.kind === "network_failure");
    assert.deepEqual(a.served, ["w1"]);
    assert.deepEqual(b.served, ["w1"]);
});

test("Pool: an aborted signal propagates, never overflows", async () => {
    const down = backend({ throws: netErr() }), up = backend();
    const p = new Pool([down.b, up.b]);
    const ac = new AbortController(); ac.abort();
    await assert.rejects(() => gen(p, "w1", { signal: ac.signal }), /down/);
    assert.deepEqual(up.served, []);        // cancellation is not a failover
});

test("Pool: generate requires a workerId (affinity keys on it)", async () => {
    await assert.rejects(() => gen(new Pool([backend().b]), ""), /workerId is required/);
});
