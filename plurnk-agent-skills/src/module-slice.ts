import type SkillTree from "./SkillTree.ts";

// {§provided-skills-module-slice} The host composes references; the skills family serves them.
export interface ProvidedSkillsSeam {
    readProvidedSkills(): Promise<ReadonlyMap<string, SkillTree>>;
}
