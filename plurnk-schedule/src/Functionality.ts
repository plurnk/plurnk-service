// {§schedule-family} — scheduled messages as one workspace Functionality family named `schedule`.
// The adapter owns the family's truth: the environment's rules, inert discovery that reads a rule
// and tells the time ({§schedule-rule}), admission that canonicalizes and bounds a rule, and the
// outcomes the timers stand behind ({§schedule-delivery}, {§schedule-residency}).
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Problems,
    type FunctionalityAdmission,
    type FunctionalityCandidate,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityIdentity,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type FunctionalityServiceDefinition,
    type JsonSchema,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity, isRecord } from "@plurnk/plurnk-contracts";
import { previewOccurrences, validateConfiguration } from "./config.ts";
import { DEFINITION_SCHEMA, DefinitionError, readDefinition, type ScheduleDefinition } from "./definition.ts";
import { describeRule, nextOccurrence, normalizeRule, parseRule, ScheduleRuleError, upcoming, type ParsedRule } from "./rules.ts";
import Scheduler, { type ScheduledRule, type SchedulerOptions } from "./Scheduler.ts";
import { isoString, zoned } from "./temporal.ts";
import ScheduleResources from "./ScheduleResources.ts";
import type { FunctionalityAdapter, FunctionalityDiscovery, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";

export const SCHEDULE_FAMILY = "schedule";
export const SCHEDULE_OWNER = "@plurnk/plurnk-schedule";

// {§module-seam-slices} — the environment readers this family resolves rules under.
export type EnvironmentSeam = Pick<ModuleSetupSeam, "readWorkspaceEnvironment" | "readSessionEnvironment">;

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

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export default class ScheduleFunctionality implements FunctionalityAdapter<never, RuntimeSchemeFacet, ScheduleDefinition, Snapshot> {
    readonly scheme: ScheduleResources;
    readonly family = SCHEDULE_FAMILY;
    readonly namespaceOwner = SCHEDULE_OWNER;
    readonly summary = "Manage scheduled activity";
    readonly definitionSchema: JsonSchema = DEFINITION_SCHEMA;
    readonly example = {
        alias: "daily",
        rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20",
        target: "session://exampleSessionName",
        prompt: "Text delivered at each occurrence.",
    };
    readonly docsDir = fileURLToPath(new URL("..", import.meta.url));
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["rule"],
        emptyListsAll: true,
        details: "`{}` tells the current time in the effective zone. `rule` is rule text: RFC 5545, an optional DTSTART line and one RRULE line, or bare `FREQ=…` parts. One inert candidate comes back: its summary opens with the current time in the effective zone and previews the first occurrences; its definition carries the rule as it would be stored, to `add` with a `target` and a `prompt`. Nothing is persisted.",
    };

    readonly #env: NodeJS.ProcessEnv;
    readonly #scheduler: Scheduler;
    readonly #report: (message: string, cause: unknown) => void;
    // {§schedule-residency} — lazily validate without moving the service rules' DTSTART epoch.
    #service: ReturnType<typeof validateConfiguration> | null = null;
    readonly #readAt: number;
    #handle: FunctionalityFamilyHandle | null = null;
    #environment: EnvironmentSeam | null = null;

    constructor(env: NodeJS.ProcessEnv = process.env, options: ScheduleFunctionalityOptions = {}) {
        this.#env = env;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#scheduler = new Scheduler({ ...options, report: this.#report, settled: (workspaceId) => { this.#settled(workspaceId); } });
        this.scheme = new ScheduleResources(() => this.#handle);
        this.#readAt = this.#scheduler.now();
    }

    attach(handle: FunctionalityFamilyHandle, environment: EnvironmentSeam): void {
        this.#handle = handle;
        this.#environment = environment;
    }

    get scheduler(): Scheduler {
        return this.#scheduler;
    }

    async available(): Promise<readonly FunctionalityServiceDefinition<ScheduleDefinition>[]> {
        this.#service ??= validateConfiguration(this.#env, this.#readAt);
        return [...this.#service].map(([alias, entry]) => ({ alias, ...entry }));
    }

    // {§schedule-rule} — the one place the time is told: on demand, alone or beside the rule it reads.
    async discover(query: FunctionalityDiscoverQuery, identity: FunctionalityIdentity): Promise<readonly FunctionalityCandidate[]> {
        const zone = await this.#zone(identity);
        const now = this.#scheduler.now();
        if (query.rule === undefined) {
            return [{
                summary: `now ${isoString(zoned(now, zone))}`,
                definition: {},
                provenance: { kind: "rule", source: zone },
            }];
        }
        const rule = query.rule;
        const parsed = this.#read(rule, zone, now);
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
            provenance: { kind: "rule", source: rule },
        }];
    }

    async admit(input: unknown, identity: FunctionalityIdentity): Promise<FunctionalityAdmission<ScheduleDefinition>> {
        const params = isRecord(input) ? input : {};
        if (typeof params.alias !== "string") throw failure("alias-required", 400, "schedule definition needs an alias.", { retryable: false });
        const { alias, ...rest } = params;
        let definition: ScheduleDefinition;
        try {
            definition = readDefinition(rest);
        } catch (cause) {
            if (!(cause instanceof DefinitionError)) throw cause;
            throw failure("definition-invalid", 400, "The schedule definition is invalid.", { errors: cause.errors, retryable: false }, cause);
        }
        const now = this.#scheduler.now();
        const parsed = this.#read(definition.rule, await this.#zone(identity), now);
        // {§schedule-rule}
        if (!parsed.bounded) throw failure("rule-unbounded", 400, "A workspace rule ends: give the RRULE a COUNT or an UNTIL.", { retryable: false });
        // {§schedule-delivery} — the rule was read now; its first arming is judged from now.
        return { alias, definition: { ...definition, rule: parsed.text }, preparation: now };
    }

    async prepare(preparation: FunctionalityPreparation<ScheduleDefinition, Snapshot>): Promise<FunctionalityPrepared<never, Snapshot>> {
        preparation.signal.throwIfAborted();
        const { workspaceId } = preparation;
        const { previous } = preparation;
        let admission: { alias: string; at: number } | undefined;
        const [current] = preparation.admissions;
        if (current !== undefined) {
            const { alias, definition, preparation: at } = current;
            if (typeof at !== "number" || !Number.isFinite(at)) throw new Error("Schedule admission has no valid preparation timestamp.");
            if (!isDeepStrictEqual(previous?.rules.get(alias)?.definition, definition)) admission = { alias, at };
        }
        const rules = new Map<string, ScheduledRule>();
        const unavailable = new Map<string, string>();
        const outcomes = new Map<string, FunctionalityOutcome>();
        const now = this.#scheduler.now();
        for (const [alias, { definition: raw }] of preparation.enabled) {
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
            if (preparation.force !== alias && failed !== undefined && isDeepStrictEqual(failed.definition, definition)) {
                unavailable.set(alias, parsed.text);
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(failed.problem) });
                continue;
            }
            const next = nextOccurrence(parsed, admission?.alias === alias ? admission.at : now);
            outcomes.set(alias, {
                state: "active",
                detail: {
                    path: `schedule:///rules/${encodeURIComponent(alias)}`,
                    rule: parsed.text,
                    zone: parsed.zone,
                    text: `${describeRule(parsed)}${next === null ? "; no future occurrences" : ""}`,
                    next: next === null ? null : isoString(next),
                    exhausted: next === null,
                    target: definition.target,
                },
            });
        }
        const snapshot: Snapshot = { rules, unavailable };
        return {
            documents: [],
            outcomes,
            snapshot,
            publish: () => undefined,
            commit: async () => { await this.#scheduler.sync(workspaceId, rules, { admission, force: preparation.force }); },
            abort: async () => {},
        };
    }

    // {§schedule-residency} — a schedule is an obligation, not a runtime: cooling the workspace
    // leaves its timers armed.
    async teardown(_snapshot: Snapshot, _identity: WorkspaceCapabilityIdentity): Promise<void> {}

    // {§schedule-rule} — the zone a rule is read in: the invoking Session's environment (its
    // overrides over the workspace layer over the service's), else the workspace's.
    async #zone(identity: FunctionalityIdentity): Promise<string> {
        const environment = this.#environment === null
            ? this.#env
            : identity.sessionId === undefined
                ? (await this.#environment.readWorkspaceEnvironment(identity.workspaceId))(this.#env)
                : (await this.#environment.readSessionEnvironment(identity.workspaceId, identity.sessionId))(this.#env);
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
