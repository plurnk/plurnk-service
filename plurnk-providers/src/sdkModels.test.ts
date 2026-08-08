import test from "node:test";
import { strict as assert } from "node:assert";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";

test("configuredProviderInfo translates one env declaration into provider facts", () => {
    assert.deepEqual(configuredProviderInfo("acme-cloud", {
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_BASE_URL: "https://api.acme.test/v1",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_API_KEY_ENV: "ACME_API_KEY, ACME_TOKEN",
    }), {
        id: "acme-cloud",
        npm: "@ai-sdk/openai-compatible",
        env: ["ACME_API_KEY", "ACME_TOKEN"],
        api: "https://api.acme.test/v1",
    });
});

test("createSdkModel uses Models.dev provider facts and operator credentials", () => {
    const sdk = createSdkModel("xai", "grok-build-0.1", { XAI_API_KEY: "test-key" });
    assert.notEqual(sdk, null);
    assert.equal(sdk?.catalog?.npm, "@ai-sdk/xai");
    assert.equal(sdk?.languageModel, undefined);
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.x.ai/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
    });
    assert.notEqual(sdk?.normalizeCharge, undefined);
});

test("createSdkModel expands catalog endpoint variables without treating them as credentials", () => {
    const sdk = createSdkModel("cloudflare", "@cf/google/gemma-4-26b-a4b-it", {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_API_KEY_ENV: "CLOUDFLARE_API_TOKEN,CLOUDFLARE_API_KEY",
    });
    assert.equal(sdk?.languageModel, undefined);
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        headers: { Authorization: "Bearer token" },
    });
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
