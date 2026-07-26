import test from "node:test";
import assert from "node:assert/strict";
import ExecEnv from "./exec-env.ts";

test("ExecEnv.scoped keeps the project + standard env, drops plurnk's own (PLURNK_* + provider keys)", () => {
    const scoped = ExecEnv.scoped({
        PATH: "/usr/bin", HOME: "/home/u",      // standard shell — keep
        MY_PROJECT_KEY: "proj-secret",           // the project's own — keep
        OPENAI_API_KEY: "sk-plurnk-provider",    // a provider key plurnk reads — drop
        AWS_REGION: "us-east-1",                 // provider coordinate, not a secret — keep
        CLOUDFLARE_ACCOUNT_ID: "account",        // provider coordinate, not a secret — keep
        ACME_TOKEN: "secret",                    // declared provider secret — drop
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_TOKEN",
        PLURNK_API_KEY: "plurnk-bearer",         // the plurnk provider's optional cred — drop
        PLURNK_SERVICE_GIT_ALLOWED: "1",                 // plurnk config — drop
        PLURNK_SERVICE_DB_PATH: "./x.db",                // plurnk config — drop
    });
    assert.equal(scoped.PATH, "/usr/bin");
    assert.equal(scoped.HOME, "/home/u");
    assert.equal(scoped.MY_PROJECT_KEY, "proj-secret", "the project's own env reaches the subprocess");
    assert.equal(scoped.OPENAI_API_KEY, undefined, "a provider API key plurnk reads is stripped");
    assert.equal(scoped.AWS_REGION, "us-east-1");
    assert.equal(scoped.CLOUDFLARE_ACCOUNT_ID, "account");
    assert.equal(scoped.ACME_TOKEN, undefined);
    // The anonymous `plurnk` provider has no apiKeyVar (filtered from the denylist),
    // but its cred is PLURNK_-prefixed — so the prefix rule strips it anyway.
    assert.equal(scoped.PLURNK_API_KEY, undefined, "the plurnk provider's bearer cred is stripped by the PLURNK_ prefix — its empty apiKeyVar loses no secret");
    assert.equal(scoped.PLURNK_SERVICE_GIT_ALLOWED, undefined, "PLURNK_* config is stripped");
    assert.equal(scoped.PLURNK_SERVICE_DB_PATH, undefined);
});
