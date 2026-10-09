import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EnvCatalog from "./env-catalog.ts";
import HostPaths from "./HostPaths.ts";
import OperatorConfig from "./OperatorConfig.ts";

test("{§operator-config-discovery} the seed is one dotenv front door with exact discovery signposts", () => {
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

test("{§agui-http-authorization} the seed mints this install's own bearer, uncommented and unique", () => {
    const seed = OperatorConfig.renderSeed();
    const minted = /^PLURNK_AGUI_TOKEN=(.+)$/m.exec(seed);
    assert.ok(minted, `the seed ships no bearer: ${seed.slice(0, 200)}`);
    // Empty is what "no check" looks like at the perimeter, so a seeded value must be real.
    assert.ok(minted[1]!.length >= 32, `a minted bearer is not guessable: ${minted[1]}`);
    assert.doesNotMatch(minted[1]!, /[^A-Za-z0-9_-]/u, "url-safe, so it survives a shell and a header");
    const second = /^PLURNK_AGUI_TOKEN=(.+)$/m.exec(OperatorConfig.renderSeed());
    assert.notEqual(minted[1], second?.[1], "each install mints its own, never a shipped constant");
});

test("{§policy} {§host-path-layout} first run creates private user-owned config once", async () => {
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

test("{§operator-config-discovery} concurrent first starts publish one complete configuration", async () => {
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
            assert.equal(start.config, starts[0]!.config);
            assert.match(start.config, /^PLURNK_AGUI_TOKEN=[A-Za-z0-9_-]{32,}$/m);
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

test("{§operator-config-undeclared-key} an operator file's undeclared daemon keys, in file order; other components' and non-plurnk keys pass", () => {
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
