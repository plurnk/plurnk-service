// {§schedule-family} — scheduled obligations and actions as one workspace Functionality family named `schedule`.
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
    Problems,
    isRecord,
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
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import { previewOccurrences, validateConfiguration } from "./config.ts";
import {
    DEFINITION_SCHEMA,
    DefinitionError,
    isScriptDefinition,
    readDefinition,
    type ScheduleDefinition,
} from "./definition.ts";
import {
    assertZone,
    defaultCatchup,
    describeRule,
    isOneShotRule,
    nextOccurrence,
    normalizeRule,
    parseRule,
    ScheduleRuleError,
    upcoming,
    type ParsedRule,
} from "./rules.ts";
import Scheduler, {
    hashDefinition,
    type ScheduleStatus,
    type ScheduledRule,
    type SchedulerOptions,
} from "./Scheduler.ts";
import { isoString, zoned } from "./temporal.ts";
import ScheduleResources from "./ScheduleResources.ts";
import type { FunctionalityAdapter, FunctionalityDiscovery, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";

export const SCHEDULE_FAMILY = "schedule";
export const SCHEDULE_OWNER = "@plurnk/plurnk-schedule";
export const SCHEDULE_LEDGER_OWNER = "@plurnk/plurnk-schedule/ledger";

// {§module-seam-slices} — the environment, parser, and state slices this family resolves under.
export type EnvironmentSeam = Pick<ModuleSetupSeam, "readWorkspaceEnvironment" | "readSessionEnvironment">
    & Partial<Pick<ModuleSetupSeam, "parseClientStatements" | "readWorkspaceModuleState" | "writeWorkspaceModuleState" | "registerModuleAction">>;

interface Snapshot {
    readonly rules: ReadonlyMap<string, ScheduledRule>;
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
    readonly summary = "List ({}) or manage scheduled and unscheduled obligations and actions.";
    readonly definitionSchema: JsonSchema = DEFINITION_SCHEMA;
    readonly example = {
        alias: "daily",
        rule: "0 9 * * *",
        target: "session://exampleSessionName",
        prompt: "Text delivered at each occurrence.",
    };
    readonly docsDir = fileURLToPath(new URL("..", import.meta.url));
    readonly discovery: FunctionalityDiscovery = {
        inputs: ["rule"],
        emptyListsAll: true,
        details: "`{\"discover\": true}` tells the current time in the effective zone; `{\"discover\": \"<rule>\"}` previews a cron, RRULE, or one-shot timestamp/duration rule alongside the current time without persisting.",
    };

    readonly #env: NodeJS.ProcessEnv;
    readonly #scheduler: Scheduler;
    readonly #report: (message: string, cause: unknown) => void;
    #service: ReturnType<typeof validateConfiguration> | null = null;
    readonly #readAt: number;
    #handle: FunctionalityFamilyHandle | null = null;
    #environment: EnvironmentSeam | null = null;

    constructor(env: NodeJS.ProcessEnv = process.env, options: ScheduleFunctionalityOptions = {}) {
        this.#env = env;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#scheduler = new Scheduler({
            ...options,
            report: this.#report,
            settled: (workspaceId) => { this.#settled(workspaceId); },
        });
        this.scheme = new ScheduleResources(() => this.#handle);
        this.#readAt = this.#scheduler.now();
    }

    attach(handle: FunctionalityFamilyHandle, environment: EnvironmentSeam): void {
        this.#handle = handle;
        this.#environment = environment;
        const hasStore = environment.readWorkspaceModuleState !== undefined
            && environment.writeWorkspaceModuleState !== undefined;
        this.#scheduler.bindHost({
            ...(hasStore
                ? {
                    store: {
                        read: (workspaceId) => environment.readWorkspaceModuleState!(workspaceId, SCHEDULE_LEDGER_OWNER),
                        write: (workspaceId, state) => environment.writeWorkspaceModuleState!(workspaceId, SCHEDULE_LEDGER_OWNER, state),
                    },
                }
                : {}),
            ...(environment.parseClientStatements === undefined
                ? {}
                : { parser: (source, workspaceId) => environment.parseClientStatements!(source, workspaceId) }),
        });
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
        assertZone(zone);
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
        const alias = isOneShotRule(parsed) ? "once" : parsed.rule.options().freq.toLowerCase();
        return [{
            alias,
            summary: [
                `now ${isoString(zoned(now, zone))}`,
                describeRule(parsed),
                preview.length === 0 ? "no occurrence ahead" : `next ${preview.join(", ")}`,
            ].join("; "),
            definition: { rule: parsed.text },
            provenance: { kind: "rule", source: rule },
        }];
    }

    async admit(input: unknown, identity: FunctionalityIdentity): Promise<FunctionalityAdmission<ScheduleDefinition>> {
        const params = isRecord(input) ? input : {};
        if (typeof params.alias !== "string") {
            throw failure("alias-required", 400, "schedule definition needs an alias.", { retryable: false });
        }
        const { alias, ...rest } = params;
        let definition: ScheduleDefinition;
        try {
            definition = readDefinition(rest);
        } catch (cause) {
            if (!(cause instanceof DefinitionError)) throw cause;
            throw failure("definition-invalid", 400, "The schedule definition is invalid.", { errors: cause.errors, retryable: false }, cause);
        }
        if (isScriptDefinition(definition) && this.#environment?.parseClientStatements !== undefined) {
            await this.#environment.parseClientStatements(definition.run, identity.workspaceId);
        }
        const now = this.#scheduler.now();
        const zone = await this.#zone(identity);
        try {
            assertZone(zone);
        } catch (cause) {
            if (!(cause instanceof ScheduleRuleError)) throw cause;
            throw failure(cause.code, 400, cause.message, { retryable: false }, cause);
        }
        if (definition.rule === null) {
            return { alias, definition, preparation: now };
        }
        const parsed = this.#read(definition.rule, zone, now);
        return { alias, definition: { ...definition, rule: parsed.text }, preparation: now };
    }

    async prepare(preparation: FunctionalityPreparation<ScheduleDefinition, Snapshot>): Promise<FunctionalityPrepared<never, Snapshot>> {
        preparation.signal.throwIfAborted();
        const { workspaceId, previous } = preparation;
        await this.#scheduler.ensureLedger(workspaceId);
        let admission: { alias: string; at: number } | undefined;
        const [current] = preparation.admissions;
        if (current !== undefined) {
            const { alias, definition, preparation: at } = current;
            if (typeof at !== "number" || !Number.isFinite(at)) {
                throw new Error("Schedule admission has no valid preparation timestamp.");
            }
            if (!isDeepStrictEqual(previous?.rules.get(alias)?.definition, definition)) {
                admission = { alias, at };
            }
        }
        const defaultZone = await this.#zone({ workspaceId }).catch(() => "UTC");
        const rules = new Map<string, ScheduledRule>();
        const unavailable = new Map<string, string>();
        const outcomes = new Map<string, FunctionalityOutcome>();
        const now = this.#scheduler.now();

        for (const [alias, { definition: raw }] of preparation.enabled) {
            let definition: ScheduleDefinition;
            let parsed: ParsedRule | null = null;
            try {
                definition = readDefinition(raw);
                if (definition.rule !== null) {
                    parsed = parseRule(definition.rule);
                }
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
            const catchup = definition.catchup ?? defaultCatchup(parsed);
            rules.set(alias, { alias, definition, parsed, catchup });

            const defHash = hashDefinition(definition);
            const rawLedger = this.#scheduler.ledgerEntry(workspaceId, alias);
            const ledger = rawLedger !== undefined && rawLedger.definitionHash === defHash && preparation.force !== alias
                ? rawLedger
                : undefined;

            if (ledger?.status === "fail" && ledger.problem !== undefined) {
                unavailable.set(alias, parsed?.text ?? "null");
                outcomes.set(alias, { state: "unavailable", problem: structuredClone(ledger.problem) });
                continue;
            }

            const status: ScheduleStatus = ledger?.status ?? "open";
            const zone = parsed?.zone ?? defaultZone;
            const cursor = admission?.alias === alias
                ? admission.at
                : catchup && ledger !== undefined
                    ? (ledger.lastFiredAt ?? ledger.createdAt)
                    : now;
            const next = parsed === null || status === "done" ? null : nextOccurrence(parsed, cursor);
            const exhausted = parsed !== null && next === null;
            const text = parsed === null
                ? "unscheduled obligation"
                : `${describeRule(parsed)}${next === null ? "; no future occurrences" : ""}`;

            outcomes.set(alias, {
                state: "active",
                detail: {
                    path: `schedule:///rules/${encodeURIComponent(alias)}`,
                    kind: isScriptDefinition(definition) ? "run" : "prompt",
                    status,
                    rule: parsed === null ? null : parsed.text,
                    zone,
                    text,
                    next: next === null ? null : isoString(next),
                    exhausted,
                    catchup,
                    lastFiredAt: ledger?.lastFiredAt != null ? isoString(zoned(ledger.lastFiredAt, zone)) : null,
                    doneAt: ledger?.doneAt != null ? isoString(zoned(ledger.doneAt, zone)) : null,
                    lastDoneAt: ledger?.lastDoneAt != null ? isoString(zoned(ledger.lastDoneAt, zone)) : null,
                    loopId: ledger?.loopId ?? null,
                    ...(definition.target === undefined ? {} : { target: definition.target }),
                    ...(!isScriptDefinition(definition) && definition.persona !== undefined ? { persona: definition.persona } : {}),
                },
            });
        }

        const snapshot: Snapshot = { rules, unavailable };
        return {
            documents: [],
            outcomes,
            snapshot,
            publish: () => undefined,
            commit: async () => {
                await this.#scheduler.sync(workspaceId, rules, { admission, force: preparation.force });
            },
            abort: async () => {},
        };
    }

    async teardown(_snapshot: Snapshot, _identity: WorkspaceCapabilityIdentity): Promise<void> {}

    async #zone(identity: FunctionalityIdentity): Promise<string> {
        const environment = this.#environment === null
            ? this.#env
            : identity.sessionId === undefined
                ? (await this.#environment.readWorkspaceEnvironment(identity.workspaceId))(this.#env)
                : (await this.#environment.readSessionEnvironment(identity.workspaceId, identity.sessionId))(this.#env);
        const zone = environment.TZ;
        if (zone === undefined || zone.length === 0) {
            throw new Error("TZ is unset; @plurnk/plurnk-schedule declares its default in .env.defaults.");
        }
        try {
            assertZone(zone);
        } catch (cause) {
            if (!(cause instanceof ScheduleRuleError)) throw cause;
            throw failure(cause.code, 400, cause.message, { retryable: false }, cause);
        }
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

    #settled(workspaceId: number): void {
        const handle = this.#handle;
        if (handle === null) return;
        void handle.refresh({ workspaceId }).catch((cause: unknown) => {
            this.#report(`schedule outcomes did not refresh for workspace ${workspaceId}`, cause);
        });
    }
}
