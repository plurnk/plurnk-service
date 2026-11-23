// {§schedule-delivery} — armed timers, durable obligation ledger (`open` | `done` | `fail`),
// `catchup` across daemon restarts, session auto-creation for `prompt` schedules, and deterministic
// `_plurnk` tool-call execution (`dispatchClientAction`) with per-step receipts for scripted `run` schedules.
import {
    MAX_TIMER_MS,
    Problems,
    isExecution,
    isRecord,
    type EntryReadResult,
    type LogEntryWire,
    type PlurnkStatement,
    type ProblemDetails,
    type ScheduleStatus,
    type ScheduledStepReceipt,
} from "@plurnk/plurnk-contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SchemeResult } from "@plurnk/plurnk-schemes";
import {
    isScriptDefinition,
    targetSessionName,
    type ScheduleDefinition,
    type ScheduledToolCall,
} from "./definition.ts";
import { isOneShotRule, nextOccurrence, type ParsedRule } from "./rules.ts";

export type { ScheduleStatus, ScheduledStepReceipt };

export interface ScheduledRule {
    readonly alias: string;
    readonly definition: ScheduleDefinition;
    readonly parsed: ParsedRule | null;
    readonly catchup: boolean;
}

export interface ScheduleLedgerEntry {
    readonly definitionHash: string;
    readonly createdAt: number;
    readonly status: ScheduleStatus;
    readonly lastFiredAt: number | null;
    readonly doneAt: number | null;
    readonly lastDoneAt: number | null;
    readonly loopId: number | null;
    readonly problem?: ProblemDetails;
}

export interface ScheduleStateStore {
    read(workspaceId: number): Promise<unknown>;
    write(workspaceId: number, state: unknown): Promise<void>;
}

export type ClientCallLowerer = (
    calls: readonly ScheduledToolCall[],
    workspaceId?: number,
) => Promise<readonly PlurnkStatement[]>;

export interface DeliveryPort {
    listSessions(
        workspaceId: number,
        query?: { readonly archived?: boolean },
    ): Promise<readonly { readonly id: number; readonly name: string; readonly archived_at?: string | null }[]>;
    createSession?(args: {
        readonly workspaceId: number;
        readonly name: string;
        readonly persona?: string;
    }): Promise<{ readonly sessionId: number; readonly sessionName: string }>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly prompt: string;
        readonly source: string;
    }): Promise<unknown>;
    dispatchClientAction?(args: {
        readonly workspaceId: number;
        readonly actor: string;
        readonly statements: PlurnkStatement[];
        readonly onLoop?: (loop: { readonly sessionId: number; readonly loopId: number }) => void;
    }): Promise<readonly { readonly status: number; readonly loopId?: number; readonly problem?: ProblemDetails; readonly [key: string]: unknown }[]>;
    readLog?(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly loopId?: number;
        readonly limit?: number;
    }): Promise<readonly LogEntryWire[]>;
    readEntry?(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly target: string;
    }): Promise<EntryReadResult>;
    readStreams?(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<readonly { readonly target: string; readonly channels: readonly { readonly state: string }[] }[]>;
}

export interface SchedulerTimers {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
}

export interface SchedulerOptions {
    readonly clock?: () => number;
    readonly timers?: SchedulerTimers;
    readonly report?: (message: string, cause: unknown) => void;
    // Called after every delivery attempt or status transition settles, so the family can republish its outcomes.
    readonly settled?: (workspaceId: number, alias: string) => void;
}

export interface ScheduleFailure {
    readonly definition: ScheduleDefinition;
    readonly problem: ProblemDetails;
}

interface Armed {
    readonly workspaceId: number;
    readonly rule: ScheduledRule;
    readonly dueMs: number;
    readonly event: string;
    handle: unknown;
    delivering: boolean;
}

interface DeliveryOutcome {
    readonly settled: boolean;
    readonly loopId: number | null;
    readonly results?: readonly ScheduledStepReceipt[];
}

interface StreamConcludedWaiter {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly resolve: (result: Readonly<Record<string, unknown>> | null) => void;
}

export class ScheduleDeliveryError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, cause === undefined ? undefined : { cause });
        this.name = "ScheduleDeliveryError";
        this.problem = problem;
    }
}

const DIAGNOSTIC_LIMIT = 512;
const PREVIEW_LIMIT = 512;
const RECENT_CONCLUDED_LIMIT = 256;
const LEDGER_VERSION = 1;
const key = (workspaceId: number, alias: string): string => `${workspaceId}:${alias}`;
const streamKey = (workspaceId: number, sessionId: number, target: string): string => `${workspaceId}:${sessionId}:${target}`;

const boundedPreview = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length <= PREVIEW_LIMIT ? trimmed : `${trimmed.slice(0, PREVIEW_LIMIT - 1)}…`;
};

const previewOfResult = (result: Readonly<Record<string, unknown>>): string | undefined => {
    if (typeof result.content === "string") return boundedPreview(result.content);
    if (typeof result.body === "string") return boundedPreview(result.body);
    if (typeof result.detail === "string") return boundedPreview(result.detail);
    if (result.results !== undefined) return boundedPreview(JSON.stringify(result.results));
    return undefined;
};

const logUriOf = (row: LogEntryWire | undefined): string | undefined => {
    if (row === undefined) return undefined;
    const loopSeq = row.loop_seq;
    const turnSeq = row.turn_seq;
    const sequence = row.sequence;
    const op = typeof row.op === "string" && row.op.length > 0 ? `/${row.op.toLowerCase()}` : "";
    if (typeof loopSeq === "number" && typeof turnSeq === "number" && typeof sequence === "number") {
        return `log:///${loopSeq}/${turnSeq}/${sequence}${op}`;
    }
    return undefined;
};

export const hashDefinition = (definition: ScheduleDefinition): string =>
    createHash("sha256").update(JSON.stringify(definition)).digest("hex");

const isTimeout = (handle: unknown): handle is NodeJS.Timeout =>
    typeof handle === "object" && handle !== null && "refresh" in handle;

const SYSTEM_TIMERS: SchedulerTimers = Object.freeze({
    set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs).unref(),
    clear: (handle: unknown): void => { if (isTimeout(handle)) clearTimeout(handle); },
});

const problem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails =>
    Problems.create("schedule:delivery", code, status, detail, { stage: "schedule-delivery", ...extensions });

const problemOf = (alias: string, cause: unknown): ProblemDetails => Problems.fromError(cause) ?? problem(
    "delivery-failed",
    502,
    `Delivering the scheduled item '${alias}' failed.`,
    {
        alias,
        diagnostic: (cause instanceof Error ? cause.message : String(cause)).slice(0, DIAGNOSTIC_LIMIT),
        retryable: true,
    },
);

const isTerminalObligation = (rule: ScheduledRule, nowMs: number): boolean => {
    if (rule.definition.rule === "manual") return false;
    if (rule.definition.rule === "once") return true;
    if (rule.parsed === null) return true;
    if (isOneShotRule(rule.parsed)) return true;
    return nextOccurrence(rule.parsed, nowMs) === null;
};

export default class Scheduler {
    readonly #clock: () => number;
    readonly #timers: SchedulerTimers;
    readonly #report: (message: string, cause: unknown) => void;
    readonly #settled: (workspaceId: number, alias: string) => void;
    readonly #armed = new Map<string, Armed>();
    readonly #rules = new Map<number, Map<string, ScheduledRule>>();
    readonly #ledgers = new Map<number, Map<string, ScheduleLedgerEntry>>();
    readonly #loadedWorkspaces = new Set<number>();
    readonly #inFlightLoops = new Map<string, string>();
    readonly #runningAliases = new Set<string>();
    readonly #pending = new Set<Promise<void>>();
    readonly #recentConcluded = new Map<string, Readonly<Record<string, unknown>> | null>();
    readonly #streamWaiters = new Set<StreamConcludedWaiter>();
    #store: ScheduleStateStore | null = null;
    #lowerCalls: ClientCallLowerer | null = null;
    #port: DeliveryPort | null = null;
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

    bindHost(options: { readonly store?: ScheduleStateStore; readonly lowerCalls?: ClientCallLowerer }): void {
        if (options.store !== undefined) this.#store = options.store;
        if (options.lowerCalls !== undefined) this.#lowerCalls = options.lowerCalls;
    }

    start(port: DeliveryPort): void {
        if (this.#port !== null) throw new Error("schedule Scheduler already started");
        this.#port = port;
        this.#closing = false;
    }

    onStreamConcluded(
        workspaceId: number,
        sessionId: number,
        target: string,
        result: Readonly<Record<string, unknown>> | null,
    ): void {
        const entryKey = streamKey(workspaceId, sessionId, target);
        this.#recentConcluded.set(entryKey, result);
        if (this.#recentConcluded.size > RECENT_CONCLUDED_LIMIT) {
            const oldest = this.#recentConcluded.keys().next().value;
            if (oldest !== undefined) this.#recentConcluded.delete(oldest);
        }
        for (const waiter of [...this.#streamWaiters]) {
            if (waiter.workspaceId === workspaceId && waiter.sessionId === sessionId && waiter.target === target) {
                this.#streamWaiters.delete(waiter);
                waiter.resolve(result);
            }
        }
    }

    #exclusive<T>(run: () => Promise<T>): Promise<T> {
        const result = this.#serial.then(run);
        this.#serial = result.then(() => {}, () => {});
        return result;
    }

    async close(): Promise<void> {
        this.#closing = true;
        for (const waiter of [...this.#streamWaiters]) {
            this.#streamWaiters.delete(waiter);
            waiter.resolve(null);
        }
        await this.#serial;
        for (const { handle } of this.#armed.values()) if (handle !== null) this.#timers.clear(handle);
        this.#armed.clear();
        await Promise.all(this.#pending);
        this.#port = null;
        if (this.#settlementErrors.length > 0) {
            throw new AggregateError(this.#settlementErrors, "Scheduled occurrence settlement failed.");
        }
    }

    async ensureLedger(workspaceId: number): Promise<ReadonlyMap<string, ScheduleLedgerEntry>> {
        if (this.#loadedWorkspaces.has(workspaceId)) {
            return this.#ledgers.get(workspaceId) ?? new Map();
        }
        const map = new Map<string, ScheduleLedgerEntry>();
        if (this.#store !== null) {
            const raw = await this.#store.read(workspaceId);
            if (isRecord(raw) && raw.version === LEDGER_VERSION && isRecord(raw.entries)) {
                for (const [alias, item] of Object.entries(raw.entries)) {
                    if (!isRecord(item) || typeof item.definitionHash !== "string" || typeof item.createdAt !== "number") continue;
                    const status: ScheduleStatus =
                        item.status === "done" || item.status === "fail" ? item.status : "open";
                    const itemProblem = Problems.fromError({ problem: item.problem });
                    map.set(alias, {
                        definitionHash: item.definitionHash,
                        createdAt: item.createdAt,
                        status,
                        lastFiredAt: typeof item.lastFiredAt === "number" ? item.lastFiredAt : null,
                        doneAt: typeof item.doneAt === "number" ? item.doneAt : null,
                        lastDoneAt: typeof item.lastDoneAt === "number" ? item.lastDoneAt : null,
                        loopId: typeof item.loopId === "number" ? item.loopId : null,
                        ...(itemProblem === null ? {} : { problem: itemProblem }),
                    });
                }
            }
        }
        this.#ledgers.set(workspaceId, map);
        this.#loadedWorkspaces.add(workspaceId);
        return map;
    }

    async #persistLedger(workspaceId: number): Promise<void> {
        if (this.#store === null) return;
        const map = this.#ledgers.get(workspaceId);
        if (map === undefined || map.size === 0) {
            await this.#store.write(workspaceId, null);
            return;
        }
        await this.#store.write(workspaceId, {
            version: LEDGER_VERSION,
            entries: Object.fromEntries(map),
        });
    }

    ledgerEntry(workspaceId: number, alias: string): ScheduleLedgerEntry | undefined {
        return this.#ledgers.get(workspaceId)?.get(alias);
    }

    failure(workspaceId: number, alias: string): ScheduleFailure | undefined {
        const entry = this.ledgerEntry(workspaceId, alias);
        const rule = this.#rules.get(workspaceId)?.get(alias);
        if (entry?.status !== "fail" || entry.problem === undefined || rule === undefined) return undefined;
        return { definition: rule.definition, problem: entry.problem };
    }

    armed(workspaceId: number): readonly string[] {
        return [...this.#armed.values()]
            .filter((armed) => armed.workspaceId === workspaceId)
            .map((armed) => armed.rule.alias)
            .toSorted();
    }

    // {§schedule-residency} — reconcile published workspace rules, durable ledger entries, and armed timers.
    // Pass `preserveLedger: true` when temporarily disarming an archived workspace without forgetting its ledger.
    sync(
        workspaceId: number,
        rules: ReadonlyMap<string, ScheduledRule>,
        options: {
            readonly admission?: { readonly alias: string; readonly at: number };
            readonly force?: string;
            readonly preserveLedger?: boolean;
        } = {},
    ): Promise<void> {
        return this.#exclusive(async () => {
            await this.ensureLedger(workspaceId);
            const ledger = this.#ledgers.get(workspaceId)!;
            this.#rules.set(workspaceId, new Map(rules));

            let dirty = false;
            if (options.preserveLedger !== true) {
                for (const alias of [...ledger.keys()]) {
                    if (!rules.has(alias)) {
                        ledger.delete(alias);
                        dirty = true;
                    }
                }
            }

            const now = this.#clock();
            for (const [alias, rule] of rules) {
                const hash = hashDefinition(rule.definition);
                const existing = ledger.get(alias);
                if (existing === undefined || existing.definitionHash !== hash) {
                    const createdAt = options.admission?.alias === alias ? options.admission.at : now;
                    ledger.set(alias, {
                        definitionHash: hash,
                        createdAt,
                        status: "open",
                        lastFiredAt: null,
                        doneAt: null,
                        lastDoneAt: null,
                        loopId: null,
                    });
                    dirty = true;
                } else if (options.force === alias && existing.status !== "open") {
                    ledger.set(alias, {
                        ...existing,
                        status: "open",
                        doneAt: null,
                        problem: undefined,
                    });
                    dirty = true;
                }
            }
            if (dirty) await this.#persistLedger(workspaceId);

            for (const [entryKey, armed] of this.#armed) {
                if (armed.workspaceId !== workspaceId) continue;
                const replacement = rules.get(armed.rule.alias);
                const state = ledger.get(armed.rule.alias);
                if (
                    replacement !== undefined
                    && state?.status === "open"
                    && isDeepStrictEqual(replacement.definition, armed.rule.definition)
                ) {
                    continue;
                }
                if (armed.handle !== null) this.#timers.clear(armed.handle);
                this.#armed.delete(entryKey);
            }

            for (const rule of rules.values()) {
                const entryKey = key(workspaceId, rule.alias);
                const state = ledger.get(rule.alias);
                if (state?.status !== "open") continue;
                if (this.#armed.has(entryKey)) continue;
                const cursor = options.admission?.alias === rule.alias
                    ? options.admission.at
                    : rule.catchup
                        ? (state.lastFiredAt ?? state.createdAt)
                        : now;
                this.#arm(workspaceId, rule, cursor);
            }
        });
    }

    // Trigger `<alias>` immediately on demand (`/schedule run <alias>` / `{ alias, trigger: true }`).
    async runNow(workspaceId: number, alias: string): Promise<{
        readonly alias: string;
        readonly status: ScheduleStatus;
        readonly loopId: number | null;
        readonly lastFiredAt: number;
        readonly doneAt: number | null;
        readonly results?: readonly ScheduledStepReceipt[];
        readonly problem?: ProblemDetails;
    }> {
        const entryKey = key(workspaceId, alias);
        const rule = await this.#exclusive(async () => {
            await this.ensureLedger(workspaceId);
            const candidate = this.#rules.get(workspaceId)?.get(alias);
            if (candidate === undefined) {
                throw new ScheduleDeliveryError(problem(
                    "not-found",
                    404,
                    `Schedule '${alias}' does not exist or is disabled in this workspace.`,
                    { alias, retryable: false },
                ));
            }
            if (this.#runningAliases.has(entryKey)) {
                throw new ScheduleDeliveryError(problem(
                    "already-running",
                    409,
                    `Schedule '${alias}' is already running in this workspace.`,
                    { alias, retryable: true },
                ));
            }
            const existingStatus = this.#ledgers.get(workspaceId)?.get(alias)?.status;
            if (candidate.definition.rule === "once" && existingStatus === "done") {
                throw new ScheduleDeliveryError(problem(
                    "already-done",
                    409,
                    `Schedule '${alias}' is already done; reopen with status "open" or switch rule to "manual" to execute again.`,
                    { alias, retryable: false },
                ));
            }
            this.#runningAliases.add(entryKey);
            return candidate;
        });

        const firedAt = this.#clock();
        let outcome: DeliveryOutcome | null = null;
        let deliveryProblem: ProblemDetails | undefined;
        let updated: ScheduleLedgerEntry;
        try {
            try {
                outcome = await this.#deliver(workspaceId, rule);
            } catch (cause) {
                deliveryProblem = problemOf(alias, cause);
                this.#report(`scheduled item '${alias}' failed in workspace ${workspaceId}`, cause);
            }

            updated = await this.#exclusive(async () => {
                try {
                    const ledger = this.#ledgers.get(workspaceId)!;
                    const prev = ledger.get(alias);
                    const hash = hashDefinition(rule.definition);
                    const createdAt = prev?.createdAt ?? firedAt;
                    let nextEntry: ScheduleLedgerEntry;
                    if (deliveryProblem !== undefined) {
                        const armed = this.#armed.get(entryKey);
                        if (armed !== undefined) {
                            if (armed.handle !== null) this.#timers.clear(armed.handle);
                            this.#armed.delete(entryKey);
                        }
                        nextEntry = {
                            definitionHash: hash,
                            createdAt,
                            status: "fail",
                            lastFiredAt: firedAt,
                            doneAt: null,
                            lastDoneAt: prev?.lastDoneAt ?? null,
                            loopId: null,
                            problem: deliveryProblem,
                        };
                    } else {
                        const terminalDone = outcome!.settled && isTerminalObligation(rule, firedAt);
                        nextEntry = {
                            definitionHash: hash,
                            createdAt,
                            status: terminalDone ? "done" : "open",
                            lastFiredAt: firedAt,
                            doneAt: terminalDone ? firedAt : null,
                            lastDoneAt: outcome!.settled ? firedAt : (prev?.lastDoneAt ?? null),
                            loopId: outcome!.loopId,
                        };
                        if (terminalDone) {
                            const armed = this.#armed.get(entryKey);
                            if (armed !== undefined) {
                                if (armed.handle !== null) this.#timers.clear(armed.handle);
                                this.#armed.delete(entryKey);
                            }
                        } else if (!this.#armed.has(entryKey)) {
                            this.#arm(workspaceId, rule, firedAt);
                        }
                    }
                    ledger.set(alias, nextEntry);
                    await this.#persistLedger(workspaceId);
                    return nextEntry;
                } finally {
                    this.#runningAliases.delete(entryKey);
                }
            });
        } finally {
            this.#runningAliases.delete(entryKey);
        }

        this.#settled(workspaceId, alias);
        if (updated.problem !== undefined) {
            throw new ScheduleDeliveryError(updated.problem);
        }
        return {
            alias,
            status: updated.status,
            loopId: updated.loopId,
            lastFiredAt: firedAt,
            doneAt: updated.doneAt,
            ...(outcome?.results === undefined ? {} : { results: outcome.results }),
        };
    }

    // Explicitly transition an obligation's status (`open` | `done` | `fail`).
    async setStatus(
        workspaceId: number,
        alias: string,
        status: ScheduleStatus,
    ): Promise<ScheduleLedgerEntry> {
        const entry = await this.#exclusive(async () => {
            await this.ensureLedger(workspaceId);
            const rule = this.#rules.get(workspaceId)?.get(alias);
            if (rule === undefined) {
                throw new ScheduleDeliveryError(problem(
                    "not-found",
                    404,
                    `Schedule '${alias}' does not exist or is disabled in this workspace.`,
                    { alias, retryable: false },
                ));
            }
            const ledger = this.#ledgers.get(workspaceId)!;
            const now = this.#clock();
            const prev = ledger.get(alias);
            const hash = hashDefinition(rule.definition);
            const entryKey = key(workspaceId, alias);
            const armed = this.#armed.get(entryKey);
            if (status !== "open" && armed !== undefined) {
                if (armed.handle !== null) this.#timers.clear(armed.handle);
                this.#armed.delete(entryKey);
            }
            const nextEntry: ScheduleLedgerEntry = {
                definitionHash: hash,
                createdAt: prev?.createdAt ?? now,
                status,
                lastFiredAt: prev?.lastFiredAt ?? null,
                doneAt: status === "done" ? now : null,
                lastDoneAt: status === "done" ? now : (prev?.lastDoneAt ?? null),
                loopId: prev?.loopId ?? null,
                ...(status === "fail"
                    ? {
                        problem: prev?.problem ?? problem(
                            "obligation-failed",
                            400,
                            `Schedule obligation '${alias}' was marked failed.`,
                            { alias, retryable: true },
                        ),
                    }
                    : {}),
            };
            ledger.set(alias, nextEntry);
            if (status === "open" && !this.#armed.has(entryKey)) {
                this.#arm(workspaceId, rule, now);
            }
            await this.#persistLedger(workspaceId);
            return nextEntry;
        });
        this.#settled(workspaceId, alias);
        return entry;
    }

    // Settle tracked agentic loops when `loop/terminated` fires.
    onLoopTerminated(
        workspaceId: number,
        loopId: number,
        result: { readonly status: number; readonly problem?: ProblemDetails },
    ): void {
        if (this.#closing) return;
        const loopKey = `${workspaceId}:${loopId}`;
        const alias = this.#inFlightLoops.get(loopKey);
        if (alias === undefined) return;
        this.#inFlightLoops.delete(loopKey);
        const work = this.#exclusive(async () => {
            await this.ensureLedger(workspaceId);
            const ledger = this.#ledgers.get(workspaceId);
            const rule = this.#rules.get(workspaceId)?.get(alias);
            const prev = ledger?.get(alias);
            if (ledger === undefined || rule === undefined || prev === undefined) return;
            const now = this.#clock();
            const entryKey = key(workspaceId, alias);
            if (result.status >= 400) {
                const armed = this.#armed.get(entryKey);
                if (armed !== undefined) {
                    if (armed.handle !== null) this.#timers.clear(armed.handle);
                    this.#armed.delete(entryKey);
                }
                const failureProblem = result.problem ?? problem(
                    "loop-failed",
                    result.status,
                    `Scheduled session loop ${loopId} for '${alias}' failed with status ${result.status}.`,
                    { alias, loopId, retryable: true },
                );
                ledger.set(alias, {
                    ...prev,
                    status: "fail",
                    loopId,
                    problem: failureProblem,
                });
            } else {
                const terminalDone = isTerminalObligation(rule, now);
                if (terminalDone) {
                    const armed = this.#armed.get(entryKey);
                    if (armed !== undefined) {
                        if (armed.handle !== null) this.#timers.clear(armed.handle);
                        this.#armed.delete(entryKey);
                    }
                }
                ledger.set(alias, {
                    ...prev,
                    status: terminalDone ? "done" : "open",
                    doneAt: terminalDone ? now : prev.doneAt,
                    lastDoneAt: now,
                    loopId,
                    problem: undefined,
                });
            }
            await this.#persistLedger(workspaceId);
        })
            .catch((cause: unknown) => {
                this.#report(`scheduled loop settlement failed for '${alias}' in workspace ${workspaceId}`, cause);
            })
            .finally(() => {
                this.#pending.delete(work);
                this.#settled(workspaceId, alias);
            });
        this.#pending.add(work);
    }

    #arm(workspaceId: number, rule: ScheduledRule, after = this.#clock()): void {
        if (this.#closing || rule.parsed === null) return;
        const entryKey = key(workspaceId, rule.alias);
        const existing = this.#armed.get(entryKey);
        if (existing !== undefined) {
            if (existing.handle !== null) this.#timers.clear(existing.handle);
            this.#armed.delete(entryKey);
        }
        const due = nextOccurrence(rule.parsed, after);
        if (due === null) return;
        const dueMs = due.epochMilliseconds;
        const fingerprint = hashDefinition(rule.definition);
        const armed: Armed = {
            workspaceId,
            rule,
            dueMs,
            event: `${rule.alias}/${fingerprint}/${dueMs}`,
            handle: null,
            delivering: false,
        };
        this.#armed.set(entryKey, armed);
        this.#setTimer(armed);
    }

    #setTimer(armed: Armed): void {
        armed.handle = this.#timers.set(
            () => { this.#fire(armed); },
            Math.max(0, Math.min(armed.dueMs - this.#clock(), MAX_TIMER_MS)),
        );
    }

    #fire(armed: Armed): void {
        const { workspaceId, rule } = armed;
        const entryKey = key(workspaceId, rule.alias);
        const delivery = (async () => {
            const admitted = await this.#exclusive(async () => {
                if (this.#closing || this.#armed.get(entryKey) !== armed || armed.delivering) return false;
                if (this.#clock() < armed.dueMs) {
                    this.#setTimer(armed);
                    return false;
                }
                if (this.#runningAliases.has(entryKey)) {
                    armed.handle = null;
                    this.#armed.delete(entryKey);
                    this.#arm(workspaceId, rule, this.#clock());
                    return false;
                }
                armed.handle = null;
                armed.delivering = true;
                this.#runningAliases.add(entryKey);
                return true;
            });
            if (!admitted) return;

            try {
                const firedAt = this.#clock();
                let outcome: DeliveryOutcome | null = null;
                let result: SchemeResult;
                try {
                    outcome = await this.#deliver(workspaceId, rule);
                    result = { status: 200 };
                } catch (cause) {
                    const failed = problemOf(rule.alias, cause);
                    result = { status: failed.status, problem: failed };
                    this.#report(`scheduled message '${rule.alias}' was not delivered in workspace ${workspaceId}`, cause);
                }

                await this.#exclusive(async () => {
                    try {
                        if (this.#armed.get(entryKey) !== armed) return;
                        this.#armed.delete(entryKey);
                        await this.ensureLedger(workspaceId);
                        const ledger = this.#ledgers.get(workspaceId)!;
                        const prev = ledger.get(rule.alias);
                        const hash = hashDefinition(rule.definition);
                        const createdAt = prev?.createdAt ?? firedAt;
                        if (result.status >= 400) {
                            ledger.set(rule.alias, {
                                definitionHash: hash,
                                createdAt,
                                status: "fail",
                                lastFiredAt: firedAt,
                                doneAt: null,
                                lastDoneAt: prev?.lastDoneAt ?? null,
                                loopId: null,
                                problem: result.problem!,
                            });
                        } else {
                            const nowAfter = this.#clock();
                            const terminalDone = outcome!.settled && isTerminalObligation(rule, nowAfter);
                            ledger.set(rule.alias, {
                                definitionHash: hash,
                                createdAt,
                                status: terminalDone ? "done" : "open",
                                lastFiredAt: firedAt,
                                doneAt: terminalDone ? nowAfter : null,
                                lastDoneAt: outcome!.settled ? nowAfter : (prev?.lastDoneAt ?? null),
                                loopId: outcome!.loopId,
                            });
                            if (!terminalDone) {
                                this.#arm(workspaceId, rule, nowAfter);
                            }
                        }
                        await this.#persistLedger(workspaceId);
                    } finally {
                        this.#runningAliases.delete(entryKey);
                    }
                });
            } finally {
                this.#runningAliases.delete(entryKey);
            }
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

    async #waitForStreamConclusion(
        port: DeliveryPort,
        workspaceId: number,
        sessionId: number,
        target: string,
    ): Promise<Readonly<Record<string, unknown>> | null> {
        const entryKey = streamKey(workspaceId, sessionId, target);
        if (this.#recentConcluded.has(entryKey)) {
            const cached = this.#recentConcluded.get(entryKey) ?? null;
            this.#recentConcluded.delete(entryKey);
            return cached;
        }
        if (port.readStreams === undefined) return null;
        const openStreams = await port.readStreams({ workspaceId, sessionId });
        const stillOpen = openStreams.some(
            (stream) => stream.target === target && stream.channels.some((ch) => ch.state === "active"),
        );
        if (!stillOpen) {
            const cached = this.#recentConcluded.get(entryKey) ?? null;
            this.#recentConcluded.delete(entryKey);
            return cached;
        }
        if (this.#closing) return null;
        return new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
            const waiter: StreamConcludedWaiter = {
                workspaceId,
                sessionId,
                target,
                resolve: (res) => {
                    this.#recentConcluded.delete(entryKey);
                    resolve(res);
                },
            };
            this.#streamWaiters.add(waiter);
            if (this.#recentConcluded.has(entryKey)) {
                this.#streamWaiters.delete(waiter);
                const cached = this.#recentConcluded.get(entryKey) ?? null;
                this.#recentConcluded.delete(entryKey);
                resolve(cached);
            }
        });
    }

    async #deliver(workspaceId: number, rule: ScheduledRule): Promise<DeliveryOutcome> {
        const port = this.#port;
        if (port === null) throw new Error("schedule Scheduler is not started");
        const source = `schedule://${encodeURIComponent(rule.alias)}`;

        if (isScriptDefinition(rule.definition)) {
            if (this.#lowerCalls === null || port.dispatchClientAction === undefined) {
                throw new ScheduleDeliveryError(problem(
                    "run-unsupported",
                    501,
                    "Scripted schedule execution is unavailable on this port.",
                    { alias: rule.alias, retryable: false },
                ));
            }
            const statements = await this.#lowerCalls(rule.definition.run, workspaceId);
            const results: ScheduledStepReceipt[] = [];
            let lastLoopId: number | null = null;
            for (let index = 0; index < statements.length; index += 1) {
                const statement = statements[index];
                const step = rule.definition.run[index] ?? rule.definition.run[rule.definition.run.length - 1];
                let capturedLoop: { readonly sessionId: number; readonly loopId: number } | null = null;
                const dispatched = await port.dispatchClientAction({
                    workspaceId,
                    actor: source,
                    statements: [statement],
                    onLoop: (loop) => { capturedLoop = loop; },
                });
                const opResult = dispatched[0] ?? { status: 500 };
                const stepLoopId = capturedLoop !== null
                    ? (capturedLoop as { readonly sessionId: number; readonly loopId: number }).loopId
                    : (typeof opResult.loopId === "number" ? opResult.loopId : null);
                if (stepLoopId !== null) lastLoopId = stepLoopId;

                let logRow: LogEntryWire | undefined;
                const activeLoop = capturedLoop as { readonly sessionId: number; readonly loopId: number } | null;
                if (activeLoop !== null && port.readLog !== undefined) {
                    const rows = await port.readLog({
                        workspaceId,
                        sessionId: activeLoop.sessionId,
                        loopId: activeLoop.loopId,
                        limit: 1,
                    });
                    logRow = rows[0];
                }
                const attrs: Record<string, unknown> = {
                    ...(isRecord(opResult.attrs) ? opResult.attrs : {}),
                    ...(logRow !== undefined && isRecord(logRow.attrs) ? logRow.attrs : {}),
                };
                const rawPathname = typeof attrs.pathname === "string" ? attrs.pathname : null;
                const streamTarget = typeof attrs.stream === "string"
                    ? attrs.stream
                    : rawPathname !== null && isExecution(statement)
                        ? `exec:///${statement.runtime}${rawPathname.startsWith("/") ? rawPathname : `/${rawPathname}`}`
                        : null;

                let stepStatus = opResult.status;
                let stepProblem = opResult.problem;
                let uri: string | undefined = typeof opResult.resource === "string"
                    ? opResult.resource
                    : logUriOf(logRow);
                let preview: string | undefined = previewOfResult(opResult);

                if (streamTarget !== null && activeLoop !== null) {
                    uri = streamTarget;
                    const concluded = stepStatus === 102
                        ? await this.#waitForStreamConclusion(port, workspaceId, activeLoop.sessionId, streamTarget)
                        : null;
                    if (concluded !== null) {
                        if (typeof concluded.status === "number") stepStatus = concluded.status;
                        const concludedProblem = Problems.fromError({ problem: concluded.problem });
                        if (concludedProblem !== null) stepProblem = concludedProblem;
                    }
                    if (port.readEntry !== undefined) {
                        const entryRead = await port.readEntry({
                            workspaceId,
                            sessionId: activeLoop.sessionId,
                            target: streamTarget,
                        });
                        const channels = entryRead.entry?.channels ?? {};
                        const resultChannel = channels.results ?? channels.result;
                        if (resultChannel !== undefined) {
                            if (resultChannel.state === "errored" && stepStatus < 400) stepStatus = 500;
                            preview = boundedPreview(resultChannel.content) ?? preview;
                        } else {
                            const parts: string[] = [];
                            for (const ch of Object.values(channels)) {
                                if (ch.content.length > 0) parts.push(ch.content);
                                if (ch.state === "errored" && stepStatus < 400) stepStatus = 500;
                            }
                            if (parts.length > 0) preview = boundedPreview(parts.join("\n"));
                        }
                    }
                }

                const receipt: ScheduledStepReceipt = {
                    index,
                    server: step.server,
                    tool: step.tool,
                    status: stepStatus,
                    ...(uri === undefined ? {} : { uri }),
                    ...(preview === undefined ? {} : { preview }),
                    ...(stepProblem === undefined ? {} : { problem: stepProblem }),
                };
                results.push(receipt);

                if (stepStatus >= 400) {
                    const failedProblem: ProblemDetails = stepProblem !== undefined
                        ? { ...stepProblem, alias: rule.alias, step: index, results }
                        : problem(
                            "run-failed",
                            stepStatus,
                            `Scheduled script '${rule.alias}' step ${index} (${step.server}.${step.tool}) failed with status ${stepStatus}.`,
                            { alias: rule.alias, step: index, results, retryable: false },
                        );
                    throw new ScheduleDeliveryError(failedProblem);
                }
            }
            return {
                settled: true,
                loopId: lastLoopId,
                results,
            };
        }

        const name = targetSessionName(rule.definition.target);
        const sessions = await port.listSessions(workspaceId);
        const existing = sessions.find((candidate) => candidate.name === name);
        if (existing !== undefined && existing.archived_at !== undefined && existing.archived_at !== null) {
            throw new ScheduleDeliveryError(problem(
                "target-archived",
                409,
                `Session '${name}' is archived.`,
                { alias: rule.alias, target: rule.definition.target, retryable: false },
            ));
        }

        let sessionId: number;
        if (existing !== undefined) {
            sessionId = existing.id;
        } else if (port.createSession !== undefined) {
            const created = await port.createSession({
                workspaceId,
                name,
                ...(rule.definition.persona === undefined ? {} : { persona: rule.definition.persona }),
            });
            sessionId = created.sessionId;
        } else {
            throw new ScheduleDeliveryError(problem(
                "target-missing",
                404,
                `No session named '${name}' exists in this workspace.`,
                { alias: rule.alias, target: rule.definition.target, retryable: true },
            ));
        }

        const loopResponse = await port.runLoop({
            workspaceId,
            sessionId,
            prompt: rule.definition.prompt,
            source,
        });
        const loopId = isRecord(loopResponse) && typeof loopResponse.loopId === "number"
            ? loopResponse.loopId
            : null;
        if (loopId !== null) {
            this.#inFlightLoops.set(`${workspaceId}:${loopId}`, rule.alias);
        }
        return { settled: false, loopId };
    }
}
