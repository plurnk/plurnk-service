// {§members-functionality} — file membership as one Worker Functionality family. The model, the
// client, and the operator learn one surface (list | discover | add | enable | disable | remove)
// for what the model may see, exactly as they do for skills and MCP servers. A definition is one
// gitignore-style glob and `!glob` excludes; definitions are desired state per Worker and the
// workspace overlay is their union ({§members-projection}) — the one truth every worker sees
// ({§membership-baseline}). A model's `add` is admitted against the service ceiling
// `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` (none < root < namespace) narrowed by the workspace.
import { stat } from "node:fs/promises";
import { matchesGlob, resolve } from "node:path";
import { Validator, type FunctionalityCandidate, type FunctionalityDiscoverQuery, type JsonSchema } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import FileCreationPolicy, { type FileCreateScope } from "../core/file-creation-policy.ts";
import GitMembership, { type OverlayResolution, type OverlayRow } from "../core/git-membership.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import type {
    FunctionalityAdapter,
    FunctionalityCaller,
    FunctionalityDefinitionSource,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    WorkerCapabilityIdentity,
} from "./DaemonModule.ts";

export const MEMBERS_FAMILY = "members";
export const MEMBERS_OWNER = "@plurnk/plurnk-core/members";
const PREFIX = "PLURNK_MEMBERS_";
const ENABLED_KEY = "PLURNK_MEMBERS_ENABLED";
const SCOPE_KEY = "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE";
const ALIAS = /^[a-z][a-z0-9-]*$/u;
const PATTERN_CHARACTERS = /[*?[\]{}]/u;
const SAMPLE = 20;

export type MembersProvenance = {
    readonly kind: "service-configuration" | "client-action" | "model-proposal";
    readonly source?: string;
};
export type MembersDefinition = {
    readonly glob: string;
    readonly provenance?: MembersProvenance;
};
export type MembersSource = "members" | "model";
// What one definition resolved to on disk: the members it admits or removes, and — for a model's
// inclusion — the matches the repository's ignore rules refused.
export type MembersResolution = {
    readonly effect: "include" | "exclude";
    readonly pattern: string;
    readonly matched: number;
    readonly files: readonly string[];
    readonly ignored: number;
};
type StateRecord = { origin: "service" | "worker"; enabled: boolean; definition?: MembersDefinition };

// The exact definition one `add` accepts. Provenance is the coordinator's truth, never the
// caller's claim: `admit` overwrites whatever arrived in the definition.
const DEFINITION: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["glob"],
    properties: {
        glob: {
            type: "string",
            minLength: 1,
            description: "A gitignore-style pattern relative to the project root (`docs/**`, `*.md`, `../shared/*.json`). A leading `!` excludes matching members; an exclusion wins over every inclusion.",
        },
        provenance: {
            type: "object",
            readOnly: true,
            additionalProperties: false,
            required: ["kind"],
            properties: {
                kind: { enum: ["service-configuration", "client-action", "model-proposal"] },
                source: { type: "string" },
            },
        },
    },
});

const refuse = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("members:functionality", code, status, detail, {}, { family: MEMBERS_FAMILY, retryable: false, ...extensions }),
);

export const isExclusion = (glob: string): boolean => glob.startsWith("!");
export const patternOf = (glob: string): string => (isExclusion(glob) ? glob.slice(1) : glob);

// A glob as an alias suggestion: `docs/**` → `docs`, `!**/tokenizer.json` → `no-tokenizer-json`.
export const aliasOf = (glob: string): string => {
    const folded = patternOf(glob).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
    const base = ALIAS.test(folded) ? folded : `p-${folded}`.replace(/-+$/u, "");
    return isExclusion(glob) ? `no-${base}` : base;
};

const foldAlias = (suffix: string): string => suffix.toLowerCase().replaceAll("_", "-");

const jsonStrings = (raw: string | undefined, key: string): string[] => {
    if (raw === undefined || raw.trim().length === 0) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (cause) { throw new Error(`${key} must be a JSON array of aliases.`, { cause }); }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error(`${key} must be a JSON array of aliases.`);
    return parsed as string[];
};

// {§members-configuration} — the operator's definitions: PLURNK_MEMBERS_<ALIAS>=<glob> (`!glob`
// excludes) and PLURNK_MEMBERS_ENABLED=[…] naming the subset enabled by default (absent or []
// enables none) — the shape PLURNK_MCP_* already has.
export const serviceMembers = (environ: NodeJS.ProcessEnv = process.env): FunctionalityServiceDefinition[] => {
    const targets = new Map<string, { key: string; glob: string }>();
    for (const [key, value] of Object.entries(environ)) {
        if (!key.startsWith(PREFIX) || value === undefined || key === ENABLED_KEY) continue;
        targets.set(foldAlias(key.slice(PREFIX.length)), { key, glob: value.trim() });
    }
    const enabled = new Set(jsonStrings(environ[ENABLED_KEY], ENABLED_KEY));
    for (const alias of enabled) {
        if (!targets.has(alias)) throw new Error(`${ENABLED_KEY} contains unknown members alias '${alias}'.`);
    }
    return [...targets].toSorted(([left], [right]) => left.localeCompare(right)).map(([alias, { key, glob }]) => {
        if (!ALIAS.test(alias)) throw new Error(`${key} names an invalid members alias '${alias}'.`);
        if (patternOf(glob).length === 0) throw new Error(`${key} names no pattern.`);
        return {
            alias,
            definition: { glob, provenance: { kind: "service-configuration", source: key } } satisfies MembersDefinition,
            enabled: enabled.has(alias),
        };
    });
};

// {§members-model-scope} — the ceiling a model's `add` is admitted against; unset is `none`,
// the guarantee ({§membership-baseline}).
export const modelScope = (environ: NodeJS.ProcessEnv = process.env): FileCreateScope => {
    const raw = environ[SCOPE_KEY];
    if (raw === undefined || raw.trim().length === 0) return "none";
    return FileCreationPolicy.parse(raw, SCOPE_KEY);
};

const outsideRoot = (pattern: string): boolean =>
    pattern.startsWith("/") || pattern === ".." || pattern.startsWith("../") || pattern.includes("/../") || pattern.endsWith("/..");

const sourceOf = (definition: MembersDefinition): MembersSource =>
    definition.provenance?.kind === "model-proposal" ? "model" : "members";

const rowOf = (definition: MembersDefinition): OverlayRow => ({
    effect: isExclusion(definition.glob) ? "exclude" : "include",
    glob: patternOf(definition.glob),
    source: sourceOf(definition),
});

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const sample = (paths: readonly string[]): string => (paths.length === 0 ? "" : `: ${paths.slice(0, SAMPLE).join(", ")}${paths.length > SAMPLE ? ", …" : ""}`);

const resolutionOf = (definition: MembersDefinition, overlay: OverlayResolution | null): MembersResolution => {
    const { effect, glob: pattern } = rowOf(definition);
    if (overlay === null) return { effect, pattern, matched: 0, files: [], ignored: 0 };
    if (effect === "exclude") {
        const files = overlay.excluded.filter((path) => matchesGlob(path, pattern));
        return { effect, pattern, matched: files.length, files: files.slice(0, SAMPLE), ignored: 0 };
    }
    const members = new Set(overlay.members);
    const files = (overlay.scans.get(pattern) ?? []).filter((path) => members.has(path));
    const ignored = overlay.masked.filter((path) => matchesGlob(path, pattern)).length;
    return { effect, pattern, matched: files.length, files: files.slice(0, SAMPLE), ignored };
};

// {§members-projection} — each enabled definition is one generated document under
// `worker://~/_plurnk/members/`, surveyed at turn 0 like every family's enabled definitions:
// what the glob is, whose it is, and what it resolved to.
const membersDocument = (alias: string, definition: MembersDefinition, resolution: MembersResolution): { pathname: string; content: string } => {
    const noun = resolution.effect === "exclude" ? "member" : "file";
    const ignored = resolution.ignored > 0 ? ` (${count(resolution.ignored, "match")} ignored)` : "";
    const kind = definition.provenance?.kind ?? "client-action";
    const source = definition.provenance?.source === undefined ? "" : ` (${definition.provenance.source})`;
    const listed = resolution.files.map((file) => `\`${file}\``).join(", ") + (resolution.matched > resolution.files.length ? ", …" : "");
    return {
        pathname: `/members/${alias}.md`,
        content: [
            `# ${alias}`,
            "",
            "## Summary",
            "",
            `${resolution.effect} \`${resolution.pattern}\` → ${count(resolution.matched, noun)}${ignored}`,
            "",
            "| Field | Value |",
            "| --- | --- |",
            `| definition | \`${JSON.stringify({ glob: definition.glob })}\` |`,
            `| origin | ${kind === "service-configuration" ? "service" : "worker"} |`,
            `| provenance | ${kind}${source} |`,
            ...(resolution.files.length === 0 ? [] : ["", `${resolution.effect === "exclude" ? "Excluded" : "Included"}: ${listed}`]),
            "",
        ].join("\n"),
    };
};

const isFile = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isFile();
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw cause;
    }
};

export default class MembersFunctionality implements FunctionalityAdapter {
    readonly family = MEMBERS_FAMILY;
    readonly namespaceOwner = MEMBERS_OWNER;
    readonly summary = "Manage this Worker's file membership: list, discover, add, enable, disable, remove.";
    readonly definitionSchema = DEFINITION;
    readonly example = { alias: "docs", definition: { glob: "docs/**" } };
    readonly discovery = {
        signature: '{"query": string}',
        details: "A path answers why it is or is not visible — tracked, included by which pattern, a creation record, excluded by which `!glob`, ignored, untracked, or absent. A glob (or `!glob`) previews what `add` would include or exclude. Names only; nothing is added.",
    };
    readonly #db: Db;
    readonly #engine: () => Engine;
    readonly #env: NodeJS.ProcessEnv;

    constructor({ db, engine, environ = process.env }: { db: Db; engine: () => Engine; environ?: NodeJS.ProcessEnv }) {
        this.#db = db;
        this.#engine = engine;
        this.#env = environ;
    }

    async available(): Promise<readonly FunctionalityServiceDefinition[]> {
        return serviceMembers(this.#env);
    }

    // Introspection, never a catalog: a path answers why it is or is not visible; a glob previews
    // what `add` would resolve to. Names only, never content.
    async discover(query: FunctionalityDiscoverQuery, identity: WorkerCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        const raw = typeof query.query === "string" ? query.query : typeof query.source === "string" ? query.source : "";
        const glob = raw.trim();
        if (patternOf(glob).length === 0) {
            throw refuse("query-required", 400, "discover takes a path or a glob.", { recovery: "Supply { \"query\": \"<path or glob>\" }." });
        }
        const overlay = await GitMembership.resolveOverlay(this.#db, identity.workspaceId, undefined, undefined);
        if (overlay === null) {
            throw refuse("headless", 409, "The workspace has no project root, so there are no file members.", { recovery: "Open the workspace on a project root." });
        }
        return [isExclusion(glob) || PATTERN_CHARACTERS.test(glob)
            ? await this.#preview(glob, overlay, identity.workspaceId)
            : await this.#verdict(glob, overlay, identity.workspaceId)];
    }

    async #preview(glob: string, overlay: OverlayResolution, workspaceId: number): Promise<FunctionalityCandidate> {
        const pattern = patternOf(glob);
        const candidate = { alias: aliasOf(glob), definition: { glob }, provenance: { kind: "preview", source: glob } };
        if (isExclusion(glob)) {
            const excluded = overlay.members.filter((path) => matchesGlob(path, pattern));
            return { ...candidate, summary: `would exclude ${count(excluded.length, "member")}${sample(excluded)}` };
        }
        const matched = await GitMembership.scanPattern(overlay.root, pattern, undefined);
        const members = new Set(overlay.members);
        const fresh = matched.filter((path) => !members.has(path));
        const ignored = await GitMembership.ignoredSubset(this.#db, workspaceId, fresh, undefined);
        return {
            ...candidate,
            summary: `would include ${count(fresh.length, "file")} (${matched.length - fresh.length} already members, ${ignored.size} ignored — a model definition cannot include those)${sample(fresh)}`,
        };
    }

    async #verdict(key: string, overlay: OverlayResolution, workspaceId: number): Promise<FunctionalityCandidate> {
        const candidate = { alias: aliasOf(key), definition: { glob: key } };
        if (!(await isFile(resolve(overlay.root, key)))) {
            return { ...candidate, provenance: { kind: "absent", source: key }, summary: "absent — no such file under the project root" };
        }
        if (overlay.members.includes(key)) {
            const definition = [...overlay.scans].find(([, paths]) => paths.includes(key))?.[0];
            const via = overlay.tracked.has(key)
                ? "tracked by git"
                : definition !== undefined ? `included by \`${definition}\`` : "a creation record: plurnk wrote it";
            return { ...candidate, provenance: { kind: "member", source: key }, summary: `member — ${via}` };
        }
        const exclusion = overlay.excludeGlobs.find((pattern) => matchesGlob(key, pattern));
        if (exclusion !== undefined) {
            return { ...candidate, provenance: { kind: "excluded", source: key }, summary: `not a member — excluded by \`!${exclusion}\`` };
        }
        if ((await GitMembership.isIgnored(this.#db, workspaceId, key, undefined)) === true) {
            return {
                ...candidate,
                provenance: { kind: "ignored", source: key },
                summary: "not a member — the repository ignores it; a client or operator definition can include it, a model definition cannot",
            };
        }
        return { ...candidate, provenance: { kind: "candidate", source: key }, summary: "not a member — untracked; add this definition to include it" };
    }

    async admit(input: unknown, identity: WorkerCapabilityIdentity, caller: FunctionalityCaller = "action"): Promise<FunctionalityDefinitionSource> {
        const { alias, definition } = input as { alias?: unknown; definition?: unknown };
        const validation = Validator.validateJsonSchemaInstance(DEFINITION, definition);
        if (!validation.valid) {
            throw refuse("definition-invalid", 400, "A members definition is { glob }: a gitignore-style pattern, `!glob` to exclude.", {
                errors: validation.errors,
                recovery: "Supply { \"alias\": \"<name>\", \"definition\": { \"glob\": \"<pattern>\" } }.",
            });
        }
        const glob = (definition as MembersDefinition).glob.trim();
        const pattern = patternOf(glob);
        if (pattern.length === 0) {
            throw refuse("definition-invalid", 400, "A members glob names a pattern; `!` alone excludes nothing.", {
                recovery: "Supply a pattern such as `docs/**` or `!**/*.lock`.",
            });
        }
        if (caller === "operation") {
            const settings = await WorkspaceSettings.read(this.#db, identity.workspaceId);
            const scope = FileCreationPolicy.effective(modelScope(this.#env), settings.membersModelScope);
            if (!FileCreationPolicy.admits(scope, outsideRoot(pattern))) {
                throw refuse("model-scope", 403, scope === "none"
                    ? "The model may not change membership here: the members scope is none."
                    : `The effective members scope '${scope}' does not admit '${glob}'.`, {
                    scope,
                    glob,
                    recovery: "`git add` the file so git tracks it, or ask the operator to add it (/members add) or raise PLURNK_SERVICE_MEMBERS_MODEL_SCOPE.",
                });
            }
        }
        return {
            alias: typeof alias === "string" && alias.length > 0 ? alias : aliasOf(glob),
            definition: {
                glob,
                provenance: { kind: caller === "operation" ? "model-proposal" : "client-action" },
            } satisfies MembersDefinition,
        };
    }

    // {§members-projection} — the workspace overlay is the union of every worker's enabled
    // definitions (ruling (a)): inclusions union, an exclusion wins in resolution, and a
    // human-authored row outranks a model-proposed row for the same pattern. Each definition's
    // outcome carries what it resolved to, so the model sees what its glob did.
    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const { workspaceId, workerId, enabled } = preparation;
        const rows = await this.#projection(workspaceId, workerId, enabled);
        const overlay = await GitMembership.resolveOverlay(this.#db, workspaceId, rows, undefined);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const documents: Array<{ pathname: string; content: string }> = [];
        for (const [alias, definition] of enabled) {
            const resolution = resolutionOf(definition as MembersDefinition, overlay);
            outcomes.set(alias, { state: "active", detail: resolution });
            documents.push(membersDocument(alias, definition as MembersDefinition, resolution));
        }
        return {
            runtimes: [],
            documents,
            outcomes,
            snapshot: { workspaceId, rows },
            commit: async () => { await this.#apply(workspaceId, rows); },
            abort: async () => {},
        };
    }

    async teardown(): Promise<void> {
        // Desired state is durable; the overlay keeps reflecting it after a Worker cools.
    }

    async #projection(workspaceId: number, workerId: number, enabled: ReadonlyMap<string, object>): Promise<OverlayRow[]> {
        const rows = new Map<string, OverlayRow>();
        const admit = (definition: MembersDefinition): void => {
            const row = rowOf(definition);
            const key = `${row.effect} ${row.glob}`;
            const current = rows.get(key);
            if (current === undefined || (current.source === "model" && row.source === "members")) rows.set(key, row);
        };
        for (const definition of enabled.values()) admit(definition as MembersDefinition);
        const service = new Map((await this.available()).map((entry) => [entry.alias, entry]));
        const states = await this.#db.worker_module_states_by_workspace.all<{ worker_id: number; state: string | null }>({
            workspace_id: workspaceId,
            namespace_owner: MEMBERS_OWNER,
        });
        for (const { worker_id, state } of states) {
            if (worker_id === workerId) continue;
            const records = state === null ? {} : ((JSON.parse(state) as { definitions?: Record<string, StateRecord> }).definitions ?? {});
            for (const [alias, entry] of service) {
                const record = records[alias];
                const on = record?.origin === "service" ? record.enabled : entry.enabled;
                if (on) admit(entry.definition as MembersDefinition);
            }
            for (const record of Object.values(records)) {
                if (record.origin === "worker" && record.enabled && record.definition !== undefined) admit(record.definition);
            }
        }
        return [...rows.values()];
    }

    async #apply(workspaceId: number, rows: readonly OverlayRow[]): Promise<void> {
        await this.#db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
        for (const { effect, glob, source } of rows) {
            await this.#db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect, glob, source });
        }
        await GitMembership.resolveGitMembership(this.#db, workspaceId, undefined);
        void this.#engine().warmWorkspaceDerivations(workspaceId).catch(() => {});
    }
}
