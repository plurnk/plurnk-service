// {§schedule-family} — scheduled messages as one workspace Functionality family named `schedule`.
// The adapter owns the family's truth: the environment's rules, inert discovery that reads a rule
// and tells the time ({§schedule-clock}), admission that canonicalizes and bounds a rule, and the
// outcomes the timers stand behind ({§schedule-delivery}, {§schedule-residency}).
import { fileURLToPath } from "node:url";
import {
    Problems,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type JsonSchema,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import { previewOccurrences, serviceDefinitions, serviceEnabled } from "./config.ts";
import { DEFINITION_SCHEMA, DefinitionError, readDefinition, type ScheduleDefinition } from "./definition.ts";
import { describeRule, nextOccurrence, normalizeRule, parseRule, ScheduleRuleError, upcoming, type ParsedRule } from "./rules.ts";
import Scheduler, { type ScheduledRule, type SchedulerOptions } from "./Scheduler.ts";
import { isoString, zoned } from "./temporal.ts";
import ScheduleResources from "./ScheduleResources.ts";

export const SCHEDULE_FAMILY = "schedule";
export const SCHEDULE_OWNER = "@plurnk/plurnk-schedule";

// Structural views of the core seam, as every module declares them.
interface WorkspaceIdentity {
    readonly workspaceId: number;
}

// The coordinator names the invoking Worker on a model-invoked verb.
interface CallIdentity extends WorkspaceIdentity {
    readonly workerId?: number;
}

interface CallOptions {
    readonly env?: Readonly<Record<string, string>>;
}

type Outcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url: string } };

interface Preparation extends WorkspaceIdentity {
    readonly enabled: ReadonlyMap<string, object>;
    readonly previous: unknown | null;
    readonly failure: "publish-unavailable" | "reject";
    readonly force?: string;
    retain(): () => void;
}

interface Prepared {
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
        identity: WorkspaceIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    refresh(identity: WorkspaceIdentity): Promise<void>;
}

export interface EnvironmentSeam {
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    readWorkerEnvironment(workspaceId: number, workerId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
}

interface Snapshot {
    readonly rules: ReadonlyMap<string, ScheduledRule>;
    // Aliases published unavailable, by canonical text: a repeat is carried, a new one is fresh.
    readonly unavailable: ReadonlyMap<string, string>;
}

export interface ScheduleFunctionalityOptions extends Omit<SchedulerOptions, "settled"> {}

export class ScheduleFunctionalityError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "ScheduleFunctionalityError";
        this.problem = problem;
    }
}

const problem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("schedule:functionality", code, status, detail, {
    stage: "schedule-functionality",
    ...extensions,
});

const failure = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): ScheduleFunctionalityError => new ScheduleFunctionalityError(problem(code, status, detail, extensions), cause);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export default class ScheduleFunctionality {
    readonly scheme: ScheduleResources;
    readonly family = SCHEDULE_FAMILY;
    readonly namespaceOwner = SCHEDULE_OWNER;
    readonly summary = "Manage scheduled messages";
    readonly definitionSchema: JsonSchema = DEFINITION_SCHEMA;
    readonly example = {
        alias: "standup",
        definition: {
            rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20",
            target: "worker://scribe",
            prompt: "Summarize yesterday's log entries for the team.",
        },
    };
    readonly docsDir = fileURLToPath(new URL("..", import.meta.url));
    readonly discovery = {
        details: "`source` is rule text: RFC 5545, an optional DTSTART line and one RRULE line, or bare `FREQ=…` parts. One inert candidate comes back. Its summary opens with the current time in the effective zone and previews the first occurrences; its definition carries the rule as it would be stored, to `add` with a `target` and a `prompt`. Nothing is persisted.",
    };

    readonly #env: NodeJS.ProcessEnv;
    readonly #scheduler: Scheduler;
    readonly #report: (message: string, cause: unknown) => void;
    // {§schedule-environment} — the service's rules, canonical from construction: a rule without a
    // DTSTART starts when it is read, and a service rule is read once, when the daemon starts.
    readonly #service: ReadonlyMap<string, { readonly definition: ScheduleDefinition; readonly enabled: boolean }>;
    #handle: FunctionalityFamilyHandle | null = null;
    #environment: EnvironmentSeam | null = null;

    constructor(env: NodeJS.ProcessEnv = process.env, options: ScheduleFunctionalityOptions = {}) {
        this.#env = env;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#scheduler = new Scheduler({ ...options, report: this.#report, settled: (workspaceId) => { this.#settled(workspaceId); } });
        this.scheme = new ScheduleResources(this.#scheduler, async (workspaceId) => {
            if (this.#handle === null) throw new Error("schedule family is not attached");
            const listing = await this.#handle.invoke("list", {}, { workspaceId });
            return (listing.body as { definitions: Array<{ alias: string; state: string }> }).definitions;
        });
        const zone = env.TZ;
        if (zone === undefined || zone.length === 0) throw new Error("TZ is unset; @plurnk/plurnk-schedule declares its default in .env.defaults.");
        const enabled = serviceEnabled(env);
        const now = this.#scheduler.now();
        this.#service = new Map([...serviceDefinitions(env)].map(([alias, definition]) => {
            let parsed: ParsedRule;
            try {
                parsed = normalizeRule(definition.rule, zone, now);
            } catch (cause) {
                throw new Error(`PLURNK_SCHEDULE_${alias.toUpperCase()}: ${messageOf(cause)}`, { cause });
            }
            return [alias, { definition: { ...definition, rule: parsed.text }, enabled: enabled.has(alias) }];
        }));
    }

    attach(handle: FunctionalityFamilyHandle, environment: EnvironmentSeam): void {
        this.#handle = handle;
        this.#environment = environment;
    }

    get scheduler(): Scheduler {
        return this.#scheduler;
    }

    // The service's rules as the coordinator's baseline, and as the module re-arms them at start.
    service(): ReadonlyMap<string, { readonly definition: ScheduleDefinition; readonly enabled: boolean }> {
        return this.#service;
    }

    async available(): Promise<readonly { alias: string; definition: object; enabled: boolean }[]> {
        return [...this.#service].map(([alias, { definition, enabled }]) => ({ alias, definition, enabled }));
    }

    // {§schedule-clock} — the one place the time is told: on demand, beside the rule it reads.
    async discover(query: FunctionalityDiscoverQuery, identity: CallIdentity, options?: CallOptions): Promise<readonly FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            throw failure("configuration-unsupported", 400, "schedule discovery reads rule text from `source`; it takes no configuration.", { retryable: false });
        }
        if (query.query !== undefined) {
            throw failure("query-unsupported", 400, "schedule discovery reads rule text from `source`; there is no catalog to search.", { retryable: false });
        }
        if (query.source === undefined) {
            throw failure("source-required", 400, "schedule discovery needs rule text in `source`; `FREQ=DAILY` is enough to read the time.", { retryable: false });
        }
        const zone = await this.#zone(identity, options);
        const now = this.#scheduler.now();
        const parsed = this.#read(query.source, zone, now);
        const preview = upcoming(parsed, now, previewOccurrences(this.#env)).map(isoString);
        return [{
            alias: parsed.rule.options().freq.toLowerCase(),
            summary: [
                `now ${isoString(zoned(now, zone))}`,
                describeRule(parsed),
                preview.length === 0 ? "no occurrence ahead" : `next ${preview.join(", ")}`,
                ...(parsed.bounded ? [] : ["unbounded: add needs COUNT or UNTIL"]),
            ].join("; "),
            definition: { rule: parsed.text },
            provenance: { kind: "rule", source: query.source },
        }];
    }

    async admit(input: unknown, identity: CallIdentity, _caller?: unknown, options?: CallOptions): Promise<{ alias: string; definition: object }> {
        const params = isRecord(input) ? input : {};
        if (typeof params.alias !== "string") throw failure("alias-required", 400, "schedule add needs an alias.", { retryable: false });
        let definition: ScheduleDefinition;
        try {
            definition = readDefinition(params.definition);
        } catch (cause) {
            if (!(cause instanceof DefinitionError)) throw cause;
            throw failure("definition-invalid", 400, "The schedule definition is invalid.", { errors: cause.errors, retryable: false }, cause);
        }
        const parsed = this.#read(definition.rule, await this.#zone(identity, options), this.#scheduler.now());
        // {§schedule-bound}
        if (!parsed.bounded) throw failure("rule-unbounded", 400, "A workspace rule ends: give the RRULE a COUNT or an UNTIL.", { retryable: false });
        return { alias: params.alias, definition: { ...definition, rule: parsed.text } };
    }

    async prepare(preparation: Preparation): Promise<Prepared> {
        const { workspaceId } = preparation;
        const previous = preparation.previous as Snapshot | null;
        const rules = new Map<string, ScheduledRule>();
        const unavailable = new Map<string, string>();
        const outcomes = new Map<string, Outcome>();
        const now = this.#scheduler.now();
        for (const [alias, raw] of preparation.enabled) {
            if (preparation.force === alias) this.#scheduler.forgive(workspaceId, alias);
            let definition: ScheduleDefinition;
            let parsed: ParsedRule;
            try {
                definition = readDefinition(raw);
                parsed = parseRule(definition.rule);
            } catch (cause) {
                const text = JSON.stringify(raw);
                const fresh = previous?.unavailable.get(alias) !== text;
                const unreadable = problem("rule-invalid", 400, `The rule of '${alias}' is unreadable: ${messageOf(cause)}`, { alias, retryable: false });
                if (preparation.failure === "reject" && fresh) throw new ScheduleFunctionalityError(unreadable, cause);
                if (fresh) this.#report(`schedule '${alias}' unavailable in workspace ${workspaceId}`, cause);
                unavailable.set(alias, text);
                outcomes.set(alias, { state: "unavailable", problem: unreadable });
                continue;
            }
            rules.set(alias, { alias, definition, parsed });
            const failed = this.#scheduler.failure(workspaceId, alias);
            if (failed !== undefined && failed.text === parsed.text) {
                unavailable.set(alias, parsed.text);
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(failed.problem) });
                continue;
            }
            const next = nextOccurrence(parsed, now);
            outcomes.set(alias, {
                state: "active",
                detail: {
                    path: `schedule:///rules/${encodeURIComponent(alias)}`,
                    rule: parsed.text,
                    zone: parsed.zone,
                    text: describeRule(parsed),
                    next: next === null ? null : isoString(next),
                    exhausted: next === null,
                    target: definition.target,
                    ...(definition.policy === undefined ? {} : { policy: definition.policy }),
                },
            });
        }
        const snapshot: Snapshot = { rules, unavailable };
        return {
            documents: [],
            outcomes,
            snapshot,
            commit: async () => { await this.#scheduler.sync(workspaceId, rules); },
            abort: async () => {},
        };
    }

    // {§schedule-residency} — a schedule is an obligation, not a runtime: cooling the workspace
    // leaves its timers armed.
    async teardown(_snapshot: unknown, _identity: WorkspaceIdentity): Promise<void> {}

    // {§schedule-zone} — the zone a rule is read in: the call's own env when it carries one (a
    // worker's `env` metadata), else the invoking Worker's environment (its overrides over the
    // workspace layer over the service's), else the workspace's.
    async #zone(identity: CallIdentity, options?: CallOptions): Promise<string> {
        const called = options?.env?.TZ;
        if (called !== undefined && called.length > 0) return called;
        const environment = this.#environment === null
            ? this.#env
            : identity.workerId === undefined
                ? (await this.#environment.readWorkspaceEnvironment(identity.workspaceId))(this.#env)
                : (await this.#environment.readWorkerEnvironment(identity.workspaceId, identity.workerId))(this.#env);
        const zone = environment.TZ;
        if (zone === undefined || zone.length === 0) throw new Error("TZ is unset; @plurnk/plurnk-schedule declares its default in .env.defaults.");
        return zone;
    }

    #read(text: string, zone: string, now: number): ParsedRule {
        try {
            return normalizeRule(text, zone, now);
        } catch (cause) {
            if (!(cause instanceof ScheduleRuleError)) throw cause;
            throw failure(cause.code, 400, cause.message, { retryable: false }, cause);
        }
    }

    // A delivery settled: the outcomes name the next occurrence or the failure. A workspace that
    // is not resident has nothing published; the coordinator's refresh returns at once.
    #settled(workspaceId: number): void {
        const handle = this.#handle;
        if (handle === null) return;
        void handle.refresh({ workspaceId }).catch((cause: unknown) => {
            this.#report(`schedule outcomes did not refresh for workspace ${workspaceId}`, cause);
        });
    }
}
