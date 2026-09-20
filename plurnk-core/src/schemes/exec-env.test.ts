import test from "node:test";
import assert from "node:assert/strict";
import ExecEnv from "./exec-env.ts";

// The shipped ceiling, as declared in plurnk-core/.env.defaults. Held here as a literal so a
// change to the default is a change to a witness, not a silent widening of what a model's
// commands can read.
const SHIPPED = "PATH,HOME,USER,LOGNAME,SHELL,PWD,TMPDIR,TERM,TZ,LANG,LC_*";

test("ExecEnv.scoped strips plurnk's own (PLURNK_* + provider keys) beneath any policy", () => {
    const scoped = ExecEnv.scoped({
        PLURNK_SERVICE_EXEC_ENV_INHERIT: "PATH,HOME,MY_PROJECT_KEY,OPENAI_API_KEY,AWS_REGION,CLOUDFLARE_ACCOUNT_ID,ACME_TOKEN,PLURNK_*",
        PATH: "/usr/bin", HOME: "/home/u",      // standard shell — keep
        MY_PROJECT_KEY: "proj-secret",           // the project's own, admitted by policy — keep
        OPENAI_API_KEY: "sk-plurnk-provider",    // a provider key plurnk reads — drop
        AWS_REGION: "us-east-1",                 // provider coordinate, not a secret — keep
        CLOUDFLARE_ACCOUNT_ID: "account",        // provider coordinate, not a secret — keep
        ACME_TOKEN: "secret",                    // declared provider secret — drop
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_TOKEN",
        PLURNK_SERVICE_GIT_ALLOWED: "1",                 // plurnk config — drop
        PLURNK_SERVICE_DB_PATH: "./x.db",                // plurnk config — drop
    });
    assert.equal(scoped.PATH, "/usr/bin");
    assert.equal(scoped.HOME, "/home/u");
    assert.equal(scoped.MY_PROJECT_KEY, "proj-secret", "a policy-admitted project var reaches the subprocess");
    assert.equal(scoped.OPENAI_API_KEY, undefined, "a provider API key plurnk reads is stripped");
    assert.equal(scoped.AWS_REGION, "us-east-1");
    assert.equal(scoped.CLOUDFLARE_ACCOUNT_ID, "account");
    assert.equal(scoped.ACME_TOKEN, undefined);
    // The policy admitted `PLURNK_*` explicitly; the invariant strips it anyway. That is the
    // whole point of running the invariant last: no policy can readmit plurnk's own.
    assert.equal(scoped.PLURNK_SERVICE_GIT_ALLOWED, undefined, "PLURNK_* config is stripped even when the policy names it");
    assert.equal(scoped.PLURNK_SERVICE_DB_PATH, undefined);
});

// {§exec-env-scoped} — the ceiling. Before it, the filter was a denylist: it knew plurnk's
// credentials and nothing about the operator's, so it handed the ssh agent and the npm token
// to every command a model wrote.
test("ExecEnv.scoped admits only the ambient names the policy names", () => {
    const host = {
        PLURNK_SERVICE_EXEC_ENV_INHERIT: SHIPPED,
        PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
        SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
        NPM_TOKEN: "npm_live",
        TAVILY_API_KEY: "tvly-live",
        BRAVE_API_KEY: "brave-live",
    };
    const scoped = ExecEnv.scoped(host);
    assert.equal(scoped.PATH, "/usr/bin", "the shell still runs");
    assert.equal(scoped.LANG, "en_US.UTF-8");
    assert.equal(scoped.LC_ALL, "en_US.UTF-8", "a trailing-* glob admits the open-ended locale family");
    for (const name of ["SSH_AUTH_SOCK", "NPM_TOKEN", "TAVILY_API_KEY", "BRAVE_API_KEY"]) {
        assert.equal(scoped[name], undefined, `${name} is not named by the shipped ceiling and does not reach a spawn`);
    }
});

test("ExecEnv.scoped: EXCLUDE narrows INHERIT without rewriting it", () => {
    const scoped = ExecEnv.scoped({
        PLURNK_SERVICE_EXEC_ENV_INHERIT: SHIPPED,
        PLURNK_SERVICE_EXEC_ENV_EXCLUDE: "TERM,LC_*",
        PATH: "/usr/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8", LC_ALL: "C",
    });
    assert.equal(scoped.PATH, "/usr/bin");
    assert.equal(scoped.TERM, undefined, "an excluded exact name is removed after inherit");
    assert.equal(scoped.LC_ALL, undefined, "exclude takes the same glob shape as inherit");
    assert.equal(scoped.LANG, "en_US.UTF-8", "exclude narrows only what it names");
});

test("ExecEnv.scoped: an empty policy admits nothing ambient", () => {
    const scoped = ExecEnv.scoped({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/ssh" });
    assert.deepEqual(scoped, {}, "the allowlist is declared in .env.defaults; an empty one is a cleared policy, not an unconfigured install");
});

// {§exec-env-scoped} — plurnk's own tooling spawns (the skills registry CLI) run a binary the
// operator configured, not a command a model wrote. The ceiling would only break them; the
// invariant still applies, because plurnk's secrets have no business in any subprocess.
test("ExecEnv.withoutOwnSecrets keeps the operator's environment and drops plurnk's own", () => {
    const kept = ExecEnv.withoutOwnSecrets({
        PATH: "/usr/bin", npm_config_registry: "https://registry.npmjs.org/",
        HTTPS_PROXY: "http://proxy:3128",
        SSH_AUTH_SOCK: "/run/ssh",
        OPENAI_API_KEY: "sk-provider",
        PLURNK_SERVICE_DB_PATH: "./x.db",
    });
    assert.equal(kept.npm_config_registry, "https://registry.npmjs.org/", "an installer CLI keeps the operator's npm configuration");
    assert.equal(kept.HTTPS_PROXY, "http://proxy:3128", "and the proxy it needs to reach a registry");
    assert.equal(kept.SSH_AUTH_SOCK, "/run/ssh", "the ceiling does not apply: this binary is not model-authored");
    assert.equal(kept.OPENAI_API_KEY, undefined, "but a provider credential never reaches it");
    assert.equal(kept.PLURNK_SERVICE_DB_PATH, undefined, "nor plurnk's own configuration");
});

// {§operator-config-env-defaults} — the subprocess-common floors are declared by
// @plurnk/plurnk-execs and reach a spawn through the ceiling, which names them.
test("ExecEnv.scoped passes the declared subprocess floors through the ceiling", () => {
    const scoped = ExecEnv.scoped({
        PLURNK_SERVICE_EXEC_ENV_INHERIT: "PATH,PAGER,GIT_PAGER,NO_COLOR,CI",
        PATH: "/usr/bin", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", CI: "1",
    });
    assert.deepEqual(scoped, { PATH: "/usr/bin", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", CI: "1" },
        "a floor that the ceiling does not name would never reach the spawn that wants it");
});
