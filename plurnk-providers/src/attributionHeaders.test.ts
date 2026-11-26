import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTION_HEADER_FIELDS } from "./types.ts";
import {
    ATTRIBUTION_VALUE_MAX_LENGTH,
    MODULE_METADATA_MAX_KEYS,
    attributionHeadersFromEnv,
    isValidModuleMetadataKey,
    parseAttributionHeaderFields,
    projectAttributionHeaders,
    sanitizeAttributionHeaderValue,
    validateAttributionHeadersFromEnv,
} from "./attributionHeaders.ts";
import { scopeEnvToAlias } from "./env.ts";
import { withProviderDefaults } from "./defaults.ts";
import { compatibleProviderFromEnv } from "./compatibleProvider.ts";
import { catalogProviderFromEnv } from "./catalogProvider.ts";
import ModelProvider from "./ModelProvider.ts";
import Pool from "./Pool.ts";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";

const readHeaders = (input: string | URL | Request, init?: RequestInit): Headers => {
    if (init?.headers !== undefined) return new Headers(init.headers);
    if (input instanceof Request) return new Headers(input.headers);
    return new Headers();
};

const openAiSseResponse = (content = "ok"): Response => new Response([
    `data: ${JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    })}`,
    "data: [DONE]",
].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

const anthropicSseResponse = (content = "ok"): Response => new Response([
    `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            usage: { input_tokens: 4, output_tokens: 0 },
        },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: content },
    })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });

const googleSseResponse = (content = "ok"): Response => new Response(
    `data: ${JSON.stringify({
        candidates: [{
            content: { role: "model", parts: [{ text: content }] },
            finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
);

const sampleAttribution = {
    workspaceId: 7,
    workspaceName: "plurnkbot-prod",
    sessionId: 42,
    sessionName: "chat-100123",
    actor: "client:telegram:9988",
    loopId: 11,
    turnId: 3,
    moduleMetadata: {
        "tenant-id": "tg-group-100123",
        plan: "starter",
    },
} as const;

test.afterEach(() => mock.restoreAll());

test("{§provider-configuration} parseAttributionHeaderFields: unset, empty, and off select none; valid lists parse strictly and invalid inputs fail fast", () => {
    assert.equal(parseAttributionHeaderFields(undefined, "KEY").size, 0);
    assert.equal(parseAttributionHeaderFields("", "KEY").size, 0);
    assert.equal(parseAttributionHeaderFields("   ", "KEY").size, 0);
    assert.equal(parseAttributionHeaderFields("off", "KEY").size, 0);
    assert.equal(parseAttributionHeaderFields(" off ", "KEY").size, 0);

    const parsed = parseAttributionHeaderFields(" workspace , session, actor, workspace ", "KEY");
    assert.deepEqual([...parsed], ["workspace", "session", "actor"]);

    const all = parseAttributionHeaderFields(ATTRIBUTION_HEADER_FIELDS.join(","), "KEY");
    assert.deepEqual([...all], [...ATTRIBUTION_HEADER_FIELDS]);

    for (const invalid of [
        "bogus",
        "Workspace",
        "workspace,",
        ",workspace",
        "workspace,,actor",
        "off,workspace",
        "workspace,off",
    ]) {
        assert.throws(
            () => parseAttributionHeaderFields(invalid, "PLURNK_PROVIDERS_ATTRIBUTION_HEADERS"),
            TypeError,
            `expected invalid input ${JSON.stringify(invalid)} to fail fast`,
        );
    }
});

test("{§provider-configuration} attributionHeadersFromEnv & scopeEnvToAlias: provider-wide opt-in, per-alias override, =off suppression, and offline env validation", () => {
    const base: NodeJS.ProcessEnv = {
        PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS: "workspace,session,actor",
        PLURNK_PROVIDERS_ATTRIBUTION_HEADERS_magic: "workspace,actor,module",
        PLURNK_PROVIDERS_ATTRIBUTION_HEADERS_public: "off",
    };

    assert.deepEqual(
        [...attributionHeadersFromEnv("openrouter", scopeEnvToAlias(base, "default"))],
        ["workspace", "session", "actor"],
    );
    assert.deepEqual(
        [...attributionHeadersFromEnv("openrouter", scopeEnvToAlias(base, "magic"))],
        ["workspace", "actor", "module"],
    );
    assert.deepEqual(
        [...attributionHeadersFromEnv("openrouter", scopeEnvToAlias(base, "public"))],
        [],
        "an alias setting =off suppresses an inherited provider-wide attribution allowlist",
    );
    assert.deepEqual(
        [...attributionHeadersFromEnv("anthropic", scopeEnvToAlias(base, "default"))],
        [],
        "provider-scoped attribution headers never leak onto other providers",
    );

    validateAttributionHeadersFromEnv(base);
    assert.throws(
        () => validateAttributionHeadersFromEnv({
            ...base,
            PLURNK_PROVIDERS_PROVIDER_OPENAI_ATTRIBUTION_HEADERS: "workspace,nope",
        }),
        /PLURNK_PROVIDERS_PROVIDER_OPENAI_ATTRIBUTION_HEADERS has invalid field "nope"/u,
    );
    assert.throws(
        () => validateAttributionHeadersFromEnv({
            ...base,
            PLURNK_PROVIDERS_ATTRIBUTION_HEADERS_badalias: "actor,invalid",
        }),
        /PLURNK_PROVIDERS_ATTRIBUTION_HEADERS_badalias has invalid field "invalid"/u,
    );
});

test("{§provider-request-authority} projectAttributionHeaders & sanitizeAttributionHeaderValue: exact field mapping, sanitization, Unicode encoding, length cap, and module key validation", () => {
    assert.deepEqual(
        projectAttributionHeaders(new Set(), sampleAttribution, "emission"),
        {},
        "zero leakage when no fields are enabled",
    );

    const projected = projectAttributionHeaders(
        new Set(ATTRIBUTION_HEADER_FIELDS),
        sampleAttribution,
        "emission",
    );
    assert.deepEqual(projected, {
        "X-Plurnk-Workspace": "plurnkbot-prod",
        "X-Plurnk-Workspace-Id": "7",
        "X-Plurnk-Session": "chat-100123",
        "X-Plurnk-Session-Id": "42",
        "X-Plurnk-Actor": "client:telegram:9988",
        "X-Plurnk-Loop-Id": "11",
        "X-Plurnk-Turn-Id": "3",
        "X-Plurnk-Call-Kind": "emission",
        "X-Plurnk-Meta-tenant-id": "tg-group-100123",
        "X-Plurnk-Meta-plan": "starter",
    });

    // Null or empty actor is omitted rather than serialized as "null" or empty.
    assert.deepEqual(
        projectAttributionHeaders(new Set(["actor", "call-kind"]), { actor: null }, "bare"),
        { "X-Plurnk-Call-Kind": "bare" },
    );

    // Control chars / CRLF injection attempts are stripped; Unicode percent-encodes safely.
    assert.equal(sanitizeAttributionHeaderValue("safe\r\nX-Injected: true\0\x1f"), "safeX-Injected: true");
    assert.equal(sanitizeAttributionHeaderValue("team-🚀-café"), "team-%F0%9F%9A%80-caf%C3%A9");
    assert.equal(sanitizeAttributionHeaderValue("\r\n\t\0"), undefined);

    // Length cap never splits a percent-encoded sequence.
    const longAscii = "a".repeat(ATTRIBUTION_VALUE_MAX_LENGTH + 40);
    assert.equal(sanitizeAttributionHeaderValue(longAscii)?.length, ATTRIBUTION_VALUE_MAX_LENGTH);
    const longEmoji = "🚀".repeat(40);
    const clampedEmoji = sanitizeAttributionHeaderValue(longEmoji)!;
    assert.ok(clampedEmoji.length <= ATTRIBUTION_VALUE_MAX_LENGTH);
    assert.equal(clampedEmoji.length % 12, 0, "UTF-8 percent-encoded 4-byte character is never split mid-escape");

    // Module key grammar and entry count limits fail fast.
    assert.equal(isValidModuleMetadataKey("tenant-id-1"), true);
    for (const badKey of ["", "Authorization", "Upper", "-dash", "bad key", "a_b", "x\r\ny", "a".repeat(65)]) {
        assert.equal(isValidModuleMetadataKey(badKey), false);
        assert.throws(
            () => projectAttributionHeaders(new Set(["module"]), { moduleMetadata: { [badKey]: "v" } }, "emission"),
            TypeError,
        );
    }
    const tooMany = Object.fromEntries(
        Array.from({ length: MODULE_METADATA_MAX_KEYS + 1 }, (_, i) => [`k-${i}`, "v"]),
    );
    assert.throws(
        () => projectAttributionHeaders(new Set(["module"]), { moduleMetadata: tooMany }, "emission"),
        RangeError,
    );
});

test("{§provider-request-authority} compatibleProviderFromEnv: zero X-Plurnk-* leakage by default, opt-in headers on generate() only (never on /models, /props, or /tokenize)", async () => {
    const baseEnv = withProviderDefaults({
        OPENAI_BASE_URL: "http://local-proxy.test/v1",
        OPENAI_API_KEY: "local-secret",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
        PLURNK_PROVIDERS_PROBE_DELAY_MS: "0",
    });

    const seenByUrl = new Map<string, Headers[]>();
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const headers = readHeaders(input, init);
        const list = seenByUrl.get(url) ?? [];
        list.push(headers);
        seenByUrl.set(url, list);
        if (url.endsWith("/models")) {
            return Response.json({ data: [{ id: "local", meta: { n_ctx: 8192 } }] });
        }
        if (url.endsWith("/props")) {
            return Response.json({ total_slots: 1 });
        }
        if (url.endsWith("/tokenize")) {
            return Response.json({ tokens: [1, 2] });
        }
        return openAiSseResponse("ok");
    });

    // 1. Default off: zero X-Plurnk-* headers anywhere.
    const defaultProvider = await compatibleProviderFromEnv(baseEnv, "local");
    assert.equal(defaultProvider.attributionHeaders?.size, 0);
    await defaultProvider.generate({
        sessionId: "sess-1",
        messages: [{ role: "user", content: "hi" }],
        callKind: "emission",
        attribution: sampleAttribution,
    });
    const defaultChatHeaders = seenByUrl.get("http://local-proxy.test/v1/chat/completions")![0];
    for (const [name] of defaultChatHeaders.entries()) {
        assert.ok(!name.startsWith("x-plurnk-"), `unexpected default header ${name}`);
    }

    // 2. Opted-in: headers appear on generate() for emission & bare, never on /models, /props, /tokenize.
    seenByUrl.clear();
    const optedProvider = await compatibleProviderFromEnv({
        ...baseEnv,
        PLURNK_PROVIDERS_PROVIDER_OPENAI_ATTRIBUTION_HEADERS: "workspace,session,actor,call-kind,module",
    }, "local");
    await optedProvider.tokenize?.("hello");
    await optedProvider.generate({
        sessionId: "sess-1",
        messages: [{ role: "user", content: "hi" }],
        callKind: "emission",
        attribution: sampleAttribution,
    });
    await optedProvider.generate({
        sessionId: "sess-2",
        messages: [{ role: "user", content: "hi bare" }],
        callKind: "bare",
        attribution: sampleAttribution,
    });

    for (const probeUrl of [
        "http://local-proxy.test/v1/models",
        "http://local-proxy.test/props",
        "http://local-proxy.test/tokenize",
    ]) {
        const probeHeaders = seenByUrl.get(probeUrl) ?? [];
        assert.ok(probeHeaders.length > 0, `expected probe to hit ${probeUrl}`);
        for (const headers of probeHeaders) {
            for (const [name] of headers.entries()) {
                assert.ok(!name.startsWith("x-plurnk-"), `probe ${probeUrl} must not carry ${name}`);
            }
        }
    }

    const [emissionHeaders, bareHeaders] = seenByUrl.get("http://local-proxy.test/v1/chat/completions")!;
    assert.equal(emissionHeaders.get("authorization"), "Bearer local-secret");
    assert.equal(emissionHeaders.get("x-plurnk-workspace"), "plurnkbot-prod");
    assert.equal(emissionHeaders.get("x-plurnk-session"), "chat-100123");
    assert.equal(emissionHeaders.get("x-plurnk-actor"), "client:telegram:9988");
    assert.equal(emissionHeaders.get("x-plurnk-call-kind"), "emission");
    assert.equal(emissionHeaders.get("x-plurnk-meta-tenant-id"), "tg-group-100123");
    assert.equal(emissionHeaders.get("x-plurnk-meta-plan"), "starter");
    assert.equal(emissionHeaders.get("x-plurnk-workspace-id"), null, "unlisted fields must not be emitted");
    assert.equal(bareHeaders.get("x-plurnk-call-kind"), "bare");
    assert.equal(bareHeaders.get("x-plurnk-workspace"), "plurnkbot-prod");
});

test("{§provider-request-authority} catalogProviderFromEnv transports (OpenRouter, Anthropic, Google) transmit opted-in X-Plurnk-* headers and preserve static auth/routing headers", async () => {
    const captured: { url: string; headers: Headers }[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const headers = readHeaders(input, init);
        captured.push({ url, headers });
        if (url.includes("anthropic")) return anthropicSseResponse("ok");
        if (url.includes("generativelanguage")) return googleSseResponse("ok");
        return openAiSseResponse("ok");
    });

    // OpenRouter (OpenAI completions over custom proxy base URL)
    const openRouter = catalogProviderFromEnv(
        "openrouter",
        withProviderDefaults({
            OPENROUTER_API_KEY: "or-secret",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_ATTRIBUTION_HEADERS: "workspace,session,actor,module",
        }),
        "openai/gpt-4.1-mini",
        "http://magic-proxy.test/v1",
    )!;
    await openRouter.generate({
        sessionId: "or-sess",
        messages: [{ role: "user", content: "hello" }],
        callKind: "emission",
        attribution: sampleAttribution,
    });
    const orReq = captured.at(-1)!;
    assert.equal(orReq.headers.get("http-referer"), "https://github.com/plurnk/plurnk-service");
    assert.equal(orReq.headers.get("x-openrouter-title"), "Plurnk");
    assert.equal(orReq.headers.get("x-plurnk-workspace"), "plurnkbot-prod");
    assert.equal(orReq.headers.get("x-plurnk-session"), "chat-100123");
    assert.equal(orReq.headers.get("x-plurnk-actor"), "client:telegram:9988");
    assert.equal(orReq.headers.get("x-plurnk-meta-tenant-id"), "tg-group-100123");

    // Anthropic (anthropic-messages API)
    const anthropic = catalogProviderFromEnv(
        "anthropic",
        withProviderDefaults({
            ANTHROPIC_API_KEY: "anth-secret",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_PROVIDER_ANTHROPIC_ATTRIBUTION_HEADERS: "workspace,loop,turn",
        }),
        "claude-sonnet-4-5",
    )!;
    await anthropic.generate({
        sessionId: "anth-sess",
        messages: [{ role: "user", content: "hello" }],
        callKind: "emission",
        attribution: sampleAttribution,
    });
    const anthReq = captured.at(-1)!;
    assert.equal(anthReq.headers.get("x-api-key"), "anth-secret");
    assert.equal(anthReq.headers.get("x-plurnk-workspace"), "plurnkbot-prod");
    assert.equal(anthReq.headers.get("x-plurnk-loop-id"), "11");
    assert.equal(anthReq.headers.get("x-plurnk-turn-id"), "3");
    assert.equal(anthReq.headers.get("x-plurnk-actor"), null);

    // Google (google-generative-ai API)
    const google = catalogProviderFromEnv(
        "google",
        withProviderDefaults({
            GEMINI_API_KEY: "gem-secret",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_PROVIDER_GOOGLE_ATTRIBUTION_HEADERS: "workspace,actor",
        }),
        "gemini-2.5-flash",
    )!;
    await google.generate({
        sessionId: "gem-sess",
        messages: [{ role: "user", content: "hello" }],
        callKind: "emission",
        attribution: sampleAttribution,
    });
    const gemReq = captured.at(-1)!;
    assert.equal(gemReq.headers.get("x-plurnk-workspace"), "plurnkbot-prod");
    assert.equal(gemReq.headers.get("x-plurnk-actor"), "client:telegram:9988");
    assert.equal(gemReq.headers.get("x-plurnk-google-fetch-route"), null);
});

test("{§provider-request-authority} static headers always take precedence over projected attribution headers, and Pool forwards attribution", async () => {
    const captured: Headers[] = [];
    const customFetch: typeof globalThis.fetch = async (input, init) => {
        captured.push(readHeaders(input, init));
        return openAiSseResponse("ok");
    };
    const backend = new ModelProvider({
        model: "pool-model",
        url: "http://proxy.test/v1/chat/completions",
        headers: {
            Authorization: "Bearer pinned",
            "X-Plurnk-Workspace": "pinned-static-value",
        },
        attributionHeaders: new Set(["workspace", "actor"]),
        fetch: customFetch,
        fetchTimeoutMs: 1000,
        operationTimeoutMs: 3000,
        effort: { mode: "off", budget: null },
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
    });
    const pool = new Pool([backend]);
    assert.deepEqual([...(pool.attributionHeaders ?? [])], ["workspace", "actor"]);
    await pool.generate({
        sessionId: "pool-sess",
        messages: [{ role: "user", content: "hi" }],
        attribution: sampleAttribution,
    });
    assert.equal(captured[0].get("authorization"), "Bearer pinned");
    assert.equal(captured[0].get("x-plurnk-workspace"), "pinned-static-value");
    assert.equal(captured[0].get("x-plurnk-actor"), "client:telegram:9988");
});
