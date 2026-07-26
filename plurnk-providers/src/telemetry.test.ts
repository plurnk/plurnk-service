import test from "node:test";
import { strict as assert } from "node:assert";
import { APICallError } from "ai";
import { ProviderError, classifyProviderError, toProviderError, providerSource } from "./telemetry.ts";

const apiError = (statusCode: number, responseBody = "body") => new APICallError({
    message: `request failed (${statusCode})`,
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
});

// Schema pattern for TelemetryEvent.source (from grammar's TelemetryEvent.json).
const SOURCE_PATTERN = /^[a-z]+(:[a-z][a-z0-9-]*)?$/;

test("providerSource produces a schema-valid colon-namespaced source", () => {
    assert.equal(providerSource("openai"), "provider:openai");
    assert.match(providerSource("openrouter"), SOURCE_PATTERN);
    assert.match(providerSource("xai"), SOURCE_PATTERN); // contains no underscore — fine
});

test("classifyProviderError maps HTTP status to kind", () => {
    const k = (status: number) => classifyProviderError(apiError(status)).kind;
    assert.equal(k(401), "unauthorized");
    assert.equal(k(403), "unauthorized");
    assert.equal(k(402), "quota_exceeded");
    assert.equal(k(429), "rate_limit");
    assert.equal(k(500), "network_failure");
    assert.equal(k(503), "network_failure");
    assert.equal(k(400), "invalid_response");
    assert.equal(k(404), "invalid_response");
});

test("classifyProviderError: a 422 flagged grammar_invalid is distinct (#548); other 422s are invalid responses", () => {
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

test("ProviderError.toTelemetryEvent emits the canonical envelope", () => {
    const e = new ProviderError("provider:openai", "rate_limit", "OpenAI 429 - slow down", { status: 429 });
    const ev = e.toTelemetryEvent();
    assert.deepEqual(ev, { source: "provider:openai", kind: "rate_limit", message: "OpenAI 429 - slow down", position: null });
    assert.match(ev.source, SOURCE_PATTERN);
    assert.ok(e instanceof Error);   // still catchable as a plain Error
    assert.equal(e.status, 429);
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
