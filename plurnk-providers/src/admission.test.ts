import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import InferenceAdmission from "./InferenceAdmission.ts";
import Pool from "./Pool.ts";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate, setTimeout } from "node:timers/promises";
import { loadActiveProvider } from "./ProviderRegistry.ts";
import { ProviderError } from "./errors.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { effectiveInputCapacity, effectiveInputWall } from "./capacity.ts";
import { type Provider, type PromptTokenMeasurement, type ProviderResponse } from "./types.ts";

const endpoint = async (t: TestContext, rejectOnce?: { id: string; status: number; headers?: Record<string, string> }) => {
    const opened: string[] = [];
    const active = new Map<string, ServerResponse>();
    const arrivals = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    let peak = 0;
    const server = createServer(async (request, response) => {
        if (request.url === "/v1/models") {
            response.end(JSON.stringify({ data: [{ id: "local", meta: { n_ctx: 8192 } }] }));
            return;
        }
        if (request.url === "/props") {
            response.end(JSON.stringify({ total_slots: 1 }));
            return;
        }
        if (request.url === "/api/show") {
            response.end(JSON.stringify({ model_info: { "fixture.context_length": 8192 } }));
            return;
        }
        if (request.url === "/v1/chat/completions/input_tokens") {
            response.end(JSON.stringify({ input_tokens: 2 }));
            return;
        }
        let input = "";
        for await (const chunk of request) input += chunk;
        const body = JSON.parse(input);
        const id = body.messages.at(-1).content as string;
        opened.push(id);
        if (rejectOnce?.id === id && opened.filter((value) => value === id).length === 1) {
            response.writeHead(rejectOnce.status, { "content-type": "application/json", ...rejectOnce.headers });
            response.end(JSON.stringify({ error: { message: "controlled upstream rejection" } }));
            return;
        }
        active.set(id, response);
        peak = Math.max(peak, active.size);
        response.on("close", () => active.delete(id));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
            id, model: body.model, object: "chat.completion.chunk", created: 1,
            choices: [{ index: 0, delta: { content: id }, finish_reason: null }],
        })}\n\n`);
        arrivals.get(id)?.resolve();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return {
        url: `http://127.0.0.1:${address.port}/v1`,
        opened,
        get peak() { return peak; },
        async wait(id: string) {
            if (active.has(id)) return;
            const arrival = Promise.withResolvers<void>();
            arrivals.set(id, arrival);
            await arrival.promise;
        },
        fail(id: string) {
            const response = active.get(id);
            assert.ok(response);
            active.delete(id);
            response.destroy();
        },
        finish(id: string) {
            const response = active.get(id);
            assert.ok(response, `${id} reached inference before completing`);
            active.delete(id);
            response.end(`data: ${JSON.stringify({
                id, model: "test", object: "chat.completion.chunk", created: 1,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            })}\n\ndata: [DONE]\n\n`);
        },
    };
};

const provider = (url: string, route: string, overrides: NodeJS.ProcessEnv = {}) => loadActiveProvider({
    PLURNK_MODEL: "limited",
    PLURNK_MODEL_limited: route,
    PLURNK_BASEURL_limited: url,
    OPENAI_API_KEY: "test-key",
    PLURNK_PROVIDERS_EFFORT: "off",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "5000",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "2000",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_MAX_CONCURRENCY_LIMITED: "1",
    ...overrides,
});

const generate = (p: Provider, id: string, signal?: AbortSignal, observeRequest?: Parameters<Provider["generate"]>[0]["observeRequest"]) => p.generate({
    sessionId: id,
    messages: [{ role: "user", content: id }],
    signal,
    observeRequest,
});

for (const [name, route] of [
    ["native SDK", "openai/gpt-4.1-mini"],
    ["catalog compatible", "fireworks-ai/accounts/fireworks/models/kimi-k3"],
    ["local compatible", "openai/local"],
    ["Ollama SDK", "ollama/local"],
] as const) {
    test(`{§provider-inference-admission} ${name} shares one streaming slot across provider instances and cancels queued work`, { timeout: 10000 }, async (t) => {
        const wire = await endpoint(t);
        const extra = { FIREWORKS_API_KEY: "test-key" };
        const firstProvider = await provider(wire.url, route, extra);
        const secondProvider = await provider(wire.url, route, {
            ...extra,
            PLURNK_MODEL: "second",
            PLURNK_MODEL_second: route,
            PLURNK_BASEURL_second: wire.url,
            PLURNK_PROVIDERS_MAX_CONCURRENCY_second: "1",
        });
        const first = generate(firstProvider, "first");
        await wire.wait("first");
        const cancel = new AbortController();
        const reason = new Error("cancel queued child");
        let opened = 0;
        const cancelled = generate(secondProvider, "cancelled", cancel.signal, async () => {
            opened += 1;
            return async () => {};
        });
        const rejected = assert.rejects(cancelled, (error) => error === reason);
        const third = generate(secondProvider, "third");
        await setImmediate();
        cancel.abort(reason);
        await rejected;
        assert.equal(opened, 0, "queued work is not recorded as a physical provider request");
        wire.finish("first");
        assert.equal((await first).assistant.content, "first");
        await wire.wait("third");
        wire.finish("third");
        assert.equal((await third).assistant.content, "third");
        assert.deepEqual(wire.opened, ["first", "third"]);
        assert.equal(wire.peak, 1, "headers and the first delta do not release streaming capacity");
    });
}

test("{§provider-inference-admission} queued expiry preserves the operation deadline without accounting for an unsent request", { timeout: 10000 }, async (t) => {
    const wire = await endpoint(t);
    const p = await provider(wire.url, "openai/gpt-4.1-mini");
    const short = await provider(wire.url, "openai/gpt-4.1-mini", { PLURNK_PROVIDERS_OPERATION_TIMEOUT: "50" });
    const first = generate(p, "first");
    await wire.wait("first");
    await assert.rejects(generate(short, "expired"), (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, "deadline_exceeded");
        assert.equal(error.problem.timeoutPhase, "operation");
        assert.deepEqual(error.accounting, []);
        return true;
    });
    const third = generate(p, "third");
    wire.finish("first");
    await first;
    await wire.wait("third");
    wire.finish("third");
    await third;
    assert.deepEqual(wire.opened, ["first", "third"]);
});

test("{§provider-inference-admission} queueing and generation do not use the discovery deadline", { timeout: 10000 }, async (t) => {
    const wire = await endpoint(t);
    const discoveryMs = 100;
    const p = await provider(wire.url, "openai/gpt-4.1-mini", {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: String(discoveryMs),
    });
    const first = generate(p, "first");
    await wire.wait("first");
    const second = generate(p, "second");
    // Past the discovery deadline: a generation or a queued request it bounded would have failed by now.
    await setTimeout(discoveryMs * 2.5);
    wire.finish("first");
    await first;
    await wire.wait("second");
    wire.finish("second");
    assert.equal((await second).assistant.content, "second");
    assert.deepEqual(wire.opened, ["first", "second"]);
});

for (const failure of ["abort", "disconnect"] as const) {
    test(`{§provider-inference-admission} in-flight ${failure} releases capacity to a queued session`, { timeout: 10000 }, async (t) => {
        const wire = await endpoint(t);
        const p = await provider(wire.url, "openai/gpt-4.1-mini");
        const cancel = new AbortController();
        const first = generate(p, "first", cancel.signal);
        const failed = assert.rejects(first, (error) => {
            if (failure === "abort") assert.equal(error, cancel.signal.reason);
            else {
                assert.ok(error instanceof ProviderError);
                assert.equal(error.kind, "network_failure");
                assert.equal(error.accounting.length, 1);
            }
            return true;
        });
        await wire.wait("first");
        const second = generate(p, "second");
        if (failure === "abort") cancel.abort(new Error("cancel active child"));
        else wire.fail("first");
        await failed;
        await wire.wait("second");
        wire.finish("second");
        assert.equal((await second).assistant.content, "second");
        assert.deepEqual(wire.opened, ["first", "second"]);
    });
}

test("{§provider-inference-admission} retry backoff relinquishes the slot and preserves ordered physical accounting", { timeout: 10000 }, async (t) => {
    const wire = await endpoint(t, { id: "retry", status: 429, headers: { "retry-after": "1" } });
    const p = await provider(wire.url, "openai/gpt-4.1-mini", { PLURNK_PROVIDERS_RETRY_ATTEMPTS: "1" });
    const retried = generate(p, "retry");
    const sibling = generate(p, "sibling");
    await wire.wait("sibling");
    assert.deepEqual(wire.opened, ["retry", "sibling"], "sibling runs during the provider-directed delay");
    wire.finish("sibling");
    await sibling;
    await wire.wait("retry");
    wire.finish("retry");
    const result = await retried;
    assert.equal(result.assistant.content, "retry");
    assert.deepEqual(result.accounting.map(({ outcome }) => outcome), ["error", "response"]);
    assert.deepEqual(wire.opened, ["retry", "sibling", "retry"]);
    assert.equal(wire.peak, 1);
});

test("{§provider-inference-admission} rejected physical request releases capacity without retrying", { timeout: 10000 }, async (t) => {
    const wire = await endpoint(t, { id: "rejected", status: 400 });
    const p = await provider(wire.url, "openai/gpt-4.1-mini");
    const rejected = assert.rejects(generate(p, "rejected"), (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, "request_rejected");
        assert.equal(error.accounting.length, 1);
        return true;
    });
    const sibling = generate(p, "sibling");
    await rejected;
    await wire.wait("sibling");
    wire.finish("sibling");
    assert.equal((await sibling).assistant.content, "sibling");
});

test("{§provider-inference-admission} distinct endpoints remain independent", { timeout: 10000 }, async (t) => {
    const a = await endpoint(t);
    const b = await endpoint(t);
    const first = generate(await provider(a.url, "openai/gpt-4.1-mini"), "a");
    const second = generate(await provider(b.url, "openai/gpt-4.1-mini"), "b");
    await Promise.all([a.wait("a"), b.wait("b")]);
    a.finish("a");
    b.finish("b");
    assert.deepEqual((await Promise.all([first, second])).map((result) => result.assistant.content), ["a", "b"]);
});

for (const limit of [-1, 2]) {
    test(`{§provider-inference-admission} configured concurrency ${limit}`, { timeout: 10000 }, async (t) => {
        const wire = await endpoint(t);
        const p = await provider(wire.url, "openai/gpt-4.1-mini", { PLURNK_PROVIDERS_MAX_CONCURRENCY_LIMITED: String(limit) });
        const observed: string[] = [];
        const calls = ["one", "two", "three"].map((id) => generate(p, id, undefined, async () => {
            observed.push(id);
            return async () => {};
        }));
        await Promise.all([wire.wait("one"), wire.wait("two")]);
        if (limit === -1) await wire.wait("three");
        assert.deepEqual(observed, limit === -1 ? ["one", "two", "three"] : ["one", "two"]);
        wire.finish("one");
        await wire.wait("three");
        wire.finish("two");
        wire.finish("three");
        await Promise.all(calls);
        assert.equal(wire.peak, limit === -1 ? 3 : limit);
        assert.deepEqual(wire.opened, ["one", "two", "three"]);
    });
}

test("{§provider-inference-admission} conflicting aliases cannot create independent allowances on one endpoint", async (t) => {
    const wire = await endpoint(t);
    await provider(wire.url, "openai/gpt-4.1-mini");
    await assert.rejects(provider(wire.url, "openai/gpt-4.1-mini", {
        PLURNK_PROVIDERS_MAX_CONCURRENCY_LIMITED: "2",
    }), (error: Error) => error.message.includes(new URL(wire.url).href.replace(/\/+$/, ""))
        && /conflicting PLURNK_PROVIDERS_MAX_CONCURRENCY values -?\d+ and 2/.test(error.message),
    "the refusal names the endpoint and both limits");
});

for (const value of ["0", "-2", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    test(`{§provider-inference-admission} invalid limit ${value} fails before inference`, async (t) => {
        const wire = await endpoint(t);
        await assert.rejects(provider(wire.url, "openai/gpt-4.1-mini", {
            PLURNK_PROVIDERS_MAX_CONCURRENCY_LIMITED: value,
        }), /MAX_CONCURRENCY must be -1 or a positive safe integer/);
        assert.deepEqual(wire.opened, []);
    });
}

for (const [name, route] of [
    ["native SDK", "openai/gpt-4.1-mini"],
    ["catalog compatible", "fireworks-ai/accounts/fireworks/models/kimi-k3"],
    ["local compatible", "openai/local"],
    ["Ollama SDK", "ollama/local"],
] as const) {
    test(`{§provider-failure-normalization} ${name}: the whole-call deadline bounds an endpoint that never sends headers`, { timeout: 10000 }, async (t) => {
        const received = Promise.withResolvers<void>();
        const server = createServer(async (request, response) => {
            if (request.url === "/v1/models") return void response.end(JSON.stringify({ data: [{ id: "local", meta: { n_ctx: 8192 } }] }));
            if (request.url === "/props") return void response.end(JSON.stringify({ total_slots: 1 }));
            if (request.url === "/api/show") return void response.end(JSON.stringify({ model_info: { "fixture.context_length": 8192 } }));
            if (request.url === "/v1/chat/completions/input_tokens") return void response.end(JSON.stringify({ input_tokens: 2 }));
            request.resume();
            await once(request, "end");
            received.resolve();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const p = await provider(`http://127.0.0.1:${address.port}/v1`, route, {
            FIREWORKS_API_KEY: "test-key",
            PLURNK_PROVIDERS_OPERATION_TIMEOUT: "150",
            PLURNK_PROVIDERS_FETCH_TIMEOUT: "6000",
        });
        await assert.rejects(generate(p, "headerless"), (error) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.kind, "deadline_exceeded");
            assert.equal(error.status, 504);
            assert.equal(error.problem.timeoutPhase, "operation");
            assert.equal(error.problem.timeoutMs, 150);
            assert.equal(error.accounting.length, 1, "the dispatched request is one settled physical attempt");
            return true;
        });
        await received.promise;
    });
}

{
const admission = (limit = 1) => InferenceAdmission.forEndpoint(`fixture:${crypto.randomUUID()}`, limit);

test("{§provider-inference-admission} FIFO reserves capacity synchronously, including handoff to a waiter", async () => {
    const gate = admission();
    const first = await gate.acquire();
    const order: number[] = [];
    const second = gate.acquire().then((release) => { order.push(2); return release; });
    const third = gate.acquire().then((release) => { order.push(3); return release; });
    await Promise.resolve();
    assert.equal(order.length, 0);
    first();
    const fourth = gate.acquire().then((release) => { order.push(4); return release; });
    const releaseSecond = await second;
    assert.deepEqual(order, [2]);
    releaseSecond();
    const releaseThird = await third;
    assert.deepEqual(order, [2, 3]);
    releaseThird();
    (await fourth)();
    assert.deepEqual(order, [2, 3, 4]);
});

test("{§provider-inference-admission} cancelled and already-aborted waiters consume no capacity", async () => {
    const gate = admission();
    const release = await gate.acquire();
    const cancellation = new AbortController();
    const reason = new Error("cancelled child");
    const cancelled = gate.acquire(cancellation.signal);
    const rejection = assert.rejects(cancelled, (error) => error === reason);
    const next = gate.acquire();
    cancellation.abort(reason);
    await rejection;
    assert.throws(() => gate.acquire(cancellation.signal), (error) => error === reason);
    release();
    (await next)();
    (await gate.acquire())();
});

test("{§provider-inference-admission} release cannot mint extra capacity", async () => {
    const gate = admission();
    const release = await gate.acquire();
    release();
    assert.throws(release, /lease was released twice/);
    (await gate.acquire())();
});

test("{§provider-inference-admission} equivalent endpoint URLs resolve one capacity owner", () => {
    const host = `${crypto.randomUUID()}.test`;
    assert.equal(
        InferenceAdmission.forEndpoint(`HTTP://${host.toUpperCase()}:80/v1/`, 1),
        InferenceAdmission.forEndpoint(`http://${host}/v1`, 1),
    );
});
}

{
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
        outputFloor: 4_800,
        reasoningBudget: null,
        inputCapacity: 36_000,
        inputWall: 43_200,
        responseMax: 12_000,
        prompt: { kind: "exact", tokens: 0, source: "test:exact" },
    },
};

type FakeOpts = {
    model?: string; window?: number | null; servedModel?: string;
    constrainsOutput?: boolean; requiresOutputBudget?: boolean;
    maxInputTokens?: number | null; maxOutputTokens?: number | null;
    outputBudget?: number | null; outputFloor?: number | null; reasoningBudget?: number | null;
    tokenize?: boolean; throws?: Error;
    promptMeasurement?: PromptTokenMeasurement;
};
// A fake backend that records which sessions it served, and optionally throws.
const backend = (opts: FakeOpts = {}) => {
    const served: string[] = [];
    const b: Provider = {
        model: opts.model ?? "gemma",
        inputModalities: new Set(),
        contextWindow: opts.window === undefined ? 48000 : opts.window,
        maxInputTokens: opts.maxInputTokens ?? null,
        maxOutputTokens: opts.maxOutputTokens ?? null,
        outputBudget: opts.outputBudget ?? null,
        outputFloor: opts.outputFloor ?? null,
        reasoningBudget: opts.reasoningBudget ?? null,
        supportedEfforts: ["off", "adaptive", "low", "medium", "high"],
        inputCapacity: effectiveInputCapacity({
            contextWindow: opts.window === undefined ? 48_000 : opts.window,
            maxInputTokens: opts.maxInputTokens ?? null,
            outputBudget: opts.outputBudget ?? null,
        }),
        inputWall: effectiveInputWall({
            contextWindow: opts.window === undefined ? 48_000 : opts.window,
            maxInputTokens: opts.maxInputTokens ?? null,
            outputFloor: opts.outputFloor ?? null,
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
            outputFloor: opts.outputFloor ?? null,
            reasoningBudget: opts.reasoningBudget ?? null,
            inputCapacity: null,
            inputWall: null,
            responseMax: maxOutputTokens ?? opts.outputBudget ?? null,
            prompt: opts.promptMeasurement ?? {
                kind: "exact",
                tokens: messages.reduce((sum, { content }) => sum + content.length, 0),
                source: "test:exact",
            },
        }),
        generate: async (args: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> => {
            served.push(args.sessionId);
            if (opts.throws !== undefined) throw opts.throws;
            return RESP;
        },
    };
    return { b, served };
};
const netErr = () => new ProviderError("provider:x", "network_failure", "down", { status: 503 });
const authErr = () => new ProviderError("provider:x", "unauthorized", "no key", { status: 401 });
const interruptedErr = () => new ProviderError("provider:x", "resource_interrupted", "generation interrupted");
const gen = (p: Pool, sessionId: string, extra: Record<string, unknown> = {}) =>
    p.generate({ messages: [], sessionId, ...extra });

// --- construction / homogeneity ---

test("{§provider-interface} Pool: empty backend list is rejected", () => {
    assert.throws(() => new Pool([]), /at least one backend/);
});

test("{§provider-interface} Pool: mixed models are rejected at construction (heterogeneous blend is not a pool)", () => {
    assert.throws(() => new Pool([backend({ model: "gemma" }).b, backend({ model: "grok" }).b]), /interchangeable/);
});

// --- surface aggregation ---

test("{§provider-interface} Pool: contextWindow is the safe floor (min) across backends", () => {
    assert.equal(new Pool([backend({ window: 48000 }).b, backend({ window: 32000 }).b]).contextWindow, 32000);
});

test("{§provider-interface} Pool: any unknown (null) window makes the pool null - no improvised cap", () => {
    assert.equal(new Pool([backend({ window: 48000 }).b, backend({ window: null }).b]).contextWindow, null);
});

test("{§provider-interface} Pool: physical limits and budgets aggregate to independent safe floors", () => {
    const big = backend({ window: 48000, maxInputTokens: 40_000, maxOutputTokens: 16_000, outputBudget: 12_000, reasoningBudget: 4_800 }).b;
    const small = backend({ window: 32000, maxInputTokens: 24_000, maxOutputTokens: 12_000, outputBudget: 8_000, reasoningBudget: 3_200 }).b;
    const p = new Pool([big, small]);
    assert.equal(p.contextWindow, 32000);
    assert.equal(p.maxInputTokens, 24_000);
    assert.equal(p.maxOutputTokens, 12_000);
    assert.equal(p.outputBudget, 8_000);
    assert.equal(p.reasoningBudget, 3_200);
});

test("{§provider-interface} Pool: capabilities aggregate conservatively (constrainsOutput all-true, requiresOutputBudget any-true)", () => {
    assert.equal(new Pool([backend({ constrainsOutput: true }).b, backend({ constrainsOutput: true }).b]).constrainsOutput, true);
    assert.equal(new Pool([backend({ constrainsOutput: true }).b, backend({ constrainsOutput: false }).b]).constrainsOutput, undefined);
    assert.equal(new Pool([backend({ requiresOutputBudget: false }).b, backend({ requiresOutputBudget: true }).b]).requiresOutputBudget, true);
    assert.equal(new Pool([backend({}).b]).requiresOutputBudget, undefined);
});

test("{§provider-interface} Pool: servedModel is the common id, undefined when they differ", () => {
    assert.equal(new Pool([backend({ servedModel: "g.gguf" }).b, backend({ servedModel: "g.gguf" }).b]).servedModel, "g.gguf");
    assert.equal(new Pool([backend({ servedModel: "g.gguf" }).b, backend({ servedModel: "h.gguf" }).b]).servedModel, undefined);
});

test("{§provider-interface} Pool: tokenize is exposed iff every backend has it", () => {
    assert.equal(typeof new Pool([backend({ tokenize: true }).b, backend({ tokenize: true }).b]).tokenize, "function");
    assert.equal(new Pool([backend({ tokenize: true }).b, backend({ tokenize: false }).b]).tokenize, undefined);
});

test("{§provider-interface} Pool: prompt counting delegates conservatively to its backends", async () => {
    const p = new Pool([backend().b]);
    assert.deepEqual(await p.countPromptTokens([{ role: "user", content: "abcd" }]), {
        kind: "exact", tokens: 4, source: "pool:test:exact",
    });
});

test("{§provider-interface} Pool: prompt evidence is conservative across every routable backend", async () => {
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

test("{§provider-capacity-admission} Pool: request capacity uses the smallest complete backend envelope", async () => {
    const prompt = { kind: "exact", tokens: 21, source: "test:exact" } as const;
    const narrowInput = backend({ window: 100, outputBudget: 90, outputFloor: 80, promptMeasurement: prompt }).b;
    const narrowContext = backend({ window: 50, outputBudget: 10, outputFloor: 5, promptMeasurement: prompt }).b;
    const pool = new Pool([narrowInput, narrowContext]);

    assert.equal(pool.inputCapacity, 10);
    assert.equal(pool.inputWall, 20);
    const capacity = await pool.assessRequestCapacity([]);
    assert.equal(capacity.contextWindow, 50);
    assert.equal(capacity.outputBudget, 10);
    assert.equal(capacity.outputFloor, 5);
    assert.equal(capacity.inputCapacity, 10, "independent minima do not synthesize a nonexistent 40-token envelope");
    assert.equal(capacity.inputWall, 20, "the wall is the smallest member wall, not the pool window less the pool floor");
    assert.equal(capacity.decision, "reject", "an exact prompt over the pool's wall is rejected ({§provider-capacity-admission})");
});

// --- dispatch: round-robin + affinity ---

test("{§provider-interface} Pool: NEW sessions round-robin across backends", async () => {
    const b0 = backend(), b1 = backend(), b2 = backend();
    const p = new Pool([b0.b, b1.b, b2.b]);
    await gen(p, "w1"); await gen(p, "w2"); await gen(p, "w3"); await gen(p, "w4");
    assert.deepEqual(b0.served, ["w1", "w4"]); // 0, then wraps at 3 % 3
    assert.deepEqual(b1.served, ["w2"]);
    assert.deepEqual(b2.served, ["w3"]);
});

test("{§provider-interface} Pool: a session STICKS to its backend across turns (KV-cache affinity)", async () => {
    const b0 = backend(), b1 = backend();
    const p = new Pool([b0.b, b1.b]);
    await gen(p, "w1"); await gen(p, "w2"); await gen(p, "w1"); await gen(p, "w1");
    assert.deepEqual(b0.served, ["w1", "w1", "w1"]); // w1 always backend 0
    assert.deepEqual(b1.served, ["w2"]);
});

// --- dispatch: overflow ---

test("{§provider-interface} Pool: a backend-availability failure overflows to a healthy sibling and re-sticks", async () => {
    const down = backend({ throws: netErr() }), up = backend();
    const p = new Pool([down.b, up.b]);
    await gen(p, "w1");                     // w1 -> backend 0 (down) -> overflow to backend 1 (up)
    assert.deepEqual(down.served, ["w1"]);
    assert.deepEqual(up.served, ["w1"]);
    await gen(p, "w1");                     // re-stuck: w1 now routes straight to backend 1
    assert.deepEqual(down.served, ["w1"]);  // NOT hit again
    assert.deepEqual(up.served, ["w1", "w1"]);
});

test("{§provider-interface} Pool: a terminal (auth) failure does NOT overflow", async () => {
    const bad = backend({ throws: authErr() }), other = backend();
    const p = new Pool([bad.b, other.b]);
    await assert.rejects(() => gen(p, "w1"), /no key/);
    assert.deepEqual(bad.served, ["w1"]);
    assert.deepEqual(other.served, []);     // never tried - auth fails the same on a peer
});

test("{§provider-interface} Pool does not overflow a resource-interrupted attempt and discard its evidence", async () => {
    const interrupted = backend({ throws: interruptedErr() }), other = backend();
    const pool = new Pool([interrupted.b, other.b]);
    await assert.rejects(
        () => gen(pool, "w1"),
        (error: unknown) => error instanceof ProviderError && error.kind === "resource_interrupted",
    );
    assert.deepEqual(interrupted.served, ["w1"]);
    assert.deepEqual(other.served, []);
});

test("{§provider-interface} Pool: whole fleet unavailable throws the last error, each backend tried once", async () => {
    const a = backend({ throws: netErr() }), b = backend({ throws: netErr() });
    const p = new Pool([a.b, b.b]);
    await assert.rejects(() => gen(p, "w1"), (e: unknown) => e instanceof ProviderError && e.kind === "network_failure");
    assert.deepEqual(a.served, ["w1"]);
    assert.deepEqual(b.served, ["w1"]);
});

test("{§provider-interface} Pool: an aborted signal propagates, never overflows", async () => {
    const down = backend({ throws: netErr() }), up = backend();
    const p = new Pool([down.b, up.b]);
    const ac = new AbortController(); ac.abort();
    await assert.rejects(() => gen(p, "w1", { signal: ac.signal }), /down/);
    assert.deepEqual(up.served, []);        // cancellation is not a failover
});

test("{§provider-interface} Pool: generate requires a sessionId (affinity keys on it)", async () => {
    await assert.rejects(() => gen(new Pool([backend().b]), ""), /sessionId is required/);
});
}
