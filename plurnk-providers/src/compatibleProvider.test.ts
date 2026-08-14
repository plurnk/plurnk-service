import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { compatibleProviderFromEnv } from "./compatibleProvider.ts";

const env = {
    OPENAI_BASE_URL: "http://local.test/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "1000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REASONING: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_REASONING_RESERVE: "10%",
    PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
    PLURNK_PROVIDERS_PROBE_DELAY: "0",
    PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "1",
};

test.afterEach(() => mock.restoreAll());

test("compatible endpoints preserve configured prompt-cache affinity", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "local", n_ctx: 8192 }] }));
        }
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            model: "local",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { headers: { "content-type": "application/json" } });
    });

    const provider = await compatibleProviderFromEnv("openai", env, "local");
    await provider.generate({
        workerId: "worker-affinity",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(body?.prompt_cache_key, "worker-affinity");
});

test("the server-wide DRY-off floor emits no DRY request fields", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "local", meta: { n_ctx: 8192 } }],
            }));
        }
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            model: "local",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { headers: { "content-type": "application/json" } });
    });

    const provider = await compatibleProviderFromEnv("openai", {
        ...env,
        PLURNK_PROVIDERS_DRY_MULTIPLIER: "0",
        // Stale or independently supplied shape values cannot activate DRY.
        PLURNK_PROVIDERS_DRY_BASE: "1.75",
        PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH: "32",
    }, "local");
    await provider.generate({
        workerId: "worker-dry-off",
        messages: [{ role: "user", content: "repeat exactly" }],
    });

    assert.equal(body?.repeat_penalty, 1.15);
    assert.equal("dry_multiplier" in (body ?? {}), false);
    assert.equal("dry_base" in (body ?? {}), false);
    assert.equal("dry_allowed_length" in (body ?? {}), false);
});

test("detected llama-server measures the complete chat request through input_tokens", async () => {
    let countUrl: string | undefined;
    let countBody: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "served.gguf", meta: { n_ctx: 8192 } }],
            }));
        }
        if (url.endsWith("/props")) {
            return new Response(JSON.stringify({ total_slots: 1 }));
        }
        if (url.endsWith("/chat/completions/input_tokens")) {
            countUrl = url;
            countBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ input_tokens: 37 }), {
                headers: { "content-type": "application/json" },
            });
        }
        throw new Error(`unexpected request ${url}`);
    });

    const provider = await compatibleProviderFromEnv("openai", env, "local");
    const messages = [
        { role: "system" as const, content: "system slot" },
        { role: "user" as const, content: "漢漢漢" },
    ];
    assert.deepEqual(await provider.countPromptTokens(messages), {
        kind: "exact",
        tokens: 37,
        source: "llama-server:/v1/chat/completions/input_tokens",
    });
    assert.equal(countUrl, "http://local.test/v1/chat/completions/input_tokens");
    assert.deepEqual(countBody?.messages, messages, "measurement receives the exact dispatched message slots");
    assert.equal(countBody?.model, "local");
    assert.deepEqual(countBody?.chat_template_kwargs, { enable_thinking: false });
});

test("a missing llama-server input-token endpoint degrades explicitly, never to a claimed bound", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "served.gguf", meta: { n_ctx: 8192 } }],
            }));
        }
        if (url.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }));
        if (url.endsWith("/chat/completions/input_tokens")) return new Response("missing", { status: 404 });
        throw new Error(`unexpected request ${url}`);
    });

    const provider = await compatibleProviderFromEnv("openai", env, "local");
    assert.deepEqual(await provider.countPromptTokens([{ role: "user", content: "漢漢漢" }]), {
        kind: "estimate",
        tokens: 2,
        source: "heuristic:chars2",
        detail: "llama-server input-token endpoint returned HTTP 404",
    });
});
