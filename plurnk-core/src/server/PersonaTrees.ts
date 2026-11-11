// {§persona-discovery} — contained directory, single-file, and inline persona resource trees.
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { errnoCode } from "@plurnk/plurnk-contracts";
import { SkillResourceError, type parseSkill, type SkillTree } from "@plurnk/plurnk-agent-skills";
import {
    FileByteSource,
    GeneratedByteSource,
    Results as SchemeResults,
    type ByteSource,
    type ResourceTreeSource,
} from "@plurnk/plurnk-schemes";

export const assertPersonaContained = (root: string, candidate: string, authored: string): void => {
    const path = relative(root, candidate);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new SkillResourceError(
            "SKILL_PATH_OUTSIDE_ROOT",
            `Persona resource '${authored}' resolves outside its persona directory.`,
        );
    }
};

export class PersonaDirectoryTree implements SkillTree {
    readonly directory: string;
    readonly document: ReturnType<typeof parseSkill>;

    constructor(directory: string, document: ReturnType<typeof parseSkill>) {
        this.directory = directory;
        this.document = document;
    }

    async #resolve(pathname: string): Promise<string> {
        if (isAbsolute(pathname)) {
            throw new SkillResourceError(
                "SKILL_PATH_OUTSIDE_ROOT",
                `Persona resource '${pathname}' is not relative to its persona directory.`,
            );
        }
        const candidate = resolve(this.directory, pathname);
        assertPersonaContained(this.directory, candidate, pathname);
        const canonical = await realpath(candidate);
        assertPersonaContained(this.directory, canonical, pathname);
        return canonical;
    }

    async resolve(pathname: string): Promise<string> {
        const canonical = await this.#resolve(pathname);
        if (!(await stat(canonical)).isFile()) {
            throw new SkillResourceError(
                "SKILL_RESOURCE_NOT_FILE",
                `Persona resource '${pathname}' is not a regular file.`,
            );
        }
        return canonical;
    }

    resource(pathname: string): ByteSource {
        return new FileByteSource(() => this.resolve(pathname));
    }

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
                throw new SkillResourceError(
                    "SKILL_RESOURCE_NOT_FILE",
                    `Persona resource '${pathname}' is not a regular file or directory.`,
                );
            }
            if (ancestors.has(canonical)) {
                throw new SkillResourceError(
                    "SKILL_DIRECTORY_CYCLE",
                    `Persona directory '${pathname}' contains a symbolic-link cycle.`,
                );
            }
            const next = new Set([...ancestors, canonical]);
            for (const name of (await readdir(canonical)).toSorted()) {
                await visit(join(pathname, name), next);
            }
        };
        await visit("", new Set());
        return files.toSorted();
    }
}

export class PersonaFileTree implements SkillTree {
    readonly file: string;
    readonly document: ReturnType<typeof parseSkill>;

    constructor(file: string, document: ReturnType<typeof parseSkill>) {
        this.file = file;
        this.document = document;
    }

    async list(): Promise<string[]> {
        return ["PERSONA.md"];
    }

    resource(pathname: string): ByteSource {
        if (pathname !== "PERSONA.md") {
            return new GeneratedByteSource(async () => {
                if (
                    isAbsolute(pathname)
                    || pathname === ".."
                    || pathname.startsWith("../")
                    || pathname.includes("/../")
                    || pathname.endsWith("/..")
                ) {
                    throw new SkillResourceError(
                        "SKILL_PATH_OUTSIDE_ROOT",
                        `Persona resource '${pathname}' resolves outside its persona directory.`,
                    );
                }
                return null;
            });
        }
        return new FileByteSource(async () => this.file);
    }
}

export class PersonaInlineTree implements SkillTree {
    readonly document: ReturnType<typeof parseSkill>;
    readonly #bytes: Uint8Array;

    constructor(document: ReturnType<typeof parseSkill>) {
        this.document = document;
        this.#bytes = new TextEncoder().encode(document.source);
    }

    async list(): Promise<string[]> {
        return ["PERSONA.md"];
    }

    resource(pathname: string): ByteSource {
        if (pathname !== "PERSONA.md") {
            return new GeneratedByteSource(async () => {
                if (
                    isAbsolute(pathname)
                    || pathname === ".."
                    || pathname.startsWith("../")
                    || pathname.includes("/../")
                    || pathname.endsWith("/..")
                ) {
                    throw new SkillResourceError(
                        "SKILL_PATH_OUTSIDE_ROOT",
                        `Persona resource '${pathname}' resolves outside its persona directory.`,
                    );
                }
                return null;
            });
        }
        return new GeneratedByteSource(async () => this.#bytes);
    }
}

export const personaTreeRefusal: NonNullable<ResourceTreeSource["refusal"]> = (cause, address) => {
    const target = `persona://${address.authority}${address.pathname}`;
    if (errnoCode(cause) === "ENOENT") {
        return SchemeResults.failure(
            "scheme:persona",
            "entry-not-found",
            404,
            `No persona resource exists at ${target}.`,
            {},
            { target },
        );
    }
    if (!(cause instanceof SkillResourceError)) return null;
    const outside = cause.code === "SKILL_PATH_OUTSIDE_ROOT";
    return SchemeResults.failure(
        "scheme:persona",
        outside ? "resource-outside-root" : "resource-invalid",
        outside ? 403 : 400,
        cause.message,
        {},
        { target },
    );
};
