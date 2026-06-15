import test from "node:test";
import assert from "node:assert/strict";
import ExecEnv from "./exec-env.ts";

test("ExecEnv.scoped keeps the project + standard env, drops plurnk's own (PLURNK_* + provider keys)", () => {
    const scoped = ExecEnv.scoped({
        PATH: "/usr/bin", HOME: "/home/u",      // standard shell — keep
        MY_PROJECT_KEY: "proj-secret",           // the project's own — keep
        OPENAI_API_KEY: "sk-plurnk-provider",    // a provider key plurnk reads — drop
        PLURNK_GIT_ALLOWED: "1",                 // plurnk config — drop
        PLURNK_DB_PATH: "./x.db",                // plurnk config — drop
    });
    assert.equal(scoped.PATH, "/usr/bin");
    assert.equal(scoped.HOME, "/home/u");
    assert.equal(scoped.MY_PROJECT_KEY, "proj-secret", "the project's own env reaches the subprocess");
    assert.equal(scoped.OPENAI_API_KEY, undefined, "a provider API key plurnk reads is stripped");
    assert.equal(scoped.PLURNK_GIT_ALLOWED, undefined, "PLURNK_* config is stripped");
    assert.equal(scoped.PLURNK_DB_PATH, undefined);
});
