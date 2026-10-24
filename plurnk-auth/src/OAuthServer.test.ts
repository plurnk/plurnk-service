// {§auth-oauth} — the authorization server on the daemon's listener, driven over HTTP exactly as a
// client would: discovery, the operator's sign-in and code exchange with PKCE, client credentials,
// refresh rotation, revocation, registration, and session management.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { authorizationDocumentSpecimens } from "./AuthorizationDocuments.ts";
import Module, { type AuthPort, type AuthSetupSeam, type ModuleOptions } from "./Module.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { requestBody } from "../../scripts/lib/test-fetch.ts";

const { default: Credentials } = await import("../../plurnk-core/src/server/Credentials.ts") as { default: new (options?: { readonly operatorSecret?: string | null }) => ApplicationPort["credentials"] };
const { default: HttpListener } = await import("../../plurnk-core/src/server/HttpListener.ts") as {
    default: {
        bind(options: { readonly host: string; readonly port: number }): Promise<{
            httpAddress(): { readonly host: string; readonly port: number };
            registerHttpRoute: ApplicationPort["registerHttpRoute"];
            admit(): void;
            close(): Promise<void>;
        }>;
    };
};
type Authority = ApplicationPort["credentials"];

const FLOOR = {
    PLURNK_AUTH: "1", PLURNK_PASS: "lovelace", PLURNK_AUTH_ISSUER: "",
    PLURNK_AUTH_ACCESS_TTL_SEC: "3600", PLURNK_AUTH_REFRESH_TTL_SEC: "2592000",
    PLURNK_AUTH_ALLOW_ORIGIN: "*",
};

interface Hosted {
    readonly module: Module;
    readonly base: string;
    readonly credentials: Authority;
    close(): Promise<void>;
}

const boot = async (
    env: Record<string, string> = {}, options: Omit<ModuleOptions, "env"> = {}, operatorSecret: string | null = "s3cret",
    setup: (credentials: Authority) => void = () => {},
): Promise<Hosted> => {
    const credentials = new Credentials({ operatorSecret });
    setup(credentials);
    const mod = Module.create({ env: { ...FLOOR, ...env }, ...options });
    const http = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        mod.setup({ credentials, httpAddress: () => http.httpAddress() });
        mod.start({ credentials, httpAddress: () => http.httpAddress(), registerHttpRoute: (prefix, handler) => http.registerHttpRoute(prefix, handler) } satisfies AuthPort);
        http.admit();
    } catch (error) {
        await mod.close().catch(() => {});
        await http.close().catch(() => {});
        throw error;
    }
    const { port } = http.httpAddress();
    return {
        module: mod,
        base: `http://127.0.0.1:${port}`,
        credentials,
        close: async () => {
            mod.stop();
            await mod.close();
            await http.close();
        },
    };
};

const form = (fields: Record<string, string>): RequestInit => ({
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
});
const basic = (id: string, secret: string): Record<string, string> =>
    ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}` });
const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => await response.json() as T;
const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const admitted = (mod: Hosted, token: string, scope = "acp"): void => {
    const claims = mod.credentials.verify(token);
    assert.ok(claims !== null && claims.kind === "access" && claims.scopes.includes(scope), `expected live access token for ${scope}`);
};
const rejected = (mod: Hosted, token: string): void => {
    const claims = mod.credentials.verify(token);
    assert.ok(claims === null || claims.kind !== "access", "expected token not to verify as an access token");
};

const register = async (base: string, redirect: string, extra: Record<string, unknown> = {}): Promise<{ client_id: string }> => {
    const response = await fetch(`${base}/oauth/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: "Witness", ...extra }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text) as { client_id: string };
};

// Signs in through the authorization endpoint as a browser would and returns the code it was redirected with.
const signIn = async (base: string, query: Record<string, string>, password: string): Promise<Response> => {
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query).toString()}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<form method="post" action="\/oauth\/authorize">/u);
    for (const [name, value] of Object.entries(query)) {
        assert.ok(html.includes(`name="${name}" value="${value.replaceAll("&", "&amp;")}"`), `the form carries ${name}`);
    }
    return fetch(`${base}/oauth/authorize`, { ...form({ ...query, password }), redirect: "manual" });
};

test("{§auth-oauth-endpoints} discovery names the issuer's endpoints, grants and PKCE method, and the resource names its authorization server", async () => {
    const mod = await boot();
    try {
        assert.deepEqual([...mod.module.mounts], ["/oauth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]);
        const metadata = await fetch(`${mod.base}/.well-known/oauth-authorization-server`);
        assert.equal(metadata.headers.get("cache-control"), "no-store");
        assert.deepEqual(await json(metadata), {
            issuer: mod.base,
            authorization_endpoint: `${mod.base}/oauth/authorize`,
            token_endpoint: `${mod.base}/oauth/token`,
            revocation_endpoint: `${mod.base}/oauth/revoke`,
            registration_endpoint: `${mod.base}/oauth/register`,
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["acp", "a2a"],
        });
        assert.deepEqual(await json(await fetch(`${mod.base}/.well-known/oauth-protected-resource`)), {
            resource: mod.base, authorization_servers: [mod.base], scopes_supported: ["acp", "a2a"], bearer_methods_supported: ["header"], resource_name: "Plurnk",
        });
        const preflight = await fetch(`${mod.base}/oauth/token`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*", "a page may read the token endpoint's answer");
        assert.equal((await fetch(`${mod.base}/oauth/nothing`)).status, 404);
        assert.equal((await fetch(`${mod.base}/oauth/token`)).status, 405, "the token endpoint is POST");
    } finally { await mod.close(); }
});

test("{§auth-oauth-endpoints} a configured issuer names the public origin a proxy serves", async () => {
    const mod = await boot({ PLURNK_AUTH_ISSUER: "https://plurnk.example" });
    try {
        const metadata = await json(await fetch(`${mod.base}/.well-known/oauth-authorization-server`));
        assert.equal(metadata.token_endpoint, "https://plurnk.example/oauth/token");
        assert.equal(mod.credentials.face()?.issuer(), "https://plurnk.example");
    } finally { await mod.close(); }
});

test("{§auth-oauth-clients} the operator's secret is a client secret: client_credentials, by Basic or by post, mints an access token", async () => {
    const mod = await boot({ PLURNK_AUTH_ACCESS_TTL_SEC: "1" });
    try {
        for (const init of [
            { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "s3cret") } },
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "acp", resource: `${mod.base}/acp` }),
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "a2a", resource: `${mod.base}/a2a` }),
        ]) {
            const response = await fetch(`${mod.base}/oauth/token`, init);
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = JSON.parse(text) as { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string };
            assert.equal(body.token_type, "Bearer");
            assert.equal(body.expires_in, 1);
            const bodyText = requestBody(init);
            const expectedScope = bodyText.includes("scope=acp") ? "acp" : bodyText.includes("scope=a2a") ? "a2a" : "acp a2a";
            assert.equal(body.scope, expectedScope, "the operator holds every scope; a request may narrow");
            assert.equal(body.refresh_token, undefined, "client credentials renew with the secret, not a refresh token");
            admitted(mod, body.access_token, expectedScope.split(" ")[0]);
        }
        rejected(mod, "s3cret");
        const minted = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })));
        admitted(mod, minted.access_token);
        await sleep(1_100);
        rejected(mod, minted.access_token);
        const wrong = await fetch(`${mod.base}/oauth/token`, { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "nope") } });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.headers.get("www-authenticate"), 'Basic realm="plurnk"');
        assert.equal((await json(wrong)).error, "invalid_client");
        const unknown = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "nobody", client_secret: "x" }));
        assert.equal(unknown.status, 401);
        assert.equal(unknown.headers.get("www-authenticate"), null, "no Basic challenge for a client that posted its credentials");
        const unsupported = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "password", client_id: "operator", client_secret: "s3cret", password: "lovelace" }));
        assert.equal(unsupported.status, 400);
        assert.equal((await json(unsupported)).error, "unsupported_grant_type", "RFC 9700: no password grant");
        const scope = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "root" }));
        assert.equal((await json(scope)).error, "invalid_scope");
    } finally { await mod.close(); }
});

test("{§auth-oauth-login} authorization code with PKCE: a registered public client, the operator's sign-in, the code and its one exchange", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        assert.match(client_id, /^[A-Za-z0-9_-]{43}$/u);
        const { verifier, challenge } = pkce();
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz&1", scope: "acp" };
        const wrong = await signIn(mod.base, query, "wrong");
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /The password is wrong\./u);
        const code = async (): Promise<string> => {
            const redirected = await signIn(mod.base, query, "lovelace");
            assert.equal(redirected.status, 302);
            const location = new URL(redirected.headers.get("location")!);
            assert.equal(`${location.origin}${location.pathname}`, redirect);
            assert.equal(location.searchParams.get("state"), "xyz&1");
            const issued = location.searchParams.get("code")!;
            assert.match(issued, /^[A-Za-z0-9_-]{43}$/u);
            return issued;
        };
        const exchange = (fields: Record<string, string>): Promise<Response> =>
            fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, redirect_uri: redirect, code_verifier: verifier, ...fields }));
        // A code is presented once, whatever the outcome: a wrong verifier or redirect spends it.
        const spent = await code();
        assert.equal((await json(await exchange({ code: spent, code_verifier: randomBytes(32).toString("base64url") }))).error, "invalid_grant", "a wrong verifier is refused");
        assert.equal((await json(await exchange({ code: spent }))).error, "invalid_grant", "and spent the code");
        assert.equal((await json(await exchange({ code: await code(), redirect_uri: "http://127.0.0.1:4000/other" }))).error, "invalid_grant", "a code is bound to its redirect");
        const granted = await exchange({ code: await code() });
        const grantedText = await granted.text();
        assert.equal(granted.status, 200, grantedText);
        const tokens = JSON.parse(grantedText) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
        assert.equal(tokens.scope, "acp");
        assert.ok(tokens.refresh_token.length > 0, "a code grant renews through a refresh token");
        admitted(mod, tokens.access_token);
        const twice = await code();
        assert.equal((await exchange({ code: twice })).status, 200);
        assert.equal((await json(await exchange({ code: twice }))).error, "invalid_grant", "a code is exchanged once");
        admitted(mod, tokens.access_token);
    } finally { await mod.close(); }
});

test("{§auth-oauth-login} a bad client or redirect is told to the person; a malformed request is redirected as an error", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { challenge } = pkce();
        const refusal = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id: "stranger", redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }).toString()}`);
        assert.equal(refusal.status, 400);
        assert.match(await refusal.text(), /not registered with this daemon/u);
        const elsewhere = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:4000/elsewhere", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }).toString()}`);
        assert.equal(elsewhere.status, 400, "a redirect the client did not register is never followed");
        const loopbackPort = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:5555/callback", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }).toString()}`);
        assert.equal(loopbackPort.status, 200, "RFC 8252: a loopback redirect may change its port");
        for (const [query, error] of [
            [{ response_type: "token", code_challenge: challenge, code_challenge_method: "S256" }, "unsupported_response_type"],
            [{ response_type: "code" }, "invalid_request"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "plain" }, "invalid_request"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "root" }, "invalid_scope"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://elsewhere.example/acp" }, "invalid_target"],
        ] as const) {
            const response = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: redirect, state: "s", ...query }).toString()}`, { redirect: "manual" });
            assert.equal(response.status, 302, JSON.stringify(query));
            const location = new URL(response.headers.get("location")!);
            assert.equal(location.searchParams.get("error"), error);
            assert.equal(location.searchParams.get("state"), "s");
        }
        const bad = await fetch(`${mod.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_post" }) });
        assert.equal(bad.status, 400);
        assert.equal((await json(bad)).error, "invalid_client_metadata", "a confidential client is declared, never registered");
        assert.equal((await json(await fetch(`${mod.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["not a url"] }) }))).error, "invalid_redirect_uri");
    } finally { await mod.close(); }
});

test("{§auth-oauth-tokens} a refresh token rotates on every use, narrows but never widens, and its reuse revokes the family", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { verifier, challenge } = pkce();
        const redirected = await signIn(mod.base, { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }, "lovelace");
        const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
        const first = await json<{ access_token: string; refresh_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier })));
        const refresh = (token: string, extra: Record<string, string> = {}): Promise<Response> =>
            fetch(`${mod.base}/oauth/token`, form({ grant_type: "refresh_token", client_id, refresh_token: token, ...extra }));
        assert.equal((await json(await refresh(first.refresh_token, { scope: "acp root" }))).error, "invalid_scope");
        const second = await json<{ access_token: string; refresh_token: string }>(await refresh(first.refresh_token));
        assert.notEqual(second.refresh_token, first.refresh_token, "rotated");
        admitted(mod, first.access_token);
        admitted(mod, second.access_token);
        const reused = await refresh(first.refresh_token);
        assert.equal(reused.status, 400);
        assert.equal((await json(reused)).error, "invalid_grant");
        for (const token of [first.access_token, second.access_token]) {
            rejected(mod, token);
        }
        assert.equal((await json(await refresh(second.refresh_token))).error, "invalid_grant", "including the rotated refresh token");
        const other = await json<{ refresh_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code: "stale", redirect_uri: redirect, code_verifier: verifier })));
        assert.equal(other.refresh_token, undefined);
    } finally { await mod.close(); }
});

test("{§auth-oauth-revocation} revocation is by family and by the owning client; a stranger's revocation changes nothing; grants are independent", async () => {
    const mod = await boot({ PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["acp"] }) });
    try {
        const mintOperator = async (): Promise<string> => (await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })))).access_token;
        const one = await mintOperator();
        const two = await mintOperator();
        const agent = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "agent", client_secret: "agent-secret" })));
        admitted(mod, agent.access_token);
        const stranger = await fetch(`${mod.base}/oauth/revoke`, form({ token: one, client_id: "agent", client_secret: "agent-secret" }));
        assert.equal(stranger.status, 200, "RFC 7009: an unowned token revokes nothing and still answers 200");
        admitted(mod, one);
        const revoked = await fetch(`${mod.base}/oauth/revoke`, form({ token: one, client_id: "operator", client_secret: "s3cret" }));
        assert.equal(revoked.status, 200);
        rejected(mod, one);
        admitted(mod, two);
        admitted(mod, agent.access_token);
        assert.equal((await fetch(`${mod.base}/oauth/revoke`, form({ token: "unknown", client_id: "operator", client_secret: "s3cret" }))).status, 200);
        assert.equal((await json(await fetch(`${mod.base}/oauth/revoke`, form({ client_id: "operator", client_secret: "s3cret" })))).error, "invalid_request");
        const asPublic = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: (await register(mod.base, "http://127.0.0.1:1/cb")).client_id }));
        assert.equal((await json(asPublic)).error, "unauthorized_client", "a public client holds nothing to present");
    } finally { await mod.close(); }
});

test("{§auth-oauth} under PLURNK_AUTH=0 the module claims no mounts and publishes no face", async () => {
    const mod = await boot({ PLURNK_AUTH: "0" }, {}, null);
    try {
        assert.deepEqual([...mod.module.mounts], []);
        assert.equal(mod.credentials.face(), null, "no face is published");
    } finally { await mod.close(); }
});

test("{§auth-oauth} an authority without an operator secret still authenticates: the code flow is the way in, and the face is published", async () => {
    const mod = await boot({}, {}, null);
    try {
        assert.equal(mod.module.mounts.length, 3);
        assert.equal(mod.credentials.face()?.issuer({ headers: { host: new URL(mod.base).host } }), mod.base);
        const asOperator = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "" }));
        assert.equal(asOperator.status, 401);
        assert.equal((await json(asOperator)).error, "invalid_client", "no secret, no operator client");
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { verifier, challenge } = pkce();
        const redirected = await signIn(mod.base, { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }, "lovelace");
        assert.equal(redirected.status, 302);
        const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
        const tokens = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier })));
        admitted(mod, tokens.access_token);
    } finally { await mod.close(); }
});

test("{§credential-authority} {§http-request-origin} the face answers its issuer from publication, before the module starts: the configured one, else the address the request reached, else the listener's", async () => {
    for (const [issuer, viaLan, unnamed] of [
        ["", "http://192.168.1.88:1066", "http://127.0.0.1:4321"],
        ["https://plurnk.example", "https://plurnk.example", "https://plurnk.example"],
    ] as const) {
        const credentials = new Credentials({ operatorSecret: "s3cret" });
        const setup: AuthSetupSeam = { credentials, httpAddress: () => ({ host: "127.0.0.1", port: 4321 }) };
        Module.create({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: issuer } }).setup(setup);
        assert.deepEqual([credentials.face()?.issuer({ headers: { host: "192.168.1.88:1066" } }), credentials.face()?.issuer({ headers: {} }), credentials.face()?.issuer()],
            [viaLan, unnamed, unnamed], "a request's address, else the listener's, as for a module asking at its start");
    }
});

// A request to the listener at `base` naming `hostHeader`, as a browser that reached the daemon by that name sends it.
const hosted = (base: string, path: string, hostHeader: string): Promise<{ readonly status: number; readonly body: string }> => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = httpRequest({ host: hostname, port, path, method: "GET", headers: { host: hostHeader } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
});

const sessionOf = (response: Response): string => {
    const match = /plurnk_session=([^;]+)/u.exec(response.headers.get("set-cookie") ?? "");
    assert.ok(match, `no session cookie: ${response.headers.get("set-cookie")}`);
    return match[1];
};

test("{§auth-oauth-session} a browser is the operator only once it signs in: the sign-in sets the session, a module's own client is then authorized silently, and a session is never a bearer", async () => {
    let secret = "";
    const mod = await boot({}, {}, "s3cret", (credentials) => {
        secret = credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["acp"] }).clientSecret;
    });
    try {
        const redirect = `${mod.base}/web/callback`;
        const client_id = "web";
        const { verifier, challenge } = pkce();
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: "acp" };
        const before = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual" });
        assert.equal(before.status, 200, "a browser on the daemon's own host meets the sign-in form too");
        assert.match(await before.text(), /Sign in to Plurnk/u);
        assert.equal(before.headers.get("set-cookie"), null, "and is given no session");
        const first = await fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "lovelace" }), redirect: "manual" });
        assert.equal(first.status, 302, await first.text());
        assert.match(first.headers.get("set-cookie") ?? "", /^plurnk_session=[A-Za-z0-9_-]{43}; Path=\/oauth; Max-Age=2592000; HttpOnly; SameSite=Lax$/u);
        const session = sessionOf(first);
        const location = new URL(first.headers.get("location")!);
        assert.equal(`${location.origin}${location.pathname}`, redirect);
        assert.equal(location.searchParams.get("state"), "s");
        const tokens = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`,
            form({ grant_type: "authorization_code", client_id, client_secret: secret, redirect_uri: redirect, code_verifier: verifier, code: location.searchParams.get("code")! })));
        admitted(mod, tokens.access_token);
        rejected(mod, session);
        const again = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${session}` } });
        assert.equal(again.status, 302);
        assert.equal(again.headers.get("set-cookie"), null, "a standing session is kept, not replaced");
        const standing = await fetch(`${mod.base}/oauth/session`, { headers: { cookie: `plurnk_session=${session}` } });
        assert.match(await standing.text(), /Signed in/u);
        const ended = await fetch(`${mod.base}/oauth/session`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `plurnk_session=${session}` }, body: "action=end" });
        assert.equal(ended.status, 200);
        assert.match(ended.headers.get("set-cookie") ?? "", /^plurnk_session=; Path=\/oauth; Max-Age=0; HttpOnly; SameSite=Lax$/u);
        assert.match(await (await fetch(`${mod.base}/oauth/session`, { headers: { cookie: `plurnk_session=${session}` } })).text(), /Not signed in/u, "signing out revokes the session");
    } finally { await mod.close(); }
});

test("{§auth-oauth-session} a client elsewhere is shown consent: allowing with the session issues the code, denying redirects access_denied, and a POST without the session issues nothing", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { challenge } = pkce();
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: "acp" };
        const signed = await fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "lovelace" }), redirect: "manual" });
        assert.equal(signed.status, 302, "signing in is the operator's own act and issues at once");
        const session = sessionOf(signed);
        const page = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${session}` } });
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Allow access\?/u);
        assert.match(html, /name="consent" value="allow"/u);
        assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
        const decide = (consent: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${mod.base}/oauth/authorize`, {
            method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ ...query, consent }).toString(),
        });
        const allowed = await decide("allow", { cookie: `plurnk_session=${session}` });
        assert.equal(allowed.status, 302);
        assert.match(new URL(allowed.headers.get("location")!).searchParams.get("code") ?? "", /^[A-Za-z0-9_-]{43}$/u);
        const denied = await decide("deny", { cookie: `plurnk_session=${session}` });
        assert.equal(denied.status, 302);
        assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
        const crossSite = await decide("allow");
        assert.equal(crossSite.status, 200, "a POST carrying no session is shown the sign-in form, never a code");
        assert.match(await crossSite.text(), /Sign in to Plurnk/u);
    } finally { await mod.close(); }
});

test("{§http-request-origin} {§auth-oauth-endpoints} the authorization server answers at whatever address a request reached it by; a configured issuer is the one answer", async () => {
    const mod = await boot();
    try {
        for (const named of ["192.168.1.88:1066", "desktop.lan:1066", "localhost:1066"]) {
            const metadata = JSON.parse((await hosted(mod.base, "/.well-known/oauth-authorization-server", named)).body) as { issuer: string; token_endpoint: string };
            assert.deepEqual([metadata.issuer, metadata.token_endpoint], [`http://${named}`, `http://${named}/oauth/token`]);
            const resource = JSON.parse((await hosted(mod.base, "/.well-known/oauth-protected-resource", named)).body) as { resource: string; authorization_servers: string[] };
            assert.deepEqual([resource.resource, resource.authorization_servers], [`http://${named}`, [`http://${named}`]]);
            assert.equal((await hosted(mod.base, "/oauth/session", named)).status, 200, `a browser that reached ${named} is served`);
        }
    } finally { await mod.close(); }
    const fronted = await boot({ PLURNK_AUTH_ISSUER: "https://plurnk.example" });
    try {
        for (const named of ["plurnk.example", "192.168.1.88:1066"]) {
            assert.equal((JSON.parse((await hosted(fronted.base, "/.well-known/oauth-authorization-server", named)).body) as { issuer: string }).issuer, "https://plurnk.example");
        }
    } finally { await fronted.close(); }
});

test("{§auth-oauth-session} no browser is the operator without the password: the empty password is named with the file to set it in, at 503, with no session; client credentials are unaffected", async () => {
    for (const [env, heading, named] of [
        [{ PLURNK_PASS: "" }, /<h1><span role="img" aria-label="Warning">⚠<\/span> No password is set<\/h1>/u, /<code>PLURNK_PASS<\/code> is empty/u],
    ] as const) {
        const mod = await boot(env, {}, "s3cret", (credentials) => { credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["acp"] }); });
        try {
            const query = { client_id: "web", redirect_uri: `${mod.base}/web/callback`, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "acp" };
            for (const attempt of [
                () => fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual" }),
                () => fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "" }), redirect: "manual" }),
            ]) {
                const page = await attempt();
                assert.equal(page.status, 503, JSON.stringify(env));
                const html = await page.text();
                assert.match(html, heading);
                assert.match(html, named);
                assert.match(html, /<code>~\/\.config\/plurnk\/\.env<\/code>/u, "where to set it");
                assert.equal(page.headers.get("set-cookie"), null, "no session");
            }
            const minted = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })));
            admitted(mod, minted.access_token);
        } finally { await mod.close(); }
    }
});

test("{§auth-oauth-login} the password selects no account: whatever password signed them in, the browser's grants name the same operator", async () => {
    const subjects: string[] = [];
    for (const password of ["lovelace", "babbage"]) {
        const mod = await boot({ PLURNK_PASS: password });
        try {
            const redirect = "http://127.0.0.1:4000/callback";
            const { client_id } = await register(mod.base, redirect);
            const { verifier, challenge } = pkce();
            const redirected = await signIn(mod.base, { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }, password);
            const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
            const tokens = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier })));
            subjects.push(mod.credentials.verify(tokens.access_token)!.subject);
        } finally { await mod.close(); }
    }
    assert.equal(subjects[0], subjects[1], "a new password changes who can sign in, never who they are");
});

test("{§auth-oauth-documents} every document is a main article under a header heading, with no script, no class and a label for every visible control", () => {
    const specimens = authorizationDocumentSpecimens();
    assert.ok(specimens.length >= 8);
    for (const body of specimens) {
        assert.match(body, /^<main><article><header><h1>/u, body);
        assert.doesNotMatch(body, /<script|\sclass=/u, body);
        for (const [input] of body.matchAll(/<input [^>]*>/gu)) {
            if (input.startsWith('<input type="hidden"')) continue;
            const id = /\bid="([^"]+)"/u.exec(input)?.[1];
            assert.ok(id !== undefined && body.includes(`<label for="${id}">`), `${input} is named by a label`);
        }
    }
});

test("{§auth-oauth-documents} a module client's registered stylesheet replaces the standalone style on its pages; any other client, or none, gets the standalone page", async () => {
    for (const password of ["lovelace", ""]) {
        const mod = await boot({ PLURNK_PASS: password }, {}, "s3cret", (credentials) => {
            credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["acp"], stylesheetPath: "/web/assets/authority.css" });
            credentials.registerClient({ id: "plain", redirectPaths: ["/plain/callback"], scopes: ["acp"] });
        });
        try {
            const authorize = (client: string): Promise<Response> => fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({
                client_id: client, redirect_uri: `${mod.base}/${client}/callback`, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "acp",
            }).toString()}`, { redirect: "manual" });
            const styled = async (response: Response): Promise<boolean> => {
                const html = await response.text();
                const linked = html.includes('<link rel="stylesheet" href="/web/assets/authority.css">');
                assert.equal(html.includes("<style>"), !linked, "the registered stylesheet replaces the standalone style, never overrides it");
                assert.match(response.headers.get("content-security-policy")!, linked ? /style-src 'self';/u : /style-src 'unsafe-inline';/u);
                return linked;
            };
            assert.equal(await styled(await authorize("web")), true, `the module's own page (${password === "" ? "no password" : "sign-in"})`);
            assert.equal(await styled(await authorize("plain")), false, "a module client that registered none");
            assert.equal(await styled(await authorize("nobody")), false, "an unknown client's refusal");
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session?client_id=web`)), true, "the session page names the client it is shown for");
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session?client_id=nobody`)), false);
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session`)), false);
        } finally { await mod.close(); }
    }
});

// {§auth-oauth-clients} {§credential-module-client} — a daemon module's own confidential client (#1119):
// the token-mediating backend of RFC 10017 §6.2 authenticates at the token endpoint and brings PKCE.
const moduleBoot = async (env: Record<string, string> = {}, scopes: readonly string[] = ["acp"]) => {
    let secret = "";
    const mod = await boot(env, {}, "s3cret", (credentials) => {
        secret = credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes }).clientSecret;
    });
    const redirect = `${env.PLURNK_AUTH_ISSUER || mod.base}/web/callback`;
    let session = "";
    const authorize = async (extra: Record<string, string> = {}): Promise<{ readonly response: Response; readonly verifier: string; readonly cookie: string }> => {
        const { verifier, challenge } = pkce();
        const query = { client_id: "web", redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "acp", state: "s", ...extra };
        const response = session === ""
            ? await fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "lovelace" }), redirect: "manual" })
            : await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${session}` } });
        session = /plurnk_session=([^;]+)/u.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? session;
        return { response, verifier, cookie: session };
    };
    const code = async (): Promise<{ readonly code: string; readonly verifier: string }> => {
        const { response, verifier } = await authorize();
        assert.equal(response.status, 302, await response.text());
        return { code: new URL(response.headers.get("location")!).searchParams.get("code")!, verifier };
    };
    return { mod, redirect, secret: () => secret, authorize, code, session: () => session };
};

test("{§auth-oauth-clients} a module's own client authorizes with PKCE, exchanges the code with its secret, rotates its refresh token and revokes its grant", async () => {
    const { mod, redirect, secret, code } = await moduleBoot();
    try {
        const first = await code();
        const exchange = (fields: Record<string, string>, headers: Record<string, string> = basic("web", secret())): Promise<Response> => fetch(`${mod.base}/oauth/token`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString(),
        });
        const granted = await exchange({ grant_type: "authorization_code", code: first.code, redirect_uri: redirect, code_verifier: first.verifier });
        const grantedText = await granted.text();
        assert.equal(granted.status, 200, grantedText);
        const tokens = JSON.parse(grantedText) as { access_token: string; refresh_token: string; scope: string };
        assert.equal(tokens.scope, "acp");
        admitted(mod, tokens.access_token);
        assert.equal(mod.credentials.verify(tokens.access_token)?.subject, "operator", "the token names the operator who authorized, never the module");
        assert.equal(mod.credentials.verify(tokens.access_token)?.clientId, "web");
        const unauthenticated = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "web" }, {});
        assert.equal(unauthenticated.status, 401);
        assert.equal((await json(unauthenticated)).error, "invalid_client");
        const renewed = await json<{ access_token: string; refresh_token: string }>(await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
        assert.notEqual(renewed.refresh_token, tokens.refresh_token, "the refresh token rotates");
        admitted(mod, renewed.access_token);
        const second = await code();
        assert.equal((await exchange({ grant_type: "authorization_code", client_id: "web", client_secret: secret(), code: second.code, redirect_uri: redirect, code_verifier: second.verifier }, {})).status, 200);
        const revoked = await fetch(`${mod.base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...basic("web", secret()) }, body: new URLSearchParams({ token: renewed.refresh_token }).toString() });
        assert.equal(revoked.status, 200);
        rejected(mod, renewed.access_token);
    } finally { await mod.close(); }
});

test("{§auth-oauth-clients} a module's client is refused without its secret, with a wrong one, off its redirect, without PKCE, and for client_credentials", async () => {
    const { mod, redirect, secret, code, authorize } = await moduleBoot();
    try {
        const post = (fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> => fetch(`${mod.base}/oauth/token`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString(),
        });
        for (const [label, fields, headers] of [
            ["no secret", { client_id: "web" }, {}],
            ["a wrong secret by post", { client_id: "web", client_secret: "wrong" }, {}],
            ["a wrong secret by Basic", {}, basic("web", "wrong")],
            ["the operator's secret", {}, basic("web", "s3cret")],
        ] as const) {
            const attempt = await code();
            const response = await post({ grant_type: "authorization_code", code: attempt.code, redirect_uri: redirect, code_verifier: attempt.verifier, ...fields }, headers);
            assert.equal(response.status, 401, label);
            assert.equal((await json(response)).error, "invalid_client", label);
        }
        for (const [label, redirect_uri] of [
            ["a path the module did not register", `${mod.base}/other`],
            ["its path on another loopback port", `http://127.0.0.1:1/web/callback`],
            ["its path on another host", "http://elsewhere.example/web/callback"],
            ["its path with a query", `${redirect}?next=1`],
        ] as const) {
            assert.equal((await authorize({ redirect_uri })).response.status, 400, `${label} is never followed`);
        }
        const bare = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id: "web", redirect_uri: redirect, response_type: "code", state: "s" }).toString()}`, { redirect: "manual" });
        assert.equal(new URL(bare.headers.get("location")!).searchParams.get("error"), "invalid_request", "PKCE is required of a confidential client too");
        const own = await post({ grant_type: "client_credentials", scope: "acp" }, basic("web", secret()));
        assert.equal(own.status, 400);
        assert.deepEqual(await json(own), { error: "unauthorized_client", error_description: "A module's client obtains tokens through the operator's authorization." });
        const wide = await authorize({ scope: "a2a" });
        assert.equal(new URL(wide.response.headers.get("location")!).searchParams.get("error"), "invalid_scope", "a scope the module did not register");
    } finally { await mod.close(); }
});

test("{§credential-module-client} a module's redirect is its path on the issuer: the address the request reached by default, the configured public origin when one is set", async () => {
    const local = await moduleBoot();
    try {
        assert.equal(local.redirect, `${local.mod.base}/web/callback`);
        assert.ok((await local.code()).code, "answered at its path on the address the request reached");
        const { challenge } = pkce();
        const authorizeAt = (named: string, redirect_uri: string) => hosted(local.mod.base, `/oauth/authorize?${new URLSearchParams({
            client_id: "web", redirect_uri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "acp", state: "s",
        }).toString()}`, named);
        assert.equal((await authorizeAt("192.168.1.88:1066", "http://192.168.1.88:1066/web/callback")).status, 200, "a browser on the LAN is asked to sign in");
        assert.equal((await authorizeAt(new URL(local.mod.base).host, "http://192.168.1.88:1066/web/callback")).status, 400,
            "the module's address is on the origin the request reached, not another");
    } finally { await local.mod.close(); }
    const fronted = await moduleBoot({ PLURNK_AUTH_ISSUER: "https://plurnk.example" });
    try {
        const { response } = await fronted.authorize();
        assert.equal(response.status, 302, await response.text());
        const location = new URL(response.headers.get("location")!);
        assert.equal(`${location.origin}${location.pathname}`, "https://plurnk.example/web/callback");
        assert.equal((await fronted.authorize({ redirect_uri: `${fronted.mod.base}/web/callback` })).response.status, 400,
            "under a configured issuer no other origin is the module's address");
    } finally { await fronted.mod.close(); }
});

const moduleSignIn = async (m: Awaited<ReturnType<typeof moduleBoot>>) => {
    const { verifier, challenge } = pkce();
    const query = { client_id: "web", redirect_uri: m.redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "acp", state: "s" };
    const response = await fetch(`${m.mod.base}/oauth/authorize`, { ...form({ ...query, password: "lovelace" }), redirect: "manual" });
    if (response.status !== 302) assert.fail(`${response.status}: ${await response.text()}`);
    const cookie = sessionOf(response);
    const exchanged = await fetch(`${m.mod.base}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...basic("web", m.secret()) },
        body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(response.headers.get("location")!).searchParams.get("code")!, redirect_uri: m.redirect, code_verifier: verifier }).toString(),
    });
    const text = await exchanged.text();
    assert.equal(exchanged.status, 200, text);
    return { cookie, query, verifier, ...(JSON.parse(text) as { access_token: string; refresh_token: string }) };
};
const visit = (base: string, query: Record<string, string>, cookie: string): Promise<Response> =>
    fetch(`${base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });

test("{§auth-oauth-session} a module's grant joins the browser's sign-in: one family, listed once without a token, and ended from either side", async () => {
    const m = await moduleBoot();
    const { credentials, base } = m.mod;
    try {
        const first = await moduleSignIn(m);
        const family = credentials.verify(first.cookie)!.family;
        assert.equal(credentials.verify(first.access_token)?.family, family, "the access token is of the sign-in's family");
        assert.equal(credentials.verify(first.refresh_token)?.family, family, "and so is the refresh token");
        const listed = credentials.sessions("operator");
        assert.deepEqual(listed.map((session) => [session.family, session.clients]), [[family, ["browser", "web"]]]);
        assert.ok(![first.cookie, first.access_token, first.refresh_token].some((token) => JSON.stringify(listed).includes(token)), "no token is listed");

        // Ended at the authorization server: the module's credentials end with the sign-in.
        const ended = await fetch(`${base}/oauth/session`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `plurnk_session=${first.cookie}` }, body: "action=end" });
        assert.equal(ended.status, 200);
        rejected(m.mod, first.access_token);
        const renewal = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...basic("web", m.secret()) }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token }).toString() });
        assert.equal((await json(renewal)).error, "invalid_grant");
        assert.deepEqual(credentials.sessions("operator"), []);

        // Ended by the module, as its own sign-out does: the browser's standing at the server ends with it.
        const second = await moduleSignIn(m);
        assert.notEqual(credentials.verify(second.cookie)!.family, family, "a new sign-in is a new family");
        credentials.revokeFamily(credentials.verify(second.access_token)!.family);
        assert.match(await (await fetch(`${base}/oauth/session`, { headers: { cookie: `plurnk_session=${second.cookie}` } })).text(), /Not signed in/u);
    } finally { await m.mod.close(); }
});

test("{§auth-oauth-session} a sign-out stays signed out: the next visit meets the sign-in form and is given no session", async () => {
    const m = await moduleBoot();
    try {
        const { credentials, base } = m.mod;
        const signed = await moduleSignIn(m);
        assert.equal((await visit(base, signed.query, signed.cookie)).status, 302, "while signed in, the module's client is authorized silently");
        credentials.revokeFamily(credentials.verify(signed.access_token)!.family);
        const after = await visit(base, signed.query, signed.cookie);
        assert.equal(after.status, 200, "the next visit is not authorized");
        assert.match(await after.text(), /Sign in to Plurnk/u);
        assert.equal(after.headers.get("set-cookie"), null, "and is given no session");
    } finally { await m.mod.close(); }
});

test("{§auth-oauth-session} only a module's grant joins the sign-in: a consented client keeps its own grant, another browser its own sign-in, and a code not yet exchanged ends with its sign-in", async () => {
    const m = await moduleBoot();
    const { credentials, base } = m.mod;
    try {
        const here = await moduleSignIn(m);
        const there = await moduleSignIn(m);
        const family = credentials.verify(here.cookie)!.family;
        assert.equal(credentials.sessions("operator").length, 2, "two browsers, two sign-ins");

        // A registered public client the operator allows from this browser.
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(base, redirect);
        const { verifier, challenge } = pkce();
        const allowed = await fetch(`${base}/oauth/authorize`, {
            method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `plurnk_session=${here.cookie}` },
            body: new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "acp", consent: "allow" }).toString(),
        });
        if (allowed.status !== 302) assert.fail(`${allowed.status}: ${await allowed.text()}`);
        const terminal = await json<{ access_token: string }>(await fetch(`${base}/oauth/token`,
            form({ grant_type: "authorization_code", client_id, code: new URL(allowed.headers.get("location")!).searchParams.get("code")!, redirect_uri: redirect, code_verifier: verifier })));
        assert.notEqual(credentials.verify(terminal.access_token)?.family, family, "a consented client's grant is a family of its own");
        assert.deepEqual(credentials.sessions("operator").find((session) => session.family === family)?.clients, ["browser", "web"], "and is no part of the sign-in");

        // A code this browser was given and has not exchanged.
        const pending = await visit(base, here.query, here.cookie);
        assert.equal(pending.status, 302);
        credentials.revokeFamily(family);
        const late = await fetch(`${base}/oauth/token`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...basic("web", m.secret()) },
            body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(pending.headers.get("location")!).searchParams.get("code")!, redirect_uri: m.redirect, code_verifier: here.verifier }).toString(),
        });
        assert.equal((await json(late)).error, "invalid_grant", "a sign-in ended before the exchange issues nothing");
        admitted(m.mod, terminal.access_token);
        admitted(m.mod, there.access_token);
        assert.deepEqual(credentials.sessions("operator").map((session) => session.family), [credentials.verify(there.cookie)!.family]);
    } finally { await m.mod.close(); }
});

test("{§auth-oauth-session} silence is for a module's own client: a registered public client is shown consent even when its redirect is on this daemon's origin", async () => {
    const { mod, code, session } = await moduleBoot();
    try {
        await code();
        const sameOrigin = `${mod.base}/web/callback`;
        const { client_id } = await register(mod.base, sameOrigin);
        const page = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: sameOrigin, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${session()}` } });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Allow access\?/u);
    } finally { await mod.close(); }
});

test("{§auth-oauth-clients} a declared client may not take a module client's id, and a module client's scope must be one this server issues", async () => {
    await assert.rejects(boot({ PLURNK_AUTH_CLIENT_web: JSON.stringify({ secret: "x", scopes: ["acp"] }) }, {}, "s3cret", (credentials) => {
        credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["acp"] });
    }), /PLURNK_AUTH_CLIENT_web: 'web' is the id of a module's own client/u);
    const { mod, authorize } = await moduleBoot({}, ["acp", "elsewhere"]);
    const complaints: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]): void => { complaints.push(args); };
    try {
        assert.equal((await authorize()).response.status, 500, "a module's fault is a server error, never a narrowed grant");
        assert.match(String((complaints[0] as unknown[])[1]), /registered the scope 'elsewhere', which this authorization server does not issue/u);
    } finally { console.error = error; await mod.close(); }
});
