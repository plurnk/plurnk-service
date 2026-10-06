import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import EnvDefaults from "../core/env-defaults.ts";
import Paths from "../Paths.ts";
import PlurnkSkill from "./PlurnkSkill.ts";

test("{§skills-installation-boundary} {§plurnk-skill} listing is lazy and chapters retain their native owners", async () => {
    const tree = await PlurnkSkill.load(resolve("../node_modules"));
    assert.equal(tree.document.name, "plurnk");
    assert.ok(tree.document.description);
    const listed = await tree.list();
    assert.deepEqual(listed.filter((path) => !path.startsWith("packages/")),
        [".env.defaults", "SKILL.md", "references/configuration.md", "references/copy-move.md", "references/extensibility.md", "references/models.md"]);
    assert.deepEqual(listed, listed.toSorted(), "the tree lists in one order");
    const configuration = tree.resource("references/configuration.md");
    assert.equal(await configuration.nativePath?.(), Paths.configuration);
    const size = await configuration.size();
    assert.notEqual(size, null);
    assert.equal(new TextDecoder().decode(await configuration.read(1, size!)), await readFile(Paths.configuration, "utf8"));
    assert.equal(await tree.resource("references/copy-move.md").nativePath?.(), resolve(dirname(Paths.configuration), "docs/copy-move.md"));
    assert.equal("nativePath" in tree.resource(".env.defaults"), false);
    assert.equal(await tree.resource("../.env").size(), null);
    assert.equal(await tree.resource("/SKILL.md").size(), null);
});

test("{§plurnk-skill} each installed ecosystem package's contract is a chapter where its package installed it", async () => {
    const tree = await PlurnkSkill.load(resolve("../node_modules"));
    const contracts = (await tree.list()).filter((path) => path.startsWith("packages/"));
    for (const name of ["@plurnk/plurnk-service", "@plurnk/plurnk-modules", "@plurnk/plurnk-execs", "@plurnk/plurnk-schemes", "@plurnk/plurnk-meta"]) {
        assert.ok(contracts.includes(`packages/${name}/SPEC.md`), `${name} publishes its contract`);
    }
    assert.equal(contracts.includes("packages/@plurnk/plurnk-execs-jq/SPEC.md"), false, "a package without a SPEC.md lists none");
    assert.ok(contracts.every((path) => path.endsWith("/SPEC.md")), "only contracts live under packages/");
    assert.equal(await tree.resource("packages/@plurnk/plurnk-service/SPEC.md").nativePath?.(), resolve(Paths.packageRoot, "SPEC.md"));
    const modules = tree.resource("packages/@plurnk/plurnk-modules/SPEC.md");
    const size = await modules.size();
    assert.notEqual(size, null);
    assert.match(new TextDecoder().decode(await modules.read(1, size!)), /\u00A7module-contract/u, "the module contract declares its tags");
    assert.equal(await tree.resource("packages/@plurnk/plurnk-absent/SPEC.md").size(), null, "an unlisted contract is not found");
});

test("{§plurnk-skill} only reading generated defaults collects the installed catalog", async (t) => {
    const tree = await PlurnkSkill.load(resolve("../node_modules"));
    const collect = t.mock.method(EnvDefaults, "collect", async () => ({
        files: [{ owner: "fixture", text: "# fixture\nKNOB=1\n", parsed: { KNOB: "1" } }],
        reports: [], configurationErrors: [],
    }));
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
