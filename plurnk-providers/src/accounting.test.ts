import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeChargeNormalizer, fireworksAccounting } from "./accounting.ts";
import { validateProviderAccountingResult } from "./cost.ts";

const evidence = ({ providerMetadata, usage }: { providerMetadata?: unknown; usage?: unknown }) => ({
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    ...(usage === undefined ? {} : { usage }),
    response: { id: "response-1" },
});

test("xAI response ticks normalize to an exact provider-authoritative charge", () => {
    const normalize = authoritativeChargeNormalizer("@ai-sdk/xai");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { cost_in_usd_ticks: 15_493_500 } })), {
        kind: "authoritative",
        amount: { amount: "15493500", currency: "USDTICK" },
        usdEquivalent: "0.00154935",
        source: "xAI response usage.cost_in_usd_ticks",
    });
});

test("OpenRouter response cost normalizes without rate reconstruction", () => {
    const normalize = authoritativeChargeNormalizer("@openrouter/ai-sdk-provider");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ providerMetadata: { openrouter: { usage: { cost: 3.2e-7 } } } })), {
        kind: "authoritative",
        amount: { amount: "0.00000032", currency: "USD" },
        usdEquivalent: "0.00000032",
        source: "OpenRouter response usage.cost",
    });
});

test("accounting normalization is an explicit adapter capability", () => {
    assert.equal(authoritativeChargeNormalizer("@ai-sdk/anthropic"), undefined);
    assert.equal(
        authoritativeChargeNormalizer("@ai-sdk/xai")!(evidence({ usage: {} })),
        undefined,
    );
    assert.throws(
        () => authoritativeChargeNormalizer("@ai-sdk/xai")!(evidence({ usage: { cost_in_usd_ticks: "1" } })),
        /cost_in_usd_ticks must be numeric/,
    );
});

test("accounting results have one runtime validation boundary", () => {
    assert.deepEqual(validateProviderAccountingResult({
        status: "pending",
        reason: "ledger ingestion is pending",
    }), {
        status: "pending",
        reason: "ledger ingestion is pending",
    });
    assert.throws(
        () => validateProviderAccountingResult({ status: "pending", reason: "" }),
        /has no reason/,
    );
    assert.throws(
        () => validateProviderAccountingResult({
            status: "settled",
            charge: {
                kind: "authoritative",
                amount: { amount: "1", currency: "USD" },
                usdEquivalent: "1",
                source: "fixture",
            },
            evaluatedAt: "not-a-time",
        }),
        /evaluation time/,
    );
});

test("Fireworks accounting correlates calls and settles a stable scoped provider subtotal", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
        { accounts: [{ name: "accounts/acme" }] },
        {
            subtotal: { currencyCode: "USD", units: "0", nanos: 31_941_728 },
            evaluationTime: "2026-08-08T12:01:00Z",
            attributionCompleteness: "COMPLETE",
        },
        {
            subtotal: { currencyCode: "USD", units: "0", nanos: 31_941_728 },
            evaluationTime: "2026-08-08T12:01:01Z",
            attributionCompleteness: "COMPLETE",
        },
    ];
    const accounting = fireworksAccounting({
        apiKey: "secret",
        timeoutMs: 100,
        pollIntervalMs: 1,
        fetch: async (input, init) => {
            requests.push({ url: String(input), init });
            return Response.json(responses.shift());
        },
    });

    assert.deepEqual(accounting.headers({ scopeId: "scope-1", callId: "call-1" }), {
        "x-multi-turn-session-id": "scope-1",
        "x-session-affinity": "scope-1",
    });
    const result = await accounting.reconcile({
        id: "scope-1",
        startedAt: "2026-08-08T12:00:00Z",
        endedAt: "2026-08-08T12:00:30Z",
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        attempts: 2,
        usage: { prompt: 100, completion: 20, reasoning: 5, cached: 10, total: 125 },
    });
    assert.deepEqual(result, {
        status: "settled",
        charge: {
            kind: "authoritative",
            amount: { amount: "0.031941728", currency: "USD" },
            usdEquivalent: "0.031941728",
            source: "Fireworks scoped usageCosts query (SELF, COMPLETE)",
        },
        evaluatedAt: "2026-08-08T12:01:01Z",
    });
    assert.equal(requests.length, 3);
    assert.match(requests[1]!.url, /accounts\/acme\/usageCosts:query$/);
    assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), {
        startTime: "2026-08-08T12:00:00Z",
        endTime: "2026-08-08T12:00:30.001Z",
        scope: "SELF",
        filter: {
            model: "accounts/fireworks/models/deepseek-v4-flash-0731",
            sessionId: "scope-1",
        },
    });
});

test("Fireworks accounting does not settle a subtotal the provider marks incomplete", async () => {
    const responses = [
        { accounts: [{ name: "accounts/acme" }] },
        {
            subtotal: { currencyCode: "USD", units: "0", nanos: 31_941_728 },
            evaluationTime: "2026-08-08T12:01:00Z",
            attributionCompleteness: "INCOMPLETE",
        },
    ];
    const accounting = fireworksAccounting({
        apiKey: "secret",
        timeoutMs: 0,
        pollIntervalMs: 1,
        fetch: async () => Response.json(responses.shift()),
    });

    const result = await accounting.reconcile({
        id: "scope-1",
        startedAt: "2026-08-08T12:00:00Z",
        endedAt: "2026-08-08T12:00:30Z",
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        attempts: 1,
        usage: { prompt: 100, completion: 20, reasoning: 5, cached: 10, total: 125 },
    });
    assert.equal(result.status, "pending");
    assert.match(result.status === "pending" ? result.reason : "", /incomplete/i);
});

test("Fireworks accounting requires two complete post-scope observations", async () => {
    const responses = [
        { accounts: [{ name: "accounts/acme" }] },
        {
            subtotal: { currencyCode: "USD", units: "0", nanos: 31_941_728 },
            evaluationTime: "2026-08-08T12:00:29Z",
            attributionCompleteness: "COMPLETE",
        },
        {
            subtotal: { currencyCode: "USD", units: "0", nanos: 31_941_728 },
            evaluationTime: "2026-08-08T12:01:01Z",
            attributionCompleteness: "COMPLETE",
        },
    ];
    const accounting = fireworksAccounting({
        apiKey: "secret",
        timeoutMs: 2,
        pollIntervalMs: 1,
        fetch: async () => Response.json(responses.shift()),
    });

    const result = await accounting.reconcile({
        id: "scope-1",
        startedAt: "2026-08-08T12:00:00Z",
        endedAt: "2026-08-08T12:00:30Z",
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        attempts: 1,
        usage: { prompt: 100, completion: 20, reasoning: 5, cached: 10, total: 125 },
    });
    assert.equal(result.status, "pending");
});

test("Fireworks accounting does not mistake an unattributed failed call for a free scope", async () => {
    const responses = [
        { accounts: [{ name: "accounts/acme" }] },
        {
            subtotal: { currencyCode: "USD" },
            evaluationTime: "2026-08-08T12:01:00Z",
            attributionCompleteness: "COMPLETE",
        },
    ];
    const accounting = fireworksAccounting({
        apiKey: "secret",
        timeoutMs: 0,
        pollIntervalMs: 1,
        fetch: async () => Response.json(responses.shift()),
    });

    assert.deepEqual(await accounting.reconcile({
        id: "scope-1",
        startedAt: "2026-08-08T12:00:00Z",
        endedAt: "2026-08-08T12:00:30Z",
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        attempts: 1,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    }), {
        status: "pending",
        reason: "Fireworks usage ledger has not attributed the issued model calls",
        evaluatedAt: "2026-08-08T12:01:00Z",
    });
});

test("Fireworks accounting settles an empty scope from stable zero-valued Money snapshots", async () => {
    const responses = [
        { accounts: [{ name: "accounts/acme" }] },
        {
            subtotal: { currencyCode: "USD" },
            evaluationTime: "2026-08-08T12:01:00Z",
            attributionCompleteness: "COMPLETE",
        },
        {
            subtotal: { currencyCode: "USD" },
            evaluationTime: "2026-08-08T12:01:01Z",
            attributionCompleteness: "COMPLETE",
        },
    ];
    const accounting = fireworksAccounting({
        apiKey: "secret",
        timeoutMs: 100,
        pollIntervalMs: 1,
        fetch: async () => Response.json(responses.shift()),
    });

    assert.deepEqual(await accounting.reconcile({
        id: "scope-1",
        startedAt: "2026-08-08T12:00:00Z",
        endedAt: "2026-08-08T12:00:30Z",
        model: "accounts/fireworks/models/deepseek-v4-flash-0731",
        attempts: 0,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    }), {
        status: "settled",
        charge: {
            kind: "authoritative",
            amount: { amount: "0", currency: "USD" },
            usdEquivalent: "0",
            source: "Fireworks scoped usageCosts query (SELF, COMPLETE)",
        },
        evaluatedAt: "2026-08-08T12:01:01Z",
    });
});
