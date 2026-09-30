// {§skills-sources} The vendor installer's knobs are retired, not ignored.
import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import SkillsFunctionality, { serviceSkills } from "./SkillsFunctionality.ts";

test("{§skills-configuration} native env parsing retains exact standard skill names without opening their sources", () => {
    const names = ["3d-tools", "分析", "café", "ｓｋｉｌｌ", "skill"];
    const definitions = names.map((name) => ({ name, source: `/unavailable/${name}` }));
    const env = parseEnv([
        "PLURNK_SKILLS_ENABLED=1",
        ...definitions.map((definition) => `PLURNK_SKILLS_${definition.name.replaceAll("-", "_")}='${JSON.stringify(definition)}'`),
        "PLURNK_SKILLS_分析_ENABLED=0",
        "PLURNK_SKILLS_future_ENABLED=0",
    ].join("\n"));
    const actual = serviceSkills(env);
    assert.equal(actual.size, names.length, "controls do not manufacture resource definitions");
    for (const definition of definitions) assert.deepEqual(actual.get(definition.name), definition);
});

test("{§skills-configuration} invalid disabled definitions still fail validation; absent definitions inherit", () => {
    const base = { PLURNK_SKILLS_ENABLED: "0", PLURNK_SKILLS_review_ENABLED: "0" };
    assert.equal(serviceSkills(base).size, 0);
    for (const definition of ["null", "{}", '{"name":"review","scope":"project","source":"/srv/review"}', "invalid-json"]) {
        assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: definition }), {
            message: "PLURNK_SKILLS_review must contain a complete SkillDefinition.",
        });
    }
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: '{"name":"other","source":"/srv/other"}' }), {
        message: "PLURNK_SKILLS_review: the definition name must equal 'review'.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: '{"name":"review"}' }), {
        message: "PLURNK_SKILLS_review: a configured skill requires a source.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: "" }), {
        message: "PLURNK_SKILLS_review must contain a definition; use PLURNK_SKILLS_review_ENABLED=0 to disable a defined resource.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: JSON.stringify({ name: "review", source: "https://forge.example/skills.git", commit: "a".repeat(40) }) }), {
        message: "PLURNK_SKILLS_review: commit is service-recorded; configure a Git ref instead.",
    });
    for (const definition of [
        { name: "review", source: "/srv/review", ref: "main" },
        { name: "review", source: "http://forge.example/skills.git" },
        { name: "review", source: "https://secret@forge.example/skills.git" },
    ]) {
        assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: JSON.stringify(definition) }), {
            message: "PLURNK_SKILLS_review: invalid skill source or ref.",
        });
    }
});

test("{§skills-sources} a retired vendor-installer knob fails boot, naming what replaced it", (t) => {
    const saved = process.env.PLURNK_SERVICE_SKILLS_REGISTRY_URL;
    t.after(() => {
        if (saved === undefined) delete process.env.PLURNK_SERVICE_SKILLS_REGISTRY_URL;
        else process.env.PLURNK_SERVICE_SKILLS_REGISTRY_URL = saved;
    });
    process.env.PLURNK_SERVICE_SKILLS_REGISTRY_URL = "https://registry.example";
    assert.throws(() => SkillsFunctionality.validateConfiguration(),
        /PLURNK_SERVICE_SKILLS_REGISTRY_URL is retired: discover takes a source; Agent Skills have no standard registry\./u);
    process.env.PLURNK_SERVICE_SKILLS_REGISTRY_URL = "";
    assert.doesNotThrow(() => SkillsFunctionality.validateConfiguration(), "an empty retired knob states nothing");
});
