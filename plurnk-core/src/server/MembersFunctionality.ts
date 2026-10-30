// {§tools-resource-materialization} — file membership as one workspace Functionality family. The model, the
// client, and the operator learn one surface ({§functionality-coordinator})
// for what the model may see, exactly as they do for skills and MCP servers. A definition is one
// shell-path glob, `!glob` excludes, and the glob is the definition's identity
// ({§functionality-replacement}): `add` names globs; enable, disable and remove name one. Definitions
// are workspace desired state and the membership overlay is their projection ({§tools-resource-materialization})
// — the one truth every session sees ({§membership}). A model's `add` is admitted against
// the service ceiling `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` (none < root < namespace) narrowed by the
// workspace.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { errnoCode, PathSyntax, Problems, Validator, isRecord, type FunctionalityCandidate, type FunctionalityDiscoverQuery, type FunctionalityFamilyHandle, type JsonSchema, type FunctionalityAdmission, type FunctionalityCaller, type FunctionalityOutcome, type FunctionalityPreparation, type FunctionalityPrepared, type FunctionalityServiceDefinition, type KillStatement, type ParsedPath, type WorkspaceCapabilityIdentity } from "@plurnk/plurnk-contracts";
import { Results as SchemeResults, type EditBatchResult, type RepresentationPreparationRequest, type RepresentationPreparationResult, type ResolvedEditStatement, type RuntimeSchemeFacet, type SchemeCtx, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { Db } from "../core/Db.ts";
import { ConfigurationError, Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type Engine from "../core/Engine.ts";
import FileCreationPolicy, { type FileCreateScope } from "../core/file-creation-policy.ts";
import GitMembership, { type OverlayResolution, type OverlayRow } from "../core/git-membership.ts";
import Namespace from "../core/namespace.ts";
import AmbientMembers, { AUTO_ADD_KEY } from "../core/AmbientMembers.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import PathGlob from "../core/PathGlob.ts";
import Paths from "../Paths.ts";
import type { FunctionalityAddressing, FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";

const MEMBERS_FAMILY = "members";
const MEMBERS_OWNER = "@plurnk/plurnk-core/members";
const PREFIX = "PLURNK_MEMBERS_";
const SCOPE_KEY = "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE";
// The operator's environment alias ({§tools-resource-materialization}); a definition's own name is its glob.
const ALIAS = /^[a-z][a-z0-9-]*$/u;
// {§functionality-replacement} — the glob is the alias: one line, no surrounding whitespace.
const GLOB = /^\S(?:[^\n]*\S)?$/u;
const sampleSize = (): number => Knob.integer("PLURNK_SERVICE_MEMBERS_SAMPLE", 0);

type MembersProvenance = {
    readonly kind: "service-configuration" | "client-action" | "model-proposal";
};
type MembersDefinition = {
    readonly glob: string;
    readonly provenance?: MembersProvenance;
};
// What a preparation commits: the overlay rows its definitions project, for the workspace they belong to.
interface MembersSnapshot {
    readonly workspaceId: number;
    readonly rows: readonly OverlayRow[];
}
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

const GLOB_DESCRIPTION = "A shell-path glob relative to the project root (`docs/**`, `*.md`, `../shared/*.json`). A leading `!` excludes matching members; an exclusion wins over every inclusion.";

// {§functionality-replacement} — what `add` takes: the globs, each one definition.
const ADD: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["files"],
    properties: {
        files: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1, description: GLOB_DESCRIPTION },
            description: "The globs to add; each is one definition.",
        },
    },
});

// What enable, disable and remove take: one definition's glob, as `list` shows it.
const SELECT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["file"],
    properties: {
        file: { type: "string", minLength: 1, description: "The glob of one definition, as `list` shows it." },
    },
});

// The exact definition the coordinator persists. Provenance is the coordinator's truth, never the
// caller's claim: `admit` stamps it from the caller.
const DEFINITION: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["glob"],
    properties: {
        glob: { type: "string", minLength: 1, description: GLOB_DESCRIPTION },
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

// {§tools-resource-materialization} — each `PLURNK_MEMBERS_<alias>=<glob>` is one service definition named by
// its glob; the environment key is its provenance. Two keys naming one glob fail by name.
export const serviceMembers = (environ: NodeJS.ProcessEnv = process.env): FunctionalityServiceDefinition<MembersDefinition>[] => {
    // {§membership-auto-add} — the family's own control is validated with its definitions, so `config
    // check` fails by name before any dispatch reads it; an absent key is the dispatch's to report.
    if (environ[AUTO_ADD_KEY] !== undefined) AmbientMembers.enabled(environ);
    const environment = new ResourceEnvironment(PREFIX, { controls: ["AUTO_ADD"], settings: [] }, environ);
    const declared = new Map<string, string>();
    return [...environment.definitions].map(([alias, { key, value }]) => {
        const glob = value.trim();
        if (!ALIAS.test(alias)) throw new ConfigurationError(key, `${key} names an invalid members alias '${alias}'.`);
        if (patternOf(glob).length === 0) throw new ConfigurationError(key, `${key} names no pattern.`);
        const earlier = declared.get(glob);
        if (earlier !== undefined) throw new ConfigurationError(key, `${key} repeats the definition '${glob}' of ${earlier}.`);
        declared.set(glob, key);
        return {
            alias: glob,
            definition: { glob, provenance: { kind: "service-configuration" } } satisfies MembersDefinition,
            enabled: environment.enabled(alias),
            provenance: { kind: "environment", source: key },
        };
    });
};

// {§tools-resource-materialization} — the ceiling a model's `add` is admitted against. The panel states it;
// an unset or empty key is a broken deployment and fails by name, never a quiet `none`.
export const modelScope = (environ: NodeJS.ProcessEnv = process.env): FileCreateScope =>
    FileCreationPolicy.parse(environ[SCOPE_KEY], SCOPE_KEY);

const outsideRoot = (pattern: string): boolean =>
    pattern.startsWith("/") || pattern === ".." || pattern.startsWith("../") || pattern.includes("/../") || pattern.endsWith("/..");

// {§tools-resource-materialization} A glob is matched against member keys, so its spelling is canonicalized as a path's is
// ({§fs-namespace}): an absolute spelling and its root-relative one name the same files. Headless, it stays as written.
const keyPattern = (pattern: string, root: string | null): string => (root === null ? null : Namespace.canonicalize(pattern, root)) ?? pattern;

const sourceOf = (definition: MembersDefinition): MembersSource =>
    definition.provenance?.kind === "model-proposal" ? "model" : "members";

const rowOf = (definition: MembersDefinition, root: string | null): OverlayRow => ({
    effect: isExclusion(definition.glob) ? "exclude" : "include",
    glob: keyPattern(patternOf(definition.glob), root),
    source: sourceOf(definition),
});

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const sample = (paths: readonly string[]): string => (paths.length === 0 ? "" : `: ${paths.slice(0, sampleSize()).join(", ")}${paths.length > sampleSize() ? ", …" : ""}`);

const resolutionOf = (definition: MembersDefinition, overlay: OverlayResolution | null): MembersResolution => {
    const { effect, glob: pattern } = rowOf(definition, overlay?.root ?? null);
    if (overlay === null) return { effect, pattern, matched: 0, files: [], ignored: 0 };
    if (effect === "exclude") {
        const files = overlay.excluded.filter((path) => PathGlob.matches(path, pattern));
        return { effect, pattern, matched: files.length, files: files.slice(0, sampleSize()), ignored: 0 };
    }
    const members = new Set(overlay.members);
    const files = (overlay.scans.get(pattern) ?? []).filter((path) => members.has(path));
    const ignored = overlay.masked.filter((path) => PathGlob.matches(path, pattern)).length;
    return { effect, pattern, matched: files.length, files: files.slice(0, sampleSize()), ignored };
};

// {§tools-resource-materialization} — a definition's document is named by its glob, percent-encoded as one path
// segment: RFC 3986 unreserved characters and parentheses stay literal, everything else is `%XX`.
export const documentName = (glob: string): string =>
    encodeURIComponent(glob).replace(/[!'*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

// {§tools-resource-materialization} — each enabled definition is one generated document under
// `plurnk:///members/`: what the glob is, whose it is, and what it resolved to.
const membersDocument = (definition: MembersDefinition, resolution: MembersResolution): { pathname: string; content: string } => {
    const noun = resolution.effect === "exclude" ? "member" : "file";
    const ignored = resolution.ignored > 0 ? ` (${count(resolution.ignored, "match")} ignored)` : "";
    const kind = definition.provenance?.kind ?? "client-action";
    const listed = resolution.files.map((file) => `\`${file}\``).join(", ") + (resolution.matched > resolution.files.length ? ", …" : "");
    return {
        pathname: `/members/${documentName(definition.glob)}.md`,
        content: [
            `# \`${definition.glob}\``,
            "",
            "## Summary",
            "",
            `${resolution.effect} \`${resolution.pattern}\` → ${count(resolution.matched, noun)}${ignored}`,
            "",
            "| Field | Value |",
            "| --- | --- |",
            `| glob | \`${definition.glob}\` |`,
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
        if (errnoCode(cause) === "ENOENT") return false;
        throw cause;
    }
};

const STREAM = /^[0-9a-f]{8}$/u;
const SCHEME_OWNER = "members:resource";

const globOfPathname = (pathname: string): string | null => {
    const raw = pathname.replace(/^\//u, "");
    if (raw.length === 0 || STREAM.test(raw)) return null;
    try {
        return decodeURIComponent(raw);
    } catch {
        return null;
    }
};

class MembersResources implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]> = {
        writableBy: ["model", "client"],
    };
    readonly #handle: () => FunctionalityFamilyHandle;

    constructor(handle: () => FunctionalityFamilyHandle) {
        this.#handle = handle;
    }

    claims(pathname: string): boolean {
        return !STREAM.test(pathname.replace(/^\//u, ""));
    }

    static #named(target: ParsedPath | null): { file: string; pathname: string } | SchemeResult {
        if (target === null || target.kind !== "url" || (target.hostname ?? "") !== "") {
            return SchemeResults.failure(SCHEME_OWNER, "target-required", 400, "The operation needs a members:///<glob> target.", {}, { retryable: false });
        }
        const file = globOfPathname(target.pathname);
        if (file === null) {
            return SchemeResults.failure(SCHEME_OWNER, "not-found", 404, "The members resource does not exist.", {}, { target: target.raw, retryable: false });
        }
        return { file, pathname: target.pathname };
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        if (request.authority !== "") return SchemeResults.failure(SCHEME_OWNER, "authority-invalid", 400, "Members resources use an empty authority.");
        const file = globOfPathname(request.pathname);
        if (file === null) return SchemeResults.failure(SCHEME_OWNER, "not-found", 404, "The members resource does not exist.");
        const listing = await this.#handle().invoke("list", {}, { workspaceId: ctx.workspaceId });
        const content = Validator.assertFunctionalityListResult(listing.body).definitions.find((entry) => entry.alias === file);
        if (content === undefined) return SchemeResults.failure(SCHEME_OWNER, "not-found", 404, "The members resource does not exist.");
        const result = await ctx.entries.write(request.pathname, {
            channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } },
        });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (statement === undefined || statements.length > 1 || statement.lineMarker !== null || statement.matcher !== null) {
            return SchemeResults.failure(SCHEME_OWNER, "value-whole", 400, "One EDIT adds one members glob, whole.", {}, { retryable: false });
        }
        const named = MembersResources.#named(statement.target);
        if ("status" in named) return named;
        try {
            await this.#handle().invoke(
                "add",
                { files: [named.file] },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }

    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        if (statement.lineMarker !== null || statement.matcher !== null) {
            return SchemeResults.failure(SCHEME_OWNER, "value-whole", 400, "KILL retires the whole members definition.", {}, { retryable: false });
        }
        const named = MembersResources.#named(statement.target);
        if ("status" in named) return named;
        try {
            await this.#handle().invoke(
                "remove",
                { file: named.file },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }
}

export default class MembersFunctionality implements FunctionalityAdapter<never, RuntimeSchemeFacet, MembersDefinition, MembersSnapshot> {
    readonly scheme: RuntimeSchemeFacet | undefined;
    readonly family = MEMBERS_FAMILY;
    readonly namespaceOwner = MEMBERS_OWNER;
    readonly summary = "Manage file membership";
    readonly definitionSchema = DEFINITION;
    readonly aliasPattern = GLOB;
    readonly addressing: FunctionalityAddressing = {
        add: ADD,
        select: SELECT,
        alias: (input) => {
            if (!isRecord(input) || typeof input.file !== "string") throw new TypeError("A members select names its file.");
            return input.file.trim();
        },
    };
    readonly example = { files: ["docs/**"] };
    readonly docsDir = Paths.packageRoot;
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query"],
        details: "A path answers why it is or is not visible — tracked, included by which pattern, a creation record, excluded by which `!glob`, ignored, untracked, or absent. A glob (or `!glob`) previews what `add` would include or exclude. Names only; nothing is added.",
    };
    readonly #db: Db;
    readonly #engine: () => Engine;
    readonly #env: NodeJS.ProcessEnv;

    constructor({ db, engine, environ = process.env, handle }: { db: Db; engine: () => Engine; environ?: NodeJS.ProcessEnv; handle?: () => FunctionalityFamilyHandle }) {
        this.#db = db;
        this.#engine = engine;
        this.#env = environ;
        this.scheme = handle === undefined ? undefined : new MembersResources(handle);
    }

    async available(): Promise<readonly FunctionalityServiceDefinition<MembersDefinition>[]> {
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
        return [isExclusion(glob) || PathSyntax.hasGlob(glob)
            ? await this.#preview(glob, overlay, identity.workspaceId)
            : await this.#verdict(keyPattern(glob, overlay.root), overlay, identity.workspaceId)];
    }

    async #preview(glob: string, overlay: OverlayResolution, workspaceId: number): Promise<FunctionalityCandidate> {
        const pattern = keyPattern(patternOf(glob), overlay.root);
        const candidate = { alias: glob, definition: { glob }, provenance: { kind: "preview", source: glob } };
        if (isExclusion(glob)) {
            const excluded = overlay.members.filter((path) => PathGlob.matches(path, pattern));
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
        const candidate = { alias: key, definition: { glob: key } };
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
        const exclusion = overlay.excludeGlobs.find((pattern) => PathGlob.matches(key, pattern));
        if (exclusion !== undefined) {
            return { ...candidate, provenance: { kind: "excluded", source: key }, summary: `not a member — excluded by \`!${exclusion}\`; only the user can lift it` };
        }
        const ignoredBy = await GitMembership.ignoreSource(this.#db, workspaceId, key, undefined);
        if (ignoredBy !== null) {
            return {
                ...candidate,
                provenance: { kind: "ignored", source: key },
                // {§membership}
                summary: `not a member — git ignores it (\`${ignoredBy.file}\` line ${ignoredBy.line}); a client or operator definition can include it, a model definition cannot`,
            };
        }
        return { ...candidate, provenance: { kind: "candidate", source: key }, summary: "not a member — untracked; add this definition to include it" };
    }

    // {§functionality-replacement} — every glob the body names is admitted, or none is: a bare `!`
    // or a glob past the model's scope refuses the whole add. The same glob twice is one definition.
    async admit(input: unknown, identity: WorkspaceCapabilityIdentity, caller: FunctionalityCaller = "action"): Promise<readonly FunctionalityAdmission<MembersDefinition>[]> {
        if (!isRecord(input) || !Array.isArray(input.files) || !input.files.every((file): file is string => typeof file === "string")) {
            throw new TypeError("A members add names its files.");
        }
        const { files } = input;
        const scope = caller === "operation"
            ? FileCreationPolicy.effective(modelScope(this.#env), (await WorkspaceSettings.read(this.#db, identity.workspaceId)).membersModelScope)
            : null;
        const root = scope === null ? null : await GitMembership.workspaceRoot(this.#db, identity.workspaceId);
        const admitted = new Map<string, FunctionalityAdmission<MembersDefinition>>();
        for (const raw of files) {
            const glob = raw.trim();
            const pattern = patternOf(glob);
            if (pattern.length === 0) {
                throw refuse("definition-invalid", 400, `'${raw}' names no pattern; \`!\` alone excludes nothing.`, {
                    recovery: "Name a pattern such as `docs/**` or `!**/*.lock`.",
                });
            }
            if (scope !== null && !FileCreationPolicy.admits(scope, outsideRoot(keyPattern(pattern, root)))) {
                throw refuse("model-scope", 403, scope === "none"
                    ? "The model may not change membership here: the members scope is none."
                    : `The effective members scope '${scope}' does not admit '${glob}'.`, {
                    scope,
                    glob,
                    recovery: "A client or operator definition can admit it; that is the user's to give: ask them.",
                });
            }
            admitted.set(glob, {
                alias: glob,
                definition: {
                    glob,
                    provenance: { kind: caller === "operation" ? "model-proposal" : "client-action" },
                } satisfies MembersDefinition,
            });
        }
        return [...admitted.values()];
    }

    // {§tools-resource-materialization} — project this workspace's enabled definitions:
    // inclusions union, an exclusion wins in resolution, and a
    // human-authored row outranks a model-proposed row for the same pattern. Each definition's
    // outcome carries what it resolved to, so the model sees what its glob did.
    async prepare(preparation: FunctionalityPreparation<MembersDefinition, MembersSnapshot>): Promise<FunctionalityPrepared<never, MembersSnapshot>> {
        preparation.signal.throwIfAborted();
        const { workspaceId, enabled } = preparation;
        const rows = this.#projection(enabled, await GitMembership.workspaceRoot(this.#db, workspaceId));
        const overlay = await GitMembership.resolveOverlay(this.#db, workspaceId, rows, undefined);
        preparation.signal.throwIfAborted();
        const outcomes = new Map<string, FunctionalityOutcome>();
        const documents: Array<{ pathname: string; content: string }> = [];
        for (const [alias, { definition }] of enabled) {
            const resolution = resolutionOf(definition, overlay);
            outcomes.set(alias, { state: "active", detail: resolution });
            documents.push(membersDocument(definition, resolution));
        }
        return {
            documents,
            outcomes,
            snapshot: { workspaceId, rows },
            publish: () => undefined,
            commit: async () => { await this.#apply(workspaceId, rows); },
            abort: async () => {},
        };
    }

    async teardown(): Promise<void> {
        // Desired state is durable; the overlay keeps reflecting it after the workspace cools.
    }

    #projection(enabled: FunctionalityPreparation<MembersDefinition>["enabled"], root: string | null): OverlayRow[] {
        const rows = new Map<string, OverlayRow>();
        const admit = (definition: MembersDefinition): void => {
            const row = rowOf(definition, root);
            const key = `${row.effect}\0${row.glob}`;
            const current = rows.get(key);
            if (current === undefined || (current.source === "model" && row.source === "members")) rows.set(key, row);
        };
        for (const { definition } of enabled.values()) admit(definition);
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
