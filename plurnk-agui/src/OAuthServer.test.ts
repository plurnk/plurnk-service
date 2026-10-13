// {§agui-oauth} — the authorization server on the module's own listener, driven over HTTP exactly as a
// client would: discovery, the operator's sign-in and code exchange with PKCE, client credentials,
// refresh rotation, revocation, registration, the login limiter, and bearer admission of /agui.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { host, type Hosted } from "../test/host.ts";
import type { AguiPort, ModuleOptions } from "./Module.ts";
import type { AguiEvent } from "./types.ts";

const { default: Credentials } = await import("../../plurnk-core/src/server/Credentials.ts") as { default: new () => ApplicationPort["credentials"] };

const FLOOR = {
    PLURNK_AGUI_SECRET: "s3cret", PLURNK_AGUI_ISSUER: "", PLURNK_AGUI_USER: "ada", PLURNK_AGUI_PASSWORD: "lovelace",
    PLURNK_AGUI_ACCESS_TTL_SEC: "3600", PLURNK_AGUI_REFRESH_TTL_SEC: "2592000", PLURNK_AGUI_LOGIN_ATTEMPTS: "5", PLURNK_AGUI_LOGIN_WINDOW_SEC: "60",
    PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_MAX_TURNS: "", PLURNK_AGUI_HEARTBEAT_MS: "0",
};

// The least seam the module needs to start and to answer a worldless action: the authority, the
// listener, no module actions and no events.
const boot = async (env: Record<string, string> = {}, options: Omit<ModuleOptions, "env"> = {}): Promise<Hosted & { readonly base: string; readonly credentials: ApplicationPort["credentials"] }> => {
    let port = 0;
    const credentials = new Credentials();
    const seam = {
        credentials,
        registerHttpRoute: () => {},
        httpAddress: () => ({ host: "127.0.0.1", port }),
        listModuleActions: () => [],
        subscribeToEvents: () => () => {},
        configurationNotices: () => [],
    } as unknown as AguiPort;
    const hosted = await host(seam, { env: { ...FLOOR, ...env }, ...options });
    port = hosted.address().port;
    return Object.assign(hosted, { base: `http://127.0.0.1:${port}`, credentials });
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

const ping = async (base: string, headers: Record<string, string>): Promise<Response> => fetch(`${base}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ threadId: "t", runId: "r", state: {}, tools: [], context: [], messages: [], forwardedProps: { plurnk: { action: { kind: "ping" } } } }),
});
const pinged = async (base: string, headers: Record<string, string>): Promise<void> => {
    const response = await ping(base, headers);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const events = text.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
    assert.ok(events.some((event) => event.type === "CUSTOM" && (event as { name?: string }).name === "plurnk.action.result"), "the action answered");
};
const refused = async (base: string, headers: Record<string, string>): Promise<{ status: number; type: string; challenge: string }> => {
    const response = await ping(base, headers);
    const body = await json<{ type: string }>(response);
    return { status: response.status, type: body.type, challenge: response.headers.get("www-authenticate") ?? "" };
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
const signIn = async (base: string, query: Record<string, string>, credentials: { username: string; password: string }): Promise<Response> => {
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<form method="post" action="\/oauth\/authorize">/u);
    for (const [name, value] of Object.entries(query)) {
        assert.ok(html.includes(`name="${name}" value="${value.replaceAll("&", "&amp;")}"`), `the form carries ${name}`);
    }
    return fetch(`${base}/oauth/authorize`, { ...form({ ...query, ...credentials }), redirect: "manual" });
};

test("{§agui-oauth-endpoints} discovery names the issuer's endpoints, grants and PKCE method, and the resource names its authorization server", async () => {
    const mod = await boot();
    try {
        assert.deepEqual([...mod.module.mounts], ["/agui", "/oauth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]);
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
            scopes_supported: ["agui"],
        });
        assert.deepEqual(await json(await fetch(`${mod.base}/.well-known/oauth-protected-resource`)), {
            resource: `${mod.base}/agui`, authorization_servers: [mod.base], scopes_supported: ["agui"], bearer_methods_supported: ["header"], resource_name: "Plurnk AG-UI",
        });
        const preflight = await fetch(`${mod.base}/oauth/token`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*", "a page may read the token endpoint's answer");
        assert.equal((await fetch(`${mod.base}/oauth/nothing`)).status, 404);
        assert.equal((await fetch(`${mod.base}/oauth/token`)).status, 405, "the token endpoint is POST");
    } finally { await mod.close(); }
});

test("{§agui-oauth-endpoints} a configured issuer names the public origin a proxy serves", async () => {
    const mod = await boot({ PLURNK_AGUI_ISSUER: "https://plurnk.example" });
    try {
        const metadata = await json(await fetch(`${mod.base}/.well-known/oauth-authorization-server`));
        assert.equal(metadata.token_endpoint, "https://plurnk.example/oauth/token");
        assert.match((await refused(mod.base, {})).challenge, /resource_metadata="https:\/\/plurnk\.example\/\.well-known\/oauth-protected-resource"/u);
    } finally { await mod.close(); }
});

test("{§agui-oauth-clients} the operator's secret is a client secret: client_credentials, by Basic or by post, mints an access token that admits /agui", async () => {
    const mod = await boot();
    try {
        for (const init of [
            { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "s3cret") } },
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "agui" }),
        ]) {
            const response = await fetch(`${mod.base}/oauth/token`, init);
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = JSON.parse(text) as { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string };
            assert.equal(body.token_type, "Bearer");
            assert.equal(body.expires_in, 3600);
            assert.equal(body.scope, "agui");
            assert.equal(body.refresh_token, undefined, "client credentials renew with the secret, not a refresh token");
            await pinged(mod.base, { authorization: `Bearer ${body.access_token}` });
        }
        // Transitional (#1115): the secret presented directly, until the terminal client exchanges it.
        await pinged(mod.base, { authorization: "Bearer s3cret" });
        const wrong = await fetch(`${mod.base}/oauth/token`, { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "nope") } });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.headers.get("www-authenticate"), 'Basic realm="plurnk"');
        assert.equal((await json(wrong)).error, "invalid_client");
        const unknown = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "nobody", client_secret: "x" }));
        assert.equal(unknown.status, 401);
        assert.equal(unknown.headers.get("www-authenticate"), null, "no Basic challenge for a client that posted its credentials");
        const unsupported = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "password", client_id: "operator", client_secret: "s3cret", username: "ada", password: "lovelace" }));
        assert.equal(unsupported.status, 400);
        assert.equal((await json(unsupported)).error, "unsupported_grant_type", "RFC 9700: no password grant");
        const scope = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "root" }));
        assert.equal((await json(scope)).error, "invalid_scope");
    } finally { await mod.close(); }
});

test("{§agui-http-authorization} admission refuses what it cannot verify, each refusal an RFC 6750 challenge naming the resource metadata", async () => {
    const mod = await boot({ PLURNK_AGUI_ACCESS_TTL_SEC: "1" });
    try {
        const metadata = `resource_metadata="${mod.base}/.well-known/oauth-protected-resource"`;
        const missing = await refused(mod.base, {});
        assert.equal(missing.status, 401);
        assert.match(missing.type, /\/bearer-token-required$/u);
        assert.equal(missing.challenge, `Bearer realm="plurnk", ${metadata}`);
        for (const header of ["Bearer", "Bearer not-a-token", "Basic abc"]) {
            const outcome = await refused(mod.base, { authorization: header });
            assert.equal(outcome.status, 401, header);
            assert.match(outcome.type, header === "Basic abc" ? /\/bearer-token-required$/u : /\/bearer-token-invalid$/u);
        }
        const invalid = await refused(mod.base, { authorization: "Bearer not-a-token" });
        assert.equal(invalid.challenge, `Bearer realm="plurnk", error="invalid_token", error_description="The access token is unknown, expired or revoked.", ${metadata}`);
        const minted = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })));
        await pinged(mod.base, { authorization: `Bearer ${minted.access_token}` });
        await sleep(1_100);
        assert.match((await refused(mod.base, { authorization: `Bearer ${minted.access_token}` })).type, /\/bearer-token-invalid$/u, "expiry is enforced at admission");
        const issued = mod.credentials.issue({ kind: "refresh", subject: "operator", clientId: "operator", scopes: ["agui"], family: "f", ttlMs: 60_000 });
        assert.match((await refused(mod.base, { authorization: `Bearer ${issued.token}` })).type, /\/bearer-token-invalid$/u, "a refresh token is never a bearer");
        const scoped = mod.credentials.issue({ kind: "access", subject: "operator", clientId: "operator", scopes: ["other"], family: "g", ttlMs: 60_000 });
        const insufficient = await refused(mod.base, { authorization: `Bearer ${scoped.token}` });
        assert.equal(insufficient.status, 403);
        assert.match(insufficient.type, /\/bearer-scope-insufficient$/u);
        assert.equal(insufficient.challenge, `Bearer realm="plurnk", error="insufficient_scope", scope="agui", ${metadata}`);
    } finally { await mod.close(); }
});

test("{§agui-oauth-login} authorization code with PKCE: a registered public client, the operator's sign-in, the code and its one exchange", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        assert.match(client_id, /^[A-Za-z0-9_-]{43}$/u);
        const { verifier, challenge } = pkce();
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz&1", scope: "agui" };
        const wrong = await signIn(mod.base, query, { username: "ada", password: "wrong" });
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /The user or password is wrong\./u);
        const code = async (): Promise<string> => {
            const redirected = await signIn(mod.base, query, { username: "ada", password: "lovelace" });
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
        assert.equal(tokens.scope, "agui");
        assert.ok(tokens.refresh_token.length > 0, "a code grant renews through a refresh token");
        await pinged(mod.base, { authorization: `Bearer ${tokens.access_token}` });
        const twice = await code();
        assert.equal((await exchange({ code: twice })).status, 200);
        assert.equal((await json(await exchange({ code: twice }))).error, "invalid_grant", "a code is exchanged once");
        await pinged(mod.base, { authorization: `Bearer ${tokens.access_token}` });
    } finally { await mod.close(); }
});

test("{§agui-oauth-login} a bad client or redirect is told to the person; a malformed request is redirected as an error; unconfigured sign-in explains itself", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { challenge } = pkce();
        const refusal = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id: "stranger", redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`);
        assert.equal(refusal.status, 400);
        assert.match(await refusal.text(), /not registered with this daemon/u);
        const elsewhere = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:4000/elsewhere", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`);
        assert.equal(elsewhere.status, 400, "a redirect the client did not register is never followed");
        const loopbackPort = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:5555/callback", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })}`);
        assert.equal(loopbackPort.status, 200, "RFC 8252: a loopback redirect may change its port");
        for (const [query, error] of [
            [{ response_type: "token", code_challenge: challenge, code_challenge_method: "S256" }, "unsupported_response_type"],
            [{ response_type: "code" }, "invalid_request"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "plain" }, "invalid_request"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "root" }, "invalid_scope"],
            [{ response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://elsewhere.example/agui" }, "invalid_target"],
        ] as const) {
            const response = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: redirect, state: "s", ...query })}`, { redirect: "manual" });
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
    const unconfigured = await boot({ PLURNK_AGUI_USER: "", PLURNK_AGUI_PASSWORD: "" });
    try {
        const { client_id } = await register(unconfigured.base, "http://127.0.0.1:4000/callback");
        const page = await fetch(`${unconfigured.base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "http://127.0.0.1:4000/callback", response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`);
        assert.equal(page.status, 503);
        assert.match(await page.text(), /PLURNK_AGUI_USER.*PLURNK_AGUI_PASSWORD/su);
        await pinged(unconfigured.base, { authorization: "Bearer s3cret" });
    } finally { await unconfigured.close(); }
});

test("{§agui-oauth-tokens} a refresh token rotates on every use, narrows but never widens, and its reuse revokes the family", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const { verifier, challenge } = pkce();
        const redirected = await signIn(mod.base, { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" }, { username: "ada", password: "lovelace" });
        const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
        const first = await json<{ access_token: string; refresh_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier })));
        const refresh = (token: string, extra: Record<string, string> = {}): Promise<Response> =>
            fetch(`${mod.base}/oauth/token`, form({ grant_type: "refresh_token", client_id, refresh_token: token, ...extra }));
        assert.equal((await json(await refresh(first.refresh_token, { scope: "agui root" }))).error, "invalid_scope");
        const second = await json<{ access_token: string; refresh_token: string }>(await refresh(first.refresh_token));
        assert.notEqual(second.refresh_token, first.refresh_token, "rotated");
        await pinged(mod.base, { authorization: `Bearer ${first.access_token}` });
        await pinged(mod.base, { authorization: `Bearer ${second.access_token}` });
        const reused = await refresh(first.refresh_token);
        assert.equal(reused.status, 400);
        assert.equal((await json(reused)).error, "invalid_grant");
        for (const token of [first.access_token, second.access_token]) {
            assert.match((await refused(mod.base, { authorization: `Bearer ${token}` })).type, /\/bearer-token-invalid$/u, "reuse ends the family");
        }
        assert.equal((await json(await refresh(second.refresh_token))).error, "invalid_grant", "including the rotated refresh token");
        const other = await json<{ refresh_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "authorization_code", client_id, code: "stale", redirect_uri: redirect, code_verifier: verifier })));
        assert.equal(other.refresh_token, undefined);
    } finally { await mod.close(); }
});

test("{§agui-oauth-revocation} revocation is by family and by the owning client; a stranger's revocation changes nothing; grants are independent", async () => {
    const mod = await boot({ PLURNK_AGUI_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["agui"] }) });
    try {
        const mintOperator = async (): Promise<string> => (await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })))).access_token;
        const one = await mintOperator();
        const two = await mintOperator();
        const agent = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "agent", client_secret: "agent-secret" })));
        await pinged(mod.base, { authorization: `Bearer ${agent.access_token}` });
        const stranger = await fetch(`${mod.base}/oauth/revoke`, form({ token: one, client_id: "agent", client_secret: "agent-secret" }));
        assert.equal(stranger.status, 200, "RFC 7009: an unowned token revokes nothing and still answers 200");
        await pinged(mod.base, { authorization: `Bearer ${one}` });
        const revoked = await fetch(`${mod.base}/oauth/revoke`, form({ token: one, client_id: "operator", client_secret: "s3cret" }));
        assert.equal(revoked.status, 200);
        assert.match((await refused(mod.base, { authorization: `Bearer ${one}` })).type, /\/bearer-token-invalid$/u);
        await pinged(mod.base, { authorization: `Bearer ${two}` });
        await pinged(mod.base, { authorization: `Bearer ${agent.access_token}` });
        assert.equal((await fetch(`${mod.base}/oauth/revoke`, form({ token: "unknown", client_id: "operator", client_secret: "s3cret" }))).status, 200);
        assert.equal((await json(await fetch(`${mod.base}/oauth/revoke`, form({ client_id: "operator", client_secret: "s3cret" })))).error, "invalid_request");
        const asPublic = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: (await register(mod.base, "http://127.0.0.1:1/cb")).client_id }));
        assert.equal((await json(asPublic)).error, "unauthorized_client", "a public client holds nothing to present");
    } finally { await mod.close(); }
});

test("{§agui-oauth-login} failed sign-ins and client secrets from one address are limited per window", async () => {
    const mod = await boot({ PLURNK_AGUI_LOGIN_ATTEMPTS: "2", PLURNK_AGUI_LOGIN_WINDOW_SEC: "60" });
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" };
        const attempt = (password: string): Promise<Response> => fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, username: "ada", password }), redirect: "manual" });
        assert.equal((await attempt("no")).status, 401);
        assert.equal((await attempt("no")).status, 401);
        const limited = await attempt("lovelace");
        assert.equal(limited.status, 429, "the right password after the limit is refused too");
        assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);
        const secrets = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" }));
        assert.equal(secrets.status, 429, "the same window covers client secrets");
        assert.equal((await json(secrets)).error, "invalid_client");
    } finally { await mod.close(); }
    const unlimited = await boot({ PLURNK_AGUI_LOGIN_ATTEMPTS: "0" });
    try {
        for (let i = 0; i < 4; i += 1) {
            assert.equal((await fetch(`${unlimited.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "no" }))).status, 401);
        }
        assert.equal((await fetch(`${unlimited.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" }))).status, 200, "0 attempts is no limit");
    } finally { await unlimited.close(); }
});

test("{§agui-oauth} with an empty secret the module mounts only /agui and admits anonymously", async () => {
    const mod = await boot({ PLURNK_AGUI_SECRET: "" });
    try {
        assert.deepEqual([...mod.module.mounts], ["/agui"]);
        await pinged(mod.base, {});
    } finally { await mod.close(); }
});
