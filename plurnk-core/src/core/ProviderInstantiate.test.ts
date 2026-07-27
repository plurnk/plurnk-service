import { test } from "node:test";
import assert from "node:assert/strict";
import ProviderInstantiate from "./ProviderInstantiate.ts";

// Regression: a per-alias baseUrl (PLURNK_BASEURL_<alias>) MUST reach the standard
// provider's endpoint resolution. When it was dropped, every openai-compat alias
// silently collapsed to an ambient OPENAI_BASE_URL, so a multi-endpoint setup ran
// the wrong box with no error. Here alias.baseUrl and OPENAI_BASE_URL point at
// different ports; the construction probe must hit the alias's port, never the env's.
test("instantiateProvider threads alias.baseUrl past an ambient OPENAI_BASE_URL", async () => {
    const hit: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((u: string | URL | Request, ...rest: unknown[]) => {
        hit.push(String(u));
        return (realFetch as (...a: unknown[]) => Promise<Response>)(u, ...rest);
    }) as typeof fetch;
    try {
        // Both endpoints are dead ports — we assert routing, not a live response, so
        // the probe's connection failure is expected and irrelevant.
        await ProviderInstantiate.instantiateProvider(
            { alias: "probe", provider: "openai", model: "m", baseUrl: "http://127.0.0.1:59731/v1" },
            { ...process.env, OPENAI_BASE_URL: "http://127.0.0.1:59732", PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500" },
        ).catch(() => {});
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.ok(hit.some((u) => u.startsWith("http://127.0.0.1:59731")), `probe must use alias.baseUrl; hit: ${hit.join(", ")}`);
    assert.ok(!hit.some((u) => u.startsWith("http://127.0.0.1:59732")), `probe must NOT fall through to OPENAI_BASE_URL; hit: ${hit.join(", ")}`);
});

test("[#525] an alias-scoped provider knob binds at construction — the per-alias CONTEXT_WINDOW pin is promoted, not dropped", async () => {
    // The regression: #construct passed raw env, so PLURNK_PROVIDERS_CONTEXT_WINDOW_<alias>
    // never reached the factory and min(cap, served) could not bind on any path.
    const provider = await ProviderInstantiate.instantiateProvider(
        { alias: "pinbox", provider: "openai", model: "test-model", baseUrl: "http://127.0.0.1:9" },
        { ...process.env, OPENAI_API_KEY: "k", PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500", PLURNK_PROVIDERS_CONTEXT_WINDOW_PINBOX: "8000", PLURNK_PROVIDERS_PROBE_NCTX: "0" },
    );
    assert.equal(provider.contextWindow, 8000, "the alias-scoped pin binds — min(cap, served) has a cap to bind with");
});

test("a pollable provider exposes the lower operator-capped window and derives its generation envelope from it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{
                    id: "served.gguf",
                    meta: { n_ctx: 49_152 },
                }],
            }), { status: 200 });
        }
        if (String(input).endsWith("/props")) {
            return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        }
        throw new Error(`unexpected request: ${String(input)}`);
    }) as typeof fetch;
    try {
        const provider = await ProviderInstantiate.instantiateProvider(
            { alias: "tight", provider: "openai", model: "local", baseUrl: "http://local.test/v1" },
            {
                ...process.env,
                PLURNK_PROVIDERS_CONTEXT_WINDOW_TIGHT: "32000",
                PLURNK_PROVIDERS_REASONING_RESERVE_TIGHT: "10%",
                PLURNK_PROVIDERS_COMPLETION_RESERVE_TIGHT: "25%",
                PLURNK_PROVIDERS_FETCH_TIMEOUT: "1500",
                PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
                PLURNK_PROVIDERS_PROBE_DELAY: "0",
            },
        );
        assert.equal(provider.contextWindow, 32_000);
        assert.equal(provider.reasoningReserve, 3_200);
        assert.equal(provider.completionReserve, 8_000);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("the process cache separates aliases and provider tuning for the same wire model", async () => {
    const realFetch = globalThis.fetch;
    const key = "PLURNK_PROVIDERS_CONTEXT_WINDOW_cachecap";
    const previous = process.env[key];
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "served.gguf", meta: { n_ctx: 49_152 } }] }), { status: 200 });
        }
        if (String(input).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        throw new Error(`unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const spec = { alias: "cachecap", provider: "openai", model: "local", baseUrl: "http://cache.test/v1" };
    try {
        process.env[key] = "32000";
        const first = await ProviderInstantiate.instantiateProvider(spec);
        process.env[key] = "16000";
        const second = await ProviderInstantiate.instantiateProvider(spec);
        assert.equal(first.contextWindow, 32_000);
        assert.equal(second.contextWindow, 16_000);
        assert.notEqual(first, second);
    } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
        globalThis.fetch = realFetch;
    }
});
