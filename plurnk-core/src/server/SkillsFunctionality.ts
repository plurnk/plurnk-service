// {§skills-functionality} — standard Agent Skills as one workspace Functionality
// family. The skill roots and host-provided trees own resources; workspace
// state owns enablement; {§skills-sources} fetch what `add` names, and no
// installer or registry stands between a source and its root.
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
import { Knob } from "@plurnk/plurnk-meta";
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
import { agentRootScopes } from "./AgentRoots.ts";
import { SkillsActionError, actionError, messageOf } from "./skills-problems.ts";

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

type Scope = SkillDefinition["scope"];


interface Installed {
    readonly name: string;
    readonly scope: Scope;
    readonly dir: string;
    readonly file: string;
}

interface Snapshot {
    readonly signature: string;
    readonly trees: ReadonlyMap<string, SkillTree>;
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
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, missing);

export default class SkillsFunctionality implements FunctionalityAdapter {
    readonly family = SKILLS_FAMILY;
    readonly aliasPattern = SKILL_NAME;
    readonly namespaceOwner = SKILLS_OWNER;
    readonly summary = "Manage Agent Skills";
    readonly definitionSchema: JsonSchema = DEFINITION;
    readonly example = { alias: "sql-formatter", definition: { name: "sql-formatter", scope: "project", source: "https://git.example/acme/skills.git" } };
    readonly docsDir = Paths.packageRoot;
    readonly discovery = {
        details: "`source` lists the Agent Skills one source carries: a git remote as a full https or ssh URL, a folder, a lone SKILL.md, or a zip or tar archive. A candidate carries the exact definition to add.",
    };

    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #provided: () => Promise<ReadonlyMap<string, SkillTree>>;
    readonly #snapshots = new Map<number, Snapshot>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor({ db, hostPaths = new HostPaths(), provided = async () => new Map() }: {
        readonly db: Db;
        readonly hostPaths?: HostPaths;
        readonly provided?: () => Promise<ReadonlyMap<string, SkillTree>>;
    }) {
        this.#db = db;
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

    #rootFor(scope: Scope, projectRoot: string | null): string | null {
        if (scope === "service") throw new TypeError("A service-provided skill has no root.");
        if (!agentRootScopes().has(scope)) return null;
        if (scope === "global") return this.#hostPaths.globalSkillsDir;
        if (scope === "plurnk") return this.#hostPaths.plurnkSkillsDir;
        return projectRoot === null ? null : this.#hostPaths.projectSkillsDir(projectRoot);
    }

    async #installedIn(scope: Scope, dir: string): Promise<Installed[]> {
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

    async #signature(projectRoot: string | null): Promise<string> {
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
        return hash.digest("hex");
    }

    // {§skills-hotload} — skills placed, edited or deleted out of band are admitted before a turn
    // assembles its packet. Changed content republishes; otherwise the coordinator republishes only
    // when the skills it would publish differ from the published ones.
    async refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        const published = this.#snapshots.get(identity.workspaceId)?.signature;
        if (published === undefined) return;
        const current = await this.#signature(await this.#projectRoot(identity.workspaceId));
        if (this.#handle === null) throw new Error("Skills Functionality is not attached to its coordinator handle.");
        await this.#handle.refresh(identity, { gate: "none", ifChanged: current === published });
    }

    async available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]> {
        const installedSkills = await this.#scan(await this.#projectRoot(identity.workspaceId));
        const native = [...installedSkills.values()].map((installed) => ({
            alias: installed.name,
            definition: { name: installed.name, scope: installed.scope } satisfies SkillDefinition,
            enabled: true,
        }));
        const provided = [...(await this.#provided()).keys()]
            .filter((name) => !installedSkills.has(name))
            .map((name) => ({ alias: name, definition: { name, scope: "service" } satisfies SkillDefinition, enabled: true }));
        return [...native, ...provided];
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
                definition: { name: skill.name, scope: "project", source } satisfies SkillDefinition,
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
        if (definition.scope === "service") {
            throw actionError("scope-not-installable", 400, "Service-provided skills can be enabled or disabled; adding a skill requires the project, plurnk, or global scope.", { alias, retryable: false });
        }
        if (definition.commit !== undefined) {
            throw actionError("definition-invalid", 400, "The service records the commit a skill was added at; name a ref instead.", { alias, retryable: false });
        }
        if (definition.source === undefined) {
            throw actionError("source-required", 400, `Adding '${alias}' requires the source that provides it.`, { alias, retryable: false });
        }
        const read = agentRootScopes();
        if (!read.has(definition.scope)) {
            throw actionError("scope-unread", 400, `'${alias}' targets the ${definition.scope} root, which this daemon does not read.`, {
                alias, scope: definition.scope, recovery: `Add it at a root this daemon reads: ${[...read].join(", ") || "none"}.`, retryable: false,
            });
        }
        const projectRoot = await this.#projectRoot(identity.workspaceId);
        if (definition.scope === "project" && projectRoot === null) {
            throw actionError("project-root-required", 400, `'${alias}' targets the project scope, but this workspace has no project root.`, { alias, recovery: "Add it with scope \"plurnk\" or \"global\", or open a workspace rooted in a project.", retryable: false });
        }
        const located = await SkillSource.locate(definition.source, { projectRoot, home: this.#hostPaths.home });
        if (located.kind !== "git") {
            if (definition.ref !== undefined) throw actionError("definition-invalid", 400, "A ref names a branch or tag of a git source.", { alias, retryable: false });
            return { alias, definition: { ...definition, source: located.location } };
        }
        return { alias, definition: { ...definition, commit: await SkillSource.resolveCommit(located.location, definition.ref) } };
    }

    // {§skills-sources} — materializes a workspace definition's skill from its source into its root.
    async #install(definition: SkillDefinition, root: string, projectRoot: string | null): Promise<Installed> {
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
            let dir: string;
            try {
                dir = await SkillSource.install(match, root);
            } catch (cause) {
                if (cause instanceof SkillsActionError) throw cause;
                throw actionError("install-failed", 500, `Agent Skill '${definition.name}' could not be placed under ${root}: ${messageOf(cause)}`, {
                    name: definition.name, scope: definition.scope, retryable: false,
                }, cause);
            }
            return { name: definition.name, scope: definition.scope, dir, file: join(dir, "SKILL.md") };
        } finally {
            await opened.close();
        }
    }

    // {§skills-remove} — the coordinator forgets the workspace definition;
    // the adapter deletes the skill that definition placed at its scope.
    async forget(source: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void> {
        const definition = source.definition as SkillDefinition;
        const root = this.#rootFor(definition.scope, await this.#projectRoot(identity.workspaceId));
        if (root === null) return;
        const dir = join(root, definition.name);
        if (!(await exists(dir))) return;
        try {
            await rm(dir, { recursive: true, force: true });
        } catch (cause) {
            throw actionError("uninstall-failed", 500, `Agent Skill '${definition.name}' could not be removed from its ${definition.scope} root: ${messageOf(cause)}`, { name: definition.name, scope: definition.scope, retryable: true }, cause);
        }
    }

    async #locate(alias: string, definition: SkillDefinition, installed: Map<string, Installed>, projectRoot: string | null): Promise<Installed | undefined> {
        const shadowing = installed.get(alias);
        if (shadowing === undefined || shadowing.scope === definition.scope) return shadowing;
        // The workspace definition names a root below the one currently
        // shadowing that name; the definition's scope is truth.
        const root = this.#rootFor(definition.scope, projectRoot);
        if (root === null) return undefined;
        const file = join(root, alias, "SKILL.md");
        return (await isFile(file)) ? { name: alias, scope: definition.scope, dir: join(root, alias), file } : undefined;
    }

    async #loadInstalled(alias: string, definition: SkillDefinition, installed: Map<string, Installed>, projectRoot: string | null): Promise<SkillDirectory> {
        let located = await this.#locate(alias, definition, installed, projectRoot);
        if (located === undefined) {
            const root = this.#rootFor(definition.scope, projectRoot);
            if (root === null && definition.scope !== "service" && !agentRootScopes().has(definition.scope)) {
                throw actionError("scope-unread", 409, `'${alias}' is installed at the ${definition.scope} root, which this daemon does not read.`, { name: alias, scope: definition.scope, retryable: false });
            }
            if (root === null) throw actionError("project-root-required", 409, `'${alias}' targets the project scope, but this workspace has no project root.`, { name: alias, retryable: false });
            if (definition.source === undefined) throw actionError("skill-missing", 404, `Agent Skill '${alias}' is not installed under its ${definition.scope} root.`, { name: alias, scope: definition.scope, root, retryable: false });
            located = await this.#install(definition, root, projectRoot);
        }
        try {
            return await SkillDirectory.load(located.dir);
        } catch (cause) {
            throw actionError("skill-invalid", 422, `Agent Skill '${alias}' is not a valid standard skill: ${messageOf(cause)}`, { name: alias, scope: located.scope, path: located.file, retryable: false }, cause);
        }
    }

    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const projectRoot = await this.#projectRoot(preparation.workspaceId);
        // Read before the skills it describes, so content changed while they load is seen as changed.
        const signature = await this.#signature(projectRoot);
        const installed = await this.#scan(projectRoot);
        const provided = await this.#provided();
        const previous = preparation.previous as Snapshot | null;
        const carried = new Set(previous?.unavailable ?? []);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const trees = new Map<string, SkillTree>();
        for (const [alias, raw] of preparation.enabled) {
            preparation.progress(alias);
            const definition = raw as SkillDefinition;
            try {
                const tree = definition.scope === "service" ? provided.get(alias)
                    : await this.#loadInstalled(alias, definition, installed, projectRoot);
                if (tree === undefined) throw actionError("skill-missing", 404, `Agent Skill '${alias}' is not provided by this service.`, { name: alias, retryable: false });
                trees.set(new URL(`skill://${alias}/`).hostname, tree);
                outcomes.set(alias, { state: "active", detail: {
                    scope: definition.scope,
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
