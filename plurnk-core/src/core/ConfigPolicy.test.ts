import test from "node:test";
import assert from "node:assert/strict";
import ConfigPolicy from "./ConfigPolicy.ts";
import { OperationFailureError } from "./results.ts";

test("{§operator-config-precedence} hard floor refuses bind-time, host-confinement, and family-managed keys regardless of allowlist", () => {
    const wideOpen: NodeJS.ProcessEnv = { PLURNK_SERVICE_CLIENT_CONFIG: "*" };

    const bindTime = [
        "PLURNK_HOST",
        "PLURNK_PORT",
        "PLURNK_SERVICE_DB_PATH",
        "PLURNK_SERVICE_STATE_ROOT",
        "PLURNK_SERVICE_AUTO_VACUUM",
        "PLURNK_SERVICE_SQLITE_TIMEOUT_MS",
        "PLURNK_SERVICE_SQLITE_READERS",
        "PLURNK_AUTH_ISSUER",
        "PLURNK_AUTH_AUDIENCE",
    ];
    for (const key of bindTime) {
        assert.deepEqual(ConfigPolicy.classifyHostOnly(key), { kind: "bind-time" }, key);
        for (const scope of ["service", "workspace"] as const) {
            const decision = ConfigPolicy.checkEditable(key, scope, wideOpen);
            assert.equal(decision.ok, false, `${key} at ${scope}`);
            if (!decision.ok) {
                assert.equal(decision.status, 403);
                assert.equal(decision.code, "config-host-only");
            }
            const cliDecision = ConfigPolicy.checkEditable(key, scope, wideOpen, { enforceAllowlist: false });
            assert.equal(cliDecision.ok, false, `${key} even without allowlist`);
        }
    }

    const confinement = [
        "PLURNK_SERVICE_CLIENT_CONFIG",
        "PLURNK_SERVICE_PROJECT_ROOT_BASE",
        "PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV",
        "PLURNK_SERVICE_EXEC_ENV_INHERIT",
        "PLURNK_SERVICE_EXEC_ENV_EXCLUDE",
        "PLURNK_SERVICE_EXEC_SCRATCH",
        "PLURNK_SERVICE_EXEC_CONCURRENCY",
        "PLURNK_SERVICE_SHARE_FOLDER",
        "PLURNK_SERVICE_UPDATEABLE",
        "PLURNK_SERVICE_ROOTS",
        "PLURNK_SERVICE_POLICY",
        "PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN",
        "PLURNK_ACP_HISTORY_LOOPS",
        "PLURNK_EXECS_TIMEOUT_MS",
        "PLURNK_EXTENSIONS_PATHS",
        "PLURNK_OTEL_ENABLED",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "PLURNK_WEB_ENABLED",
    ];
    for (const key of confinement) {
        assert.deepEqual(ConfigPolicy.classifyHostOnly(key), { kind: "confinement" }, key);
        const decision = ConfigPolicy.checkEditable(key, "service", wideOpen);
        assert.equal(decision.ok, false, key);
        if (!decision.ok) {
            assert.equal(decision.status, 403);
            assert.equal(decision.code, "config-host-only");
        }
    }

    const familyManaged: ReadonlyArray<readonly [string, string]> = [
        ["PLURNK_MCP_github", "mcp"],
        ["PLURNK_MCP_WORKSPACE_TRANSPORTS", "mcp"],
        ["PLURNK_SKILLS_lint", "skills"],
        ["PLURNK_PERSONAS_reviewer", "personas"],
        ["PLURNK_SCHEDULE_nightly", "schedule"],
        ["PLURNK_MEMBERS_docs", "members"],
    ];
    for (const [key, family] of familyManaged) {
        assert.deepEqual(ConfigPolicy.classifyHostOnly(key), { kind: "family-managed", family }, key);
        const decision = ConfigPolicy.checkEditable(key, "service", wideOpen);
        assert.equal(decision.ok, false, key);
        if (!decision.ok) {
            assert.equal(decision.status, 403);
            assert.equal(decision.code, "config-family-managed");
            assert.equal(decision.extensions?.family, family);
        }
    }

    // PLURNK_MEMBERS_AUTO_ADD is a service behavior toggle, not a family definition.
    assert.equal(ConfigPolicy.classifyHostOnly("PLURNK_MEMBERS_AUTO_ADD"), null);
    assert.equal(ConfigPolicy.checkEditable("PLURNK_MEMBERS_AUTO_ADD", "service", wideOpen).ok, true);
});

test("{§operator-config-precedence} fail-safe allowlist parses none/empty closed and matches exact, prefix globs, and credentials", () => {
    assert.deepEqual(ConfigPolicy.parseAllowlist({}), []);
    assert.deepEqual(ConfigPolicy.parseAllowlist({ PLURNK_SERVICE_CLIENT_CONFIG: "" }), []);
    assert.deepEqual(ConfigPolicy.parseAllowlist({ PLURNK_SERVICE_CLIENT_CONFIG: "   " }), []);
    assert.deepEqual(ConfigPolicy.parseAllowlist({ PLURNK_SERVICE_CLIENT_CONFIG: "none" }), []);
    assert.deepEqual(ConfigPolicy.parseAllowlist({ PLURNK_SERVICE_CLIENT_CONFIG: "NONE" }), []);

    const env: NodeJS.ProcessEnv = {
        PLURNK_SERVICE_CLIENT_CONFIG: "PLURNK_MODEL, PLURNK_MODEL_*, credentials, TZ",
    };
    const allowlist = ConfigPolicy.parseAllowlist(env);
    assert.deepEqual(allowlist, ["PLURNK_MODEL", "PLURNK_MODEL_*", "credentials", "TZ"]);

    assert.equal(ConfigPolicy.matchesAllowlist("PLURNK_MODEL", allowlist, env), true);
    assert.equal(ConfigPolicy.matchesAllowlist("PLURNK_MODEL_FAST", allowlist, env), true);
    assert.equal(ConfigPolicy.matchesAllowlist("OPENAI_API_KEY", allowlist, env), true);
    assert.equal(ConfigPolicy.matchesAllowlist("TZ", allowlist, env), true);
    assert.equal(ConfigPolicy.matchesAllowlist("PLURNK_SERVICE_PROPOSALS", allowlist, env), false);

    // Closed allowlist refuses everything for client callers, while local CLI bypasses allowlist (never hard floor).
    const closed: NodeJS.ProcessEnv = { PLURNK_SERVICE_CLIENT_CONFIG: "none" };
    const blocked = ConfigPolicy.checkEditable("PLURNK_MODEL", "service", closed);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "config-not-allowed");
    assert.equal(ConfigPolicy.checkEditable("PLURNK_MODEL", "service", closed, { enforceAllowlist: false }).ok, true);
    assert.equal(ConfigPolicy.checkEditable("PLURNK_PORT", "service", closed, { enforceAllowlist: false }).ok, false);
});

test("{§operator-config-precedence} scope enforcement isolates secrets to service scope and restricts workspace keys to workspace-aware knobs", () => {
    const env: NodeJS.ProcessEnv = {
        PLURNK_SERVICE_CLIENT_CONFIG: "PLURNK_MODEL,PLURNK_SERVICE_WAIT_SEC,PLURNK_SERVICE_FILES_ITEMS,credentials",
    };

    const badName = ConfigPolicy.checkEditable("9INVALID", "service", env);
    assert.equal(badName.ok, false);
    if (!badName.ok) {
        assert.equal(badName.status, 400);
        assert.equal(badName.code, "config-key-invalid");
    }

    const svcSecret = ConfigPolicy.checkEditable("OPENAI_API_KEY", "service", env);
    assert.deepEqual(svcSecret, { ok: true, secret: true });

    const wsSecret = ConfigPolicy.checkEditable("OPENAI_API_KEY", "workspace", env);
    assert.equal(wsSecret.ok, false);
    if (!wsSecret.ok) {
        assert.equal(wsSecret.status, 403);
        assert.equal(wsSecret.code, "config-secret-service-only");
    }

    const svcDaemonOnly = ConfigPolicy.checkEditable("PLURNK_SERVICE_WAIT_SEC", "service", env);
    assert.deepEqual(svcDaemonOnly, { ok: true, secret: false });

    const wsDaemonOnly = ConfigPolicy.checkEditable("PLURNK_SERVICE_WAIT_SEC", "workspace", env);
    assert.equal(wsDaemonOnly.ok, false);
    if (!wsDaemonOnly.ok) {
        assert.equal(wsDaemonOnly.status, 400);
        assert.equal(wsDaemonOnly.code, "config-scope-unsupported");
    }

    const wsAllowed = ConfigPolicy.checkEditable("PLURNK_SERVICE_FILES_ITEMS", "workspace", env);
    assert.deepEqual(wsAllowed, { ok: true, secret: false });
});

test("{§operator-config-precedence} validateValue enforces typed constraints at write time", () => {
    const failsInvalid = (key: string, value: unknown): void => {
        assert.throws(
            () => ConfigPolicy.validateValue(key, value),
            (err: unknown) => err instanceof OperationFailureError
                && err.result.status === 400
                && err.result.problem?.type === "https://problems.plurnk.xyz/daemon/config/config-value-invalid",
            `expected config-value-invalid for ${key}=${JSON.stringify(value)}`,
        );
    };

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_GIT_ALLOWED", "0"), "0");
    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_GIT_ALLOWED", "1"), "1");
    failsInvalid("PLURNK_SERVICE_GIT_ALLOWED", "true");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_FILE_CREATE_SCOPE", "root"), "root");
    failsInvalid("PLURNK_SERVICE_FILE_CREATE_SCOPE", "everything");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_PROPOSALS", "accept"), "accept");
    failsInvalid("PLURNK_SERVICE_PROPOSALS", "auto");

    assert.equal(ConfigPolicy.validateValue("PLURNK_PROVIDERS_EFFORT", "high"), "high");
    failsInvalid("PLURNK_PROVIDERS_EFFORT", "turbo");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_EMISSION_HISTORY", "latest"), "latest");
    failsInvalid("PLURNK_SERVICE_EMISSION_HISTORY", "some");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_MAX_COMMANDS", "-1"), "-1");
    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_MAX_COMMANDS", "0"), "0");
    failsInvalid("PLURNK_SERVICE_MAX_COMMANDS", "-2");
    failsInvalid("PLURNK_SERVICE_MAX_COMMANDS", "1.5");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_OPTIMISTIC_WAIT_MS", "0"), "0");
    failsInvalid("PLURNK_SERVICE_OPTIMISTIC_WAIT_MS", "-1");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_WAIT_SEC", "30"), "30");
    failsInvalid("PLURNK_SERVICE_WAIT_SEC", "0");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", ""), "");
    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", "5000"), "5000");
    failsInvalid("PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", "0");
    failsInvalid("PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", "-5");

    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_BUDGET_PRESSURE", "80%"), "80%");
    assert.equal(ConfigPolicy.validateValue("PLURNK_SERVICE_BUDGET_PRESSURE", "100%"), "100%");
    failsInvalid("PLURNK_SERVICE_BUDGET_PRESSURE", "101%");
    failsInvalid("PLURNK_SERVICE_BUDGET_PRESSURE", "80");

    failsInvalid("PLURNK_MODEL", 42);
    failsInvalid("PLURNK_MODEL", "bad\0value");
    failsInvalid("PLURNK_MODEL", "bad\uD800surrogate");
});

test("{§operator-config-workspace-settings} composeCeiling strictly narrows ceiling keys and overrides ordinary keys", () => {
    // Boolean ceiling: 0 always wins.
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_GIT_ALLOWED", "1", "0"), "0");
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_GIT_ALLOWED", "0", "1"), "0");
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_GIT_ALLOWED", "1", "1"), "1");
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_GIT_ALLOWED", undefined, "1"), "1");

    // Scope lattice: none < root < namespace.
    for (const key of ["PLURNK_SERVICE_FILE_CREATE_SCOPE", "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE"]) {
        assert.equal(ConfigPolicy.composeCeiling(key, "namespace", "root"), "root");
        assert.equal(ConfigPolicy.composeCeiling(key, "root", "namespace"), "root");
        assert.equal(ConfigPolicy.composeCeiling(key, "root", "none"), "none");
        assert.equal(ConfigPolicy.composeCeiling(key, "none", "namespace"), "none");
        assert.equal(ConfigPolicy.composeCeiling(key, "none", "root"), "none");
    }

    // Integer caps: -1 is unlimited, finite min wins.
    for (const key of ["PLURNK_SERVICE_MAX_COMMANDS", "PLURNK_SERVICE_MAX_TURNS"]) {
        assert.equal(ConfigPolicy.composeCeiling(key, "-1", "10"), "10");
        assert.equal(ConfigPolicy.composeCeiling(key, "10", "-1"), "10");
        assert.equal(ConfigPolicy.composeCeiling(key, "10", "5"), "5");
        assert.equal(ConfigPolicy.composeCeiling(key, "5", "10"), "5");
        assert.equal(ConfigPolicy.composeCeiling(key, "5", "0"), "0");
        assert.equal(ConfigPolicy.composeCeiling(key, "-1", "-1"), "-1");
    }

    // Ordinary choice keys let inner tier override unconditionally.
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_MODEL", "openai/gpt-4o", "anthropic/claude"), "anthropic/claude");
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_FILES_ITEMS", "0", "25"), "25");
    assert.equal(ConfigPolicy.composeCeiling("PLURNK_SERVICE_PROPOSALS", "review", "accept"), "accept");
});
