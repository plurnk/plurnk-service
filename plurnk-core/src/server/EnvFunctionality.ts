// SPEC {§env-functionality} {§functionality-scope} {§exec-env-scoped} — environment as the
// fourth Functionality family, and the first whose definitions are owned by a Worker.
//
// The other families describe what EXISTS in a workspace: a skill, an MCP server, a member, an
// outbound agent. They are capabilities, and a capability belongs to the workspace that holds it.
// An environment describes how one Worker WORKS. That is context, not capability, and context
// belongs to the actor doing the work — which is the whole of what `scope: "worker"` declares.
//
// Nothing else about the family is special. The six verbs, the two origins, enabledness and the
// service-baseline rules are the coordinator's, unchanged, which is what keeps the families'
// idioms from drifting apart.
import type {
    FunctionalityAdapter, FunctionalityDefinitionSource,
    FunctionalityPreparation, FunctionalityPrepared, FunctionalityServiceDefinition,
    WorkspaceCapabilityIdentity,
} from "./DaemonModule.ts";
import type { FunctionalityCandidate, FunctionalityDiscoverQuery, JsonSchema } from "@plurnk/plurnk-contracts";
import EnvCatalog from "../core/env-catalog.ts";
import EnvDefaults, { type EnvDefaultsFile } from "../core/env-defaults.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import ExecEnv from "../schemes/exec-env.ts";
import Paths from "../Paths.ts";

export const ENV_FAMILY = "env";
// The family's namespace owner — also the key a spawn reads its Worker's state under.
export const ENV_OWNER = "@plurnk/plurnk-service";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// A refusal is the verb's own operation result, the shape both projections convert; anything else
// thrown here would surface as a fault of the action or the manager rather than as the outcome.
const actionError = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): OperationFailureError =>
    new OperationFailureError(
        Results.failure("env:functionality", code, status, detail, {}, { family: ENV_FAMILY, retryable: false, ...extensions }),
    );

// POSIX-ish, and deliberately narrow: a name the shell can actually export. This is the family's
// alias grammar ({§functionality-adapter}) — the alias IS the variable name, and case is semantic.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// One variable. The alias IS the name, so the definition carries only what the name does not.
const DEFINITION: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
        value: { type: "string", description: "The exact value, used verbatim. No interpolation, no escapes." },
    },
} as unknown as JsonSchema;

export default class EnvFunctionality implements FunctionalityAdapter {
    readonly family = ENV_FAMILY;
    readonly namespaceOwner = ENV_OWNER;
    readonly summary = "Read and shape the environment your commands run in";
    readonly definitionSchema = DEFINITION;
    readonly scope = "worker" as const;
    readonly aliasPattern = NAME;
    readonly docsDir = Paths.packageRoot;
    readonly example = { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } };
    readonly discovery = {
        details: "`discover` is this installation's configuration catalog: every knob an installed "
            + "package declares, with the declaring package as provenance and its own comment as the "
            + "summary. `query` matches a name; `source` selects one owning package. It is not a "
            + "permissions list — you may set any name — it is how you learn which names have a "
            + "consumer, and how you learn the name of a value only the operator can supply.",
    };

    readonly #defaults: () => Promise<readonly EnvDefaultsFile[]>;

    constructor(defaults: () => Promise<readonly EnvDefaultsFile[]>) {
        this.#defaults = defaults;
    }

    // Service origin: every ambient name the operator's ceiling admits, exactly as a
    // service-declared MCP server is a service definition. A Worker may disable one for itself
    // — that is how `CI=1` goes away for one Worker without the operator changing anything.
    //
    // Values are projected because the ceiling is the security boundary, not this projection:
    // anything admitted is already readable by any command the Worker runs. Withholding it here
    // would be theatre, and would make `list` lie about the environment its commands see.
    async available(_identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]> {
        return Object.entries(ExecEnv.scoped())
            .map(([alias, value]) => ({ alias, definition: { value: value ?? "" }, enabled: true }))
            .toSorted((left, right) => left.alias.localeCompare(right.alias));
    }

    async discover(query: FunctionalityDiscoverQuery, _identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            // A client's own environment contributing candidates would be a second door into the
            // cascade, past the operator's ceiling. The refusal is the same shape Agent Skills uses.
            throw actionError("configuration-unsupported", 400,
                "Environment discovery reads this installation's declared configuration; client configuration contributes nothing.",
                { retryable: false });
        }
        return EnvCatalog.candidates(await this.#defaults(), {
            ...(query.query === undefined ? {} : { query: query.query }),
            ...(query.source === undefined ? {} : { source: query.source }),
        }) as readonly FunctionalityCandidate[];
    }

    async admit(input: unknown, _identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource> {
        const record = input as { alias?: unknown; definition?: unknown };
        const alias = typeof record.alias === "string" ? record.alias : "";
        if (!NAME.test(alias)) {
            throw actionError("name-invalid", 400,
                `'${alias}' is not a name a shell can export.`, { retryable: false });
        }
        // The invariant, refused at admission rather than silently at the spawn: a name the model
        // writes here would otherwise be dropped when the environment composes, and it would never
        // learn why. {§exec-env-scoped} strips these unconditionally at every layer.
        if (ExecEnv.ownSecretTest()(alias)) {
            throw actionError("name-reserved", 400,
                `'${alias}' is plurnk's own: PLURNK_* configuration and provider credential names never reach a subprocess.`,
                { retryable: false });
        }
        const definition = record.definition as { value?: unknown } | undefined;
        if (typeof definition?.value !== "string") {
            throw actionError("value-invalid", 400, `'${alias}' needs a string value.`, { retryable: false });
        }
        return { alias, definition: { value: definition.value } };
    }

    // Nothing is launched, so nothing can fail to launch: every enabled definition is active and
    // there is no snapshot to tear down. The environment is read at the spawn that uses it
    // ({§exec-env-scoped}), never held resident — which is why this family publishes no runtimes.
    async prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared> {
        const outcomes = new Map([...preparation.enabled.keys()].map((alias) => [alias, { state: "active" as const }]));
        return {
            runtimes: [], documents: [], outcomes, snapshot: null,
            commit: async () => undefined,
            abort: async () => undefined,
        };
    }

    async teardown(_snapshot: unknown, _identity: WorkspaceCapabilityIdentity): Promise<void> {
        return undefined;
    }

    static defaultsReader(projectRoot: string, pluginsNodeModules: string): () => Promise<readonly EnvDefaultsFile[]> {
        let cached: readonly EnvDefaultsFile[] | undefined;
        return async () => cached ??= await EnvDefaults.collect(projectRoot, pluginsNodeModules);
    }

    // {§exec-env-scoped} layer four, applied at the spawn: the Worker's own state over the ambient
    // ceiling. An enabled worker entry sets its value; a disabled entry of either origin withholds the
    // name. One rule with `list`, which projects the same state, so what a Worker sees listed is what
    // its command receives. The state is the coordinator's persisted shape ({§functionality-state});
    // anything else is a defect, not a fallback. The invariant runs last, as at every layer.
    //
    // Beside the environment comes its record: every name with its provenance, which the spawn
    // writes on its own log row and the digest renders — the host-versus-container confound closed
    // where it starts.
    static compose(ambient: NodeJS.ProcessEnv, state: unknown): { env: NodeJS.ProcessEnv; record: Record<string, EnvRecord> } {
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
            if (entry.origin === "service") continue;
            if (entry.origin !== "worker") throw new Error(`env state for '${name}' has origin '${String(entry.origin)}'`);
            if (!isRecord(entry.definition) || typeof entry.definition.value !== "string") throw new Error(`env state for '${name}' holds no string value`);
            reserved ??= ExecEnv.ownSecretTest();
            if (reserved(name)) {
                record[name] = { source: "masked" };
                continue;
            }
            env[name] = entry.definition.value;
            record[name] = { source: "worker", ...from, value: entry.definition.value };
        }
        for (const [name, value] of Object.entries(env)) {
            if (record[name] === undefined && value !== undefined) record[name] = { source: "host", value };
        }
        return { env, record };
    }
}

// One name's provenance in a spawn's environment ({§exec-env-scoped}): the host through the
// ceiling, this Worker's own value (`from` names an ancestor when it was inherited), or a name
// withheld — by this Worker, by the ancestor named, or by the invariant.
export interface EnvRecord {
    readonly source: "host" | "worker" | "masked";
    readonly from?: string;
    readonly value?: string;
}
