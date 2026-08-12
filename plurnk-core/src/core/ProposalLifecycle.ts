import {
    InvalidOperationResultError,
    PLURNK_OPS,
    Validator,
    type OperationResult,
    type PlurnkOp,
    type PlurnkStatement,
    type ProposalDisposition,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type { PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import { observedSync } from "../observe/spans.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { ProposalApplyResult, SchemeCtx } from "@plurnk/plurnk-schemes";
import Results, { OperationFailureError } from "./results.ts";

// Proposal lifecycle types. A scheme returns DispatchResult{status:202,attrs}
// to propose; dispatch writes a state='proposed' log entry, registers a waiter
// in #pending, and awaits resolution. Resolution arrives via
// Engine.resolveProposal(id, decision, body?) — from the CoreSeam resolution call,
// core-owned disposition, or a timeout.
export type ProposalDecision = "accept" | "reject" | "cancel";
export interface ProposalResolution {
    decision: ProposalDecision;
    // Final body the resolver wants written/applied (e.g., reviewer-edited
    // content) — INPUT to applyResolution, not echoed back verbatim. The applied
    // result reaches the model via the scheme's applyResult body (e.g. the EDIT diff).
    body?: string;
    // Structured model-facing result produced by the accepted scheme apply.
    // Unlike the resolver body, this describes what actually landed.
    result?: object;
    // Operational reason (rejected / timeout / write_failed / policy_veto / etc.).
    // Stored on log_entries.outcome COLUMN for forensics; a NON-accept also
    // carries it as the rx's terse error token — the one-word why the model
    // acts on (a mechanically failed apply must not read like a mute 400).
    outcome?: string;
}
interface ProposalWaiter {
    resolve: (resolution: ProposalResolution) => void;
    timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export interface ProposalSettlement {
    resolution: ProposalResolution;
    applied?: DispatchResult;
}

// External observation of the contracts-owned projection. workspaceId is
// additional internal scope for Daemon's event envelope; it is deliberately
// absent from ProposalProjection itself.
export interface ProposalPendingEvent extends ProposalProjection {
    workspaceId: number;
}

interface ProposalRow {
    logEntryId: number;
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
    op: string;
    signal: string | null;
    scheme: string | null;
    pathname: string | null;
    rx: string;
    attrs: string;
    loop_flags: string;
}

const PROPOSAL_OPS = new Set<string>(PLURNK_OPS);

// {§proposal-timeout-cancels} — empty means an indefinite wait; a positive
// millisecond value opts into a bound. An explicit invalid value is a broken
// operator contract, never another spelling of the indefinite default.
const readProposalTimeoutMs = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new RangeError(
            `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS must be empty or a finite positive number of milliseconds; got ${JSON.stringify(raw)}`,
        );
    }
    return n;
};

// The proposal lifecycle (SPEC.md {§engine-rails} + {§methods-proposal-resolve}): a
// side-effecting op that returns 202 pauses in dispatch until a resolution
// arrives — from a client-interface resume, core-owned disposition, or the
// timeout — then the scheme's applyResolution hook applies the accept.
export default class ProposalLifecycle {
    #db: Db;
    #schemes: SchemeRegistry;
    #notices: NoticeChannel;
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #tokenize: (text: string) => number;
    #mimetypes: Mimetypes | undefined;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    #liveSubscriptions: LiveSubscriptions;
    // Proposal lifecycle: pending dispatch pauses waiting for resolution.
    // Dispatch awaits the promise when a scheme returns status 202;
    // Engine.resolveProposal feeds the resolution back in. Map is per-log-
    // entry-id; entries clear on resolution. SPEC.md {§engine-rails} + {§methods-proposal-resolve}.
    #pending = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Correctness policy is
    // deliberately absent: loop-owned settlement happens in this owner before
    // observers run, so an observer cannot become a hidden policy fallback.
    #listeners: Array<(payload: ProposalPendingEvent) => void> = [];

    constructor({ db, schemes, notices, streamEventNotify, wakeWorkerNotify, tokenize, mimetypes, executors, loopSignal, liveSubscriptions }: {
        db: Db;
        schemes: SchemeRegistry;
        notices: NoticeChannel;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        tokenize: (text: string) => number;
        mimetypes?: Mimetypes;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        liveSubscriptions: LiveSubscriptions;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#notices = notices;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#tokenize = tokenize;
        this.#mimetypes = mimetypes;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#liveSubscriptions = liveSubscriptions;
    }

    // External API to feed a resolution into a pending proposal. Called by
    // the CoreSeam resolution call, core-owned disposition, or the timeout
    // watcher. Throws when the logEntryId has no
    // pending waiter — duplicate resolutions, IDs for non-proposed entries,
    // or entries already-resolved are caller errors.
    resolve(logEntryId: number, resolution: ProposalResolution): void {
        observedSync( // {§observability-boundary}
            "proposal.resolve",
            { "entry.id": logEntryId, decision: resolution.decision },
            () => {
                this.#resolveSettled(logEntryId, resolution);
            },
        );
    }

    #resolveSettled(logEntryId: number, resolution: ProposalResolution): void {
        const waiter = this.#pending.get(logEntryId);
        if (waiter === undefined) {
            throw new OperationFailureError(Results.failure(
                "proposal:resolution",
                "proposal-not-pending",
                409,
                `Proposal ${logEntryId} is not pending.`,
                {},
                {
                    logEntryId,
                    stage: "proposal-resolution",
                    recovery: "Refresh pending proposals before resolving one.",
                    retryable: false,
                },
            ));
        }
        if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
        this.#pending.delete(logEntryId);
        waiter.resolve(resolution);
    }

    // Snapshot of pending proposals for client-interface discovery. Returns
    // the log entry IDs currently awaiting resolution.
    pendingIds(): number[] {
        return [...this.#pending.keys()];
    }

    async pending(logEntryId: number): Promise<ProposalPendingEvent> {
        const row = await this.#db.proposal_get_pending.get<ProposalRow>({ log_entry_id: logEntryId });
        if (row === undefined) throw new Error(`Pending proposal ${logEntryId} has no durable proposed row.`);
        return this.#project(row);
    }

    async list(workspaceId: number): Promise<ProposalProjection[]> {
        const rows = await this.#db.proposal_list_pending.all<ProposalRow>({ workspace_id: workspaceId });
        // {§proposal-list} — the durable row carries review material, while
        // #pending carries this process's callable resolution owner. Discovery
        // exposes only their intersection; persistence alone cannot fabricate
        // a resolvable stopped world.
        const projected = await Promise.all(
            rows.filter((row) => this.#pending.has(row.logEntryId)).map((row) => this.#project(row)),
        );
        return projected.map(({ workspaceId: _workspaceId, ...proposal }) => proposal);
    }

    settleOwned(proposal: ProposalPendingEvent): void {
        if (proposal.disposition.owner !== "loop") return;
        const { decision, outcome } = proposal.disposition;
        this.resolve(proposal.logEntryId, {
            decision,
            ...(outcome === undefined ? {} : { outcome }),
        });
    }

    #abandon(logEntryId: number): void {
        const waiter = this.#pending.get(logEntryId);
        if (waiter === undefined) return;
        if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
        this.#pending.delete(logEntryId);
    }

    async failPreparation(logEntryId: number, cause: unknown): Promise<void> {
        this.#abandon(logEntryId);
        const failure = Results.failure(
            "proposal:policy",
            "proposal-policy-failed",
            500,
            "Core could not establish the proposal's settlement policy.",
            {},
            {
                logEntryId,
                stage: "proposal-policy",
                retryable: false,
            },
        );
        try {
            await this.applyResolution(logEntryId, {
                resolution: { decision: "reject", outcome: "policy_failed" },
                applied: failure,
            });
        } catch (terminalCause) {
            throw new AggregateError(
                [cause, terminalCause],
                `Proposal ${logEntryId} policy failed and its durable row could not be terminalized.`,
            );
        }
    }

    // {§worker-lifecycle-total-reap}: shutdown cancels every process-local proposal waiter.
    cancelAll(outcome: string): void {
        for (const [logEntryId, waiter] of [...this.#pending.entries()]) {
            if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
            this.#pending.delete(logEntryId);
            waiter.resolve({ decision: "cancel", outcome });
        }
    }

    // Subscribe to proposal-pending observations. These listeners never own
    // resolution policy; client-owned proposals may resolve through the public
    // seam after observing the event.
    onPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#listeners.push(listener);
    }

    notifyPending(event: ProposalPendingEvent): void {
        for (const listener of this.#listeners) {
            try { listener(event); }
            catch (cause) { console.error("proposal pending observer failed:", cause); }
        }
    }

    async #project(row: ProposalRow): Promise<ProposalPendingEvent> {
        const op = ProposalLifecycle.#op(row);
        const attrs = ProposalLifecycle.#objectJson(row.logEntryId, "attrs", row.attrs);
        const result = ProposalLifecycle.#result(row.logEntryId, row.rx);
        const flags = LoopFlagsReader.parse(row.loop_flags, row.loopId);
        const target = ProposalLifecycle.#target(row, op, attrs);
        const operatorQuestion = ProposalLifecycle.#operatorQuestion(row, op, attrs);
        const diverged = await this.#db.engine_target_diverged_this_turn.get<{ hit: number }>({
            worker_id: row.workerId,
            turn_id: row.turnId,
            scheme: target.scheme,
            pathname: target.pathname,
        });
        const staleClobberRisk = diverged !== undefined;
        const proposal = Validator.assertProposalProjection({
            logEntryId: row.logEntryId,
            workerId: row.workerId,
            loopId: row.loopId,
            turnId: row.turnId,
            op,
            target,
            body: typeof result.body === "string" ? result.body : "",
            attrs,
            flags,
            staleClobberRisk,
            disposition: ProposalLifecycle.#disposition(operatorQuestion, flags, staleClobberRisk),
        });
        return { ...proposal, workspaceId: row.workspaceId };
    }

    static #op(row: ProposalRow): PlurnkOp {
        if (!PROPOSAL_OPS.has(row.op)) {
            throw new Error(`Pending proposal ${row.logEntryId} has invalid operation ${JSON.stringify(row.op)}.`);
        }
        return row.op as PlurnkOp;
    }

    static #objectJson(logEntryId: number, field: string, raw: string): Record<string, unknown> {
        try {
            const value: unknown = JSON.parse(raw);
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new TypeError(`${field} is not an object`);
            }
            return value as Record<string, unknown>;
        } catch (cause) {
            throw new Error(`Pending proposal ${logEntryId} has invalid ${field} JSON.`, { cause });
        }
    }

    static #result(logEntryId: number, raw: string): OperationResult {
        try {
            const value: unknown = JSON.parse(raw);
            const result = Validator.assertOperationResult(value as OperationResult);
            if (result.status !== 202) throw new TypeError(`status is ${result.status}, not 202`);
            return result;
        } catch (cause) {
            throw new Error(`Pending proposal ${logEntryId} has invalid proposed result JSON.`, { cause });
        }
    }

    static #target(
        row: ProposalRow,
        op: PlurnkOp,
        attrs: Record<string, unknown>,
    ): { scheme: string | null; pathname: string | null } {
        const routed = attrs.proposalTarget;
        if (routed === undefined) {
            if (op === "COPY" || op === "MOVE") {
                throw new Error(`Pending proposal ${row.logEntryId} has no canonical ${op} proposal target.`);
            }
            return { scheme: row.scheme, pathname: row.pathname };
        }
        if (
            routed === null
            || typeof routed !== "object"
            || Array.isArray(routed)
            || typeof (routed as { scheme?: unknown }).scheme !== "string"
            || typeof (routed as { pathname?: unknown }).pathname !== "string"
        ) {
            throw new Error(`Pending proposal ${row.logEntryId} has an invalid canonical proposal target.`);
        }
        return {
            scheme: (routed as { scheme: string }).scheme === "file"
                ? null
                : (routed as { scheme: string }).scheme,
            pathname: (routed as { pathname: string }).pathname,
        };
    }

    static #operatorQuestion(
        row: ProposalRow,
        op: PlurnkOp,
        attrs: Record<string, unknown>,
    ): boolean {
        if (op !== "SEND" || row.signal === null) return false;
        let signal: unknown;
        try {
            signal = JSON.parse(row.signal);
        } catch (cause) {
            throw new Error(`Pending proposal ${row.logEntryId} has invalid signal JSON.`, { cause });
        }
        if (signal !== 300) return false;
        if (typeof attrs.question !== "string") {
            throw new Error(`Pending SEND signal 300 proposal ${row.logEntryId} has no question.`);
        }
        return true;
    }

    static #disposition(
        operatorQuestion: boolean,
        flags: LoopFlags,
        staleClobberRisk: boolean,
    ): ProposalDisposition {
        if (flags.auto) {
            if (operatorQuestion) return { owner: "client" };
            return staleClobberRisk
                ? { owner: "loop", decision: "reject", outcome: "stale_read_clobber" }
                : { owner: "loop", decision: "accept" };
        }
        if (flags.noProposals) {
            return { owner: "loop", decision: "reject", outcome: "no_review_channel" };
        }
        return { owner: "client" };
    }

    awaitResolution(logEntryId: number): Promise<ProposalResolution> {
        const timeoutMs = readProposalTimeoutMs();
        return new Promise<ProposalResolution>((resolve) => {
            const timeoutHandle = timeoutMs === null ? null : setTimeout(() => {
                // Operator-bounded lane only: synthesize a cancel resolution through the same
                // path as any other. State transitions to cancelled with outcome='timeout'.
                if (this.#pending.has(logEntryId)) {
                    this.#pending.delete(logEntryId);
                    resolve({ decision: "cancel", outcome: "timeout" }); // {§proposal-timeout-cancels}
                }
            }, timeoutMs);
            this.#pending.set(logEntryId, { resolve, timeoutHandle });
        });
    }

    // On accept, run the scheme's applyResolution — File writes disk, Exec spawns. {§proposal-accept-applies}
    async workerApply(
        statement: PlurnkStatement,
        originalResult: DispatchResult,
        resolution: ProposalResolution,
        ids: { workspaceId: number; workerId: number; loopId: number; turnId: number },
    ): Promise<ProposalSettlement> {
        const { workspaceId, workerId, loopId, turnId } = ids;
        if (resolution.decision !== "accept") return { resolution };
        // EXEC routes to the exec scheme regardless of target (cwd, not
        // a scheme address). All other ops resolve their handler from
        // statement.target's scheme.
        // COPY/MOVE write the DEST (statement.body), not the source (target): the
        // accept must reach the dest scheme's applyResolution (File writes disk).
        const routedScheme = (originalResult.attrs as { proposalScheme?: unknown } | undefined)?.proposalScheme;
        const schemeName = typeof routedScheme === "string"
            ? routedScheme
            : statement.op === "EXEC"
                ? "exec"
                : (statement.op === "COPY" || statement.op === "MOVE")
                    ? schemeNameOf(statement.body?.target ?? null)
                    : schemeNameOf(statement.target);
        if (schemeName === null) return { resolution };
        const handler = this.#schemes.get(schemeName) as
            | { applyResolution?: (args: { attrs: object; body?: string }, ctx: SchemeCtx) => Promise<ProposalApplyResult> }
            | undefined;
        if (handler === undefined || typeof handler.applyResolution !== "function") return { resolution };
        try {
            // Build a ctx for the scheme's applyResolution. The proposal
            // was raised inside a specific (workspace, worker, loop, turn);
            // the scheme uses ctx to write the entry that makes the
            // operation's artifact visible in the next packet's index.
            const applyCtx: PlurnkSchemeContext = {
                db: this.#db, workspaceId, workerId, loopId, turnId,
                writer: "model", signal: this.#loopSignal(loopId),
                streamEventNotify: this.#streamEventNotify,
                wakeWorkerNotify: this.#wakeWorkerNotify,
                tokenize: this.#tokenize,
                mimetypes: this.#mimetypes,
                pushNotice: (notice) => this.#notices.push(workspaceId, loopId, notice),
                executors: this.#executors(),
            };
            const request = {
                attrs: (originalResult.attrs ?? {}) as object,
                body: resolution.body,
            };
            const manifest = this.#schemes.manifestFor(schemeName);
            if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
            const applyResult = Results.assert(await handler.applyResolution(request, new SchemeCtxImpl(applyCtx, schemeName, manifest, this.#liveSubscriptions)));
            if (applyResult.status >= 400) {
                return {
                    resolution: {
                        ...resolution,
                        outcome: typeof applyResult.outcome === "string" ? applyResult.outcome : "apply_failed",
                    },
                    applied: applyResult,
                };
            }
            // Propagate applyResolution.outcome onto the accepted resolution
            // (operational metadata, e.g. exec's "started") AND its body — the applied result the
            // model must see THIS turn: a file EDIT's line-numbered diff, a [300] answer. EXEC
            // never uses the body rail — its output streams uniformly ({§exec-stream}, NO same-turn
            // in-body exception; automatic admission only skips the review pause) and is READ next turn.
            const withOutcome = applyResult.outcome !== undefined && resolution.outcome === undefined
                ? { ...resolution, outcome: applyResult.outcome }
                : resolution;
            return {
                resolution: {
                    ...withOutcome,
                    ...(applyResult.body !== undefined ? { body: applyResult.body as string } : {}),
                    ...(applyResult.result !== undefined ? { result: applyResult.result as object } : {}),
                },
                applied: applyResult,
            };
        } catch (err) {
            console.error(`Proposal application failed for scheme '${schemeName}':`, err);
            return {
                resolution: { ...resolution, outcome: "apply_threw" },
                applied: Results.failure(
                    `scheme:${schemeName}`,
                    "proposal-apply-threw",
                    500,
                    `Scheme '${schemeName}' failed outside its proposal application contract.`,
                    { outcome: "apply_threw" },
                    {
                        stage: "proposal-application",
                        retryable: false,
                    },
                ),
            };
        }
    }

    async applyResolution(logEntryId: number, settlement: ProposalSettlement): Promise<DispatchResult> {
        const { resolution, applied } = settlement;
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default) {§proposal-reject-fails}
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default) {§proposal-cancel-aborts}
        // resolution.outcome wins over the default when supplied; this is how
        // veto filters (Phase E.2 proposal.accepting) can specify a more
        // precise outcome string like 'policy_veto' or 'timeout'.
        const decision = resolution.decision;
        const appliedFailed = applied !== undefined && applied.status >= 400;
        const state = appliedFailed ? "failed"
            : decision === "accept" ? "resolved"
            : decision === "reject" ? "failed"
            : "cancelled";
        const status = appliedFailed ? applied.status
            : decision === "accept" ? 200
            : decision === "reject" ? 400
            : 499;
        const defaultOutcome = decision === "accept" ? null
            : decision === "reject" ? "rejected"
            : "loop_aborted";
        const appliedOutcome = applied !== undefined && typeof applied.outcome === "string" ? applied.outcome : null;
        const outcome = resolution.outcome ?? appliedOutcome ?? defaultOutcome;
        const projected = resolution.result ?? {};
        for (const reserved of ["status", "problem", "error"]) {
            if (Object.hasOwn(projected, reserved)) {
                throw new InvalidOperationResultError(
                    `Proposal result fields cannot override reserved operation result field '${reserved}'.`,
                );
            }
        }
        let result: DispatchResult;
        if (appliedFailed) {
            result = applied;
        } else if (decision === "accept") {
            result = Results.assert({
                status,
                ...(resolution.body !== undefined ? { body: resolution.body } : {}),
                ...projected,
                ...(outcome !== null ? { outcome } : {}),
            });
        } else {
            const code = decision === "reject" ? "rejected" : "cancelled";
            const action = decision === "reject" ? "rejected" : "cancelled";
            const detail = `The proposal was ${action}${outcome === null ? "." : ` (${outcome}).`}`;
            result = Results.failure("proposal", code, status, detail, {
                ...(outcome !== null ? { outcome } : {}),
            }, {
                stage: "proposal-settlement",
                retryable: false,
            });
        }
        const coordinate = await this.#db.engine_log_entry_coordinate.get<{
            loop_seq: number;
            turn_seq: number;
            sequence: number;
            op: string;
        }>({ id: logEntryId });
        if (coordinate === undefined) throw new Error(`ProposalLifecycle.applyResolution: log entry ${logEntryId} has no coordinate`);
        Results.attachInstance(result, `log:///${coordinate.loop_seq}/${coordinate.turn_seq}/${coordinate.sequence}/${coordinate.op}`);
        const rx = JSON.stringify(result);
        await this.#db.engine_resolve_log_entry.run({
            id: logEntryId, state, outcome, status_rx: status, rx,
        });
        return result;
    }
}
