// [§operator-config-env-defaults] — the .env.defaults assembly: every package owns its knobs,
// one floor, one law (global key uniqueness), rendered to a machine-owned catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EnvDefaults from "./env-defaults.ts";

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

test("[§operator-config-env-defaults] collect: the host's file + @plurnk/* + plurnk-declaring third parties; bystanders excluded", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-plugin", { plurnk: true, defaults: "ACME_PLUGIN_Y=2\n" });
        await addPackage(nm, "left-pad", { defaults: "LEFT_PAD=oops\n" }); // ships a file but is NOT an ecosystem member
        await addPackage(nm, "@plurnk/plurnk-silent", {});                 // member, no file — fine
        const files = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-plugin"],
            "host first, then members name-sorted; the bystander's file is never read");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("[§operator-config-env-defaults] the ONE law: a key claimed by two packages crashes naming both", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_ENVD_TEST_KNOB=13\n" });
        const files = await EnvDefaults.collect(root, nm);
        assert.throws(() => EnvDefaults.merge(files),
            /PLURNK_ENVD_TEST_KNOB is claimed by both @plurnk\/plurnk-service and @plurnk\/plurnk-fake/,
            "the collision names both claimants — the handoff signal");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("[§operator-config-env-defaults] apply is a floor — set-if-unset, never an override", async () => {
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

test("[§operator-config-env-defaults] a malformed member file crashes naming the owner — never a degraded floor", async () => {
    const { root, nm } = await scaffold();
    try {
        // parseEnv never throws — it mints junk keys from malformed lines (" =" → key "").
        // The assembly's own key validation is the fail-hard.
        await addPackage(nm, "@plurnk/plurnk-broken", { defaults: "PLURNK_BROKEN_X=1\n =\n" });
        await assert.rejects(() => EnvDefaults.collect(root, nm), /@plurnk\/plurnk-broken: malformed \.env\.defaults/,
            "the crash names the owning package");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("[§operator-config-env-defaults] the catalog render is machine-owned, owner-labelled, comments preserved", async () => {
    const { root, nm } = await scaffold();
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "# fake's own doc line\nPLURNK_FAKE_X=1\n" });
        const files = await EnvDefaults.collect(root, nm);
        const catalog = EnvDefaults.renderCatalog(files);
        assert.match(catalog, /MACHINE-OWNED/, "the header warns it is regenerated");
        assert.match(catalog, /═══ @plurnk\/plurnk-service ═══/, "the host section is owner-labelled");
        assert.match(catalog, /═══ @plurnk\/plurnk-fake ═══/, "each member section is owner-labelled");
        assert.match(catalog, /# fake's own doc line/, "the owner's comments ARE the docs — preserved verbatim");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("[§operator-config-env-defaults] PLURNK_PLUGINS_TRUSTED_ONLY gates third parties, never @plurnk/*", async () => {
    const { root, nm } = await scaffold();
    const prior = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    try {
        await addPackage(nm, "@plurnk/plurnk-fake", { defaults: "PLURNK_FAKE_X=1\n" });
        await addPackage(nm, "acme-plugin", { plurnk: true, defaults: "ACME_PLUGIN_Y=2\n" });
        await addPackage(nm, "evil-plugin", { plurnk: true, defaults: "EVIL_Z=3\n" });
        process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "acme-plugin";
        const files = await EnvDefaults.collect(root, nm);
        assert.deepEqual(files.map((f) => f.owner), ["@plurnk/plurnk-service", "@plurnk/plurnk-fake", "acme-plugin"],
            "@plurnk/* always trusted; the allowlist admits acme; evil-plugin's knobs never load");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prior;
        await rm(root, { recursive: true, force: true });
    }
});
