// {§schedule-delivery} — the timers. One armed occurrence per (workspace, alias); at its instant
// the message is delivered to the target worker through the application port as an arrival with
// the source `schedule://<alias>`, joining the worker's live loop or starting one. Then the next
// occurrence arms from now: a late fire delivers once and skips what it missed, never a backlog.
// A delivery failure disarms the rule and holds its Problem for the outcome; `enable` retries.
import { Problems, type LoopPolicy, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { targetWorkerName, type ScheduleDefinition } from "./definition.ts";
import { nextOccurrence, type ParsedRule } from "./rules.ts";

export interface ScheduledRule {
    readonly alias: string;
    readonly definition: ScheduleDefinition;
    readonly parsed: ParsedRule;
}

export interface DeliveryPort {
    listWorkers(workspaceId: number): Promise<readonly { readonly id: number; readonly name: string }[]>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly prompt: string;
        readonly source: string;
        readonly policy?: LoopPolicy;
    }): Promise<unknown>;
}

export interface SchedulerTimers {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
}

export interface SchedulerOptions {
    readonly clock?: () => number;
    readonly timers?: SchedulerTimers;
    readonly report?: (message: string, cause: unknown) => void;
    // Called after every delivery attempt settles, so the family can republish its outcomes.
    readonly settled?: (workspaceId: number, alias: string) => void;
}

export interface ScheduleFailure {
    readonly text: string;
    readonly problem: ProblemDetails;
}

interface Armed {
    readonly workspaceId: number;
    readonly rule: ScheduledRule;
    readonly handle: unknown;
}

export class ScheduleDeliveryError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "ScheduleDeliveryError";
        this.problem = problem;
    }
}

// setTimeout's ceiling; a farther occurrence arms in hops.
const MAX_DELAY_MS = 2_147_483_647;
const DIAGNOSTIC_LIMIT = 512;
const key = (workspaceId: number, alias: string): string => `${workspaceId}:${alias}`;

const DEFAULT_TIMERS: SchedulerTimers = Object.freeze({
    set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs).unref(),
    clear: (handle: unknown): void => { clearTimeout(handle as NodeJS.Timeout); },
});

const problem = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): ProblemDetails =>
    Problems.create("schedule:delivery", code, status, detail, { stage: "schedule-delivery", ...extensions });

const problemOf = (alias: string, cause: unknown): ProblemDetails => Problems.fromError(cause) ?? problem(
    "delivery-failed", 502, `Delivering the scheduled message '${alias}' failed.`,
    { alias, diagnostic: (cause instanceof Error ? cause.message : String(cause)).slice(0, DIAGNOSTIC_LIMIT), retryable: true },
);

export default class Scheduler {
    readonly #clock: () => number;
    readonly #timers: SchedulerTimers;
    readonly #report: (message: string, cause: unknown) => void;
    readonly #settled: (workspaceId: number, alias: string) => void;
    readonly #armed = new Map<string, Armed>();
    readonly #failures = new Map<string, ScheduleFailure>();
    readonly #pending = new Set<Promise<void>>();
    #port: DeliveryPort | null = null;

    constructor(options: SchedulerOptions = {}) {
        this.#clock = options.clock ?? Date.now;
        this.#timers = options.timers ?? DEFAULT_TIMERS;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#settled = options.settled ?? (() => {});
    }

    now(): number {
        return this.#clock();
    }

    start(port: DeliveryPort): void {
        if (this.#port !== null) throw new Error("schedule Scheduler already started");
        this.#port = port;
    }

    async close(): Promise<void> {
        for (const { handle } of this.#armed.values()) this.#timers.clear(handle);
        this.#armed.clear();
        await Promise.all(this.#pending);
        this.#port = null;
    }

    // {§schedule-residency} — a workspace's rule set as published: aliases absent from it disarm,
    // present ones re-arm from now. A held failure clears when its rule leaves the set or changes.
    sync(workspaceId: number, rules: ReadonlyMap<string, ScheduledRule>): void {
        for (const [entryKey, armed] of this.#armed) {
            if (armed.workspaceId !== workspaceId || rules.has(armed.rule.alias)) continue;
            this.#timers.clear(armed.handle);
            this.#armed.delete(entryKey);
        }
        for (const [entryKey, failed] of this.#failures) {
            if (!entryKey.startsWith(`${workspaceId}:`)) continue;
            const rule = rules.get(entryKey.slice(entryKey.indexOf(":") + 1));
            if (rule === undefined || rule.parsed.text !== failed.text) this.#failures.delete(entryKey);
        }
        for (const rule of rules.values()) {
            if (this.#failures.has(key(workspaceId, rule.alias))) continue;
            this.#arm(workspaceId, rule);
        }
    }

    failure(workspaceId: number, alias: string): ScheduleFailure | undefined {
        return this.#failures.get(key(workspaceId, alias));
    }

    forgive(workspaceId: number, alias: string): void {
        this.#failures.delete(key(workspaceId, alias));
    }

    armed(workspaceId: number): readonly string[] {
        return [...this.#armed.values()].filter((armed) => armed.workspaceId === workspaceId).map((armed) => armed.rule.alias).toSorted();
    }

    #arm(workspaceId: number, rule: ScheduledRule): void {
        const entryKey = key(workspaceId, rule.alias);
        const existing = this.#armed.get(entryKey);
        if (existing !== undefined) {
            this.#timers.clear(existing.handle);
            this.#armed.delete(entryKey);
        }
        const now = this.#clock();
        const due = nextOccurrence(rule.parsed, now);
        if (due === null) return;
        const dueMs = due.epochMilliseconds;
        const handle = this.#timers.set(() => { this.#fire(workspaceId, rule, dueMs); }, Math.min(dueMs - now, MAX_DELAY_MS));
        this.#armed.set(entryKey, { workspaceId, rule, handle });
    }

    #fire(workspaceId: number, rule: ScheduledRule, dueMs: number): void {
        const entryKey = key(workspaceId, rule.alias);
        if (this.#armed.get(entryKey)?.rule !== rule) return;
        this.#armed.delete(entryKey);
        if (this.#clock() < dueMs) {
            this.#arm(workspaceId, rule);
            return;
        }
        const delivery: Promise<void> = this.#deliver(workspaceId, rule)
            .then(() => { this.#arm(workspaceId, rule); })
            .catch((cause: unknown) => {
                this.#failures.set(entryKey, { text: rule.parsed.text, problem: problemOf(rule.alias, cause) });
                this.#report(`scheduled message '${rule.alias}' was not delivered in workspace ${workspaceId}`, cause);
            })
            .finally(() => {
                this.#pending.delete(delivery);
                this.#settled(workspaceId, rule.alias);
            });
        this.#pending.add(delivery);
    }

    async #deliver(workspaceId: number, rule: ScheduledRule): Promise<void> {
        const port = this.#port;
        if (port === null) throw new Error("schedule Scheduler is not started");
        const name = targetWorkerName(rule.definition.target);
        const worker = (await port.listWorkers(workspaceId)).find((candidate) => candidate.name === name);
        if (worker === undefined) {
            throw new ScheduleDeliveryError(problem("target-missing", 404, `No worker named '${name}' exists in this workspace.`, {
                alias: rule.alias,
                target: rule.definition.target,
                retryable: true,
            }));
        }
        await port.runLoop({
            workspaceId,
            workerId: worker.id,
            prompt: rule.definition.prompt,
            source: `schedule://${encodeURIComponent(rule.alias)}`,
            ...(rule.definition.policy === undefined ? {} : { policy: rule.definition.policy }),
        });
    }
}
