import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { compatibleProviderFromEnv } from "./compatibleProvider.ts";
import { UnsupportedEffortError } from "./types.ts";
import { requestBody, requestUrl } from "../../scripts/lib/test-fetch.ts";
import { ollamaProviderFromEnv } from "./ollama.ts";
import { type Effort } from "@plurnk/plurnk-contracts";

{
const env = {
    PLURNK_PROVIDERS_MAX_CONCURRENCY: "-1",
    OPENAI_BASE_URL: "http://local.test/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_EFFORT: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
    PLURNK_PROVIDERS_OUTPUT_FLOOR: "10%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
    PLURNK_PROVIDERS_PROBE_DELAY: "0",
    PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
    PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
};

const streamedChatResponse = (content: string) => new Response([
    `data: ${JSON.stringify({
        id: "test-completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
    })}`,
    "data: [DONE]",
].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

test.afterEach(() => mock.restoreAll());

test("{§provider-interface} repeated text and reasoning retain the provider finish and final usage", async (t) => {
    const defaults = parseEnv(await readFile(new URL("../.env.defaults", import.meta.url), "utf8"));
    for (const channel of ["content", "reasoning_content"] as const) {
        for (const finishReason of ["stop", "length"] as const) {
            await t.test(`{§provider-interface} ${channel}: ${finishReason}`, async () => {
                const repeated = "if app_configs is None:\n";
                const fragments = Array.from({ length: 40 }, (_, index) => `${repeated}    candidate_${index}()\n`);
                const chunk = (delta: Record<string, string>, finish: string | null = null) => `data: ${JSON.stringify({
                    id: "repeated-code", object: "chat.completion.chunk", created: 1, model: "local",
                    choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`;
                const usage = { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110,
                    completion_tokens_details: { reasoning_tokens: channel === "reasoning_content" ? 80 : 0 } };
                let requests = 0;
                let settled = 0;
                const observed: string[] = [];
                mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
                    if (requestUrl(input).endsWith("/models")) {
                        return Response.json({ data: [{ id: "local", n_ctx: 100_000 }] });
                    }
                    requests++;
                    return new Response(fragments.map((text) => chunk({ [channel]: text })).join("")
                        + chunk({ content: "final answer" }, finishReason)
                        + `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
                    { headers: { "content-type": "text/event-stream" } });
                });
                const provider = await compatibleProviderFromEnv({ ...defaults, ...env }, "local");
                const response = await provider.generate({
                    sessionId: "repeated-code", messages: [{ role: "user", content: "compare these candidates" }],
                    observeReasoning: (delta) => { observed.push(delta); },
                    observeRequest: async () => async () => { settled++; },
                });
                assert.equal(response.assistant.finishReason, finishReason);
                assert.equal(response.assistant.content, (channel === "content" ? fragments.join("") : "") + "final answer");
                assert.equal(response.assistant.reasoning ?? "", channel === "reasoning_content" ? fragments.join("") : "");
                assert.equal(observed.join(""), channel === "reasoning_content" ? fragments.join("") : "");
                assert.equal(requests, 1);
                assert.equal(settled, 1);
                assert.equal(response.accounting.length, 1);
                assert.equal(response.accounting[0]?.outcome, "response");
                assert.equal(response.accounting[0]?.usage?.inputTokens, 10);
                assert.equal(response.accounting[0]?.usage?.outputTokens, 100);
                assert.equal(response.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, usage.completion_tokens_details.reasoning_tokens);
            });
        }
    }
});

test("{§provider-sdk-boundary} an undifferentiated compatible endpoint receives no guessed prompt-cache field", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "local", n_ctx: 8192 }] }));
        }
        body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        return streamedChatResponse("ok");
    });

    const provider = await compatibleProviderFromEnv(env, "local");
    await provider.generate({
        sessionId: "session-affinity",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal("prompt_cache_key" in (body ?? {}), false);
});

test("{§provider-configuration} the server-wide DRY-off floor emits no DRY request fields", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "local", meta: { n_ctx: 8192 } }],
            }));
        }
        body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        return streamedChatResponse("ok");
    });

    const provider = await compatibleProviderFromEnv({
        ...env,
        PLURNK_PROVIDERS_DRY_MULTIPLIER: "0",
        // Stale or independently supplied shape values cannot activate DRY.
        PLURNK_PROVIDERS_DRY_BASE: "1.75",
        PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH: "32",
    }, "local");
    await provider.generate({
        sessionId: "session-dry-off",
        messages: [{ role: "user", content: "repeat exactly" }],
    });

    assert.equal(body?.repeat_penalty, 1.15);
    assert.equal("dry_multiplier" in (body ?? {}), false);
    assert.equal("dry_base" in (body ?? {}), false);
    assert.equal("dry_allowed_length" in (body ?? {}), false);
});

// {§provider-effort} What a llama-server rail admits, and what each admitted effort sends.
const TEMPLATE_EFFORTS: ReadonlyArray<{
    name: string;
    declared: Record<string, string>;
    effort: Effort;
    admits?: readonly Effort[];
    sends?: Record<string, unknown>;
    refused?: RegExp;
}> = [
    { name: "off, nothing declared", declared: {}, effort: "off", admits: ["off", "adaptive"], sends: { enable_thinking: false } },
    { name: "adaptive, nothing declared", declared: {}, effort: "adaptive", admits: ["off", "adaptive"], sends: { enable_thinking: true } },
    {
        name: "a fixed effort, nothing declared", declared: {}, effort: "medium",
        refused: /effort 'medium' is unsupported; supported efforts: off, adaptive\. Declare each effort the served chat template distinguishes: PLURNK_PROVIDERS_REASONING_EFFORTS=medium /,
    },
    {
        name: "a declared fixed effort", declared: { PLURNK_PROVIDERS_REASONING_EFFORTS: "low,medium,xhigh" }, effort: "medium",
        admits: ["off", "adaptive", "low", "medium", "xhigh"], sends: { enable_thinking: true, reasoning_effort: "medium" },
    },
    {
        name: "adaptive beside a declaration", declared: { PLURNK_PROVIDERS_REASONING_EFFORTS: "low" }, effort: "adaptive",
        admits: ["off", "adaptive", "low"], sends: { enable_thinking: true },
    },
    {
        name: "a fixed effort outside the declaration", declared: { PLURNK_PROVIDERS_REASONING_EFFORTS: "low,xhigh" }, effort: "high",
        refused: /effort 'high' is unsupported; supported efforts: off, adaptive, low, xhigh\./,
    },
    {
        name: "the provider-wide declaration", declared: { PLURNK_PROVIDERS_PROVIDER_OPENAI_REASONING_EFFORTS: "max" }, effort: "max",
        admits: ["off", "adaptive", "max"], sends: { enable_thinking: true, reasoning_effort: "max" },
    },
];

for (const row of TEMPLATE_EFFORTS) {
    test(`{§provider-effort} a llama-server rail, ${row.name}`, async () => {
        let sent: Record<string, unknown> | undefined;
        mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "served.gguf", meta: { n_ctx: 8192 } }] }));
            if (url.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }));
            if (url.endsWith("/chat/completions")) {
                sent = JSON.parse(requestBody(init)) as Record<string, unknown>;
                return streamedChatResponse("ok");
            }
            throw new Error(`unexpected request ${url}`);
        });
        const configured = { ...env, ...row.declared, PLURNK_PROVIDERS_EFFORT: row.effort };
        if (row.refused !== undefined) {
            const refused = row.refused;
            await assert.rejects(compatibleProviderFromEnv(configured, "local"),
                (error: unknown) => error instanceof UnsupportedEffortError && refused.test(error.message));
            return;
        }
        const provider = await compatibleProviderFromEnv(configured, "local");
        assert.deepEqual(provider.supportedEfforts, row.admits, "the rail admits off, adaptive and what the operator declared");
        await provider.generate({ sessionId: "session-effort", messages: [{ role: "user", content: "hello" }] });
        assert.deepEqual(sent?.chat_template_kwargs, row.sends, "a fixed effort rides as the template's own variable");
    });
}

test("{§provider-effort} a compatible route without a template refuses a fixed effort and names no declaration", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "local", n_ctx: 8192 }] }));
        throw new Error(`unexpected request ${url}`);
    });
    await assert.rejects(
        compatibleProviderFromEnv({ ...env, PLURNK_PROVIDERS_EFFORT: "high", PLURNK_PROVIDERS_REASONING_EFFORTS: "high" }, "local"),
        (error: unknown) => error instanceof UnsupportedEffortError
            && error.message.endsWith("effort 'high' is unsupported; supported efforts: off, adaptive. This route sends no fixed-effort control."),
    );
});

test("{§model-fact-resolution} detected llama-server measures the complete chat request through input_tokens", async () => {
    let countUrl: string | undefined;
    let countBody: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "served.gguf", meta: { n_ctx: 8192 } }],
            }));
        }
        if (url.endsWith("/props")) {
            return new Response(JSON.stringify({ total_slots: 1 }));
        }
        if (url.endsWith("/chat/completions/input_tokens")) {
            countUrl = url;
            countBody = JSON.parse(requestBody(init)) as Record<string, unknown>;
            return new Response(JSON.stringify({ input_tokens: 37 }), {
                headers: { "content-type": "application/json" },
            });
        }
        throw new Error(`unexpected request ${url}`);
    });

    const provider = await compatibleProviderFromEnv(env, "local");
    const messages = [
        { role: "system" as const, content: "system slot" },
        { role: "user" as const, content: "漢漢漢" },
    ];
    assert.deepEqual(await provider.countPromptTokens(messages), {
        kind: "exact",
        tokens: 37,
        source: "llama-server:/v1/chat/completions/input_tokens",
    });
    assert.equal(countUrl, "http://local.test/v1/chat/completions/input_tokens");
    assert.deepEqual(countBody?.messages, messages, "measurement receives the exact dispatched message slots");
    assert.equal(countBody?.model, "local");
    assert.deepEqual(countBody?.chat_template_kwargs, { enable_thinking: false });
});

test("{§provider-capacity-admission} a missing llama-server input-token endpoint degrades explicitly, never to a claimed bound", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/models")) {
            return new Response(JSON.stringify({
                data: [{ id: "served.gguf", meta: { n_ctx: 8192 } }],
            }));
        }
        if (url.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }));
        if (url.endsWith("/chat/completions/input_tokens")) return new Response("missing", { status: 404 });
        throw new Error(`unexpected request ${url}`);
    });

    const provider = await compatibleProviderFromEnv(env, "local");
    assert.deepEqual(await provider.countPromptTokens([{ role: "user", content: "漢漢漢" }]), {
        kind: "estimate",
        tokens: 2,
        source: "heuristic:chars2",
        detail: "llama-server input-token endpoint returned HTTP 404",
    });
});
}

{
const env = Object.freeze({
    PLURNK_PROVIDERS_MAX_CONCURRENCY: "-1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_EFFORT: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
    PLURNK_PROVIDERS_OUTPUT_FLOOR: "10%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
    PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
});

test.afterEach(() => mock.restoreAll());

// {§model-fact-resolution}
test("{§model-fact-resolution} #126: Ollama always probes model physics and applies an operator context-window ceiling", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        calls.push(requestUrl(input));
        return new Response(JSON.stringify({
            model_info: { "qwen.context_length": 32_768 },
        }));
    });

    const windows: Array<number | null> = [];
    for (const operatorCap of [undefined, "8192", "65536"] as const) {
        const provider = await ollamaProviderFromEnv({
            ...env,
            ...(operatorCap === undefined ? {} : { PLURNK_PROVIDERS_CONTEXT_WINDOW: operatorCap }),
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434/v1" });
        windows.push(provider.contextWindow);
    }

    assert.deepEqual(windows, [32_768, 8_192, 32_768]);
    assert.deepEqual(calls, Array.from({ length: 3 }, () => "http://ollama.test:11434/api/show"));
});

test("{§model-fact-resolution} #126: an operator ceiling does not hide an Ollama probe HTTP failure", async () => {
    mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    await assert.rejects(
        () => ollamaProviderFromEnv({
            ...env,
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434" }),
        /ollama provider: \/api\/show returned 503/,
    );
});

test("{§model-fact-resolution} #126: an operator ceiling does not hide a missing Ollama model fact", async () => {
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ model_info: {} })));
    await assert.rejects(
        () => ollamaProviderFromEnv({
            ...env,
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434" }),
        /ollama provider: \/api\/show has no \*\.context_length key for "qwen2\.5-coder"/,
    );
});
}
