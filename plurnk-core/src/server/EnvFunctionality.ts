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
import type { FunctionalityCandidate, FunctionalityDiscoverQuery, JsonSchema, ProblemDetails } from "@plurnk/plurnk-contracts";
import { Problems } from "@plurnk/plurnk-contracts";
import EnvCatalog from "../core/env-catalog.ts";
import EnvDefaults, { type EnvDefaultsFile } from "../core/env-defaults.ts";
import ExecEnv from "../schemes/exec-env.ts";


class EnvActionError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(problem.detail);
        this.name = "EnvActionError";
        this.problem = problem;
    }
}

const actionError = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): EnvActionError =>
    new EnvActionError(Problems.create("env:functionality", code, status, detail, {
        stage: "env-functionality",
        retryable: status === 409 || status >= 500,
        ...extensions,
    }));

export const ENV_FAMILY = "env";
const ENV_OWNER = "@plurnk/plurnk-service";

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
}
