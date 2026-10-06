import test from "node:test";
import assert from "node:assert/strict";
import { resolveModuleOptions } from "./config.ts";

const floor: NodeJS.ProcessEnv = {
    PLURNK_AGUI_TOKEN: "",
    PLURNK_AGUI_ALLOW_ORIGIN: "*",
    PLURNK_AGUI_MAX_TURNS: "",
    PLURNK_AGUI_HEARTBEAT_MS: "15000",
};

test("[{§agui-configuration}] AG-UI consumes and validates its package-owned environment", () => {
    assert.deepEqual(resolveModuleOptions({ env: floor }), {
        token: "",
        allowOrigin: "*",
        maxTurns: undefined,
        heartbeatMs: 15000,
    });
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_MAX_TURNS: "-1" } }).maxTurns, -1);
    assert.equal(resolveModuleOptions({ env: { ...floor, PLURNK_AGUI_MAX_TURNS: "0" } }).maxTurns, 0);
});

test("[{§agui-configuration}] explicit in-process options override the assembled environment", () => {
    assert.deepEqual(resolveModuleOptions({
        token: "explicit",
        allowOrigin: "https://portal.example",
        maxTurns: 3,
        heartbeatMs: 0,
        env: {
            PLURNK_AGUI_TOKEN: "environment",
            PLURNK_AGUI_ALLOW_ORIGIN: "*",
            PLURNK_AGUI_MAX_TURNS: "7",
            PLURNK_AGUI_HEARTBEAT_MS: "25",
        },
    }), {
        token: "explicit",
        allowOrigin: "https://portal.example",
        maxTurns: 3,
        heartbeatMs: 0,
    });
    assert.equal(resolveModuleOptions({
        token: "",
        heartbeatMs: 0,
        env: { PLURNK_AGUI_TOKEN: "environment", PLURNK_AGUI_ALLOW_ORIGIN: "*" },
    }).token, "", "an explicit empty token disables the environment's bearer requirement");
});

test("[{§agui-configuration}] missing and malformed numeric configuration fails at the owner", () => {
    const resolve = (env: NodeJS.ProcessEnv) => resolveModuleOptions({ env });
    // {§operator-config-only-home} — an absent token key is a broken floor, never a silently open listener.
    assert.throws(() => resolve({}), /PLURNK_AGUI_TOKEN is missing from the assembled environment floor/);
    assert.throws(() => resolve({ PLURNK_AGUI_TOKEN: "" }), /PLURNK_AGUI_ALLOW_ORIGIN is missing from the assembled environment floor/);
    const open = { PLURNK_AGUI_TOKEN: "", PLURNK_AGUI_ALLOW_ORIGIN: "*" };
    assert.throws(() => resolve(open), /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/);
    assert.throws(() => resolve({ ...open, PLURNK_AGUI_HEARTBEAT_MS: "many" }), /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/);
    assert.throws(() => resolve({ ...open, PLURNK_AGUI_HEARTBEAT_MS: "-1" }), /from 0 through 2147483647/);
    assert.throws(() => resolve({ ...open, PLURNK_AGUI_HEARTBEAT_MS: "2147483648" }), /from 0 through 2147483647/);
    assert.throws(
        () => resolve({ ...open, PLURNK_AGUI_HEARTBEAT_MS: "15000", PLURNK_AGUI_MAX_TURNS: "-2" }),
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
});
