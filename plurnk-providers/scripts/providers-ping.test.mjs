import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exerciseRuntimeNeutralSession } from "./lib/runtime-neutral-session-control.mjs";
import {
    executePingRoutes,
    pingRunIsRed,
    planProviderPings,
    redactText,
    sensitiveValuesFromEnv,
    responseShape,
    writePingRecord,
} from "./providers-ping.mjs";
import {
    resolveProbeMaxOutputTokens,
    selectProbeAliases,
} from "./token-envelope-probe.mjs";

test("{§model-fact-resolution} #224: provider ping planning selects one cheapest declared route per keyed provider", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_flash: "deepseek/deepseek-v4-flash",
        PLURNK_MODEL_pro: "deepseek/deepseek-v4-pro",
        PLURNK_MODEL_openai: "openrouter/openai/gpt-5.4",
        PLURNK_MODEL_qwen: "openrouter/qwen/qwen3.7-flash",
        PLURNK_MODEL_cloud: "cloudflare-workers-ai/@cf/openai/gpt-oss-20b",
        DEEPSEEK_API_KEY: "deepseek-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
    });

    assert.deepEqual(
        plan.routes.map(({ alias, provider, model }) => ({ alias, provider, model })),
        [
            { alias: "flash", provider: "deepseek", model: "deepseek-v4-flash" },
            { alias: "qwen", provider: "openrouter", model: "qwen/qwen3.7-flash" },
        ],
    );
    assert.deepEqual(plan.unkeyed, ["cloudflare-workers-ai"]);
    assert.deepEqual(plan.unrouted, []);
});

test("{§model-fact-resolution} #224: the provider-named alias resolves an unpriced keyed provider without guessing another model", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_amanda: "acme/amanda",
        PLURNK_MODEL_acme: "acme/acme",
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY",
        ACME_API_KEY: "acme-secret",
    });

    assert.equal(plan.routes.length, 1);
    assert.equal(plan.routes[0].alias, "acme");
    assert.equal(plan.routes[0].selection, "provider-named alias");
});

test("{§model-fact-resolution} #224: a catalog key without a declared route remains explicitly red", () => {
    const plan = planProviderPings({ MISTRAL_API_KEY: "mistral-secret" });

    assert.deepEqual(plan.routes, []);
    assert.deepEqual(plan.unrouted, ["mistral"]);
    assert.equal(pingRunIsRed(plan, []), true);
});

test("{§model-fact-resolution} #224: multiple unpriced aliases remain one ambiguous provider, not guessed routes", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_amanda: "acme/amanda",
        PLURNK_MODEL_ashley: "acme/ashley",
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY",
        ACME_API_KEY: "acme-secret",
    });

    assert.deepEqual(plan.routes, []);
    assert.deepEqual(plan.unrouted, ["acme"]);
});

test("{§model-fact-resolution} #224: response evidence retains structure but no provider scalar values", () => {
    assert.deepEqual(responseShape({
        id: "account-and-response-id",
        usage: { input_tokens: 12, cached: false, detail: null },
        choices: [{ finish_reason: "stop", text: "OK" }],
        events: [{ delta: "a" }, { delta: "b" }],
    }), {
        choices: [{ finish_reason: "string", text: "string" }],
        events: [{ delta: "string" }],
        id: "string",
        usage: { cached: "boolean", detail: "null", input_tokens: "number" },
    });
});

test("{§model-fact-resolution} #224: retained diagnostics redact credentials, account identity, and URL authority", () => {
    const redacted = redactText(
        "request secret-key failed for account-123 at https://user:pass@example.test/v1?token=query-secret",
        ["secret-key", "account-123", "query-secret"],
    );

    for (const forbidden of ["secret-key", "account-123", "query-secret", "user", "pass"]) {
        assert.equal(redacted.includes(forbidden), false, forbidden);
    }
    assert.match(redacted, /__redacted__/);
});

test("{§model-fact-resolution} #242: secret discovery does not mistake token-limit controls for credentials", () => {
    const env = {
        PLURNK_DIGEST_REQUIEM_MAX_TOKENS: "16384",
        OPENAI_API_KEY: "credential-value",
        CLOUDFLARE_ACCOUNT_ID: "account-value",
    };

    assert.deepEqual(sensitiveValuesFromEnv(env).toSorted(), [
        "account-value",
        "credential-value",
    ]);
});

test("{§model-fact-resolution} #224: each attempted provider leaves one safe JSON record", async () => {
    const root = await mkdtemp(join(tmpdir(), "providers-ping-test-"));
    try {
        const record = {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            status: "response",
            responseShape: { id: "string" },
            accounting: {
                requests: [{
                    provider: "provider:deepseek",
                    model: "deepseek-v4-flash",
                    outcome: "response",
                    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
                    cost: {
                        kind: "estimated",
                        amount: { amount: "0.000001", currency: "USD" },
                        source: "Models.dev catalog rates",
                    },
                }],
                usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
                costUsd: "0.000001",
            },
        };
        const path = await writePingRecord(root, record, ["secret-key"]);
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
        await assert.rejects(
            writePingRecord(root, { ...record, provider: "secret-key" }, ["secret-key"]),
            /refusing to persist sensitive provider-ping evidence/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§model-fact-resolution} #224: execution invokes every selected route exactly once and preserves red outcomes", async () => {
    const routes = [
        { provider: "deepseek", alias: "flash", model: "deepseek-v4-flash" },
        { provider: "xai", alias: "gbuild", model: "grok-build-0.1" },
    ];
    const calls = [];
    const records = await executePingRoutes(routes, async (route) => {
        calls.push(route.provider);
        return { provider: route.provider, status: route.provider === "xai" ? "error" : "response" };
    });

    assert.deepEqual(calls.toSorted(), ["deepseek", "xai"]);
    assert.equal(records.length, 2);
    assert.equal(pingRunIsRed({ unrouted: [] }, records), true);
    assert.equal(pingRunIsRed({ unrouted: [] }, [{ status: "response" }]), false);
});

test("{§model-fact-resolution} #242: token probe selects only explicit aliases", () => {
    const routes = selectProbeAliases({
        PLURNK_MODEL_fast: "deepseek/deepseek-v4-flash",
        PLURNK_MODEL_slow: "deepseek/deepseek-v4-pro",
    }, ["slow"]);

    assert.deepEqual(routes.map(({ alias, provider, model }) => ({ alias, provider, model })), [{
        alias: "slow",
        provider: "deepseek",
        model: "deepseek-v4-pro",
    }]);
    assert.throws(
        () => selectProbeAliases({ PLURNK_MODEL_fast: "deepseek/model" }, ["missing"]),
        /unknown provider alias/,
    );
});

test("{§model-fact-resolution} #242: output-token modes distinguish configured policy from model physics", () => {
    const provider = { outputBudget: 350, maxOutputTokens: 500 };

    assert.equal(resolveProbeMaxOutputTokens("configured", provider), 350);
    assert.equal(resolveProbeMaxOutputTokens("model", provider), 500);
    assert.equal(resolveProbeMaxOutputTokens("42", provider), 42);
    assert.throws(() => resolveProbeMaxOutputTokens("configured", {}), /requires a resolved output budget/);
    assert.throws(() => resolveProbeMaxOutputTokens("0", provider), /safe integer >= 1/);
});

test("{§provider-interface} the public accounting and error subpaths initialize in a browser Session", async () => {
    await exerciseRuntimeNeutralSession({
        absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
        conditions: ["plurnk-dev"],
    });
});
