// {§persona-discovery} — workspace personas as a workspace Functionality family (`personas`,
// `plurnk.personas(...)`, `PLURNK_PERSONAS_*`) discovered across the 4-tier configuration cascade
// (<project>/.agents/personas, $XDG_CONFIG_HOME/plurnk/personas, $XDG_CONFIG_HOME/agents/personas,
// ~/.agents/personas), environment definitions, and workspace overrides,
// exposed through `persona://<name>/PERSONA.md` (`READ`, `FIND`, `EDIT`, `KILL`) and `listPersonas`.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    SKILL_NAME,
    errnoCode,
    isRecord,
    type ApplicationPersonaProjection,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityIdentity,
    type FunctionalityOrigin,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type FunctionalityPreparedDefinition,
    type FunctionalityServiceDefinition,
    type JsonSchema,
    type Notice,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import {
    ContainedDirectoryTree,
    InlineResourceTree,
    SingleFileResourceTree,
    assertContainedPath,
    type SkillTree,
} from "@plurnk/plurnk-agent-skills";
import { ConfigurationError, isLexicallyWithinDirectory, isWithinDirectory } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter, FunctionalityDiscovery, ModuleSetupSeam, WorkspacePaths } from "@plurnk/plurnk-modules";
import type { ResourceTreeSource } from "@plurnk/plurnk-schemes";
import {
    PERSONA_DEFINITION_SCHEMA,
    PERSONAS_FAMILY,
    PERSONAS_OWNER,
    PERSONAS_PREFIX,
    PersonasActionError,
    formatPersonaMarkdown,
    inferPersonaNameFromPath,
    injectPersonaNameIfMissing,
    isInlineDefinition,
    parsePersonaDefinitionObject,
    parsePersonaDocument,
    parsePersonaEditBody,
    personaProblem,
    personasEnvironment,
    refusePersona,
    servicePersonas,
    type PersonaDefinition,
    type PersonaSourceDefinition,
} from "./PersonaDefinition.ts";
import { personaTreeRefusal } from "./PersonaScheme.ts";

export type PersonaSourceSeam = Pick<
    ModuleSetupSeam,
    "workspacePaths" | "servicePaths" | "readWorkspaceModuleState" | "readServiceModuleState"
>;

const COLD_WORKSPACE_CACHE_LIMIT = 16;

const isInsidePath = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const isFile = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isFile();
    } catch (cause) {
        const code = errnoCode(cause);
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw cause;
    }
};

interface DiscoveredPersona {
    readonly projection: ApplicationPersonaProjection;
    readonly tree: SkillTree;
    readonly definition: PersonaSourceDefinition;
    readonly provenance: {
        readonly kind: "directory" | "file";
        readonly source: string;
        readonly reference: string;
    };
}

interface ScanResult {
    readonly paths: WorkspacePaths;
    readonly projectRoot: string | null;
    readonly discovered: ReadonlyMap<string, DiscoveredPersona>;
    readonly notices: readonly Notice[];
    readonly signatureParts: readonly string[];
}

export interface PersonaSnapshot {
    readonly signature: string;
    readonly trees: ReadonlyMap<string, SkillTree>;
    readonly projections: readonly ApplicationPersonaProjection[];
    readonly notices: readonly Notice[];
    readonly definitions: ReadonlyMap<string, PersonaDefinition>;
    readonly exemptAliases: ReadonlySet<string>;
    readonly unavailable: readonly string[];
}

interface PersistedPersonaEntry {
    readonly origin: "host" | "service" | "workspace";
    readonly enabled: boolean;
    readonly definition?: PersonaDefinition;
}

const parsePersistedPersonaState = (
    raw: unknown,
    scope: "service" | "workspace" = "workspace",
): Readonly<Record<string, PersistedPersonaEntry>> => {
    if (raw === null || raw === undefined) return {};
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.definitions)) {
        throw new Error("Persisted persona state is not a version 1 record.");
    }
    const out: Record<string, PersistedPersonaEntry> = {};
    for (const [alias, value] of Object.entries(raw.definitions)) {
        if (!SKILL_NAME.test(alias) || !isRecord(value) || typeof value.enabled !== "boolean") {
            throw new Error(`Persisted persona state has invalid alias '${alias}'.`);
        }
        if (value.origin === scope) {
            out[alias] = {
                origin: scope,
                enabled: value.enabled,
                definition: parsePersonaDefinitionObject(value.definition),
            };
        } else if (value.origin === "host" || (scope === "workspace" && value.origin === "service")) {
            out[alias] = {
                origin: value.origin,
                enabled: value.enabled,
            };
        } else {
            throw new Error(`Persisted persona state for '${alias}' has invalid origin.`);
        }
    }
    return out;
};

export default class PersonasFunctionality implements FunctionalityAdapter<never, never, PersonaDefinition, PersonaSnapshot> {
    readonly family = PERSONAS_FAMILY;
    readonly namespaceOwner = PERSONAS_OWNER;
    readonly aliasPattern = SKILL_NAME;
    readonly summary = "List ({}) or manage personas.";
    readonly definitionSchema: JsonSchema = PERSONA_DEFINITION_SCHEMA;
    readonly example = {
        alias: "professor",
        description: "Rigorous first-principles teacher.",
        body: "Explain from invariants before examples.",
        effort: "high" as const,
    };
    readonly docsDir = resolve(import.meta.dirname, "..");
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query", "source"],
        emptyListsAll: true,
        details: "`{\"discover\": true}` or `{\"discover\": \"<query>\"}` lists personas discovered from active configuration roots; `{\"discover\": {\"source\": \"...\"}}` inspects a persona file or directory. Returns candidates with addable definitions.",
    };

    readonly #seam: PersonaSourceSeam;
    readonly #env: NodeJS.ProcessEnv | undefined;
    readonly #snapshots = new Map<number, PersonaSnapshot>();
    readonly #trees = new Map<number, ReadonlyMap<string, SkillTree>>();
    readonly #projections = new Map<number, readonly ApplicationPersonaProjection[]>();
    readonly #notices = new Map<number, readonly Notice[]>();
    readonly #scanned = new Map<number, ScanResult>();
    readonly #exemptDefinitions = new Map<number, ReadonlyMap<string, PersonaDefinition>>();
    readonly #coldWorkspaces = new Set<number>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor(seam: PersonaSourceSeam, options: { readonly env?: NodeJS.ProcessEnv } = {}) {
        this.#seam = seam;
        this.#env = options.env;
    }

    static validateConfiguration(environ: NodeJS.ProcessEnv = process.env): void {
        servicePersonas(environ);
    }

    async #pathsFor(identity: FunctionalityIdentity): Promise<WorkspacePaths> {
        if (identity.scope === "service") {
            if (this.#seam.servicePaths !== undefined) return this.#seam.servicePaths();
            return { home: this.#effectiveEnv().HOME ?? "", projectRoot: null, configurationRoots: [], projectRootConfinement: "unrestricted" };
        }
        return await this.#seam.workspacePaths(identity.workspaceId);
    }

    #isExemptEntry(workspaceId: number, alias: string, entry: FunctionalityPreparedDefinition<PersonaDefinition>): boolean {
        if (entry.origin !== undefined) return entry.origin === "host";
        return this.#isExemptDefinition(workspaceId, alias, entry.definition);
    }

    #isExemptDefinition(workspaceId: number, alias: string, definition: PersonaDefinition): boolean {
        const exempt = this.#exemptDefinitions.get(workspaceId)?.get(alias);
        return exempt !== undefined && isDeepStrictEqual(exempt, definition);
    }

    // {§persona-discovery} {§operator-config-workspace-settings} — enforce project-root confinement on
    // non-exempt local workspace persona paths before touching files outside the workspace.
    async #resolveContainedLocalSource(
        rawSource: string,
        paths: WorkspacePaths,
        alias?: string,
    ): Promise<string> {
        const confinement = paths.projectRootConfinement ?? "unrestricted";
        const trimmed = rawSource.trim();
        if (confinement === "none") {
            throw refusePersona(
                "persona-source-forbidden",
                403,
                "Local filesystem persona sources are unavailable while project roots are disabled by operator policy.",
                {
                    ...(alias === undefined ? {} : { alias }),
                    recovery: "Use an inline { description, body } persona definition.",
                },
            );
        }
        if (trimmed.length === 0) {
            throw refusePersona("source-invalid", 400, "Persona source must be a non-empty path.", {
                ...(alias === undefined ? {} : { alias }),
            });
        }
        if (confinement === "confined") {
            if (paths.projectRoot === null) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local filesystem persona sources require a workspace project root under confined operator policy.",
                    {
                        ...(alias === undefined ? {} : { alias }),
                        recovery: "Use an inline { description, body } persona definition or open a workspace with a project root.",
                    },
                );
            }
            if (trimmed === "~" || trimmed.startsWith("~/")) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    {
                        ...(alias === undefined ? {} : { alias }),
                        recovery: "Use a path inside this workspace's project root or an inline { description, body } persona.",
                    },
                );
            }
            const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(paths.projectRoot, trimmed);
            if (!isLexicallyWithinDirectory(paths.projectRoot, resolvedPath)) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    {
                        ...(alias === undefined ? {} : { alias }),
                        recovery: "Use a path inside this workspace's project root or an inline { description, body } persona.",
                    },
                );
            }
            if (!(await isWithinDirectory(paths.projectRoot, resolvedPath))) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    {
                        ...(alias === undefined ? {} : { alias }),
                        recovery: "Use a path inside this workspace's project root or an inline { description, body } persona.",
                    },
                );
            }
            return resolvedPath;
        }
        if (!isAbsolute(trimmed) && paths.projectRoot === null) {
            throw refusePersona(
                "source-relative-without-project",
                400,
                `Relative persona source '${trimmed}' requires a workspace project root.`,
                { ...(alias === undefined ? {} : { alias }), source: trimmed },
            );
        }
        return isAbsolute(trimmed) ? resolve(trimmed) : resolve(paths.projectRoot!, trimmed);
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
    }

    handle(): FunctionalityFamilyHandle {
        if (this.#handle === null) throw new Error("personas family is not attached");
        return this.#handle;
    }

    trees(workspaceId: number): ReadonlyMap<string, SkillTree> {
        return this.#trees.get(workspaceId) ?? new Map();
    }

    notices(workspaceId: number): readonly Notice[] {
        return this.#notices.get(workspaceId) ?? [];
    }

    configurationNotices(identity: WorkspaceCapabilityIdentity): readonly Notice[] {
        return this.#notices.get(identity.workspaceId) ?? [];
    }

    clear(workspaceId: number): void {
        this.#snapshots.delete(workspaceId);
        this.#trees.delete(workspaceId);
        this.#projections.delete(workspaceId);
        this.#notices.delete(workspaceId);
        this.#scanned.delete(workspaceId);
        this.#exemptDefinitions.delete(workspaceId);
        this.#coldWorkspaces.delete(workspaceId);
    }

    #trackColdWorkspace(workspaceId: number): void {
        if (this.#snapshots.has(workspaceId)) {
            this.#coldWorkspaces.delete(workspaceId);
            return;
        }
        this.#coldWorkspaces.delete(workspaceId);
        this.#coldWorkspaces.add(workspaceId);
        while (this.#coldWorkspaces.size > COLD_WORKSPACE_CACHE_LIMIT) {
            const oldest = this.#coldWorkspaces.values().next().value;
            if (oldest === undefined) break;
            this.#coldWorkspaces.delete(oldest);
            if (!this.#snapshots.has(oldest)) this.clear(oldest);
        }
    }

    #effectiveEnv(): NodeJS.ProcessEnv {
        return this.#env ?? process.env;
    }

    async #scanRoots(workspaceId: number): Promise<ScanResult> {
        const result = await this.#scanRootsForPaths(await this.#seam.workspacePaths(workspaceId));
        this.#scanned.set(workspaceId, result);
        return result;
    }

    async #scanRootsForPaths(paths: WorkspacePaths): Promise<ScanResult> {
        const { projectRoot } = paths;
        const canonicalProjectRoot = projectRoot === null ? null : await realpath(projectRoot).catch(() => null);

        const discovered = new Map<string, DiscoveredPersona>();
        const notices: Notice[] = [];
        const signatureParts: string[] = [];

        const scanDir = async (personasDir: string, scope: string): Promise<void> => {
            if (scope === "project" && canonicalProjectRoot === null) return;
            let entries;
            try {
                entries = await readdir(personasDir, { withFileTypes: true });
            } catch (cause) {
                if (errnoCode(cause) === "ENOENT") return;
                const message = `Persona directory '${personasDir}' could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`;
                signatureParts.push(`err:${personasDir}:${message}`);
                notices.push({
                    source: "personas",
                    kind: "configuration_invalid",
                    level: "warn",
                    message,
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
                    if (
                        scope === "project"
                        && canonicalProjectRoot !== null
                        && (!isInsidePath(canonicalProjectRoot, canonicalDir) || !isInsidePath(canonicalProjectRoot, canonicalFile))
                    ) {
                        continue;
                    }
                    assertContainedPath(canonicalDir, canonicalFile, "PERSONA.md", "Persona");
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`dir:${name}:${canonicalDir}:${source}`);
                    const parsed = parsePersonaDocument(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new ContainedDirectoryTree(canonicalDir, parsed.document, "Persona"),
                        definition: {
                            source: canonicalDir,
                            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                        },
                        provenance: {
                            kind: "directory",
                            source: canonicalDir,
                            reference: canonicalFile,
                        },
                    });
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    signatureParts.push(`invalid-dir:${candidateFile}:${message}`);
                    notices.push({
                        source: "personas",
                        kind: "configuration_invalid",
                        level: "warn",
                        message,
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
                    if (
                        scope === "project"
                        && canonicalProjectRoot !== null
                        && !isInsidePath(canonicalProjectRoot, canonicalFile)
                    ) {
                        continue;
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`file:${name}:${canonicalFile}:${source}`);
                    const parsed = parsePersonaDocument(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new SingleFileResourceTree(canonicalFile, parsed.document, "PERSONA.md", "Persona"),
                        definition: {
                            source: canonicalFile,
                            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                        },
                        provenance: {
                            kind: "file",
                            source: canonicalFile,
                            reference: canonicalFile,
                        },
                    });
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    signatureParts.push(`invalid-file:${candidateFile}:${message}`);
                    notices.push({
                        source: "personas",
                        kind: "configuration_invalid",
                        level: "warn",
                        message,
                    });
                }
            }
        };

        for (const root of paths.configurationRoots) {
            await scanDir(join(root.directory, "personas"), root.scope);
        }

        return { paths, projectRoot, discovered, notices, signatureParts };
    }

    async #loadDefinition(
        alias: string,
        definition: PersonaDefinition,
        paths: WorkspacePaths,
        scanned?: ReadonlyMap<string, DiscoveredPersona>,
        enforceContainment = false,
    ): Promise<{ readonly projection: ApplicationPersonaProjection; readonly tree: SkillTree }> {
        if (isInlineDefinition(definition)) {
            const markdown = formatPersonaMarkdown(alias, definition);
            const parsed = parsePersonaDocument(`persona://${alias}/PERSONA.md`, alias, markdown);
            return {
                projection: parsed.projection,
                tree: new InlineResourceTree(parsed.document, "PERSONA.md", "Persona"),
            };
        }
        const rawSource = definition.source.trim();
        const confinement = paths.projectRootConfinement ?? "unrestricted";
        let resolvedPath: string;
        if (enforceContainment) {
            resolvedPath = await this.#resolveContainedLocalSource(rawSource, paths, alias);
        } else {
            if (!isAbsolute(rawSource) && paths.projectRoot === null) {
                throw refusePersona(
                    "source-relative-without-project",
                    400,
                    `Relative persona source '${rawSource}' requires a workspace project root.`,
                    { alias, source: rawSource },
                );
            }
            resolvedPath = isAbsolute(rawSource) ? resolve(rawSource) : resolve(paths.projectRoot!, rawSource);
        }
        const preScanned = scanned?.get(alias);
        if (
            preScanned !== undefined
            && preScanned.definition.source === resolvedPath
            && (definition.model === undefined || definition.model === preScanned.projection.model)
            && (definition.effort === undefined || definition.effort === preScanned.projection.effort)
        ) {
            return { projection: preScanned.projection, tree: preScanned.tree };
        }
        let info;
        try {
            info = await stat(resolvedPath);
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") {
                throw refusePersona("source-not-found", 404, `Persona source '${rawSource}' does not exist.`, {
                    alias,
                    source: rawSource,
                });
            }
            throw cause;
        }
        if (info.isDirectory()) {
            const candidateFile = join(resolvedPath, "PERSONA.md");
            if (
                enforceContainment
                && confinement === "confined"
                && paths.projectRoot !== null
                && !(await isWithinDirectory(paths.projectRoot, candidateFile))
            ) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    { alias },
                );
            }
            if (!(await isFile(candidateFile))) {
                throw refusePersona("persona-not-found", 404, `Persona directory '${rawSource}' does not contain PERSONA.md.`, {
                    alias,
                    source: rawSource,
                });
            }
            const canonicalDir = await realpath(resolvedPath);
            const canonicalFile = await realpath(candidateFile);
            if (
                enforceContainment
                && confinement === "confined"
                && paths.projectRoot !== null
                && (!(await isWithinDirectory(paths.projectRoot, canonicalDir)) || !(await isWithinDirectory(paths.projectRoot, canonicalFile)))
            ) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    { alias },
                );
            }
            assertContainedPath(canonicalDir, canonicalFile, "PERSONA.md", "Persona");
            const content = await readFile(canonicalFile, "utf8");
            const parsed = parsePersonaDocument(
                candidateFile,
                alias,
                injectPersonaNameIfMissing(alias, content),
                { model: definition.model, effort: definition.effort },
            );
            return {
                projection: parsed.projection,
                tree: new ContainedDirectoryTree(canonicalDir, parsed.document, "Persona"),
            };
        }
        if (info.isFile()) {
            const canonicalFile = await realpath(resolvedPath);
            if (
                enforceContainment
                && confinement === "confined"
                && paths.projectRoot !== null
                && !(await isWithinDirectory(paths.projectRoot, canonicalFile))
            ) {
                throw refusePersona(
                    "persona-source-forbidden",
                    403,
                    "Local persona source is outside the workspace project root.",
                    { alias },
                );
            }
            const content = await readFile(canonicalFile, "utf8");
            const parsed = parsePersonaDocument(
                resolvedPath,
                alias,
                injectPersonaNameIfMissing(alias, content),
                { model: definition.model, effort: definition.effort },
            );
            return {
                projection: parsed.projection,
                tree: new SingleFileResourceTree(canonicalFile, parsed.document, "PERSONA.md", "Persona"),
            };
        }
        throw refusePersona("source-invalid", 400, `Persona source '${rawSource}' is neither a file nor a directory.`, {
            alias,
            source: rawSource,
        });
    }

    async #signature(
        workspaceId: number,
        definitions: ReadonlyMap<string, PersonaDefinition>,
        exemptAliases: ReadonlySet<string>,
        preScanned?: ScanResult,
    ): Promise<string> {
        const hash = createHash("sha256");
        const scanned = preScanned ?? await this.#scanRoots(workspaceId);
        for (const part of scanned.signatureParts) hash.update(part);
        hash.update(JSON.stringify({ projectRootConfinement: scanned.paths.projectRootConfinement ?? "unrestricted" }));
        const effective = this.#effectiveEnv();
        const env = personasEnvironment(effective);
        hash.update(JSON.stringify(servicePersonas(effective)));
        for (const [alias, definition] of definitions) {
            hash.update(JSON.stringify([alias, definition, env.enabled(alias)]));
            if (!isInlineDefinition(definition)) {
                const enforceContainment = !exemptAliases.has(alias);
                try {
                    const loaded = await this.#loadDefinition(alias, definition, scanned.paths, scanned.discovered, enforceContainment);
                    hash.update(loaded.projection.source);
                } catch (cause) {
                    hash.update(cause instanceof Error ? cause.message : String(cause));
                }
            }
        }
        return hash.digest("hex");
    }

    async refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        const published = this.#snapshots.get(identity.workspaceId);
        if (published === undefined || this.#handle === null) return;
        const current = await this.#signature(identity.workspaceId, published.definitions, published.exemptAliases);
        await this.#handle.refresh(identity, { gate: "none", ifChanged: current === published.signature });
    }

    async available(identity: FunctionalityIdentity): Promise<readonly FunctionalityServiceDefinition<PersonaDefinition>[]> {
        const env = this.#effectiveEnv();
        const configured = servicePersonas(env);
        const settings = personasEnvironment(env);
        const scanned = identity.scope === "service"
            ? await this.#scanRootsForPaths(await this.#pathsFor(identity))
            : await this.#scanRoots(identity.workspaceId);
        const definitions = new Map<string, FunctionalityServiceDefinition<PersonaDefinition>>();
        for (const [name, item] of scanned.discovered) {
            definitions.set(name, {
                alias: name,
                definition: item.definition,
                enabled: settings.enabled(name),
                provenance: item.provenance,
            });
        }
        for (const item of configured) {
            definitions.set(item.alias, item);
        }
        if (identity.scope !== "service") {
            this.#exemptDefinitions.set(
                identity.workspaceId,
                new Map([...definitions].map(([alias, item]) => [alias, item.definition])),
            );
        }
        return [...definitions.values()];
    }

    async discover(
        query: FunctionalityDiscoverQuery,
        identity: FunctionalityIdentity,
    ): Promise<readonly FunctionalityCandidate[]> {
        const paths = await this.#pathsFor(identity);
        const { projectRoot } = paths;
        const confinement = paths.projectRootConfinement ?? "unrestricted";
        if (query.source !== undefined) {
            const rawSource = query.source.trim();
            const resolvedPath = await this.#resolveContainedLocalSource(query.source, paths);
            let info;
            try {
                info = await stat(resolvedPath);
            } catch (cause) {
                if (errnoCode(cause) === "ENOENT") {
                    throw refusePersona("source-not-found", 404, `Persona source '${rawSource}' does not exist.`, {
                        source: rawSource,
                    });
                }
                throw cause;
            }
            const candidates: FunctionalityCandidate[] = [];
            if (info.isFile()) {
                const content = await readFile(resolvedPath, "utf8");
                const inferredName = inferPersonaNameFromPath(resolvedPath, content);
                let parsed;
                try {
                    parsed = parsePersonaDocument(
                        resolvedPath,
                        inferredName,
                        injectPersonaNameIfMissing(inferredName, content),
                    );
                } catch (cause) {
                    throw refusePersona("persona-invalid", 422, cause instanceof Error ? cause.message : String(cause), {
                        source: rawSource,
                    }, cause);
                }
                candidates.push({
                    alias: parsed.projection.name,
                    summary: parsed.projection.description,
                    definition: {
                        source: rawSource,
                        ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                        ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                    },
                    provenance: { kind: "file", source: rawSource, reference: resolvedPath },
                });
            } else if (info.isDirectory()) {
                const directPersona = join(resolvedPath, "PERSONA.md");
                if (
                    confinement === "confined"
                    && projectRoot !== null
                    && !(await isWithinDirectory(projectRoot, directPersona))
                ) {
                    throw refusePersona(
                        "persona-source-forbidden",
                        403,
                        "Local persona source is outside the workspace project root.",
                        { source: rawSource },
                    );
                }
                if (await isFile(directPersona)) {
                    const content = await readFile(directPersona, "utf8");
                    const inferredName = inferPersonaNameFromPath(directPersona, content);
                    let parsed;
                    try {
                        parsed = parsePersonaDocument(
                            directPersona,
                            inferredName,
                            injectPersonaNameIfMissing(inferredName, content),
                        );
                    } catch (cause) {
                        throw refusePersona("persona-invalid", 422, cause instanceof Error ? cause.message : String(cause), {
                            source: rawSource,
                        }, cause);
                    }
                    candidates.push({
                        alias: parsed.projection.name,
                        summary: parsed.projection.description,
                        definition: {
                            source: rawSource,
                            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                        },
                        provenance: { kind: "directory", source: rawSource, reference: directPersona },
                    });
                } else {
                    const entries = (await readdir(resolvedPath, { withFileTypes: true }))
                        .toSorted((a, b) => a.name.localeCompare(b.name));
                    for (const entry of entries) {
                        if (entry.name.startsWith(".")) continue;
                        if (entry.isDirectory() || entry.isSymbolicLink()) {
                            const subDir = join(resolvedPath, entry.name);
                            const subFile = join(subDir, "PERSONA.md");
                            if (!SKILL_NAME.test(entry.name)) continue;
                            if (
                                confinement === "confined"
                                && projectRoot !== null
                                && (!(await isWithinDirectory(projectRoot, subDir)) || !(await isWithinDirectory(projectRoot, subFile)))
                            ) {
                                continue;
                            }
                            if (!(await isFile(subFile))) continue;
                            try {
                                const content = await readFile(subFile, "utf8");
                                const parsed = parsePersonaDocument(subFile, entry.name, content);
                                const subSource = join(rawSource, entry.name);
                                candidates.push({
                                    alias: parsed.projection.name,
                                    summary: parsed.projection.description,
                                    definition: {
                                        source: subSource,
                                        ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                                        ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                                    },
                                    provenance: { kind: "directory", source: subSource, reference: subFile },
                                });
                            } catch { /* skip malformed sibling during directory scan */ }
                        } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
                            const name = entry.name.slice(0, -".md".length);
                            if (!SKILL_NAME.test(name) || candidates.some((c) => c.alias === name)) continue;
                            const subFile = join(resolvedPath, entry.name);
                            if (
                                confinement === "confined"
                                && projectRoot !== null
                                && !(await isWithinDirectory(projectRoot, subFile))
                            ) {
                                continue;
                            }
                            if (!(await isFile(subFile))) continue;
                            try {
                                const content = await readFile(subFile, "utf8");
                                const parsed = parsePersonaDocument(subFile, name, content);
                                const subSource = join(rawSource, entry.name);
                                candidates.push({
                                    alias: parsed.projection.name,
                                    summary: parsed.projection.description,
                                    definition: {
                                        source: subSource,
                                        ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                                        ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                                    },
                                    provenance: { kind: "file", source: subSource, reference: subFile },
                                });
                            } catch { /* skip malformed sibling during directory scan */ }
                        }
                    }
                    if (candidates.length === 0) {
                        throw refusePersona("persona-not-found", 404, `No valid persona found in '${rawSource}'.`, {
                            source: rawSource,
                        });
                    }
                }
            }
            const term = query.query?.trim().toLowerCase();
            return term === undefined || term.length === 0
                ? candidates
                : candidates.filter((c) =>
                    (c.alias?.toLowerCase().includes(term) ?? false)
                    || (c.summary?.toLowerCase().includes(term) ?? false));
        }

        const serviceList = await this.available(identity);
        const scanned = identity.scope === "service"
            ? await this.#scanRootsForPaths(paths)
            : this.#scanned.get(identity.workspaceId);
        const term = query.query?.trim().toLowerCase();
        const candidates: FunctionalityCandidate[] = [];
        for (const item of serviceList) {
            try {
                const loaded = await this.#loadDefinition(
                    item.alias,
                    item.definition,
                    scanned?.paths ?? paths,
                    scanned?.discovered,
                    false,
                );
                if (
                    term !== undefined
                    && term.length > 0
                    && !item.alias.toLowerCase().includes(term)
                    && !loaded.projection.description.toLowerCase().includes(term)
                ) {
                    continue;
                }
                candidates.push({
                    alias: item.alias,
                    summary: loaded.projection.description,
                    definition: item.definition,
                    provenance: item.provenance ?? { kind: "host", source: "personas" },
                });
            } catch { /* skip broken candidate in open discovery */ }
        }
        return candidates;
    }

    async admit(
        input: unknown,
        identity: FunctionalityIdentity,
    ): Promise<FunctionalityDefinitionSource<PersonaDefinition>> {
        const params = isRecord(input) ? input : {};
        const alias = typeof params.alias === "string" ? params.alias.trim() : "";
        if (alias.length === 0 || !SKILL_NAME.test(alias)) {
            throw refusePersona(
                "definition-invalid",
                400,
                `Persona alias '${alias}' is invalid; use lowercase alphanumeric characters and single hyphens (1..64 chars).`,
            );
        }
        const { alias: _alias, ...rest } = params;
        let definition: PersonaDefinition;
        try {
            definition = parsePersonaDefinitionObject(rest);
        } catch (cause) {
            throw refusePersona(
                "definition-invalid",
                400,
                cause instanceof Error ? cause.message : String(cause),
                { alias },
                cause,
            );
        }
        const paths = await this.#pathsFor(identity);
        try {
            await this.#loadDefinition(alias, definition, paths, undefined, true);
        } catch (cause) {
            if (cause instanceof PersonasActionError) throw cause;
            throw refusePersona(
                "persona-invalid",
                422,
                cause instanceof Error ? cause.message : String(cause),
                { alias },
                cause,
            );
        }
        return { alias, definition };
    }

    async prepare(
        preparation: FunctionalityPreparation<PersonaDefinition, PersonaSnapshot>,
    ): Promise<FunctionalityPrepared<never, PersonaSnapshot>> {
        preparation.signal.throwIfAborted();
        const scanned = await this.#scanRoots(preparation.workspaceId);
        preparation.signal.throwIfAborted();
        const definitions = new Map(
            [...preparation.enabled].map(([alias, { definition }]) => [alias, definition]),
        );
        const exemptAliases = new Set(
            [...preparation.enabled]
                .filter(([alias, entry]) => this.#isExemptEntry(preparation.workspaceId, alias, entry))
                .map(([alias]) => alias),
        );
        const signature = await this.#signature(preparation.workspaceId, definitions, exemptAliases, scanned);
        preparation.signal.throwIfAborted();

        const { previous } = preparation;
        const carried = new Set(previous?.unavailable ?? []);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const trees = new Map<string, SkillTree>();
        const projections: ApplicationPersonaProjection[] = [];
        const notices: Notice[] = [...scanned.notices];

        for (const [alias, definition] of [...definitions.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
            preparation.signal.throwIfAborted();
            preparation.progress([alias]);
            try {
                const enforceContainment = !exemptAliases.has(alias);
                const loaded = await this.#loadDefinition(
                    alias,
                    definition,
                    scanned.paths,
                    scanned.discovered,
                    enforceContainment,
                );
                trees.set(alias, loaded.tree);
                projections.push(loaded.projection);
                outcomes.set(alias, {
                    state: "active",
                    detail: {
                        description: loaded.projection.description,
                        ...(loaded.projection.model === undefined ? {} : { model: loaded.projection.model }),
                        ...(loaded.projection.effort === undefined ? {} : { effort: loaded.projection.effort }),
                    },
                });
            } catch (cause) {
                const problem: ProblemDetails = cause instanceof PersonasActionError
                    ? cause.problem
                    : personaProblem(
                        "persona-invalid",
                        422,
                        cause instanceof Error ? cause.message : String(cause),
                        { alias },
                    );
                const fresh = !carried.has(alias)
                    || !isDeepStrictEqual(previous?.definitions.get(alias), definition)
                    || preparation.force === alias;
                if (preparation.failure === "reject" && fresh) {
                    if (cause instanceof PersonasActionError) throw cause;
                    throw new PersonasActionError(problem, cause);
                }
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(problem) });
                notices.push({
                    source: "personas",
                    kind: "configuration_invalid",
                    level: "warn",
                    message: problem.detail,
                });
            }
        }

        const snapshot: PersonaSnapshot = {
            signature,
            trees,
            projections,
            notices,
            definitions,
            exemptAliases,
            unavailable: [...outcomes]
                .filter(([, outcome]) => outcome.state === "unavailable")
                .map(([alias]) => alias),
        };
        const { workspaceId } = preparation;
        return {
            documents: [],
            outcomes,
            snapshot,
            publish: () => {
                const before = this.#snapshots.get(workspaceId);
                this.#coldWorkspaces.delete(workspaceId);
                this.#snapshots.set(workspaceId, snapshot);
                this.#trees.set(workspaceId, snapshot.trees);
                this.#projections.set(workspaceId, snapshot.projections);
                this.#notices.set(workspaceId, snapshot.notices);
                return () => {
                    if (before === undefined) {
                        this.#snapshots.delete(workspaceId);
                        this.#trees.delete(workspaceId);
                        this.#projections.delete(workspaceId);
                        this.#notices.delete(workspaceId);
                    } else {
                        this.#snapshots.set(workspaceId, before);
                        this.#trees.set(workspaceId, before.trees);
                        this.#projections.set(workspaceId, before.projections);
                        this.#notices.set(workspaceId, before.notices);
                    }
                };
            },
            commit: async () => {},
            abort: async () => {},
        };
    }

    async teardown(_snapshot: PersonaSnapshot, identity: WorkspaceCapabilityIdentity): Promise<void> {
        this.clear(identity.workspaceId);
    }

    async read(workspaceId: number): Promise<readonly ApplicationPersonaProjection[]> {
        if (this.#handle !== null && this.#snapshots.has(workspaceId)) {
            try {
                await this.refreshIfChanged({ workspaceId });
            } catch (cause) {
                if (!(cause instanceof ConfigurationError)) throw cause;
                await this.#handle.refresh({ workspaceId }, { gate: "none" });
            }
            if (this.#snapshots.has(workspaceId)) {
                return this.#projections.get(workspaceId) ?? [];
            }
            return [];
        }
        const [rawServiceState, rawWorkspaceState] = await Promise.all([
            this.#seam.readServiceModuleState?.(PERSONAS_OWNER) ?? null,
            this.#seam.readWorkspaceModuleState?.(workspaceId, PERSONAS_OWNER) ?? null,
        ]);
        const servicePersisted = parsePersistedPersonaState(rawServiceState, "service");
        const persisted = parsePersistedPersonaState(rawWorkspaceState, "workspace");

        let hostList: readonly FunctionalityServiceDefinition<PersonaDefinition>[];
        try {
            hostList = await this.available({ workspaceId });
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.#trees.set(workspaceId, new Map());
            this.#projections.set(workspaceId, []);
            const notice: readonly Notice[] = cause.key.startsWith(PERSONAS_PREFIX)
                ? [{
                    source: `functionality:${PERSONAS_FAMILY}`,
                    kind: "configuration_unavailable",
                    level: "error",
                    message: cause.message,
                }]
                : [];
            this.#notices.set(workspaceId, notice);
            this.#trackColdWorkspace(workspaceId);
            return [];
        }
        const scanned = this.#scanned.get(workspaceId)!;

        const serviceEffective = new Map<string, { readonly origin: FunctionalityOrigin; readonly enabled: boolean; readonly definition: PersonaDefinition }>();
        for (const item of hostList) {
            const override = servicePersisted[item.alias];
            const enabled = override?.origin === "host" ? override.enabled : item.enabled;
            serviceEffective.set(item.alias, { origin: "host", enabled, definition: item.definition });
        }
        for (const [alias, record] of Object.entries(servicePersisted)) {
            if (record.origin === "service" && record.definition !== undefined) {
                serviceEffective.set(alias, { origin: "service", enabled: record.enabled, definition: record.definition });
            }
        }

        const effective = new Map<string, { readonly origin: FunctionalityOrigin; readonly enabled: boolean; readonly definition: PersonaDefinition }>();
        for (const [alias, item] of serviceEffective) {
            const override = persisted[alias];
            const enabled = override !== undefined && override.origin !== "workspace" ? override.enabled : item.enabled;
            effective.set(alias, { origin: item.origin, enabled, definition: item.definition });
        }
        for (const [alias, record] of Object.entries(persisted)) {
            if (record.origin === "workspace" && record.definition !== undefined) {
                effective.set(alias, { origin: "workspace", enabled: record.enabled, definition: record.definition });
            }
        }

        const trees = new Map<string, SkillTree>();
        const projections: ApplicationPersonaProjection[] = [];
        const notices: Notice[] = [...scanned.notices];

        for (const [alias, entry] of [...effective.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
            if (!entry.enabled) continue;
            try {
                const enforceContainment = entry.origin !== "host";
                const loaded = await this.#loadDefinition(
                    alias,
                    entry.definition,
                    scanned.paths,
                    scanned.discovered,
                    enforceContainment,
                );
                trees.set(alias, loaded.tree);
                projections.push(loaded.projection);
            } catch (cause) {
                notices.push({
                    source: "personas",
                    kind: "configuration_invalid",
                    level: "warn",
                    message: cause instanceof Error ? cause.message : String(cause),
                });
            }
        }
        this.#trees.set(workspaceId, trees);
        this.#projections.set(workspaceId, projections);
        this.#notices.set(workspaceId, notices);
        this.#trackColdWorkspace(workspaceId);
        return projections;
    }

    static readonly parseEditBody = parsePersonaEditBody;
    static readonly parsePersonaDocument = parsePersonaDocument;
    static readonly refusal: NonNullable<ResourceTreeSource["refusal"]> = personaTreeRefusal;
}
