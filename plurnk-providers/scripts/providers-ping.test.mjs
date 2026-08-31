import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    executePingRoutes,
    pingRunIsRed,
    pingRequest,
    planProviderPings,
    redactText,
    sensitiveValuesFromEnv,
    responseShape,
    writePingRecord,
} from "./providers-ping.mjs";

test("#224: provider ping planning selects one cheapest declared route per keyed provider", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_flash: "deepseek/deepseek-v4-flash",
        PLURNK_MODEL_pro: "deepseek/deepseek-v4-pro",
        PLURNK_MODEL_ibm: "openrouter/ibm-granite/granite-4.1-8b",
        PLURNK_MODEL_qwen: "openrouter/qwen/qwen3.7-flash",
        PLURNK_MODEL_cloud: "cloudflare-workers-ai/@cf/openai/gpt-oss-20b",
        DEEPSEEK_API_KEY: "deepseek-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
    });

    assert.deepEqual(
        plan.routes.map(({ alias, provider, model }) => ({ alias, provider, model })),
        [
            { alias: "flash", provider: "deepseek", model: "deepseek-v4-flash" },
            { alias: "ibm", provider: "openrouter", model: "ibm-granite/granite-4.1-8b" },
        ],
    );
    assert.deepEqual(plan.unkeyed, ["cloudflare-workers-ai"]);
    assert.deepEqual(plan.unrouted, []);
});

test("#224: the provider-named alias resolves an unpriced keyed provider without guessing another model", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_amanda: "plurnk/amanda",
        PLURNK_MODEL_plurnk: "plurnk/plurnk",
        PLURNK_API_KEY: "plurnk-secret",
    });

    assert.equal(plan.routes.length, 1);
    assert.equal(plan.routes[0].alias, "plurnk");
    assert.equal(plan.routes[0].selection, "provider-named alias");
});

test("#224: a catalog key without a declared route remains explicitly red", () => {
    const plan = planProviderPings({ MISTRAL_API_KEY: "mistral-secret" });

    assert.deepEqual(plan.routes, []);
    assert.deepEqual(plan.unrouted, ["mistral"]);
    assert.equal(pingRunIsRed(plan, []), true);
});

test("#224: multiple unpriced aliases remain one ambiguous provider, not guessed routes", () => {
    const plan = planProviderPings({
        PLURNK_MODEL_amanda: "plurnk/amanda",
        PLURNK_MODEL_ashley: "plurnk/ashley",
        PLURNK_API_KEY: "plurnk-secret",
    });

    assert.deepEqual(plan.routes, []);
    assert.deepEqual(plan.unrouted, ["plurnk"]);
});

test("#224: response evidence retains structure but no provider scalar values", () => {
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

test("#224: the bounded probe carries the complete first-party turn identity", () => {
    const request = pingRequest({ provider: "plurnk" });

    assert.equal(request.workerId, "providers-ping-plurnk");
    assert.equal(request.primaryWorkerId, request.workerId);
    assert.equal(request.maxOutputTokens, 16);
});

test("#224: retained diagnostics redact credentials, account identity, and URL authority", () => {
    const redacted = redactText(
        "request secret-key failed for account-123 at https://user:pass@example.test/v1?token=query-secret",
        ["secret-key", "account-123", "query-secret"],
    );

    for (const forbidden of ["secret-key", "account-123", "query-secret", "user", "pass"]) {
        assert.equal(redacted.includes(forbidden), false, forbidden);
    }
    assert.match(redacted, /__redacted__/);
});

test("#242: secret discovery does not mistake token-limit controls for credentials", () => {
    const env = {
        PLURNK_SERVICE_REQUIEM_MAX_TOKENS: "16384",
        OPENAI_API_KEY: "credential-value",
        CLOUDFLARE_ACCOUNT_ID: "account-value",
    };

    assert.deepEqual(sensitiveValuesFromEnv(env).toSorted(), [
        "account-value",
        "credential-value",
    ]);
});

test("#224: each attempted provider leaves one safe JSON record", async () => {
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

test("#224: execution invokes every selected route exactly once and preserves red outcomes", async () => {
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
