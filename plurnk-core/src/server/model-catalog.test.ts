import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { listModelCatalog } from "./model-catalog.ts";

test("{§model-catalog}: configured discovery exposes every ready model under one exact provider/model selector", () => {
    const page = listModelCatalog({ provider: "deepseek" }, { DEEPSEEK_API_KEY: "configured" });
    assert.ok(page.total > 0);
    assert.equal(page.items.length, page.total);
    assert.equal(page.nextOffset, undefined);
    assert.ok(page.items.every(({ provider, selector, readiness }) =>
        provider === "deepseek"
        && selector.startsWith("deepseek/")
        && readiness.ready
        && readiness.causes.length === 0));
    assert.deepEqual(
        page.items.map(({ selector }) => selector),
        page.items.map(({ selector }) => selector).toSorted(),
        "catalog order is stable and route-oriented",
    );
});

test("{§model-catalog}: the broad catalog reports missing local configuration without probing or hiding models", () => {
    const page = listModelCatalog({
        provider: "cloudflare-workers-ai",
        availability: "all",
        limit: 1,
    }, {});
    assert.equal(page.items.length, 1);
    assert.ok(page.total > 1);
    assert.equal(page.nextOffset, 1);
    const [entry] = page.items;
    assert.equal(entry.provider, "cloudflare-workers-ai");
    assert.equal(entry.readiness.ready, false);
    assert.deepEqual(entry.readiness.causes, [
        { kind: "configuration", alternatives: [["CLOUDFLARE_ACCOUNT_ID"]] },
        { kind: "credential", alternatives: [["CLOUDFLARE_API_KEY"]] },
    ]);
    assert.equal(Object.hasOwn(entry.capabilities, "reasoning"), true);
    assert.ok(entry.limits.contextTokens > 0);
});

test("{§model-catalog}: search and pagination apply to the complete filtered result before slicing", () => {
    const complete = listModelCatalog({
        provider: "deepseek",
        search: "DeepSeek",
        availability: "all",
        limit: 100,
    }, {});
    const page = listModelCatalog({
        provider: "deepseek",
        search: "deepseek",
        availability: "all",
        offset: 1,
        limit: 2,
    }, {});
    assert.equal(page.total, complete.total);
    assert.deepEqual(page.items, complete.items.slice(1, 3));
    assert.equal(page.nextOffset, complete.total > 3 ? 3 : undefined);
});

test("{§model-catalog}: no configured provider means the default page is honestly empty", () => {
    assert.deepEqual(listModelCatalog({}, {}), { items: [], offset: 0, total: 0 });
});

test("{§model-catalog}: discovery exposes the provider's exact reasoning policies without credentials or I/O", () => {
    const fetch = mock.method(globalThis, "fetch", () => {
        throw new Error("model discovery must not contact a provider");
    });
    try {
        for (const { provider, model, env, expected } of [
            {
                provider: "deepseek", model: "deepseek-v4-flash",
                env: { PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort" },
                expected: ["off", "adaptive", "low", "high", "max"],
            },
            {
                provider: "deepseek", model: "deepseek-v4-flash",
                env: {
                    PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort",
                    PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_EFFORTS: "medium,medium",
                },
                expected: ["off", "adaptive", "low", "medium", "high", "max"],
            },
            {
                provider: "openai", model: "gpt-4.1-mini",
                env: { PLURNK_PROVIDERS_PROVIDER_OPENAI_REASONING_EFFORTS: "high,max" },
                expected: ["off", "adaptive"],
            },
            {
                provider: "google", model: "gemini-3.7-flash", env: {},
                expected: ["adaptive", "low", "medium", "high"],
            },
        ]) {
            const page = listModelCatalog({ provider, search: model, availability: "all" }, env);
            const entry = page.items.find(({ selector }) => selector === `${provider}/${model}`);
            assert.ok(entry, `${provider}/${model} is discoverable without credentials`);
            assert.deepEqual(
                Reflect.get(entry.capabilities, "reasoningPolicies"), expected, entry.selector,
            );
            assert.equal(entry.readiness.ready, false);
        }
        assert.equal(fetch.mock.callCount(), 0);
    } finally {
        fetch.mock.restore();
    }
});
