// {§persona-discovery} — workspace personas discovered across the 5-tier cascade
// (<project>/.plurnk/personas, <project>/.agents/personas, $XDG_CONFIG_HOME/plurnk/personas,
// $XDG_CONFIG_HOME/agents/personas, ~/.agents/personas) and enabled workspace plugins,
// exposed as read-only `persona://<name>/PERSONA.md` resource trees and `listPersonas`.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    EFFORTS,
    errnoCode,
    SKILL_NAME,
    type ApplicationPersonaProjection,
    type Effort,
    type Notice,
} from "@plurnk/plurnk-contracts";
import { parseSkill, SkillResourceError, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { AgentPluginFiles } from "@plurnk/plurnk-agent-plugins";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { FileByteSource, GeneratedByteSource, Results, type ByteSource, type ResourceTreeSource } from "@plurnk/plurnk-schemes";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import { agentRootScopes, workspacePaths } from "./AgentRoots.ts";
import type WorkspacePlugins from "./WorkspacePlugins.ts";

const { isFile } = AgentPluginFiles;

const isEffort = (value: unknown): value is Effort =>
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value);

const assertContained = (root: string, candidate: string, authored: string): void => {
    const path = relative(root, candidate);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new SkillResourceError(
            "SKILL_PATH_OUTSIDE_ROOT",
            `Persona resource '${authored}' resolves outside its persona directory.`,
        );
    }
};

class PersonaDirectoryTree implements SkillTree {
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
        assertContained(this.directory, candidate, pathname);
        const canonical = await realpath(candidate);
        assertContained(this.directory, canonical, pathname);
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

class PersonaFileTree implements SkillTree {
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

interface DiscoveredPersona {
    readonly projection: ApplicationPersonaProjection;
    readonly tree: SkillTree;
}

export default class WorkspacePersonas {
    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #plugins: WorkspacePlugins;
    readonly #trees = new Map<number, ReadonlyMap<string, SkillTree>>();
    readonly #projections = new Map<number, readonly ApplicationPersonaProjection[]>();
    readonly #notices = new Map<number, readonly Notice[]>();

    constructor({
        db,
        hostPaths,
        plugins,
    }: {
        readonly db: Db;
        readonly hostPaths: HostPaths;
        readonly plugins: WorkspacePlugins;
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        this.#plugins = plugins;
    }

    trees(workspaceId: number): ReadonlyMap<string, SkillTree> {
        return this.#trees.get(workspaceId) ?? new Map();
    }

    notices(workspaceId: number): readonly Notice[] {
        return this.#notices.get(workspaceId) ?? [];
    }

    clear(workspaceId: number): void {
        this.#trees.delete(workspaceId);
        this.#projections.delete(workspaceId);
        this.#notices.delete(workspaceId);
    }

    async refresh(workspaceId: number): Promise<readonly ApplicationPersonaProjection[]> {
        return await this.read(workspaceId);
    }

    async read(workspaceId: number): Promise<readonly ApplicationPersonaProjection[]> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        let paths: ReturnType<typeof workspacePaths>;
        let selectedScopes: ReturnType<typeof agentRootScopes>;
        try {
            paths = workspacePaths(this.#hostPaths, projectRoot);
            selectedScopes = agentRootScopes();
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.#trees.set(workspaceId, new Map());
            this.#projections.set(workspaceId, []);
            this.#notices.set(workspaceId, []);
            return [];
        }
        const { plugins } = await this.#plugins.read(workspaceId);
        const scopes = new Set([
            ...paths.configurationRoots.map(({ scope }) => scope),
            ...plugins.map(({ scope }) => scope),
        ]);

        const discovered = new Map<string, DiscoveredPersona>();
        const notices: Notice[] = [];

        const scanDir = async (personasDir: string, containRoot?: string): Promise<void> => {
            let entries;
            try {
                entries = await readdir(personasDir, { withFileTypes: true });
            } catch (cause) {
                if (errnoCode(cause) === "ENOENT") return;
                notices.push({
                    source: "personas",
                    kind: "configuration_invalid",
                    level: "warn",
                    message: `Persona directory '${personasDir}' could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`,
                });
                return;
            }
            const sorted = [...entries].toSorted((a, b) => a.name.localeCompare(b.name));
            // 1. Directory form: <personasDir>/<name>/PERSONA.md
            for (const entry of sorted) {
                if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
                const name = entry.name;
                if (name.startsWith(".") || !SKILL_NAME.test(name) || discovered.has(name)) continue;
                const candidateDir = join(personasDir, name);
                const candidateFile = join(candidateDir, "PERSONA.md");
                if (!(await isFile(candidateFile))) continue;
                try {
                    const canonicalDir = await realpath(candidateDir);
                    const canonicalFile = await realpath(candidateFile);
                    assertContained(canonicalDir, canonicalFile, "PERSONA.md");
                    if (containRoot !== undefined) {
                        assertContained(containRoot, canonicalDir, `personas/${name}`);
                        assertContained(containRoot, canonicalFile, `personas/${name}/PERSONA.md`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    const parsed = WorkspacePersonas.#parsePersona(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new PersonaDirectoryTree(canonicalDir, parsed.document),
                    });
                } catch (cause) {
                    notices.push({
                        source: "personas",
                        kind: "configuration_invalid",
                        level: "warn",
                        message: cause instanceof Error ? cause.message : String(cause),
                    });
                }
            }
            // 2. Single-file form: <personasDir>/<name>.md
            for (const entry of sorted) {
                if (!entry.isFile() && !entry.isSymbolicLink()) continue;
                if (!entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
                const name = entry.name.slice(0, -".md".length);
                if (!SKILL_NAME.test(name) || discovered.has(name)) continue;
                const candidateFile = join(personasDir, entry.name);
                if (!(await isFile(candidateFile))) continue;
                try {
                    const canonicalFile = await realpath(candidateFile);
                    if (containRoot !== undefined) {
                        assertContained(containRoot, canonicalFile, `personas/${entry.name}`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    const parsed = WorkspacePersonas.#parsePersona(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new PersonaFileTree(canonicalFile, parsed.document),
                    });
                } catch (cause) {
                    notices.push({
                        source: "personas",
                        kind: "configuration_invalid",
                        level: "warn",
                        message: cause instanceof Error ? cause.message : String(cause),
                    });
                }
            }
        };

        for (const scope of scopes) {
            if (scope === "project" && projectRoot !== null && selectedScopes.has("project")) {
                await scanDir(join(resolve(projectRoot), ".plurnk", "personas"));
            }
            const root = paths.configurationRoots.find((candidate) => candidate.scope === scope);
            if (root !== undefined) {
                await scanDir(join(root.directory, "personas"));
            }
            for (const plugin of plugins.filter((candidate) => candidate.scope === scope)) {
                await scanDir(join(plugin.root, "personas"), plugin.root);
            }
        }

        const trees = new Map<string, SkillTree>();
        const projections: ApplicationPersonaProjection[] = [];
        for (const [name, item] of [...discovered.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
            trees.set(name, item.tree);
            projections.push(item.projection);
        }
        this.#trees.set(workspaceId, trees);
        this.#projections.set(workspaceId, projections);
        this.#notices.set(workspaceId, notices);
        return projections;
    }

    static #parsePersona(
        file: string,
        expectedName: string,
        source: string,
    ): { readonly projection: ApplicationPersonaProjection; readonly document: ReturnType<typeof parseSkill> } {
        const document = parseSkill(file, expectedName, source);
        const body = document.body.trim();
        if (body.length === 0) {
            throw new Error(`${file}: Persona '${expectedName}' requires non-empty instruction body.`);
        }
        const rawModel = document.metadata.model;
        let model: string | undefined;
        if (rawModel !== undefined) {
            if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
                throw new Error(`${file}: Persona '${expectedName}' frontmatter 'model' must be a non-empty string.`);
            }
            model = rawModel.trim();
        }
        const rawEffort = document.metadata.effort;
        let effort: Effort | undefined;
        if (rawEffort !== undefined) {
            if (!isEffort(rawEffort)) {
                throw new Error(
                    `${file}: Persona '${expectedName}' frontmatter 'effort' must be one of ${EFFORTS.join(", ")}.`,
                );
            }
            effort = rawEffort;
        }
        return {
            document,
            projection: {
                name: document.name,
                description: document.description,
                body,
                source: document.source,
                ...(model === undefined ? {} : { model }),
                ...(effort === undefined ? {} : { effort }),
            },
        };
    }

    static readonly refusal: NonNullable<ResourceTreeSource["refusal"]> = (cause, address) => {
        const target = `persona://${address.authority}${address.pathname}`;
        if (errnoCode(cause) === "ENOENT") {
            return Results.failure(
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
        return Results.failure(
            "scheme:persona",
            outside ? "resource-outside-root" : "resource-invalid",
            outside ? 403 : 400,
            cause.message,
            {},
            { target },
        );
    };
}
