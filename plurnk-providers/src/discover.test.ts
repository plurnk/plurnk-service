import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discover } from "./discover.ts";

const buildModules = async (packages: Record<string, unknown>): Promise<string> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "providers-scan-"));
    for (const [rel, pkg] of Object.entries(packages)) {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    }
    return root;
};

test("discover: the node_modules scan is scope-agnostic — third-party scopes are found", async () => {
    const root = await buildModules({
        "@plurnk/plurnk-providers-openrouter": { name: "@plurnk/plurnk-providers-openrouter", plurnk: { kind: "provider", name: "openrouter" } },
        "@acme/acme-provider-foo": { name: "@acme/acme-provider-foo", plurnk: { kind: "provider", name: "foo" } },
        "unscoped-provider-bar": { name: "unscoped-provider-bar", plurnk: { kind: "provider", name: "bar" } },
        "left-pad": { name: "left-pad" },                                   // no plurnk block → ignored
        "@plurnk/plurnk-execs-git": { name: "@plurnk/plurnk-execs-git", plurnk: { kind: "exec", runtimes: [] } }, // wrong kind → ignored
    });
    const registry = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()].sort(), ["bar", "foo", "openrouter"]);
    assert.equal(registry.get("foo"), "@acme/acme-provider-foo");      // third-party scope resolves
    assert.equal(registry.get("bar"), "unscoped-provider-bar");        // unscoped resolves
    await fs.rm(root, { recursive: true, force: true });
});

test("discover: a provider package missing plurnk.name is ignored, not crashed", async () => {
    const root = await buildModules({
        "@acme/headless": { name: "@acme/headless", plurnk: { kind: "provider" } },          // no name
        "@acme/named": { name: "@acme/named", plurnk: { kind: "provider", name: "named" } },
    });
    const registry = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()], ["named"]);
    await fs.rm(root, { recursive: true, force: true });
});

test("discover: a name claimed by two packages is a fail-hard collision", async () => {
    const root = await buildModules({
        "@plurnk/plurnk-providers-xai": { name: "@plurnk/plurnk-providers-xai", plurnk: { kind: "provider", name: "xai" } },
        "@acme/rival-xai": { name: "@acme/rival-xai", plurnk: { kind: "provider", name: "xai" } },
    });
    await assert.rejects(
        () => discover({ cwd: root }),
        /provider name collision: 'xai' claimed by both/,
    );
    await fs.rm(root, { recursive: true, force: true });
});

test("discover: missing node_modules yields an empty registry, not an error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "providers-empty-"));
    const registry = await discover({ cwd: root });
    assert.equal(registry.size, 0);
    await fs.rm(root, { recursive: true, force: true });
});
