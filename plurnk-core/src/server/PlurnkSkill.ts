import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, type SkillDocument, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { FileByteSource, GeneratedByteSource, type ByteSource } from "@plurnk/plurnk-schemes";
import Paths from "../Paths.ts";
import EnvDefaults from "../core/env-defaults.ts";

// {§plurnk-skill} Core composes sources; their packages remain their authors.
export default class PlurnkSkill implements SkillTree {
    readonly document: SkillDocument;
    readonly #nodeModules: string;
    readonly #files = new Map([
        ["SKILL.md", Paths.teachingSource(TEACHING_CORPUS.skill)],
        ["references/configuration.md", Paths.configuration],
        ["references/models.md", resolve(dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-providers/package.json"))), "docs/models.md")],
    ]);

    private constructor(document: SkillDocument, nodeModules: string) {
        this.document = document;
        this.#nodeModules = nodeModules;
    }

    static async load(nodeModules: string): Promise<PlurnkSkill> {
        const file = Paths.teachingSource(TEACHING_CORPUS.skill);
        return new PlurnkSkill(parseSkill(file, "plurnk", await readFile(file, "utf8")), nodeModules);
    }

    async list(): Promise<string[]> {
        return [...this.#files.keys(), ".env.defaults"].sort();
    }

    resource(pathname: string): ByteSource {
        const file = this.#files.get(pathname);
        if (file !== undefined) return new FileByteSource(async () => file);
        return new GeneratedByteSource(async () => {
            if (pathname !== ".env.defaults") return null;
            const sources = await EnvDefaults.collect(dirname(Paths.configuration), this.#nodeModules);
            return new TextEncoder().encode(EnvDefaults.renderCatalog(sources));
        });
    }
}
