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
