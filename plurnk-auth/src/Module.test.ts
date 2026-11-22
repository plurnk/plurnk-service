import assert from "node:assert/strict";
import test from "node:test";
import daemonModuleEntry from "./daemon-module.ts";
import { bootAuthModule, FLOOR, startMockOidcProvider } from "../test/harness.ts";
import { Module } from "./index.ts";

test("[{§auth-oauth}] unconfigured PLURNK_AUTH_ISSUER claims zero mounts, publishes no face, and mounts no HTTP routes", async (t) => {
    const hosted = await bootAuthModule();
    t.after(() => hosted.close());

    assert.deepEqual(hosted.module.mounts, []);
    assert.equal(hosted.credentials.face(), null);
    assert.equal(await hosted.credentials.verify("any-token"), null);

    const res = await fetch(`${hosted.base}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 404);

    const prevEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(FLOOR)) {
        prevEnv[k] = process.env[k];
        process.env[k] = v;
    }
    try {
        const fromDaemonEntry = daemonModuleEntry();
        assert.ok(fromDaemonEntry instanceof Module);
        assert.deepEqual(fromDaemonEntry.mounts, []);
    } finally {
        for (const [k, v] of Object.entries(prevEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test("[{§auth-oauth}] {§auth-configuration} RFC 9728 protected-resource metadata reflects resource origin, X-Forwarded headers on loopback, CORS, and callback hints", async (t) => {
    const idp = await startMockOidcProvider("/realms/plurnk");
    t.after(() => idp.close());

    const hosted = await bootAuthModule({
        PLURNK_AUTH_ISSUER: idp.issuer,
        PLURNK_AUTH_CLIENT_ID: "plurnk-web-client",
        PLURNK_AUTH_ALLOW_ORIGIN: "https://app.example.com",
    });
    t.after(() => hosted.close());

    assert.deepEqual(hosted.module.mounts, ["/.well-known/oauth-protected-resource"]);
    assert.equal(hosted.credentials.face()?.issuer(), hosted.base);
    assert.equal(
        hosted.credentials.face()?.issuer({
            headers: {
                "x-forwarded-proto": "https",
                "x-forwarded-host": "plurnk.example.com",
            },
        }),
        "https://plurnk.example.com",
    );

    const getRes = await fetch(`${hosted.base}/.well-known/oauth-protected-resource`, {
        headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "plurnk.example.com",
        },
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(getRes.headers.get("cache-control"), "no-store");
    assert.deepEqual(await getRes.json(), {
        resource: "https://plurnk.example.com",
        authorization_servers: [idp.issuer],
        scopes_supported: ["openid", "profile", "email"],
        bearer_methods_supported: ["header"],
        resource_name: "Plurnk",
        client_id: "plurnk-web-client",
        redirect_uri: "https://plurnk.example.com/auth/callback",
    });

    const headRes = await fetch(`${hosted.base}/.well-known/oauth-protected-resource`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "");

    const optRes = await fetch(`${hosted.base}/.well-known/oauth-protected-resource`, { method: "OPTIONS" });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), "https://app.example.com");

    const postRes = await fetch(`${hosted.base}/.well-known/oauth-protected-resource`, { method: "POST" });
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.get("allow"), "GET, HEAD, OPTIONS");

    const subPathRes = await fetch(`${hosted.base}/.well-known/oauth-protected-resource/extra`);
    assert.equal(subPathRes.status, 404);

    // Explicit PLURNK_AUTH_CALLBACK and empty PLURNK_AUTH_ALLOW_ORIGIN:
    const customCallback = await bootAuthModule({
        PLURNK_AUTH_ISSUER: idp.issuer,
        PLURNK_AUTH_CALLBACK: "https://frontend.example.com/oauth/cb",
        PLURNK_AUTH_ALLOW_ORIGIN: "",
    });
    t.after(() => customCallback.close());

    const cbRes = await fetch(`${customCallback.base}/.well-known/oauth-protected-resource`);
    assert.equal(cbRes.status, 200);
    assert.equal(cbRes.headers.get("access-control-allow-origin"), null);
    const cbJson = await cbRes.json() as { redirect_uri: string; client_id?: string };
    assert.equal(cbJson.redirect_uri, "https://frontend.example.com/oauth/cb");
    assert.equal(cbJson.client_id, undefined);

    customCallback.module.stop();
    const stoppingRes = await fetch(`${customCallback.base}/.well-known/oauth-protected-resource`);
    assert.equal(stoppingRes.status, 503);
});

test("[{§auth-oauth}] {§auth-configuration} OidcVerifier verifies ES256 JWKS tokens, audience, expiry, PLURNK_AUTH_USERS sub/email_verified matrix, RFC 8414 fallback, and recovery", async (t) => {
    const idp = await startMockOidcProvider("/realms/plurnk");
    t.after(() => idp.close());

    const hosted = await bootAuthModule({
        PLURNK_AUTH_ISSUER: idp.issuer,
        PLURNK_AUTH_CLIENT_ID: "plurnk-cli",
        PLURNK_AUTH_USERS: "sub-allowed,Alice@Example.com",
    });
    t.after(() => hosted.close());

    // 1. Transient discovery failure self-heals on next request.
    idp.setDiscoveryMode("broken");
    const validSubToken = await idp.sign({
        sub: "sub-allowed",
        aud: "plurnk-cli",
        scope: "openid profile",
    });
    assert.equal(await hosted.credentials.verify(validSubToken), null);

    // 2. Fallback to RFC 8414 authorization server metadata succeeds and verifies.
    idp.setDiscoveryMode("rfc8414");
    const verifiedSub = await hosted.credentials.verify(validSubToken);
    assert.ok(verifiedSub !== null);
    assert.equal(verifiedSub.subject, "sub-allowed");
    assert.deepEqual(verifiedSub.scopes, ["openid", "profile"]);
    assert.equal(typeof verifiedSub.expiresAt, "number");

    // 3. Verified email (`email_verified: true`) matches case-insensitively.
    const verifiedEmailToken = await idp.sign({
        sub: "google-uid-999",
        aud: "plurnk-cli",
        email: "alice@example.com",
        email_verified: true,
        scp: ["openid", "email"],
    });
    const verifiedEmail = await hosted.credentials.verify(verifiedEmailToken);
    assert.ok(verifiedEmail !== null);
    assert.equal(verifiedEmail.subject, "google-uid-999");
    assert.equal(verifiedEmail.email, "alice@example.com");
    assert.deepEqual(verifiedEmail.scopes, ["openid", "email"]);

    // 4. Unverified email (`email_verified: false` or omitted) is rejected even when email string matches!
    const unverifiedEmailToken = await idp.sign({
        sub: "google-uid-attacker",
        aud: "plurnk-cli",
        email: "alice@example.com",
        email_verified: false,
    });
    assert.equal(await hosted.credentials.verify(unverifiedEmailToken), null);

    // 5. Unauthorized user is rejected.
    const strangerToken = await idp.sign({
        sub: "bob-uid",
        aud: "plurnk-cli",
        email: "bob@example.com",
        email_verified: true,
    });
    assert.equal(await hosted.credentials.verify(strangerToken), null);

    // 6. Audience mismatch, issuer mismatch, wrong signature, expired token, missing exp, and blank token all reject.
    const wrongAud = await idp.sign({ sub: "sub-allowed", aud: "other-app" });
    assert.equal(await hosted.credentials.verify(wrongAud), null);

    const wrongIss = await idp.sign({ sub: "sub-allowed", aud: "plurnk-cli" }, { issuer: "https://evil.example.com" });
    assert.equal(await hosted.credentials.verify(wrongIss), null);

    const wrongKey = await idp.sign({ sub: "sub-allowed", aud: "plurnk-cli" }, { useWrongKey: true });
    assert.equal(await hosted.credentials.verify(wrongKey), null);

    const expired = await idp.sign({ sub: "sub-allowed", aud: "plurnk-cli" }, { expiresInSec: -60 });
    assert.equal(await hosted.credentials.verify(expired), null);

    const noExp = await idp.sign({ sub: "sub-allowed", aud: "plurnk-cli" }, { omitExp: true });
    assert.equal(await hosted.credentials.verify(noExp), null);

    assert.equal(await hosted.credentials.verify("   "), null);

    // 7. Discovery rejects mismatched metadata issuer and non-HTTPS non-loopback jwks_uri.
    const mismatchHosted = await bootAuthModule({ PLURNK_AUTH_ISSUER: idp.issuer });
    t.after(() => mismatchHosted.close());
    idp.setDiscoveryMode("mismatch-issuer");
    const unrestrictedToken = await idp.sign({ sub: "anyone" });
    assert.equal(await mismatchHosted.credentials.verify(unrestrictedToken), null);

    idp.setDiscoveryMode("insecure-jwks");
    assert.equal(await mismatchHosted.credentials.verify(unrestrictedToken), null);

    idp.setDiscoveryMode("oidc");
    const admittedAnyUser = await mismatchHosted.credentials.verify(unrestrictedToken);
    assert.equal(admittedAnyUser?.subject, "anyone");
});
