import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import EnvDefaults from "../core/env-defaults.ts";
import Paths from "../Paths.ts";
import PlurnkSkill from "./PlurnkSkill.ts";

test("{§plurnk-skill} listing is lazy and chapters retain their native owners", async () => {
    const tree = await PlurnkSkill.load(resolve("../node_modules"));
    assert.equal(tree.document.name, "plurnk");
    assert.ok(tree.document.description);
    assert.deepEqual(await tree.list(), [".env.defaults", "SKILL.md", "references/configuration.md", "references/models.md"]);
    const configuration = tree.resource("references/configuration.md");
    assert.equal(await configuration.nativePath?.(), Paths.configuration);
    const size = await configuration.size();
    assert.notEqual(size, null);
    assert.equal(new TextDecoder().decode(await configuration.read(1, size!)), await readFile(Paths.configuration, "utf8"));
    assert.equal("nativePath" in tree.resource(".env.defaults"), false);
    assert.equal(await tree.resource("../.env").size(), null);
    assert.equal(await tree.resource("/SKILL.md").size(), null);
});

test("{§plurnk-skill} only reading generated defaults collects the installed catalog", async (t) => {
    const tree = await PlurnkSkill.load(resolve("../node_modules"));
    const collect = t.mock.method(EnvDefaults, "collect", async () => [{ owner: "fixture", text: "# fixture\nKNOB=1\n", parsed: { KNOB: "1" } }]);
    await tree.list();
    const source = tree.resource(".env.defaults");
    assert.equal(collect.mock.callCount(), 0);
    const size = await source.size();
    assert.notEqual(size, null);
    assert.match(new TextDecoder().decode(await source.read(1, size!)), /# fixture\nKNOB=1/);
    assert.equal(collect.mock.callCount(), 1);
    await tree.resource(".env.defaults").size();
    assert.equal(collect.mock.callCount(), 2, "a later resource acquisition observes the current catalog");
});
