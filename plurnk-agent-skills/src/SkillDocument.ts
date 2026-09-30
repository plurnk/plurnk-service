import { parse as parseYaml } from "yaml";
import { SKILL_NAME } from "@plurnk/plurnk-contracts";

export interface SkillDocument {
    readonly name: string;
    readonly description: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly body: string;
    readonly source: string;
}

const frontmatter = (file: string, source: string): { fields: Record<string, unknown>; header: string } => {
    if (!/^---\r?\n/u.test(source)) throw new Error(`${file}: Agent Skill requires YAML frontmatter`);
    const header = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu.exec(source);
    if (header === null) throw new Error(`${file}: Agent Skill frontmatter is not closed`);
    let metadata: unknown;
    try {
        metadata = parseYaml(header[1]!);
    } catch (cause) {
        throw new Error(`${file}: Agent Skill frontmatter is invalid YAML`, { cause });
    }
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(`${file}: Agent Skill frontmatter must be a mapping`);
    }
    return { fields: metadata as Record<string, unknown>, header: header[0] };
};

const nameOf = (file: string, fields: Record<string, unknown>): string => {
    const { name } = fields;
    if (typeof name !== "string" || name.length === 0) throw new Error(`${file}: Agent Skill frontmatter requires name`);
    if (!SKILL_NAME.test(name)) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} is invalid`);
    if ([...name].length > 64) throw new Error(`${file}: Agent Skill name exceeds 64 characters`);
    return name;
};

// {§agent-skills-name} A consumer that names the directory itself — a skill at the root of a
// fetched source — reads the name first; the folder rule then holds by construction.
export const skillName = (file: string, source: string): string => nameOf(file, frontmatter(file, source).fields);

// {§agent-skills-directory} Discovery consumes two keys; it does not replace the source.
export const parseSkill = (file: string, folder: string, source: string): SkillDocument => {
    const { fields, header } = frontmatter(file, source);
    const name = nameOf(file, fields);
    if (name !== folder) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} must match folder ${JSON.stringify(folder)}`);
    const { description } = fields;
    if (typeof description !== "string" || description.trim().length === 0) throw new Error(`${file}: Agent Skill frontmatter requires description`);
    if ([...description].length > 1024) throw new Error(`${file}: Agent Skill description exceeds 1024 characters`);
    return { name, description, metadata: fields, body: source.slice(header.length), source };
};
