// {§skills-functionality} — standard Agent Skills as one workspace Functionality
// family. Configuration roots are inputs; live references and fetched sources
// belong to workspace definitions, never to an installation scope.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { SkillDirectory, type SkillTree } from "@plurnk/plurnk-agent-skills";
import {
    SKILL_NAME,
    Validator,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type JsonSchema,
    type SkillDefinition,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import { Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import Paths from "../Paths.ts";
import type {
    FunctionalityDefinitionSource,
    FunctionalityFamilyHandle,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type {
    FunctionalityAdapter,
} from "./DaemonModule.ts";
import SkillSource from "./SkillSource.ts";
import { agentRootScopes, type AgentRootScope } from "./AgentRoots.ts";
import { SkillsActionError, actionError, messageOf } from "./skills-problems.ts";
import type WorkspaceStorage from "./WorkspaceStorage.ts";

const SKILLS_FAMILY = "skills";
const SKILLS_OWNER = "@plurnk/plurnk-core/skills";
const DEFINITION = { $ref: "https://schemas.plurnk.xyz/v0/SkillDefinition.json" } as const satisfies JsonSchema;
// {§skills-sources} — the vendor installer's knobs; each names what replaced it.
const RETIRED_KNOBS: Readonly<Record<string, string>> = Object.freeze({
    PLURNK_SERVICE_SKILLS_CLI: "add fetches git, folder and file sources itself",
    PLURNK_SERVICE_SKILLS_CLI_TIMEOUT_MS: "PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS bounds each fetch",
    PLURNK_SERVICE_SKILLS_REGISTRY_URL: "discover takes a source; Agent Skills have no standard registry",
    PLURNK_SERVICE_SKILLS_REGISTRY_LIMIT: "discover takes a source; Agent Skills have no standard registry",
    PLURNK_SERVICE_SKILLS_REGISTRY_TIMEOUT_MS: "discover takes a source; Agent Skills have no standard registry",
});
// Installed roots in precedence order: a nearer root shadows a farther one by name.
const ROOTS = ["project", "plurnk", "global"] as const;

interface Installed {
    readonly name: string;
    readonly scope: AgentRootScope;
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
    "PLURNK_SKILLS_", { controls: [], settings: [], aliasPattern: SKILL_NAME }, env,
);

export const serviceSkills = (env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, SkillDefinition> => {
    const definitions = new Map<string, SkillDefinition>();
    for (const [alias, { key, value }] of environment(env).definitions) {
        let definition: SkillDefinition;
        try {
            definition = Validator.assertSkillDefinition(JSON.parse(value));
        } catch (cause) {
            throw new Error(`${key} must contain a complete SkillDefinition.`, { cause });
        }
        if (definition.name !== alias) throw new Error(`${key}: the definition name must equal '${alias}'.`);
        if (definition.source === undefined) throw new Error(`${key}: a configured skill requires a source.`);
        if (definition.commit !== undefined) throw new Error(`${key}: commit is service-recorded; configure a Git ref instead.`);
        try {
            const remote = SkillSource.remote(definition.source);
            if (definition.ref !== undefined && remote === null) throw new Error("A ref names a branch or tag of a git source.");
        } catch (cause) {
            throw new Error(`${key}: invalid skill source or ref.`, { cause });
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
    readonly docsDir = Paths.packageRoot;
    readonly discovery = {
        details: "`source` lists the Agent Skills one source carries: a git remote as a full https or ssh URL, a folder, a lone SKILL.md, or a zip or tar archive. A candidate carries the exact definition to add.",
    };

    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #storage: WorkspaceStorage;
    readonly #provided: () => Promise<ReadonlyMap<string, SkillTree>>;
    readonly #snapshots = new Map<number, Snapshot>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor({ db, storage, hostPaths = new HostPaths(), provided = async () => new Map() }: {
        readonly db: Db;
        readonly storage: WorkspaceStorage;
        readonly hostPaths?: HostPaths;
        readonly provided?: () => Promise<ReadonlyMap<string, SkillTree>>;
    }) {
        this.#db = db;
        this.#storage = storage;
        this.#hostPaths = hostPaths;
        this.#provided = provided;
    }

    // Refuses the vendor installer's retired knobs, naming what replaced each, and reads the fetch deadline.
    static validateConfiguration(): void {
        for (const [knob, successor] of Object.entries(RETIRED_KNOBS)) {
            const stale = process.env[knob];
            if (stale !== undefined && stale.length > 0) throw new Error(`${knob} is retired: ${successor}.`);
        }
        Knob.integer("PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS", 1);
        serviceSkills();
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
    }

    trees(workspaceId: number): ReadonlyMap<string, SkillTree> {
        return this.#snapshots.get(workspaceId)?.trees ?? new Map();
    }

    async #projectRoot(workspaceId: number): Promise<string | null> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return workspace?.project_root ?? null;
    }

    #rootFor(scope: AgentRootScope, projectRoot: string | null): string | null {
        if (!agentRootScopes().has(scope)) return null;
        if (scope === "global") return this.#hostPaths.globalSkillsDir;
        if (scope === "plurnk") return this.#hostPaths.plurnkSkillsDir;
        return projectRoot === null ? null : this.#hostPaths.projectSkillsDir(projectRoot);
    }

    async #installedIn(scope: AgentRootScope, dir: string): Promise<Installed[]> {
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
            if (await isFile(file)) installed.push({ name: entry.name, scope, dir: join(dir, entry.name), file });
        }
        return installed.toSorted((left, right) => left.name.localeCompare(right.name));
    }

    // The effective installed union: project shadows plurnk shadows global, by name.
    async #scan(projectRoot: string | null): Promise<Map<string, Installed>> {
        const union = new Map<string, Installed>();
        for (const scope of ROOTS) {
            const dir = this.#rootFor(scope, projectRoot);
            if (dir === null) continue;
            for (const installed of await this.#installedIn(scope, dir)) {
                if (!union.has(installed.name)) union.set(installed.name, installed);
            }
        }
        return union;
    }

    async #signature(projectRoot: string | null, definitions: ReadonlyMap<string, object>): Promise<string> {
        const hash = createHash("sha256");
        for (const [name, tree] of await this.#provided()) {
            hash.update(JSON.stringify([name, "service", tree.document.source]));
        }
        for (const scope of ROOTS) {
            const root = this.#rootFor(scope, projectRoot);
            if (root === null) continue;
            for (const installed of await this.#installedIn(scope, root)) {
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
                const located = await SkillSource.locate(definition.source, { projectRoot, home: this.#hostPaths.home });
                if (located.kind !== "folder" && located.kind !== "skill-file") continue;
                const opened = await SkillSource.open(located);
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
        const current = await this.#signature(await this.#projectRoot(identity.workspaceId), published.definitions);
        if (this.#handle === null) throw new Error("Skills Functionality is not attached to its coordinator handle.");
        await this.#handle.refresh(identity, { gate: "none", ifChanged: current === published.signature });
    }

    async available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]> {
        const installedSkills = await this.#scan(await this.#projectRoot(identity.workspaceId));
        const definitions = new Map<string, SkillDefinition>([...(await this.#provided()).keys()].map((name) => [name, { name }]));
        for (const { name, dir } of installedSkills.values()) definitions.set(name, { name, source: dir });
        for (const [name, definition] of serviceSkills()) definitions.set(name, definition);
        const settings = environment();
        return [...definitions].map(([alias, definition]) => ({ alias, definition, enabled: settings.enabled(alias) }));
    }

    async discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            throw actionError("configuration-unsupported", 400, "Agent Skills discovery takes a source; client configuration contributes nothing.", { retryable: false });
        }
        if (query.query !== undefined) {
            throw actionError("query-unsupported", 400, "Agent Skills have no standard registry to search; discover takes a source: a git remote as a full https or ssh URL, a folder, a lone SKILL.md, or a zip or tar archive.", { query: query.query, retryable: false });
        }
        if (query.source === undefined) return [];
        const source = query.source;
        const located = await SkillSource.locate(source, { projectRoot: await this.#projectRoot(identity.workspaceId), home: this.#hostPaths.home });
        const opened = await SkillSource.open(located);
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
        const projectRoot = await this.#projectRoot(identity.workspaceId);
        const located = await SkillSource.locate(definition.source, { projectRoot, home: this.#hostPaths.home });
        if (located.kind !== "git") {
            if (definition.ref !== undefined) throw actionError("definition-invalid", 400, "A ref names a branch or tag of a git source.", { alias, retryable: false });
            return { alias, definition: { ...definition, source: located.location } };
        }
        return { alias, definition: { ...definition, commit: await SkillSource.resolveCommit(located.location, definition.ref) } };
    }

    // {§skills-sources} — complete source identity owns a reusable materialization within one workspace.
    async #loadSource(definition: SkillDefinition, workspaceId: number, projectRoot: string | null): Promise<SkillDirectory> {
        const key = createHash("sha256").update(JSON.stringify([
            definition.name, definition.source, definition.ref ?? null, definition.commit ?? null,
        ])).digest("hex");
        const root = join(await this.#storage.directory(workspaceId, SKILLS_OWNER), key);
        const cached = join(root, definition.name);
        if (await isFile(join(cached, "SKILL.md"))) return this.#loadDirectory(definition.name, cached);
        const located = await SkillSource.locate(definition.source!, { projectRoot, home: this.#hostPaths.home });
        const opened = await SkillSource.open(located, {
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
        const projectRoot = await this.#projectRoot(preparation.workspaceId);
        // Read before the skills it describes, so content changed while they load is seen as changed.
        const signature = await this.#signature(projectRoot, preparation.enabled);
        const provided = await this.#provided();
        const previous = preparation.previous as Snapshot | null;
        const carried = new Set(previous?.unavailable ?? []);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const trees = new Map<string, SkillTree>();
        for (const [alias, raw] of preparation.enabled) {
            preparation.progress(alias);
            const definition = raw as SkillDefinition;
            try {
                const tree = definition.source === undefined ? provided.get(alias)
                    : await this.#loadSource(definition, preparation.workspaceId, projectRoot);
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
            definitions: new Map(preparation.enabled),
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
