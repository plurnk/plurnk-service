import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { compatibleProviderFromEnv } from "./compatibleProvider.ts";

const env = {
    OPENAI_BASE_URL: "http://local.test/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
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

test("#567: the server-wide DRY-off floor emits no DRY request fields", async () => {
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
