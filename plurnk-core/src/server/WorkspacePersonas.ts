// {§persona-discovery} — workspace personas as a workspace Functionality family (`personas`,
// `await plurnk.personas(...)`, `PLURNK_PERSONAS_*`) discovered across the 4-tier configuration cascade
// (<project>/.agents/personas, $XDG_CONFIG_HOME/plurnk/personas, $XDG_CONFIG_HOME/agents/personas,
// ~/.agents/personas), enabled workspace plugins, environment definitions, and workspace overrides,
// exposed through `persona://<name>/PERSONA.md` (`READ`, `FIND`, `EDIT`, `KILL`) and `listPersonas`.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    EFFORTS,
    errnoCode,
    isRecord,
    PathSyntax,
    Problems,
    SKILL_NAME,
    Validator,
    type ApplicationPersonaProjection,
    type Effort,
    type FindStatement,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type FunctionalityServiceDefinition,
    type JsonSchema,
    type KillStatement,
    type Notice,
    type ParsedPath,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import { parseSkill, skillName, SkillResourceError, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { AgentPluginFiles } from "@plurnk/plurnk-agent-plugins";
import { ConfigurationError, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import {
    FileByteSource,
    GeneratedByteSource,
    Results as SchemeResults,
    type ByteSource,
    type EditBatchResult,
    type EntryAddress,
    type EntryCoordinate,
    type ResolvedEditStatement,
    type ResourceTreeSource,
    type SchemeAddressCtx,
    type SchemeCtx,
    type SchemeManifest,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import { entryCoordinateOf } from "../core/plurnk-uri.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import Paths from "../Paths.ts";
import type { FindResult } from "../schemes/_entry-find.ts";
import ResourceTreeScheme from "../schemes/ResourceTreeScheme.ts";
import { workspacePaths } from "./AgentRoots.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import FunctionalityState from "./FunctionalityState.ts";
import type WorkspacePlugins from "./WorkspacePlugins.ts";

const { isFile } = AgentPluginFiles;

const PERSONAS_FAMILY = "personas";
const PERSONAS_OWNER = "@plurnk/plurnk-service:personas";
const PREFIX = "PLURNK_PERSONAS_";

interface PersonaSourceDefinition {
    readonly source: string;
    readonly model?: string;
    readonly effort?: Effort;
}

interface PersonaInlineDefinition {
    readonly description: string;
    readonly body: string;
    readonly model?: string;
    readonly effort?: Effort;
}

export type PersonaDefinition = PersonaSourceDefinition | PersonaInlineDefinition;

const isEffort = (value: unknown): value is Effort =>
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value);

const isInlineDefinition = (value: PersonaDefinition): value is PersonaInlineDefinition =>
    "description" in value && "body" in value;

const PERSONA_INLINE_SCHEMA: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["description", "body"],
    properties: {
        description: { type: "string", minLength: 1, maxLength: 1024 },
        body: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: [...EFFORTS] },
    },
});

const PERSONA_SOURCE_SCHEMA: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: {
        source: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: [...EFFORTS] },
    },
});

const PERSONA_DEFINITION_SCHEMA: JsonSchema = Object.freeze({
    anyOf: [PERSONA_INLINE_SCHEMA, PERSONA_SOURCE_SCHEMA],
});

const refuse = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("personas:functionality", code, status, detail, {}, {
        family: PERSONAS_FAMILY,
        retryable: false,
        ...extensions,
    }),
);

const assertContained = (root: string, candidate: string, authored: string): void => {
    const path = relative(root, candidate);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new SkillResourceError(
            "SKILL_PATH_OUTSIDE_ROOT",
            `Persona resource '${authored}' resolves outside its persona directory.`,
        );
    }
};

const formatPersonaMarkdown = (name: string, def: PersonaInlineDefinition): string => [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(def.description)}`,
    ...(def.model === undefined ? [] : [`model: ${JSON.stringify(def.model)}`]),
    ...(def.effort === undefined ? [] : [`effort: ${def.effort}`]),
    "---",
    "",
    def.body.trim(),
    "",
].join("\n");

const parsePersonaDefinitionObject = (raw: unknown): PersonaDefinition => {
    if (!isRecord(raw)) {
        throw new Error("Persona definition must be a JSON object with either { description, body } or { source }.");
    }
    const allowedKeys = new Set(["source", "description", "body", "model", "effort"]);
    for (const key of Object.keys(raw)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`Persona definition contains unsupported field '${key}'.`);
        }
    }
    let model: string | undefined;
    if (raw.model !== undefined) {
        if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
            throw new Error("Persona definition 'model' must be a non-empty string.");
        }
        model = raw.model.trim();
    }
    let effort: Effort | undefined;
    if (raw.effort !== undefined) {
        if (!isEffort(raw.effort)) {
            throw new Error(`Persona definition 'effort' must be one of ${EFFORTS.join(", ")}.`);
        }
        effort = raw.effort;
    }
    const hasSource = raw.source !== undefined;
    const hasInline = raw.description !== undefined || raw.body !== undefined;
    if (hasSource && hasInline) {
        throw new Error("Persona definition must specify either { source } or { description, body }, not both.");
    }
    if (hasSource) {
        if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
            throw new Error("Persona definition 'source' must be a non-empty path.");
        }
        return {
            source: raw.source.trim(),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
        };
    }
    if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
        throw new Error("Inline persona definition requires a non-empty 'description'.");
    }
    const description = raw.description.trim();
    if (Array.from(description).length > 1024) {
        throw new Error("Persona description exceeds 1024 characters.");
    }
    if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
        throw new Error("Inline persona definition requires a non-empty 'body'.");
    }
    return {
        description,
        body: raw.body.trim(),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
    };
};

const environment = (environ: NodeJS.ProcessEnv = process.env): ResourceEnvironment =>
    new ResourceEnvironment(PREFIX, { controls: [], settings: [], aliasPattern: SKILL_NAME }, environ);

export const servicePersonas = (environ: NodeJS.ProcessEnv = process.env): FunctionalityServiceDefinition<PersonaDefinition>[] => {
    const env = environment(environ);
    const out: FunctionalityServiceDefinition<PersonaDefinition>[] = [];
    for (const [alias, { key, value }] of env.definitions) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch (cause) {
            throw new ConfigurationError(key, `${key} must be valid JSON ({ "source": "..." } or { "description": "...", "body": "..." }).`, { cause });
        }
        let definition: PersonaDefinition;
        try {
            definition = parsePersonaDefinitionObject(parsed);
        } catch (cause) {
            throw new ConfigurationError(key, `${key}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        out.push({
            alias,
            definition,
            enabled: env.enabled(alias),
            provenance: { kind: "environment", source: key },
        });
    }
    return out;
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

class PersonaInlineTree implements SkillTree {
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
    readonly summary = "List ({}) or manage personas";
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
        if (this.#env[`${PREFIX}ENABLED`] !== undefined) return this.#env;
        return { [`${PREFIX}ENABLED`]: "1", ...this.#env };
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
                    assertContained(canonicalDir, canonicalFile, "PERSONA.md");
                    if (containRoot !== undefined) {
                        assertContained(containRoot, canonicalDir, `personas/${name}`);
                        assertContained(containRoot, canonicalFile, `personas/${name}/PERSONA.md`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`dir:${name}:${canonicalDir}:${source}`);
                    const parsed = WorkspacePersonas.parsePersonaDocument(candidateFile, name, source);
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
                        assertContained(containRoot, canonicalFile, `personas/${entry.name}`);
                    }
                    const source = await readFile(canonicalFile, "utf8");
                    signatureParts.push(`file:${name}:${canonicalFile}:${source}`);
                    const parsed = WorkspacePersonas.parsePersonaDocument(candidateFile, name, source);
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
            const parsed = WorkspacePersonas.parsePersonaDocument(`persona://${alias}/PERSONA.md`, alias, markdown);
            return {
                projection: parsed.projection,
                tree: new PersonaInlineTree(parsed.document),
            };
        }
        const rawSource = definition.source.trim();
        if (!isAbsolute(rawSource) && projectRoot === null) {
            throw refuse(
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
                throw refuse("source-not-found", 404, `Persona source '${rawSource}' does not exist.`, {
                    alias,
                    source: rawSource,
                });
            }
            throw cause;
        }
        if (info.isDirectory()) {
            const candidateFile = join(resolvedPath, "PERSONA.md");
            if (!(await isFile(candidateFile))) {
                throw refuse("persona-not-found", 404, `Persona directory '${rawSource}' does not contain PERSONA.md.`, {
                    alias,
                    source: rawSource,
                });
            }
            const canonicalDir = await realpath(resolvedPath);
            const canonicalFile = await realpath(candidateFile);
            assertContained(canonicalDir, canonicalFile, "PERSONA.md");
            const content = await readFile(canonicalFile, "utf8");
            const parsed = WorkspacePersonas.parsePersonaDocument(
                candidateFile,
                alias,
                WorkspacePersonas.#injectNameIfMissing(alias, content),
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
            const parsed = WorkspacePersonas.parsePersonaDocument(
                resolvedPath,
                alias,
                WorkspacePersonas.#injectNameIfMissing(alias, content),
                { model: definition.model, effort: definition.effort },
            );
            return {
                projection: parsed.projection,
                tree: new PersonaFileTree(canonicalFile, parsed.document),
            };
        }
        throw refuse("source-invalid", 400, `Persona source '${rawSource}' is neither a file nor a directory.`, {
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
        const env = environment(this.#effectiveEnv());
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
        const settings = environment(env);
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
                throw refuse("source-invalid", 400, "Persona discovery 'source' must be a non-empty path.");
            }
            if (!isAbsolute(rawSource) && projectRoot === null) {
                throw refuse(
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
                    throw refuse("source-not-found", 404, `Persona source '${rawSource}' does not exist.`, {
                        source: rawSource,
                    });
                }
                throw cause;
            }
            const candidates: FunctionalityCandidate[] = [];
            if (info.isFile()) {
                const content = await readFile(resolvedPath, "utf8");
                const inferredName = WorkspacePersonas.#inferNameFromPath(resolvedPath, content);
                let parsed;
                try {
                    parsed = WorkspacePersonas.parsePersonaDocument(
                        resolvedPath,
                        inferredName,
                        WorkspacePersonas.#injectNameIfMissing(inferredName, content),
                    );
                } catch (cause) {
                    throw refuse("persona-invalid", 422, cause instanceof Error ? cause.message : String(cause), {
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
                    const inferredName = WorkspacePersonas.#inferNameFromPath(directPersona, content);
                    let parsed;
                    try {
                        parsed = WorkspacePersonas.parsePersonaDocument(
                            directPersona,
                            inferredName,
                            WorkspacePersonas.#injectNameIfMissing(inferredName, content),
                        );
                    } catch (cause) {
                        throw refuse("persona-invalid", 422, cause instanceof Error ? cause.message : String(cause), {
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
                                const parsed = WorkspacePersonas.parsePersonaDocument(subFile, entry.name, content);
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
                                const parsed = WorkspacePersonas.parsePersonaDocument(subFile, name, content);
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
                        throw refuse("persona-not-found", 404, `No valid persona found in '${rawSource}'.`, {
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
            throw refuse(
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
            throw refuse(
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
            throw refuse(
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
            const notice = cause.key.startsWith(PREFIX)
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

    static #inferNameFromPath(filePath: string, content: string): string {
        try {
            return skillName(filePath, content);
        } catch {
            const base = basename(filePath);
            if (base === "PERSONA.md") return basename(dirname(filePath));
            if (base.endsWith(".md")) return base.slice(0, -".md".length);
            return base;
        }
    }

    static #injectNameIfMissing(alias: string, source: string): string {
        const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/mu.exec(source);
        if (match === null) return source;
        if (/^\s*name\s*:/mu.test(match[2])) return source;
        return `${match[1]}name: ${alias}\n${match[2]}${match[3]}${source.slice(match[0].length)}`;
    }

    static parseEditBody(alias: string, rawBody: string): PersonaDefinition {
        const trimmed = rawBody.trim();
        if (trimmed.length === 0) {
            throw new Error(`Persona '${alias}' requires either a Markdown document with YAML frontmatter or a JSON definition object.`);
        }
        if (trimmed.startsWith("{")) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch (cause) {
                throw new Error(`Persona '${alias}' JSON definition is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
            }
            return parsePersonaDefinitionObject(parsed);
        }
        const withName = WorkspacePersonas.#injectNameIfMissing(alias, rawBody);
        const parsed = WorkspacePersonas.parsePersonaDocument(
            `persona://${alias}/PERSONA.md`,
            alias,
            withName,
        );
        return {
            description: parsed.projection.description,
            body: parsed.projection.body,
            ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
            ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
        };
    }

    static parsePersonaDocument(
        file: string,
        expectedName: string,
        source: string,
        overrides: { readonly model?: string; readonly effort?: Effort } = {},
    ): { readonly projection: ApplicationPersonaProjection; readonly document: ReturnType<typeof parseSkill> } {
        const document = parseSkill(file, expectedName, source);
        const body = document.body.trim();
        if (body.length === 0) {
            throw new Error(`${file}: Persona '${expectedName}' requires non-empty instruction body.`);
        }
        const rawModel = overrides.model ?? document.metadata.model;
        let model: string | undefined;
        if (rawModel !== undefined) {
            if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
                throw new Error(`${file}: Persona '${expectedName}' frontmatter 'model' must be a non-empty string.`);
            }
            model = rawModel.trim();
        }
        const rawEffort = overrides.effort ?? document.metadata.effort;
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
}

export type PersonaSchemeInvoke = (
    verb: "list" | "replace" | "remove" | "disable",
    params: unknown,
    identity: { readonly workspaceId: number; readonly sessionId: number },
    caller?: "operation" | "action",
) => Promise<{ readonly status: number; readonly body?: unknown }>;

export class PersonaScheme extends ResourceTreeScheme {
    override readonly manifest: SchemeManifest = {
        name: "persona",
        authority: "resource",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        folderScopes: true,
        textEditScopes: true,
        modelVisible: true,
    };

    readonly #personas: WorkspacePersonas;
    readonly #invoke: PersonaSchemeInvoke;

    constructor(personas: WorkspacePersonas, invoke: PersonaSchemeInvoke) {
        super("persona", {
            trees: (workspaceId) => personas.trees(workspaceId),
            refusal: WorkspacePersonas.refusal,
        });
        this.#personas = personas;
        this.#invoke = invoke;
    }

    static normalizeAddress(target: ParsedPath, options: { readonly forFind?: boolean } = {}): EntryCoordinate {
        const raw = entryCoordinateOf(target, "resource");
        let { authority, pathname } = raw;
        if (authority.endsWith(".md") && (pathname === "" || pathname === "/")) {
            authority = authority.slice(0, -".md".length);
            pathname = "/PERSONA.md";
        } else if (!options.forFind && authority.length > 0 && !PathSyntax.hasGlob(authority) && (pathname === "" || pathname === "/")) {
            pathname = "/PERSONA.md";
        } else if (authority === "") {
            const mdMatch = /^\/([^/]+)\.md$/u.exec(pathname);
            if (mdMatch !== null) {
                authority = mdMatch[1];
                pathname = "/PERSONA.md";
            } else {
                const subMatch = /^\/([^/]+)(\/.+)$/u.exec(pathname);
                if (subMatch !== null) {
                    authority = subMatch[1];
                    pathname = subMatch[2];
                } else {
                    const bareMatch = /^\/([^/]+)$/u.exec(pathname);
                    if (bareMatch !== null) {
                        authority = bareMatch[1];
                        pathname = options.forFind ? "" : PathSyntax.hasGlob(bareMatch[1]) ? "/" : "/PERSONA.md";
                    } else if (options.forFind && (pathname === "" || pathname === "/")) {
                        authority = "*";
                        pathname = "/";
                    }
                }
            }
        }
        return { authority, pathname };
    }

    override async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        if (statement.target?.kind === "url") {
            const normalized = PersonaScheme.normalizeAddress(statement.target, { forFind: true });
            return await super.find(
                {
                    ...statement,
                    target: {
                        ...statement.target,
                        hostname: normalized.authority,
                        port: null,
                        pathname: PathSyntax.encodeParens(normalized.pathname),
                        query: null,
                    },
                },
                ctx,
            );
        }
        return await super.find(statement, ctx);
    }

    override async resolveEntryAddress(
        target: ParsedPath,
        ctx: SchemeAddressCtx,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | null> {
        const address = PersonaScheme.normalizeAddress(target);
        if (access === "write") return address;
        const trees = this.#personas.trees(ctx.workspaceId);
        return PathSyntax.hasGlob(address.authority) || trees.has(address.authority) ? address : null;
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (
            statement === undefined
            || statement.target === null
            || statements.length > 1
            || statement.lineMarker !== null
            || statement.matcher !== null
        ) {
            return SchemeResults.failure(
                "scheme:persona",
                "value-whole",
                400,
                "One edit sets one persona definition, whole.",
                {},
                {
                    recovery: "await plurnk.edit({ path: \"persona://<name>/PERSONA.md\", content: \"...\" }) with the complete persona Markdown or JSON definition.",
                    retryable: false,
                },
            );
        }
        const target = statement.target;
        const address = PersonaScheme.normalizeAddress(target);
        if (!SKILL_NAME.test(address.authority) || address.pathname !== "/PERSONA.md") {
            return SchemeResults.failure(
                "scheme:persona",
                "target-invalid",
                400,
                "Persona writes must target persona://<name>/PERSONA.md (or persona://<name>.md) with a valid lowercase-hyphenated persona name.",
                {},
                { target: target.raw, retryable: false },
            );
        }
        let definition: PersonaDefinition;
        try {
            definition = WorkspacePersonas.parseEditBody(address.authority, statement.body ?? "");
        } catch (cause) {
            return SchemeResults.failure(
                "scheme:persona",
                "persona-invalid",
                400,
                cause instanceof Error ? cause.message : String(cause),
                {},
                { target: target.raw, retryable: false },
            );
        }
        try {
            await this.#invoke(
                "replace",
                { alias: address.authority, ...definition },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(address.pathname);
        return { status: 200 };
    }

    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        if (statement.lineMarker !== null || statement.matcher !== null) {
            return SchemeResults.failure(
                "scheme:persona",
                "value-whole",
                400,
                "kill retires the whole persona definition.",
                {},
                { retryable: false },
            );
        }
        const targetRaw = statement.target?.raw ?? "persona://";
        const address = statement.target === null
            ? { authority: "", pathname: "/" }
            : PersonaScheme.normalizeAddress(statement.target);
        if (!SKILL_NAME.test(address.authority) || address.pathname !== "/PERSONA.md") {
            return SchemeResults.failure(
                "scheme:persona",
                "target-invalid",
                400,
                "Persona kill must target persona://<name>/PERSONA.md (or persona://<name>.md).",
                {},
                { target: targetRaw, retryable: false },
            );
        }
        const listed = await this.#invoke(
            "list",
            {},
            { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
            "action",
        );
        const entry = Validator.assertFunctionalityListResult(listed.body).definitions.find(
            (d) => d.alias === address.authority,
        );
        if (entry === undefined || (entry.origin === "service" && entry.state === "disabled")) {
            return SchemeResults.failure(
                "scheme:persona",
                "entry-not-found",
                404,
                `No persona resource exists at persona://${address.authority}/PERSONA.md.`,
                {},
                { target: targetRaw },
            );
        }
        try {
            await this.#invoke(
                entry.origin === "workspace" ? "remove" : "disable",
                { alias: address.authority },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(address.pathname);
        return { status: 200 };
    }
}
