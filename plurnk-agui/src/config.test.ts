import test from "node:test";
import assert from "node:assert/strict";
import { resolveModuleOptions } from "./config.ts";

const floor: NodeJS.ProcessEnv = {
    PLURNK_AGUI_TOKEN: "",
    PLURNK_AGUI_MAX_TURNS: "",
    PLURNK_AGUI_HEARTBEAT_MS: "15000",
};

test("[{§agui-configuration}] AG-UI consumes and validates its package-owned environment", () => {
    assert.deepEqual(resolveModuleOptions({ host: "127.0.0.1", port: 1066, env: floor }), {
        host: "127.0.0.1",
        port: 1066,
        token: "",
        maxTurns: undefined,
        heartbeatMs: 15000,
    });
    assert.equal(resolveModuleOptions({ host: "127.0.0.1", port: 0, env: { ...floor, PLURNK_AGUI_MAX_TURNS: "-1" } }).maxTurns, -1);
    assert.equal(resolveModuleOptions({ host: "127.0.0.1", port: 0, env: { ...floor, PLURNK_AGUI_MAX_TURNS: "0" } }).maxTurns, 0);
});

test("[{§agui-configuration}] explicit in-process options override the assembled environment", () => {
    assert.deepEqual(resolveModuleOptions({
        host: "localhost",
        port: 1,
        token: "explicit",
        maxTurns: 3,
        heartbeatMs: 0,
        env: {
            PLURNK_AGUI_TOKEN: "environment",
            PLURNK_AGUI_MAX_TURNS: "7",
            PLURNK_AGUI_HEARTBEAT_MS: "25",
        },
    }), {
        host: "localhost",
        port: 1,
        token: "explicit",
        maxTurns: 3,
        heartbeatMs: 0,
    });
    assert.equal(resolveModuleOptions({
        host: "localhost",
        port: 1,
        token: "",
        heartbeatMs: 0,
        env: { PLURNK_AGUI_TOKEN: "environment" },
    }).token, "", "an explicit empty token disables the environment's bearer requirement");
});

test("[{§agui-configuration}] missing and malformed numeric configuration fails at the owner", () => {
    const resolve = (env: NodeJS.ProcessEnv) => resolveModuleOptions({ host: "127.0.0.1", port: 0, env });
    assert.throws(() => resolve({}), /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/);
    assert.throws(() => resolve({ PLURNK_AGUI_HEARTBEAT_MS: "many" }), /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/);
    assert.throws(() => resolve({ PLURNK_AGUI_HEARTBEAT_MS: "-1" }), /from 0 through 2147483647/);
    assert.throws(() => resolve({ PLURNK_AGUI_HEARTBEAT_MS: "2147483648" }), /from 0 through 2147483647/);
    assert.throws(
        () => resolve({ PLURNK_AGUI_HEARTBEAT_MS: "15000", PLURNK_AGUI_MAX_TURNS: "-2" }),
        /PLURNK_AGUI_MAX_TURNS must be a safe integer from -1 through 9007199254740991/,
    );
    assert.throws(
        () => resolveModuleOptions({ host: "127.0.0.1", port: 0, heartbeatMs: null as unknown as number, env: floor }),
        /ModuleOptions.heartbeatMs must be a safe integer/,
        "an invalid explicit option fails instead of falling through to the environment",
    );
    assert.throws(
        () => resolveModuleOptions({ host: "127.0.0.1", port: 0, maxTurns: "" as unknown as number, env: floor }),
        /ModuleOptions.maxTurns must be a safe integer/,
        "only an empty environment value means no module turn default",
    );
});
