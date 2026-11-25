import assert from "node:assert/strict";
import test from "node:test";
import { FLOOR } from "../test/harness.ts";
import { resolveModuleOptions } from "./config.ts";

test("[{§auth-configuration}] plurnk-auth defaults to disabled when PLURNK_AUTH_ISSUER is empty and validates package-owned knobs", () => {
    assert.deepEqual(resolveModuleOptions({ env: FLOOR }), {
        authenticates: false,
        issuer: "",
        clientId: "",
        audience: "",
        callbackUrl: "",
        scopes: ["openid", "profile", "email"],
        allowedUsers: [],
        delegates: [],
        allowOrigin: "*",
    });

    const google = resolveModuleOptions({
        env: {
            ...FLOOR,
            PLURNK_AUTH_ISSUER: "https://Accounts.Google.com",
            PLURNK_AUTH_CLIENT_ID: "12345.apps.googleusercontent.com",
            PLURNK_AUTH_USERS: " alice@example.com , 10987654321 ",
            PLURNK_AUTH_DELEGATES: " bridge-a , bridge-b , bridge-a ",
        },
    });
    assert.deepEqual(google, {
        authenticates: true,
        issuer: "https://accounts.google.com",
        clientId: "12345.apps.googleusercontent.com",
        audience: "12345.apps.googleusercontent.com",
        callbackUrl: "",
        scopes: ["openid", "profile", "email"],
        allowedUsers: ["alice@example.com", "10987654321"],
        delegates: ["bridge-a", "bridge-b"],
        allowOrigin: "*",
    });

    // Preserves path-prefixed OIDC issuers with or without trailing slash (Keycloak vs Authentik).
    assert.equal(
        resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "https://sso.example.com/realms/plurnk" } }).issuer,
        "https://sso.example.com/realms/plurnk",
    );
    assert.equal(
        resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "https://auth.example.com/application/o/plurnk/" } }).issuer,
        "https://auth.example.com/application/o/plurnk/",
    );
    assert.equal(
        resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "http://127.0.0.1:8080" } }).authenticates,
        true,
    );
    assert.equal(
        resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "http://[::1]:8080" } }).authenticates,
        true,
    );
});

test("[{§auth-configuration}] explicit ModuleOptions override environment values and reject malformed URLs or missing floor keys", () => {
    const customFetch = globalThis.fetch;
    const overridden = resolveModuleOptions({
        env: FLOOR,
        issuer: "https://id.example.com",
        clientId: "web-client",
        audience: "https://plurnk.example.com/acp",
        callbackUrl: "https://web.example.com/auth/callback",
        scopes: ["openid", "email"],
        allowedUsers: ["operator@example.com"],
        delegates: ["plurnkbot-bridge"],
        allowOrigin: "https://web.example.com",
        fetch: customFetch,
    });
    assert.deepEqual(overridden, {
        authenticates: true,
        issuer: "https://id.example.com",
        clientId: "web-client",
        audience: "https://plurnk.example.com/acp",
        callbackUrl: "https://web.example.com/auth/callback",
        scopes: ["openid", "email"],
        allowedUsers: ["operator@example.com"],
        delegates: ["plurnkbot-bridge"],
        allowOrigin: "https://web.example.com",
        fetch: customFetch,
    });

    for (const key of Object.keys(FLOOR)) {
        const partial = { ...FLOOR };
        delete partial[key];
        assert.throws(() => resolveModuleOptions({ env: partial }), new RegExp(`${key} is missing from the assembled environment floor`, "u"));
    }

    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "http://remote-idp.example.com" } }),
        /PLURNK_AUTH_ISSUER must use https:\/\//u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "https://id.example.com?foo=1" } }),
        /must not include credentials, query parameters, or fragments/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ISSUER: "not a url" } }),
        /must be a valid URL/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_CALLBACK: "https://web.example.com/cb#frag" } }),
        /without credentials or fragment/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_CALLBACK: "ftp://web.example.com/cb" } }),
        /must be an http\(s\) URL/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: { ...FLOOR, PLURNK_AUTH_ALLOW_ORIGIN: "https://web.example.com/path" } }),
        /single http\(s\) origin/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: FLOOR, issuer: 123 as unknown as string }),
        /ModuleOptions\.issuer must be a string/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: FLOOR, scopes: 123 as unknown as string }),
        /PLURNK_AUTH_SCOPES must be a string or string array/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: FLOOR, allowedUsers: 123 as unknown as string }),
        /PLURNK_AUTH_USERS must be a comma-separated string or string array/u,
    );
    assert.throws(
        () => resolveModuleOptions({ env: FLOOR, delegates: 123 as unknown as string }),
        /PLURNK_AUTH_DELEGATES must be a comma-separated string or string array/u,
    );
});
