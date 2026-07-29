import test from "node:test";
import { strict as assert } from "node:assert";
import { authorize, poll, OAuthProblemError } from "./oauth.ts";
import { install } from "./client.ts";
import { serverConfig } from "./config.ts";

const RESOURCE = "https://mcp.test/mcp";
const AS = "https://auth.test";

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rejectedProblem = async (promise: Promise<unknown>): Promise<OAuthProblemError["problem"]> => {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof OAuthProblemError);
        return error.problem;
    }
    assert.fail("Expected OAuth operation to reject.");
};

// AS metadata — `device` toggles the RFC 8628 `device_authorization_endpoint`,
// which the SDK's `z.looseObject` schema preserves though it is untyped.
const asMetadata = (device: boolean): Record<string, unknown> => ({
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    registration_endpoint: `${AS}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    token_endpoint_auth_methods_supported: ["none"],
    ...(device ? { device_authorization_endpoint: `${AS}/device` } : {}),
});

// A mock authorization server driven entirely through the injected fetchFn (no
// network). `tokenQueue` supplies successive `/token` poll responses in order.
const mockFetch = (opts: { device?: boolean; tokenQueue?: Response[] } = {}): typeof fetch => {
    const device = opts.device ?? true;
    const tokenQueue = [...(opts.tokenQueue ?? [])];
    return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (url.includes("oauth-protected-resource")) return json({ resource: RESOURCE, authorization_servers: [AS] });
        if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) return json(asMetadata(device));
        if (url === `${AS}/register`) return json({ client_id: "test-client-id", redirect_uris: [], token_endpoint_auth_method: "none", grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] });
        if (url === `${AS}/device`) return json({ device_code: "dev-code-xyz", user_code: "WDJB-MJHT", verification_uri: `${AS}/device`, verification_uri_complete: `${AS}/device?user_code=WDJB-MJHT`, expires_in: 1800, interval: 5 });
        if (url === `${AS}/token`) return tokenQueue.shift() ?? json({ error: "authorization_pending" }, 400);
        return new Response("not found", { status: 404 });
    }) as typeof fetch;
};

test("authorize: discovery + DCR + device-authorization request → verificationUri + userCode + opaque device blob", async () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    try {
        const r = await authorize("oasrv", { fetchFn: mockFetch() });
        assert.equal(r.verificationUri, `${AS}/device`);
        assert.equal(r.verificationUriComplete, `${AS}/device?user_code=WDJB-MJHT`);
        assert.equal(r.userCode, "WDJB-MJHT");
        assert.equal(r.interval, 5);
        assert.equal(r.expiresIn, 1800);
        assert.equal(r.device.deviceCode, "dev-code-xyz");
        assert.equal(r.device.clientId, "test-client-id");
        assert.equal(r.device.tokenEndpoint, `${AS}/token`);
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.device)), "device is an opaque JSON blob the caller round-trips");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});

test("authorize: an AS with no device_authorization_endpoint returns an exact public problem", async () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    try {
        const problem = await rejectedProblem(authorize("oasrv", { fetchFn: mockFetch({ device: false }) }));
        assert.equal(problem.type, "https://problems.plurnk.dev/executor/mcp/device-grant-unsupported");
        assert.equal(problem.status, 501);
        assert.equal(problem.stage, "discovery");
        assert.equal(problem.retryable, false);
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});

test("poll: authorization_pending → pending, then a granted token → authorized with Bearer headers", async () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    try {
        const fetchFn = mockFetch({ tokenQueue: [
            json({ error: "authorization_pending" }, 400),
            json({ access_token: "tok-abc123", token_type: "Bearer", expires_in: 3600 }),
        ] });
        const { device } = await authorize("oasrv", { fetchFn });
        assert.deepEqual(await poll("oasrv", { device, fetchFn }), { status: "pending" });
        assert.deepEqual(await poll("oasrv", { device, fetchFn }), { status: "authorized", headers: { Authorization: "Bearer tok-abc123" } });
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});

test("poll: slow_down / access_denied / expired_token map to their terminal statuses", async () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    try {
        for (const [error, status] of [["slow_down", "slow_down"], ["access_denied", "denied"], ["expired_token", "expired"]] as const) {
            const fetchFn = mockFetch({ tokenQueue: [json({ error }, 400)] });
            const { device } = await authorize("oasrv", { fetchFn });
            assert.deepEqual(await poll("oasrv", { device, fetchFn }), { status });
        }
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});

test("authorize: a stdio server is rejected with an exact public problem", async () => {
    process.env.PLURNK_EXECS_MCP_STDIOSRV = "node server.mjs";
    try {
        const problem = await rejectedProblem(authorize("stdiosrv", { fetchFn: mockFetch() }));
        assert.equal(problem.type, "https://problems.plurnk.dev/executor/mcp/oauth-transport-unsupported");
        assert.equal(problem.status, 400);
        assert.equal(problem.stage, "configuration");
        assert.equal(problem.retryable, false);
    } finally {
        delete process.env.PLURNK_EXECS_MCP_STDIOSRV;
    }
});

test("authorize: an invalid device response returns a causal public problem", async () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    const fetchFn = mockFetch();
    const invalid = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        if (url === `${AS}/device`) return json({ user_code: "missing-fields" });
        return fetchFn(input, init);
    }) as typeof fetch;
    try {
        const problem = await rejectedProblem(authorize("oasrv", { fetchFn: invalid }));
        assert.equal(problem.type, "https://problems.plurnk.dev/executor/mcp/device-authorization-response-invalid");
        assert.equal(problem.status, 502);
        assert.equal(problem.stage, "authorization");
        assert.equal(problem.retryable, false);
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});

test("poll: incomplete device state returns an exact client-correctable problem", async () => {
    const problem = await rejectedProblem(poll("oasrv", {
        device: { deviceCode: "", clientId: "", tokenEndpoint: "" },
        fetchFn: mockFetch(),
    }));
    assert.equal(problem.type, "https://problems.plurnk.dev/executor/mcp/device-state-invalid");
    assert.equal(problem.status, 400);
    assert.equal(problem.stage, "token-poll");
    assert.equal(problem.retryable, false);
    assert.match(problem.recovery ?? "", /Start a new authorization request/);
});

test("install: overlays the bearer onto an env server's headers and evicts the cached client (#1)", () => {
    process.env.PLURNK_EXECS_MCP_OASRV = RESOURCE;
    try {
        install("oasrv", { Authorization: "Bearer tok-abc123" });
        assert.equal(serverConfig("oasrv")?.headers?.Authorization, "Bearer tok-abc123");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_OASRV;
    }
});
