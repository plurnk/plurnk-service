// {§skills-sources} The vendor installer's knobs are retired, not ignored.
import test from "node:test";
import assert from "node:assert/strict";
import SkillsFunctionality from "./SkillsFunctionality.ts";

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
