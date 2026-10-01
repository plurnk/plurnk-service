import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import MaterializerRegistry from "./Materializer.ts";

test("{§http-materializer-plugins} a standard bundle uses lazy family discovery without a daemon module", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "materializer-plugin-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugin = join(root, "plugin");
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "@plurnk/example-plugin", type: "module" }));
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example-plugin",
        extensions: { "ai.plurnk": { kind: "http-materializer", materializers: [{ id: "fixture", module: "ai.plurnk/materializer.mjs" }] } },
    }));
    const registry = await new MaterializerRegistry().discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] });
    const found = registry.materializerFor("fixture");
    assert.ok(found, "discovery does not import the implementation");
    await writeFile(join(plugin, "ai.plurnk/materializer.mjs"), `export default {
        id: "fixture", eligible: () => "fixture:v1",
        extract: async () => ({ outcome: "success", body: "native body", identity: "fixture:v1", evidence: [] }),
    };`);
    assert.equal(await found.eligible("https://example.com/", {}), "fixture:v1");
    assert.deepEqual(await found.extract("https://example.com/", {}), {
        outcome: "success", body: "native body", identity: "fixture:v1", evidence: [],
    });
    assert.equal(await registry.discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] }), registry);
    assert.equal(await registry.materializerFor("fixture")?.eligible("https://example.com/", {}), "fixture:v1");
    const competitor = join(root, "competitor");
    await mkdir(competitor);
    await writeFile(join(competitor, "package.json"), JSON.stringify({
        name: "@plurnk/competitor", plurnk: { kind: "http-materializer", materializers: [{ id: "fixture", module: "unused.mjs" }] },
    }));
    await assert.rejects(new MaterializerRegistry().discover({ packageDirs: [
        { dir: plugin, name: "@plurnk/example-plugin" }, { dir: competitor, name: "@plurnk/competitor" },
    ] }), /claimed by both @plurnk\/example-plugin and @plurnk\/competitor/);
    await rm(join(plugin, "ai.plurnk/materializer.mjs"));
    await writeFile(join(root, "outside.mjs"), "throw new Error('must not import');");
    await symlink(join(root, "outside.mjs"), join(plugin, "ai.plurnk/materializer.mjs"));
    await assert.rejects(new MaterializerRegistry().discover({ packageDirs: [{ dir: plugin, name: "@plurnk/example-plugin" }] }),
        /native module resolves outside the plugin root/);
});
