import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialAuthority } from "./Application.ts";
import {
    admitBearerRequest,
    admitBrowserOrigin,
    buildCorsHeaders,
    isLoopbackHost,
    parseScopedRoute,
    requestOrigin,
    resolvePublicOrigin,
} from "./HttpOrigin.ts";

const makeAuthority = (resourceOrigin: string | null): CredentialAuthority => {
    const verify = async (token: string) => {
        if (token === "valid-jwt") {
            return {
                subject: "auth0|507f1f77",
                handle: "alice",
                name: "Alice Smith",
                email: "alice@example.com",
                scopes: ["openid", "profile", "email"],
                expiresAt: 9_999_999_999_999,
            };
        }
        if (token === "delegate-jwt") {
            return {
                subject: "plurnkbot",
                scopes: ["openid"],
                expiresAt: 9_999_999_999_999,
                canDelegateActor: true,
            };
        }
        return null;
    };
    return {
        verify,
        publish: () => {},
        face: () => (resourceOrigin === null ? null : { issuer: () => resourceOrigin, verify }),
    };
};

test("{§credential-authority} {§http-host} admitBearerRequest admits unconfigured authorities and verifies header, WebSocket subprotocol, and query tokens when active", async () => {
    const unconfigured = makeAuthority(null);
    assert.deepEqual(await admitBearerRequest(unconfigured, { headers: {} }), {
        ok: true,
        subject: null,
    });

    const active = makeAuthority("https://plurnk.example.com");

    const missing = await admitBearerRequest(active, { headers: {} }, { domain: "acp:http", codePrefix: "acp/http" });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
        assert.equal(
            missing.challenge,
            'Bearer realm="plurnk", resource_metadata="https://plurnk.example.com/.well-known/oauth-protected-resource"',
        );
        assert.equal(missing.problem.status, 401);
        assert.equal(missing.problem.code, "acp/http/bearer-token-required");
    }

    const invalid = await admitBearerRequest(
        active,
        { headers: { authorization: "Bearer expired-jwt" } },
        { domain: "acp:http", codePrefix: "acp/http" },
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
        assert.match(invalid.challenge, /error="invalid_token"/u);
        assert.equal(invalid.problem.status, 401);
        assert.equal(invalid.problem.code, "acp/http/bearer-token-invalid");
    }

    assert.deepEqual(
        await admitBearerRequest(active, { headers: { authorization: "Bearer valid-jwt" } }),
        { ok: true, subject: "auth0|507f1f77", handle: "alice", name: "Alice Smith" },
    );
    assert.deepEqual(
        await admitBearerRequest(
            active,
            { headers: { "sec-websocket-protocol": "acp, bearer.valid-jwt" }, url: "/acp" },
            { allowQueryToken: true },
        ),
        { ok: true, subject: "auth0|507f1f77", handle: "alice", name: "Alice Smith" },
    );
    assert.deepEqual(
        await admitBearerRequest(
            active,
            { headers: {}, url: "/acp?access_token=valid-jwt" },
            { allowQueryToken: true },
        ),
        { ok: true, subject: "auth0|507f1f77", handle: "alice", name: "Alice Smith" },
    );
    assert.deepEqual(
        await admitBearerRequest(active, { headers: { authorization: "Bearer delegate-jwt" } }),
        { ok: true, subject: "plurnkbot", canDelegateActor: true },
    );
});

test("{§http-host} admitBrowserOrigin blocks cross-site CSRF, cross-site WebSockets, and loopback DNS rebinding while admitting CLI, same-origin, proxied, and CORS-allowed callers", () => {
    const loopback = { host: "127.0.0.1", port: 1066 };

    // CLI / non-browser callers have neither Origin nor Sec-Fetch-* and pass through.
    assert.deepEqual(admitBrowserOrigin({ headers: { host: "127.0.0.1:1066" } }, { allowOrigin: "", listener: loopback }), { ok: true });

    // Localhost / 127.0.0.1 same-origin browser requests pass.
    assert.deepEqual(
        admitBrowserOrigin(
            { headers: { host: "localhost:1066", origin: "http://localhost:1066", "sec-fetch-site": "same-origin" } },
            { allowOrigin: "", listener: loopback },
        ),
        { ok: true },
    );

    // Reverse-proxied same-origin browser requests (carrying X-Forwarded-Proto/For) pass.
    assert.deepEqual(
        admitBrowserOrigin(
            {
                headers: {
                    host: "plurnk.example.com",
                    origin: "https://plurnk.example.com",
                    "sec-fetch-site": "same-origin",
                    "x-forwarded-proto": "https",
                },
            },
            { allowOrigin: "", listener: loopback },
        ),
        { ok: true },
    );

    // Cross-site browser drive-by (CVE-2025-49596 class) is rejected 403.
    const crossSite = admitBrowserOrigin(
        { headers: { host: "127.0.0.1:1066", origin: "https://evil.example", "sec-fetch-site": "cross-site" } },
        { allowOrigin: "", listener: loopback, domain: "acp:http", codePrefix: "acp/http" },
    );
    assert.equal(crossSite.ok, false);
    if (!crossSite.ok) assert.equal(crossSite.problem.code, "acp/http/cross-origin-forbidden");

    // DNS-rebinding browser attack (evil.example:1066 directly to 127.0.0.1:1066 with no proxy headers) is rejected 403.
    const dnsRebind = admitBrowserOrigin(
        { headers: { host: "evil.example:1066", origin: "http://evil.example:1066", "sec-fetch-site": "same-origin" } },
        { allowOrigin: "", listener: loopback, domain: "acp:http", codePrefix: "acp/http" },
    );
    assert.equal(dnsRebind.ok, false);
    if (!dnsRebind.ok) assert.equal(dnsRebind.problem.code, "acp/http/host-not-allowed");

    // Explicit allowOrigin admits matching cross-origin PLURNK_ACP_URL web host and rejects others.
    assert.deepEqual(
        admitBrowserOrigin(
            { headers: { host: "127.0.0.1:1066", origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" } },
            { allowOrigin: "http://127.0.0.1:5173", listener: loopback },
        ),
        { ok: true },
    );
    assert.equal(
        admitBrowserOrigin(
            { headers: { host: "127.0.0.1:1066", origin: "https://evil.example", "sec-fetch-site": "cross-site" } },
            { allowOrigin: "http://127.0.0.1:5173", listener: loopback },
        ).ok,
        false,
    );
});

test("{§http-admission} isLoopbackHost, resolvePublicOrigin, buildCorsHeaders, and parseScopedRoute handle proxies, CORS, and scoped paths", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackHost("example.com"), false);
    assert.equal(isLoopbackHost(undefined), false);

    const loopback = { host: "127.0.0.1", port: 1066 };
    assert.equal(requestOrigin({ headers: {} }, { host: "::1", port: 1066 }), "http://[::1]:1066");
    assert.equal(resolvePublicOrigin(undefined, { host: "0.0.0.0", port: 1066 }), "http://127.0.0.1:1066");
    assert.equal(
        resolvePublicOrigin(
            {
                headers: {
                    host: "127.0.0.1:1066",
                    "x-forwarded-proto": "https",
                    "x-forwarded-host": "plurnk.example.com",
                },
            },
            loopback,
        ),
        "https://plurnk.example.com",
    );
    assert.equal(
        resolvePublicOrigin(
            { headers: { host: "local.dev" } },
            loopback,
        ),
        "http://local.dev:1066",
    );
    assert.equal(
        resolvePublicOrigin(
            { headers: { host: "127.0.0.1:1066" } },
            loopback,
            makeAuthority("https://configured.example.com"),
        ),
        "https://configured.example.com",
    );

    assert.deepEqual(
        buildCorsHeaders("", { methods: "GET", allowHeaders: "authorization" }),
        {},
    );
    assert.deepEqual(
        buildCorsHeaders("https://app.example", {
            methods: "GET, POST",
            allowHeaders: "*",
            exposeHeaders: "Mcp-Session-Id",
            requestHeaders: "authorization, mcp-param-foo",
        }),
        {
            "access-control-allow-origin": "https://app.example",
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "authorization, mcp-param-foo",
            "access-control-expose-headers": "Mcp-Session-Id",
        },
    );

    assert.deepEqual(
        parseScopedRoute("/mcp", { mount: "/mcp", domain: "mcp:http", codePrefix: "mcp/http" }),
        { ok: true },
    );
    assert.deepEqual(
        parseScopedRoute("/mcp/ws%201/main/", { mount: "/mcp", domain: "mcp:http", codePrefix: "mcp/http" }),
        { ok: true, workspaceSegment: "ws 1", sessionSegment: "main" },
    );
    assert.equal(
        parseScopedRoute("/other", { mount: "/mcp", domain: "mcp:http" }).ok,
        false,
    );
    assert.equal(
        parseScopedRoute("/mcp/a/b/c", { mount: "/mcp", domain: "mcp:http" }).ok,
        false,
    );
    assert.equal(
        parseScopedRoute("/mcp/%E0%A4%A", { mount: "/mcp", domain: "mcp:http" }).ok,
        false,
    );
    assert.equal(
        parseScopedRoute("/notifications/%20", {
            mount: "/notifications",
            domain: "daemon:notifications",
            emptySegmentDetail: "Empty segment.",
        }).ok,
        false,
    );
});
