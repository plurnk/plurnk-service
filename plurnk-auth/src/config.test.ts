import test from "node:test";
import assert from "node:assert/strict";
import { resolveModuleOptions, SCOPES } from "./config.ts";

const floor: NodeJS.ProcessEnv = {
    PLURNK_AUTH: "0",
    PLURNK_PASS: "",
    PLURNK_AUTH_ISSUER: "",
    PLURNK_AUTH_ACCESS_TTL_SEC: "3600",
    PLURNK_AUTH_REFRESH_TTL_SEC: "2592000",
    PLURNK_AUTH_ALLOW_ORIGIN: "*",
};

test("[{§auth-configuration}] plurnk-auth consumes and validates its package-owned environment", () => {
    assert.deepEqual(resolveModuleOptions({ env: floor }), {
        authenticates: false,
        issuer: "",
        password: "",
        accessTtlSec: 3600,
        refreshTtlSec: 2592000,
        clients: {},
        allowOrigin: "*",
    });
    assert.deepEqual(SCOPES, ["acp"]);
});

test("[{§auth-configuration}] explicit in-process options override the assembled environment", () => {
    const resolved = resolveModuleOptions({
        auth: true,
        issuer: "https://plurnk.example",
        password: "lovelace",
        accessTtlSec: 60,
        refreshTtlSec: 120,
        clients: { agent: { secret: "s", scopes: ["acp"] } },
        allowOrigin: "https://portal.example",
        env: {
            ...floor,
            PLURNK_AUTH: "0",
            PLURNK_AUTH_ISSUER: "http://127.0.0.1:1",
            PLURNK_PASS: "env-password",
            PLURNK_AUTH_CLIENT_other: JSON.stringify({ secret: "o", scopes: ["acp"] }),
        },
    });
    assert.deepEqual(resolved, {
        authenticates: true,
        issuer: "https://plurnk.example",
        password: "lovelace",
        accessTtlSec: 60,
        refreshTtlSec: 120,
        clients: { agent: { secret: "s", scopes: ["acp"] } },
        allowOrigin: "https://portal.example",
    });
    assert.equal(resolveModuleOptions({ auth: false, env: { ...floor, PLURNK_AUTH: "1" } }).authenticates, false, "an explicit posture overrides the environment's");
});

test("[{§credential-authority}] the posture is PLURNK_AUTH alone, never inferred from a sign-in or a declared client", () => {
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "1" } }).authenticates, true);
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "1", PLURNK_PASS: "" } }).authenticates, true, "on without a password");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "0", PLURNK_PASS: "pw" } }).authenticates, false, "a password does not switch it on");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "0", PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "s", scopes: ["acp"] }) } }).authenticates, false, "a declared client does not switch it on");
    assert.throws(() => resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "yes" } }), /PLURNK_AUTH must be 0 or 1/u);
    assert.throws(() => resolveModuleOptions({ auth: "1" as unknown as boolean, env: floor }), /ModuleOptions.auth must be a boolean/u);
});

test("[{§auth-oauth-clients}] every PLURNK_AUTH_CLIENT_<id> line declares one confidential client, validated at the owner", () => {
    const declared = resolveModuleOptions({ env: {
        ...floor,
        PLURNK_AUTH_CLIENT_researcher: JSON.stringify({ secret: "r-secret", scopes: ["acp", "acp"] }),
        "PLURNK_AUTH_CLIENT_web.lane-2": JSON.stringify({ secret: "w", scopes: ["acp"] }),
    } }).clients;
    assert.deepEqual(declared, { "researcher": { secret: "r-secret", scopes: ["acp"] }, "web.lane-2": { secret: "w", scopes: ["acp"] } });
    const resolve = (key: string, value: string) => () => resolveModuleOptions({ env: { ...floor, [key]: value } });
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", "not json"), /PLURNK_AUTH_CLIENT_bad must be a JSON object/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", "[]"), /must be a JSON object/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ scopes: ["acp"] })), /needs a non-empty "secret"/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ secret: "s" })), /needs "scopes", a non-empty array from \["acp"\]/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ secret: "s", scopes: ["root"] })), /needs "scopes"/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_operator", JSON.stringify({ secret: "s", scopes: ["acp"] })), /"operator" is the operator's own client/u);
    assert.throws(() => resolveModuleOptions({ clients: { operator: { secret: "s", scopes: ["acp"] } }, env: floor }), /"operator" is not a client id/u);
    assert.throws(() => resolveModuleOptions({ clients: { "no spaces": { secret: "s", scopes: ["acp"] } }, env: floor }), /"no spaces" is not a client id/u);
});

test("[{§auth-configuration}] missing and malformed configuration fails at the owner", () => {
    const resolve = (env: NodeJS.ProcessEnv) => resolveModuleOptions({ env });
    assert.throws(() => resolve({}), /PLURNK_AUTH is missing from the assembled environment floor/);
    for (const key of ["PLURNK_AUTH_ISSUER", "PLURNK_PASS", "PLURNK_AUTH_ALLOW_ORIGIN"]) {
        const env = { ...floor };
        delete env[key];
        assert.throws(() => resolve(env), new RegExp(`${key} is missing from the assembled environment floor`, "u"));
    }
    for (const key of ["PLURNK_AUTH_ACCESS_TTL_SEC", "PLURNK_AUTH_REFRESH_TTL_SEC"]) {
        assert.throws(() => resolve({ ...floor, [key]: "0" }), new RegExp(`${key} must be a safe integer from 1`, "u"));
        assert.throws(() => resolve({ ...floor, [key]: "" }), new RegExp(`${key} must be a safe integer`, "u"));
    }
    assert.throws(() => resolveModuleOptions({ password: 1 as unknown as string, env: floor }), /ModuleOptions.password must be a string/u);
});
