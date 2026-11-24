// {§provided-skills-module-slice} {§agent-skills-directory} Contained filesystem, single-file,
// and inline resource trees shared by Agent Skills and Personas.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FileByteSource, GeneratedByteSource, type ByteSource } from "@plurnk/plurnk-schemes";
import type { SkillDocument } from "./SkillDocument.ts";

export class SkillResourceError extends Error {
    readonly code: "SKILL_PATH_OUTSIDE_ROOT" | "SKILL_RESOURCE_NOT_FILE" | "SKILL_DIRECTORY_CYCLE";

    constructor(code: SkillResourceError["code"], message: string) {
        super(message);
        this.name = "SkillResourceError";
        this.code = code;
    }
}

export interface DocumentResourceTree {
    readonly document: SkillDocument;
    list(): Promise<string[]>;
    resource(pathname: string): ByteSource;
}

export const assertContainedPath = (
    root: string,
    candidate: string,
    authored: string,
    label = "Skill",
): void => {
    const path = relative(root, candidate);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        const lower = label.toLowerCase();
        throw new SkillResourceError(
            "SKILL_PATH_OUTSIDE_ROOT",
            `${label} resource '${authored}' resolves outside its ${lower} directory.`,
        );
    }
};

const isPathTraversal = (pathname: string): boolean =>
    isAbsolute(pathname)
    || pathname === ".."
    || pathname.startsWith("../")
    || pathname.includes("/../")
    || pathname.endsWith("/..");

export class ContainedDirectoryTree implements DocumentResourceTree {
    readonly directory: string;
    readonly document: SkillDocument;
    readonly #label: string;
    readonly #lowerLabel: string;

    constructor(directory: string, document: SkillDocument, label = "Skill") {
        this.directory = directory;
        this.document = document;
        this.#label = label;
        this.#lowerLabel = label.toLowerCase();
    }

    async #resolve(pathname: string): Promise<string> {
        if (isAbsolute(pathname)) {
            throw new SkillResourceError(
                "SKILL_PATH_OUTSIDE_ROOT",
                `${this.#label} resource '${pathname}' is not relative to its ${this.#lowerLabel} directory.`,
            );
        }
        const candidate = resolve(this.directory, pathname);
        assertContainedPath(this.directory, candidate, pathname, this.#label);
        const canonical = await realpath(candidate);
        assertContainedPath(this.directory, canonical, pathname, this.#label);
        return canonical;
    }

    async resolve(pathname: string): Promise<string> {
        const canonical = await this.#resolve(pathname);
        if (!(await stat(canonical)).isFile()) {
            throw new SkillResourceError(
                "SKILL_RESOURCE_NOT_FILE",
                `${this.#label} resource '${pathname}' is not a regular file.`,
            );
        }
        return canonical;
    }

    read(pathname: string): Promise<Buffer> {
        return this.resolve(pathname).then((file) => readFile(file));
    }

    resource(pathname: string): FileByteSource {
        return new FileByteSource(() => this.resolve(pathname));
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
                throw new SkillResourceError(
                    "SKILL_RESOURCE_NOT_FILE",
                    `${this.#label} resource '${pathname}' is not a regular file or directory.`,
                );
            }
            if (ancestors.has(canonical)) {
                throw new SkillResourceError(
                    "SKILL_DIRECTORY_CYCLE",
                    `${this.#label} directory '${pathname}' contains a symbolic-link cycle.`,
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

export class SingleFileResourceTree implements DocumentResourceTree {
    readonly file: string;
    readonly document: SkillDocument;
    readonly #entryName: string;
    readonly #label: string;
    readonly #lowerLabel: string;

    constructor(file: string, document: SkillDocument, entryName = "PERSONA.md", label = "Persona") {
        this.file = file;
        this.document = document;
        this.#entryName = entryName;
        this.#label = label;
        this.#lowerLabel = label.toLowerCase();
    }

    async list(): Promise<string[]> {
        return [this.#entryName];
    }

    resource(pathname: string): ByteSource {
        if (pathname !== this.#entryName) {
            return new GeneratedByteSource(async () => {
                if (isPathTraversal(pathname)) {
                    throw new SkillResourceError(
                        "SKILL_PATH_OUTSIDE_ROOT",
                        `${this.#label} resource '${pathname}' resolves outside its ${this.#lowerLabel} directory.`,
                    );
                }
                return null;
            });
        }
        return new FileByteSource(async () => this.file);
    }
}

export class InlineResourceTree implements DocumentResourceTree {
    readonly document: SkillDocument;
    readonly #entryName: string;
    readonly #label: string;
    readonly #lowerLabel: string;
    readonly #bytes: Uint8Array;

    constructor(document: SkillDocument, entryName = "PERSONA.md", label = "Persona") {
        this.document = document;
        this.#entryName = entryName;
        this.#label = label;
        this.#lowerLabel = label.toLowerCase();
        this.#bytes = new TextEncoder().encode(document.source);
    }

    async list(): Promise<string[]> {
        return [this.#entryName];
    }

    resource(pathname: string): ByteSource {
        if (pathname !== this.#entryName) {
            return new GeneratedByteSource(async () => {
                if (isPathTraversal(pathname)) {
                    throw new SkillResourceError(
                        "SKILL_PATH_OUTSIDE_ROOT",
                        `${this.#label} resource '${pathname}' resolves outside its ${this.#lowerLabel} directory.`,
                    );
                }
                return null;
            });
        }
        return new GeneratedByteSource(async () => this.#bytes);
    }
}
