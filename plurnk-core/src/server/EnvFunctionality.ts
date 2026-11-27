// {§execution-output-identity} {§env-functionality} — workspace defaults and session overrides
// compose through one family; lifecycle verbs and persistence belong to the coordinator.
import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import type {
    FunctionalityCandidate,
    FunctionalityDefinitionSource,
    FunctionalityDiscoverQuery,
    FunctionalityIdentity,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityProvenance,
    FunctionalityServiceDefinition,
    JsonSchema,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import { type RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import EnvCatalog from "../core/env-catalog.ts";
import EnvDefaults, { type EnvDefaultsFile } from "../core/env-defaults.ts";
import HostPaths from "../core/HostPaths.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import ExecEnv from "../schemes/exec-env.ts";
import Paths from "../Paths.ts";
import type { Db } from "../core/Db.ts";
import { agentRootScopes, workspacePaths } from "./AgentRoots.ts";

const ENV_FAMILY = "env";
// The family's namespace owner — also the key a spawn reads its Session's state under.
export const ENV_OWNER = "@plurnk/plurnk-service";

// A refusal is the verb's own operation result, the shape both projections convert; anything else
// thrown here would surface as a fault of the action or the manager rather than as the outcome.
const actionError = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): OperationFailureError =>
    new OperationFailureError(
        Results.failure("env:functionality", code, status, detail, {}, { family: ENV_FAMILY, retryable: false, ...extensions }),
    );

// {§execution-output-identity} The family reserves Plurnk configuration and provider credentials.
const reservedNameError = (alias: string): OperationFailureError => actionError("name-reserved", 400,
    `'${alias}' is reserved in env entries.`, {
        alias,
        recovery: "read mcp:///plurnk/env.json for supported configuration paths.",
    });

// POSIX-ish, and deliberately narrow: a name the shell can actually export. This is the family's
// alias grammar ({§functionality-adapter}) — the alias IS the variable name, and case is semantic.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// One variable. The alias IS the name, so the definition carries only what the name does not.
interface EnvDefinition {
    readonly value: string;
}
const DEFINITION: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
        value: { type: "string", description: "The exact value, used verbatim. No interpolation, no escapes." },
    },
};

export default class EnvFunctionality implements FunctionalityAdapter<never, RuntimeSchemeFacet, EnvDefinition, null> {
    // {§env-functionality} — the registry as this family's own address space, env:///NAME.
    readonly scheme: RuntimeSchemeFacet | undefined;
    readonly family = ENV_FAMILY;
    readonly namespaceOwner = ENV_OWNER;
    readonly summary = "List ({}) or manage environment variables.";
    readonly definitionSchema = DEFINITION;
    readonly scopes = ["session", "workspace", "service"] as const;
    readonly aliasPattern = NAME;
    readonly docsDir = Paths.packageRoot;
    readonly example = { alias: "CARGO_TARGET_DIR", value: "/tmp/shared" };
    // {§env-functionality} A client's own environment is no input: it would bypass the operator's ceiling.
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query", "source"],
        emptyListsAll: true,
        details: "`{\"discover\": true}` lists settable variables declared by installed packages (`PLURNK_*` excluded); `{\"discover\": \"<query>\"}` or `{\"discover\": {\"query\": \"...\", \"source\": \"...\"}}` filters by name/comment or declaring package.",
    };

    readonly #defaults: () => Promise<readonly EnvDefaultsFile[]>;
    readonly #hostPaths: HostPaths | undefined;
    readonly #db: Db | undefined;

    constructor(
        defaults: () => Promise<readonly EnvDefaultsFile[]>,
        scheme?: RuntimeSchemeFacet,
        hostPaths?: HostPaths,
        db?: Db,
    ) {
        this.#defaults = defaults;
        this.scheme = scheme;
        this.#hostPaths = hostPaths;
        this.#db = db;
    }

    static async #cascadedFileEntries(
        db: Db | undefined,
        workspaceId: number | null,
        environment: NodeJS.ProcessEnv = process.env,
        hostPaths?: HostPaths,
    ): Promise<ReadonlyArray<{ readonly alias: string; readonly value: string; readonly source: string }>> {
        let projectRoot: string | null = null;
        if (workspaceId !== null) {
            if (db === undefined) return [];
            const ws = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
            projectRoot = ws?.project_root ?? null;
        }
        let roots: ReturnType<typeof workspacePaths>["configurationRoots"];
        try {
            roots = workspacePaths(hostPaths ?? new HostPaths({ env: environment }), projectRoot, environment).configurationRoots;
        } catch (cause) {
            if (cause instanceof ConfigurationError) return [];
            throw cause;
        }
        const reserved = ExecEnv.ownSecretTest(environment);
        const merged = new Map<string, { readonly alias: string; readonly value: string; readonly source: string }>();
        // Apply farthest-to-nearest so `<project>/.agents/.env` overrides `$XDG_CONFIG_HOME/plurnk/env`,
        // which overrides `$XDG_CONFIG_HOME/agents/.env` and `~/.agents/.env`.
        for (const { scope, directory } of [...roots].toReversed()) {
            const filePath = scope === "plurnk" ? join(directory, "env") : join(directory, ".env");
            let raw: string;
            try {
                raw = await readFile(filePath, "utf8");
            } catch (cause) {
                if (errnoCode(cause) === "ENOENT") continue;
                throw cause;
            }
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseEnv yields string values
            const parsed = parseEnv(raw) as Record<string, string>;
            for (const [alias, value] of Object.entries(parsed)) {
                if (!NAME.test(alias) || reserved(alias)) continue;
                merged.set(alias, { alias, value, source: filePath });
            }
        }
        return [...merged.values()];
    }

    static async #projectExampleFile(
        db: Db | undefined,
        workspaceId: number,
        environment: NodeJS.ProcessEnv = process.env,
    ): Promise<EnvDefaultsFile | null> {
        if (db === undefined) return null;
        let projectEnabled = false;
        try {
            projectEnabled = agentRootScopes(environment).has("project");
        } catch (cause) {
            if (cause instanceof ConfigurationError) return null;
            throw cause;
        }
        if (!projectEnabled) return null;
        const ws = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        if (ws?.project_root == null) return null;
        let text: string;
        try {
            text = await readFile(join(ws.project_root, ".env.example"), "utf8");
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return null;
            throw cause;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseEnv yields string values
        const parsed = parseEnv(text) as Record<string, string>;
        return { owner: ".env.example", reference: ".env.example", text, parsed };
    }

    // Service origin: every ambient name the operator's ceiling admits plus non-reserved runtime
    // env files across PLURNK_SERVICE_ROOTS, exactly as a service-declared MCP server is a service
    // definition. A Session may disable one for itself — that is how `CI=1` goes away for one
    // Session without the operator changing anything.
    //
    // Values are projected because the ceiling is the security boundary, not this projection:
    // anything admitted is already readable by any command the Session runs. Withholding it here
    // would be theatre, and would make `list` lie about the environment its commands see.
    async available(identity: FunctionalityIdentity): Promise<readonly FunctionalityServiceDefinition<EnvDefinition>[]> {
        const merged = new Map<string, { value: string; provenance: FunctionalityProvenance }>();
        for (const [alias, value] of Object.entries(ExecEnv.scoped(process.env, this.#hostPaths))) {
            merged.set(alias, { value: value ?? "", provenance: { kind: "environment", source: alias } });
        }
        const workspaceId = identity.scope === "service" ? null : identity.workspaceId;
        for (const { alias, value, source } of await EnvFunctionality.#cascadedFileEntries(this.#db, workspaceId, process.env, this.#hostPaths)) {
            merged.set(alias, { value, provenance: { kind: "file", source } });
        }
        return [...merged.entries()]
            .map(([alias, { value, provenance }]) => ({
                alias, definition: { value }, enabled: true, provenance,
            }))
            .toSorted((left, right) => left.alias.localeCompare(right.alias));
    }

    async discover(query: FunctionalityDiscoverQuery, identity: FunctionalityIdentity): Promise<readonly FunctionalityCandidate[]> {
        // The catalog is filtered to what a Session may set (#586, the converged shape): plurnk's own
        // configuration and provider credential names are the operator's, refused by `add`, and would
        // only bury the few names that matter under the operator's knobs.
        const reserved = ExecEnv.ownSecretTest();
        const example = identity.scope === "service"
            ? null
            : await EnvFunctionality.#projectExampleFile(this.#db, identity.workspaceId, process.env);
        const files = example === null ? await this.#defaults() : [...await this.#defaults(), example];
        if (query.source !== undefined && !files.some(({ owner }) => owner === query.source)) {
            throw actionError("source-unknown", 400, `'${query.source}' is not a package in the configuration catalog.`, {
                source: query.source,
                recovery: "Omit source to list the catalog. read files; set variables with add.",
            });
        }
        return EnvCatalog.candidates(files, {
            ...(query.query === undefined ? {} : { query: query.query }),
            ...(query.source === undefined ? {} : { source: query.source }),
        }).filter(({ alias }) => !reserved(alias));
    }

    async admit(input: unknown, _identity: FunctionalityIdentity): Promise<FunctionalityDefinitionSource<EnvDefinition>> {
        const record: Readonly<Record<string, unknown>> = isRecord(input) ? input : {};
        const alias = typeof record.alias === "string" ? record.alias : "";
        if (!NAME.test(alias)) {
            throw actionError("name-invalid", 400,
                `'${alias}' is not a name a shell can export.`, { retryable: false });
        }
        if (ExecEnv.ownSecretTest()(alias)) throw reservedNameError(alias);
        if (typeof record.value !== "string") {
            throw actionError("value-invalid", 400, `'${alias}' needs a string value.`, { retryable: false });
        }
        return { alias, definition: { value: record.value } };
    }

    // Nothing is launched, so nothing can fail to launch: every enabled definition is active and
    // there is no snapshot to tear down. The environment is read at the spawn that uses it
    // ({§execution-output-identity}), never held resident — which is why this family publishes no runtimes.
    async prepare(preparation: FunctionalityPreparation<EnvDefinition, null>): Promise<FunctionalityPrepared<never, null>> {
        preparation.signal.throwIfAborted();
        const outcomes = new Map([...preparation.enabled.keys()].map((alias) => [alias, { state: "active" as const }]));
        return {
            documents: [], outcomes, snapshot: null,
            publish: () => undefined,
            commit: async () => undefined,
            abort: async () => undefined,
        };
    }

    async teardown(_snapshot: null, _identity: WorkspaceCapabilityIdentity): Promise<void> {
        return undefined;
    }

    static defaultsReader(projectRoot: string, installedNodeModules: string): () => Promise<readonly EnvDefaultsFile[]> {
        let cached: readonly EnvDefaultsFile[] | undefined;
        return async () => cached ??= await EnvDefaults.collect(projectRoot, installedNodeModules);
    }

    // {§execution-output-identity} Apply one persisted layer and record the provenance beside its values.
    static compose(
        ambient: NodeJS.ProcessEnv,
        state: unknown,
        scope: "service" | "session" | "workspace" = "session",
    ): { env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> } {
        if (!isRecord(state) || state.version !== 1 || !isRecord(state.definitions)) throw new Error("env state is not a version 1 record");
        const env: NodeJS.ProcessEnv = { ...ambient };
        const record: Record<string, EnvRecord> = {};
        let reserved: ((name: string) => boolean) | undefined;
        for (const [name, entry] of Object.entries(state.definitions)) {
            if (!isRecord(entry) || typeof entry.enabled !== "boolean") throw new Error(`env state for '${name}' is malformed`);
            const from = typeof entry.inherited === "string" ? { from: entry.inherited } : {};
            if (!entry.enabled) {
                delete env[name];
                record[name] = { source: "masked", ...from };
                continue;
            }
            if (
                entry.origin === "host"
                || (scope !== "service" && entry.origin === "service")
                || (scope === "session" && entry.origin === "workspace")
            ) continue;
            if (entry.origin !== scope) throw new Error(`env state for '${name}' has origin '${String(entry.origin)}'`);
            if (!isRecord(entry.definition) || typeof entry.definition.value !== "string") throw new Error(`env state for '${name}' holds no string value`);
            reserved ??= ExecEnv.ownSecretTest();
            if (reserved(name)) {
                record[name] = { source: "masked" };
                continue;
            }
            env[name] = entry.definition.value;
            record[name] = { source: scope, ...from, value: entry.definition.value };
        }
        for (const [name, value] of Object.entries(env)) {
            if (record[name] === undefined && value !== undefined) record[name] = { source: "host", value };
        }
        return { env, record };
    }

    // {§execution-output-identity} Service-tier runtime env overlay over an admitted ambient base
    // (host non-project env files + `service.env`, without workspace or session overrides).
    static async service(db: Db, hostPaths?: HostPaths): Promise<(ambient?: NodeJS.ProcessEnv) => { env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> }> {
        const [serviceRow, cascaded] = await Promise.all([
            db.service_module_state_get.get<{ state: string }>({ namespace_owner: ENV_OWNER }),
            this.#cascadedFileEntries(db, null, process.env, hostPaths),
        ]);
        const serviceState: unknown = serviceRow === undefined ? { version: 1, definitions: {} } : JSON.parse(serviceRow.state);
        const fileOverlay: NodeJS.ProcessEnv = Object.fromEntries(cascaded.map(({ alias, value }) => [alias, value]));
        return (ambient = ExecEnv.scoped(process.env, hostPaths)) => {
            const hostEnv: NodeJS.ProcessEnv = { ...ambient, ...fileOverlay };
            return this.compose(hostEnv, serviceState, "service");
        };
    }

    // {§execution-output-identity} Both execution and capability startup read these same persisted layers.
    static async workspace(db: Db, workspaceId: number, hostPaths?: HostPaths): Promise<(ambient?: NodeJS.ProcessEnv) => { env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> }> {
        const [serviceRow, row, cascaded] = await Promise.all([
            db.service_module_state_get.get<{ state: string }>({ namespace_owner: ENV_OWNER }),
            db.workspace_module_state_get.get<{ state: string }>({ workspace_id: workspaceId, namespace_owner: ENV_OWNER }),
            this.#cascadedFileEntries(db, workspaceId, process.env, hostPaths),
        ]);
        const serviceState: unknown = serviceRow === undefined ? { version: 1, definitions: {} } : JSON.parse(serviceRow.state);
        const workspaceState: unknown = row === undefined ? { version: 1, definitions: {} } : JSON.parse(row.state);
        const fileOverlay: NodeJS.ProcessEnv = Object.fromEntries(cascaded.map(({ alias, value }) => [alias, value]));
        return (ambient = ExecEnv.scoped(process.env, hostPaths)) => {
            const hostEnv: NodeJS.ProcessEnv = { ...ambient, ...fileOverlay };
            const serviceLayer = this.compose(hostEnv, serviceState, "service");
            const workspaceBaseEnv: NodeJS.ProcessEnv = { ...serviceLayer.env };
            const baseRecord: Record<string, EnvRecord> = { ...serviceLayer.record };
            if (isRecord(workspaceState) && isRecord(workspaceState.definitions)) {
                for (const [name, entry] of Object.entries(workspaceState.definitions)) {
                    if (
                        isRecord(entry)
                        && entry.enabled === true
                        && entry.origin === "host"
                        && hostEnv[name] !== undefined
                        && workspaceBaseEnv[name] === undefined
                    ) {
                        workspaceBaseEnv[name] = hostEnv[name];
                        baseRecord[name] = { source: "host", value: hostEnv[name] };
                    }
                }
            }
            const workspaceLayer = this.compose(workspaceBaseEnv, workspaceState, "workspace");
            return {
                env: workspaceLayer.env,
                record: {
                    ...baseRecord,
                    ...Object.fromEntries(Object.entries(workspaceLayer.record).filter(([, item]) => item.source !== "host")),
                },
            };
        };
    }

    // Explicit active session overrides (`env://<session>/NAME`): excludes inherited workspace/service values and disabled masks.
    static async sessionOverrides(
        db: Db,
        sessionId: number,
        environment: NodeJS.ProcessEnv = process.env,
    ): Promise<Readonly<Record<string, string>>> {
        const row = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: ENV_OWNER });
        if (row === undefined) return {};
        const state: unknown = JSON.parse(row.state);
        if (!isRecord(state) || state.version !== 1 || !isRecord(state.definitions)) return {};
        const reserved = ExecEnv.ownSecretTest(environment);
        const out: Record<string, string> = {};
        for (const [name, entry] of Object.entries(state.definitions)) {
            if (!isRecord(entry) || entry.enabled !== true || entry.origin !== "session") continue;
            if (!isRecord(entry.definition) || typeof entry.definition.value !== "string") continue;
            if (!NAME.test(name) || reserved(name)) continue;
            out[name] = entry.definition.value;
        }
        return out;
    }

    // Parse `$PLURNK_ENV` scratch sink assignments (`KEY=VALUE`, quoted multiline values, comments).
    static parseSink(text: string): { readonly entries: ReadonlyArray<{ readonly alias: string; readonly value: string }> } | SchemeResult {
        const meaningful = text
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
        if (meaningful.length === 0) return { entries: [] };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseEnv yields string values
        const parsed = parseEnv(text) as Record<string, string>;
        const entries = Object.entries(parsed);
        if (entries.length === 0) {
            return Results.failure("env:functionality", "value-invalid", 400,
                "PLURNK_ENV content must declare KEY=VALUE assignments.", {}, { family: ENV_FAMILY, retryable: false });
        }
        for (const [alias] of entries) {
            if (!NAME.test(alias)) {
                return Results.failure("env:functionality", "name-invalid", 400,
                    `'${alias}' in PLURNK_ENV is not a name a shell can export.`, {}, { family: ENV_FAMILY, alias, retryable: false });
            }
        }
        return { entries: entries.map(([alias, value]) => ({ alias, value })) };
    }

    static async resolve(
        db: Db,
        workspaceId: number,
        sessionId?: number,
        ambient?: NodeJS.ProcessEnv,
        hostPaths?: HostPaths,
    ): Promise<{ env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> }> {
        const empty = { version: 1, definitions: {} };
        const shared = (await this.workspace(db, workspaceId, hostPaths))(ambient ?? ExecEnv.scoped(process.env, hostPaths));
        const session = sessionId === undefined ? undefined : await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: ENV_OWNER });
        const result = this.compose(shared.env, session === undefined ? empty : JSON.parse(session.state));
        return { env: result.env, record: { ...shared.record, ...Object.fromEntries(Object.entries(result.record).filter(([, item]) => item.source !== "host")) } };
    }
}

// One name's provenance in a spawn's environment ({§execution-output-identity}): the host through the
// ceiling, this Session's own value (`from` names an ancestor when it was inherited), or a name
// withheld — by this Session, by the ancestor named, or by the invariant.
export interface EnvRecord {
    readonly source: "host" | "service" | "workspace" | "session" | "masked";
    readonly from?: string;
    readonly value?: string;
}
