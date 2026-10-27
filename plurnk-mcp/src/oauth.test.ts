// {§oauth-continuation} {§mcp-host-composition} — OAuth continuation, grant residency, and challenge handling across the MCP workspace adapter.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
    McpServer,
    completable,
    createMcpHandler,
    type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { serveIssuerOAuth, serveOAuthMcp } from "../test/oauth-fixture.ts";
import { context, preparationRequest } from "../test/scheme-fixture.ts";
import { httpServer, stdioServer as stdio } from "../test/definitions.ts";
import {
    harness,
    httpHandler,
    interactiveOAuthFixture,
    oauthDefinition,
    rejectsManagementProblem,
    type Prepared,
} from "../test/module-harness.ts";
import type McpResources from "./McpResources.ts";
import type { OAuthGrantSummary } from "./oauth.ts";
import ServerConnection from "./client.ts";

// {§mcp-host-composition} A server that answers its catalog to anyone and refuses one request kind with HTTP 401 and a
// JSON-RPC result body, as Google's hosted Workspace servers refuse tools/call.
const REQUEST_KINDS = ["tools/call", "resources/read", "prompts/get", "completion/complete"] as const;
type RequestKind = typeof REQUEST_KINDS[number];

const awaitingSignIn: Readonly<Record<RequestKind, string>> = {
    "tools/call": "https://problems.plurnk.xyz/executor/mcp/authorization-required",
    "resources/read": "https://problems.plurnk.xyz/scheme/mcp/authorization-required",
    "prompts/get": "https://problems.plurnk.xyz/scheme/mcp/authorization-required",
    "completion/complete": "https://problems.plurnk.xyz/mcp/management/authorization-required",
};

const challengeHandler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "challenge-fixture", version: "1.0.0" });
    server.registerTool(
        "echo",
        { description: "Echo one message.", inputSchema: z.object({ message: z.string() }) },
        async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
    server.registerResource("note", "test:///note", {}, async () => ({ contents: [{ uri: "test:///note", text: "a note" }] }));
    server.registerPrompt(
        "note",
        { argsSchema: z.object({ topic: completable(z.string(), () => ["alpha"]) }) },
        async ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: topic } }] }),
    );
    return server;
}, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

const serveChallenge = (t: TestContext, refused: RequestKind) => serveMcpHttp(t, challengeHandler(), async (request) => {
    if (request.method !== "POST") return null;
    const body = await request.clone().json().catch(() => null) as { method?: unknown; id?: unknown } | null;
    if (body?.method !== refused) return null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: "Request is missing required authentication credential." }] } }),
        { status: 401, headers: { "content-type": "application/json" } });
});

const callArgs = (runtime: string, target: string, body: string) => ({
    metadata: null, runtime, body, cwd: null, target, signal: new AbortController().signal,
    write: () => {}, setState: () => {}, emit: () => {}, interact: async () => ({ action: "cancel" as const }),
});

// One request of a kind through the alias's published runtime, as the status and Problem type it settles with.
const requestThrough = async (
    h: ReturnType<typeof harness>, alias: string, kind: RequestKind, workspaceId = 1,
): Promise<{ status: number; type?: string | undefined }> => {
    const runtime = h.snapshots.get(workspaceId)?.prepared?.runtimes.find(({ decl }) => decl.name === alias);
    assert.ok(runtime?.availability.available, `${alias} is in service`);
    switch (kind) {
        case "tools/call": {
            const result = await runtime.executor.run(callArgs(alias, "echo", JSON.stringify({ message: "hi" })));
            return { status: result.status, type: result.problem?.type };
        }
        case "resources/read":
        case "prompts/get": {
            const pathname = kind === "resources/read" ? `/resources/${encodeURIComponent("test:///note")}` : "/prompts/note";
            const result = await (runtime.scheme as McpResources).prepareRepresentation(preparationRequest(pathname), context().ctx);
            return { status: result.status, type: result.problem?.type };
        }
        case "completion/complete":
            try {
                await h.action(workspaceId, "workspace.mcp.complete", { server: alias, ref: { type: "ref/prompt", name: "note" }, argument: { name: "topic", value: "a" } });
                return { status: 200 };
            } catch (error) {
                const problem = (error as { problem?: ProblemDetails }).problem;
                return { status: problem?.status ?? 500, type: problem?.type };
            }
    }
};

// The publication after `before`, which a refusal asks for.
const republished = async (h: ReturnType<typeof harness>, before: Prepared | null | undefined): Promise<Prepared | null | undefined> => {
    for (let attempt = 0; attempt < 300 && h.snapshots.get(1)?.prepared === before; attempt += 1) await delay(10);
    return h.snapshots.get(1)?.prepared;
};

test("{§mcp-host-composition} each request kind refused for want of a sign-in fails authorization-required and republishes its alias awaiting one, out of service", async (t) => {
    for (const kind of REQUEST_KINDS) {
        await t.test(kind, async (t) => {
            const served = await serveChallenge(t, kind);
            const h = harness();
            await h.setup();
            try {
                const first = await h.lane(1, new Map([["gmail", httpServer("gmail", served.url)]]));
                assert.equal(first.outcomes.get("gmail")?.state, "active", "its catalog answers without credentials");
                assert.deepEqual(await requestThrough(h, "gmail", kind), { status: 401, type: awaitingSignIn[kind] });
                assert.deepEqual((await republished(h, first))?.outcomes.get("gmail"), { state: "authorization-required", authorization: {} });
                assert.deepEqual(h.inService(1), []);
                assert.deepEqual(h.unavailable(1), [{ name: "gmail", detail: "it awaits the operator's sign-in" }]);
            } finally { await h.teardown(1); await h.module.stop(); }
        });
    }
});

test("{§mcp-host-composition} a configured credential's refused request changes no state and offers no sign-in", async (t) => {
    for (const kind of REQUEST_KINDS) {
        await t.test(kind, async (t) => {
            const served = await serveChallenge(t, kind);
            const definition: McpServerDefinition = { ...httpServer("gmail", served.url), headers: { Authorization: "Bearer fixture" } };
            const h = harness();
            await h.setup();
            try {
                await h.lane(1, new Map([["gmail", definition]]));
                const refused = await requestThrough(h, "gmail", kind);
                assert.notEqual(refused.status, 200);
                assert.ok(refused.type?.endsWith("/authorization-required") !== true, `${kind} fails as its kind fails: ${refused.type}`);
                const again = await h.lane(1, new Map([["gmail", definition]]));
                assert.equal(again.outcomes.get("gmail")?.state, "active");
                assert.deepEqual(h.inService(1), ["gmail"]);
            } finally { await h.teardown(1); await h.module.stop(); }
        });
    }
});

test("{§mcp-host-composition} only a fresh connection answers the awaited sign-in, publishing what it observes", async (t) => {
    const events: Readonly<Record<string, (h: ReturnType<typeof harness>, definition: McpServerDefinition) => Promise<Prepared>>> = {
        "an explicit enable": (h, definition) => h.lane(1, new Map([["gmail", definition]]), { force: "gmail" }),
        "a changed definition": (h, definition) => h.lane(1, new Map([["gmail", { ...definition, headers: { "X-Fixture": "changed" } }]])),
        "removal and return": async (h, definition) => { await h.lane(1, new Map()); return h.lane(1, new Map([["gmail", definition]])); },
        "cooling and return": async (h, definition) => { await h.teardown(1); return h.lane(1, new Map([["gmail", definition]])); },
    };
    for (const [event, apply] of Object.entries(events)) {
        await t.test(event, async (t) => {
            const served = await serveChallenge(t, "tools/call");
            const definition = httpServer("gmail", served.url);
            const h = harness();
            await h.setup();
            try {
                const first = await h.lane(1, new Map([["gmail", definition]]));
                assert.equal((await requestThrough(h, "gmail", "tools/call")).status, 401);
                assert.equal((await republished(h, first))?.outcomes.get("gmail")?.state, "authorization-required");
                const answered = await apply(h, definition);
                assert.equal(answered.outcomes.get("gmail")?.state, "active", "its catalog still answers without credentials");
                assert.deepEqual(h.inService(1), ["gmail"]);
            } finally { await h.teardown(1); await h.module.stop(); }
        });
    }
});

test("{§mcp-host-composition} a signed-in grant that lapses mid-run keeps its alias, awaiting a fresh sign-in", async (t) => {
    const { origin, served, revoke } = await interactiveOAuthFixture(t);
    const definition = httpServer("oauth", served.url);
    const h = harness();
    await h.setup();
    const signIn = async (): Promise<void> => {
        const started = await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { authorization: { url: string } };
        const callback = new URL("http://127.0.0.1:54321/callback");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", new URL(started.authorization.url).searchParams.get("state")!);
        callback.searchParams.set("iss", origin);
        await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: callback.href });
        await h.settleRefreshes();
    };
    try {
        await h.lane(1, new Map([["oauth", definition]]));
        await signIn();
        assert.deepEqual(h.inService(1), ["oauth"]);
        const signedIn = h.snapshots.get(1)?.prepared;
        revoke();
        assert.deepEqual(await requestThrough(h, "oauth", "tools/call"), { status: 401, type: awaitingSignIn["tools/call"] });
        assert.deepEqual((await republished(h, signedIn))?.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
        assert.deepEqual(h.unavailable(1), [{ name: "oauth", detail: "it awaits the operator's sign-in" }], "the alias stays registered");
        await signIn();
        assert.deepEqual(h.inService(1), ["oauth"], "a fresh sign-in answers it");
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

// {§oauth-continuation} The client's sign-in to an alias awaiting one at an authorization server that consents at
// once: begin at the client's callback, the browser's consent, and the callback it returns.
const signInAtIssuer = async (h: ReturnType<typeof harness>, alias: string): Promise<URL> => {
    const started = await h.action(1, "workspace.mcp.oauth.begin", {
        alias, redirectUrl: "http://127.0.0.1:54321/callback",
    }) as { status: number; authorization?: { url: string } };
    assert.equal(started.status, 202);
    assert.ok(started.authorization !== undefined, "the sign-in starts though the connection was never challenged");
    // The browser: the authorization server answers the consent with a redirect to the client's callback.
    const consent = await fetch(started.authorization.url, { redirect: "manual" });
    const callbackUrl = consent.headers.get("location");
    assert.equal(consent.status, 302);
    assert.ok(callbackUrl !== null);
    await h.action(1, "workspace.mcp.oauth.complete", { alias, callbackUrl });
    await h.settleRefreshes();
    return new URL(started.authorization.url);
};

// {§oauth-continuation} A pre-registered client signing in to a server that never challenges its
// catalog and publishes no OAuth metadata, at the issuer its definition names.
const issuerSignIn = async (t: TestContext, authorizationParams?: Readonly<Record<string, string>>) => {
    const client = { id: "plurnk-desktop", secret: "fixture-secret" };
    const servers = await serveIssuerOAuth(t, httpHandler(), client);
    const definition: McpServerDefinition = {
        ...httpServer("calendar", servers.resource),
        authorization: {
            type: "oauth", clientId: client.id, clientSecret: "${FIXTURE_CLIENT_SECRET}", scope: "calendar.readonly", issuer: servers.issuer,
            ...(authorizationParams === undefined ? {} : { authorizationParams }),
        },
    };
    const h = harness({ FIXTURE_CLIENT_SECRET: client.secret });
    await h.setup();
    const first = await h.lane(1, new Map([["calendar", definition]]));
    assert.equal(first.outcomes.get("calendar")?.state, "active", "its catalog answers without credentials");
    assert.equal((await requestThrough(h, "calendar", "tools/call")).status, 401);
    assert.equal((await republished(h, first))?.outcomes.get("calendar")?.state, "authorization-required");
    const url = await signInAtIssuer(h, "calendar");
    assert.deepEqual(h.inService(1), ["calendar"]);
    assert.equal((await requestThrough(h, "calendar", "tools/call")).status, 200, "the grant answers the call");
    return { ...servers, h, definition, url };
};

test("{§oauth-continuation} a sign-in starts at the configured issuer and carries the definition's parameters; its refresh token outlives the access token", async (t) => {
    const { h, url, issuer, authorizations, tokenRequests, expire } = await issuerSignIn(t, { access_type: "offline", prompt: "consent" });
    try {
        assert.equal(url.origin, issuer, "discovery started at the issuer, not the resource");
        assert.equal(url.searchParams.get("access_type"), "offline");
        assert.equal(url.searchParams.get("prompt"), "consent");
        assert.equal(url.searchParams.get("client_id"), "plurnk-desktop");
        assert.equal(url.searchParams.get("scope"), "calendar.readonly");
        assert.equal(authorizations.length, 1);
        expire();
        assert.equal((await requestThrough(h, "calendar", "tools/call")).status, 200, "the refresh token re-acquires an access token");
        assert.deepEqual(tokenRequests.map((request) => request.get("grant_type")), ["authorization_code", "refresh_token"]);
        assert.deepEqual(h.inService(1), ["calendar"]);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§oauth-continuation} without offline access the lapsed grant awaits a fresh sign-in", async (t) => {
    const { h, url, tokenRequests, expire } = await issuerSignIn(t);
    try {
        assert.equal(url.searchParams.get("access_type"), null);
        const signedIn = h.snapshots.get(1)?.prepared;
        expire();
        assert.deepEqual(await requestThrough(h, "calendar", "tools/call"), { status: 401, type: awaitingSignIn["tools/call"] });
        assert.deepEqual((await republished(h, signedIn))?.outcomes.get("calendar"), { state: "authorization-required", authorization: {} });
        assert.deepEqual(tokenRequests.map((request) => request.get("grant_type")), ["authorization_code"]);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

test("{§oauth-continuation} a server that publishes no OAuth metadata, with no issuer named, cannot begin a sign-in", async (t) => {
    const client = { id: "plurnk-desktop", secret: "fixture-secret" };
    const servers = await serveIssuerOAuth(t, httpHandler(), client);
    const definition = httpServer("calendar", servers.resource);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["calendar", definition]]));
        assert.equal((await requestThrough(h, "calendar", "tools/call")).status, 401);
        await republished(h, first);
        const begin = () => h.action(1, "workspace.mcp.oauth.begin", { alias: "calendar", redirectUrl: "http://127.0.0.1:54321/callback" });
        await rejectsManagementProblem(begin, "oauth-metadata-unavailable", 502);
        await assert.rejects(begin, (error: unknown) => {
            assert.match(String((error as { problem?: { recovery?: unknown } }).problem?.recovery), /authorization\.issuer/, "the refusal names the working form");
            return true;
        });
        assert.equal(h.leases(), 0, "the refused attempt holds no residency");
        assert.equal(servers.authorizations.length, 0);
    } finally { await h.teardown(1); await h.module.stop(); }
});

// {§oauth-continuation} An alias signed in once, with what the test does to its grant next.
interface SignedIn {
    readonly h: ReturnType<typeof harness>;
    readonly alias: string;
    readonly definition: McpServerDefinition;
    // What `list` shows of the grant while a connection presents it.
    readonly summary: OAuthGrantSummary;
    // The access token lapses, where the server issued a refresh token that still answers.
    readonly lapse?: () => void;
    // The server refuses the grant from now on, and refuses to refresh it.
    readonly revoke: () => void;
}

// The callback a consenting authorization server returns to the redirect for this authorization request.
const fixtureCallback = (redirectUrl: string, authorizationUrl: string, issuer: string): string => {
    const callback = new URL(redirectUrl);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", new URL(authorizationUrl).searchParams.get("state")!);
    callback.searchParams.set("iss", issuer);
    return callback.href;
};

// {§oauth-continuation} The ways a sign-in reaches a server: one that challenges its catalog, at the callback a client binds or at
// the redirect its definition configures, and one that answers its catalog to anyone and refuses calls, at the issuer its
// definition names with offline access.
const SIGNED_IN: Readonly<Record<string, (t: TestContext) => Promise<SignedIn>>> = {
    "a challenging server at a client's callback": async (t) => {
        const { origin, served, revoke } = await interactiveOAuthFixture(t);
        const definition = httpServer("oauth", served.url);
        const h = harness();
        await h.setup();
        await h.lane(1, new Map([["oauth", definition]]));
        const redirectUrl = "http://127.0.0.1:54321/callback";
        const started = await h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }) as { authorization: { url: string } };
        await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: fixtureCallback(redirectUrl, started.authorization.url, origin) });
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        return { h, alias: "oauth", definition, summary: { issuer: origin, scope: "mcp:read", refreshable: false }, revoke };
    },
    "a challenging server at its configured redirect": async (t) => {
        const { origin, served, revoke } = await interactiveOAuthFixture(t);
        const definition = oauthDefinition(served);
        const h = harness();
        await h.setup();
        const first = await h.lane(1, new Map([["oauth", definition]]));
        const { url } = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization;
        await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: fixtureCallback(`${origin}/callback`, url, origin) });
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        return { h, alias: "oauth", definition, summary: { issuer: origin, scope: "mcp:read", refreshable: false }, revoke };
    },
    "a server refusing calls at its named issuer": async (t) => {
        const { h, definition, issuer, expire, revoke } = await issuerSignIn(t, { access_type: "offline" });
        return { h, alias: "calendar", definition, summary: { issuer, refreshable: true }, lapse: expire, revoke };
    },
};

// {§oauth-continuation} The events that open a fresh connection for an alias once it is signed in, and whether that connection
// presents the grant; each returns the workspace the connection serves.
const FRESH_CONNECTIONS: Readonly<Record<string, { readonly presents: boolean; readonly open: (signedIn: SignedIn) => Promise<number> }>> = {
    "cooling and return": { presents: true, open: async ({ h, alias, definition }) => {
        await h.teardown(1);
        await h.lane(1, new Map([[alias, definition]]));
        return 1;
    } },
    "an explicit enable": { presents: true, open: async ({ h, alias, definition }) => {
        await h.lane(1, new Map([[alias, definition]]), { force: alias });
        return 1;
    } },
    "disable and return": { presents: true, open: async ({ h, alias, definition }) => {
        await h.lane(1, new Map());
        await h.lane(1, new Map([[alias, definition]]));
        return 1;
    } },
    "a changed definition": { presents: false, open: async ({ h, alias, definition }) => {
        await h.lane(1, new Map([[alias, { ...definition, headers: { "X-Fixture": "changed" } }]]));
        return 1;
    } },
    "another workspace": { presents: false, open: async ({ h, alias, definition }) => {
        await h.lane(2, new Map([[alias, definition]]));
        return 2;
    } },
};

// Whether the alias serves a tool call in the workspace: in service, and its call answered.
const answersCall = async (h: ReturnType<typeof harness>, alias: string, workspaceId: number): Promise<boolean> =>
    h.inService(workspaceId).includes(alias) && (await requestThrough(h, alias, "tools/call", workspaceId)).status === 200;

// The grant the alias's published outcome lists in the workspace.
const listedGrant = (h: ReturnType<typeof harness>, alias: string, workspaceId: number): OAuthGrantSummary | undefined => {
    const outcome = h.snapshots.get(workspaceId)?.prepared?.outcomes.get(alias);
    return outcome?.state === "active" ? outcome.detail?.grant : undefined;
};

const settle = async (h: ReturnType<typeof harness>): Promise<void> => {
    for (const workspaceId of [1, 2]) await h.teardown(workspaceId).catch(() => undefined);
    await h.module.stop();
};

test("{§oauth-continuation} an accepted sign-in outlives its connection: each later connection with its definition presents it and lists its summary, and no other", async (t) => {
    for (const [server, signIn] of Object.entries(SIGNED_IN)) {
        for (const [event, { presents, open }] of Object.entries(FRESH_CONNECTIONS)) {
            await t.test(`{§oauth-continuation} ${server}: ${event}`, async (t) => {
                const signedIn = await signIn(t);
                try {
                    assert.deepEqual(listedGrant(signedIn.h, signedIn.alias, 1), signedIn.summary, "the accepted sign-in lists its grant");
                    const workspaceId = await open(signedIn);
                    assert.deepEqual(listedGrant(signedIn.h, signedIn.alias, workspaceId), presents ? signedIn.summary : undefined);
                    // A presented grant refreshes its lapsed access token, where the server issued a refresh token.
                    signedIn.lapse?.();
                    assert.equal(await answersCall(signedIn.h, signedIn.alias, workspaceId), presents);
                } finally { await settle(signedIn.h); }
            });
        }
    }
});

test("{§oauth-continuation} a carried grant its server refuses starts a sign-in only at a redirect its definition configures", async (t) => {
    for (const [server, signIn] of Object.entries(SIGNED_IN)) {
        await t.test(server, async (t) => {
            const { h, alias, definition, revoke } = await signIn(t);
            try {
                await h.teardown(1);
                revoke();
                let prepared = await h.lane(1, new Map([[alias, definition]]));
                if (prepared.outcomes.get(alias)?.state === "active") {
                    assert.equal((await requestThrough(h, alias, "tools/call")).status, 401);
                    prepared = (await republished(h, prepared))!;
                    await h.settleRefreshes();
                }
                const outcome = prepared.outcomes.get(alias) as { state: string; authorization: { url?: string } };
                assert.equal(outcome.state, "authorization-required");
                const configured = definition.type === "streamable-http" && definition.authorization?.type === "oauth"
                    ? definition.authorization.redirectUrl : undefined;
                if (configured === undefined) {
                    assert.deepEqual(outcome.authorization, {}, "no client waits at the redirect the grant was accepted at");
                    assert.equal(h.leases(), 0);
                } else {
                    assert.equal(new URL(outcome.authorization.url!).searchParams.get("redirect_uri"), configured);
                    assert.equal(h.leases(), 1, "the sign-in it starts holds the workspace");
                }
            } finally { await settle(h); }
        });
    }
});

test("{§oauth-continuation} a grant ends when its authorization server rejects it, and the next accepted sign-in replaces it", async (t) => {
    const { h, definition, issuer, revoke, tokenRequests, authorizations } = await issuerSignIn(t, { access_type: "offline" });
    const call = async (): Promise<number> => (await requestThrough(h, "calendar", "tools/call")).status;
    const coolAndReturn = async (): Promise<Prepared> => {
        await h.teardown(1);
        return h.lane(1, new Map([["calendar", definition]]));
    };
    try {
        const returned = await coolAndReturn();
        revoke();
        assert.equal(await call(), 401, "the refused refresh answers no call");
        await republished(h, returned);
        await h.settleRefreshes();
        assert.deepEqual(tokenRequests.map((request) => request.get("grant_type")), ["authorization_code", "refresh_token"]);
        const ended = await coolAndReturn();
        assert.equal(listedGrant(h, "calendar", 1), undefined, "the ended grant is not listed");
        assert.equal(await call(), 401);
        assert.equal(tokenRequests.length, 2, "the ended grant is neither presented nor refreshed");
        await republished(h, ended);
        await h.settleRefreshes();
        await signInAtIssuer(h, "calendar");
        assert.deepEqual(listedGrant(h, "calendar", 1), { issuer, refreshable: true }, "the new grant is listed");
        assert.equal(await call(), 200);
        await coolAndReturn();
        assert.equal(await call(), 200, "the new grant is carried");
        assert.equal(authorizations.length, 2);
    } finally { await settle(h); }
});

test("{§mcp-module} OAuth fixture denies missing, wrong, and replayed grants instead of rewarding sign-in bypass", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const token = (body: string) => fetch(`${origin}/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    for (const body of ["", "grant_type=client_credentials", "grant_type=authorization_code&code=wrong"]) {
        const response = await token(body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "invalid_grant");
    }
    const guessed = await fetch(served.url, { headers: { Authorization: "Bearer access-token" } });
    assert.equal(guessed.status, 401);
    await guessed.text();
    const grant = "grant_type=authorization_code&code=fixture-code";
    const accepted = await token(grant);
    assert.equal(accepted.status, 200);
    const credentials = await accepted.json();
    assert.equal(typeof credentials.access_token, "string");
    assert.notEqual(credentials.access_token, "access-token");
    const replay = await token(grant);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
});

test("{§oauth-continuation} a URL-only server hands authorization to the client without changing its definition", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const definition = httpServer("oauth", served.url);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", definition]]));
        assert.deepEqual(prepared.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
        assert.equal(h.leases(), 0, "no pending browser attempt before the client begins");
        assert.deepEqual(h.inService(1), []);
        assert.deepEqual(h.unavailable(1), [{ name: "oauth", detail: "it awaits the operator's sign-in" }],
            "{§mcp-configuration} the server keeps its alias, and a call to it names the sign-in it awaits");
        const started = await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { status: number; authorization: { url: string } };
        assert.equal(started.status, 202);
        const url = new URL(started.authorization.url);
        assert.equal(h.snapshots.get(1)?.prepared, prepared, "starting sign-in does not publish or enable capabilities");
        assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:54321/callback");
        assert.equal(h.leases(), 1);
        const callback = new URL("http://127.0.0.1:54321/callback");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("iss", origin);
        await h.lane(1, new Map([["oauth", definition]]));
        assert.equal(h.leases(), 1, "an unchanged publication cannot discard the client's independent sign-in attempt");
        const completed = await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: callback.href }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.deepEqual(h.snapshots.get(1)?.enabled.get("oauth"), definition, "the client callback is session state, not configuration");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} a callback replayed once the grant is published, before its commit, is no longer pending", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const definition = httpServer("oauth", served.url);
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["oauth", definition]]));
        const started = await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { authorization: { url: string } };
        const callback = new URL("http://127.0.0.1:54321/callback");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", new URL(started.authorization.url).searchParams.get("state")!);
        callback.searchParams.set("iss", origin);
        const complete = () => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: callback.href });
        assert.deepEqual(await complete(), { status: 202, alias: "oauth" });
        assert.deepEqual(await complete(), { status: 202, alias: "oauth" }, "an accepted, unpublished grant shares its acceptance");
        let between = 0;
        h.hooks.between = async () => {
            between++;
            await rejectsManagementProblem(complete, "oauth-not-pending", 404);
        };
        await h.settleRefreshes();
        assert.equal(between, 1, "the publication ran once");
        assert.deepEqual(h.inService(1), ["oauth"]);
        assert.equal(h.leases(), 0, "the consumed candidate's lease is released at commit");
        await rejectsManagementProblem(complete, "oauth-not-pending", 404);
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} beginning sign-in can discover usable tools without publishing into a held workspace", async (t) => {
    let challenged = true;
    const served = await serveMcpHttp(t, httpHandler(), () => challenged ? new Response("unauthorized", { status: 401 }) : null);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = httpServer("oauth", served.url);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        assert.equal(initial.outcomes.get("oauth")?.state, "authorization-required");
        challenged = false;
        const begin = () => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        });
        assert.deepEqual(await begin(), { status: 202, alias: "oauth" });
        assert.deepEqual(await begin(), { status: 202, alias: "oauth" });
        assert.equal(h.refreshes(), 1);
        assert.equal(h.leases(), 1);
        assert.equal(h.snapshots.get(1)?.prepared, initial);
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.deepEqual(await begin(), { status: 200, alias: "oauth" });
    } finally { release.resolve(); await h.module.stop(); }
});

for (const [option, code] of [["metadata", "oauth-metadata-unavailable"], ["registration", "oauth-registration-unavailable"]] as const) {
    test(`{§oauth-continuation} missing OAuth ${option} is a setup diagnostic, not retryable downtime`, async (t) => {
        const { served } = await serveOAuthMcp(t, httpHandler(), { [option]: false });
        const h = harness();
        await h.setup();
        try {
            const definition = httpServer("oauth", served.url);
            await h.lane(1, new Map([["oauth", definition]]));
            await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
                alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
            }), code, 502);
            assert.equal(h.leases(), 0, "failed setup leaves no pending credential flow");
            assert.deepEqual(h.snapshots.get(1)?.prepared?.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
            assert.deepEqual(h.snapshots.get(1)?.enabled.get("oauth"), definition, "the inspectable definition survives failed sign-in setup");
        } finally { await h.module.stop(); }
    });
}

test("{§oauth-continuation} rejected explicit credentials are not reported as retryable downtime", async (t) => {
    const { served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", {
            ...httpServer("oauth", served.url), headers: { Authorization: "Bearer wrong-token" },
        }]]));
        const outcome = prepared.outcomes.get("oauth");
        assert.equal(outcome?.state, "unavailable");
        assert.equal((outcome as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-authentication-failed");
        assert.equal((outcome as { problem: ProblemDetails }).problem.retryable, false);
        assert.doesNotMatch(JSON.stringify(outcome), /wrong-token/);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }), "oauth-configuration-conflict", 409);
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} client callbacks cannot replace fixed redirects or target nonlocal HTTP", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const count = served.requests.length;
        for (const redirectUrl of ["http://example.test/callback", "file:///callback", "http://127.0.0.1:0/callback", "https://user:secret@example.test/callback"]) {
            await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }), "oauth-redirect-invalid", 400);
        }
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: `${origin}/different`,
        }), "oauth-configuration-conflict", 409);
        assert.equal(served.requests.length, count, "invalid callbacks cause no remote traffic");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} a later client attempt invalidates the old callback and publishes only the new one", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    const redirectUrl = "http://127.0.0.1:54321/callback";
    try {
        await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        const begin = async () => {
            const result = await h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }) as { authorization: { url: string } };
            const url = new URL(redirectUrl);
            url.searchParams.set("state", new URL(result.authorization.url).searchParams.get("state")!);
            url.searchParams.set("code", "fixture-code");
            url.searchParams.set("iss", origin);
            return url.href;
        };
        const stale = await begin();
        const current = await begin();
        assert.notEqual(stale, current);
        assert.equal(h.leases(), 1);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: stale }), "oauth-callback-invalid", 400);
        await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: current });
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: current }), "oauth-not-pending", 404);
        const ready = await h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }) as { status: number };
        assert.equal(ready.status, 200, "an already active connection is not replaced");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} removal during client preparation prevents a late authorization publication", async (t) => {
    const { served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const environment = h.seam.readWorkspaceEnvironment;
        h.seam.readWorkspaceEnvironment = async () => { entered.resolve(); await release.promise; return environment(); };
        const start = { alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback" };
        const result = rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", start), "oauth-target-conflict", 409);
        await entered.promise;
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", start), "oauth-busy", 409);
        await h.lane(1, new Map());
        release.resolve();
        await result;
        assert.deepEqual(h.inService(1), []);
        assert.equal(h.leases(), 0);
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} an accepted OAuth callback holds residency until ordinary catalog publication", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const outcome = prepared.outcomes.get("oauth");
        assert.equal(outcome?.state, "authorization-required");
        assert.deepEqual(h.inService(1), [], "a challenged server is not in service");
        assert.equal(h.leases(), 1, "the pending authorization holds one residency lease");
        await assert.rejects(() => h.teardown(1), /cannot cool with pending OAuth residency/);
        const state = new URL((outcome as { authorization: { url: string } }).authorization.url).searchParams.get("state");
        assert.ok(state);
        const completed = await h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"], "the authorized server is published through catalog refresh");
        assert.equal(h.leases(), 0, "the pending lease was released on publication");
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=x&state=y` }), "oauth-not-pending", 404);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

for (const change of ["none", "withdraw", "replace"] as const) {
test(`{§oauth-continuation} accepted callbacks are coalesced, the held workspace keeps the alias as published, and publication respects ${change}`, { timeout: 10000 }, async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = oauthDefinition(served);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        const outcome = initial.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        const params = { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` };
        const complete = () => h.action(1, "workspace.mcp.oauth.complete", params);
        const accepted = { status: 202, alias: "oauth" };
        assert.deepEqual(await Promise.all([complete(), complete()]), [accepted, accepted]);
        assert.equal(tokenRequests.length, 1, "one grant exchange for concurrent callbacks");
        assert.deepEqual(h.inService(1), [], "the callback does not bypass publication");
        assert.deepEqual(h.unavailable(1), [{ name: "oauth", detail: "it awaits the operator's sign-in" }], "a call is refused as published");
        assert.equal(h.snapshots.get(1)?.prepared, initial, "list reports the published snapshot");
        assert.equal(h.refreshes(), 1, "duplicate callbacks do not schedule duplicate publication");
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: `${origin}/callback`,
        }), accepted, "beginning again cannot replace a grant already awaiting publication");
        if (change === "withdraw") await h.lane(1, new Map());
        if (change === "replace") await h.lane(1, new Map([["oauth", { ...definition, headers: { "X-Replacement": "1" } }]]));
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), change === "none" ? ["oauth"] : []);
        if (change === "none") assert.deepEqual(listedGrant(h, "oauth", 1), { issuer: origin, scope: "mcp:read", refreshable: false }, "the publication lists the grant");
        assert.equal(h.leases(), change === "replace" ? 1 : 0);
        assert.equal(tokenRequests.length, 1, "publication never replays the grant");
        if (change !== "none") {
            assert.equal(h.snapshots.get(1)?.prepared?.outcomes.get("oauth")?.state,
                change === "replace" ? "authorization-required" : undefined, "old acceptance cannot restore or authorize the replacement");
        }
    } finally { release.resolve(); await h.module.stop(); }
});
}

test("{§oauth-continuation} failed preparation after an accepted grant publishes its diagnostic and closes the candidate", async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    const close = t.mock.method(ServerConnection.prototype, "close");
    const errors = t.mock.method(console, "error", () => {});
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const outcome = prepared.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }), { status: 202, alias: "oauth" });
        h.environment.PLURNK_MCP_oauth_TOOLS = "not json";
        release.resolve();
        await h.settleRefreshes();
        const unavailable = h.snapshots.get(1)?.prepared?.outcomes.get("oauth");
        assert.equal(unavailable?.state, "unavailable");
        assert.equal((unavailable as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-settings-invalid");
        assert.equal(errors.mock.callCount(), 1, "the preparation failure remains visible");
        assert.equal(h.leases(), 0);
        assert.deepEqual(h.inService(1), []);
        assert.equal(close.mock.callCount(), 1, "the unpublishable authorized candidate is closed, not orphaned");
        assert.equal(tokenRequests.length, 1);
    } finally { release.resolve(); await h.module.stop(); }
});

test("{§oauth-continuation} aborting publication retains the accepted grant for the next preparation", async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = oauthDefinition(served);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        const outcome = initial.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        const params = { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` };
        const accepted = { status: 202, alias: "oauth" };
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", params), accepted);
        const attempt = await h.adapter().prepare({
            signal: new AbortController().signal,
            ...h.identity(1), enabled: new Map([["oauth", { definition }]]), previous: initial.snapshot,
            failure: "publish-unavailable", admissions: [], retain: () => () => {}, progress: () => {},
        });
        assert.equal(attempt.outcomes.get("oauth")?.state, "active");
        await attempt.abort();
        assert.equal(h.leases(), 1);
        assert.deepEqual(h.inService(1), []);
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", params), accepted);
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.equal(tokenRequests.length, 1, "a discarded capability publication never replays the authorization code");
    } finally { release.resolve(); await h.module.stop(); }
});

test("{§oauth-continuation} withdrawing a server with a pending authorization clears the attempt and releases its residency", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const url = (prepared.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        assert.equal(h.leases(), 1);
        await h.lane(1, new Map());
        assert.equal(h.leases(), 0, "the withdrawn alias's pending attempt released its lease");
        const state = new URL(url).searchParams.get("state")!;
        await rejectsManagementProblem(
            () => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` }),
            "oauth-not-pending", 404,
        );
        await h.teardown(1);
    } finally { await h.module.stop(); }
});

for (const authorize of [false, true]) test(`{§oauth-continuation} a fresh module restores definitions but not ${authorize ? "accepted credentials" : "pending sign-in"}`, async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const definition = httpServer("oauth", served.url);
    const definitions = new Map([["oauth", definition]]);
    const original = harness();
    await original.setup();
    let callbackUrl: string;
    try {
        await original.lane(1, definitions);
        const started = await original.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { authorization: { url: string } };
        const callback = new URL("http://127.0.0.1:54321/callback");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", new URL(started.authorization.url).searchParams.get("state")!);
        callback.searchParams.set("iss", origin);
        callbackUrl = callback.href;
        if (authorize) {
            await original.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl });
            await original.settleRefreshes();
            assert.deepEqual(original.inService(1), ["oauth"]);
        } else {
            assert.equal(original.leases(), 1);
        }
        assert.deepEqual(original.snapshots.get(1)?.enabled.get("oauth"), definition, "neither a callback nor credentials enter the stored definition");
    } finally { await original.module.stop(); }
    assert.equal(original.leases(), 0);

    const restored = harness();
    await restored.setup();
    try {
        const prepared = await restored.lane(1, definitions);
        assert.deepEqual(prepared.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
        assert.deepEqual(restored.inService(1), []);
        await rejectsManagementProblem(() => restored.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth", callbackUrl,
        }), "oauth-not-pending", 404);
        const restarted = await restored.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { status: number; authorization: { url: string } };
        assert.equal(restarted.status, 202);
        assert.notEqual(new URL(restarted.authorization.url).searchParams.get("state"), new URL(callbackUrl).searchParams.get("state"));
    } finally { await restored.module.stop(); }
});

test("{§oauth-continuation} a superseded authorization attempt cannot complete a replacement, and a changed target conflicts", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        // The definition changes underneath the pending authorization: the new
        // challenge supersedes the old one and holds the single lease.
        const changed = { ...oauthDefinition(served), headers: { "X-Changed": "1" } };
        await h.lane(1, new Map([["oauth", changed]]));
        assert.equal(h.leases(), 1, "the superseded attempt released its lease; the replacement holds one");
        const staleState = new URL(firstUrl).searchParams.get("state")!;
        await rejectsManagementProblem(
            () => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(staleState)}&iss=${encodeURIComponent(origin)}` }),
            "oauth-callback-invalid", 400,
        );
        // A committed attachment that no longer matches the pending definition conflicts.
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", oauthDefinition(served)]]));
        assert.equal(h.leases(), 1);
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", oauthDefinition(served)]]), { force: "oauth" });
        const replacementState = new URL((h.snapshots.get(1)!.prepared!.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url).searchParams.get("state")!;
        const completed = await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(replacementState)}&iss=${encodeURIComponent(origin)}` }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.inService(1), ["echo", "oauth"]);
        assert.equal(h.leases(), 0);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

test("{§oauth-continuation} a replacement without authorization discards the pending credential flow", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        const replacement = await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        assert.deepEqual(replacement.outcomes.get("oauth"), { state: "authorization-required", authorization: {} },
            "the replacement sees the challenge but does not inherit the pending authorization URL");
        assert.equal(h.leases(), 0, "a superseded flow cannot retain the workspace");
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(new URL(firstUrl).searchParams.get("state")!)}`,
        }), "oauth-not-pending", 404);
    } finally { await h.module.stop(); }
});
