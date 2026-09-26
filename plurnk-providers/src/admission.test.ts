import test, { type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate, setTimeout } from "node:timers/promises";
import { loadActiveProvider } from "./ProviderRegistry.ts";
import type { Provider } from "./types.ts";
import { ProviderError } from "./errors.ts";

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
    PLURNK_PROVIDERS_REASONING: "off",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "5000",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "2000",
    PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "2000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REPEATED_LINE_LIMIT: "0",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_MAX_CONCURRENCY_LIMITED: "1",
    ...overrides,
});

const generate = (p: Provider, id: string, signal?: AbortSignal, observeRequest?: Parameters<Provider["generate"]>[0]["observeRequest"]) => p.generate({
    workerId: id,
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

test("{§provider-inference-admission} queued time does not consume physical-attempt or first-content deadlines", { timeout: 10000 }, async (t) => {
    const wire = await endpoint(t);
    const p = await provider(wire.url, "openai/gpt-4.1-mini", {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "100",
        PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "100",
    });
    const first = generate(p, "first");
    await wire.wait("first");
    const second = generate(p, "second");
    await setTimeout(250);
    wire.finish("first");
    await first;
    await wire.wait("second");
    wire.finish("second");
    assert.equal((await second).assistant.content, "second");
    assert.deepEqual(wire.opened, ["first", "second"]);
});

for (const failure of ["abort", "disconnect"] as const) {
    test(`{§provider-inference-admission} in-flight ${failure} releases capacity to a queued worker`, { timeout: 10000 }, async (t) => {
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
    }), /conflicting.*MAX_CONCURRENCY/);
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
