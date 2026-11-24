import assert from "node:assert/strict";
import test from "node:test";
import {
    SingleFlightRefresh,
    buildAuthorizationServerMetadataUrls,
    discoverAuthorizationServerMetadata,
    discoverProtectedResourceMetadata,
    generatePkcePair,
    isAllowedOAuthUrl,
    parseJwtExpiresAt,
    parseWwwAuthenticateResourceMetadata,
    resolveTokenExpiresAt,
} from "./OAuthClient.ts";

test("{§client-oauth-pkce} validates OAuth URLs, parses WWW-Authenticate, builds RFC 8414 path-aware metadata URLs, and discovers metadata", async () => {
    assert.equal(isAllowedOAuthUrl("https://auth.example.com/realms/main"), true);
    assert.equal(isAllowedOAuthUrl("http://127.0.0.1:8080/oauth"), true);
    assert.equal(isAllowedOAuthUrl("http://localhost:8080/oauth"), true);
    assert.equal(isAllowedOAuthUrl("http://[::1]:8080/oauth"), true);
    assert.equal(isAllowedOAuthUrl("http://auth.example.com/oauth"), false);
    assert.equal(isAllowedOAuthUrl("https://user:pass@auth.example.com"), false);
    assert.equal(isAllowedOAuthUrl("not-a-url"), false);

    assert.equal(
        parseWwwAuthenticateResourceMetadata(
            'Bearer realm="plurnk", resource_metadata="https://plurnk.example.com/.well-known/oauth-protected-resource"',
        ),
        "https://plurnk.example.com/.well-known/oauth-protected-resource",
    );
    assert.equal(
        parseWwwAuthenticateResourceMetadata('Bearer resource_metadata="http://evil.example/meta"'),
        null,
    );

    assert.deepEqual(buildAuthorizationServerMetadataUrls("https://idp.example.com/realms/dev"), [
        "https://idp.example.com/.well-known/oauth-authorization-server/realms/dev",
        "https://idp.example.com/realms/dev/.well-known/openid-configuration",
    ]);
    assert.deepEqual(buildAuthorizationServerMetadataUrls("https://idp.example.com"), [
        "https://idp.example.com/.well-known/oauth-authorization-server",
        "https://idp.example.com/.well-known/openid-configuration",
    ]);

    const fakeFetch: typeof fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://plurnk.example.com/.well-known/oauth-protected-resource") {
            return new Response(
                JSON.stringify({
                    resource: "https://plurnk.example.com",
                    authorization_servers: ["https://idp.example.com/realms/dev"],
                    scopes_supported: ["openid", "profile"],
                    client_id: "plurnk-cli",
                    redirect_uri: "http://127.0.0.1/callback",
                }),
                { status: 200 },
            );
        }
        if (url === "https://idp.example.com/.well-known/oauth-authorization-server/realms/dev") {
            return new Response("Not Found", { status: 404 });
        }
        if (url === "https://idp.example.com/realms/dev/.well-known/openid-configuration") {
            return new Response(
                JSON.stringify({
                    issuer: "https://idp.example.com/realms/dev",
                    authorization_endpoint: "https://idp.example.com/realms/dev/authorize",
                    token_endpoint: "https://idp.example.com/realms/dev/token",
                    registration_endpoint: "https://idp.example.com/realms/dev/register",
                    code_challenge_methods_supported: ["S256"],
                }),
                { status: 200 },
            );
        }
        return new Response("Not Found", { status: 404 });
    };

    const resource = await discoverProtectedResourceMetadata("https://plurnk.example.com", fakeFetch);
    assert.equal(resource.clientId, "plurnk-cli");
    assert.deepEqual(resource.authorizationServers, ["https://idp.example.com/realms/dev"]);

    const asMeta = await discoverAuthorizationServerMetadata("https://idp.example.com/realms/dev", fakeFetch);
    assert.equal(asMeta.tokenEndpoint, "https://idp.example.com/realms/dev/token");
    assert.equal(asMeta.registrationEndpoint, "https://idp.example.com/realms/dev/register");

    await assert.rejects(
        () =>
            discoverAuthorizationServerMetadata("https://idp.example.com", async () =>
                new Response(
                    JSON.stringify({
                        issuer: "https://other.example.com",
                        authorization_endpoint: "https://idp.example.com/auth",
                        token_endpoint: "https://idp.example.com/token",
                    }),
                    { status: 200 },
                )),
        /issuer mismatch/u,
    );
});

test("{§client-oauth-pkce} generates S256 PKCE pairs, preserves short-lived expires_in and JWT exp, and deduplicates concurrent refreshes", async () => {
    const pkce = await generatePkcePair();
    assert.equal(pkce.codeChallengeMethod, "S256");
    assert.ok(pkce.codeVerifier.length >= 43);
    assert.ok(pkce.codeChallenge.length >= 43);
    assert.notEqual(pkce.codeVerifier, pkce.codeChallenge);

    const payloadB64 = Buffer.from(JSON.stringify({ sub: "alice", exp: 1_900_000_005 })).toString("base64url");
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${payloadB64}.sig`;
    assert.equal(parseJwtExpiresAt(jwt), 1_900_000_005_000);
    assert.equal(parseJwtExpiresAt("opaque-token"), null);

    // Short TTL (5s) is preserved faithfully, never inflated to 60s
    assert.equal(resolveTokenExpiresAt(5, jwt, 1_000_000), 1_005_000);
    assert.equal(resolveTokenExpiresAt(undefined, jwt, 1_000_000), 1_900_000_005_000);
    assert.equal(resolveTokenExpiresAt(undefined, "opaque", 1_000_000), undefined);

    const singleFlight = new SingleFlightRefresh<number>();
    let calls = 0;
    const gate = Promise.withResolvers<number>();
    const p1 = singleFlight.run("https://plurnk.example.com", () => {
        calls += 1;
        return gate.promise;
    });
    const p2 = singleFlight.run("https://plurnk.example.com", async () => {
        calls += 1;
        return 999;
    });
    assert.equal(singleFlight.has("https://plurnk.example.com"), true);
    gate.resolve(42);
    assert.deepEqual(await Promise.all([p1, p2]), [42, 42]);
    assert.equal(calls, 1);
    assert.equal(singleFlight.has("https://plurnk.example.com"), false);
});
