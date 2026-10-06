import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, type SkillDocument, type SkillTree } from "@plurnk/plurnk-agent-skills";
import Meta, { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { FileByteSource, GeneratedByteSource, type ByteSource } from "@plurnk/plurnk-schemes";
import Paths from "../Paths.ts";
import EnvDefaults from "../core/env-defaults.ts";

const SERVICE = "@plurnk/plurnk-service";

// {§plurnk-skill} Core composes sources; their packages remain their authors.
export default class PlurnkSkill implements SkillTree {
    readonly document: SkillDocument;
    readonly #nodeModules: string;
    readonly #files = new Map([
        ["SKILL.md", Paths.teachingSource(TEACHING_CORPUS.skill)],
        ["references/configuration.md", Paths.configuration],
        ["references/copy-move.md", resolve(dirname(Paths.configuration), "docs/copy-move.md")],
        ["references/extensibility.md", Paths.teachingSource(TEACHING_CORPUS.skillChapters.extensibility)],
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
        return [...this.#files.keys(), ".env.defaults", ...(await this.#contracts()).keys()].sort();
    }

    resource(pathname: string): ByteSource {
        const file = this.#files.get(pathname);
        if (file !== undefined) return new FileByteSource(async () => file);
        if (pathname.startsWith("packages/")) return new FileByteSource(async () => (await this.#contracts()).get(pathname) ?? null);
        return new GeneratedByteSource(async () => {
            if (pathname !== ".env.defaults") return null;
            const sources = await EnvDefaults.collect(dirname(Paths.configuration), this.#nodeModules);
            return new TextEncoder().encode(EnvDefaults.renderCatalog(sources.files));
        });
    }

    // The service's own contract, then each installed ecosystem member's that ships one with its
    // published type declarations, read where its package installed them: the membership of the
    // defaults catalog, observed when asked. The service's declarations are its internals, not a contract.
    async #contracts(): Promise<ReadonlyMap<string, string>> {
        const members = await EnvDefaults.members(await Meta.packageDirs(this.#nodeModules));
        const contracts = new Map<string, string>();
        for (const { name, dir } of [{ name: SERVICE, dir: Paths.packageRoot }, ...members.filter(({ name }) => name !== SERVICE)]) {
            if (!await PlurnkSkill.#isFile(join(dir, "SPEC.md"))) continue;
            contracts.set(`packages/${name}/SPEC.md`, join(dir, "SPEC.md"));
            if (name === SERVICE) continue;
            for (const file of await PlurnkSkill.#declarations(join(dir, "dist"))) {
                contracts.set(`packages/${name}/${relative(dir, file)}`, file);
            }
        }
        return contracts;
    }

    static async #isFile(file: string): Promise<boolean> {
        try {
            return (await stat(file)).isFile();
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw cause;
        }
    }

    // Regular `.d.ts` files beneath `dist/`; a symbolic link is never followed out of the package.
    static async #declarations(dist: string): Promise<string[]> {
        try {
            return (await readdir(dist, { recursive: true, withFileTypes: true }))
                .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
                .map((entry) => join(entry.parentPath, entry.name));
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw cause;
        }
    }
}
