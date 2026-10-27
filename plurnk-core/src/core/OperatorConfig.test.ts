import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import EnvCatalog from "./env-catalog.ts";
import HostPaths from "./HostPaths.ts";
import OperatorConfig from "./OperatorConfig.ts";
import ServiceTeardown from "./ServiceTeardown.ts";
import EnvDefaults from "./env-defaults.ts";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isZeroPinTuning, scrubZeroPinTuning } from "../../test/zero-pin.ts";

describe("OperatorConfig", () => {
test("{§operator-config-precedence} the seed is one dotenv front door with exact discovery signposts", () => {
    const seed = OperatorConfig.renderSeed();
    assert.match(seed, /^# Plurnk user configuration\./);
    assert.match(seed, /Full installed options: plurnk-service config defaults/);
    assert.match(seed, /PLURNK_MODEL_openrouter="openrouter\/qwen\/qwen3-coder"/);
    assert.match(seed, /PLURNK_MODEL_local="openai\/qwen"/);
    assert.match(seed, /PLURNK_PROVIDERS_GBNF_local=~\/\.config\/plurnk\/local\.gbnf/);
    assert.match(seed, /MCP SERVERS — complete definitions/);
    assert.match(seed, /PLURNK_MCP_brave=\{"name":"brave","type":"stdio"/);
    assert.match(seed, /PLURNK_MCP_brave_ENABLED=0/);
    assert.match(seed, /PLURNK_SCHEMES_HTTP_MATERIALIZER=tavily-extract/);
    assert.match(seed, /AGENT SKILLS — project skills live in \.agents\/skills/);
    assert.doesNotMatch(seed, /^(?!#).*PLURNK_MODEL=/m, "no model ships selected");
});

test("{§credential-authority} the seed teaches the posture and sets no credential: the daemon mints its secret at boot", () => {
    const seed = OperatorConfig.renderSeed();
    assert.match(seed, /^# PLURNK_SECRET=$/m, "the secret line is a commented teaching line, never a shipped value");
    assert.match(seed, /^# PLURNK_PASS=$/m);
    assert.doesNotMatch(seed, /^PLURNK_(?:AUTH|SECRET|PASS)=/m, "the shared panel's posture stands; the seed sets none of its keys");
    assert.equal(seed, OperatorConfig.renderSeed(), "the seed is one text, with nothing minted into it");
});

test("{§packet-inject} {§host-path-layout} first run creates private user-owned config once", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-operator-config-"));
    const paths = new HostPaths({ env: {}, home: join(root, "home") });
    const policySource = join(root, "policy.md");
    await writeFile(policySource, "# Policy\nOriginal.\n");
    try {
        assert.equal(await OperatorConfig.ensure(paths, policySource), true);
        assert.equal((await stat(paths.configDir)).mode & 0o777, 0o700);
        assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
        assert.equal((await stat(paths.policyFile)).mode & 0o777, 0o600);
        assert.match(await readFile(paths.configFile, "utf8"), /config defaults/);
        assert.equal(await readFile(paths.policyFile, "utf8"), "# Policy\nOriginal.\n");

        await writeFile(paths.configFile, "PLURNK_MODEL=mine\n");
        await writeFile(paths.policyFile, "# Mine\n");
        assert.equal(await OperatorConfig.ensure(paths, policySource), false);
        assert.equal(await readFile(paths.configFile, "utf8"), "PLURNK_MODEL=mine\n");
        assert.equal(await readFile(paths.policyFile, "utf8"), "# Mine\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§host-path-layout} an existing config directory suppresses partial reseeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-operator-config-existing-"));
    const paths = new HostPaths({ env: {}, home: join(root, "home") });
    const policySource = join(root, "policy.md");
    await writeFile(policySource, "# Policy\n");
    try {
        await mkdir(paths.configDir, { recursive: true });
        assert.equal(await OperatorConfig.ensure(paths, policySource), false);
        await assert.rejects(() => readFile(paths.configFile, "utf8"), /ENOENT/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} concurrent first starts publish one complete configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-operator-config-concurrent-"));
    const paths = new HostPaths({ env: {}, home: join(root, "home") });
    const policySource = join(root, "policy.md");
    await writeFile(policySource, "# Policy\nShared initial policy.\n");
    try {
        const starts = await Promise.all(Array.from({ length: 12 }, async () => {
            const created = await OperatorConfig.ensure(paths, policySource);
            return {
                created,
                config: await readFile(paths.configFile, "utf8"),
                policy: await readFile(paths.policyFile, "utf8"),
            };
        }));
        assert.equal(starts.filter(({ created }) => created).length, 1);
        for (const start of starts) {
            assert.equal(start.config, starts[0].config);
            assert.match(start.config, /^# PLURNK_SECRET=$/m);
            assert.equal(start.policy, "# Policy\nShared initial policy.\n");
        }
        assert.deepEqual(await readdir(paths.configHome), ["plurnk"], "losing initializers remove only their staging directories");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§host-path-layout} a partial first-run write rolls back the owned config home", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-operator-config-rollback-"));
    const paths = new HostPaths({ env: {}, home: join(root, "home") });
    const policySource = join(root, "policy.md");
    await writeFile(policySource, "# Policy\n");
    Object.defineProperty(paths, "policyFile", { value: paths.configFile });
    try {
        await assert.rejects(() => OperatorConfig.ensure(paths, policySource), /EEXIST/);
        await assert.rejects(() => stat(paths.configDir), /ENOENT/);
        await assert.rejects(() => readFile(paths.configFile, "utf8"), /ENOENT/);
        assert.deepEqual(await readdir(paths.configHome), [], "a failed seed leaves no partial configuration or staging directory");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} an operator file's undeclared daemon keys, in file order; other components' and non-plurnk keys pass", () => {
    const declares = EnvCatalog.declares([{
        owner: "@plurnk/plurnk-fixture", parsed: {},
        text: "PLURNK_FIXTURE_EFFORT=adaptive\n# PLURNK_MODEL=cloud\n# PLURNK_MCP_<alias>=<definition>\n",
    }]);
    const text = [
        "# PLURNK_COMMENTED_OUT=1",
        "PLURNK_FIXTURE_TYPO=1",
        "PLURNK_FIXTURE_EFFORT=low",           // declared
        "PLURNK_FIXTURE_EFFORT_deep12=off",    // a declared name's scope
        "PLURNK_MODEL_deep12=deepseek/v4",     // the scope of a commented declaration
        "PLURNK_MCP_brave_TOOLS=[]",           // a family member
        "PLURNK_CLIENT_COLOR=0",               // the client's
        "PLURNK_BENCHLET_TIMEOUT=1",           // the bench's
        "PLURNK_SWEBENCH_RESOLV_CONF=/etc/x",  // the bench's
        "PLURNK_PI_MODEL=fixture",             // the bench's
        "PLURNK_CANDIDATE_GRADE_DEADLINE_SEC=1", // the bench's
        "PLURNK_COMPOSITION_ROOT=/tmp/x",      // the client's
        "OPENROUTER_API_KEY=fixture",          // not the daemon's namespace
        "PLURNK_UNREAD_KNOB=1",
    ].join("\n");
    assert.deepEqual(OperatorConfig.undeclared(text, declares), ["PLURNK_FIXTURE_TYPO", "PLURNK_UNREAD_KNOB"]);
});
});

describe("ServiceTeardown", () => {
test("{§module-shutdown-order} service teardown releases admitted resources in reverse ownership order, exactly once", async () => {
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); },
        ["observability shutdown", async () => { calls.push("observability.shutdown"); }],
        ["database close", async () => { calls.push("db.close"); }],
        ["HTTP listener close", async () => { calls.push("listener.close"); }],
    );

    await Promise.all([teardown.close(), teardown.close()]);

    assert.deepEqual(calls, ["daemon.stop", "observability.shutdown", "db.close", "listener.close"]);
});

test("{§module-shutdown-order} service teardown runs observability and database phases after daemon failure and preserves every failure", async () => {
    const daemonFailure = new Error("daemon stop failed");
    const observabilityFailure = new Error("observability shutdown failed");
    const databaseFailure = new Error("database close failed");
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); throw daemonFailure; },
        ["observability shutdown", async () => { calls.push("observability.shutdown"); throw observabilityFailure; }],
        ["database close", async () => { calls.push("db.close"); throw databaseFailure; }],
    );

    await assert.rejects(
        () => teardown.close(),
        (cause: unknown) => {
            assert.ok(cause instanceof AggregateError);
            assert.equal(cause.message, "service shutdown failed");
            assert.deepEqual(cause.errors, [daemonFailure, observabilityFailure, databaseFailure]);
            return true;
        },
    );
    assert.deepEqual(calls, ["daemon.stop", "observability.shutdown", "db.close"]);
});

test("{§startup-admission} failed startup preserves the originating failure and every teardown failure", async () => {
    const startupFailure = new Error("daemon start failed");
    const daemonFailure = new Error("daemon stop failed");
    const observabilityFailure = new Error("observability shutdown failed");
    const databaseFailure = new Error("database close failed");
    const teardown = new ServiceTeardown(
        async () => { throw daemonFailure; },
        ["observability shutdown", async () => { throw observabilityFailure; }],
        ["database close", async () => { throw databaseFailure; }],
    );

    await assert.rejects(
        () => teardown.fail(startupFailure),
        (cause: unknown) => {
            assert.ok(cause instanceof AggregateError);
            assert.equal(cause.message, "service startup and shutdown failed");
            assert.deepEqual(cause.errors, [startupFailure, daemonFailure, observabilityFailure, databaseFailure]);
            return true;
        },
    );
});

test("{§startup-admission} failed startup rethrows its exact failure when teardown succeeds", async () => {
    const startupFailure = new Error("daemon start failed");
    const teardown = new ServiceTeardown(async () => {});

    await assert.rejects(
        () => teardown.fail(startupFailure),
        (cause: unknown) => cause === startupFailure,
    );
});

test("{§module-shutdown-order} a repeated signal request performs and reports failed teardown once", async () => {
    const failure = new Error("daemon stop failed");
    let stops = 0;
    let closes = 0;
    const reported: unknown[] = [];
    let resolveReport: (() => void) | undefined;
    const reportReceived = new Promise<void>((resolve) => { resolveReport = resolve; });
    const teardown = new ServiceTeardown(
        async () => { stops += 1; throw failure; },
        ["observability shutdown", async () => {}],
        ["database close", async () => { closes += 1; }],
    );
    const report = (cause: unknown): void => {
        reported.push(cause);
        resolveReport?.();
    };

    teardown.request(report);
    teardown.request(report);
    await reportReceived;

    assert.equal(stops, 1);
    assert.equal(closes, 1);
    assert.deepEqual(reported, [failure]);
});

test("{§module-shutdown-order} a clean request reports its settlement once, to the closed callback alone", async () => {
    let closes = 0;
    let closed = 0;
    const reported: unknown[] = [];
    let resolveClosed: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const teardown = new ServiceTeardown(async () => { closes += 1; });
    const onClosed = (): void => { closed += 1; resolveClosed?.(); };
    teardown.request((cause) => { reported.push(cause); }, onClosed);
    teardown.request((cause) => { reported.push(cause); }, onClosed);
    await settled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes, 1, "the teardown ran once");
    assert.equal(closed, 1, "settlement was reported once");
    assert.deepEqual(reported, [], "nothing failed, so nothing was reported as a failure");
});

test("{§module-shutdown-order} service teardown diagnostics enumerate aggregate failures", () => {
    const cause = new AggregateError([
        new Error("daemon stop failed"),
        new Error("database close failed"),
    ], "service shutdown failed");

    assert.equal(
        ServiceTeardown.diagnostic("shutdown", cause),
        "shutdown: service shutdown failed\n"
        + "  1. daemon stop failed\n"
        + "  2. database close failed\n",
    );
});

for (const phase of ["observability shutdown", "database close", "HTTP listener close"]) {
test(`{§module-shutdown-order} ${phase} cannot outlive the enclosing shutdown budget`, async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "20";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const pending = Promise.withResolvers<void>();
    let laterCleanup = false;
    const teardown = new ServiceTeardown(
        async () => {},
        [phase, async () => pending.promise],
        ["later cleanup", async () => { laterCleanup = true; }],
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
        await assert.rejects(Promise.race([
            teardown.close(),
            // A liveness bound: the subject is the 20 ms stop budget; this only names a teardown that never settles.
            new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("test guard: service cleanup remained unbounded")), 20_000); }),
        ]), { message: `stop deadline exceeded waiting for ${phase}` });
        assert.equal(laterCleanup, true, "later cleanup is attempted even after the deadline");
    } finally {
        clearTimeout(guard);
        pending.resolve();
        await teardown.close().catch((cause) => { assert.match(String(cause), /stop deadline exceeded/); });
    }
});
}

test("{§module-shutdown-order} nested drains and later cleanup share the original deadline", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "100";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const nested = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>();
    const stuck = Promise.withResolvers<void>();
    const teardown = new ServiceTeardown(
        async (deadline) => {
            const result = deadline.settle("nested drain", () => new Promise<void>((resolve) => setTimeout(resolve, 60)));
            nested.resolve();
            assert.equal((await result).status, "fulfilled");
        },
        ["database close", async () => { later.resolve(); await stuck.promise; }],
    );
    const closed = assert.rejects(teardown.close(), { message: "stop deadline exceeded waiting for database close" });
    await nested.promise;
    t.mock.timers.tick(60);
    await later.promise;
    t.mock.timers.tick(40);
    await closed;
    stuck.resolve();
});

test("{§module-shutdown-order} an expired producer drain still closes observers before enclosing resources", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "20";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const events: string[] = [];
    const stuck = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const teardown = new ServiceTeardown(
        async (deadline) => {
            const waiting = deadline.settle("producer drain", () => stuck.promise);
            entered.resolve();
            const result = await waiting;
            events.push("observers closed");
            if (result.status === "rejected") throw result.reason;
        },
        ["database close", async () => { events.push("database closed"); }],
    );
    try {
        const closed = assert.rejects(teardown.close(), { message: "stop deadline exceeded waiting for producer drain" });
        await entered.promise;
        t.mock.timers.tick(20);
        await closed;
        assert.deepEqual(events, ["observers closed", "database closed"]);
    } finally { stuck.resolve(); }
});
});

describe("env-catalog", () => {
const FILES = [
    {
        owner: "@plurnk/plurnk-execs",
        parsed: {},
        text: [
            "# Comma-separated allowlist; unset = all discovered runtimes.",
            "# PLURNK_EXECS_ONLY=sh,js",
            "# A pager that waits for a keypress hangs a spawn that has no terminal.",
            "PAGER=cat",
            "# Colour escapes are noise in a captured channel.",
            "NO_COLOR=1",
        ].join("\n"),
    },
    {
        owner: "@plurnk/plurnk-mcp",
        parsed: {},
        text: "# Connection and protocol-discovery deadline, positive ms.\nPLURNK_MCP_CONNECT_TIMEOUT=30000",
    },
];

test("{§env-functionality} EnvCatalog.declarations carries each knob's own comment, and a commented knob is a knob", () => {
    const found = EnvCatalog.declarations(FILES[0].text);
    assert.deepEqual(found.map(({ name }) => name), ["PLURNK_EXECS_ONLY", "PAGER", "NO_COLOR"],
        "an optional declaration is written commented out; it stays findable by name");
    assert.match(found[1].text, /keypress hangs a spawn/u, "a declaration carries the comment that introduces it");
});

test("{§env-functionality} EnvCatalog.project with no query is the whole catalog", () => {
    const all = EnvCatalog.project(FILES);
    assert.match(all, /PAGER=cat/u);
    assert.match(all, /PLURNK_MCP_CONNECT_TIMEOUT=30000/u);
    assert.match(all, /═══ @plurnk\/plurnk-execs ═══/u, "owner-labelled, in the same form `config defaults` prints");
});

test("{§env-functionality} EnvCatalog.project filters by owning package", () => {
    const mcp = EnvCatalog.project(FILES, { source: "@plurnk/plurnk-mcp" });
    assert.match(mcp, /PLURNK_MCP_CONNECT_TIMEOUT/u);
    assert.doesNotMatch(mcp, /PAGER/u, "a source filter answers 'what does this package let me change'");
});

test("{§env-functionality} EnvCatalog.project matches the declaration name or its comment, never its value", () => {
    const pager = EnvCatalog.project(FILES, { query: "pager" });
    assert.match(pager, /PAGER=cat/u);
    assert.doesNotMatch(pager, /PLURNK_MCP_CONNECT_TIMEOUT/u);
    // A Session looks for a variable by what it is for before it knows what it is called.
    const deadline = EnvCatalog.project(FILES, { query: "deadline" });
    assert.match(deadline, /PLURNK_MCP_CONNECT_TIMEOUT/u, "the comment that documents a name is a match");
    assert.doesNotMatch(deadline, /PAGER=cat/u);
    // `cat` is the VALUE of PAGER. Matching values would hand the model bytes it did not ask
    // to see; the model's own context hygiene is reason enough, before any secrecy argument.
    assert.equal(EnvCatalog.project(FILES, { query: "cat" }).includes("PAGER=cat"), false,
        "a value match is not a match");
});

test("{§env-functionality} EnvCatalog.project keeps the comment with its declaration when filtered", () => {
    const one = EnvCatalog.project(FILES, { query: "NO_COLOR" });
    assert.match(one, /# Colour escapes are noise in a captured channel\.\nNO_COLOR=1/u,
        "a filtered declaration arrives documented, which is the point of projecting the source text");
});

test("{§functionality-model-projection} EnvCatalog.project drops a package with no match rather than rendering an empty section", () => {
    assert.doesNotMatch(EnvCatalog.project(FILES, { query: "PAGER" }), /plurnk-mcp/u);
});

// {§functionality-model-projection} — discover returns structured candidates, not rendered text:
// the family contract requires one addable definition per candidate. The declaration's comment
// becomes the candidate's summary and the owning package its provenance, so the documentation
// moves into the field that exists for it rather than being lost.
test("{§env-functionality} EnvCatalog.candidates carries the comment as summary and the package as provenance", () => {
    const [first] = EnvCatalog.candidates(FILES, { query: "PAGER" });
    assert.equal(first.alias, "PAGER");
    assert.equal(first.summary, "A pager that waits for a keypress hangs a spawn that has no terminal.");
    assert.deepEqual(first.definition, { value: "cat" });
    assert.equal(first.provenance.source, "@plurnk/plurnk-execs");
});

test("{§env-functionality} EnvCatalog.candidates drops a section header, which introduces a region and not a key", () => {
    const [only] = EnvCatalog.candidates([{
        owner: "@plurnk/x", parsed: {},
        text: "# ── Defaults (floor-set) ───────────────\n# The real documentation.\nTHING=1",
    }]);
    assert.equal(only.summary, "The real documentation.", "prose never begins with a run of rule characters");
});

// The security property the ceiling exists for, at the discovery surface: the catalog projects
// what a package DECLARED, never what the operator filled in. A model learns the name and the
// purpose so it can ask for the key by name, and never sees the value.
test("{§env-functionality} EnvCatalog.candidates projects the declared value, never an operator's", () => {
    const [credential] = EnvCatalog.candidates([{
        owner: "@plurnk/plurnk-tavily-plugin", parsed: {},
        text: "# Tavily API key; unset disables the materializer.\nTAVILY_API_KEY=",
    }]);
    assert.equal(credential.definition.value, "", "the declaration is empty even when the host has one set");
    assert.match(credential.summary!, /unset disables/u, "the model learns what it is for, so it can ask by name");
});

test("{§operator-config-precedence} EnvCatalog.candidates omits summary rather than inventing one", () => {
    const [bare] = EnvCatalog.candidates([{ owner: "@plurnk/x", parsed: {}, text: "BARE=1" }]);
    assert.equal(bare.summary, undefined, "a templated instance is self-documenting; an empty string would be a lie");
});

// {§operator-config-precedence} — a `<placeholder>` in a declared name declares a family.
const FAMILIES = {
    owner: "@plurnk/plurnk-fixture",
    parsed: {},
    text: [
        "# Per-alias switch.",
        "PLURNK_FIXTURE_EFFORT=adaptive",
        "# PLURNK_FIXTURE_BUDGET=8192",
        "# Any alias: its definition and its own controls.",
        "# PLURNK_FIXTURE_DEF_<alias>=<definition>",
        "# PLURNK_FIXTURE_PROVIDER_<NAME>_<SETTING>=<value>",
        "# What a pager does.",
        "PAGER=cat",
    ].join("\n"),
};

test("{§operator-config-precedence} a family declaration is its own declaration, never prose documenting the next key", () => {
    const found = EnvCatalog.declarations(FAMILIES.text);
    assert.deepEqual(found.map(({ name }) => name), [
        "PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PLURNK_FIXTURE_DEF_<alias>", "PLURNK_FIXTURE_PROVIDER_<NAME>_<SETTING>", "PAGER",
    ]);
    assert.equal(found.at(-1)!.text, "# What a pager does.\nPAGER=cat", "the family's lines stay with the family");
    assert.deepEqual(EnvCatalog.candidates([FAMILIES]).map(({ alias }) => alias), ["PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PAGER"],
        "a family is no name a Session can set, so it is no candidate");
});

test("{§operator-config-precedence} a key is declared by name, as a declared name's scope, or as a family member", () => {
    const declares = EnvCatalog.declares([FAMILIES]);
    for (const key of [
        "PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PAGER",          // by name, live or commented
        "PLURNK_FIXTURE_EFFORT_deep12", "PLURNK_FIXTURE_BUDGET_my-box.2",   // a declared name's scope
        "PLURNK_FIXTURE_DEF_docs", "PLURNK_FIXTURE_DEF_docs_ENABLED",       // family members
        "PLURNK_FIXTURE_DEF_分析", "PLURNK_FIXTURE_PROVIDER_FIREWORKS_AI_REASONING_EFFORTS",
    ]) assert.equal(declares(key), true, key);
    for (const key of [
        "PLURNK_FIXTURE_EFORT",            // nothing declares a misspelling
        "PLURNK_FIXTURE",                  // a prefix of a declared name is not that name
        "PLURNK_FIXTURE_EFFORT_",          // a scope is never empty
        "PLURNK_FIXTURE_DEF_",             // nor is a placeholder
        "PLURNK_FIXTURE_DEF_a b",          // and it holds no space
        "PLURNK_FIXTURE_PROVIDER_ACME",    // two placeholders need two segments
    ]) assert.equal(declares(key), false, key);
});
});

describe("env-defaults", () => {
// {§operator-config-precedence} — the .env.defaults assembly: every package owns its knobs,
// one floor, one law (global key uniqueness), projected through the on-demand catalog.







// These fixtures are third-party packages, so this file exercises the operator who admitted them
// ({§extension-trust-boundary}); the shipped panel admits only `@plurnk/*`. Tests of the gate itself
// state their own value below and override this one.
process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";

const setting = (t: TestContext, key: string, value: string): void => {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
};

const scaffold = async (): Promise<{ root: string; nm: string }> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-envd-"));
    const nm = join(root, "node_modules");
    await mkdir(nm, { recursive: true });
    await writeFile(join(root, ".env.defaults"), "# the host's knob\nPLURNK_ENVD_TEST_KNOB=42\n");
    return { root, nm };
};

const addPackage = async (nm: string, name: string, opts: { plurnk?: boolean; defaults?: string }): Promise<void> => {
    const dir = join(nm, ...name.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, ...(opts.plurnk ? { plurnk: { kind: "exec" } } : {}) }));
    if (opts.defaults !== undefined) await writeFile(join(dir, ".env.defaults"), opts.defaults);
};

test("{§operator-config-precedence} collect: the host's file + @plurnk/* + plurnk-declaring third parties; bystanders excluded", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-extension", { plurnk: true, defaults: "ACME_EXTENSION_Y=2\n" });
        await addPackage(nm, "left-pad", { defaults: "LEFT_PAD=oops\n" }); // ships a file but is NOT an ecosystem member
        await addPackage(nm, "@plurnk/plurnk-silent", {});                 // member, no file — fine
        const { files } = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-extension"],
            "host first, then members name-sorted; the bystander's file is never read");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§operator-config-precedence} the ONE law: a key claimed by two packages crashes naming both", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_ENVD_TEST_KNOB=13\n" });
        const { files } = await EnvDefaults.collect(root, nm);
        assert.throws(() => EnvDefaults.merge(files),
            /PLURNK_ENVD_TEST_KNOB is claimed by both @plurnk\/plurnk-service and @plurnk\/plurnk-fake/,
            "the collision names both claimants — the handoff signal");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§operator-config-precedence} unreadable defaults fail with their owner and cause instead of vanishing from the catalog", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    await addPackage(nm, "@plurnk/plurnk-broken", {});
    await mkdir(join(nm, "@plurnk", "plurnk-broken", ".env.defaults"));
    await assert.rejects(() => EnvDefaults.collect(root, nm), (cause: Error) => {
        assert.match(cause.message, /@plurnk\/plurnk-broken: cannot read \.env\.defaults/);
        assert.equal((cause.cause as NodeJS.ErrnoException)?.code, "EISDIR");
        return true;
    });
});

test("{§operator-config-precedence} apply is a floor — set-if-unset, never an override", async () => {
    const key = "PLURNK_ENVD_FLOOR_PROBE";
    delete process.env[key];
    try {
        const merged = new Map([[key, { value: "floor", owner: "t" }], ["PLURNK_ENVD_FLOOR_PROBE_2", { value: "lands", owner: "t" }]]);
        process.env[key] = "operator";
        delete process.env.PLURNK_ENVD_FLOOR_PROBE_2;
        EnvDefaults.apply(merged);
        assert.equal(process.env[key], "operator", "an operator-set value is never overridden by the floor");
        assert.equal(process.env.PLURNK_ENVD_FLOOR_PROBE_2, "lands", "an unset knob takes the floor value");
    } finally { delete process.env[key]; delete process.env.PLURNK_ENVD_FLOOR_PROBE_2; }
});

test("{§operator-config-precedence} a malformed member file crashes naming the owner — never a degraded floor", async () => {
    const { root, nm } = await scaffold();
    try {
        // parseEnv never throws — it mints junk keys from malformed lines (" =" → key "").
        // The assembly's own key validation is the fail-hard.
        await addPackage(nm, "@plurnk/plurnk-broken", { defaults: "PLURNK_BROKEN_X=1\n =\n" });
        await assert.rejects(() => EnvDefaults.collect(root, nm), /@plurnk\/plurnk-broken: malformed \.env\.defaults/,
            "the crash names the owning package");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§operator-config-precedence} the on-demand catalog is owner-labelled and preserves package comments", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "# fake's own doc line\nPLURNK_FAKE_X=1\n" });
        const { files } = await EnvDefaults.collect(root, nm);
        const catalog = EnvDefaults.renderCatalog(files);
        assert.match(catalog, /Generated on demand/, "the header identifies the projection");
        assert.match(catalog, /--config.*--env-file/u, "additional files are selected explicitly through the launcher");
        assert.match(catalog, /working directory's \.env is not read/u, "the catalog does not imply ambient project configuration");
        assert.match(catalog, /═══ @plurnk\/plurnk-service ═══/, "the host section is owner-labelled");
        assert.match(catalog, /═══ @plurnk\/plurnk-fake ═══/, "each member section is owner-labelled");
        assert.match(catalog, /# fake's own doc line/, "the owner's comments ARE the docs — preserved verbatim");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§operator-config-precedence} the catalog contains declarations and examples, never effective environment values", async () => {
    const { root, nm } = await scaffold();
    const key = "PLURNK_ENVD_REFERENCE_SECRET";
    const previous = process.env[key];
    try {
        const source = `# Required only when enabled.\n# ${key}=\nPLURNK_ENVD_REFERENCE_ENABLED=0\n`;
        await addPackage(nm, "acme-extension", { plurnk: true, defaults: source });
        process.env[key] = "private-test-sentinel";
        const catalog = EnvDefaults.renderCatalog((await EnvDefaults.collect(root, nm)).files);
        assert.ok(catalog.includes(source), "retain optional declarations and their owner's explanations");
        assert.ok(!catalog.includes(process.env[key]), "effective values are not configuration documentation");
    } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} PLURNK_EXTENSIONS_TRUSTED_ONLY gates third parties, never @plurnk/*", async () => {
    const { root, nm } = await scaffold();
    const prior = process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-extension", { plurnk: true, defaults: "ACME_EXTENSION_Y=2\n" });
        await addPackage(nm, "evil-extension", { plurnk: true, defaults: "EVIL_Z=3\n" });
        process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "acme-extension";
        const { files } = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-extension"],
            "@plurnk/* always trusted; the allowlist admits acme; evil-extension's knobs never load");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
        else process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = prior;
        await rm(root, { recursive: true, force: true });
    }
});

const addPlugin = async (dir: string, name: string, defaults: string): Promise<void> => {
    await mkdir(join(dir, "ai.plurnk"), { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name,
        extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/plugin.mjs" } },
    }));
    await writeFile(join(dir, "ai.plurnk/.env.defaults"), defaults);
    await writeFile(join(dir, "ai.plurnk/plugin.mjs"), "export default {};");
};

for (const kind of ["module", "http-materializer"] as const) {
    test(`{§operator-config-precedence} linked ${kind} defaults share their native code's canonical root`, async (t) => {
        const { root, nm } = await scaffold();
        t.after(() => rm(root, { recursive: true, force: true }));
        const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
        setting(t, "PLURNK_SERVICE_ROOTS", "project");
        const plugin = join(root, "source");
        const linked = join(nm, "example");
        await addPlugin(plugin, "example", "PLUGIN_VALUE=linked\n");
        await writeFile(join(plugin, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example",
            extensions: { "ai.plurnk": kind === "module"
                ? { kind, module: "ai.plurnk/plugin.mjs" }
                : { kind, materializers: [{ id: "example", module: "ai.plurnk/plugin.mjs" }] } },
        }));
        await symlink(plugin, linked, "dir");
        const collect = () => EnvDefaults.collect(root, nm, { hostPaths });
        const collected = await collect();
        assert.deepEqual(collected.configurationErrors, []);
        assert.deepEqual(collected.files.map(({ owner }) => owner), ["@plurnk/plurnk-service", "example"]);
        assert.deepEqual(EnvDefaults.merge(collected.files).get("PLUGIN_VALUE"), { value: "linked", owner: "example" });

        await rm(join(plugin, "ai.plurnk/.env.defaults"));
        const absent = await collect();
        assert.deepEqual(absent.configurationErrors, [], "a missing optional panel is not a containment failure");
        assert.equal(EnvDefaults.merge(absent.files).has("PLUGIN_VALUE"), false);

        await writeFile(join(root, "outside.env"), "PLUGIN_VALUE=escaped\n");
        await symlink(join(root, "outside.env"), join(plugin, "ai.plurnk/.env.defaults"));
        const escaped = await collect();
        assert.equal(EnvDefaults.merge(escaped.files).has("PLUGIN_VALUE"), false);
        assert.equal(escaped.configurationErrors.length, 1);
        assert.match(escaped.configurationErrors[0].message, /native defaults resolve outside the plugin root/);
    });
}

test("{§operator-config-precedence} native defaults follow the same root shadowing as native code", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    setting(t, "PLURNK_SERVICE_ROOTS", "project,plurnk,global");
    await addPlugin(join(nm, "published"), "example", "PLUGIN_VALUE=npm\n");
    await addPlugin(join(hostPaths.globalPluginsDir, "local"), "example", "PLUGIN_VALUE=user\n");
    await addPlugin(join(hostPaths.projectPluginsDir(root), "project"), "project-only", "PROJECT_VALUE=unwanted\n");
    const collected = await EnvDefaults.collect(root, nm, { hostPaths });
    assert.deepEqual(collected.configurationErrors, []);
    assert.deepEqual(collected.files.map(({ owner }) => owner), ["@plurnk/plurnk-service", "example"]);
    assert.deepEqual(EnvDefaults.merge(collected.files).get("PLUGIN_VALUE"), { value: "user", owner: "example" });
    assert.equal(EnvDefaults.merge(collected.files).has("PROJECT_VALUE"), false);
    assert.deepEqual(collected.reports.map(({ outcome }) => outcome), ["shadowed"]);
    process.env.PLURNK_SERVICE_ROOTS = "project";
    const gated = await EnvDefaults.collect(root, nm, { hostPaths });
    assert.deepEqual(EnvDefaults.merge(gated.files).get("PLUGIN_VALUE"), { value: "npm", owner: "example" });
});

test("{§operator-config-precedence} untrusted native defaults are not admitted; path escapes are repairable", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const plugin = join(nm, "example");
    await addPlugin(plugin, "example", "PLUGIN_VALUE=unused\n");
    await writeFile(join(root, "outside.env"), "PLUGIN_VALUE=escaped\n");
    await rm(join(plugin, "ai.plurnk/.env.defaults"));
    await symlink(join(root, "outside.env"), join(plugin, "ai.plurnk/.env.defaults"));
    setting(t, "PLURNK_EXTENSIONS_TRUSTED_ONLY", "1");
    assert.deepEqual((await EnvDefaults.collect(root, nm, { hostPaths })).configurationErrors, [], "untrusted defaults were not read");
    process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";
    const collected = await EnvDefaults.collect(root, nm, { hostPaths });
    assert.deepEqual(collected.files.map(({ owner }) => owner), ["@plurnk/plurnk-service"]);
    assert.equal(collected.configurationErrors.length, 1);
    assert.equal(collected.configurationErrors[0].key, join(plugin, "ai.plurnk/.env.defaults"));
    assert.match(collected.configurationErrors[0].message, /resolve outside the plugin root/);
});

test("{§configuration-repair-path} invalid root selection is diagnosed while package defaults remain usable", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    setting(t, "PLURNK_SERVICE_ROOTS", "typo");
    const collected = await EnvDefaults.collect(root, nm);
    assert.equal(collected.files[0].parsed.PLURNK_ENVD_TEST_KNOB, "42");
    assert.equal(collected.configurationErrors.length, 1);
    assert.equal(collected.configurationErrors[0].key, "PLURNK_SERVICE_ROOTS");
});

test("{§operator-config-precedence} npm-only capabilities keep their panel when a user folder shadows portable components", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    setting(t, "PLURNK_SERVICE_ROOTS", "global");
    const published = join(nm, "example");
    const local = join(hostPaths.globalPluginsDir, "example");
    for (const [dir, value] of [[published, "npm"], [local, "folder"]]) {
        await addPlugin(dir, "example", `PLUGIN_VALUE=${value}\n`);
        await writeFile(join(dir, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example",
            extensions: { "ai.plurnk": { kind: "http-materializer", materializers: [{ id: "example", module: "ai.plurnk/plugin.mjs" }] } },
        }));
    }
    const collected = await EnvDefaults.collect(root, nm, { hostPaths });
    assert.deepEqual(collected.configurationErrors, []);
    assert.deepEqual(EnvDefaults.merge(collected.files).get("PLUGIN_VALUE"), { value: "npm", owner: "example" });
});
});

describe("zero-pin", () => {
test("{§operator-config-precedence}: operator tuning is stripped and provider configuration remains", () => {
    // STRIPPED — box tuning a fresh install would not have:
    for (const k of [
        "PLURNK_PROVIDERS_CONTEXT_WINDOW",           // bare window pin → force the probe
        "PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", // per-alias window pin
        "PLURNK_PROVIDERS_OUTPUT_BUDGET_turboderp",
        "PLURNK_PROVIDERS_REASONING_BUDGET_gbuild",
    ]) assert.equal(isZeroPinTuning(k), true, `${k} must be stripped (operator tuning)`);

    // KEPT — the fresh-user config: model selection + shipped percent defaults:
    for (const k of [
        "PLURNK_MODEL", "PLURNK_MODEL_turboderp",
        "PLURNK_PROVIDERS_OUTPUT_BUDGET",       // BARE percent default
        "PLURNK_PROVIDERS_REASONING_BUDGET",    // optional bare subset
        "PLURNK_SERVICE_BUDGET_LARGEST_ITEMS",   // a service knob is not provider tuning
        "PLURNK_PROVIDERS_BASE_URL_turboderp",
    ]) assert.equal(isZeroPinTuning(k), false, `${k} must be KEPT (fresh-user config)`);
});

test("{§operator-config-precedence}: scrubbing mutates the gate environment and reports every removed key", () => {
    const env = {
        PLURNK_MODEL: "turboderp",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp: "49152",
        PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",           // bare — stays
        PLURNK_PROVIDERS_REASONING_BUDGET_turboderp: "4096", // per-alias — stripped
    } as NodeJS.ProcessEnv;
    const stripped = scrubZeroPinTuning(env);
    assert.deepEqual(stripped.toSorted(), ["PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", "PLURNK_PROVIDERS_REASONING_BUDGET_turboderp"]);
    assert.equal(env.PLURNK_MODEL, "turboderp", "model selection survives");
    assert.equal(env.PLURNK_PROVIDERS_OUTPUT_BUDGET, "35%", "the bare percentage envelope survives");
    assert.equal(env.PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp, undefined, "the window pin is gone → probe forced");
});
});
