// {§skills-functionality} — standard Agent Skills as one workspace Functionality
// family. Configuration roots are inputs; live references and fetched sources
// belong to workspace definitions, never to an installation scope.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillDirectory, type ProvidedSkillsSeam, type SkillTree } from "@plurnk/plurnk-agent-skills";
import {
    SKILL_NAME,
    Validator,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type JsonSchema,
    type SkillDefinition,
} from "@plurnk/plurnk-contracts";
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import { ConfigurationError, Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type {
    FunctionalityDefinitionSource,
    FunctionalityFamilyHandle,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { FunctionalityAdapter, FunctionalityDiscovery, ModuleSetupSeam, WorkspacePaths } from "@plurnk/plurnk-modules";
import SkillSource from "./SkillSource.ts";
import { SkillsActionError, actionError, messageOf } from "./problems.ts";

const SKILLS_FAMILY = "skills";
const SKILLS_OWNER = "@plurnk/plurnk-skills";
const DEFINITION = { $ref: "https://schemas.plurnk.xyz/v0/SkillDefinition.json" } as const satisfies JsonSchema;
export type SourceSeam = Pick<ModuleSetupSeam, "workspacePaths" | "workspaceStateDirectory" | "operatorEnvironment">
    & WorkspacePluginsSeam & ProvidedSkillsSeam;

interface Installed {
    readonly name: string;
    readonly kind?: "plugin";
    readonly dir: string;
    readonly file: string;
}

interface Snapshot {
    readonly signature: string;
    readonly trees: ReadonlyMap<string, SkillTree>;
    readonly definitions: ReadonlyMap<string, object>;
    // Aliases whose last preparation was unavailable; an unchanged one stays
    // unavailable under a client's reject policy unless it is the retried alias.
    readonly unavailable: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const missing = (cause: unknown): false => {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw cause;
};
const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), missing);

const environment = (env: NodeJS.ProcessEnv = process.env): ResourceEnvironment => new ResourceEnvironment(
    "PLURNK_SKILLS_", { controls: ["FETCH_TIMEOUT_MS"], settings: [], aliasPattern: SKILL_NAME }, env,
);

export const serviceSkills = (env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, SkillDefinition> => {
    const definitions = new Map<string, SkillDefinition>();
    for (const [alias, { key, value }] of environment(env).definitions) {
        let definition: SkillDefinition;
        try {
            definition = Validator.assertSkillDefinition(JSON.parse(value));
        } catch (cause) {
            throw new ConfigurationError(key, `${key} must contain a complete SkillDefinition.`, { cause });
        }
        if (definition.name !== alias) throw new ConfigurationError(key, `${key}: the definition name must equal '${alias}'.`);
        if (definition.source === undefined) throw new ConfigurationError(key, `${key}: a configured skill requires a source.`);
        if (definition.commit !== undefined) throw new ConfigurationError(key, `${key}: commit is service-recorded; configure a Git ref instead.`);
        try {
            const remote = SkillSource.remote(definition.source);
            if (definition.ref !== undefined && remote === null) throw new Error("A ref names a branch or tag of a git source.");
        } catch (cause) {
            throw new ConfigurationError(key, `${key}: invalid skill source or ref.`, { cause });
        }
        definitions.set(alias, definition);
    }
    return definitions;
};

export default class SkillsFunctionality implements FunctionalityAdapter {
    readonly family = SKILLS_FAMILY;
    readonly aliasPattern = SKILL_NAME;
    readonly namespaceOwner = SKILLS_OWNER;
    readonly summary = "Manage Agent Skills";
    readonly definitionSchema: JsonSchema = DEFINITION;
    readonly example = { alias: "sql-formatter", definition: { name: "sql-formatter", source: "https://git.example/acme/skills.git" } };
    readonly docsDir = resolve(import.meta.dirname, "..");
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["source"],
        details: "`source` lists the Agent Skills one source carries: a git remote as a full https or ssh URL, a folder, a lone SKILL.md, or a zip or tar archive. A candidate carries the exact definition to add.",
    };

    readonly #seam: SourceSeam;
    readonly #source: SkillSource;
    readonly #snapshots = new Map<number, Snapshot>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor(seam: SourceSeam) {
        this.#seam = seam;
        this.#source = new SkillSource(() => seam.operatorEnvironment());
    }

    // Reads the fetch deadline and the configured definitions without opening a source.
    static validateConfiguration(): void {
        Knob.integer("PLURNK_SKILLS_FETCH_TIMEOUT_MS", 1);
        serviceSkills();
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
    }

    trees(workspaceId: number): ReadonlyMap<string, SkillTree> {
        return this.#snapshots.get(workspaceId)?.trees ?? new Map();
    }

    async #installedIn(scope: string, dir: string): Promise<Installed[]> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw new Error(`read ${scope} Agent Skills directory ${dir} failed`, { cause });
        }
        const installed: Installed[] = [];
        for (const entry of entries.filter((candidate) => candidate.isDirectory() || candidate.isSymbolicLink())) {
            const file = join(dir, entry.name, "SKILL.md");
            if (await isFile(file)) installed.push({ name: entry.name, dir: join(dir, entry.name), file });
        }
        return installed.toSorted((left, right) => left.name.localeCompare(right.name));
    }

    // {§agent-plugins-hosting} Standalone skills precede bundles within each host-ordered scope.
    async #scan(workspaceId: number, { configurationRoots }: WorkspacePaths): Promise<Map<string, Installed>> {
        const union = new Map<string, Installed>();
        const { plugins } = await this.#seam.readWorkspacePlugins(workspaceId);
        const scopes = new Set([...configurationRoots.map(({ scope }) => scope), ...plugins.map(({ scope }) => scope)]);
        for (const scope of scopes) {
            const root = configurationRoots.find((candidate) => candidate.scope === scope);
            const standalone = root === undefined ? [] : await this.#installedIn(scope, join(root.directory, "skills"));
            for (const installed of standalone) {
                if (!union.has(installed.name)) union.set(installed.name, installed);
            }
            for (const plugin of plugins.filter((candidate) => candidate.scope === scope)) {
                for (const skill of plugin.skills) {
                    const name = skill.document.name;
                    if (!union.has(name)) union.set(name, { name, kind: "plugin", dir: skill.directory, file: join(skill.directory, "SKILL.md") });
                }
            }
        }
        return union;
    }

    async #signature(workspaceId: number, paths: WorkspacePaths, definitions: ReadonlyMap<string, object>): Promise<string> {
        const hash = createHash("sha256");
        hash.update((await this.#seam.readWorkspacePlugins(workspaceId)).signature);
        for (const [name, tree] of await this.#seam.readProvidedSkills()) {
            hash.update(JSON.stringify([name, "service", tree.document.source]));
        }
        for (const { scope, directory } of paths.configurationRoots) {
            for (const installed of await this.#installedIn(scope, join(directory, "skills"))) {
                const identity = await Promise.all([realpath(installed.dir), readFile(installed.file, "utf8")])
                    .catch((cause: unknown) => [messageOf(cause)]);
                hash.update(JSON.stringify([installed.name, scope, ...identity]));
            }
        }
        const settings = environment();
        hash.update(JSON.stringify([...serviceSkills()]));
        for (const [alias, raw] of definitions) {
            const definition = raw as SkillDefinition;
            hash.update(JSON.stringify([alias, definition, settings.enabled(alias)]));
            if (definition.source === undefined) continue;
            try {
                const located = await SkillSource.locate(definition.source, paths);
                if (located.kind !== "folder" && located.kind !== "skill-file") continue;
                const opened = await this.#source.open(located);
                try {
                    for (const found of opened.skills.filter(({ name }) => name === alias)) {
                        hash.update(JSON.stringify([await realpath(found.dir), await readFile(join(found.dir, "SKILL.md"), "utf8")]));
                    }
                    hash.update(JSON.stringify(opened.invalid));
                } finally { await opened.close(); }
            } catch (cause) {
                // The preparation reports the source failure; its fingerprint lets restoration trigger a retry.
                hash.update(messageOf(cause));
            }
        }
        return hash.digest("hex");
    }

    // {§skills-hotload} — skills placed, edited or deleted out of band are admitted before a turn
    // assembles its packet. Changed content republishes; otherwise the coordinator republishes only
    // when the skills it would publish differ from the published ones.
    async refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        const published = this.#snapshots.get(identity.workspaceId);
        if (published === undefined) return;
        const current = await this.#signature(identity.workspaceId, await this.#seam.workspacePaths(identity.workspaceId), published.definitions);
        if (this.#handle === null) throw new Error("Skills Functionality is not attached to its coordinator handle.");
        await this.#handle.refresh(identity, { gate: "none", ifChanged: current === published.signature });
    }

    async available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]> {
        SkillsFunctionality.validateConfiguration();
        const installedSkills = await this.#scan(identity.workspaceId, await this.#seam.workspacePaths(identity.workspaceId));
        const settings = environment();
        const definitions = new Map<string, FunctionalityServiceDefinition>();
        for (const name of (await this.#seam.readProvidedSkills()).keys()) {
            definitions.set(name, { alias: name, definition: { name }, enabled: settings.enabled(name) });
        }
        for (const { name, dir, file, kind } of installedSkills.values()) {
            definitions.set(name, {
                alias: name, definition: { name, source: dir }, enabled: settings.enabled(name),
                provenance: { kind: kind ?? "file", source: file },
            });
        }
        for (const [name, definition] of serviceSkills()) {
            definitions.set(name, {
                alias: name, definition, enabled: settings.enabled(name),
                provenance: { kind: "environment", source: settings.definitions.get(name)!.key },
            });
        }
        return [...definitions.values()];
    }

    async discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        const source = query.source!;
        const located = await SkillSource.locate(source, await this.#seam.workspacePaths(identity.workspaceId));
        const opened = await this.#source.open(located);
        try {
            return opened.skills.map((skill): FunctionalityCandidate => ({
                alias: skill.name,
                summary: skill.description,
                definition: { name: skill.name, source } satisfies SkillDefinition,
                provenance: { kind: "source", source },
            }));
        } finally {
            await opened.close();
        }
    }

    async admit(input: unknown, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource> {
        const params = isRecord(input) ? input : {};
        let definition: SkillDefinition;
        try {
            definition = structuredClone(Validator.assertSkillDefinition(structuredClone(params.definition) as SkillDefinition));
        } catch (cause) {
            throw actionError("definition-invalid", 400, "The Agent Skill definition is invalid.", { retryable: false }, cause);
        }
        const alias = typeof params.alias === "string" ? params.alias : definition.name;
        if (alias !== definition.name) {
            throw actionError("alias-mismatch", 400, `Alias '${alias}' must equal the skill name '${definition.name}'.`, { alias, name: definition.name, retryable: false });
        }
        if (definition.commit !== undefined) {
            throw actionError("definition-invalid", 400, "The service records the commit a skill was added at; name a ref instead.", { alias, retryable: false });
        }
        if (definition.source === undefined) {
            throw actionError("source-required", 400, `Adding '${alias}' requires the source that provides it.`, { alias, retryable: false });
        }
        const located = await SkillSource.locate(definition.source, await this.#seam.workspacePaths(identity.workspaceId));
        if (located.kind !== "git") {
            if (definition.ref !== undefined) throw actionError("definition-invalid", 400, "A ref names a branch or tag of a git source.", { alias, retryable: false });
            return { alias, definition: { ...definition, source: located.location } };
        }
        return { alias, definition: { ...definition, commit: await this.#source.resolveCommit(located.location, definition.ref) } };
    }

    // {§skills-sources} — complete source identity owns a reusable materialization within one workspace.
    async #loadSource(definition: SkillDefinition, workspaceId: number, paths: WorkspacePaths): Promise<SkillDirectory> {
        const key = createHash("sha256").update(JSON.stringify([
            definition.name, definition.source, definition.ref ?? null, definition.commit ?? null,
        ])).digest("hex");
        const root = join(await this.#seam.workspaceStateDirectory(workspaceId, SKILLS_OWNER), key);
        const cached = join(root, definition.name);
        if (await isFile(join(cached, "SKILL.md"))) return this.#loadDirectory(definition.name, cached);
        const located = await SkillSource.locate(definition.source!, paths);
        const opened = await this.#source.open(located, {
            ...(definition.ref === undefined ? {} : { ref: definition.ref }),
            ...(definition.commit === undefined ? {} : { commit: definition.commit }),
        });
        try {
            const matches = opened.skills.filter(({ name }) => name === definition.name);
            if (matches.length > 1) {
                throw actionError("skill-ambiguous", 409, `'${definition.source}' carries ${matches.length} skills named '${definition.name}'.`, {
                    name: definition.name, source: definition.source, retryable: false,
                });
            }
            const match = matches[0];
            if (match === undefined) {
                const broken = opened.invalid.find(({ dir }) => dir.endsWith(`/${definition.name}`));
                if (broken !== undefined) {
                    throw actionError("skill-invalid", 422, `Agent Skill '${definition.name}' in '${definition.source}' is not a valid standard skill: ${broken.reason}`, {
                        name: definition.name, source: definition.source, retryable: false,
                    });
                }
                throw actionError("skill-not-found", 404, `'${definition.source}' carries no Agent Skill named '${definition.name}'.`, {
                    name: definition.name, source: definition.source, retryable: false,
                });
            }
            if (located.kind === "folder" || located.kind === "skill-file") {
                await SkillSource.assertInward(match.dir);
                return await this.#loadDirectory(definition.name, match.dir);
            }
            let dir: string;
            try {
                dir = await SkillSource.install(match, root);
            } catch (cause) {
                if (cause instanceof SkillsActionError) throw cause;
                throw actionError("install-failed", 500, `Agent Skill '${definition.name}' could not be placed under ${root}: ${messageOf(cause)}`, {
                    name: definition.name, retryable: false,
                }, cause);
            }
            return await this.#loadDirectory(definition.name, dir);
        } finally {
            await opened.close();
        }
    }

    async #loadDirectory(alias: string, dir: string): Promise<SkillDirectory> {
        try {
            return await SkillDirectory.load(dir);
        } catch (cause) {
            throw actionError("skill-invalid", 422, `Agent Skill '${alias}' is not a valid standard skill: ${messageOf(cause)}`, { name: alias, path: join(dir, "SKILL.md"), retryable: false }, cause);
        }
    }

    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const paths = await this.#seam.workspacePaths(preparation.workspaceId);
        const definitions = new Map([...preparation.enabled].map(([alias, { definition }]) => [alias, definition]));
        // Read before the skills it describes, so content changed while they load is seen as changed.
        const signature = await this.#signature(preparation.workspaceId, paths, definitions);
        const provided = await this.#seam.readProvidedSkills();
        const previous = preparation.previous as Snapshot | null;
        const carried = new Set(previous?.unavailable ?? []);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const trees = new Map<string, SkillTree>();
        for (const [alias, raw] of definitions) {
            preparation.progress(alias);
            const definition = raw as SkillDefinition;
            try {
                const tree = definition.source === undefined ? provided.get(alias)
                    : await this.#loadSource(definition, preparation.workspaceId, paths);
                if (tree === undefined) throw actionError("skill-missing", 404, `Agent Skill '${alias}' is not provided by this service.`, { name: alias, retryable: false });
                trees.set(new URL(`skill://${alias}/`).hostname, tree);
                outcomes.set(alias, { state: "active", detail: {
                    ...(tree instanceof SkillDirectory ? { path: tree.directory } : {}),
                    description: tree.document.description,
                } });
            } catch (cause) {
                if (!(cause instanceof SkillsActionError)) throw cause;
                const fresh = !carried.has(alias) || preparation.force === alias;
                if (preparation.failure === "reject" && fresh) throw cause;
                if (fresh) console.error(`Agent Skill '${alias}' unavailable: ${cause.problem.detail}`);
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(cause.problem) });
            }
        }
        const snapshot: Snapshot = {
            signature,
            trees,
            definitions,
            unavailable: [...outcomes].filter(([, outcome]) => outcome.state === "unavailable").map(([alias]) => alias),
        };
        const { workspaceId } = preparation;
        return {
            documents: [],
            outcomes,
            snapshot,
            commit: async () => { this.#snapshots.set(workspaceId, snapshot); },
            abort: async () => {},
        };
    }

    async teardown(_snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void> {
        this.#snapshots.delete(identity.workspaceId);
    }
}
