import test from "node:test";
import assert from "node:assert/strict";
import { resolveModuleOptions, SCOPES } from "./config.ts";
import { hashPassword, hashPasswordSync, parsePasswordHash, verifyPassword } from "./password.ts";

const sampleHash = hashPasswordSync("lovelace", { cost: 1_024 });

const floor: NodeJS.ProcessEnv = {
    PLURNK_AUTH: "0",
    PLURNK_AUTH_PASSWORD_HASH: "",
    PLURNK_AUTH_FAILURE_LIMIT: "5",
    PLURNK_AUTH_FAILURE_WINDOW_SEC: "60",
    PLURNK_AUTH_KDF_CONCURRENCY: "2",
    PLURNK_AUTH_ISSUER: "",
    PLURNK_AUTH_CODE_TTL_SEC: "60",
    PLURNK_AUTH_ACCESS_TTL_SEC: "3600",
    PLURNK_AUTH_REFRESH_TTL_SEC: "2592000",
    PLURNK_AUTH_ALLOW_ORIGIN: "*",
};

test("[{§auth-configuration}] plurnk-auth consumes and validates its package-owned environment", () => {
    assert.deepEqual(resolveModuleOptions({ env: floor }), {
        authenticates: false,
        issuer: "",
        passwordHash: "",
        failureLimit: 5,
        failureWindowSec: 60,
        kdfConcurrency: 2,
        codeTtlSec: 60,
        accessTtlSec: 3600,
        refreshTtlSec: 2592000,
        clients: {},
        allowOrigin: "*",
    });
    assert.deepEqual(SCOPES, ["acp", "mcp", "notifications"]);
});

test("[{§auth-configuration}] explicit in-process options override the assembled environment", () => {
    const otherHash = hashPasswordSync("babbage", { cost: 1_024 });
    const resolved = resolveModuleOptions({
        auth: true,
        issuer: "https://plurnk.example",
        passwordHash: sampleHash,
        failureLimit: 3,
        failureWindowSec: 120,
        kdfConcurrency: 4,
        codeTtlSec: 30,
        accessTtlSec: 60,
        refreshTtlSec: 120,
        clients: { agent: { secret: "s", scopes: ["acp"] } },
        allowOrigin: "https://portal.example",
        env: {
            ...floor,
            PLURNK_AUTH: "0",
            PLURNK_AUTH_ISSUER: "http://127.0.0.1:1",
            PLURNK_AUTH_PASSWORD_HASH: otherHash,
            PLURNK_AUTH_FAILURE_LIMIT: "9",
            PLURNK_AUTH_FAILURE_WINDOW_SEC: "90",
            PLURNK_AUTH_KDF_CONCURRENCY: "8",
            PLURNK_AUTH_CLIENT_other: JSON.stringify({ secret: "o", scopes: ["acp"] }),
        },
    });
    assert.deepEqual(resolved, {
        authenticates: true,
        issuer: "https://plurnk.example",
        passwordHash: sampleHash,
        failureLimit: 3,
        failureWindowSec: 120,
        kdfConcurrency: 4,
        codeTtlSec: 30,
        accessTtlSec: 60,
        refreshTtlSec: 120,
        clients: { agent: { secret: "s", scopes: ["acp"] } },
        allowOrigin: "https://portal.example",
    });
    assert.equal(resolveModuleOptions({ auth: false, env: { ...floor, PLURNK_AUTH: "1" } }).authenticates, false, "an explicit posture overrides the environment's");
});

test("[{§credential-authority}] the posture is PLURNK_AUTH alone, never inferred from a sign-in or a declared client", () => {
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "1" } }).authenticates, true);
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "1", PLURNK_AUTH_PASSWORD_HASH: "" } }).authenticates, true, "on without a password hash");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "0", PLURNK_AUTH_PASSWORD_HASH: sampleHash } }).authenticates, false, "a password hash does not switch it on");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "0", PLURNK_AUTH_CLIENT_agent: JSON.stringify({ secret: "s", scopes: ["acp"] }) } }).authenticates, false, "a declared client does not switch it on");
    assert.throws(() => resolveModuleOptions({ env: { ...floor, PLURNK_AUTH: "yes" } }), /PLURNK_AUTH must be 0 or 1/u);
    assert.throws(() => resolveModuleOptions({ auth: "1" as unknown as boolean, env: floor }), /ModuleOptions.auth must be a boolean/u);
});

test("[{§auth-oauth-clients}] every PLURNK_AUTH_CLIENT_<id> line declares one confidential client, validated at the owner", () => {
    const declared = resolveModuleOptions({ env: {
        ...floor,
        PLURNK_AUTH_CLIENT_researcher: JSON.stringify({ secret: "r-secret", scopes: ["acp", "notifications", "acp"] }),
        "PLURNK_AUTH_CLIENT_web.lane-2": JSON.stringify({ secret: "w", scopes: ["mcp"] }),
    } }).clients;
    assert.deepEqual(declared, {
        "researcher": { secret: "r-secret", scopes: ["acp", "notifications"] },
        "web.lane-2": { secret: "w", scopes: ["mcp"] },
    });
    const resolve = (key: string, value: string) => () => resolveModuleOptions({ env: { ...floor, [key]: value } });
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", "not json"), /PLURNK_AUTH_CLIENT_bad must be a JSON object/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", "[]"), /must be a JSON object/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ scopes: ["acp"] })), /needs a non-empty "secret"/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ secret: "s" })), /needs "scopes", a non-empty array from \["acp","mcp","notifications"\]/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_bad", JSON.stringify({ secret: "s", scopes: ["root"] })), /needs "scopes"/u);
    assert.throws(resolve("PLURNK_AUTH_CLIENT_operator", JSON.stringify({ secret: "s", scopes: ["acp"] })), /"operator" is the operator's own client/u);
    assert.throws(() => resolveModuleOptions({ clients: { operator: { secret: "s", scopes: ["acp"] } }, env: floor }), /"operator" is not a client id/u);
    assert.throws(() => resolveModuleOptions({ clients: { "no spaces": { secret: "s", scopes: ["acp"] } }, env: floor }), /"no spaces" is not a client id/u);
});

test("[{§auth-configuration}] missing and malformed configuration fails at the owner", () => {
    const resolve = (env: NodeJS.ProcessEnv) => resolveModuleOptions({ env });
    assert.throws(() => resolve({}), /PLURNK_AUTH is missing from the assembled environment floor/);
    for (const key of ["PLURNK_AUTH_ISSUER", "PLURNK_AUTH_PASSWORD_HASH", "PLURNK_AUTH_ALLOW_ORIGIN"]) {
        const env = { ...floor };
        delete env[key];
        assert.throws(() => resolve(env), new RegExp(`${key} is missing from the assembled environment floor`, "u"));
    }
    for (const key of [
        "PLURNK_AUTH_FAILURE_LIMIT",
        "PLURNK_AUTH_FAILURE_WINDOW_SEC",
        "PLURNK_AUTH_KDF_CONCURRENCY",
        "PLURNK_AUTH_CODE_TTL_SEC",
        "PLURNK_AUTH_ACCESS_TTL_SEC",
        "PLURNK_AUTH_REFRESH_TTL_SEC",
    ]) {
        assert.throws(() => resolve({ ...floor, [key]: "0" }), new RegExp(`${key} must be a safe integer from 1`, "u"));
        assert.throws(() => resolve({ ...floor, [key]: "" }), new RegExp(`${key} must be a safe integer`, "u"));
    }
    assert.throws(() => resolveModuleOptions({ passwordHash: 1 as unknown as string, env: floor }), /ModuleOptions.passwordHash must be a string/u);
    for (const malformed of [
        "lovelace",
        "$scrypt$ln=14,r=8,p=1$salt$digest",
        "scrypt:512:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "scrypt:3000:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "scrypt:1048576:16:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "scrypt:16384:8:1:short:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA:short",
        "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAA!:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
        assert.throws(
            () => resolve({ ...floor, PLURNK_AUTH_PASSWORD_HASH: malformed }),
            /PLURNK_AUTH_PASSWORD_HASH must be empty or 'scrypt:<N>:<r>:<p>:<salt>:<digest>'/u,
            malformed,
        );
        assert.throws(() => parsePasswordHash(malformed), /PLURNK_AUTH_PASSWORD_HASH must be empty or 'scrypt:/u, malformed);
    }
});

test("[{§auth-configuration}] {§auth-oauth-clients} scrypt password hashes encode without '$' and PLURNK_AUTH_PASSWORD_HASH hot-reloads live", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    assert.ok(!encoded.includes("$"), "encoding is $-free so .env and shells never interpolate");
    assert.match(encoded, /^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/u);
    assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
    assert.equal(await verifyPassword("wrong password", encoded), false);
    assert.equal(await verifyPassword("", encoded), false);
    await assert.rejects(() => hashPassword(""), /Password must not be empty/u);
    assert.throws(() => hashPasswordSync(""), /Password must not be empty/u);

    const env: NodeJS.ProcessEnv = { ...floor, PLURNK_AUTH: "1", PLURNK_AUTH_PASSWORD_HASH: "" };
    const resolved = resolveModuleOptions({ env });
    assert.equal(resolved.passwordHash, "");
    env.PLURNK_AUTH_PASSWORD_HASH = encoded;
    assert.equal(resolved.passwordHash, encoded);
});
