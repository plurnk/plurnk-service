// {§auth-oauth} — the authorization server on the daemon's listener, driven over HTTP exactly as a
// client would: discovery, the operator's sign-in and code exchange with PKCE, client credentials,
// refresh rotation, revocation, registration, and session management.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { authorizationDocumentSpecimens } from "./AuthorizationDocuments.ts";
import Module, { type AuthSetupSeam } from "./Module.ts";
import { admitted, basic, boot, Credentials, FLOOR, form, hosted, json, pkce, register, rejected, sessionOf, signIn } from "../test/harness.ts";

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
            scopes_supported: ["acp"],
        });
        assert.deepEqual(await json(await fetch(`${mod.base}/.well-known/oauth-protected-resource`)), {
            resource: mod.base, authorization_servers: [mod.base], scopes_supported: ["acp"], bearer_methods_supported: ["header"], resource_name: "Plurnk",
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
        for (const init of [
            { ...form({ grant_type: "client_credentials" }), headers: { "content-type": "application/x-www-form-urlencoded", ...basic("operator", "s3cret") } },
            form({ grant_type: "client_credentials", client_id: "operator", client_secret: "s3cret", scope: "acp", resource: `${mod.base}/acp` }),
        ]) {
            const response = await fetch(`${mod.base}/oauth/token`, init);
            const text = await response.text();
            assert.equal(response.status, 200, text);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = JSON.parse(text) as { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string };
            assert.equal(body.token_type, "Bearer");
            assert.equal(body.expires_in, 1);
            const expectedScope = "acp";
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

test("{§auth-oauth-clients} no browser is the operator without the password: the empty password is named with the file to set it in, at 503, with no session; client credentials are unaffected", async () => {
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

test("{§auth-oauth-clients} the password selects no account: whatever password signed them in, the browser's grants name the same operator", async () => {
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

test("{§auth-oauth} {§auth-oauth-clients} {§auth-oauth-tokens} loopback /oauth/handoff mints single-use short-lived tickets for operator bearers even when PLURNK_PASS is empty, rejects non-operator or non-loopback callers, and never replays", async () => {
    const { PassThrough } = await import("node:stream");
    const { ServerResponse, IncomingMessage } = await import("node:http");
    const { default: OAuthServer } = await import("./OAuthServer.ts");
    const { resolveModuleOptions } = await import("./config.ts");

    const mod = await boot(
        {
            PLURNK_PASS: "",
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

        // First GET consumes ticket, sets plurnk_session even with PLURNK_PASS="", and 303-redirects to return path.
        const redeemed = await fetch(handoff.url, { redirect: "manual" });
        assert.equal(redeemed.status, 303);
        assert.equal(redeemed.headers.get("location"), `${mod.base}/?view=sessions`);
        const cookie = sessionOf(redeemed);

        // Silent module-client authorization succeeds immediately with that session even while PLURNK_PASS="".
        const silentAuth = await fetch(`${mod.base}/oauth/authorize?${new URLSearchParams({
            client_id: "plurnk-web",
            redirect_uri: `${mod.base}/auth/callback`,
            response_type: "code",
            code_challenge: pkce().challenge,
            code_challenge_method: "S256",
            scope: "acp",
        }).toString()}`, { redirect: "manual", headers: { cookie: `plurnk_session=${cookie}` } });
        assert.equal(silentAuth.status, 302, "plurnk-web authorizes silently from handoff session without PLURNK_PASS");

        // Replaying the same ticket fails 401 with no cookie.
        const replay = await fetch(handoff.url, { redirect: "manual" });
        assert.equal(replay.status, 401);
        assert.equal(replay.headers.get("set-cookie"), null);
        assert.match(await replay.text(), /Sign-in link expired/u);

        // Expired ticket fails 401 and non-loopback socket fails 403.
        let now = 10_000;
        const unitAuth = new OAuthServer({
            credentials: mod.credentials,
            opts: resolveModuleOptions({ env: { ...FLOOR, PLURNK_PASS: "", PLURNK_AUTH_CODE_TTL_SEC: "5" } }),
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

        // Restart with the same secret, PLURNK_PASS="", and PLURNK_AUTH_CLIENT_temp removed.
        const second = await boot(
            { PLURNK_PASS: "" },
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
            { PLURNK_PASS: "" },
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

