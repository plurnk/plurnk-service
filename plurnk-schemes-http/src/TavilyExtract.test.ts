import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    TAVILY_DEPTH,
    TAVILY_TIMEOUT_MS,
    tavilyConfiguration,
    tavilyExtract,
    tavilyExtractIdentity,
} from "./TavilyExtract.ts";

const saved = new Map([
    ["TAVILY_API_KEY", process.env.TAVILY_API_KEY],
    [TAVILY_DEPTH, process.env[TAVILY_DEPTH]],
    [TAVILY_TIMEOUT_MS, process.env[TAVILY_TIMEOUT_MS]],
]);

beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
    process.env[TAVILY_DEPTH] = "basic";
    process.env[TAVILY_TIMEOUT_MS] = "1000";
});

after(() => {
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const withFetch = async (replacement: typeof fetch, run: () => Promise<void>): Promise<void> => {
    const original = globalThis.fetch;
    globalThis.fetch = replacement;
    try { await run(); } finally { globalThis.fetch = original; }
};

const response = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json", ...headers } },
);

const configure = (): void => { process.env.TAVILY_API_KEY = "tvly-test-key"; };

test("Tavily absence is optional after depth and timeout configuration validate", async () => {
    assert.equal(tavilyConfiguration(), null);
    assert.equal(tavilyExtractIdentity(), null);
    assert.equal(await tavilyExtract("https://example.com"), null);
});

test("invalid Tavily depth or timeout fails before any provider request", async () => {
    configure();
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        throw new Error("must not call");
    }) as typeof fetch, async () => {
        process.env[TAVILY_DEPTH] = "expensive-ish";
        assert.throws(tavilyConfiguration, /must be "basic" or "advanced"/);
        process.env[TAVILY_DEPTH] = "basic";
        process.env[TAVILY_TIMEOUT_MS] = "0";
        assert.throws(tavilyConfiguration, /must be a positive integer/);
        await assert.rejects(
            tavilyExtract("https://example.com"),
            /must be a positive integer/,
        );
    });
    assert.equal(calls, 0);
});

test("Tavily success sends only the owned extraction request and preserves usage evidence", async () => {
    configure();
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    let requestHeaders = new Headers();
    await withFetch((async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestHeaders = new Headers(init?.headers);
        return response({
            results: [{ url: "https://example.com/final", raw_content: "# Extracted" }],
            failed_results: [],
            request_id: "req-123",
            usage: { credits: 0.2 },
        });
    }) as typeof fetch, async () => {
        const result = await tavilyExtract("https://example.com/original");
        assert.deepEqual(result === null ? null : {
            outcome: result.outcome,
            markdown: result.outcome === "success" ? result.markdown : undefined,
            sourceUrl: result.outcome === "success" ? result.sourceUrl : undefined,
            requestId: result.requestId,
            credits: result.credits,
            status: result.status,
        }, {
            outcome: "success",
            markdown: "# Extracted",
            sourceUrl: "https://example.com/final",
            requestId: "req-123",
            credits: 0.2,
            status: 200,
        });
        assert.ok((result?.elapsedMs ?? -1) >= 0);
    });
    assert.equal(requestUrl, "https://api.tavily.com/extract");
    assert.equal(requestHeaders.get("authorization"), "Bearer tvly-test-key");
    assert.deepEqual(requestBody, {
        urls: ["https://example.com/original"],
        extract_depth: "basic",
        format: "markdown",
        include_usage: true,
    });
});

for (const specimen of [
    { status: 401, outcome: "hard", reason: "authentication" },
    { status: 403, outcome: "hard", reason: "authentication" },
    { status: 400, outcome: "hard", reason: "provider-rejection" },
    { status: 429, outcome: "recoverable", reason: "rate-limit" },
    { status: 503, outcome: "recoverable", reason: "server" },
] as const) {
    test(`Tavily HTTP ${specimen.status} is classified as ${specimen.outcome}/${specimen.reason}`, async () => {
        configure();
        await withFetch((async () => response({
            detail: "provider refusal",
            request_id: "req-failure",
            usage: { credits: 0 },
        }, specimen.status, { "retry-after": "17" })) as typeof fetch, async () => {
            const result = await tavilyExtract("https://example.com");
            if (result === null || result.outcome === "success") assert.fail("expected failure");
            assert.equal(result?.outcome, specimen.outcome);
            assert.equal(result.reason, specimen.reason);
            assert.equal(result.status, specimen.status);
            assert.equal(result.requestId, "req-failure");
            assert.equal(result.credits, 0);
            assert.equal(result.retryAfter, "17");
            assert.equal(result.error, "provider refusal");
        });
    });
}

test("a per-URL failed_results occurrence is an admitted recoverable failure", async () => {
    configure();
    await withFetch((async () => response({
        results: [],
        failed_results: [{ url: "https://example.com", error: "not extractable" }],
        request_id: "req-failed-result",
        usage: { credits: 0 },
    })) as typeof fetch, async () => {
        const result = await tavilyExtract("https://example.com");
        assert.equal(result?.outcome, "recoverable");
        if (result?.outcome !== "recoverable") assert.fail("expected recoverable failure");
        assert.equal(result.reason, "failed-result");
        assert.equal(result.error, "not extractable");
    });
});

for (const [name, payload] of [
    ["invalid JSON", "{"],
    ["missing usage", { results: [{ raw_content: "body" }], request_id: "req" }],
    ["missing request ID", { results: [{ raw_content: "body" }], usage: { credits: 1 } }],
    ["missing result and failure", { results: [], failed_results: [], request_id: "req", usage: { credits: 1 } }],
] as const) {
    test(`a successful Tavily response with ${name} is a hard malformed-response failure`, async () => {
        configure();
        await withFetch((async () => response(payload)) as typeof fetch, async () => {
            const result = await tavilyExtract("https://example.com");
            assert.equal(result?.outcome, "hard");
            if (result?.outcome !== "hard") assert.fail("expected hard failure");
            assert.equal(result.reason, "malformed-response");
        });
    });
}

test("a Tavily transport failure is recoverable and retains a bounded cause", async () => {
    configure();
    await withFetch((async () => { throw new Error("socket unavailable"); }) as typeof fetch, async () => {
        const result = await tavilyExtract("https://example.com");
        assert.equal(result?.outcome, "recoverable");
        if (result?.outcome !== "recoverable") assert.fail("expected recoverable failure");
        assert.equal(result.reason, "network");
        assert.equal(result.error, "socket unavailable");
    });
});

test("the Tavily-owned timeout is recoverable", async () => {
    configure();
    process.env[TAVILY_TIMEOUT_MS] = "1";
    await withFetch(((_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch, async () => {
        const result = await tavilyExtract("https://example.com");
        assert.equal(result?.outcome, "recoverable");
        if (result?.outcome !== "recoverable") assert.fail("expected recoverable failure");
        assert.equal(result.reason, "timeout");
    });
});

test("caller cancellation propagates the caller's exact reason", async () => {
    configure();
    const caller = new AbortController();
    const reason = new Error("operator cancelled");
    await withFetch((async (_input, init) => {
        caller.abort(reason);
        init?.signal?.throwIfAborted();
        throw new Error("unreachable");
    }) as typeof fetch, async () => {
        await assert.rejects(
            tavilyExtract("https://example.com", { signal: caller.signal }),
            (error: unknown) => error === reason,
        );
    });
});

test("caller cancellation while consuming a Tavily response propagates the exact reason", async () => {
    configure();
    const caller = new AbortController();
    const reason = new Error("operator cancelled response consumption");
    await withFetch((async (_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
                queueMicrotask(() => caller.abort(reason));
            },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch, async () => {
        await assert.rejects(
            tavilyExtract("https://example.com", { signal: caller.signal }),
            (error: unknown) => error === reason,
        );
    });
});

test("the Tavily-owned timeout remains recoverable while consuming a response", async () => {
    configure();
    process.env[TAVILY_TIMEOUT_MS] = "1";
    await withFetch((async (_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch, async () => {
        const result = await tavilyExtract("https://example.com");
        assert.equal(result?.outcome, "recoverable");
        if (result?.outcome !== "recoverable") assert.fail("expected recoverable failure");
        assert.equal(result.reason, "timeout");
    });
});
