import test from "node:test";
import assert from "node:assert/strict";
import { resolveModuleOptions, SCOPES } from "./config.ts";

const floor: NodeJS.ProcessEnv = {
    PLURNK_AGUI_SECRET: "",
    PLURNK_AGUI_ISSUER: "",
    PLURNK_AGUI_USER: "",
    PLURNK_AGUI_PASSWORD: "",
    PLURNK_AGUI_ACCESS_TTL_SEC: "3600",
    PLURNK_AGUI_REFRESH_TTL_SEC: "2592000",
    PLURNK_AGUI_LOGIN_ATTEMPTS: "5",
    PLURNK_AGUI_LOGIN_WINDOW_SEC: "60",
    PLURNK_AGUI_ALLOW_ORIGIN: "*",
    PLURNK_AGUI_MAX_TURNS: "",
    PLURNK_AGUI_HEARTBEAT_MS: "15000",
};

test("[{§agui-configuration}] AG-UI consumes and validates its package-owned environment", () => {
    assert.deepEqual(resolveModuleOptions({ env: floor }), {
        authenticates: false,
        secret: "",
        issuer: "",
        user: "",
        password: "",
        accessTtlSec: 3600,
        refreshTtlSec: 2592000,
        loginAttempts: 5,
        loginWindowSec: 60,
        clients: {},
        allowOrigin: "*",
        maxTurns: undefined,
        heartbeatMs: 15000,
    });
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_MAX_TURNS: "-1" } }).maxTurns, -1);
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_MAX_TURNS: "0" } }).maxTurns, 0);
    assert.deepEqual(SCOPES, ["agui"]);
});

test("[{§agui-configuration}] explicit in-process options override the assembled environment", () => {
    const resolved = resolveModuleOptions({
        secret: "explicit",
        issuer: "https://plurnk.example",
        user: "ada",
        password: "lovelace",
        accessTtlSec: 60,
        refreshTtlSec: 120,
        loginAttempts: 0,
        loginWindowSec: 1,
        clients: { agent: { secret: "s", scopes: ["agui"] } },
        allowOrigin: "https://portal.example",
        maxTurns: 3,
        heartbeatMs: 0,
        env: {
            ...floor,
            PLURNK_AGUI_SECRET: "environment",
            PLURNK_AGUI_ISSUER: "http://127.0.0.1:1",
            PLURNK_AGUI_USER: "env-user",
            PLURNK_AGUI_PASSWORD: "env-password",
            PLURNK_AGUI_CLIENT_other: JSON.stringify({ secret: "o", scopes: ["agui"] }),
            PLURNK_AGUI_MAX_TURNS: "7",
            PLURNK_AGUI_HEARTBEAT_MS: "25",
        },
    });
    assert.deepEqual(resolved, {
        authenticates: true,
        secret: "explicit",
        issuer: "https://plurnk.example",
        user: "ada",
        password: "lovelace",
        accessTtlSec: 60,
        refreshTtlSec: 120,
        loginAttempts: 0,
        loginWindowSec: 1,
        clients: { agent: { secret: "s", scopes: ["agui"] } },
        allowOrigin: "https://portal.example",
        maxTurns: 3,
        heartbeatMs: 0,
    });
    assert.equal(resolveModuleOptions({
        secret: "",
        env: { ...floor, PLURNK_AGUI_SECRET: "environment" },
    }).secret, "", "an explicit empty secret overrides the environment's");
    // {§agui-oauth} — the daemon authenticates when it holds anything to authenticate against.
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_SECRET: "s" } }).authenticates, true);
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_USER: "ada", PLURNK_AGUI_PASSWORD: "pw" } }).authenticates, true, "a sign-in alone");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_USER: "ada" } }).authenticates, false, "a user without a password is no sign-in");
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_CLIENT_agent: JSON.stringify({ secret: "s", scopes: ["agui"] }) } }).authenticates, true, "a declared client alone");
});

test("[{§agui-oauth-clients}] every PLURNK_AGUI_CLIENT_<id> line declares one confidential client, validated at the owner", () => {
    const declared = resolveModuleOptions({ env: {
        ...floor,
        PLURNK_AGUI_CLIENT_researcher: JSON.stringify({ secret: "r-secret", scopes: ["agui", "agui"] }),
        "PLURNK_AGUI_CLIENT_web.lane-2": JSON.stringify({ secret: "w", scopes: ["agui"] }),
    } }).clients;
    assert.deepEqual(declared, { "researcher": { secret: "r-secret", scopes: ["agui"] }, "web.lane-2": { secret: "w", scopes: ["agui"] } });
    const resolve = (key: string, value: string) => () => resolveModuleOptions({ env: { ...floor, [key]: value } });
    assert.throws(resolve("PLURNK_AGUI_CLIENT_bad", "not json"), /PLURNK_AGUI_CLIENT_bad must be a JSON object/u);
    assert.throws(resolve("PLURNK_AGUI_CLIENT_bad", "[]"), /must be a JSON object/u);
    assert.throws(resolve("PLURNK_AGUI_CLIENT_bad", JSON.stringify({ scopes: ["agui"] })), /needs a non-empty "secret"/u);
    assert.throws(resolve("PLURNK_AGUI_CLIENT_bad", JSON.stringify({ secret: "s" })), /needs "scopes", a non-empty array from \["agui"\]/u);
    assert.throws(resolve("PLURNK_AGUI_CLIENT_bad", JSON.stringify({ secret: "s", scopes: ["root"] })), /needs "scopes"/u);
    assert.throws(resolve("PLURNK_AGUI_CLIENT_operator", JSON.stringify({ secret: "s", scopes: ["agui"] })), /"operator" is the operator's own client/u);
    assert.throws(() => resolveModuleOptions({ clients: { operator: { secret: "s", scopes: ["agui"] } }, env: floor }), /"operator" is not a client id/u);
    assert.throws(() => resolveModuleOptions({ clients: { "no spaces": { secret: "s", scopes: ["agui"] } }, env: floor }), /"no spaces" is not a client id/u);
});

test("[{§agui-configuration}] missing and malformed configuration fails at the owner", () => {
    const resolve = (env: NodeJS.ProcessEnv) => resolveModuleOptions({ env });
    // {§operator-config-only-home} — an absent key is a broken floor, never a silently open listener.
    assert.throws(() => resolve({}), /PLURNK_AGUI_SECRET is missing from the assembled environment floor/);
    for (const key of ["PLURNK_AGUI_ISSUER", "PLURNK_AGUI_USER", "PLURNK_AGUI_PASSWORD", "PLURNK_AGUI_ALLOW_ORIGIN"]) {
        const env = { ...floor };
        delete env[key];
        assert.throws(() => resolve(env), new RegExp(`${key} is missing from the assembled environment floor`, "u"));
    }
    for (const key of ["PLURNK_AGUI_ACCESS_TTL_SEC", "PLURNK_AGUI_REFRESH_TTL_SEC", "PLURNK_AGUI_LOGIN_WINDOW_SEC"]) {
        assert.throws(() => resolve({ ...floor, [key]: "0" }), new RegExp(`${key} must be a safe integer from 1`, "u"));
        assert.throws(() => resolve({ ...floor, [key]: "" }), new RegExp(`${key} must be a safe integer`, "u"));
    }
    assert.throws(() => resolve({ ...floor, PLURNK_AGUI_LOGIN_ATTEMPTS: "-1" }), /PLURNK_AGUI_LOGIN_ATTEMPTS must be a safe integer from 0/u);
    assert.throws(() => resolve({ ...floor, PLURNK_AGUI_LOGIN_WINDOW_SEC: "2147484" }), /PLURNK_AGUI_LOGIN_WINDOW_SEC must be a safe integer from 1 through 2147483/u);
    assert.throws(() => resolve({ ...floor, PLURNK_AGUI_HEARTBEAT_MS: "many" }), /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/);
    assert.throws(() => resolve({ ...floor, PLURNK_AGUI_HEARTBEAT_MS: "-1" }), /from 0 through 2147483647/);
    assert.throws(() => resolve({ ...floor, PLURNK_AGUI_HEARTBEAT_MS: "2147483648" }), /from 0 through 2147483647/);
    assert.throws(
        () => resolve({ ...floor, PLURNK_AGUI_MAX_TURNS: "-2" }),
        /PLURNK_AGUI_MAX_TURNS must be a safe integer from -1 through 9007199254740991/,
    );
    assert.throws(
        () => resolveModuleOptions({ heartbeatMs: null as unknown as number, env: floor }),
        /ModuleOptions.heartbeatMs must be a safe integer/,
        "an invalid explicit option fails instead of falling through to the environment",
    );
    assert.throws(
        () => resolveModuleOptions({ maxTurns: "" as unknown as number, env: floor }),
        /ModuleOptions.maxTurns must be a safe integer/,
        "only an empty environment value means no module turn default",
    );
    assert.throws(() => resolveModuleOptions({ secret: 1 as unknown as string, env: floor }), /ModuleOptions.secret must be a string/u);
});
