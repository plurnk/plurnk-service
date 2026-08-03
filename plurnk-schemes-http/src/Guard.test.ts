// SSRF guard unit tests. Fully hermetic — pure range checks and IP-literal URLs
// (net.isIP short-circuits DNS). Redirect-hop count reads
// PLURNK_SCHEMES_HTTP_REDIRECTS from .env.defaults via --env-file.

import test from "node:test";
import { strict as assert } from "node:assert";
import Guard, { GuardBlockedError } from "./Guard.ts";

test("isPublicAddress: blocks RFC-reserved v4 ranges", () => {
    for (const ip of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.0.1"]) {
        assert.equal(Guard.isPublicAddress(ip), false, `${ip} should be non-public`);
    }
});

test("isPublicAddress: allows public v4 (incl. range boundaries)", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "11.0.0.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) {
        assert.equal(Guard.isPublicAddress(ip), true, `${ip} should be public`);
    }
});

test("isPublicAddress: blocks non-global v4 ranges", () => {
    for (const ip of ["192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
        assert.equal(Guard.isPublicAddress(ip), false, `${ip} should be non-global`);
    }
});

test("isPublicAddress: blocks non-global v6 and canonical v4-mapped forms", () => {
    for (const ip of ["::", "::1", "100::1", "2001::1", "2001:db8::1", "3fff::1", "5f00::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
        assert.equal(Guard.isPublicAddress(ip), false, `${ip} should be private`);
    }
    assert.equal(Guard.isPublicAddress("2606:4700:4700::1111"), true);
    assert.equal(Guard.isPublicAddress("::ffff:8.8.8.8"), true);
    assert.equal(Guard.isPublicAddress("::ffff:808:808"), true);
    assert.equal(Guard.isPublicAddress("not-an-address"), false);
});

test("isPublicUrl: protocol / localhost / IP-literal, no DNS", async () => {
    for (const bad of ["ftp://8.8.8.8/", "file:///etc/passwd", "http://localhost/", "http://x.localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/", "https://user:secret@8.8.8.8/", "ws://127.0.0.1/", "wss://192.168.1.1/", "not a url"]) {
        assert.equal(await Guard.isPublicUrl(bad), false, `${bad} should be refused`);
    }
    assert.equal(await Guard.isPublicUrl("https://8.8.8.8/"), true);
    assert.equal(await Guard.isPublicUrl("http://[2606:4700:4700::1111]/"), true);
    // ws(s):// ride the same range check (the Ws engine guards its target here).
    assert.equal(await Guard.isPublicUrl("wss://8.8.8.8/"), true);
    assert.equal(await Guard.isPublicUrl("ws://93.184.216.34/feed"), true);
});

test("Guard.fetch: a private target is refused before any fetch", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    try {
        await assert.rejects(
            Guard.fetch("http://127.0.0.1/", { method: "GET", body: undefined, headers: [] }, AbortSignal.timeout(2000)),
            (e) => e instanceof GuardBlockedError,
        );
        assert.equal(called, false);
    } finally { globalThis.fetch = orig; }
});

test("Guard.fetch: ws(s) remains valid for socket validation but not byte transport", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    try {
        assert.equal(await Guard.isPublicUrl("wss://8.8.8.8/"), true);
        await assert.rejects(
            Guard.fetch("wss://8.8.8.8/", { method: "GET", body: undefined, headers: [] }, AbortSignal.timeout(2000)),
            (error) => error instanceof GuardBlockedError,
        );
        assert.equal(called, false);
    } finally { globalThis.fetch = orig; }
});

test("Guard.fetch: a redirect INTO private space is re-guarded and refused", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request) =>
        String(u).includes("8.8.8.8")
            ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })
            : new Response("private-body")) as typeof fetch;
    try {
        await assert.rejects(
            Guard.fetch("http://8.8.8.8/", { method: "GET", body: undefined, headers: [] }, AbortSignal.timeout(2000)),
            (e) => e instanceof GuardBlockedError,
        );
    } finally { globalThis.fetch = orig; }
});

test("Guard.fetch: follows only Fetch redirect statuses", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        return new Response(null, { status: 300, headers: { location: "http://1.1.1.1/next" } });
    }) as typeof fetch;
    try {
        const response = await Guard.fetch(
            "http://8.8.8.8/start",
            { method: "GET", body: undefined, headers: [] },
            AbortSignal.timeout(2000),
        );
        assert.equal(response.status, 300);
        assert.equal(calls, 1);
    } finally { globalThis.fetch = orig; }
});

test("Guard.fetch: redirect method, body, and body-header changes follow Fetch", async (t) => {
    const cases = [
        { status: 301, method: "POST", body: "payload", expectedMethod: "GET", expectedBody: undefined, contentType: null },
        { status: 302, method: "PUT", body: "payload", expectedMethod: "PUT", expectedBody: "payload", contentType: "text/plain" },
        { status: 303, method: "HEAD", body: undefined, expectedMethod: "HEAD", expectedBody: undefined, contentType: "text/plain" },
        { status: 303, method: "DELETE", body: "payload", expectedMethod: "GET", expectedBody: undefined, contentType: null },
        { status: 307, method: "POST", body: "payload", expectedMethod: "POST", expectedBody: "payload", contentType: "text/plain" },
    ] as const;
    for (const specimen of cases) {
        await t.test(`${specimen.status} ${specimen.method}`, async () => {
            const orig = globalThis.fetch;
            const seen: Array<{ method?: string; body?: BodyInit | null; headers: Headers }> = [];
            globalThis.fetch = (async (_target, init) => {
                seen.push({ method: init?.method, body: init?.body, headers: new Headers(init?.headers) });
                return seen.length === 1
                    ? new Response(null, { status: specimen.status, headers: { location: "/next" } })
                    : new Response("done");
            }) as typeof fetch;
            try {
                await Guard.fetch(
                    "http://8.8.8.8/start",
                    {
                        method: specimen.method,
                        body: specimen.body,
                        headers: [["Content-Type", "text/plain"], ["Content-Language", "en"], ["X-Trace", "kept"]],
                    },
                    AbortSignal.timeout(2000),
                );
                assert.equal(seen[1]?.method, specimen.expectedMethod);
                assert.equal(seen[1]?.body, specimen.expectedBody);
                assert.equal(seen[1]?.headers.get("content-type"), specimen.contentType);
                assert.equal(seen[1]?.headers.get("content-language"), specimen.contentType === null ? null : "en");
                assert.equal(seen[1]?.headers.get("x-trace"), "kept");
            } finally { globalThis.fetch = orig; }
        });
    }
});

test("Guard.fetch: strips Authorization only after a cross-origin redirect", async () => {
    const run = async (location: string): Promise<Headers> => {
        const orig = globalThis.fetch;
        const seen: Headers[] = [];
        globalThis.fetch = (async (_target, init) => {
            seen.push(new Headers(init?.headers));
            return seen.length === 1
                ? new Response(null, { status: 302, headers: { location } })
                : new Response("done");
        }) as typeof fetch;
        try {
            await Guard.fetch(
                "https://8.8.8.8/start",
                { method: "GET", body: undefined, headers: [["Authorization", "Bearer secret"], ["X-Trace", "kept"]] },
                AbortSignal.timeout(2000),
            );
            return seen[1]!;
        } finally { globalThis.fetch = orig; }
    };

    const sameOrigin = await run("/next");
    assert.equal(sameOrigin.get("authorization"), "Bearer secret");
    const crossOrigin = await run("https://1.1.1.1/next");
    assert.equal(crossOrigin.get("authorization"), null);
    assert.equal(crossOrigin.get("x-trace"), "kept");
});

test("Guard.fetch: cancels a followed redirect response body", async () => {
    const orig = globalThis.fetch;
    let cancelled = false;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        if (calls > 1) return new Response("done");
        const body = new ReadableStream({ cancel() { cancelled = true; } });
        return new Response(body, { status: 302, headers: { location: "/next" } });
    }) as typeof fetch;
    try {
        await Guard.fetch(
            "http://8.8.8.8/start",
            { method: "GET", body: undefined, headers: [] },
            AbortSignal.timeout(2000),
        );
        assert.equal(cancelled, true);
    } finally { globalThis.fetch = orig; }
});
