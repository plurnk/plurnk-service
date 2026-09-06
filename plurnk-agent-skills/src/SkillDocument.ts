import { parse as parseYaml } from "yaml";

export interface SkillDocument {
    readonly name: string;
    readonly description: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly body: string;
    readonly source: string;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// {§agent-skills-directory} Discovery consumes two keys; it does not replace the source.
export const parseSkill = (file: string, folder: string, source: string): SkillDocument => {
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
    const fields = metadata as Record<string, unknown>;
    const { name, description } = fields;
    if (typeof name !== "string" || name.length === 0) throw new Error(`${file}: Agent Skill frontmatter requires name`);
    if (!SKILL_NAME.test(name)) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} is invalid`);
    if (name.length > 64) throw new Error(`${file}: Agent Skill name exceeds 64 characters`);
    if (name !== folder) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} must match folder ${JSON.stringify(folder)}`);
    if (typeof description !== "string" || description.trim().length === 0) throw new Error(`${file}: Agent Skill frontmatter requires description`);
    if (description.length > 1024) throw new Error(`${file}: Agent Skill description exceeds 1024 characters`);
    return { name, description, metadata: fields, body: source.slice(header[0].length), source };
};
