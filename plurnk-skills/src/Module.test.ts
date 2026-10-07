import assert from "node:assert/strict";
import test from "node:test";
import { parseSkill, SkillResourceError, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter } from "@plurnk/plurnk-modules";
import { GeneratedByteSource, type ResourceTreeSource } from "@plurnk/plurnk-schemes";
import Module from "./Module.ts";

const setup = async (module: Module, provided: ReadonlyMap<string, SkillTree> = new Map()) => {
    const families: FunctionalityAdapter[] = [];
    const sources: ResourceTreeSource[] = [];
    const seam: Parameters<Module["setup"]>[0] = {
        workspacePaths: async () => ({ home: "/unused", projectRoot: null, configurationRoots: [] }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => provided,
        workspaceStateDirectory: async () => { throw new Error("Provided resources require no directory."); },
        operatorEnvironment: () => { throw new Error("Provided resources launch no subprocess."); },
        registerFunctionalityAdapter: (family) => {
            families.push(family);
            return {
                invoke: async () => { throw new Error("Setup does not perform family actions."); },
                refresh: async () => {},
            };
        },
        registerResourceTreeScheme: async (name, source) => {
            assert.equal(name, "skill");
            sources.push(source);
        },
    };
    await module.setup(seam);
    assert.equal(families.length, 1);
    assert.equal(sources.length, 1);
    return { family: families[0]!, source: sources[0]!, seam };
};

test("{§skills-module} public seams connect ordinary family publication to original resources", async () => {
    const module = Module.init();
    assert.deepEqual(module.contained, []);
    const body = "---\nname: guide\ndescription: Read this guide\n---\nOriginal resource.\n";
    const tree: SkillTree = {
        document: parseSkill("/guide/SKILL.md", "guide", body),
        list: async () => ["SKILL.md"],
        resource: (path) => new GeneratedByteSource(async () => path === "SKILL.md" ? new TextEncoder().encode(body) : null),
    };
    const { family, source, seam } = await setup(module, new Map([["guide", tree]]));
    assert.equal(family.namespaceOwner, "@plurnk/plurnk-skills");
    assert.equal(family.family, "skills");
    const identity = { workspaceId: 1 };
    const available = await family.available(identity);
    assert.deepEqual(available, [{ alias: "guide", definition: { name: "guide" }, enabled: true }]);
    const prepared = await family.prepare({
        ...identity, enabled: new Map([["guide", { definition: { name: "guide" } }]]), previous: null,
        failure: "reject", progress: () => {}, retain: () => () => {},
    });
    assert.equal(source.trees(1).size, 0, "preparation alone publishes nothing");
    await prepared.commit();
    assert.equal(source.trees(1).get("guide"), tree, "no flattening or surrogate source");
    assert.equal(source.trees(2).size, 0);
    const bytes = source.trees(1).get("guide")!.resource("SKILL.md");
    assert.equal(new TextDecoder().decode(await bytes.read(1, body.length)), body);
    await family.teardown(prepared.snapshot, identity);
    assert.equal(source.trees(1).size, 0, "cooling withdraws the tree through the family lifecycle");
    await assert.rejects(module.setup(seam), /skills module already set up/);
});

test("{§skills-module} invalid configuration is inspectable, reported offline, and repairable", async (t) => {
    const previous = process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS;
        else process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = previous;
    });
    process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = "bad";
    const module = Module.init();
    assert.equal(module.contained.length, 1);
    assert.equal(module.contained[0]?.key, "PLURNK_SKILLS_FETCH_TIMEOUT_MS");
    const { family } = await setup(module);
    await assert.rejects(family.available({ workspaceId: 1 }), ConfigurationError);
    process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = "1000";
    assert.deepEqual(await family.available({ workspaceId: 1 }), []);
});

test("{§skills-resources} source refusals preserve the skill boundary without hiding unexpected failures", async () => {
    const { source } = await setup(Module.init());
    const address = { authority: "guide", pathname: "/secret" };
    for (const [cause, status, suffix] of [
        [{ code: "ENOENT" }, 404, "entry-not-found"],
        [new SkillResourceError("SKILL_PATH_OUTSIDE_ROOT", "Outside root."), 403, "resource-outside-root"],
        [new SkillResourceError("SKILL_RESOURCE_NOT_FILE", "Not a file."), 400, "resource-invalid"],
    ] as const) {
        const result = source.refusal!(cause, address);
        assert.equal(result?.status, status);
        assert.equal(result?.problem?.type, `https://problems.plurnk.xyz/scheme/skill/${suffix}`);
    }
    assert.equal(source.refusal!(new Error("unexpected source failure"), address), null);
});
