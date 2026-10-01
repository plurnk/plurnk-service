// {§operator-config-env-defaults} — the .env.defaults assembly: every package owns its knobs,
// one floor, one law (global key uniqueness), projected through the on-demand catalog.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EnvDefaults from "./env-defaults.ts";
import HostPaths from "./HostPaths.ts";

// These fixtures are third-party packages, so this file exercises the operator who admitted them
// ({§plugin-trust-boundary}); the shipped panel admits only `@plurnk/*`. Tests of the gate itself
// state their own value below and override this one.
process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "0";

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

test("collect: the host's file + @plurnk/* + plurnk-declaring third parties; bystanders excluded", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-plugin", { plurnk: true, defaults: "ACME_PLUGIN_Y=2\n" });
        await addPackage(nm, "left-pad", { defaults: "LEFT_PAD=oops\n" }); // ships a file but is NOT an ecosystem member
        await addPackage(nm, "@plurnk/plurnk-silent", {});                 // member, no file — fine
        const { files } = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-plugin"],
            "host first, then members name-sorted; the bystander's file is never read");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("the ONE law: a key claimed by two packages crashes naming both", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_ENVD_TEST_KNOB=13\n" });
        const { files } = await EnvDefaults.collect(root, nm);
        assert.throws(() => EnvDefaults.merge(files),
            /PLURNK_ENVD_TEST_KNOB is claimed by both @plurnk\/plurnk-service and @plurnk\/plurnk-fake/,
            "the collision names both claimants — the handoff signal");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§operator-config-source-errors} unreadable defaults fail with their owner and cause instead of vanishing from the catalog", async (t) => {
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

test("apply is a floor — set-if-unset, never an override", async () => {
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

test("a malformed member file crashes naming the owner — never a degraded floor", async () => {
    const { root, nm } = await scaffold();
    try {
        // parseEnv never throws — it mints junk keys from malformed lines (" =" → key "").
        // The assembly's own key validation is the fail-hard.
        await addPackage(nm, "@plurnk/plurnk-broken", { defaults: "PLURNK_BROKEN_X=1\n =\n" });
        await assert.rejects(() => EnvDefaults.collect(root, nm), /@plurnk\/plurnk-broken: malformed \.env\.defaults/,
            "the crash names the owning package");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("the on-demand catalog is owner-labelled and preserves package comments", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "# fake's own doc line\nPLURNK_FAKE_X=1\n" });
        const { files } = await EnvDefaults.collect(root, nm);
        const catalog = EnvDefaults.renderCatalog(files);
        assert.match(catalog, /Generated on demand/, "the header identifies the projection");
        assert.match(catalog, /--config.*--env-file/u, "additional files are selected explicitly through the launcher");
        assert.match(catalog, /working directory's \.env is not read/u, "the catalog does not imply ambient project configuration");
        assert.doesNotMatch(catalog, /~\/.plurnk/, "the retired mixed home is absent");
        assert.match(catalog, /═══ @plurnk\/plurnk-service ═══/, "the host section is owner-labelled");
        assert.match(catalog, /═══ @plurnk\/plurnk-fake ═══/, "each member section is owner-labelled");
        assert.match(catalog, /# fake's own doc line/, "the owner's comments ARE the docs — preserved verbatim");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("the catalog contains declarations and examples, never effective environment values", async () => {
    const { root, nm } = await scaffold();
    const key = "PLURNK_ENVD_REFERENCE_SECRET";
    const previous = process.env[key];
    try {
        const source = `# Required only when enabled.\n# ${key}=\nPLURNK_ENVD_REFERENCE_ENABLED=0\n`;
        await addPackage(nm, "acme-plugin", { plurnk: true, defaults: source });
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

test("PLURNK_PLUGINS_TRUSTED_ONLY gates third parties, never @plurnk/*", async () => {
    const { root, nm } = await scaffold();
    const prior = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-plugin", { plurnk: true, defaults: "ACME_PLUGIN_Y=2\n" });
        await addPackage(nm, "evil-plugin", { plurnk: true, defaults: "EVIL_Z=3\n" });
        process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "acme-plugin";
        const { files } = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-plugin"],
            "@plurnk/* always trusted; the allowlist admits acme; evil-plugin's knobs never load");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prior;
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

test("{§operator-config-env-defaults} native defaults follow the same root shadowing as native code", async (t) => {
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

test("{§operator-config-env-defaults} untrusted native defaults are not admitted; path escapes are repairable", async (t) => {
    const { root, nm } = await scaffold();
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const plugin = join(nm, "example");
    await addPlugin(plugin, "example", "PLUGIN_VALUE=unused\n");
    await writeFile(join(root, "outside.env"), "PLUGIN_VALUE=escaped\n");
    await rm(join(plugin, "ai.plurnk/.env.defaults"));
    await symlink(join(root, "outside.env"), join(plugin, "ai.plurnk/.env.defaults"));
    setting(t, "PLURNK_PLUGINS_TRUSTED_ONLY", "1");
    assert.deepEqual((await EnvDefaults.collect(root, nm, { hostPaths })).configurationErrors, [], "untrusted defaults were not read");
    process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "0";
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

test("{§operator-config-env-defaults} npm-only capabilities keep their panel when a user folder shadows portable components", async (t) => {
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
