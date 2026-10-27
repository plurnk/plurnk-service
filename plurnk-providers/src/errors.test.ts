import test from "node:test";
import assert from "node:assert/strict";
import RequestCapture from "./RequestCapture.ts";
import ModelProvider from "./ModelProvider.ts";
import { APICallError, JSONParseError, ProviderError, RETRYABLE_PROVIDER_KINDS, RetryError, TypeValidationError, classifyProviderError, toProviderError } from "./errors.ts";
import { providerSource } from "./notices.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { createProviderModel } from "./modelAdapters.ts";
import { requestBody } from "../../scripts/lib/test-fetch.ts";
import { type ProviderAttempt, type ProviderRequestAccounting } from "./types.ts";

const apiError = (statusCode: number, responseBody = "body") => new APICallError({
    message: `request failed (${statusCode})`,
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
});

const SOURCE_PATTERN = /^[a-z]+(:[a-z][a-z0-9-]*)?$/;

test("{§provider-failure-normalization} HTTP request rejection preserves its cause without becoming a response-contract strike", () => {
    for (const status of [400, 404, 405, 422]) {
        const message = "The requested model is not available on this endpoint.";
        const cause = apiError(status, JSON.stringify({ error: { message } }));
        Object.defineProperty(cause, "message", { value: message });
        const failure = toProviderError(cause, "provider:example");
        assert.equal(failure.kind, "request_rejected");
        assert.equal(failure.status, status);
        assert.equal(failure.message, message);
        assert.equal(failure.problem.detail, message);
        assert.equal(failure.problem.retryable, false);
        assert.equal(failure.cause, cause);
    }
    assert.equal(classifyProviderError(apiError(200)).kind, "invalid_response", "a malformed successful response still violates the response contract");
});

test("{§provider-failure-normalization} providerSource folds a provider name into the colon-namespaced source grammar", () => {
    assert.equal(providerSource("openai"), "provider:openai");
    assert.match(providerSource("openrouter"), SOURCE_PATTERN);
    assert.equal(providerSource("@scope/custom_provider"), "provider:scope-custom-provider");
    assert.equal(providerSource("2fast"), "provider:p-2fast");
    assert.throws(() => providerSource(""), /must name a provider/);
});

test("{§provider-failure-normalization} classifyProviderError maps HTTP status to kind", () => {
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
    assert.equal(k(400), "request_rejected");
    assert.equal(k(404), "request_rejected");
});

test("{§provider-failure-normalization} capacity normalization prefers structured provider codes and keeps generic 400s distinct", () => {
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
    }))).kind, "request_rejected");
});

test("{§provider-failure-normalization} a transport's no-replay directive does not change the consumer-recoverable flag", () => {
    const final = new APICallError({
        message: "edge router says not to replay",
        url: "https://example.test/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 524,
        isRetryable: false,
    });
    const error = toProviderError(final, "provider:test");
    assert.equal(error.kind, "network_failure");
    assert.equal(error.problem.retryable, true, "the consumer re-issues every network_failure, so the flag says so");
});

test("{§provider-failure-normalization} retryable is exactly the consumer-recoverable kind set", () => {
    const kinds = ["rate_limit", "network_failure", "deadline_exceeded", "model_refused", "request_rejected", "invalid_response", "unauthorized", "quota_exceeded", "grammar_invalid", "capacity_exceeded", "resource_interrupted", "generation_failed"] as const;
    assert.deepEqual(
        kinds.filter((kind) => new ProviderError("provider:test", kind, "fixture").problem.retryable === true),
        ["rate_limit", "network_failure", "deadline_exceeded", "resource_interrupted"],
    );
    assert.deepEqual([...RETRYABLE_PROVIDER_KINDS], ["rate_limit", "network_failure", "deadline_exceeded", "resource_interrupted"]);
    assert.equal(new ProviderError("provider:test", "generation_failed", "fixture").status, 502, "{§provider-failure-normalization} a declared generation error is not re-issued");
});

test("{§provider-failure-normalization} classifyProviderError: a 422 flagged grammar_invalid is distinct from other request rejections", () => {
    const rejected = apiError(422, JSON.stringify({ error: { type: "grammar_invalid", message: "non-conforming emission rejected: ..." } }));
    assert.equal(classifyProviderError(rejected).kind, "grammar_invalid");
    assert.equal(classifyProviderError(apiError(422, JSON.stringify({ error: { type: "invalid_request_error" } }))).kind, "request_rejected");
    assert.equal(classifyProviderError(apiError(422, "<html>Bad</html>")).kind, "request_rejected");
});

test("{§provider-failure-normalization} classifyProviderError treats non-HTTP errors as network_failure", () => {
    assert.equal(classifyProviderError(new TypeError("fetch failed")).kind, "network_failure");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    assert.equal(classifyProviderError(timeout).kind, "network_failure");
});

test("{§provider-failure-normalization} ProviderError carries a validated RFC 9457 Problem Details object", () => {
    const e = new ProviderError("provider:openai", "rate_limit", "OpenAI 429 - slow down", { status: 429 });
    assert.deepEqual(e.problem, {
        type: "https://problems.plurnk.xyz/provider/openai/rate-limit",
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

test("{§provider-failure-normalization} ProviderError carries resource-interrupted attempt evidence outside Problem Details", () => {
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
            outputFloor: null,
            responseMax: null,
            reasoningBudget: null,
            inputCapacity: null,
            inputWall: null,
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
        type: "https://problems.plurnk.xyz/provider/deepseek/resource-interrupted",
        title: "Resource interrupted",
        status: 503,
        detail: "The provider interrupted generation because inference resources were unavailable.",
        providerKind: "resource_interrupted",
        stage: "provider-response",
        retryable: true,
        finishReason: "resource_interrupted",
        rawFinishReason: "insufficient_system_resource",
    });
});

test("{§provider-failure-normalization} toProviderError classifies and tags an HTTP error with the source + status", () => {
    const cause = apiError(401, "no key");
    const pe = toProviderError(cause, "provider:groq");
    assert.equal(pe.kind, "unauthorized");
    assert.equal(pe.source, "provider:groq");
    assert.equal(pe.status, 401);
    assert.equal(pe.cause, cause);
});

test("{§provider-failure-normalization} toProviderError passes an existing ProviderError through unchanged", () => {
    const original = new ProviderError("provider:xai", "rate_limit", "429");
    assert.equal(toProviderError(original, "provider:other"), original);
});

test("{§provider-failure-normalization} provider diagnostics are bounded without losing structured failure facts", () => {
    const cause = apiError(502);
    Object.defineProperty(cause, "message", { value: "abcdefghij" });
    const error = toProviderError(cause, "provider:test", 4);
    assert.equal(error.problem.detail, "abcd...");
    assert.equal(error.problem.status, 502);
    assert.equal(error.problem.providerKind, "network_failure");
    assert.equal(error.cause, cause);
});

test("{§provider-failure-normalization} transport retry exhaustion is explicit and stays consumer-recoverable", () => {
    const failures = [apiError(429), apiError(429), apiError(429)];
    const cause = new RetryError({
        message: "Failed after 3 attempts.",
        reason: "maxRetriesExceeded",
        errors: failures,
    });
    const error = toProviderError(cause, "provider:test");
    assert.equal(error.problem.retryable, true);
    assert.equal(error.problem.attempts, 3);
    assert.equal(error.problem.retryExhausted, true);
    assert.equal(error.cause, cause);
});


// {§provider-failure-normalization} — the SDK wraps every processing failure of a 2xx body in one message;
// the durable Problem keeps a bounded classification of what actually happened underneath.
const processingFailure = (cause: Error) => new APICallError({
    message: "Failed to process successful response",
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    responseHeaders: { authorization: "Bearer never-copied", "x-request-id": "req_1" },
    cause,
});

test("{§provider-failure-normalization} a terminated body, invalid JSON, a schema-invalid body, and an internal fault are told apart in durable evidence", () => {
    const terminated = toProviderError(processingFailure(new TypeError("terminated")), "provider:test", 512);
    assert.equal(terminated.problem.providerKind, "network_failure");
    assert.deepEqual(terminated.problem.cause, { causeKind: "transport_terminated", causeName: "TypeError", causeMessage: "terminated" });

    const parse = toProviderError(processingFailure(new JSONParseError({ text: "<html>502 Bad Gateway</html>".repeat(40), cause: new SyntaxError("Unexpected token <") })), "provider:test", 512);
    assert.equal(parse.problem.providerKind, "invalid_response");
    assert.deepEqual(parse.problem.cause, { causeKind: "invalid_json", causeName: "JSONParseError", causeMessage: "JSON parsing failed (1120 characters)" });
    assert.doesNotMatch(JSON.stringify(parse.problem), /Bad Gateway/, "the payload never enters the Problem");

    const schema = toProviderError(processingFailure(new TypeValidationError({ value: { choices: "not-an-array", secret: "sk-live" }, cause: new Error("Expected array, received string at choices\nmore lines") })), "provider:test", 512);
    assert.equal(schema.problem.providerKind, "invalid_response");
    assert.deepEqual(schema.problem.cause, { causeKind: "schema_invalid", causeName: "TypeValidationError", causeMessage: "Type validation failed: Expected array, received string at choices" });
    assert.doesNotMatch(JSON.stringify(schema.problem), /sk-live|not-an-array/, "the value never enters the Problem");

    const internal = toProviderError(processingFailure(new RangeError("Invalid array length\n    at Array.push (stack frame)")), "provider:test", 512);
    assert.deepEqual(internal.problem.cause, { causeKind: "internal", causeName: "RangeError", causeMessage: "Invalid array length" });
    assert.doesNotMatch(JSON.stringify(internal.problem), /stack frame|authorization|Bearer|req_1/, "no stack, no headers");

    const bounded = toProviderError(processingFailure(new Error("x".repeat(100))), "provider:test", 8);
    assert.equal((bounded.problem.cause as { causeMessage: string }).causeMessage, "xxxxxxxx...", "the cause message honours the configured detail limit");
    assert.equal(toProviderError(apiError(502), "provider:test", 512).problem.cause, undefined, "an error without a cause reports none");
});

{
test("{§provider-interface}: capture omits credentials and URL details and preserves a failed dispatch", async () => {
    const capture = new RequestCapture();
    const failure = new Error("network failed");
    const fetch = capture.fetch(async () => { throw failure; });
    const body = "{ \"literal\": \"unchanged\" }\n";
    await assert.rejects(fetch("https://user:secret@example.test/key-in-path?key=secret#secret", {
        method: "POST", headers: { authorization: "Bearer secret" }, body,
    }), (error) => error === failure);
    assert.deepEqual(capture.request, { origin: "https://example.test", method: "POST", body });
    assert.doesNotMatch(JSON.stringify(capture.request), /secret|key-in-path/);
});

test("{§provider-interface}: Request observation leaves the transport body readable", async () => {
    const input = new Request("https://example.test/completions", { method: "POST", body: "{\n}\n" });
    const capture = new RequestCapture();
    const fetch = capture.fetch(async (request) => {
        assert.equal(request, input);
        assert.equal(await input.text(), "{\n}\n");
        return new Response("ok");
    });
    await fetch(input);
    assert.equal(capture.request?.body, "{\n}\n");
});
}

{
for (const native of [false, true]) {
    for (const capture of [false, true]) {
        test(`{§provider-request-accounting} retained request equals dispatched bytes; native=${native}, capture=${capture}`, async (t) => {
            const received = new Map<string, string>();
            const secondArrived = Promise.withResolvers<void>();
            const server = createServer(async (request, response) => {
                let body = "";
                for await (const chunk of request) body += chunk.toString();
                const content = JSON.parse(body).messages[0].content as string;
                received.set(content, body);
                if (content.startsWith("first")) await secondArrived.promise;
                else secondArrived.resolve();
                assert.equal(request.headers.authorization, "Bearer fixture-secret");
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({
                    id: "fixture", model: "fixture", created: 0,
                    choices: [{ index: 0, message: { role: "assistant", content: "observed" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
                }));
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
            const address = server.address();
            assert.ok(address !== null && typeof address === "object");
            const origin = `http://127.0.0.1:${address.port}`;
            const provider = new ModelProvider({
                model: "fixture",
                ...(native
                    ? { modelTransport: createProviderModel("openai", "fixture", { OPENAI_API_KEY: "fixture-secret" }, `${origin}/v1`)!.modelTransport! }
                    : { url: `${origin}/v1/chat/completions`, headers: { Authorization: "Bearer fixture-secret" } }),
                streaming: false, rawBody: capture,
                fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
                temperature: 0.25, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            });
            await Promise.all(["first", "second"].map(async (identity) => {
                const content = `${identity}: literal "quotes" and a newline\n`;
                const evidence: unknown[] = [];
                const result = await provider.generate({
                    sessionId: identity, messages: [{ role: "user", content }],
                    observeRequest: async () => async (_accounting, value) => { evidence.push(value); },
                });
                assert.equal(result.assistant.content, "observed");
                assert.equal(evidence.length, 1);
                assert.deepEqual((evidence[0] as { request?: unknown }).request,
                    capture ? { method: "POST", origin, body: received.get(content) } : undefined);
                const dispatched = JSON.parse(received.get(content)!);
                assert.deepEqual(dispatched.tools, []);
                assert.equal(dispatched.tool_choice, "none");
                assert.equal(dispatched.temperature, 0.25);
                assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret/u);
            }));
            assert.equal(received.size, 2, "concurrent calls retain their own request bodies");
        });
    }
}

for (const protocol of ["google", "anthropic", "openrouter", "amazon-bedrock"] as const) {
    test(`{§provider-interface}: ${protocol} retains the native SDK body after owned transforms`, async () => {
        const sdk = createProviderModel(protocol, "fixture", {
            GEMINI_API_KEY: "fixture-secret", ANTHROPIC_API_KEY: "fixture-secret", OPENROUTER_API_KEY: "fixture-secret",
            AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "fixture-secret",
        });
        assert.ok(sdk?.modelTransport);
        let sent: string | undefined;
        let evidence: { request?: { body: string } } | undefined;
        const provider = new ModelProvider({
            model: "fixture", modelTransport: sdk.modelTransport,
            streaming: false, rawBody: true, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            fetch: async (_url, init) => {
                sent = requestBody(init);
                const response = protocol === "google"
                    ? { candidates: [{ content: { role: "model", parts: [{ text: "observed" }] }, finishReason: "STOP" }],
                        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }
                    : protocol === "anthropic"
                        ? { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "observed" }],
                            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }
                        : protocol === "amazon-bedrock"
                            ? { output: { message: { role: "assistant", content: [{ text: "observed" }] } },
                                stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } }
                            : { id: "fixture", model: "fixture", created: 0,
                                choices: [{ index: 0, message: { role: "assistant", content: "observed" }, finish_reason: "stop" }],
                                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
                return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
            },
        });
        const result = await provider.generate({ sessionId: "witness", messages: [{ role: "user", content: "Inspect the native body." }],
            observeRequest: async () => async (_accounting, value) => { evidence = value as typeof evidence; },
        });
        assert.equal(result.assistant.content, "observed");
        assert.equal(evidence?.request?.body, sent);
        assert.ok(sent?.includes("Inspect the native body."));
        assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret/u);
        const body = JSON.parse(sent!);
        if (protocol === "google") assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
        else if (protocol !== "amazon-bedrock") assert.deepEqual(body.tool_choice, protocol === "anthropic" ? { type: "none" } : "none");
    });
}

test("{§provider-request-accounting} native Messages failures retain SDK reasoning and uninterpreted chunks", async () => {
    const chunks = [
        { type: "message_start", message: { id: "native-failed", type: "message", role: "assistant", model: "fixture",
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Native partial reasoning." } },
        { type: "error", error: { type: "overloaded_error", message: "Native stream failed." } },
    ];
    const modelTransport = createProviderModel("anthropic", "fixture", { ANTHROPIC_API_KEY: "fixture" })!.modelTransport!(
        async () => new Response(
            chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const provider = new ModelProvider({
        model: "fixture", modelTransport, streaming: true, rawBody: false,
        fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
        temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
    });
    const records: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
    await assert.rejects(provider.generate({ sessionId: "witness", messages: [],
        observeRequest: async () => async (accounting, evidence) => { records.push({ accounting, evidence }); },
    }), /Native stream failed/);
    assert.equal(records.length, 1);
    assert.equal(records[0].accounting.outcome, "error");
    const evidence = records[0].evidence as { reasoning: string; rawBody: unknown[]; error: { message: string } };
    assert.equal(evidence.reasoning, "Native partial reasoning.");
    assert.deepEqual(evidence.rawBody, chunks);
    assert.match(evidence.error.message, /Native stream failed/);
});

for (const reported of [false, true]) {
    test(`{§provider-request-accounting} missing finish preserves partial output and raw evidence; usage=${reported}`, async () => {
        const chunk = {
            id: "failed-request", model: "fixture",
            choices: [{ index: 0, delta: { content: "unfinished", reasoning_content: "before EOF" }, finish_reason: null }],
            ...(reported ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
            vendor_evidence: "retained without interpretation",
        };
        const settled: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
        const provider = new ModelProvider({
            model: "fixture", url: "https://example.test/v1/chat/completions",
            streaming: true, rawBody: false, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
                headers: { "content-type": "text/event-stream", "x-request-id": "request-991" },
            }),
        });
        await assert.rejects(provider.generate({
            sessionId: "witness", messages: [],
            observeRequest: async () => async (accounting, evidence) => { settled.push({ accounting, evidence }); },
        }), /Response stream ended without a finish reason/);
        assert.equal(settled.length, 1);
        assert.equal(settled[0].accounting.outcome, "error");
        assert.equal(settled[0].accounting.usage?.inputTokens, reported ? 100 : undefined);
        const evidence = settled[0].evidence as {
            content: string; reasoning: string; rawBody: unknown[];
            error: { message: string }; chargeEvidence: { response: { id: string; headers: Record<string, string> } };
        };
        assert.ok(evidence, "failed requests must settle forensic evidence, not just accounting");
        assert.equal(evidence.content, "unfinished");
        assert.equal(evidence.reasoning, "before EOF");
        assert.deepEqual(evidence.rawBody, [chunk]);
        assert.equal(evidence.error.message, "Response stream ended without a finish reason.");
        assert.equal(evidence.chargeEvidence.response.id, "failed-request");
        assert.equal(evidence.chargeEvidence.response.headers["x-request-id"], "request-991");
    });
}

for (const capture of [false, true]) {
    test(`{§provider-request-accounting} a directed HTTP retry preserves the error body before a successful response; capture=${capture}`, async () => {
        const records: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
        const bodies: string[] = [];
        let calls = 0;
        const provider = new ModelProvider({
            model: "fixture", url: "https://example.test/v1/chat/completions", streaming: false,
            rawBody: capture, fetchTimeoutMs: 1000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 1,
            fetch: async (_input, init) => {
                calls++;
                bodies.push(requestBody(init));
                return calls === 1
                    ? new Response('{"error":{"message":"try again"},"witness":991}', {
                        status: 503, headers: { "content-type": "application/json", "x-should-retry": "true", "x-request-id": "failed-http" },
                    })
                    : new Response(JSON.stringify({
                        id: "recovered", model: "fixture",
                        choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
                    }), { headers: { "content-type": "application/json" } });
            },
        });
        const result = await provider.generate({
            sessionId: "witness", messages: [],
            observeRequest: async () => async (accounting, evidence) => { records.push({ accounting, evidence }); },
        });
        assert.equal(result.assistant.content, "recovered");
        assert.deepEqual(records.map(({ accounting }) => accounting.outcome), ["error", "response"]);
        const failed = records[0].evidence as { rawBody: string; chargeEvidence: { response: { headers: Record<string, string> } } };
        assert.equal(failed.rawBody, '{"error":{"message":"try again"},"witness":991}');
        assert.equal(failed.chargeEvidence.response.headers["x-request-id"], "failed-http");
        assert.equal(records[0].accounting.status, 503);
        assert.equal((records[1].evidence as { content: string }).content, "recovered");
        assert.deepEqual(records.map(({ evidence }) => (evidence as { request?: { body: string } }).request?.body),
            capture ? bodies : [undefined, undefined]);
    });
}
}
