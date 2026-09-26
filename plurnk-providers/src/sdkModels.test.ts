import test from "node:test";
import { strict as assert } from "node:assert";
import { configuredProviderInfo, createSdkModel, providerReadiness } from "./sdkModels.ts";
import { withProviderDefaults } from "./defaults.ts";

test("{§provider-fact-authority} one env declaration holds one credential name", () => {
    assert.deepEqual(configuredProviderInfo("acme-cloud", {
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_BASE_URL: "https://api.acme.test/v1",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_API_KEY_ENV: "ACME_API_KEY",
    }), {
        id: "acme-cloud",
        name: "acme-cloud",
        npm: "@ai-sdk/openai-compatible",
        env: ["ACME_API_KEY"],
        api: "https://api.acme.test/v1",
    });
    assert.throws(
        () => configuredProviderInfo("acme-cloud", {
            PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_NPM: "@ai-sdk/openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_API_KEY_ENV: "ACME_API_KEY,ACME_TOKEN",
        }),
        /one exact name, never an ordered fallback/,
    );
});

test("{§model-catalog-readiness}: readiness uses the construction credential and endpoint requirements without exposing values", () => {
    assert.deepEqual(providerReadiness("google", {}), {
        ready: false,
        causes: [{
            kind: "credential",
            alternatives: [["GOOGLE_API_KEY"], ["GOOGLE_GENERATIVE_AI_API_KEY"], ["GEMINI_API_KEY"]],
        }],
    });
    assert.deepEqual(providerReadiness("google", { GEMINI_API_KEY: "secret-value" }), {
        ready: true,
        causes: [],
    });
    assert.doesNotMatch(JSON.stringify(providerReadiness("google", { GEMINI_API_KEY: "secret-value" })), /secret-value/);

    assert.deepEqual(providerReadiness("cloudflare-workers-ai", { CLOUDFLARE_API_KEY: "key" }), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["CLOUDFLARE_ACCOUNT_ID"]],
        }],
    });
    assert.deepEqual(providerReadiness("cloudflare-workers-ai", {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "key",
    }), { ready: true, causes: [] });
});

test("{§model-catalog-readiness}: Bedrock reports its actual alternative authentication sets and region requirement", () => {
    assert.deepEqual(providerReadiness("amazon-bedrock", {}), {
        ready: false,
        causes: [{
            kind: "credential",
            alternatives: [
                ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
                ["AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_REGION"],
                ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
                ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
            ],
        }],
    });
    assert.deepEqual(providerReadiness("amazon-bedrock", {
        AWS_BEARER_TOKEN_BEDROCK: "bearer",
        AWS_REGION: "us-east-1",
    }), { ready: true, causes: [] });
    assert.deepEqual(providerReadiness("amazon-bedrock", {
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
    }), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["AWS_REGION"], ["AWS_DEFAULT_REGION"]],
        }],
    });
});

test("{§model-catalog-readiness}: operator-declared unauthenticated compatible endpoints are ready without an invented credential", () => {
    assert.deepEqual(providerReadiness("acme", {
        PLURNK_PROVIDERS_PROVIDER_ACME_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL: "http://127.0.0.1:9000/v1",
    }), { ready: true, causes: [] });
});

test("{§model-catalog-readiness}: an authenticated operator declaration reports its missing credential-name configuration", () => {
    const env = {
        PLURNK_PROVIDERS_PROVIDER_ACME_NPM: "@ai-sdk/openai",
    };
    assert.deepEqual(providerReadiness("acme", env), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV"]],
        }],
    });
    assert.throws(
        () => createSdkModel("acme", "model", env),
        /PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV must be set/,
    );
});

test("createSdkModel constructs Cerebras from Models.dev facts", () => {
    const sdk = createSdkModel("cerebras", "gemma-4-31b", {
        CEREBRAS_API_KEY: "test-key",
    });
    assert.notEqual(sdk, null);
    assert.equal(sdk?.catalog?.npm, "@ai-sdk/cerebras");
    assert.notEqual(sdk?.languageModel, undefined);
    assert.equal(sdk?.compatible, undefined);
});

test("{§provider-wire-declaration} SDK construction does not freeze request-local reasoning controls", () => {
    const model = createSdkModel("openrouter", "z-ai/glm-5.3-flash", {
        OPENROUTER_API_KEY: "test-key",
    })?.languageModel as { settings?: { reasoning?: unknown } } | undefined;
    assert.ok(model);
    assert.equal(model.settings?.reasoning, undefined);
});

test("{§openrouter-app-attribution} attribution rejects malformed URLs and the retired title name", () => {
    assert.throws(
        () => createSdkModel("openrouter", "openai/gpt-5", {
            OPENROUTER_API_KEY: "key",
            OPENROUTER_HTTP_REFERER: "plurnk",
        }),
        /OPENROUTER_HTTP_REFERER must be an absolute HTTP\(S\) URL/,
    );
    assert.throws(
        () => createSdkModel("openrouter", "openai/gpt-5", {
            OPENROUTER_API_KEY: "key",
            OPENROUTER_X_TITLE: "Plurnk",
        }),
        /OPENROUTER_X_TITLE was renamed to OPENROUTER_APP_TITLE/,
    );
});

test("the Google SDK adapter owns its readable-reasoning response projection", () => {
    assert.deepEqual(
        createSdkModel("google", "gemini-3.7-flash", { GEMINI_API_KEY: "test-key" })?.reasoningResponseProviderOptions,
        { google: { thinkingConfig: { includeThoughts: true } } },
    );
    assert.equal(
        createSdkModel("cerebras", "gemma-4-31b", { CEREBRAS_API_KEY: "test-key" })?.reasoningResponseProviderOptions,
        undefined,
    );
});

test("createSdkModel attaches DeepInfra's documented response-cost normalizer", () => {
    const sdk = createSdkModel("deepinfra", "zai-org/GLM-5.2", {
        DEEPINFRA_API_KEY: "test-key",
    });
    assert.notEqual(sdk?.languageModel, undefined);
    assert.deepEqual(sdk?.normalizeCost?.({
        usage: { estimated_cost: 5.04e-5 },
        response: { id: "response-1" },
    }), {
        kind: "estimated",
        amount: { amount: "0.0000504", currency: "USD" },
        source: "DeepInfra response usage.estimated_cost",
    });
});

test("{§provider-fact-authority} catalog credential names are law without any package or operator alias", () => {
    const sdk = createSdkModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", withProviderDefaults({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "key",
    }));
    assert.equal(sdk?.languageModel, undefined);
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        headers: { Authorization: "Bearer key" },
    });
    assert.deepEqual(sdk?.cacheAffinity, { target: "header", name: "x-session-affinity" });
});

test("{§provider-fact-authority} an operator credential override holds one exact name", () => {
    const sdk = createSdkModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", {
        CLOUDFLARE_ACCOUNT_ID: "account",
        MY_ORG_CLOUDFLARE_KEY: "key",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_API_KEY_ENV: "MY_ORG_CLOUDFLARE_KEY",
    });
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        headers: { Authorization: "Bearer key" },
    });
});

test("{§provider-fact-authority} ordered credential fallbacks are rejected at construction", () => {
    assert.throws(
        () => createSdkModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", {
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_TOKEN: "token",
            PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_API_KEY_ENV: "CLOUDFLARE_API_TOKEN,CLOUDFLARE_API_KEY",
        }),
        /one exact name, never an ordered fallback/,
    );
    assert.throws(
        () => createSdkModel("acme", "model", {
            PLURNK_PROVIDERS_PROVIDER_ACME_NPM: "@ai-sdk/openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY,ACME_TOKEN",
        }),
        /one exact name, never an ordered fallback/,
    );
});

test("{§provider-cache-affinity} the environment panel supplies each documented cache-affinity projection", () => {
    assert.deepEqual(
        createSdkModel("openai", "gpt-4.1-mini", withProviderDefaults({ OPENAI_API_KEY: "key" }))?.cacheAffinity,
        { target: "provider-option", provider: "openai", name: "promptCacheKey" },
    );
    assert.deepEqual(
        createSdkModel("deepinfra", "zai-org/GLM-5.2", withProviderDefaults({ DEEPINFRA_API_KEY: "key" }))?.cacheAffinity,
        { target: "provider-option", provider: "deepinfra", name: "prompt_cache_key" },
    );
    assert.deepEqual(
        createSdkModel("openrouter", "openai/gpt-5", withProviderDefaults({ OPENROUTER_API_KEY: "key" }))?.cacheAffinity,
        { target: "header", name: "x-session-id" },
    );
    assert.deepEqual(
        createSdkModel("fireworks-ai", "accounts/fireworks/models/test", withProviderDefaults({ FIREWORKS_API_KEY: "key" }))?.cacheAffinity,
        { target: "header", name: "x-session-affinity" },
    );
    assert.equal(createSdkModel("openai", "gpt-4.1-mini", { OPENAI_API_KEY: "key" })?.cacheAffinity, undefined,
        "the SDK binding does not reconstruct a missing declaration from provider identity");
});

test("explicit stable-system cache breakpoints exist only on supported Claude routes", () => {
    const cacheControl = { type: "ephemeral" };
    assert.deepEqual(
        createSdkModel("anthropic", "claude-sonnet-4-6", { ANTHROPIC_API_KEY: "key" })?.systemCacheProviderOptions,
        { anthropic: { cacheControl } },
    );
    assert.deepEqual(
        createSdkModel("openrouter", "anthropic/claude-sonnet-4.6", { OPENROUTER_API_KEY: "key" })?.systemCacheProviderOptions,
        { openrouter: { cacheControl } },
    );
    assert.equal(
        createSdkModel("openrouter", "openai/gpt-5", { OPENROUTER_API_KEY: "key" })?.systemCacheProviderOptions,
        undefined,
    );
    assert.equal(
        createSdkModel("deepseek", "deepseek-v4-flash", { DEEPSEEK_API_KEY: "key" })?.systemCacheProviderOptions,
        undefined,
    );
});

test("an operator-declared compatible provider receives no guessed cache extension", () => {
    const sdk = createSdkModel("acme", "model", {
        ACME_API_KEY: "key",
        PLURNK_PROVIDERS_PROVIDER_ACME_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL: "https://api.acme.test/v1",
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY",
    });
    assert.equal(sdk?.cacheAffinity, undefined);
    assert.equal(sdk?.systemCacheProviderOptions, undefined);
});

test("#157: a cataloged compatible provider fails before transport when its declared credential is absent", () => {
    assert.throws(
        () => createSdkModel("deepseek", "deepseek-v4-flash", {}),
        /deepseek provider: DEEPSEEK_API_KEY must be set/,
    );
});

test("createSdkModel fails clearly for a declared but unsupported SDK package", () => {
    assert.throws(
        () => createSdkModel("acme", "model", {
            PLURNK_PROVIDERS_PROVIDER_ACME_NPM: "@acme/ai-sdk",
        }),
        /Models.dev declares unsupported AI SDK package @acme\/ai-sdk/,
    );
});

// {§provider-fact-authority}: the catalog admits a provider only for an SDK package it names, so every admitted
// provider constructs; a package on the generator's list without a construction here is a route that reports ready
// and then cannot run.
test("{§provider-fact-authority} every catalog provider constructs a model through its SDK package", async () => {
    const { catalogSnapshot, lookupProvider } = await import("@plurnk/plurnk-models");
    const failures: string[] = [];
    for (const [provider, models] of Object.entries(catalogSnapshot())) {
        const info = lookupProvider(provider)!;
        const model = Object.keys(models)[0]!;
        const env = withProviderDefaults(Object.fromEntries(info.env.map((name) => [name, "test-value"])));
        try { if (createSdkModel(provider, model, env) === null) failures.push(`${provider} (${info.npm}): no model`); }
        catch (cause) { failures.push(`${provider} (${info.npm}): ${(cause as Error).message}`); }
    }
    assert.deepEqual(failures, []);
});
