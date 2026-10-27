// {§auth-oauth-clients} {§credential-authority} — a daemon module's own confidential client (#1119):
// the token-mediating backend of RFC 10017 §6.2 authenticates at the token endpoint and brings PKCE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { admitted, basic, boot, form, hosted, json, pkce, register, rejected, sessionOf } from "../test/harness.ts";

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
        const wide = await authorize({ scope: "other" });
        assert.equal(new URL(wide.response.headers.get("location")!).searchParams.get("error"), "invalid_scope", "a scope the module did not register");
    } finally { await mod.close(); }
});

test("{§credential-authority} a module's redirect is its path on the issuer: the address the request reached by default, the configured public origin when one is set", async () => {
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

test("{§auth-oauth-clients} a module's grant joins the browser's sign-in: one family, listed once without a token, and ended from either side", async () => {
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

test("{§auth-oauth-clients} a sign-out stays signed out: the next visit meets the sign-in form and is given no session", async () => {
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

test("{§auth-oauth-clients} only a module's grant joins the sign-in: a consented client keeps its own grant, another browser its own sign-in, and a code not yet exchanged ends with its sign-in", async () => {
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

test("{§auth-oauth-clients} silence is for a module's own client: a registered public client is shown consent even when its redirect is on this daemon's origin", async () => {
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
