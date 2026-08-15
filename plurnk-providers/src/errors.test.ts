import test from "node:test";
import { strict as assert } from "node:assert";
import { APICallError, RetryError } from "ai";
import { ProviderError, ProviderTimeoutError, classifyProviderError, toProviderError } from "./errors.ts";
import type { ProviderAttempt } from "./types.ts";
import { providerSource } from "./notices.ts";

const apiError = (statusCode: number, responseBody = "body") => new APICallError({
    message: `request failed (${statusCode})`,
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
});

const SOURCE_PATTERN = /^[a-z]+(:[a-z][a-z0-9-]*)?$/;

test("providerSource produces a schema-valid colon-namespaced source", () => {
    assert.equal(providerSource("openai"), "provider:openai");
    assert.match(providerSource("openrouter"), SOURCE_PATTERN);
    assert.equal(providerSource("@scope/custom_provider"), "provider:scope-custom-provider");
    assert.equal(providerSource("2fast"), "provider:p-2fast");
    assert.throws(() => providerSource(""), /must name a provider/);
});

test("classifyProviderError maps HTTP status to kind", () => {
    const k = (status: number) => classifyProviderError(apiError(status)).kind;
    assert.equal(k(401), "unauthorized");
    assert.equal(k(403), "unauthorized");
    assert.equal(k(402), "quota_exceeded");
    assert.equal(k(429), "rate_limit");
    assert.equal(k(408), "network_failure");
    assert.equal(k(409), "network_failure");
    assert.equal(k(500), "network_failure");
    assert.equal(k(503), "network_failure");
    assert.equal(k(413), "capacity_exceeded");
    assert.equal(k(400), "invalid_response");
    assert.equal(k(404), "invalid_response");
});

test("capacity normalization prefers structured provider codes and keeps generic 400s distinct", () => {
    const openai = apiError(400, JSON.stringify({
        error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "maximum context length exceeded",
        },
    }));
    assert.equal(classifyProviderError(openai).kind, "capacity_exceeded");
    const normalized = toProviderError(openai, "provider:openai");
    assert.equal(normalized.status, 413);
    assert.equal(normalized.problem.capacityStage, "upstream");
    assert.equal(normalized.problem.providerStatus, 400);
    assert.equal(classifyProviderError(apiError(400, JSON.stringify({
        error: { type: "invalid_request_error", code: "bad_temperature", message: "bad temperature" },
    }))).kind, "invalid_response");
});

test("provider retry directives survive HTTP failure normalization", () => {
    const final = new APICallError({
        message: "edge router says not to replay",
        url: "https://example.test/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 524,
        isRetryable: false,
    });
    const error = toProviderError(final, "provider:test");
    assert.equal(error.kind, "network_failure");
    assert.equal(error.problem.retryable, false);
});

test("classifyProviderError: a 422 flagged grammar_invalid is distinct; other 422s are invalid responses", () => {
    const rejected = apiError(422, JSON.stringify({ error: { type: "grammar_invalid", message: "non-conforming emission rejected: ..." } }));
    assert.equal(classifyProviderError(rejected).kind, "grammar_invalid");
    assert.equal(classifyProviderError(apiError(422, JSON.stringify({ error: { type: "invalid_request_error" } }))).kind, "invalid_response");
    assert.equal(classifyProviderError(apiError(422, "<html>Bad</html>")).kind, "invalid_response");
});

test("classifyProviderError treats non-HTTP errors as network_failure", () => {
    assert.equal(classifyProviderError(new TypeError("fetch failed")).kind, "network_failure");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    assert.equal(classifyProviderError(timeout).kind, "network_failure");
});

test("ProviderError carries a validated RFC 9457 Problem Details object", () => {
    const e = new ProviderError("provider:openai", "rate_limit", "OpenAI 429 - slow down", { status: 429 });
    assert.deepEqual(e.problem, {
        type: "https://problems.plurnk.dev/provider/openai/rate-limit",
        title: "Rate limit",
        status: 429,
        detail: "OpenAI 429 - slow down",
        providerKind: "rate_limit",
        stage: "provider-request",
        retryable: true,
    });
    assert.match(e.source, SOURCE_PATTERN);
    assert.ok(e instanceof Error);
    assert.equal(e.status, 429);
});

test("ProviderError marks failures that require changed external state as non-retryable", () => {
    const unauthorized = new ProviderError("provider:openai", "unauthorized", "Invalid API key.");
    assert.equal(unauthorized.problem.retryable, false);
    assert.equal(unauthorized.problem.stage, "provider-request");
});

test("#161: ProviderError carries resource-interrupted attempt evidence outside Problem Details", () => {
    const attempt = {
        assistant: {
            content: "partial",
            reasoning: null,
            finishReason: "resource_interrupted",
            model: "served-model",
        },
        assistantRaw: { rawFinishReason: "insufficient_system_resource" },
        accounting: [{
            provider: "provider:deepseek",
            model: "served-model",
            outcome: "response",
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            cost: { kind: "unknown", reason: "fixture has no monetary evidence" },
        }],
        capacity: {
            decision: "defer",
            contextWindow: null,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget: null,
            reasoningBudget: null,
            inputCapacity: null,
            prompt: {
                kind: "unavailable",
                source: "fixture",
                detail: "the interrupted fixture has no preflight measurement",
            },
        },
    } as ProviderAttempt;
    const error = new ProviderError(
        "provider:deepseek",
        "resource_interrupted",
        "The provider interrupted generation because inference resources were unavailable.",
        {
            attempt,
            extensions: {
                stage: "provider-response",
                finishReason: "resource_interrupted",
                rawFinishReason: "insufficient_system_resource",
            },
        },
    );

    assert.equal(error.attempt, attempt);
    assert.deepEqual(error.accounting, attempt.accounting);
    assert.deepEqual(error.problem, {
        type: "https://problems.plurnk.dev/provider/deepseek/resource-interrupted",
        title: "Resource interrupted",
        status: 503,
        detail: "The provider interrupted generation because inference resources were unavailable.",
        providerKind: "resource_interrupted",
        stage: "provider-response",
        retryable: false,
        finishReason: "resource_interrupted",
        rawFinishReason: "insufficient_system_resource",
    });
});

test("toProviderError classifies and tags an HTTP error with the source + status", () => {
    const cause = apiError(401, "no key");
    const pe = toProviderError(cause, "provider:groq");
    assert.equal(pe.kind, "unauthorized");
    assert.equal(pe.source, "provider:groq");
    assert.equal(pe.status, 401);
    assert.equal(pe.cause, cause);
});

test("toProviderError passes an existing ProviderError through unchanged", () => {
    const original = new ProviderError("provider:xai", "rate_limit", "429");
    assert.equal(toProviderError(original, "provider:other"), original);
});

test("provider diagnostics are bounded without losing structured failure facts", () => {
    const cause = apiError(502);
    Object.defineProperty(cause, "message", { value: "abcdefghij" });
    const error = toProviderError(cause, "provider:test", 4);
    assert.equal(error.problem.detail, "abcd...");
    assert.equal(error.problem.status, 502);
    assert.equal(error.problem.providerKind, "network_failure");
    assert.equal(error.cause, cause);
});

test("retry exhaustion is explicit and does not recommend another automatic replay", () => {
    const failures = [apiError(429), apiError(429), apiError(429)];
    const cause = new RetryError({
        message: "Failed after 3 attempts.",
        reason: "maxRetriesExceeded",
        errors: failures,
    });
    const error = toProviderError(cause, "provider:test");
    assert.equal(error.problem.retryable, false);
    assert.equal(error.problem.attempts, 3);
    assert.equal(error.problem.retryExhausted, true);
    assert.equal(error.cause, cause);
});

test("retry exhaustion retains the exact inner deadline phase", () => {
    const failures = [1, 2].map(() => new APICallError({
        message: "attempt timed out",
        url: "https://example.test/v1/chat/completions",
        requestBodyValues: {},
        cause: new ProviderTimeoutError("attempt", 10),
        isRetryable: true,
    }));
    const cause = new RetryError({
        message: "Failed after 2 attempts.",
        reason: "maxRetriesExceeded",
        errors: failures,
    });
    const error = toProviderError(cause, "provider:test");
    assert.equal(error.kind, "network_failure");
    assert.equal(error.status, 503);
    assert.equal(error.problem.retryable, false);
    assert.equal(error.problem.attempts, 2);
    assert.equal(error.problem.retryExhausted, true);
    assert.equal(error.problem.timeoutPhase, "attempt");
    assert.equal(error.problem.timeoutMs, 10);
});
