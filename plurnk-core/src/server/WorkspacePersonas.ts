// {§persona-discovery} — workspace personas as a workspace Functionality family (`personas`,
// `plurnk.personas(...)`, `PLURNK_PERSONAS_*`) discovered across the 4-tier configuration cascade
// (<project>/.agents/personas, $XDG_CONFIG_HOME/plurnk/personas, $XDG_CONFIG_HOME/agents/personas,
// ~/.agents/personas), enabled workspace plugins, environment definitions, and workspace overrides,
// exposed through `persona://<name>/PERSONA.md` (`READ`, `FIND`, `EDIT`, `KILL`) and `listPersonas`.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    errnoCode,
    isRecord,
    SKILL_NAME,
    type ApplicationPersonaProjection,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type FunctionalityServiceDefinition,
    type JsonSchema,
    type Notice,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { SkillTree } from "@plurnk/plurnk-agent-skills";
import { AgentPluginFiles } from "@plurnk/plurnk-agent-plugins";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import type { ResourceTreeSource } from "@plurnk/plurnk-schemes";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import Paths from "../Paths.ts";
import { workspacePaths } from "./AgentRoots.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import FunctionalityState from "./FunctionalityState.ts";
import {
    formatPersonaMarkdown,
    inferPersonaNameFromPath,
    injectPersonaNameIfMissing,
    isInlineDefinition,
    parsePersonaDefinitionObject,
    parsePersonaDocument,
    parsePersonaEditBody,
    PERSONA_DEFINITION_SCHEMA,
    PERSONAS_FAMILY,
    PERSONAS_OWNER,
    PERSONAS_PREFIX,
    personasEnvironment,
    refusePersona,
    servicePersonas,
    type PersonaDefinition,
    type PersonaSourceDefinition,
} from "./PersonaDefinition.ts";
import {
    assertPersonaContained,
    PersonaDirectoryTree,
    PersonaFileTree,
    PersonaInlineTree,
    personaTreeRefusal,
} from "./PersonaTrees.ts";
import type WorkspacePlugins from "./WorkspacePlugins.ts";

const { isFile } = AgentPluginFiles;

interface DiscoveredPersona {
    readonly projection: ApplicationPersonaProjection;
    readonly tree: SkillTree;
    readonly definition: PersonaSourceDefinition;
    readonly provenance: {
        readonly kind: "directory" | "file" | "plugin";
        readonly source: string;
        readonly reference: string;
    };
}

interface ScanResult {
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
    readonly unavailable: readonly string[];
}

export default class WorkspacePersonas implements FunctionalityAdapter<never, never, PersonaDefinition, PersonaSnapshot> {
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
    readonly docsDir = Paths.packageRoot;
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query", "source"],
        emptyListsAll: true,
        details: "`{\"discover\": true}` or `{\"discover\": \"<query>\"}` lists personas discovered from active configuration roots and plugins; `{\"discover\": {\"source\": \"...\"}}` inspects a persona file or directory. Returns candidates with addable definitions.",
    };

    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #plugins: WorkspacePlugins;
    readonly #env: NodeJS.ProcessEnv;
    readonly #snapshots = new Map<number, PersonaSnapshot>();
    readonly #trees = new Map<number, ReadonlyMap<string, SkillTree>>();
    readonly #projections = new Map<number, readonly ApplicationPersonaProjection[]>();
    readonly #notices = new Map<number, readonly Notice[]>();
    readonly #scanned = new Map<number, ScanResult>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor({
        db,
        hostPaths,
        plugins,
        environ = process.env,
    }: {
        readonly db: Db;
        readonly hostPaths: HostPaths;
        readonly plugins: WorkspacePlugins;
        readonly environ?: NodeJS.ProcessEnv;
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        this.#plugins = plugins;
        this.#env = environ;
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
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
    }

    async refresh(workspaceId: number): Promise<readonly ApplicationPersonaProjection[]> {
        return await this.read(workspaceId);
    }

    #effectiveEnv(): NodeJS.ProcessEnv {
        if (this.#env[`${PERSONAS_PREFIX}ENABLED`] !== undefined) return this.#env;
        return { [`${PERSONAS_PREFIX}ENABLED`]: "1", ...this.#env };
    }

    async #scanRootsAndPlugins(workspaceId: number): Promise<ScanResult> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        const paths = workspacePaths(this.#hostPaths, projectRoot, this.#env);
        const pluginSet = await this.#plugins.read(workspaceId);
        const { plugins } = pluginSet;
        const scopes = new Set([
            ...paths.configurationRoots.map(({ scope }) => scope),
            ...plugins.map(({ scope }) => scope),
        ]);

        const discovered = new Map<string, DiscoveredPersona>();
        const notices: Notice[] = [];
        const signatureParts: string[] = [pluginSet.signature];

        const scanDir = async (personasDir: string, containRoot?: string): Promise<void> => {
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
                    assertPersonaContained(canonicalDir, canonicalFile, "PERSONA.md");
                    if (containRoot !== undefined) {
                        assertPersonaContained(containRoot, canonicalDir, `personas/${name}`);
                        assertPersonaContained(containRoot, canonicalFile, `personas/${name}/PERSONA.md`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`dir:${name}:${canonicalDir}:${source}`);
                    const parsed = parsePersonaDocument(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new PersonaDirectoryTree(canonicalDir, parsed.document),
                        definition: {
                            source: canonicalDir,
                            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                        },
                        provenance: {
                            kind: containRoot !== undefined ? "plugin" : "directory",
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
                    if (containRoot !== undefined) {
                        assertPersonaContained(containRoot, canonicalFile, `personas/${entry.name}`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`file:${name}:${canonicalFile}:${source}`);
                    const parsed = parsePersonaDocument(candidateFile, name, source);
                    discovered.set(name, {
                        projection: parsed.projection,
                        tree: new PersonaFileTree(canonicalFile, parsed.document),
                        definition: {
                            source: canonicalFile,
                            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
                            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
                        },
                        provenance: {
                            kind: containRoot !== undefined ? "plugin" : "file",
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

        for (const scope of scopes) {
            const root = paths.configurationRoots.find((candidate) => candidate.scope === scope);
            if (root !== undefined) {
                await scanDir(join(root.directory, "personas"));
            }
            for (const plugin of plugins.filter((candidate) => candidate.scope === scope)) {
                await scanDir(join(plugin.root, "personas"), plugin.root);
            }
        }

        const result: ScanResult = { projectRoot, discovered, notices, signatureParts };
        this.#scanned.set(workspaceId, result);
        return result;
    }

    async #loadDefinition(
        alias: string,
        definition: PersonaDefinition,
        projectRoot: string | null,
        scanned?: ReadonlyMap<string, DiscoveredPersona>,
    ): Promise<{ readonly projection: ApplicationPersonaProjection; readonly tree: SkillTree }> {
        if (isInlineDefinition(definition)) {
            const markdown = formatPersonaMarkdown(alias, definition);
            const parsed = parsePersonaDocument(`persona://${alias}/PERSONA.md`, alias, markdown);
            return {
                projection: parsed.projection,
                tree: new PersonaInlineTree(parsed.document),
            };
        }
        const rawSource = definition.source.trim();
        if (!isAbsolute(rawSource) && projectRoot === null) {
            throw refusePersona(
                "source-relative-without-project",
                400,
                `Relative persona source '${rawSource}' requires a workspace project root.`,
                { alias, source: rawSource },
            );
        }
        const resolvedPath = isAbsolute(rawSource) ? resolve(rawSource) : resolve(projectRoot!, rawSource);
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
            if (!(await isFile(candidateFile))) {
                throw refusePersona("persona-not-found", 404, `Persona directory '${rawSource}' does not contain PERSONA.md.`, {
                    alias,
                    source: rawSource,
                });
            }
            const canonicalDir = await realpath(resolvedPath);
            const canonicalFile = await realpath(candidateFile);
            assertPersonaContained(canonicalDir, canonicalFile, "PERSONA.md");
            const content = await readFile(canonicalFile, "utf8");
            const parsed = parsePersonaDocument(
                candidateFile,
                alias,
                injectPersonaNameIfMissing(alias, content),
                { model: definition.model, effort: definition.effort },
            );
            return {
                projection: parsed.projection,
                tree: new PersonaDirectoryTree(canonicalDir, parsed.document),
            };
        }
        if (info.isFile()) {
            const canonicalFile = await realpath(resolvedPath);
            const content = await readFile(canonicalFile, "utf8");
            const parsed = parsePersonaDocument(
                resolvedPath,
                alias,
                injectPersonaNameIfMissing(alias, content),
                { model: definition.model, effort: definition.effort },
            );
            return {
                projection: parsed.projection,
                tree: new PersonaFileTree(canonicalFile, parsed.document),
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
        preScanned?: ScanResult,
    ): Promise<string> {
        const hash = createHash("sha256");
        const scanned = preScanned ?? await this.#scanRootsAndPlugins(workspaceId);
        for (const part of scanned.signatureParts) hash.update(part);
        const env = personasEnvironment(this.#effectiveEnv());
        hash.update(JSON.stringify(servicePersonas(this.#effectiveEnv())));
        for (const [alias, definition] of definitions) {
            hash.update(JSON.stringify([alias, definition, env.enabled(alias)]));
            if (!isInlineDefinition(definition)) {
                try {
                    const loaded = await this.#loadDefinition(alias, definition, scanned.projectRoot, scanned.discovered);
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
        const current = await this.#signature(identity.workspaceId, published.definitions);
        await this.#handle.refresh(identity, { gate: "none", ifChanged: current === published.signature });
    }

    async available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition<PersonaDefinition>[]> {
        const env = this.#effectiveEnv();
        const configured = servicePersonas(env);
        const settings = personasEnvironment(env);
        const scanned = await this.#scanRootsAndPlugins(identity.workspaceId);
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
        return [...definitions.values()];
    }

    async discover(
        query: FunctionalityDiscoverQuery,
        identity: WorkspaceCapabilityIdentity,
    ): Promise<readonly FunctionalityCandidate[]> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: identity.workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        if (query.source !== undefined) {
            const rawSource = query.source.trim();
            if (rawSource.length === 0) {
                throw refusePersona("source-invalid", 400, "Persona discovery 'source' must be a non-empty path.");
            }
            if (!isAbsolute(rawSource) && projectRoot === null) {
                throw refusePersona(
                    "source-relative-without-project",
                    400,
                    `Relative persona source '${rawSource}' requires a workspace project root.`,
                    { source: rawSource },
                );
            }
            const resolvedPath = isAbsolute(rawSource) ? resolve(rawSource) : resolve(projectRoot!, rawSource);
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
                    });
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
                        });
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
                            const subFile = join(resolvedPath, entry.name, "PERSONA.md");
                            if (!SKILL_NAME.test(entry.name) || !(await isFile(subFile))) continue;
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
        const scanned = this.#scanned.get(identity.workspaceId);
        const term = query.query?.trim().toLowerCase();
        const candidates: FunctionalityCandidate[] = [];
        for (const item of serviceList) {
            try {
                const loaded = await this.#loadDefinition(
                    item.alias,
                    item.definition,
                    projectRoot,
                    scanned?.discovered,
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
                    provenance: item.provenance ?? { kind: "service", source: "personas" },
                });
            } catch { /* skip broken candidate in open discovery */ }
        }
        return candidates;
    }

    async admit(
        input: unknown,
        identity: WorkspaceCapabilityIdentity,
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
            );
        }
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: identity.workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        try {
            await this.#loadDefinition(alias, definition, projectRoot);
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            throw refusePersona(
                "persona-invalid",
                422,
                cause instanceof Error ? cause.message : String(cause),
                { alias },
            );
        }
        return { alias, definition };
    }

    async prepare(
        preparation: FunctionalityPreparation<PersonaDefinition, PersonaSnapshot>,
    ): Promise<FunctionalityPrepared<never, PersonaSnapshot>> {
        preparation.signal.throwIfAborted();
        const scanned = await this.#scanRootsAndPlugins(preparation.workspaceId);
        preparation.signal.throwIfAborted();
        const definitions = new Map(
            [...preparation.enabled].map(([alias, { definition }]) => [alias, definition]),
        );
        const signature = await this.#signature(preparation.workspaceId, definitions, scanned);
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
                const loaded = await this.#loadDefinition(
                    alias,
                    definition,
                    scanned.projectRoot,
                    scanned.discovered,
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
                const problem: ProblemDetails = cause instanceof OperationFailureError && cause.result.problem !== undefined
                    ? cause.result.problem
                    : Results.failure(
                        "personas:functionality",
                        "persona-invalid",
                        422,
                        cause instanceof Error ? cause.message : String(cause),
                        {},
                        { family: PERSONAS_FAMILY, alias, retryable: false },
                    ).problem!;
                const fresh = !carried.has(alias)
                    || !isDeepStrictEqual(previous?.definitions.get(alias), definition)
                    || preparation.force === alias;
                if (preparation.failure === "reject" && fresh) {
                    if (cause instanceof OperationFailureError) throw cause;
                    throw new OperationFailureError({ status: problem.status, problem });
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
        const row = await this.#db.workspace_module_state_get?.get<{ state: string }>({
            workspace_id: workspaceId,
            namespace_owner: PERSONAS_OWNER,
        });
        const rawState: unknown = row === undefined ? null : JSON.parse(row.state);
        const state = FunctionalityState.parseState(
            this,
            rawState,
            `workspace ${workspaceId}`,
            "workspace",
        );
        let effective;
        try {
            effective = await FunctionalityState.effective(
                this,
                { workspaceId, scope: "workspace" },
                state,
                async () => state,
            );
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.#trees.set(workspaceId, new Map());
            this.#projections.set(workspaceId, []);
            const notice = cause.key.startsWith(PERSONAS_PREFIX)
                ? [ConfigurationDiagnostics.notice(PERSONAS_FAMILY, cause)]
                : [];
            this.#notices.set(workspaceId, notice);
            return [];
        }
        const scanned = this.#scanned.get(workspaceId)!;

        const trees = new Map<string, SkillTree>();
        const projections: ApplicationPersonaProjection[] = [];
        const notices: Notice[] = [...scanned.notices];

        for (const [alias, entry] of [...effective.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
            if (!entry.enabled) continue;
            try {
                const loaded = await this.#loadDefinition(
                    alias,
                    parsePersonaDefinitionObject(entry.definition),
                    scanned.projectRoot,
                    scanned.discovered,
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
        return projections;
    }

    static readonly parseEditBody = parsePersonaEditBody;
    static readonly parsePersonaDocument = parsePersonaDocument;
    static readonly refusal: NonNullable<ResourceTreeSource["refusal"]> = personaTreeRefusal;
}
