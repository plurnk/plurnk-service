// {§auth-oauth} — the authorization server on the daemon's listener, driven over HTTP exactly as a
// client would: discovery, the operator's sign-in and code exchange with PKCE, client credentials,
// refresh rotation, revocation, registration, and session management.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { authorizationDocumentSpecimens } from "./AuthorizationDocuments.ts";
import Module, { type AuthSetupSeam } from "./Module.ts";
import { hashPassword, hashPasswordSync } from "./password.ts";
import { admitted, basic, boot, Credentials, FLOOR, form, hosted, json, pkce, register, rejected, sessionOf, signIn, TEST_PASSWORD_HASH } from "../test/harness.ts";

test("{§auth-oauth} discovery names the issuer's endpoints, grants and PKCE method, and the resource names its authorization server", async () => {
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
            scopes_supported: ["acp", "mcp", "notifications"],
        });
        assert.deepEqual(await json(await fetch(`${mod.base}/.well-known/oauth-protected-resource`)), {
            resource: mod.base,
            authorization_servers: [mod.base],
            scopes_supported: ["acp", "mcp", "notifications"],
            bearer_methods_supported: ["header"],
            resource_name: "Plurnk",
        });
        const preflight = await fetch(`${mod.base}/oauth/token`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*", "a page may read the token endpoint's answer");
        assert.equal((await fetch(`${mod.base}/oauth/nothing`)).status, 404);
        assert.equal((await fetch(`${mod.base}/oauth/token`)).status, 405, "the token endpoint is POST");
    } finally { await mod.close(); }
});

test("{§auth-oauth} a configured issuer names the public origin a proxy serves", async () => {
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
        for (const [init, expectedScope] of [
            [
                { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "s3cret") } },
                "acp mcp notifications",
            ],
            [
                form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "acp", resource: `${mod.base}/acp` }),
                "acp",
            ],
        ] as const) {
            const response = await fetch(`${mod.base}/oauth/token`, init);
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = JSON.parse(text) as { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string };
            assert.equal(body.token_type, "Bearer");
            assert.equal(body.expires_in, 1);
            assert.equal(body.scope, expectedScope, "the operator holds every scope; a request may narrow");
            assert.equal(body.refresh_token, undefined, "client credentials renew with the secret, not a refresh token");
            for (const granted of expectedScope.split(" ")) {
                admitted(mod, body.access_token, granted);
            }
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
        const delegated = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", requested_subject: "scoutproxy" })));
        assert.equal(mod.credentials.verify(delegated.access_token)?.subject, "scoutproxy", "confidential client_credentials may mint a delegated subject token");
        assert.equal(mod.credentials.verify(delegated.access_token)?.clientId, "operator");
        const badSubject = await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", requested_subject: "bad/sub" }));
        assert.equal(badSubject.status, 400);
        assert.equal((await json(badSubject)).error, "invalid_request");
    } finally { await mod.close(); }
});

test("{§auth-oauth-clients} authorization code with PKCE: a registered public client, the operator's sign-in, the code and its one exchange", async () => {
    const mod = await boot();
    try {
        const redirect = "http://127.0.0.1:4000/callback";
        const { client_id } = await register(mod.base, redirect);
        assert.match(client_id, /^[A-Za-z0-9_-]{43}$/u);
        const { verifier, challenge } = pkce();
        const query = { client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz&1", scope: "acp" };
        const publicPage = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`);
        assert.equal(publicPage.status, 200);
        assert.match(await publicPage.text(), /<strong>Witness<\/strong> asks to use this daemon \(scope: acp\)\./u);
        const wrong = await signIn(mod.base, query, "wrong");
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /Invalid password\./u);
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

test("{§auth-oauth-clients} a bad client or redirect is told to the person; a malformed request is redirected as an error", async () => {
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

test("{§auth-oauth-tokens} revocation is by family and by the owning client; a stranger's revocation changes nothing; grants are independent", async () => {
    const mod = await boot({
        PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["acp"] }),
        PLURNK_AUTH_CLIENT_bridge: JSON.stringify({ secret: "bridge-secret", scopes: ["acp", "notifications"] }),
        PLURNK_AUTH_CLIENT_mcp_gw: JSON.stringify({ secret: "mcp-secret", scopes: ["mcp"] }),
    });
    try {
        const bridge = await json<{ access_token: string; scope: string }>(await fetch(
            `${mod.base}/oauth/token`,
            form({
                grant_type: "client_credentials",
                client_id: "bridge",
                client_secret: "bridge-secret",
                scope: "acp notifications",
                resource: `${mod.base}/notifications`,
            }),
        ));
        assert.equal(bridge.scope, "acp notifications");
        admitted(mod, bridge.access_token, "acp");
        admitted(mod, bridge.access_token, "notifications");
        const mcpGw = await json<{ access_token: string; scope: string }>(await fetch(
            `${mod.base}/oauth/token`,
            form({
                grant_type: "client_credentials",
                client_id: "mcp_gw",
                client_secret: "mcp-secret",
                resource: `${mod.base}/mcp`,
            }),
        ));
        assert.equal(mcpGw.scope, "mcp");
        admitted(mod, mcpGw.access_token, "mcp");
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

test("{§credential-authority} {§http-host} the face answers its issuer from publication, before the module starts: the configured one, else the address the request reached, else the listener's", async () => {
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

test("{§auth-oauth-clients} a browser is the operator only once it signs in: the sign-in sets the session, a module's own client is then authorized silently, and a session is never a bearer", async () => {
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
        const beforeHtml = await before.text();
        assert.match(beforeHtml, /Sign in to Plurnk/u);
        assert.doesNotMatch(beforeHtml, /asks to use this daemon/u, "a first-party module client renders no third-party delegation copy");
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

test("{§auth-oauth-clients} a client elsewhere is shown consent: allowing with the session issues the code, denying redirects access_denied, and a POST without the session issues nothing", async () => {
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

test("{§http-host} {§auth-oauth} the authorization server answers at whatever address a request reached it by; a configured issuer is the one answer", async () => {
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

test("{§auth-oauth-clients} no browser signs in by password when PLURNK_AUTH_PASSWORD_HASH is empty: 503 renders generic unavailability without leaking configuration, and client credentials are unaffected", async () => {
    const mod = await boot({ PLURNK_AUTH_PASSWORD_HASH: "" }, {}, "s3cret", (credentials) => {
        credentials.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["acp"] });
    });
    try {
        const query = { client_id: "web", redirect_uri: `${mod.base}/web/callback`, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "acp" };
        for (const attempt of [
            () => fetch(`${mod.base}/oauth/authorize?${new URLSearchParams(query).toString()}`, { redirect: "manual" }),
            () => fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "" }), redirect: "manual" }),
            () => fetch(`${mod.base}/oauth/authorize`, { ...form({ ...query, password: "lovelace" }), redirect: "manual" }),
        ]) {
            const page = await attempt();
            assert.equal(page.status, 503);
            const html = await page.text();
            assert.match(html, /<h1><span role="img" aria-label="Warning">⚠<\/span> Sign-in unavailable<\/h1>/u);
            assert.match(html, /<p>Password sign-in is not enabled\.<\/p>/u);
            assert.doesNotMatch(html, /PLURNK_|\.env|XDG|plurnk web|secret|~\/\.config/iu, "exposes zero operator file paths, env vars, or CLI commands");
            assert.equal(page.headers.get("set-cookie"), null, "no session");
        }
        const minted = await json<{ access_token: string }>(await fetch(`${mod.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" })));
        admitted(mod, minted.access_token);
    } finally { await mod.close(); }
});

test("{§auth-oauth-clients} the password selects no account: whatever password hash signed them in, the browser's grants name the same operator", async () => {
    const subjects: string[] = [];
    for (const password of ["lovelace", "babbage"]) {
        const mod = await boot({ PLURNK_AUTH_PASSWORD_HASH: hashPasswordSync(password, { cost: 1_024 }) });
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

test("{§auth-oauth-clients} every document is a main article under a header heading, with no script, no class and a label for every visible control", () => {
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

test("{§auth-oauth-clients} a module client's registered stylesheet replaces the standalone style on its pages; any other client, or none, gets the standalone page", async () => {
    for (const passwordHash of [TEST_PASSWORD_HASH, ""]) {
        const mod = await boot({ PLURNK_AUTH_PASSWORD_HASH: passwordHash }, {}, "s3cret", (credentials) => {
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
            assert.equal(await styled(await authorize("web")), true, `the module's own page (${passwordHash === "" ? "unavailable" : "sign-in"})`);
            assert.equal(await styled(await authorize("plain")), false, "a module client that registered none");
            assert.equal(await styled(await authorize("nobody")), false, "an unknown client's refusal");
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session?client_id=web`)), true, "the session page names the client it is shown for");
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session?client_id=nobody`)), false);
            assert.equal(await styled(await fetch(`${mod.base}/oauth/session`)), false);
        } finally { await mod.close(); }
    }
});

test("{§auth-oauth} {§auth-oauth-clients} {§auth-oauth-tokens} loopback /oauth/handoff mints single-use short-lived tickets for operator bearers even when PLURNK_AUTH_PASSWORD_HASH is empty, rejects non-operator or non-loopback callers, and never replays", async () => {
    const { PassThrough } = await import("node:stream");
    const { ServerResponse, IncomingMessage } = await import("node:http");
    const { default: OAuthServer } = await import("./OAuthServer.ts");
    const { resolveModuleOptions } = await import("./config.ts");

    const mod = await boot(
        {
            PLURNK_AUTH_PASSWORD_HASH: "",
            PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["acp"] }),
        },
        {},
        "s3cret",
        (credentials) => {
            credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] });
        },
    );
    try {
        // Missing or invalid bearer token -> 401 with Bearer challenge.
        const unauth = await fetch(`${mod.base}/oauth/handoff`, { method: "POST" });
        assert.equal(unauth.status, 401);
        assert.match(unauth.headers.get("www-authenticate") ?? "", /^Bearer\b/u);

        // Non-operator client -> 403 unauthorized_client.
        const agentToken = await json<{ access_token: string }>(await fetch(
            `${mod.base}/oauth/token`,
            form({ grant_type: "client_credentials", client_id: "agent", client_secret: "agent-secret", scope: "acp" }),
        ));
        const wrongClient = await fetch(`${mod.base}/oauth/handoff`, {
            method: "POST",
            headers: { authorization: `Bearer ${agentToken.access_token}` },
        });
        assert.equal(wrongClient.status, 403);
        assert.equal((await json(wrongClient)).error, "unauthorized_client");

        // Operator client delegated to another requested_subject -> 403 unauthorized_client.
        const delegatedToken = await json<{ access_token: string }>(await fetch(
            `${mod.base}/oauth/token`,
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", requested_subject: "delegate" }),
        ));
        const wrongSubject = await fetch(`${mod.base}/oauth/handoff`, {
            method: "POST",
            headers: { authorization: `Bearer ${delegatedToken.access_token}` },
        });
        assert.equal(wrongSubject.status, 403);

        // Operator bearer -> valid handoff ticket; invalid return paths rejected at 400.
        const opToken = await json<{ access_token: string }>(await fetch(
            `${mod.base}/oauth/token`,
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" }),
        ));
        for (const badReturn of ["https://evil.example/", "//evil.example/", "/ok#frag", "relative", "/oauth/handoff"]) {
            const bad = await fetch(`${mod.base}/oauth/handoff`, {
                method: "POST",
                headers: { authorization: `Bearer ${opToken.access_token}`, "content-type": "application/json" },
                body: JSON.stringify({ return: badReturn }),
            });
            assert.equal(bad.status, 400, badReturn);
        }

        const mintedRes = await fetch(`${mod.base}/oauth/handoff`, {
            method: "POST",
            headers: { authorization: `Bearer ${opToken.access_token}`, "content-type": "application/json" },
            body: JSON.stringify({ return: "/?view=sessions" }),
        });
        assert.equal(mintedRes.status, 200);
        const handoff = await json<{ ticket: string; url: string; expires_in: number }>(mintedRes);
        assert.equal(handoff.expires_in, 60);
        assert.equal(handoff.url, `${mod.base}/oauth/handoff?ticket=${encodeURIComponent(handoff.ticket)}`);

        // First GET consumes ticket, sets plurnk_session even with PLURNK_AUTH_PASSWORD_HASH="", and 303-redirects to return path.
        const redeemed = await fetch(handoff.url, { redirect: "manual" });
        assert.equal(redeemed.status, 303);
        assert.equal(redeemed.headers.get("location"), `${mod.base}/?view=sessions`);
        const cookie = sessionOf(redeemed);

        // Silent module-client authorization succeeds immediately with that session even while PLURNK_AUTH_PASSWORD_HASH="".
        const silentAuth = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({
            client_id: "plurnk-web",
            redirect_uri: `${mod.base}/auth/callback`,
            response_type: "code",
            code_challenge: pkce().challenge,
            code_challenge_method: "S256",
            scope: "acp",
        }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });
        assert.equal(silentAuth.status, 302, "plurnk-web authorizes silently from handoff session without PLURNK_AUTH_PASSWORD_HASH");

        // Replaying the same ticket fails 401 with no cookie.
        const replay = await fetch(handoff.url, { redirect: "manual" });
        assert.equal(replay.status, 401);
        assert.equal(replay.headers.get("set-cookie"), null);
        assert.match(await replay.text(), /Sign-in link expired/u);

        // Expired ticket fails 401 and non-loopback socket fails 403.
        let now = 10_000;
        const unitAuth = new OAuthServer({
            credentials: mod.credentials,
            opts: resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_PASSWORD_HASH: "", PLURNK_AUTH_CODE_TTL_SEC: "5" } }),
            issuer: () => "http://127.0.0.1:1066",
            now: () => now,
        });
        const invokeDirect = async (method: string, url: string, remoteAddress: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> => {
            const socket = Object.assign(new PassThrough(), { remoteAddress });
            const req = new IncomingMessage(socket as never);
            req.method = method;
            req.url = url;
            req.headers = headers;
            req.push(null);
            const res = new ServerResponse(req);
            const chunks: Buffer[] = [];
            const origWrite = res.write.bind(res);
            const origEnd = res.end.bind(res);
            res.write = ((chunk: string | Buffer | Uint8Array) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
                return origWrite(chunk);
            }) as typeof res.write;
            res.end = ((chunk?: unknown) => {
                if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
                else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
                return origEnd();
            }) as typeof res.end;
            await unitAuth.handle(req, res);
            return { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") };
        };
        const remoteAttempt = await invokeDirect("POST", "/oauth/handoff", "192.168.1.50", { authorization: `Bearer ${opToken.access_token}` });
        assert.equal(remoteAttempt.status, 403);
        const localMint = await invokeDirect("POST", "/oauth/handoff", "127.0.0.1", { authorization: `Bearer ${opToken.access_token}` });
        assert.equal(localMint.status, 200);
        const { ticket: expiringTicket } = JSON.parse(localMint.body) as { ticket: string };
        now += 5_000;
        const expiredRedeem = await invokeDirect("GET", `/oauth/handoff?ticket=${encodeURIComponent(expiringTicket)}`, "127.0.0.1");
        assert.equal(expiredRedeem.status, 401);
        assert.match(expiredRedeem.body, /Sign-in link expired/u);
    } finally {
        await mod.close();
    }
});

test("{§auth-oauth-clients} {§auth-oauth-tokens} {§credential-authority} encrypted browser sessions and public-client refresh grants survive daemon restart and revoke when secret rotates or a declared client is removed", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "plurnk-auth-restart-"));
    const storePath = join(dir, "credentials");
    try {
        let cookie = "";
        let clientId = "";
        let refreshToken = "";
        let declaredToken = "";

        const first = await boot(
            { PLURNK_AUTH_CLIENT_temp: JSON.stringify({ secret: "temp-secret", scopes: ["acp"] }) },
            {},
            "durable-secret",
            (credentials) => { credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] }); },
            storePath,
        );
        try {
            const redirect = "http://127.0.0.1:4300/callback";
            clientId = (await register(first.base, redirect)).client_id;
            const { verifier, challenge } = pkce();
            const signed = await signIn(first.base, {
                client_id: clientId,
                redirect_uri: redirect,
                response_type: "code",
                code_challenge: challenge,
                code_challenge_method: "S256",
            }, "lovelace");
            cookie = sessionOf(signed);
            const code = new URL(signed.headers.get("location")!).searchParams.get("code")!;
            const exchanged = await json<{ access_token: string; refresh_token: string }>(await fetch(
                `${first.base}/oauth/token`,
                form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier }),
            ));
            refreshToken = exchanged.refresh_token;
            declaredToken = (await json<{ access_token: string }>(await fetch(
                `${first.base}/oauth/token`,
                form({ grant_type: "client_credentials", client_id: "temp", client_secret: "temp-secret", scope: "acp" }),
            ))).access_token;
            admitted(first, declaredToken);
        } finally {
            await first.close();
        }

        // Restart with the same secret, PLURNK_AUTH_PASSWORD_HASH="", and PLURNK_AUTH_CLIENT_temp removed.
        const second = await boot(
            { PLURNK_AUTH_PASSWORD_HASH: "" },
            {},
            "durable-secret",
            (credentials) => { credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] }); },
            storePath,
        );
        try {
            rejected(second, declaredToken);
            // Browser session survives and silently re-authorizes plurnk-web without asking for a password.
            const silent = await fetch(`${second.base}/oauth/authorize?${new URLSearchParams({
                client_id: "plurnk-web",
                redirect_uri: `${second.base}/auth/callback`,
                response_type: "code",
                code_challenge: pkce().challenge,
                code_challenge_method: "S256",
                scope: "acp",
            }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });
            assert.equal(silent.status, 302, "persisted browser session silently re-authorizes module client across restart");

            // Registered public client and its refresh token survive restart and rotate cleanly.
            const refreshed = await fetch(
                `${second.base}/oauth/token`,
                form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
            );
            assert.equal(refreshed.status, 200);
            const nextTokens = await json<{ access_token: string; refresh_token: string }>(refreshed);
            admitted(second, nextTokens.access_token);
        } finally {
            await second.close();
        }

        // Restart with a rotated secret: prior sessions and refresh tokens fail closed cleanly.
        const rotated = await boot(
            { PLURNK_AUTH_PASSWORD_HASH: "" },
            {},
            "rotated-secret",
            (credentials) => { credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] }); },
            storePath,
        );
        try {
            const afterRotate = await fetch(`${rotated.base}/oauth/session`, { headers: { cookie: `plurnk_session=${cookie}` } });
            assert.match(await afterRotate.text(), /Not signed in/u);
        } finally {
            await rotated.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§auth-oauth-clients} {§diagnostic-observation} requested_subject on client_credentials is permitted across principals only for the operator client; declared clients may name only themselves", async () => {
    const mod = await boot({
        PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["acp"] }),
        PLURNK_AUTH_CLIENT_bridge: JSON.stringify({ secret: "bridge-secret", scopes: ["acp"] }),
    });
    try {
        const cases: readonly {
            readonly label: string;
            readonly clientId: string;
            readonly secret: string;
            readonly requestedSubject?: string;
            readonly expectedStatus: number;
            readonly expectedSubject?: string;
            readonly expectedError?: { readonly code: string; readonly description: string };
        }[] = [
            { label: "operator default subject", clientId: "operator", secret: "s3cret", expectedStatus: 200, expectedSubject: "operator" },
            { label: "operator explicit operator subject", clientId: "operator", secret: "s3cret", requestedSubject: "operator", expectedStatus: 200, expectedSubject: "operator" },
            { label: "operator delegated arbitrary principal", clientId: "operator", secret: "s3cret", requestedSubject: "agent", expectedStatus: 200, expectedSubject: "agent" },
            { label: "operator malformed requested_subject", clientId: "operator", secret: "s3cret", requestedSubject: "bad/sub", expectedStatus: 400, expectedError: { code: "invalid_request", description: "requested_subject must match [A-Za-z0-9._-]+." } },
            { label: "declared client default subject", clientId: "agent", secret: "agent-secret", expectedStatus: 200, expectedSubject: "agent" },
            { label: "declared client naming its own id", clientId: "agent", secret: "agent-secret", requestedSubject: "agent", expectedStatus: 200, expectedSubject: "agent" },
            { label: "declared client attempting operator impersonation", clientId: "agent", secret: "agent-secret", requestedSubject: "operator", expectedStatus: 400, expectedError: { code: "invalid_request", description: "Only the operator client may set requested_subject to another principal." } },
            { label: "declared client attempting sibling principal impersonation", clientId: "agent", secret: "agent-secret", requestedSubject: "bridge", expectedStatus: 400, expectedError: { code: "invalid_request", description: "Only the operator client may set requested_subject to another principal." } },
            { label: "declared client malformed requested_subject", clientId: "agent", secret: "agent-secret", requestedSubject: "bad/sub", expectedStatus: 400, expectedError: { code: "invalid_request", description: "requested_subject must match [A-Za-z0-9._-]+." } },
        ];
        for (const c of cases) {
            const response = await fetch(`${mod.base}/oauth/token`, form({
                grant_type: "client_credentials",
                client_id: c.clientId,
                client_secret: c.secret,
                scope: "acp",
                ...(c.requestedSubject === undefined ? {} : { requested_subject: c.requestedSubject }),
            }));
            assert.equal(response.status, c.expectedStatus, c.label);
            if (c.expectedSubject !== undefined) {
                const body = await json<{ access_token: string }>(response);
                const verified = mod.credentials.verify(body.access_token);
                assert.equal(verified?.subject, c.expectedSubject, c.label);
                assert.equal(verified?.clientId, c.clientId, c.label);
            } else {
                assert.deepEqual(await json(response), {
                    error: c.expectedError!.code,
                    error_description: c.expectedError!.description,
                }, c.label);
            }
        }
    } finally {
        await mod.close();
    }
});

test("{§auth-oauth} {§auth-oauth-clients} POST /oauth/session enforces same-origin via Sec-Fetch-Site and Origin across direct and proxied issuers", async () => {
    const establishBrowserSession = async (hostedMod: Awaited<ReturnType<typeof boot>>): Promise<string> => {
        const redirect = "http://127.0.0.1:4400/callback";
        const { client_id } = await register(hostedMod.base, redirect);
        const signed = await signIn(hostedMod.base, {
            client_id,
            redirect_uri: redirect,
            response_type: "code",
            code_challenge: pkce().challenge,
            code_challenge_method: "S256",
        }, "lovelace");
        return sessionOf(signed);
    };

    const mod = await boot();
    try {
        const session = await establishBrowserSession(mod);
        const rejectedMatrix: readonly [string, Record<string, string>][] = [
            ["Sec-Fetch-Site: cross-site + cross-site Origin", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
            ["Sec-Fetch-Site: cross-site alone", { "sec-fetch-site": "cross-site" }],
            ["Sec-Fetch-Site: same-site from another loopback port", { "sec-fetch-site": "same-site", origin: "http://127.0.0.1:1" }],
            ["mismatched Origin alone", { origin: "https://evil.example" }],
            ["mismatched loopback port Origin", { origin: "http://127.0.0.1:1" }],
            ["opaque null Origin", { origin: "null" }],
            ["Origin with trailing slash", { origin: `${mod.base}/` }],
            ["Origin with path", { origin: `${mod.base}/oauth/session` }],
            ["Origin with userinfo", { origin: `http://user@${new URL(mod.base).host}` }],
        ];
        for (const [label, extraHeaders] of rejectedMatrix) {
            const res = await fetch(`${mod.base}/oauth/session`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", cookie: `plurnk_session=${session}`, ...extraHeaders },
                body: "action=end",
            });
            assert.equal(res.status, 403, label);
            assert.equal(res.headers.get("set-cookie"), null, `${label}: never clears cookie on 403`);
            assert.equal((await json(res)).error, "access_denied", label);
            assert.notEqual(mod.credentials.verify(session), null, `${label}: session family stays live`);
        }

        // Same-origin browser POST (Sec-Fetch-Site: same-origin + matching Origin) signs out cleanly.
        const sameOriginRes = await fetch(`${mod.base}/oauth/session`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: `plurnk_session=${session}`,
                "sec-fetch-site": "same-origin",
                origin: mod.base,
            },
            body: "action=end",
        });
        assert.equal(sameOriginRes.status, 200);
        assert.match(sameOriginRes.headers.get("set-cookie") ?? "", /^plurnk_session=; Path=\/oauth; Max-Age=0;/u);
        assert.equal(mod.credentials.verify(session), null);

        // User-initiated Sec-Fetch-Site: none with matching Origin also succeeds.
        const secondSession = await establishBrowserSession(mod);
        const noneSiteRes = await fetch(`${mod.base}/oauth/session`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: `plurnk_session=${secondSession}`,
                "sec-fetch-site": "none",
                origin: mod.base,
            },
            body: "action=end",
        });
        assert.equal(noneSiteRes.status, 200);
        assert.equal(mod.credentials.verify(secondSession), null);
    } finally {
        await mod.close();
    }

    // Behind a configured public issuer (reverse proxy), Origin must match PLURNK_AUTH_ISSUER.
    const fronted = await boot({ PLURNK_AUTH_ISSUER: "https://plurnk.example" });
    try {
        const session = await establishBrowserSession(fronted);
        const wrongInternalOrigin = await fetch(`${fronted.base}/oauth/session`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: `plurnk_session=${session}`,
                "sec-fetch-site": "same-origin",
                origin: fronted.base,
            },
            body: "action=end",
        });
        assert.equal(wrongInternalOrigin.status, 403);
        assert.notEqual(fronted.credentials.verify(session), null);

        const publicIssuerOrigin = await fetch(`${fronted.base}/oauth/session`, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: `plurnk_session=${session}`,
                "sec-fetch-site": "same-origin",
                origin: "https://plurnk.example",
            },
            body: "action=end",
        });
        assert.equal(publicIssuerOrigin.status, 200);
        assert.equal(fronted.credentials.verify(session), null);
    } finally {
        await fronted.close();
    }
});

test("{§auth-oauth} {§auth-oauth-clients} {§credential-authority} POST /oauth/register evicts oldest inactive public clients past 1,000 without 503 bricking across restarts while preserving live grants and configured or module clients", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PassThrough } = await import("node:stream");
    const { IncomingMessage, ServerResponse } = await import("node:http");
    const { default: OAuthServer } = await import("./OAuthServer.ts");
    const { resolveModuleOptions } = await import("./config.ts");

    const dir = await mkdtemp(join(tmpdir(), "plurnk-register-bound-"));
    const storePath = join(dir, "credentials");
    try {
        const redirect = "http://127.0.0.1:4500/callback";
        let protectedClientId = "";
        let protectedRefresh = "";
        let firstInactiveId = "";
        let sixthClientId = "";
        let cookie = "";

        const first = await boot(
            { PLURNK_AUTH_CLIENT_bot: JSON.stringify({ secret: "bot-secret", scopes: ["acp"] }) },
            {},
            "durable-secret",
            (credentials) => { credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/web/cb"], scopes: ["acp"] }); },
            storePath,
        );
        try {
            // Client #1 obtains a live PKCE grant.
            protectedClientId = (await register(first.base, redirect)).client_id;
            const { verifier, challenge } = pkce();
            const signed = await signIn(first.base, {
                client_id: protectedClientId,
                redirect_uri: redirect,
                response_type: "code",
                code_challenge: challenge,
                code_challenge_method: "S256",
            }, "lovelace");
            cookie = sessionOf(signed);
            const code = new URL(signed.headers.get("location")!).searchParams.get("code")!;
            const exchanged = await json<{ access_token: string; refresh_token: string }>(await fetch(
                `${first.base}/oauth/token`,
                form({ grant_type: "authorization_code", client_id: protectedClientId, code, redirect_uri: redirect, code_verifier: verifier }),
            ));
            protectedRefresh = exchanged.refresh_token;

            // Clients #2..#1,000 are unauthenticated registrations with no tokens; #1,001..#1,005 overflow the bound.
            for (let i = 2; i <= 1_005; i += 1) {
                const reg = await register(first.base, redirect);
                if (i === 2) firstInactiveId = reg.client_id;
                if (i === 7) sixthClientId = reg.client_id;
            }
            assert.equal(first.credentials.publicClients?.().length, 1_000, "persisted public clients stay bounded at 1,000");

            // Oldest inactive registration (#2) was evicted; #7 (6th inactive, after 5 overflows) remains.
            const evictedAuthorize = await fetch(`${first.base}/oauth/authorize?${new URLSearchParams({
                client_id: firstInactiveId, redirect_uri: redirect, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256",
            }).toString()}`, { redirect: "manual" });
            assert.equal(evictedAuthorize.status, 400, "evicted inactive client is no longer registered");

            const retainedAuthorize = await fetch(`${first.base}/oauth/authorize?${new URLSearchParams({
                client_id: sixthClientId, redirect_uri: redirect, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256",
            }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });
            assert.equal(retainedAuthorize.status, 200, "non-evicted public client still reaches consent");

            // Protected client #1 (with live grant), operator, declared bot, and module client all keep working.
            const refreshed = await fetch(`${first.base}/oauth/token`, form({
                grant_type: "refresh_token", client_id: protectedClientId, refresh_token: protectedRefresh,
            }));
            assert.equal(refreshed.status, 200);
            protectedRefresh = (await json<{ refresh_token: string }>(refreshed)).refresh_token;

            assert.equal((await fetch(`${first.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "operator", client_secret: "durable-secret" }))).status, 200);
            assert.equal((await fetch(`${first.base}/oauth/token`, form({ grant_type: "client_credentials", client_id: "bot", client_secret: "bot-secret" }))).status, 200);
            const modSilent = await fetch(`${first.base}/oauth/authorize?${new URLSearchParams({
                client_id: "plurnk-web", redirect_uri: `${first.base}/web/cb`, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "acp",
            }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });
            assert.equal(modSilent.status, 302);
        } finally {
            await first.close();
        }

        // Restart from disk at full capacity (1,000 public clients): registration still succeeds at 201 and never bricks at 503.
        const second = await boot(
            { PLURNK_AUTH_CLIENT_bot: JSON.stringify({ secret: "bot-secret", scopes: ["acp"] }) },
            {},
            "durable-secret",
            (credentials) => { credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/web/cb"], scopes: ["acp"] }); },
            storePath,
        );
        try {
            const afterRestart = await register(second.base, redirect);
            assert.match(afterRestart.client_id, /^[A-Za-z0-9_-]{43}$/u);
            assert.equal(second.credentials.publicClients?.().length, 1_000);
            const refreshedAgain = await fetch(`${second.base}/oauth/token`, form({
                grant_type: "refresh_token", client_id: protectedClientId, refresh_token: protectedRefresh,
            }));
            assert.equal(refreshedAgain.status, 200, "active public client survives post-restart eviction");
        } finally {
            await second.close();
        }

        // Fallback path when CredentialAuthority omits registerPublicClient/publicClients: still bounded at 1,000.
        const backing = new Credentials({ operatorSecret: "s3cret" });
        const minimalAuthority: typeof backing = {
            operatorSecret: backing.operatorSecret,
            issue: (c) => backing.issue(c),
            verify: (t) => backing.verify(t),
            consume: (t) => backing.consume(t),
            revokeFamily: (f) => backing.revokeFamily(f),
            onRevoked: (l) => backing.onRevoked(l),
            sessions: (s) => backing.sessions(s),
            registerClient: (c) => backing.registerClient(c),
            client: (id) => backing.client(id),
            authenticateClient: (id, s) => backing.authenticateClient(id, s),
            publish: (f) => backing.publish(f),
            face: () => backing.face(),
        };
        const fallbackServer = new OAuthServer({
            credentials: minimalAuthority,
            opts: resolveModuleOptions({ env: FLOOR }),
            issuer: () => "http://127.0.0.1:1066",
        });
        const invokeFallback = async (method: string, url: string, contentType: string, payload: string): Promise<{ status: number; location: string; body: string }> => {
            const req = new IncomingMessage(new PassThrough() as never);
            req.method = method;
            req.url = url;
            req.headers = contentType.length > 0 ? { "content-type": contentType } : {};
            if (payload.length > 0) req.push(Buffer.from(payload, "utf8"));
            req.push(null);
            const res = new ServerResponse(req);
            const chunks: Buffer[] = [];
            const origEnd = res.end.bind(res);
            res.end = ((chunk?: unknown) => {
                if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
                else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
                return origEnd();
            }) as typeof res.end;
            await fallbackServer.handle(req, res);
            return { status: res.statusCode, location: String(res.getHeader("location") ?? ""), body: Buffer.concat(chunks).toString("utf8") };
        };
        const regBody = JSON.stringify({ redirect_uris: [redirect] });
        const firstFallback = JSON.parse((await invokeFallback("POST", "/oauth/register", "application/json", regBody)).body) as { client_id: string };
        const { verifier: fbVerifier, challenge: fbChallenge } = pkce();
        const fbSignIn = await invokeFallback(
            "POST",
            "/oauth/authorize",
            "application/x-www-form-urlencoded",
            new URLSearchParams({
                client_id: firstFallback.client_id, redirect_uri: redirect, response_type: "code",
                code_challenge: fbChallenge, code_challenge_method: "S256", password: "lovelace",
            }).toString(),
        );
        const fbCode = new URL(fbSignIn.location).searchParams.get("code")!;
        const fbExchange = await invokeFallback(
            "POST",
            "/oauth/token",
            "application/x-www-form-urlencoded",
            new URLSearchParams({
                grant_type: "authorization_code", client_id: firstFallback.client_id,
                code: fbCode, redirect_uri: redirect, code_verifier: fbVerifier,
            }).toString(),
        );
        const fbTokens = JSON.parse(fbExchange.body) as { refresh_token: string };
        let secondFallbackId = "";
        for (let i = 2; i <= 1_001; i += 1) {
            const r = await invokeFallback("POST", "/oauth/register", "application/json", regBody);
            assert.equal(r.status, 201);
            if (i === 2) secondFallbackId = (JSON.parse(r.body) as { client_id: string }).client_id;
        }
        const fbStillActive = await invokeFallback(
            "POST",
            "/oauth/token",
            "application/x-www-form-urlencoded",
            new URLSearchParams({ grant_type: "refresh_token", client_id: firstFallback.client_id, refresh_token: fbTokens.refresh_token }).toString(),
        );
        assert.equal(fbStillActive.status, 200, "fallback eviction preserves active public client");
        const fbEvicted = await invokeFallback(
            "GET",
            `/oauth/authorize?${new URLSearchParams({ client_id: secondFallbackId, redirect_uri: redirect, response_type: "code", code_challenge: fbChallenge, code_challenge_method: "S256" }).toString()}`,
            "",
            "",
        );
        assert.equal(fbEvicted.status, 400, "fallback eviction removes oldest inactive public client");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§auth-oauth-clients} {§auth-oauth-tokens} {§auth-configuration} scrypt KDF concurrency bounds and per-address failure rate limiting protect /oauth/authorize and /oauth/token across direct and HTTPS-proxied sockets", async () => {
    const { PassThrough } = await import("node:stream");
    const { IncomingMessage, ServerResponse } = await import("node:http");
    const { default: OAuthServer } = await import("./OAuthServer.ts");
    const { resolveModuleOptions } = await import("./config.ts");

    // 1. Default-cost hashPassword round-trip and KDF concurrency bound (PLURNK_AUTH_KDF_CONCURRENCY=1) over HTTP.
    const defaultHash = await hashPassword("ada-lovelace");
    const kdfMod = await boot(
        {
            PLURNK_AUTH_PASSWORD_HASH: defaultHash,
            PLURNK_AUTH_KDF_CONCURRENCY: "1",
            PLURNK_AUTH_FAILURE_LIMIT: "10",
        },
        {},
        "s3cret",
        (credentials) => {
            credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] });
        },
    );
    try {
        const query = {
            client_id: "plurnk-web",
            redirect_uri: `${kdfMod.base}/auth/callback`,
            response_type: "code",
            code_challenge: pkce().challenge,
            code_challenge_method: "S256",
            scope: "acp",
        };
        const concurrent = await Promise.all(
            Array.from({ length: 6 }, () =>
                fetch(`${kdfMod.base}/oauth/authorize`, { ...form({ ...query, password: "ada-lovelace" }), redirect: "manual" }),
            ),
        );
        const statuses = concurrent.map((r) => r.status);
        assert.ok(statuses.includes(302), "at least one sign-in verifies and redirects");
        assert.ok(statuses.includes(429), "excess concurrent KDF requests fail fast at 429");
        for (const throttled of concurrent.filter((r) => r.status === 429)) {
            assert.equal(throttled.headers.get("retry-after"), "1");
            assert.match(await throttled.text(), /Too many sign-in requests in progress\./u);
        }
        const afterDrain = await fetch(`${kdfMod.base}/oauth/authorize`, {
            ...form({ ...query, password: "ada-lovelace" }),
            redirect: "manual",
        });
        assert.equal(afterDrain.status, 302, "KDF slot releases cleanly after in-flight verification completes");
    } finally {
        await kdfMod.close();
    }

    // 2. Sliding-window failure rate limiting across /oauth/authorize and /oauth/token + rightmost X-Forwarded-For under loopback HTTPS issuer.
    let now = 100_000;
    const credentials = new Credentials({ operatorSecret: "s3cret" });
    credentials.registerClient({ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"] });
    const proxied = new OAuthServer({
        credentials,
        opts: resolveModuleOptions({
            env: {
                ...FLOOR,
                PLURNK_AUTH_ISSUER: "https://plurnk.example",
                PLURNK_AUTH_FAILURE_LIMIT: "2",
                PLURNK_AUTH_FAILURE_WINDOW_SEC: "60",
            },
        }),
        issuer: () => "https://plurnk.example",
        now: () => now,
    });
    const invoke = async (
        server: InstanceType<typeof OAuthServer>,
        url: string,
        remoteAddress: string,
        payload: Record<string, string>,
        headers: Record<string, string> = {},
    ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
        const socket = Object.assign(new PassThrough(), { remoteAddress });
        const req = new IncomingMessage(socket as never);
        req.method = "POST";
        req.url = url;
        const encoded = new URLSearchParams(payload).toString();
        req.headers = { "content-type": "application/x-www-form-urlencoded", ...headers };
        req.push(Buffer.from(encoded, "utf8"));
        req.push(null);
        const res = new ServerResponse(req);
        const outHeaders: Record<string, string> = {};
        const origWriteHead = res.writeHead.bind(res);
        res.writeHead = (statusCode: number, statusMessage?: unknown, head?: unknown) => {
            const raw = (typeof statusMessage === "object" && statusMessage !== null ? statusMessage : head) as Record<string, string | number | readonly string[] | undefined> | undefined;
            if (raw !== undefined) {
                for (const [k, v] of Object.entries(raw)) {
                    if (typeof v === "string" || typeof v === "number") outHeaders[k.toLowerCase()] = String(v);
                }
            }
            return origWriteHead(statusCode, statusMessage as never, head as never);
        };
        const chunks: Buffer[] = [];
        const origEnd = res.end.bind(res);
        res.end = ((chunk?: unknown) => {
            if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
            else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
            return origEnd();
        }) as typeof res.end;
        await server.handle(req, res);
        for (const [k, v] of Object.entries(res.getHeaders())) {
            if (v !== undefined) outHeaders[k.toLowerCase()] = String(v);
        }
        return { status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks).toString("utf8") };
    };

    const authForm = {
        client_id: "plurnk-web",
        redirect_uri: "https://plurnk.example/auth/callback",
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        scope: "acp",
    };
    // Rightmost hop 203.0.113.10 fails twice despite spoofed leading X-Forwarded-For hops.
    assert.equal(
        (await invoke(proxied, "/oauth/authorize", "127.0.0.1", { ...authForm, password: "wrong" }, { "x-forwarded-for": "198.51.100.1, 203.0.113.10" })).status,
        401,
    );
    now += 10_000;
    assert.equal(
        (await invoke(proxied, "/oauth/token", "127.0.0.1", { grant_type: "client_credentials", client_id: "operator", client_secret: "wrong" }, { "x-forwarded-for": "198.51.100.2, 203.0.113.10" })).status,
        401,
    );
    // 3rd attempt from 203.0.113.10 is throttled at 429 on both /oauth/authorize and /oauth/token, even with valid credentials.
    const blockedAuth = await invoke(
        proxied,
        "/oauth/authorize",
        "127.0.0.1",
        { ...authForm, password: "lovelace" },
        { "x-forwarded-for": "198.51.100.99, 203.0.113.10" },
    );
    assert.equal(blockedAuth.status, 429);
    assert.equal(blockedAuth.headers["retry-after"], "50");
    assert.match(blockedAuth.body, /Too many failed sign-in attempts\./u);

    const blockedToken = await invoke(
        proxied,
        "/oauth/token",
        "127.0.0.1",
        { grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" },
        { "x-forwarded-for": "203.0.113.10" },
    );
    assert.equal(blockedToken.status, 429);
    assert.equal(blockedToken.headers["retry-after"], "50");
    assert.equal((JSON.parse(blockedToken.body) as { error: string }).error, "temporarily_unavailable");

    // Sibling remote IP 203.0.113.11 is unaffected.
    const otherIp = await invoke(
        proxied,
        "/oauth/authorize",
        "127.0.0.1",
        { ...authForm, password: "lovelace" },
        { "x-forwarded-for": "203.0.113.11" },
    );
    assert.equal(otherIp.status, 302, "per-address throttle isolates distinct proxy client hops");

    // Non-loopback socket ignores spoofed X-Forwarded-For and keys on socket remoteAddress.
    assert.equal(
        (await invoke(proxied, "/oauth/token", "192.0.2.55", { grant_type: "client_credentials", client_id: "operator", client_secret: "wrong" }, { "x-forwarded-for": "198.51.100.1" })).status,
        401,
    );
    assert.equal(
        (await invoke(proxied, "/oauth/token", "192.0.2.55", { grant_type: "client_credentials", client_id: "operator", client_secret: "wrong" }, { "x-forwarded-for": "198.51.100.2" })).status,
        401,
    );
    assert.equal(
        (await invoke(proxied, "/oauth/token", "192.0.2.55", { grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret" }, { "x-forwarded-for": "198.51.100.3" })).status,
        429,
        "direct non-loopback socket ignores spoofed X-Forwarded-For",
    );

    // Once the failure window expires, 203.0.113.10 signs in again.
    now += 51_000;
    const recovered = await invoke(
        proxied,
        "/oauth/authorize",
        "127.0.0.1",
        { ...authForm, password: "lovelace" },
        { "x-forwarded-for": "203.0.113.10" },
    );
    assert.equal(recovered.status, 302, "address recovers after sliding window expires");
});



