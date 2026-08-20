import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HostPaths from "./HostPaths.ts";
import OperatorConfig from "./OperatorConfig.ts";

test("{§operator-config-discovery} the seed is one dotenv front door with exact discovery signposts", () => {
    const seed = OperatorConfig.renderSeed();
    assert.match(seed, /^# Plurnk user configuration\./);
    assert.match(seed, /Full installed options: plurnk-service config defaults/);
    assert.match(seed, /PLURNK_MODEL_plurnk="plurnk\/plurnk"/);
    assert.match(seed, /PLURNK_MODEL_openrouter="openrouter\/qwen\/qwen3-coder"/);
    assert.match(seed, /PLURNK_MODEL_local="openai\/qwen"/);
    assert.match(seed, /PLURNK_PROVIDERS_GBNF_local=plurnk\.qwen\.gbnf/);
    assert.match(seed, /PLURNK_MCP_BRAVE=npx/);
    assert.match(seed, /PLURNK_SCHEMES_HTTP_MATERIALIZER=tavily-extract/);
    assert.match(seed, /FIND-SKILLS ships enabled inside Plurnk/);
    assert.doesNotMatch(seed, /^(?!#).*PLURNK_MODEL=/m, "no model ships selected");
});

test("{§host-path-layout} first run creates private user-owned config once", async () => {
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
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
