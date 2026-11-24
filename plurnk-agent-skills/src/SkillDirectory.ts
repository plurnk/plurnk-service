import { readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
    ContainedDirectoryTree,
    SkillResourceError,
    assertContainedPath,
    type DocumentResourceTree,
} from "./ResourceTrees.ts";
import { parseSkill, type SkillDocument } from "./SkillDocument.ts";

// {§provided-skills-module-slice} Resource names are relative to the skill root.
export type SkillTree = DocumentResourceTree;

// {§provided-skills-module-slice} The host composes references; the skills family serves them.
export interface ProvidedSkillsSeam {
    readProvidedSkills(): Promise<ReadonlyMap<string, SkillTree>>;
}

export { SkillResourceError };

// {§agent-skills-directory} A loaded skill is a source tree, not a flattened document.
export default class SkillDirectory extends ContainedDirectoryTree implements SkillTree {
    private constructor(directory: string, document: SkillDocument) {
        super(directory, document, "Skill");
    }

    static async load(directory: string): Promise<SkillDirectory> {
        const canonical = await realpath(directory);
        const file = join(canonical, "SKILL.md");
        const resolved = await realpath(file);
        assertContainedPath(canonical, resolved, "SKILL.md", "Skill");
        const source = await readFile(resolved, "utf8");
        return new SkillDirectory(canonical, parseSkill(file, basename(resolve(directory)), source));
    }
}
