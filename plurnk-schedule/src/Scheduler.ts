// {§schedule-delivery} — the timers. One armed occurrence per (workspace, alias); at its instant
// the message is delivered to the target worker through the application port as an arrival with
// the source `schedule://<alias>`, joining the worker's live loop or starting one. Then the next
// occurrence arms from now: a late fire delivers once and skips what it missed, never a backlog.
// A delivery failure disarms the rule and holds its Problem for the outcome; `enable` retries.
import { Problems, type LoopPolicy, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { createHash } from "node:crypto";
import type { AwaitedEventCaps, AwaitedEventProducer, SchemeResult } from "@plurnk/plurnk-schemes";
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
    readonly dueMs: number;
    readonly event: string;
    handle: unknown | null;
    delivering: boolean;
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

const SYSTEM_TIMERS: SchedulerTimers = Object.freeze({
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
    #events: AwaitedEventProducer | null = null;
    #serial: Promise<void> = Promise.resolve();
    #closing = false;
    readonly #settlementErrors: unknown[] = [];

    constructor(options: SchedulerOptions = {}) {
        this.#clock = options.clock ?? Date.now;
        this.#timers = options.timers ?? SYSTEM_TIMERS;
        this.#report = options.report ?? ((message, cause) => { console.error(`${message}:`, cause); });
        this.#settled = options.settled ?? (() => {});
    }

    now(): number {
        return this.#clock();
    }

    start(port: DeliveryPort): void {
        if (this.#port !== null) throw new Error("schedule Scheduler already started");
        this.#port = port;
        this.#closing = false;
    }

    attach(events: AwaitedEventProducer): void {
        this.#events = events;
    }

    #exclusive<T>(run: () => Promise<T>): Promise<T> {
        const result = this.#serial.then(run);
        this.#serial = result.then(() => {}, () => {});
        return result;
    }

    async close(): Promise<void> {
        this.#closing = true;
        await this.#serial;
        for (const { handle } of this.#armed.values()) if (handle !== null) this.#timers.clear(handle);
        this.#armed.clear();
        await Promise.all(this.#pending);
        this.#port = null;
        if (this.#settlementErrors.length > 0) throw new AggregateError(this.#settlementErrors, "Scheduled occurrence settlement failed.");
    }

    // {§schedule-residency} — a workspace's rule set as published: aliases absent from it disarm,
    // unchanged occurrences retain identity. A held failure clears when its rule leaves the set or changes.
    sync(workspaceId: number, rules: ReadonlyMap<string, ScheduledRule>): Promise<void> {
        return this.#exclusive(async () => {
            for (const [entryKey, armed] of this.#armed) {
                if (armed.workspaceId !== workspaceId) continue;
                const replacement = rules.get(armed.rule.alias);
                if (replacement !== undefined && JSON.stringify(replacement.definition) === JSON.stringify(armed.rule.definition)) continue;
                if (armed.handle !== null) this.#timers.clear(armed.handle);
                this.#armed.delete(entryKey);
                await this.#settle(armed, { status: 410, problem: problem("occurrence-withdrawn", 410, "The scheduled occurrence is no longer active.") });
            }
            for (const [entryKey, failed] of this.#failures) {
                if (!entryKey.startsWith(`${workspaceId}:`)) continue;
                const rule = rules.get(entryKey.slice(entryKey.indexOf(":") + 1));
                if (rule === undefined || rule.parsed.text !== failed.text) this.#failures.delete(entryKey);
            }
            for (const rule of rules.values()) {
                if (this.#failures.has(key(workspaceId, rule.alias))) continue;
                if (this.#armed.has(key(workspaceId, rule.alias))) continue;
                this.#arm(workspaceId, rule);
            }
        });
    }

    wait(workspaceId: number, alias: string, events: AwaitedEventCaps): Promise<SchemeResult> {
        return this.#exclusive(async () => {
            const armed = this.#armed.get(key(workspaceId, alias));
            if (armed === undefined || this.#closing) return {
                status: 409, problem: problem("occurrence-unavailable", 409, `Schedule '${alias}' has no pending occurrence.`),
            };
            return events.join({ event: armed.event, source: `schedule:///rules/${encodeURIComponent(alias)}`, dueAt: new Date(armed.dueMs).toISOString() });
        });
    }

    async reconcile(): Promise<void> {
        const events = this.#events;
        if (events === null) return;
        await this.#exclusive(async () => {
            const pending = await events.pending();
            for (const record of pending) {
                if ([...this.#armed.values()].some((armed) => armed.workspaceId === record.workspaceId && armed.event === record.event)) continue;
                const overdue = record.dueAt !== undefined && Date.parse(record.dueAt) <= this.#clock();
                const result = overdue
                    ? { status: 504, problem: problem("occurrence-uncertain", 504, "The occurrence elapsed while delivery was not durably settled; its delivery outcome is unknown.") }
                    : { status: 410, problem: problem("occurrence-unavailable", 410, "The awaited occurrence is not active in the restored schedule.") };
                await events.settle(record.workspaceId, record.event, result);
            }
        });
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
        if (this.#closing) return;
        const entryKey = key(workspaceId, rule.alias);
        const existing = this.#armed.get(entryKey);
        if (existing !== undefined) {
            if (existing.handle !== null) this.#timers.clear(existing.handle);
            this.#armed.delete(entryKey);
        }
        const now = this.#clock();
        const due = nextOccurrence(rule.parsed, now);
        if (due === null) return;
        const dueMs = due.epochMilliseconds;
        const fingerprint = createHash("sha256").update(JSON.stringify(rule.definition)).digest("hex");
        const armed: Armed = { workspaceId, rule, dueMs, event: `${rule.alias}/${fingerprint}/${dueMs}`, handle: null, delivering: false };
        this.#armed.set(entryKey, armed);
        this.#setTimer(armed);
    }

    #setTimer(armed: Armed): void {
        armed.handle = this.#timers.set(() => { this.#fire(armed); }, Math.max(0, Math.min(armed.dueMs - this.#clock(), MAX_DELAY_MS)));
    }

    #settle(armed: Armed, result: SchemeResult): Promise<void> {
        return this.#events?.settle(armed.workspaceId, armed.event, result) ?? Promise.resolve();
    }

    #fire(armed: Armed): void {
        const { workspaceId, rule } = armed;
        const entryKey = key(workspaceId, rule.alias);
        const delivery = (async () => {
            const admitted = await this.#exclusive(async () => {
                if (this.#closing || this.#armed.get(entryKey) !== armed || armed.delivering) return false;
                if (this.#clock() < armed.dueMs) { this.#setTimer(armed); return false; }
                armed.handle = null;
                armed.delivering = true;
                return true;
            });
            if (!admitted) return;
            // Admission may demand workspace capabilities. Never hold the producer's
            // mutation queue across that exterior call ({§schedule-await}).
            let result: SchemeResult;
            try {
                await this.#deliver(workspaceId, rule);
                result = { status: 200 };
            } catch (cause) {
                const failed = problemOf(rule.alias, cause);
                result = { status: failed.status, problem: failed };
                this.#report(`scheduled message '${rule.alias}' was not delivered in workspace ${workspaceId}`, cause);
            }
            await this.#exclusive(async () => {
                await this.#settle(armed, result);
                if (this.#armed.get(entryKey) !== armed) return;
                this.#armed.delete(entryKey);
                if (result.status >= 400) this.#failures.set(entryKey, { text: rule.parsed.text, problem: result.problem! });
                else this.#arm(workspaceId, rule);
            });
        })()
            .catch((cause: unknown) => {
                this.#settlementErrors.push(cause);
                this.#report(`scheduled occurrence '${rule.alias}' could not settle in workspace ${workspaceId}`, cause);
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
