import test, { type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discover } from "./discover.ts";

// #551: create a temp dir AND register its removal on the test context, so it's
// cleaned on a GREEN or RED run. A trailing rm after the assertions leaks the dir
// whenever one throws — thousands accumulate on a shared box at drill frequency.
const tempDir = async (t: TestContext, prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
};

const buildModules = async (t: TestContext, packages: Record<string, unknown>): Promise<string> => {
    const root = await tempDir(t, "providers-scan-");
    for (const [rel, pkg] of Object.entries(packages)) {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    }
    return root;
};

test("discover: the node_modules scan is scope-agnostic — third-party scopes are found", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/plurnk-provider-native": { name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } },
        "@acme/acme-provider-foo": { name: "@acme/acme-provider-foo", plurnk: { kind: "provider", name: "foo" } },
        "unscoped-provider-bar": { name: "unscoped-provider-bar", plurnk: { kind: "provider", name: "bar" } },
        "left-pad": { name: "left-pad" },                                   // no plurnk block → ignored
        "@plurnk/plurnk-execs-git": { name: "@plurnk/plurnk-execs-git", plurnk: { kind: "exec", runtimes: [] } }, // wrong kind → ignored
    });
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()].sort(), ["bar", "foo", "native"]);
    assert.equal(registry.get("foo"), "@acme/acme-provider-foo");      // third-party scope resolves
    assert.equal(registry.get("bar"), "unscoped-provider-bar");        // unscoped resolves
});

test("discover: a provider package missing plurnk.name is ignored, not crashed", async (t) => {
    const root = await buildModules(t, {
        "@acme/headless": { name: "@acme/headless", plurnk: { kind: "provider" } },          // no name
        "@acme/named": { name: "@acme/named", plurnk: { kind: "provider", name: "named" } },
    });
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()], ["named"]);
});

test("discover: an array kind claims no provider family", async (t) => {
    const root = await buildModules(t, {
        "@acme/dual": {
            name: "@acme/dual",
            plurnk: { kind: ["provider", "scheme"], name: "dual" },
        },
    });
    const { registry } = await discover({ cwd: root });
    assert.equal(registry.size, 0);
});

test("discover: a name claimed by two packages is a fail-hard collision", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/plurnk-provider-native": { name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } },
        "@acme/rival-native": { name: "@acme/rival-native", plurnk: { kind: "provider", name: "native" } },
    });
    await assert.rejects(
        () => discover({ cwd: root }),
        /provider name collision: 'native' claimed by both/,
    );
});

test("discover: node_modules entries with no package.json or malformed JSON are skipped, not crashed", async (t) => {
    const root = await tempDir(t, "providers-junk-");
    const nm = path.join(root, "node_modules");
    await fs.mkdir(path.join(nm, "no-manifest"), { recursive: true });                  // a dir, no package.json
    await fs.mkdir(path.join(nm, "broken"), { recursive: true });
    await fs.writeFile(path.join(nm, "broken", "package.json"), "{ not json", "utf-8");  // malformed
    const good = path.join(nm, "@plurnk", "plurnk-provider-native");
    await fs.mkdir(good, { recursive: true });
    await fs.writeFile(path.join(good, "package.json"), JSON.stringify({ name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } }), "utf-8");
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()], ["native"]); // only the well-formed provider survives
});

test("discover: normalizes attribution per package and preserves the published provider projection", async (t) => {
    const root = await buildModules(t, {
        "@acme/provider-solo": { name: "@acme/provider-solo", plurnk: { kind: "provider", name: "solo", attribution: "@acme/solo" } },
        "@acme/provider-multi": { name: "@acme/provider-multi", plurnk: { kind: "provider", name: "multi", attribution: ["@acme/a", "@acme/b"] } },
        "@acme/provider-none": { name: "@acme/provider-none", plurnk: { kind: "provider", name: "none" } },
    });
    const { attributions, packageAttributions } = await discover({ cwd: root });
    assert.equal(attributions.get("solo"), "@acme/solo");
    assert.deepEqual(attributions.get("multi"), ["@acme/a", "@acme/b"]);
    assert.equal(attributions.has("none"), false);
    assert.deepEqual([...packageAttributions], [
        ["@acme/provider-multi", ["@acme/a", "@acme/b"]],
        ["@acme/provider-solo", ["@acme/solo"]],
    ]);
});

test("discover: validates trusted attribution before provider admission", async (t) => {
    const root = await buildModules(t, {
        "@acme/provider-bad": { name: "@acme/provider-bad", plurnk: { kind: "provider", name: "bad", attribution: 42 } },
    });
    await assert.rejects(
        discover({ cwd: root }),
        /plugin '@acme\/provider-bad': plurnk\.attribution must be a non-empty string or string\[\]/,
    );

    const reservedRoot = await buildModules(t, {
        "@acme/provider-reserved": { name: "@acme/provider-reserved", plurnk: { kind: "provider", name: "reserved", attribution: "@plurnk/staff" } },
    });
    await assert.rejects(discover({ cwd: reservedRoot }), /'@plurnk\/' is reserved/);
});

test("discover: an untrusted malformed attribution is withheld before validation", async (t) => {
    const root = await buildModules(t, {
        "@acme/provider-bad": { name: "@acme/provider-bad", plurnk: { kind: "provider", name: "bad", attribution: ["ok", 42] } },
    });
    const result = await discover({
        cwd: root,
        env: { PLURNK_PLUGINS_TRUSTED_ONLY: "1" } as NodeJS.ProcessEnv,
    });
    assert.equal(result.registry.size, 0);
    assert.equal(result.skipped.get("bad"), "@acme/provider-bad");
    assert.equal(result.packageAttributions.size, 0);
});

test("discover: missing node_modules yields an empty registry, not an error", async (t) => {
    const root = await tempDir(t, "providers-empty-");
    const { registry } = await discover({ cwd: root });
    assert.equal(registry.size, 0);
});

// — trust gate (PLURNK_PLUGINS_TRUSTED_ONLY, #15) —

const trustFixture = (t: TestContext) => buildModules(t, {
    "@plurnk/plurnk-provider-native": { name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } },
    "@acme/acme-provider-foo": { name: "@acme/acme-provider-foo", plurnk: { kind: "provider", name: "foo" } },
});

test("trust gate OFF (unset/empty/0): every provider is trusted", async (t) => {
    const root = await trustFixture(t);
    for (const gate of [undefined, "", "0"]) {
        const { registry, skipped } = await discover({ cwd: root, env: { PLURNK_PLUGINS_TRUSTED_ONLY: gate } as NodeJS.ProcessEnv });
        assert.deepEqual([...registry.keys()].sort(), ["foo", "native"]);
        assert.equal(skipped.size, 0);
    }
});

test("trust gate ON: @plurnk/* always trusted; third party declined → skipped, not registered", async (t) => {
    const root = await trustFixture(t);
    const { registry, skipped } = await discover({ cwd: root, env: { PLURNK_PLUGINS_TRUSTED_ONLY: "1" } as NodeJS.ProcessEnv });
    assert.deepEqual([...registry.keys()], ["native"]);              // @plurnk/* survives
    assert.equal(registry.has("foo"), false);                        // third party not registered
    assert.equal(skipped.get("foo"), "@acme/acme-provider-foo");     // …recorded for a precise error
});

test("trust gate ON with an allowlist: a named third-party package is trusted", async (t) => {
    const root = await trustFixture(t);
    const { registry, skipped } = await discover({ cwd: root, env: { PLURNK_PLUGINS_TRUSTED_ONLY: "@acme/acme-provider-foo" } as NodeJS.ProcessEnv });
    assert.deepEqual([...registry.keys()].sort(), ["foo", "native"]);
    assert.equal(skipped.size, 0);
});
