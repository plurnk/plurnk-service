// {§skills-functionality} — standard Agent Skills as one Worker Functionality
// family. The filesystem under the universal roots is the only truth about
// installation; the Worker's durable state owns enablement; the standard
// `skills` CLI is the deterministic installer beneath `add`/`remove` and the
// registry behind `discover`, and neither is the model's or a client's contract.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { parse as parseYaml } from "yaml";
import {
    Problems,
    Validator,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type JsonSchema,
    type ProblemDetails,
    type SkillDefinition,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import type {
    FunctionalityAdapter,
    FunctionalityDefinitionSource,
    FunctionalityFamilyHandle,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    WorkerCapabilityIdentity,
} from "./DaemonModule.ts";

const execFileP = promisify(execFile);

export const SKILLS_FAMILY = "skills";
export const SKILLS_OWNER = "@plurnk/plurnk-core/skills";
const DEFINITION = { $ref: "https://schemas.plurnk.dev/v0/SkillDefinition.json" } as const satisfies JsonSchema;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DEFAULT_CLI = "npx --yes skills";
const DEFAULT_REGISTRY = "https://skills.sh";
const REGISTRY_LIMIT = 20;
const CLI_TIMEOUT_MS = 120_000;

type Scope = SkillDefinition["scope"];

interface SkillDoc {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

interface Installed {
    readonly name: string;
    readonly scope: Scope;
    readonly dir: string;
    readonly file: string;
}

interface Snapshot {
    readonly signature: string;
    // Aliases whose last preparation was unavailable; an unchanged one stays
    // unavailable under a client's reject policy unless it is the retried alias.
    readonly unavailable: readonly string[];
}

export interface RegistrySkill {
    readonly name: string;
    readonly id: string;
    readonly source: string;
    readonly installs: number | null;
}

// The deterministic machinery beneath the adapter: the standard `skills` CLI
// and the ecosystem registry. Tests substitute both.
export interface SkillsToolchain {
    // `home` is the host's user home: the standard CLI's `~` must agree with
    // the service's global Agent Skills root.
    run(args: readonly string[], cwd: string, home: string): Promise<string>;
    search(query: string): Promise<readonly RegistrySkill[]>;
}

export class SkillsActionError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "SkillsActionError";
        this.problem = problem;
    }
}

const problem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("skills:functionality", code, status, detail, {
    stage: "skills-functionality",
    retryable: status === 409 || status >= 500,
    ...extensions,
});

const actionError = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): SkillsActionError => new SkillsActionError(problem(code, status, detail, extensions), cause);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), () => false);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// Agent Skills requires YAML frontmatter with name and description. Admission
// consumes those two discovery keys and preserves the instruction body.
export const parseSkill = (file: string, folder: string, raw: string): SkillDoc => {
    const lines = raw.replace(/\r\n/gu, "\n").split("\n");
    if (lines[0] !== "---") throw new Error(`${file}: Agent Skill requires YAML frontmatter`);
    const close = lines.indexOf("---", 1);
    if (close === -1) throw new Error(`${file}: Agent Skill frontmatter is not closed`);
    let metadata: unknown;
    try {
        metadata = parseYaml(lines.slice(1, close).join("\n"), { maxAliasCount: 0, uniqueKeys: true });
    } catch (cause) {
        throw new Error(`${file}: Agent Skill frontmatter is invalid YAML`, { cause });
    }
    if (!isRecord(metadata)) throw new Error(`${file}: Agent Skill frontmatter must be a mapping`);
    const { name, description } = metadata;
    if (typeof name !== "string" || name.length === 0) throw new Error(`${file}: Agent Skill frontmatter requires name`);
    if (!SKILL_NAME.test(name)) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} is invalid`);
    if (name.length > 64) throw new Error(`${file}: Agent Skill name exceeds 64 characters`);
    if (name !== folder) throw new Error(`${file}: Agent Skill name ${JSON.stringify(name)} must match folder ${JSON.stringify(folder)}`);
    if (typeof description !== "string" || description.length === 0) throw new Error(`${file}: Agent Skill frontmatter requires description`);
    if (description.length > 1024) throw new Error(`${file}: Agent Skill description exceeds 1024 characters`);
    return { name, description, body: lines.slice(close + 1).join("\n").trim() };
};

export const renderSkill = (doc: SkillDoc): string => [
    `# ${doc.name}`,
    "",
    "## Summary",
    "",
    doc.description,
    ...(doc.body.length === 0 ? [] : ["", doc.body]),
].join("\n");

export const renderIndex = (skills: readonly SkillDoc[]): string => [
    "# Skills",
    "",
    "## Summary",
    "",
    "Agent Skills enabled for this worker.",
    ...skills.flatMap((skill) => ["", `- **${skill.name}** — ${skill.description}`]),
].join("\n");

// `skills add <source> --list` prints, after an "Available Skills" heading,
// each skill name at one indentation and its description at a deeper one,
// behind the CLI's box-drawing gutter. Only that structure is read.
export const parseListing = (output: string): Array<{ name: string; description: string }> => {
    const lines = stripVTControlCharacters(output).split(/\r?\n/u);
    const start = lines.findIndex((line) => /Available Skills\s*$/u.test(line));
    if (start === -1) return [];
    const skills: Array<{ name: string; description: string }> = [];
    for (const line of lines.slice(start + 1)) {
        const match = /^[^\s\p{L}\p{N}]*( +)(\S.*)$/u.exec(line);
        if (match === null) continue;
        const indent = match[1]!.length;
        const text = match[2]!.trim();
        if (indent === 4) {
            if (SKILL_NAME.test(text)) skills.push({ name: text, description: "" });
            continue;
        }
        const last = skills.at(-1);
        if (last === undefined || indent < 6) continue;
        skills[skills.length - 1] = { name: last.name, description: last.description.length === 0 ? text : `${last.description} ${text}` };
    }
    return skills;
};

export class StandardSkillsToolchain implements SkillsToolchain {
    readonly #command: readonly string[];
    readonly #registry: string | null;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        const cli = env.PLURNK_SERVICE_SKILLS_CLI?.trim();
        this.#command = (cli === undefined || cli.length === 0 ? DEFAULT_CLI : cli).split(/\s+/u);
        const registry = env.PLURNK_SERVICE_SKILLS_REGISTRY_URL;
        this.#registry = registry === undefined ? DEFAULT_REGISTRY : registry.trim().length === 0 ? null : registry.trim().replace(/\/+$/u, "");
    }

    get registry(): string | null {
        return this.#registry;
    }

    async run(args: readonly string[], cwd: string, home: string): Promise<string> {
        const [command, ...prefix] = this.#command;
        const { stdout, stderr } = await execFileP(command!, [...prefix, ...args], {
            cwd,
            env: { ...process.env, HOME: home, NO_COLOR: "1", CI: "1" },
            timeout: CLI_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
        });
        return `${stdout}\n${stderr}`;
    }

    async search(query: string): Promise<readonly RegistrySkill[]> {
        if (this.#registry === null) {
            throw actionError("registry-not-configured", 501, "Skills registry search is disabled; PLURNK_SERVICE_SKILLS_REGISTRY_URL is empty.", { query, retryable: false });
        }
        const url = `${this.#registry}/api/search?${new URLSearchParams({ q: query, limit: String(REGISTRY_LIMIT) })}`;
        let response: Response;
        try {
            response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        } catch (cause) {
            throw actionError("registry-unreachable", 502, `Skills registry ${this.#registry} could not be reached.`, { query, registry: this.#registry, retryable: true }, cause);
        }
        if (!response.ok) throw actionError("registry-rejected", 502, `Skills registry ${this.#registry} answered ${response.status}.`, { query, registry: this.#registry, status: response.status, retryable: true });
        const body = await response.json() as { skills?: unknown };
        if (!Array.isArray(body.skills)) throw actionError("registry-invalid", 502, `Skills registry ${this.#registry} returned no skills array.`, { query, registry: this.#registry, retryable: true });
        return body.skills.flatMap((skill): RegistrySkill[] => {
            if (!isRecord(skill) || typeof skill.name !== "string" || typeof skill.id !== "string") return [];
            return [{
                name: skill.name,
                id: skill.id,
                source: typeof skill.source === "string" && skill.source.length > 0 ? skill.source : skill.id.split("/").slice(0, 2).join("/"),
                installs: typeof skill.installs === "number" ? skill.installs : null,
            }];
        });
    }
}

export default class SkillsFunctionality implements FunctionalityAdapter {
    readonly family = SKILLS_FAMILY;
    readonly namespaceOwner = SKILLS_OWNER;
    readonly summary = "Agent Skills: standard SKILL.md directories under the project and user roots, enabled per Worker.";
    readonly definitionSchema: JsonSchema = DEFINITION;

    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #toolchain: SkillsToolchain;
    readonly #signatures = new Map<number, string>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor({ db, hostPaths = new HostPaths(), toolchain = new StandardSkillsToolchain() }: {
        readonly db: Db;
        readonly hostPaths?: HostPaths;
        readonly toolchain?: SkillsToolchain;
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        this.#toolchain = toolchain;
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
    }

    async #projectRoot(workspaceId: number): Promise<string | null> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return workspace?.project_root ?? null;
    }

    #rootFor(scope: Scope, projectRoot: string | null): string | null {
        if (scope === "global") return this.#hostPaths.globalSkillsDir;
        return projectRoot === null ? null : this.#hostPaths.projectSkillsDir(projectRoot);
    }

    #cwdFor(scope: Scope, projectRoot: string | null): string {
        return scope === "global" || projectRoot === null ? this.#hostPaths.home : projectRoot;
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

    // The effective installed union: project shadows global by name.
    async #scan(projectRoot: string | null): Promise<Map<string, Installed>> {
        const union = new Map<string, Installed>();
        for (const scope of ["project", "global"] as const) {
            const dir = this.#rootFor(scope, projectRoot);
            if (dir === null) continue;
            for (const installed of await this.#installedIn(scope, dir)) {
                if (!union.has(installed.name)) union.set(installed.name, installed);
            }
        }
        return union;
    }

    // The standard installer's lock files record each installed skill's source.
    async #lockSources(projectRoot: string | null): Promise<Map<string, string>> {
        const sources = new Map<string, string>();
        for (const dir of [projectRoot, this.#hostPaths.home]) {
            if (dir === null) continue;
            let lock: unknown;
            try {
                lock = JSON.parse(await readFile(join(dir, "skills-lock.json"), "utf8"));
            } catch {
                continue;
            }
            if (!isRecord(lock) || !isRecord(lock.skills)) continue;
            for (const [name, entry] of Object.entries(lock.skills)) {
                if (isRecord(entry) && typeof entry.source === "string" && !sources.has(name)) sources.set(name, entry.source);
            }
        }
        return sources;
    }

    async #signature(projectRoot: string | null): Promise<string> {
        const hash = createHash("sha256");
        for (const installed of (await this.#scan(projectRoot)).values()) {
            const content = await readFile(installed.file, "utf8").catch((cause: unknown) => `!${messageOf(cause)}`);
            hash.update(`${installed.name} ${installed.scope} ${content}`);
        }
        return hash.digest("hex");
    }

    // {§skills-hotload} — filesystem installers operate out of band; before a
    // turn assembles its packet the family republishes when the roots changed.
    async refreshIfChanged(identity: WorkerCapabilityIdentity): Promise<void> {
        const published = this.#signatures.get(identity.workerId);
        if (published === undefined) return;
        const current = await this.#signature(await this.#projectRoot(identity.workspaceId));
        if (current === published) return;
        if (this.#handle === null) throw new Error("Skills Functionality is not attached to its coordinator handle.");
        await this.#handle.refresh(identity, { gate: "none" });
    }

    async available(identity: WorkerCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]> {
        const projectRoot = await this.#projectRoot(identity.workspaceId);
        const sources = await this.#lockSources(projectRoot);
        return [...(await this.#scan(projectRoot)).values()].map((installed) => {
            const source = sources.get(installed.name);
            const definition: SkillDefinition = { name: installed.name, scope: installed.scope, ...(source === undefined ? {} : { source }) };
            return { alias: installed.name, definition, enabled: true };
        });
    }

    async discover(query: FunctionalityDiscoverQuery, identity: WorkerCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            throw actionError("configuration-unsupported", 400, "Agent Skills discovery takes a registry query or an explicit source; client configuration contributes nothing.", { retryable: false });
        }
        if (query.source !== undefined) {
            const source = query.source;
            const cwd = this.#cwdFor("project", await this.#projectRoot(identity.workspaceId));
            let output: string;
            try {
                output = await this.#toolchain.run(["add", source, "--list"], cwd, this.#hostPaths.home);
            } catch (cause) {
                throw actionError("discover-failed", 502, `Agent Skills source '${source}' could not be listed: ${messageOf(cause)}`, { source, retryable: true }, cause);
            }
            return parseListing(output).map((skill): FunctionalityCandidate => ({
                alias: skill.name,
                ...(skill.description.length === 0 ? {} : { summary: skill.description }),
                definition: { name: skill.name, scope: "project", source } satisfies SkillDefinition,
                provenance: { kind: "source", source },
            }));
        }
        if (query.query === undefined) return [];
        const registry = await this.#toolchain.search(query.query);
        return registry.flatMap((skill): FunctionalityCandidate[] => {
            if (!SKILL_NAME.test(skill.name)) return [];
            return [{
                alias: skill.name,
                ...(skill.installs === null ? {} : { summary: `${skill.installs} installs` }),
                definition: { name: skill.name, scope: "project", source: skill.source } satisfies SkillDefinition,
                provenance: { kind: "registry", source: skill.source, reference: `${DEFAULT_REGISTRY}/${skill.id}` },
            }];
        });
    }

    async admit(input: unknown, identity: WorkerCapabilityIdentity): Promise<FunctionalityDefinitionSource> {
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
        if (definition.source === undefined) {
            throw actionError("source-required", 400, `Adding '${alias}' requires the standard installer source that provides it.`, { alias, retryable: false });
        }
        if (definition.scope === "project" && await this.#projectRoot(identity.workspaceId) === null) {
            throw actionError("project-root-required", 400, `'${alias}' targets the project scope, but this workspace has no project root.`, { alias, recovery: "Add it with scope \"global\" or open a workspace rooted in a project.", retryable: false });
        }
        return { alias, definition };
    }

    async #install(definition: SkillDefinition, root: string, cwd: string): Promise<Installed> {
        const args = ["add", definition.source!, "--agent", "universal", "--skill", definition.name, "--yes", ...(definition.scope === "global" ? ["--global"] : [])];
        let output: string;
        try {
            output = await this.#toolchain.run(args, cwd, this.#hostPaths.home);
        } catch (cause) {
            throw actionError("install-failed", 502, `Agent Skill '${definition.name}' could not be installed from '${definition.source}': ${messageOf(cause)}`, { name: definition.name, source: definition.source, scope: definition.scope, retryable: true }, cause);
        }
        const file = join(root, definition.name, "SKILL.md");
        if (!(await isFile(file))) {
            throw actionError("install-failed", 502, `The installer reported '${definition.name}' from '${definition.source}' but ${file} does not exist.`, { name: definition.name, source: definition.source, scope: definition.scope, output: stripVTControlCharacters(output).trim().slice(-2000), retryable: true });
        }
        return { name: definition.name, scope: definition.scope, dir: join(root, definition.name), file };
    }

    // {§skills-remove} — the coordinator forgets the Worker's own definition;
    // the adapter uninstalls what that definition installed at its scope.
    async forget(source: FunctionalityDefinitionSource, identity: WorkerCapabilityIdentity): Promise<void> {
        const definition = source.definition as SkillDefinition;
        const projectRoot = await this.#projectRoot(identity.workspaceId);
        const root = this.#rootFor(definition.scope, projectRoot);
        if (root === null) return;
        const dir = join(root, definition.name);
        if (!(await exists(dir))) return;
        try {
            await this.#toolchain.run(["remove", definition.name, "--yes", ...(definition.scope === "global" ? ["--global"] : [])], this.#cwdFor(definition.scope, projectRoot), this.#hostPaths.home);
        } catch (cause) {
            throw actionError("uninstall-failed", 502, `Agent Skill '${definition.name}' could not be removed from its ${definition.scope} root: ${messageOf(cause)}`, { name: definition.name, scope: definition.scope, retryable: true }, cause);
        }
        if (await exists(dir)) throw actionError("uninstall-failed", 502, `The installer reported removal of '${definition.name}' but ${dir} still exists.`, { name: definition.name, scope: definition.scope, retryable: true });
    }

    async #locate(alias: string, definition: SkillDefinition, installed: Map<string, Installed>, projectRoot: string | null): Promise<Installed | undefined> {
        const shadowing = installed.get(alias);
        if (shadowing === undefined || shadowing.scope === definition.scope) return shadowing;
        // The Worker's own definition names a root below the one currently
        // shadowing that name; the definition's scope is truth.
        const root = this.#rootFor(definition.scope, projectRoot);
        if (root === null) return undefined;
        const file = join(root, alias, "SKILL.md");
        return (await isFile(file)) ? { name: alias, scope: definition.scope, dir: join(root, alias), file } : undefined;
    }

    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const projectRoot = await this.#projectRoot(preparation.workspaceId);
        const installed = await this.#scan(projectRoot);
        const previous = preparation.previous as Snapshot | null;
        const carried = new Set(previous?.unavailable ?? []);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const docs: SkillDoc[] = [];
        for (const [alias, raw] of preparation.enabled) {
            const definition = raw as SkillDefinition;
            try {
                let located = await this.#locate(alias, definition, installed, projectRoot);
                if (located === undefined) {
                    const root = this.#rootFor(definition.scope, projectRoot);
                    if (root === null) throw actionError("project-root-required", 409, `'${alias}' targets the project scope, but this workspace has no project root.`, { name: alias, retryable: false });
                    if (definition.source === undefined) throw actionError("skill-missing", 404, `Agent Skill '${alias}' is not installed under its ${definition.scope} root.`, { name: alias, scope: definition.scope, root, retryable: false });
                    located = await this.#install(definition, root, this.#cwdFor(definition.scope, projectRoot));
                }
                let doc: SkillDoc;
                try {
                    doc = parseSkill(located.file, located.name, await readFile(located.file, "utf8"));
                } catch (cause) {
                    throw actionError("skill-invalid", 422, `Agent Skill '${alias}' is not a valid standard skill: ${messageOf(cause)}`, { name: alias, scope: located.scope, path: located.file, retryable: false }, cause);
                }
                docs.push(doc);
                outcomes.set(alias, { state: "active", detail: { scope: located.scope, path: located.dir, description: doc.description } });
            } catch (cause) {
                if (!(cause instanceof SkillsActionError)) throw cause;
                const fresh = !carried.has(alias) || preparation.force === alias;
                if (preparation.failure === "reject" && fresh) throw cause;
                if (fresh) console.error(`Agent Skill '${alias}' unavailable: ${cause.problem.detail}`);
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(cause.problem) });
            }
        }
        docs.sort((left, right) => left.name.localeCompare(right.name));
        const documents = [
            { pathname: "skills/index.md", content: renderIndex(docs) },
            ...docs.map((doc) => ({ pathname: `skills/${encodeURIComponent(doc.name)}.md`, content: renderSkill(doc) })),
        ];
        const signature = await this.#signature(projectRoot);
        const snapshot: Snapshot = {
            signature,
            unavailable: [...outcomes].filter(([, outcome]) => outcome.state === "unavailable").map(([alias]) => alias),
        };
        const { workerId } = preparation;
        return {
            runtimes: [],
            documents,
            outcomes,
            snapshot,
            commit: async () => { this.#signatures.set(workerId, signature); },
            abort: async () => {},
        };
    }

    async teardown(_snapshot: unknown, identity: WorkerCapabilityIdentity): Promise<void> {
        this.#signatures.delete(identity.workerId);
    }
}
