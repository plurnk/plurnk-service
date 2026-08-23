// {§a2a-agents-functionality} — outbound A2A agents as one Worker Functionality
// family named `agents`. The adapter owns protocol truth: the environment's
// definitions, inert Agent Card discovery, admission of an authored definition,
// two-phase preparation (card discovery + HTTP+JSON client per alias), and the
// per-Worker snapshot the `a2a` scheme resolves aliases against. The family is
// not tagged `a2a` because every executor tag is also a scheme face and would
// collide with the `a2a://` resource scheme.
import type { AgentCard } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import {
    Problems,
    Validator,
    type A2AAgentDefinition as A2aAgentDefinition,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type JsonSchema,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import { outboundDefinitions, serviceEnabledNames } from "./config.ts";
import { connectHttpJsonAgentFromCard, discoverAgentCard } from "./HttpJsonClient.ts";

export const AGENTS_FAMILY = "agents";
export const AGENTS_OWNER = "@plurnk/plurnk-a2a";
const DEFINITION = { $ref: "https://schemas.plurnk.dev/v0/A2aAgentDefinition.json" } as const satisfies JsonSchema;
const ALIAS = /^[a-z][a-z0-9-]*$/u;
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;

// Structural views of the core seam, as every module declares them.
interface WorkerIdentity {
    readonly workspaceId: number;
    readonly workerId: number;
}

type Outcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url: string } };

interface Preparation extends WorkerIdentity {
    readonly enabled: ReadonlyMap<string, object>;
    readonly previous: unknown | null;
    readonly failure: "publish-unavailable" | "reject";
    readonly force?: string;
    retain(): () => void;
}

interface Prepared {
    readonly runtimes: readonly never[];
    readonly documents: readonly { readonly pathname: string; readonly content: string }[];
    readonly outcomes: ReadonlyMap<string, Outcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

export interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "enable" | "disable" | "remove",
        params: unknown,
        identity: WorkerIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    refresh(identity: WorkerIdentity): Promise<void>;
}

interface Attachment {
    readonly definition: A2aAgentDefinition;
    readonly card: AgentCard;
    readonly client: Client;
}

interface Snapshot {
    readonly attachments: ReadonlyMap<string, Attachment>;
    readonly unavailable: ReadonlyMap<string, { readonly definition: A2aAgentDefinition; readonly problem: ProblemDetails }>;
}

export class A2aFunctionalityError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "A2aFunctionalityError";
        this.problem = problem;
    }
}

const problem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("a2a:functionality", code, status, detail, {
    stage: "a2a-functionality",
    retryable: status === 409 || status >= 500,
    ...extensions,
});

const failure = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): A2aFunctionalityError => new A2aFunctionalityError(problem(code, status, detail, extensions), cause);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const sameDefinition = (left: A2aAgentDefinition, right: A2aAgentDefinition): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

// A symbolic `${NAME}` reference resolves at connection; anything else is literal.
const resolveReference = (value: string, env: NodeJS.ProcessEnv, alias: string, field: string): string => {
    const match = ENV_REFERENCE.exec(value);
    if (match === null) return value;
    const resolved = env[match[1]!];
    if (resolved === undefined || resolved.length === 0) {
        throw failure("authorization-unresolved", 409, `A2A agent '${alias}' references ${value} in ${field}, which is not set in the service environment.`, { agent: alias, field, reference: value, retryable: true });
    }
    return resolved;
};

export const aliasOfCard = (card: AgentCard): string => {
    const slug = card.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    const candidate = /^[a-z]/u.test(slug) ? slug : `agent${slug.length === 0 ? "" : `-${slug}`}`;
    return ALIAS.test(candidate) ? candidate : "agent";
};

// {§a2a-agents-catalog} — one concise model-facing document per active alias:
// identity to choose among agents and the invocation form; the exact card and
// its skills stay pullable through `READ a2a://<alias>`.
export const renderAgent = (alias: string, card: AgentCard): string => {
    const description = card.description.trim().replace(/\s+/gu, " ");
    const version = card.version.trim().length === 0 ? "" : ` v${card.version.trim()}`;
    const streaming = card.capabilities?.streaming === true ? "yes" : "no";
    return [
        `# ${alias}`,
        "",
        "## Summary",
        "",
        `a2a://${alias} — ${card.name}${version}: ${description}`,
        "",
        "## Invocation",
        "",
        "```plurnk",
        `## SEND0 [200] (a2a://${alias})`,
        "Describe the work for this agent; a Task answers 102 and its result wakes the next turn.",
        "```",
        "",
        `streaming: ${streaming} · card and skills: \`READ a2a://${alias}\``,
    ].join("\n");
};

export default class A2aFunctionality {
    readonly family = AGENTS_FAMILY;
    readonly namespaceOwner = AGENTS_OWNER;
    readonly summary = "Outbound A2A agents: remote peers addressed as a2a://<alias>, enabled per Worker.";
    readonly definitionSchema: JsonSchema = DEFINITION;

    readonly #env: NodeJS.ProcessEnv;
    readonly #snapshots = new Map<number, Snapshot>();
    #handle: FunctionalityFamilyHandle | null = null;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.#env = env;
    }

    attach(handle: FunctionalityFamilyHandle): void {
        this.#handle = handle;
    }

    get handle(): FunctionalityFamilyHandle {
        if (this.#handle === null) throw new Error("A2A agents Functionality is not attached to its coordinator handle.");
        return this.#handle;
    }

    // The `a2a` scheme's resolver: the alias in the Functionality of the Worker
    // the operation acts in. Unknown or disabled → null (404 at the scheme);
    // unavailable → its one exact preparation Problem.
    resolve(authority: string, workerId: number): Client | null {
        const snapshot = this.#snapshots.get(workerId);
        if (snapshot === undefined) return null;
        const attachment = snapshot.attachments.get(authority);
        if (attachment !== undefined) return attachment.client;
        const unavailable = snapshot.unavailable.get(authority);
        if (unavailable !== undefined) throw new A2aFunctionalityError(structuredClone(unavailable.problem));
        return null;
    }

    async available(): Promise<readonly { alias: string; definition: object; enabled: boolean }[]> {
        const enabled = new Set(serviceEnabledNames(this.#env));
        return outboundDefinitions(this.#env).map((definition) => ({
            alias: definition.name,
            definition,
            enabled: enabled.has(definition.name),
        }));
    }

    async discover(query: FunctionalityDiscoverQuery): Promise<readonly FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            const overlay = Object.fromEntries(Object.entries(query.configuration).filter(([, value]) => typeof value === "string")) as Record<string, string>;
            let definitions: A2aAgentDefinition[];
            try {
                definitions = outboundDefinitions(overlay);
            } catch (cause) {
                throw failure("configuration-invalid", 400, `The offered A2A configuration is invalid: ${messageOf(cause)}`, { retryable: false }, cause);
            }
            return definitions.map((definition): FunctionalityCandidate => ({
                alias: definition.name,
                definition,
                provenance: { kind: "client-configuration", source: `PLURNK_A2A_${definition.name.toUpperCase()}` },
            }));
        }
        if (query.source !== undefined) {
            const source = query.source;
            if (!/^https?:\/\//u.test(source)) {
                throw failure("source-invalid", 400, `A2A discovery takes an absolute HTTP(S) agent URL; got ${JSON.stringify(source)}.`, { source, retryable: false });
            }
            let card: AgentCard;
            try {
                card = await discoverAgentCard(source);
            } catch (cause) {
                throw failure("card-unreachable", 502, `No standard Agent Card could be discovered at '${source}': ${messageOf(cause)}`, { source, retryable: true }, cause);
            }
            const alias = aliasOfCard(card);
            return [{
                alias,
                summary: card.description,
                definition: { name: alias, url: source } satisfies A2aAgentDefinition,
                provenance: { kind: "agent-card", source, reference: card.name },
            }];
        }
        if (query.query !== undefined) {
            throw failure("registry-not-configured", 501, "A2A registry search requires a configured downstream registry; none is configured.", { query: query.query, recovery: "Discover an explicit agent URL.", retryable: false });
        }
        return [];
    }

    async admit(input: unknown): Promise<{ alias: string; definition: object }> {
        const params = isRecord(input) ? input : {};
        let definition: A2aAgentDefinition;
        try {
            definition = structuredClone(Validator.assertA2aAgentDefinition(structuredClone(params.definition) as A2aAgentDefinition));
        } catch (cause) {
            throw failure("definition-invalid", 400, "The A2A agent definition is invalid.", { retryable: false }, cause);
        }
        const alias = typeof params.alias === "string" ? params.alias : definition.name;
        if (alias !== definition.name) {
            throw failure("alias-mismatch", 400, `Alias '${alias}' must equal the definition's name '${definition.name}'.`, { alias, name: definition.name, retryable: false });
        }
        return { alias, definition };
    }

    async #attach(alias: string, definition: A2aAgentDefinition): Promise<Attachment> {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(definition.headers ?? {})) {
            headers[name] = resolveReference(value, this.#env, alias, `headers.${name}`);
        }
        if (definition.authorization !== undefined) {
            headers.Authorization = `Bearer ${resolveReference(definition.authorization.token, this.#env, alias, "authorization.token")}`;
        }
        let card: AgentCard;
        try {
            card = await discoverAgentCard(definition.url, definition.cardPath, { headers });
        } catch (cause) {
            throw failure("card-unreachable", 502, `A2A agent '${alias}' has no discoverable standard Agent Card at ${definition.url}: ${messageOf(cause)}`, { agent: alias, url: definition.url, retryable: true }, cause);
        }
        let client: Client;
        try {
            client = await connectHttpJsonAgentFromCard(card, { headers });
        } catch (cause) {
            throw failure("interface-unsupported", 502, `A2A agent '${alias}' advertises no usable HTTP+JSON 1.0 interface: ${messageOf(cause)}`, { agent: alias, url: definition.url, interfaces: card.supportedInterfaces.map(({ protocolBinding, protocolVersion }) => `${protocolBinding} ${protocolVersion}`), retryable: false }, cause);
        }
        return { definition, card, client };
    }

    async prepare(preparation: Preparation): Promise<Prepared> {
        const previous = preparation.previous as Snapshot | null;
        const attachments = new Map<string, Attachment>();
        const unavailable = new Map<string, { definition: A2aAgentDefinition; problem: ProblemDetails }>();
        const outcomes = new Map<string, Outcome>();
        for (const [alias, raw] of preparation.enabled) {
            const definition = raw as A2aAgentDefinition;
            const kept = previous?.attachments.get(alias);
            if (kept !== undefined && sameDefinition(kept.definition, definition) && preparation.force !== alias) {
                attachments.set(alias, kept);
            } else {
                const carried = previous?.unavailable.get(alias);
                const fresh = carried === undefined || !sameDefinition(carried.definition, definition) || preparation.force === alias;
                try {
                    attachments.set(alias, await this.#attach(alias, definition));
                } catch (cause) {
                    if (!(cause instanceof A2aFunctionalityError)) throw cause;
                    if (preparation.failure === "reject" && fresh) throw cause;
                    if (fresh) console.error(`A2A agent '${alias}' unavailable: ${cause.problem.detail}`);
                    unavailable.set(alias, { definition, problem: structuredClone(cause.problem) });
                    outcomes.set(alias, { state: "unavailable", problem: structuredClone(cause.problem) });
                    continue;
                }
            }
            const { card } = attachments.get(alias)!;
            outcomes.set(alias, {
                state: "active",
                detail: {
                    name: card.name,
                    version: card.version,
                    description: card.description,
                    skills: card.skills.map(({ id }) => id),
                    streaming: card.capabilities?.streaming === true,
                },
            });
        }
        const documents = [...attachments]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([alias, { card }]) => ({ pathname: `agents/${encodeURIComponent(alias)}.md`, content: renderAgent(alias, card) }));
        const snapshot: Snapshot = { attachments, unavailable };
        const { workerId } = preparation;
        return {
            runtimes: [],
            documents,
            outcomes,
            snapshot,
            commit: async () => { this.#snapshots.set(workerId, snapshot); },
            abort: async () => {},
        };
    }

    async teardown(_snapshot: unknown, identity: WorkerIdentity): Promise<void> {
        this.#snapshots.delete(identity.workerId);
    }
}
