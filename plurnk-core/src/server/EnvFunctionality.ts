// {§workspace-env} {§env-functionality} — workspace defaults and worker overrides
// compose through one family; lifecycle verbs and persistence belong to the coordinator.
import { isRecord } from "@plurnk/plurnk-contracts";
import type {
    FunctionalityCandidate,
    FunctionalityDefinitionSource,
    FunctionalityDiscoverQuery,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    JsonSchema,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { FunctionalityAdapter, FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import { MetadataOptions, type RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import EnvCatalog from "../core/env-catalog.ts";
import EnvDefaults, { type EnvDefaultsFile } from "../core/env-defaults.ts";
import type HostPaths from "../core/HostPaths.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import ExecEnv from "../schemes/exec-env.ts";
import Paths from "../Paths.ts";
import type { Db } from "../core/Db.ts";

const ENV_FAMILY = "env";
// The family's namespace owner — also the key a spawn reads its Worker's state under.
export const ENV_OWNER = "@plurnk/plurnk-service";

// A refusal is the verb's own operation result, the shape both projections convert; anything else
// thrown here would surface as a fault of the action or the manager rather than as the outcome.
const actionError = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): OperationFailureError =>
    new OperationFailureError(
        Results.failure("env:functionality", code, status, detail, {}, { family: ENV_FAMILY, retryable: false, ...extensions }),
    );

// {§exec-env-scoped} The family and invocation modifier share the same reservation.
const reservedNameError = (alias: string): OperationFailureError => actionError("name-reserved", 400,
    `'${alias}' is reserved in env entries and invocation overrides.`, {
        alias,
        recovery: "READ worker:///_plurnk/plurnk/env.md for supported configuration paths.",
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
    // {§env-scheme} — the registry as this family's own address space, env:///NAME.
    readonly scheme: RuntimeSchemeFacet | undefined;
    readonly family = ENV_FAMILY;
    readonly namespaceOwner = ENV_OWNER;
    readonly summary = "Read and shape the environment your commands run in";
    readonly definitionSchema = DEFINITION;
    readonly scopes = ["worker", "workspace"] as const;
    readonly aliasPattern = NAME;
    readonly docsDir = Paths.packageRoot;
    readonly example = { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } };
    // {§env-functionality} A client's own environment is no input: it would bypass the operator's ceiling.
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["query", "source"],
        emptyListsAll: true,
        details: "`discover` is this installation's configuration catalog: every name an installed "
            + "package declares that you may set, with the declaring package as provenance and its own "
            + "comment as the summary; plurnk's own names never appear. `query` matches a name or the "
            + "comment that documents it; `source` selects one owning package; an empty body is the "
            + "whole catalog, which is short — start there. It is how you learn which names have a "
            + "consumer, and how you learn the name of a value only the operator can supply. "
            + "READ a dotenv file; set its variables with `add` or `EDIT (env:///NAME)`.",
    };

    readonly #defaults: () => Promise<readonly EnvDefaultsFile[]>;
    readonly #hostPaths: HostPaths | undefined;

    constructor(defaults: () => Promise<readonly EnvDefaultsFile[]>, scheme?: RuntimeSchemeFacet, hostPaths?: HostPaths) {
        this.#defaults = defaults;
        this.scheme = scheme;
        this.#hostPaths = hostPaths;
    }

    // Service origin: every ambient name the operator's ceiling admits, exactly as a
    // service-declared MCP server is a service definition. A Worker may disable one for itself
    // — that is how `CI=1` goes away for one Worker without the operator changing anything.
    //
    // Values are projected because the ceiling is the security boundary, not this projection:
    // anything admitted is already readable by any command the Worker runs. Withholding it here
    // would be theatre, and would make `list` lie about the environment its commands see.
    async available(_identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition<EnvDefinition>[]> {
        return Object.entries(ExecEnv.scoped(process.env, this.#hostPaths))
            .map(([alias, value]) => ({
                alias, definition: { value: value ?? "" }, enabled: true,
                provenance: { kind: "environment", source: alias },
            }))
            .toSorted((left, right) => left.alias.localeCompare(right.alias));
    }

    async discover(query: FunctionalityDiscoverQuery, _identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        // The catalog is filtered to what a Worker may set (#586, the converged shape): plurnk's own
        // configuration and provider credential names are the operator's, refused by `add`, and would
        // only bury the few names that matter under the operator's knobs.
        const reserved = ExecEnv.ownSecretTest();
        const files = await this.#defaults();
        if (query.source !== undefined && !files.some(({ owner }) => owner === query.source)) {
            throw actionError("source-unknown", 400, `'${query.source}' is not a package in the configuration catalog.`, {
                source: query.source,
                recovery: "Omit source to list the catalog. READ files; set variables with add or EDIT (env:///NAME).",
            });
        }
        return EnvCatalog.candidates(files, {
            ...(query.query === undefined ? {} : { query: query.query }),
            ...(query.source === undefined ? {} : { source: query.source }),
        }).filter(({ alias }) => !reserved(alias));
    }

    async admit(input: unknown, _identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource<EnvDefinition>> {
        const record: Readonly<Record<string, unknown>> = isRecord(input) ? input : {};
        const alias = typeof record.alias === "string" ? record.alias : "";
        if (!NAME.test(alias)) {
            throw actionError("name-invalid", 400,
                `'${alias}' is not a name a shell can export.`, { retryable: false });
        }
        if (ExecEnv.ownSecretTest()(alias)) throw reservedNameError(alias);
        const { definition } = record;
        if (!isRecord(definition) || typeof definition.value !== "string") {
            throw actionError("value-invalid", 400, `'${alias}' needs a string value.`, { retryable: false });
        }
        return { alias, definition: { value: definition.value } };
    }

    // Nothing is launched, so nothing can fail to launch: every enabled definition is active and
    // there is no snapshot to tear down. The environment is read at the spawn that uses it
    // ({§exec-env-scoped}), never held resident — which is why this family publishes no runtimes.
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

    static defaultsReader(projectRoot: string, installedNodeModules: string, hostPaths?: HostPaths): () => Promise<readonly EnvDefaultsFile[]> {
        let cached: readonly EnvDefaultsFile[] | undefined;
        return async () => cached ??= (await EnvDefaults.collect(
            projectRoot,
            installedNodeModules,
            hostPaths === undefined ? {} : { hostPaths },
        )).files;
    }

    // {§workspace-env} Apply one persisted layer and record the provenance beside its values.
    static compose(
        ambient: NodeJS.ProcessEnv,
        state: unknown,
        modifier: Readonly<Record<string, string>> = {},
        scope: "worker" | "workspace" = "worker",
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
            if (entry.origin === "service" || (scope === "worker" && entry.origin === "workspace")) continue;
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
        // {§env-option} — the op's own environment, nearest the spawn; admitted by name already.
        for (const [name, value] of Object.entries(modifier)) {
            reserved ??= ExecEnv.ownSecretTest();
            if (reserved(name)) throw new Error(`env modifier names plurnk's own '${name}' past admission`);
            env[name] = value;
            record[name] = { source: "modifier", value };
        }
        for (const [name, value] of Object.entries(env)) {
            if (record[name] === undefined && value !== undefined) record[name] = { source: "host", value };
        }
        return { env, record };
    }

    // {§workspace-env} Both execution and capability startup read these same persisted layers.
    static async workspace(db: Db, workspaceId: number, hostPaths?: HostPaths): Promise<(ambient?: NodeJS.ProcessEnv) => { env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> }> {
        const row = await db.workspace_module_state_get.get<{ state: string }>({ workspace_id: workspaceId, namespace_owner: ENV_OWNER });
        const state: unknown = row === undefined ? { version: 1, definitions: {} } : JSON.parse(row.state);
        return (ambient = ExecEnv.scoped(process.env, hostPaths)) => this.compose(ambient, state, {}, "workspace");
    }

    static async resolve(
        db: Db,
        workspaceId: number,
        workerId?: number,
        modifier: Readonly<Record<string, string>> = {},
        ambient?: NodeJS.ProcessEnv,
        hostPaths?: HostPaths,
    ): Promise<{ env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> }> {
        const empty = { version: 1, definitions: {} };
        const shared = (await this.workspace(db, workspaceId, hostPaths))(ambient ?? ExecEnv.scoped(process.env, hostPaths));
        const worker = workerId === undefined ? undefined : await db.worker_module_state_get.get<{ state: string }>({ worker_id: workerId, namespace_owner: ENV_OWNER });
        const result = this.compose(shared.env, worker === undefined ? empty : JSON.parse(worker.state), modifier);
        return { env: result.env, record: { ...shared.record, ...Object.fromEntries(Object.entries(result.record).filter(([, item]) => item.source !== "host")) } };
    }

    // {§env-option} — the heading's `env` option, read through the one metadata reader and admitted
    // by the family's own rules: an object of string values under names a shell can export, never
    // plurnk's own. A refusal names the key and the reason, so the model learns why, exactly as `add`
    // refuses. A block that is not the array shape carries no `env` for the service to read: it is
    // the invoked executor's to accept or refuse ({§scheme-metadata-modifier}), as `pattern` is
    // lifted only from a block that parses.
    static modifier(metadata: readonly string[] | null | undefined, source = "env:functionality"): Readonly<Record<string, string>> {
        const read = MetadataOptions.parse(metadata, source);
        if ("failure" in read) return Object.freeze({});
        return EnvFunctionality.environment(read.env);
    }

    static environment(raw: unknown): Readonly<Record<string, string>> {
        if (raw === undefined) return Object.freeze({});
        if (!isRecord(raw)) throw actionError("env-invalid", 400, "`env` must be an object of string values.", { retryable: false });
        const reserved = ExecEnv.ownSecretTest();
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(raw)) {
            if (!NAME.test(name)) throw actionError("name-invalid", 400, `'${name}' is not a name a shell can export.`, { alias: name, retryable: false });
            if (reserved(name)) throw reservedNameError(name);
            if (typeof value !== "string") throw actionError("value-invalid", 400, `'${name}' needs a string value.`, { alias: name, retryable: false });
            out[name] = value;
        }
        return Object.freeze(out);
    }
}

// One name's provenance in a spawn's environment ({§exec-env-scoped}): the host through the
// ceiling, this Worker's own value (`from` names an ancestor when it was inherited), the op's own
// modifier ({§env-option}), or a name withheld — by this Worker, by the ancestor named, or by the
// invariant.
export interface EnvRecord {
    readonly source: "host" | "workspace" | "worker" | "modifier" | "masked";
    readonly from?: string;
    readonly value?: string;
}
