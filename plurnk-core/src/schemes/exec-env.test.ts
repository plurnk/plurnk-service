import test, { describe } from "node:test";
import assert from "node:assert/strict";
import HostPaths from "../core/HostPaths.ts";
import ExecEnv from "./exec-env.ts";
import EntryGraph from "./_entry-graph.ts";
import ExecAbort from "./exec-abort.ts";

describe("exec-env", () => {
// The shipped ceiling, as declared in plurnk-core/.env.defaults. Held here as a literal so a
// change to the default is a change to a witness, not a silent widening of what a model's
// commands can read.
const SHIPPED = "PATH,HOME,USER,LOGNAME,SHELL,PWD,TMPDIR,TERM,TZ,LANG,LC_*";

test("{§execution-output-identity} ExecEnv.scoped strips plurnk's own (PLURNK_* + provider keys) beneath any policy", () => {
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
    // {§execution-output-identity} Ambient selectors cannot admit a reserved name.
    assert.equal(scoped.PLURNK_SERVICE_GIT_ALLOWED, undefined, "PLURNK_* config is stripped even when the policy names it");
    assert.equal(scoped.PLURNK_SERVICE_DB_PATH, undefined);
});

// {§execution-output-identity} — the ceiling: a command receives only the ambient names the policy names.
test("{§execution-output-identity} ExecEnv.scoped admits only the ambient names the policy names", () => {
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

test("{§execution-output-identity} ExecEnv.scoped: EXCLUDE narrows INHERIT without rewriting it", () => {
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

test("{§execution-output-identity} ExecEnv.scoped: an empty policy admits nothing ambient", () => {
    const scoped = ExecEnv.scoped({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/ssh" });
    assert.deepEqual(scoped, {}, "the allowlist is declared in .env.defaults; an empty one is a cleared policy, not an unconfigured install");
});

// {§execution-output-identity} Module-owned launches have a broader ambient base, not implicit provider credentials.
test("{§operator-config-precedence} ExecEnv.withoutOwnSecrets keeps the operator's environment and drops plurnk's own", () => {
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
    assert.equal(kept.OPENAI_API_KEY, undefined, "a provider credential is excluded from the ambient base");
    assert.equal(kept.PLURNK_SERVICE_DB_PATH, undefined, "nor plurnk's own configuration");
});

// {§operator-config-precedence} — the subprocess-common floors are declared by
// @plurnk/plurnk-execs and reach a spawn through the ceiling, which names them.
test("{§execution-output-identity} ExecEnv.scoped passes the declared subprocess floors through the ceiling", () => {
    const scoped = ExecEnv.scoped({
        PLURNK_SERVICE_EXEC_ENV_INHERIT: "PATH,PAGER,GIT_PAGER,NO_COLOR,CI",
        PATH: "/usr/bin", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", CI: "1",
    });
    assert.deepEqual(scoped, { PATH: "/usr/bin", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", CI: "1" },
        "a floor that the ceiling does not name would never reach the spawn that wants it");
});

test("{§execution-output-identity} {§host-path-layout} ExecEnv.scoped and ExecEnv.withoutOwnSecrets project the daemon's HostPaths before filtering", () => {
    const hostPaths = new HostPaths({
        home: "/tmp/isolated-home",
        env: { PLURNK_SERVICE_STATE_ROOT: "/tmp/isolated-state" },
    });
    const ambient = {
        PLURNK_SERVICE_EXEC_ENV_INHERIT: "PATH,HOME,XDG_*",
        PATH: "/usr/bin",
        HOME: "/home/operator",
        XDG_CONFIG_HOME: "/home/operator/.config",
        OPENAI_API_KEY: "sk-secret",
    };
    const scoped = ExecEnv.scoped(ambient, hostPaths);
    assert.equal(scoped.HOME, "/tmp/isolated-home");
    assert.equal(scoped.XDG_CONFIG_HOME, "/tmp/isolated-home/.config");
    assert.equal(scoped.XDG_DATA_HOME, "/tmp/isolated-state/data");
    assert.equal(scoped.OPENAI_API_KEY, undefined);

    const moduleBase = ExecEnv.withoutOwnSecrets(ambient, hostPaths);
    assert.equal(moduleBase.HOME, "/tmp/isolated-home");
    assert.equal(moduleBase.XDG_CONFIG_HOME, "/tmp/isolated-home/.config");
    assert.equal(moduleBase.XDG_RUNTIME_DIR, "/tmp/isolated-state/runtime");
    assert.equal(moduleBase.OPENAI_API_KEY, undefined);
});
});

describe("_entry-graph", () => {
test("{§operator-config-precedence} EntryGraph.storeBatch reads and validates the service-owned persistence knob", () => {
    const prior = process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH;
    try {
        process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = "37";
        assert.equal(EntryGraph.storeBatch(), 37);
        process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = "0";
        assert.throws(() => EntryGraph.storeBatch(), /safe integer of at least 1/);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH;
        else process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH = prior;
    }
});
});

describe("exec-abort", () => {
// These shapes ARE the wire contract with @plurnk/plurnk-execs' SubprocessExecutor:
// it reads `reason.signal` (overrideSignal) and `reason.housekeeping`/`reason.graceMs`
// (housekeepingGrace). A drift here silently defaults the executor to its SIGHUP polite-ask.

test("{§executor-cancellation} killReason: a numeric override delivers exactly that signal (the executor wire contract)", () => {
    assert.deepEqual(ExecAbort.killReason(9), { signal: 9 });   // SIGKILL
    assert.deepEqual(ExecAbort.killReason(15), { signal: 15 }); // SIGTERM
});

test("{§executor-cancellation} killReason: KILL without a signal override (null) carries no override — the executor's SIGHUP polite default", () => {
    assert.deepEqual(ExecAbort.killReason(null), { signal: null });
});

test("{§operator-config-precedence} teardownReason: a bounded housekeeping reap carrying the consumer's grace", () => {
    const r = ExecAbort.teardownReason();
    assert.equal(r.housekeeping, true);
    assert.equal(typeof r.graceMs, "number");
});

// {§operator-config-precedence} — the panel owns the value. An unset key is a broken floor and
// crashes by name.
test("{§operator-config-precedence} graceMs: the panel's value, read live; an unset or invalid key crashes by name", () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
    try {
        assert.equal(prior, "2000", "the suite runs on the package's own panel");
        assert.equal(ExecAbort.graceMs, 2000);
        process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "150";
        assert.equal(ExecAbort.graceMs, 150);
        assert.equal(ExecAbort.teardownReason().graceMs, 150);
        delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        assert.throws(() => ExecAbort.graceMs, /PLURNK_SERVICE_EXEC_KILL_GRACE_MS is missing from the assembled environment floor/);
        process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "soon";
        assert.throws(() => ExecAbort.graceMs, /must be a safe integer of at least 0; got "soon"/);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        else process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = prior;
    }
});
});
