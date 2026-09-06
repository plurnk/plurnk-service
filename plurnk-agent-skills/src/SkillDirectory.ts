import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSkill, type SkillDocument } from "./SkillDocument.ts";

export class SkillResourceError extends Error {
    readonly code: "SKILL_PATH_OUTSIDE_ROOT" | "SKILL_RESOURCE_NOT_FILE" | "SKILL_DIRECTORY_CYCLE";

    constructor(code: SkillResourceError["code"], message: string) {
        super(message);
        this.name = "SkillResourceError";
        this.code = code;
    }
}

// {§agent-skills-directory} A loaded skill is a source tree, not a flattened document.
export default class SkillDirectory {
    readonly directory: string;
    readonly document: SkillDocument;

    private constructor(directory: string, document: SkillDocument) {
        this.directory = directory;
        this.document = document;
    }

    static async load(directory: string): Promise<SkillDirectory> {
        const canonical = await realpath(directory);
        const file = join(canonical, "SKILL.md");
        const resolved = await realpath(file);
        SkillDirectory.#assertContained(canonical, resolved, "SKILL.md");
        const source = await readFile(resolved, "utf8");
        return new SkillDirectory(canonical, parseSkill(file, basename(resolve(directory)), source));
    }

    static #assertContained(root: string, candidate: string, authored: string): void {
        const path = relative(root, candidate);
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
            throw new SkillResourceError("SKILL_PATH_OUTSIDE_ROOT", `Skill resource '${authored}' resolves outside its skill directory.`);
        }
    }

    async #resolve(pathname: string): Promise<string> {
        if (isAbsolute(pathname)) {
            throw new SkillResourceError("SKILL_PATH_OUTSIDE_ROOT", `Skill resource '${pathname}' is not relative to its skill directory.`);
        }
        const candidate = resolve(this.directory, pathname);
        SkillDirectory.#assertContained(this.directory, candidate, pathname);
        const canonical = await realpath(candidate);
        SkillDirectory.#assertContained(this.directory, canonical, pathname);
        return canonical;
    }

    async resolve(pathname: string): Promise<string> {
        const canonical = await this.#resolve(pathname);
        if (!(await stat(canonical)).isFile()) {
            throw new SkillResourceError("SKILL_RESOURCE_NOT_FILE", `Skill resource '${pathname}' is not a regular file.`);
        }
        return canonical;
    }

    read(pathname: string): Promise<Buffer> {
        return this.resolve(pathname).then((file) => readFile(file));
    }

    // {§agent-skills-disclosure} Walk names only; file bodies remain demand-loaded.
    async list(): Promise<string[]> {
        const files: string[] = [];
        const visit = async (pathname: string, ancestors: ReadonlySet<string>): Promise<void> => {
            const canonical = await this.#resolve(pathname);
            const info = await stat(canonical);
            if (info.isFile()) {
                files.push(pathname.split(sep).join("/"));
                return;
            }
            if (!info.isDirectory()) {
                throw new SkillResourceError("SKILL_RESOURCE_NOT_FILE", `Skill resource '${pathname}' is not a regular file or directory.`);
            }
            if (ancestors.has(canonical)) {
                throw new SkillResourceError("SKILL_DIRECTORY_CYCLE", `Skill directory '${pathname}' contains a symbolic-link cycle.`);
            }
            const next = new Set([...ancestors, canonical]);
            for (const name of (await readdir(canonical)).sort()) {
                await visit(join(pathname, name), next);
            }
        };
        await visit("", new Set());
        return files.sort();
    }
}
