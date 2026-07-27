import type { PlurnkStatement, ParsedPath } from "@plurnk/plurnk-grammar";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type { PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { SchemeCtx } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

// Proposal lifecycle types. A scheme returns DispatchResult{status:202,attrs}
// to propose; dispatch writes a state='proposed' log entry, registers a waiter
// in #pending, and awaits resolution. Resolution arrives via
// Engine.resolveProposal(id, decision, body?) — from the loop/resolve RPC
// (Phase E.2), the in-tree auto listener (Phase E.3), or a timeout.
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

// External observers of pending-proposal events. workspaceId is included so
// Daemon can scope its WS broadcast. attrs is the scheme-supplied payload
// (file diff, exec command, etc.) the client needs to render review UI.
// flags carries the loop's persisted flags so listeners (auto resolution,
// the client-facing notification) can decide policy without a second DB
// roundtrip — loaded once at dispatch, shared with all listeners.
export interface ProposalPendingEvent {
    logEntryId: number;
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: object;
    flags: LoopFlags;
    // #note10 — the target entry diverged on disk this turn (ambient change since the
    // model's prior turn), so the model's EDIT is based on a stale read. Loop auto
    // would silently clobber the ambient change; its listener rejects when set.
    staleClobberRisk: boolean;
}

// Resolution timeout — OFF by default (owner ruling, the AG-UI migration's first surfaced
// decision): a stopped world awaiting a human WAITS — the human's absence is not an answer,
// and a silent five-minute cancel is the machine deciding it was. The [102]<-1> doctrine's
// sibling: waiting is a mode of continuing. An operator whose deployment needs a bound sets
// PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS explicitly (the decision table); empty = indefinite.
const readProposalTimeoutMs = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
};

// The proposal lifecycle (SPEC.md §engine-rails + §methods loop.resolve): a
// side-effecting op that returns 202 pauses in dispatch until a resolution
// arrives — from the loop/resolve RPC, the in-tree auto listener, or the
// timeout — then the scheme's applyResolution hook applies the accept.
export default class ProposalLifecycle {
    #db: Db;
    #schemes: SchemeRegistry;
    #telemetry: TelemetryChannel;
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
    // entry-id; entries clear on resolution. SPEC.md §engine-rails + §methods (loop.resolve).
    #pending = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Daemon subscribes
    // here to push `loop/proposal` notifications when an entry enters
    // pending state. auto listener (Phase E.3) subscribes here too. Lean
    // event emitter — no priority, no veto chain at this layer; filter
    // chains come later if a real consumer needs them.
    #listeners: Array<(payload: ProposalPendingEvent) => void> = [];

    constructor({ db, schemes, telemetry, streamEventNotify, wakeWorkerNotify, tokenize, mimetypes, executors, loopSignal, liveSubscriptions }: {
        db: Db;
        schemes: SchemeRegistry;
        telemetry: TelemetryChannel;
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
        this.#telemetry = telemetry;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#tokenize = tokenize;
        this.#mimetypes = mimetypes;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#liveSubscriptions = liveSubscriptions;
    }

    // External API to feed a resolution into a pending proposal. Called by
    // the loop/resolve RPC handler (Phase E.2), the in-tree auto listener
    // (Phase E.3), or the timeout watcher. Throws when the logEntryId has no
    // pending waiter — duplicate resolutions, IDs for non-proposed entries,
    // or entries already-resolved are caller errors.
    resolve(logEntryId: number, resolution: ProposalResolution): void {
        const waiter = this.#pending.get(logEntryId);
        if (waiter === undefined) {
            throw new Error(`Engine.resolveProposal: no pending proposal for log_entry ${logEntryId}`);
        }
        if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
        this.#pending.delete(logEntryId);
        waiter.resolve(resolution);
    }

    // Snapshot of pending proposals (for diagnostic / RPC listings). Returns
    // the log entry IDs currently awaiting resolution.
    pendingIds(): number[] {
        return [...this.#pending.keys()];
    }

    // Daemon shutdown: settle EVERY pending waiter with a cancel so the stopped world can't
    // deadlock the stop — a drain paused inside dispatch awaiting a resolution that will never
    // come held Promise.allSettled(drains) open forever (a daemon with a pending HITL proposal
    // could not shut down; the #344 wedge class). §proposal-cancel-aborts — same cancel lane as
    // a timeout, outcome names the cause.
    cancelAll(outcome: string): void {
        for (const [logEntryId, waiter] of [...this.#pending.entries()]) {
            if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
            this.#pending.delete(logEntryId);
            waiter.resolve({ decision: "cancel", outcome });
        }
    }

    // Subscribe to proposal-pending events. Daemon registers a listener
    // that broadcasts the loop/proposal WS notification; auto listener
    // (Phase E.3) registers one that auto-resolves. Listeners fire BEFORE
    // dispatch awaits resolution, so synchronous (or fast-async) handlers
    // can resolve inline.
    onPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#listeners.push(listener);
    }

    notifyPending(event: ProposalPendingEvent): void {
        for (const listener of this.#listeners) {
            try { listener(event); } catch (_) { /* listener errors don't break dispatch */ }
        }
    }

    awaitResolution(logEntryId: number): Promise<ProposalResolution> {
        const timeoutMs = readProposalTimeoutMs();
        return new Promise<ProposalResolution>((resolve) => {
            const timeoutHandle = timeoutMs === null ? null : setTimeout(() => {
                // Operator-bounded lane only: synthesize a cancel resolution through the same
                // path as any other. State transitions to cancelled with outcome='timeout'.
                if (this.#pending.has(logEntryId)) {
                    this.#pending.delete(logEntryId);
                    resolve({ decision: "cancel", outcome: "timeout" }); // §proposal-timeout-cancels
                }
            }, timeoutMs);
            this.#pending.set(logEntryId, { resolve, timeoutHandle });
        });
    }

    // On accept, run the scheme's applyResolution — File writes disk, Exec spawns. §proposal-accept-applies
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
        const schemeName = statement.op === "EXEC" ? "exec"
            : (statement.op === "COPY" || statement.op === "MOVE") ? schemeNameOf(statement.body as ParsedPath | null)
            : schemeNameOf(statement.target);
        if (schemeName === null) return { resolution };
        const handler = this.#schemes.get(schemeName) as
            | { applyResolution?: (args: { attrs: object; body?: string }, ctx: SchemeCtx) => Promise<{ status: number; outcome?: string; body?: string; result?: object }> }
            | undefined;
        if (handler === undefined || typeof handler.applyResolution !== "function") return { resolution };
        try {
            // Build a ctx for the scheme's applyResolution. The proposal
            // was raised inside a specific (workspace, run, loop, turn);
            // the scheme uses ctx to write the entry that makes the
            // operation's artifact visible in the next packet's index.
            const applyCtx: PlurnkSchemeContext = {
                db: this.#db, workspaceId, workerId, loopId, turnId,
                writer: "model", signal: this.#loopSignal(loopId),
                streamEventNotify: this.#streamEventNotify,
                wakeWorkerNotify: this.#wakeWorkerNotify,
                tokenize: this.#tokenize,
                mimetypes: this.#mimetypes,
                pushTelemetry: (event) => this.#telemetry.push(workspaceId, loopId, event),
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
            // never uses the body rail — its output streams uniformly (§exec-stream, NO same-turn
            // in-body exception; inline only skips the review pause) and is READ next turn.
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
            return {
                resolution: { ...resolution, outcome: "apply_threw" },
                applied: Results.failure(
                    `scheme:${schemeName}`,
                    "proposal-apply-threw",
                    500,
                    err instanceof Error ? err.message : String(err),
                    { outcome: "apply_threw" },
                ),
            };
        }
    }

    async applyResolution(logEntryId: number, settlement: ProposalSettlement): Promise<DispatchResult> {
        const { resolution, applied } = settlement;
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default) §proposal-reject-fails
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default) §proposal-cancel-aborts
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
        let result: DispatchResult;
        if (appliedFailed) {
            result = applied;
        } else if (decision === "accept") {
            result = Results.assert({
                status,
                ...(resolution.body !== undefined ? { body: resolution.body } : {}),
                ...(resolution.result ?? {}),
                ...(outcome !== null ? { outcome } : {}),
            });
        } else {
            const code = decision === "reject" ? "rejected" : "cancelled";
            const action = decision === "reject" ? "rejected" : "cancelled";
            const detail = `The proposal was ${action}${outcome === null ? "." : ` (${outcome}).`}`;
            result = Results.failure("proposal", code, status, detail, {
                ...(outcome !== null ? { outcome } : {}),
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
