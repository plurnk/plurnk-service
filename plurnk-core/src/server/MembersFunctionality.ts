// {§members-functionality} — file membership as one workspace Functionality family. The model, the
// client, and the operator learn one surface (list | discover | add | enable | disable | remove)
// for what the model may see, exactly as they do for skills and MCP servers. A definition is one
// gitignore-style glob and `!glob` excludes; definitions are workspace desired state and the
// membership overlay is their projection ({§members-projection}) — the one truth every worker sees
// ({§membership-baseline}). A model's `add` is admitted against the service ceiling
// `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` (none < root < namespace) narrowed by the workspace.
import { stat } from "node:fs/promises";
import { matchesGlob, resolve } from "node:path";
import { Validator, type FunctionalityCandidate, type FunctionalityDiscoverQuery, type JsonSchema } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { ConfigurationError, Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type Engine from "../core/Engine.ts";
import FileCreationPolicy, { type FileCreateScope } from "../core/file-creation-policy.ts";
import GitMembership, { type OverlayResolution, type OverlayRow } from "../core/git-membership.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import Paths from "../Paths.ts";
import type {
    FunctionalityCaller,
    FunctionalityDefinitionSource,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";

const MEMBERS_FAMILY = "members";
const MEMBERS_OWNER = "@plurnk/plurnk-core/members";
const PREFIX = "PLURNK_MEMBERS_";
const SCOPE_KEY = "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE";
const ALIAS = /^[a-z][a-z0-9-]*$/u;
const PATTERN_CHARACTERS = /[*?[\]{}]/u;
const sampleSize = (): number => Knob.integer("PLURNK_SERVICE_MEMBERS_SAMPLE", 0);

type MembersProvenance = {
    readonly kind: "service-configuration" | "client-action" | "model-proposal";
};
type MembersDefinition = {
    readonly glob: string;
    readonly provenance?: MembersProvenance;
};
type MembersSource = "members" | "model";
// What one definition resolved to on disk: the members it admits or removes, and — for a model's
// inclusion — the matches the repository's ignore rules refused.
type MembersResolution = {
    readonly effect: "include" | "exclude";
    readonly pattern: string;
    readonly matched: number;
    readonly files: readonly string[];
    readonly ignored: number;
};

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

const isExclusion = (glob: string): boolean => glob.startsWith("!");
const patternOf = (glob: string): string => (isExclusion(glob) ? glob.slice(1) : glob);

// A glob as an alias suggestion: `docs/**` → `docs`, `!**/tokenizer.json` → `no-tokenizer-json`.
export const aliasOf = (glob: string): string => {
    const folded = patternOf(glob).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
    const base = ALIAS.test(folded) ? folded : `p-${folded}`.replace(/-+$/u, "");
    return isExclusion(glob) ? `no-${base}` : base;
};

// {§members-configuration}
export const serviceMembers = (environ: NodeJS.ProcessEnv = process.env): FunctionalityServiceDefinition[] => {
    const environment = new ResourceEnvironment(PREFIX, { controls: [], settings: [] }, environ);
    return [...environment.definitions].map(([alias, { key, value }]) => {
        const glob = value.trim();
        if (!ALIAS.test(alias)) throw new ConfigurationError(key, `${key} names an invalid members alias '${alias}'.`);
        if (patternOf(glob).length === 0) throw new ConfigurationError(key, `${key} names no pattern.`);
        return {
            alias,
            definition: { glob, provenance: { kind: "service-configuration" } } satisfies MembersDefinition,
            enabled: environment.enabled(alias),
            provenance: { kind: "environment", source: key },
        };
    });
};

// {§members-model-scope} — the ceiling a model's `add` is admitted against. The panel states it;
// an unset or empty key is a broken deployment and fails by name, never a quiet `none`.
export const modelScope = (environ: NodeJS.ProcessEnv = process.env): FileCreateScope =>
    FileCreationPolicy.parse(environ[SCOPE_KEY], SCOPE_KEY);

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
const sample = (paths: readonly string[]): string => (paths.length === 0 ? "" : `: ${paths.slice(0, sampleSize()).join(", ")}${paths.length > sampleSize() ? ", …" : ""}`);

const resolutionOf = (definition: MembersDefinition, overlay: OverlayResolution | null): MembersResolution => {
    const { effect, glob: pattern } = rowOf(definition);
    if (overlay === null) return { effect, pattern, matched: 0, files: [], ignored: 0 };
    if (effect === "exclude") {
        const files = overlay.excluded.filter((path) => matchesGlob(path, pattern));
        return { effect, pattern, matched: files.length, files: files.slice(0, sampleSize()), ignored: 0 };
    }
    const members = new Set(overlay.members);
    const files = (overlay.scans.get(pattern) ?? []).filter((path) => members.has(path));
    const ignored = overlay.masked.filter((path) => matchesGlob(path, pattern)).length;
    return { effect, pattern, matched: files.length, files: files.slice(0, sampleSize()), ignored };
};

// {§members-projection} — each enabled definition is one generated document under
// `worker:///_plurnk/members/`, surveyed at turn 0 like every family's enabled definitions:
// what the glob is, whose it is, and what it resolved to.
const membersDocument = (alias: string, definition: MembersDefinition, resolution: MembersResolution): { pathname: string; content: string } => {
    const noun = resolution.effect === "exclude" ? "member" : "file";
    const ignored = resolution.ignored > 0 ? ` (${count(resolution.ignored, "match")} ignored)` : "";
    const kind = definition.provenance?.kind ?? "client-action";
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
            `| origin | ${kind === "service-configuration" ? "service" : "workspace"} |`,
            `| provenance | ${kind} |`,
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
    readonly summary = "Manage file membership";
    readonly definitionSchema = DEFINITION;
    readonly example = { alias: "docs", definition: { glob: "docs/**" } };
    readonly docsDir = Paths.packageRoot;
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query"],
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
    async discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        const raw = query.query!;
        const glob = raw.trim();
        if (patternOf(glob).length === 0) {
            throw refuse("query-invalid", 400, `'${raw}' names no path or pattern.`, {
                recovery: "Supply a path such as `docs/guide.md` or a pattern such as `docs/**`.",
            });
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

    async admit(input: unknown, identity: WorkspaceCapabilityIdentity, caller: FunctionalityCaller = "action"): Promise<FunctionalityDefinitionSource> {
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

    // {§members-projection} — project this workspace's enabled definitions:
    // inclusions union, an exclusion wins in resolution, and a
    // human-authored row outranks a model-proposed row for the same pattern. Each definition's
    // outcome carries what it resolved to, so the model sees what its glob did.
    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const { workspaceId, enabled } = preparation;
        const rows = this.#projection(enabled);
        const overlay = await GitMembership.resolveOverlay(this.#db, workspaceId, rows, undefined);
        const outcomes = new Map<string, FunctionalityOutcome>();
        const documents: Array<{ pathname: string; content: string }> = [];
        for (const [alias, { definition }] of enabled) {
            const resolution = resolutionOf(definition as MembersDefinition, overlay);
            outcomes.set(alias, { state: "active", detail: resolution });
            documents.push(membersDocument(alias, definition as MembersDefinition, resolution));
        }
        return {
            documents,
            outcomes,
            snapshot: { workspaceId, rows },
            commit: async () => { await this.#apply(workspaceId, rows); },
            abort: async () => {},
        };
    }

    async teardown(): Promise<void> {
        // Desired state is durable; the overlay keeps reflecting it after the workspace cools.
    }

    #projection(enabled: FunctionalityPreparation["enabled"]): OverlayRow[] {
        const rows = new Map<string, OverlayRow>();
        const admit = (definition: MembersDefinition): void => {
            const row = rowOf(definition);
            const key = `${row.effect}\0${row.glob}`;
            const current = rows.get(key);
            if (current === undefined || (current.source === "model" && row.source === "members")) rows.set(key, row);
        };
        for (const { definition } of enabled.values()) admit(definition as MembersDefinition);
        return [...rows.values()];
    }

    async #apply(workspaceId: number, rows: readonly OverlayRow[]): Promise<void> {
        await this.#db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
        if (rows.length > 0) {
            await this.#db.crud_insert_family_workspace_constraints.run({
                workspace_id: workspaceId,
                rows: JSON.stringify(rows.map(({ effect, glob, source }) => ({ effect, glob, source }))),
            });
        }
        // One owner reconciles membership after a constraint change: the workspace warm, which
        // coalesces with any pass already in flight and rescans once more after it — a detached
        // pass that read the previous rows can no longer land its stale resolution last.
        await this.#engine().warmWorkspaceDerivations(workspaceId);
    }
}
