import type { ByteSource } from "@plurnk/plurnk-schemes";
import type { SkillDocument } from "./SkillDocument.ts";

// {§agent-skills-tree} Resource names are relative to the skill root.
export default interface SkillTree {
    readonly document: SkillDocument;
    list(): Promise<string[]>;
    resource(pathname: string): ByteSource;
}
