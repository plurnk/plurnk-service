import type { PlurnkStatement, ParsedPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { StreamEventNotify, WakeRunNotify } from "./ChannelWrite.ts";
import type { PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { schemeNameOf } from "./plurnk-uri.ts";

// Proposal lifecycle types. A scheme returns DispatchResult{status:202,attrs}
// to propose; dispatch writes a state='proposed' log entry, registers a waiter
// in #pending, and awaits resolution. Resolution arrives via
// Engine.resolveProposal(id, decision, body?) — from the loop/resolve RPC
// (Phase E.2), the in-tree YOLO listener (Phase E.3), or a timeout.
export type ProposalDecision = "accept" | "reject" | "cancel";
export interface ProposalResolution {
    decision: ProposalDecision;
    // Final body the resolver wants written/applied (e.g., reviewer-
    // edited content). INPUT to applyResolution; not in the model-facing
    // rx — the model sees the result via the entry/index now (post-F.5
    // and EDIT-registers-entry), not via input echoes.
    body?: string;
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

// External observers of pending-proposal events. sessionId is included so
// Daemon can scope its WS broadcast. attrs is the scheme-supplied payload
// (file diff, exec command, etc.) the client needs to render review UI.
// flags carries the loop's persisted flags so listeners (YOLO auto-accept,
// the client-facing notification) can decide policy without a second DB
// roundtrip — loaded once at dispatch, shared with all listeners.
export interface ProposalPendingEvent {
    logEntryId: number;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: object;
    flags: LoopFlags;
    // #note10 — the target entry diverged on disk this turn (ambient change since the
    // model's prior turn), so the model's EDIT is based on a stale read. A server-YOLO
    // auto-accept would silently clobber the ambient change; YOLO rejects when set.
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
// arrives — from the loop/resolve RPC, the in-tree YOLO listener, or the
// timeout — then the scheme's applyResolution hook applies the accept.
export default class ProposalLifecycle {
    #db: Db;
    #schemes: SchemeRegistry;
    #telemetry: TelemetryChannel;
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeRunNotify: WakeRunNotify | undefined;
    #tokenize: (text: string) => number;
    #mimetypes: Mimetypes | undefined;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    // Proposal lifecycle: pending dispatch pauses waiting for resolution.
    // Dispatch awaits the promise when a scheme returns status 202;
    // Engine.resolveProposal feeds the resolution back in. Map is per-log-
    // entry-id; entries clear on resolution. SPEC.md §engine-rails + §methods (loop.resolve).
    #pending = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Daemon subscribes
    // here to push `loop/proposal` notifications when an entry enters
    // pending state. YOLO listener (Phase E.3) subscribes here too. Lean
    // event emitter — no priority, no veto chain at this layer; filter
    // chains come later if a real consumer needs them.
    #listeners: Array<(payload: ProposalPendingEvent) => void> = [];

    constructor({ db, schemes, telemetry, streamEventNotify, wakeRunNotify, tokenize, mimetypes, executors, loopSignal }: {
        db: Db;
        schemes: SchemeRegistry;
        telemetry: TelemetryChannel;
        streamEventNotify?: StreamEventNotify;
        wakeRunNotify?: WakeRunNotify;
        tokenize: (text: string) => number;
        mimetypes?: Mimetypes;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#telemetry = telemetry;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeRunNotify = wakeRunNotify;
        this.#tokenize = tokenize;
        this.#mimetypes = mimetypes;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
    }

    // External API to feed a resolution into a pending proposal. Called by
    // the loop/resolve RPC handler (Phase E.2), the in-tree YOLO listener
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

    // Subscribe to proposal-pending events. Daemon registers a listener
    // that broadcasts the loop/proposal WS notification; YOLO listener
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
    async runApply(
        statement: PlurnkStatement,
        originalResult: DispatchResult,
        resolution: ProposalResolution,
        ids: { sessionId: number; runId: number; loopId: number; turnId: number },
    ): Promise<ProposalResolution> {
        const { sessionId, runId, loopId, turnId } = ids;
        if (resolution.decision !== "accept") return resolution;
        // EXEC routes to the exec scheme regardless of target (cwd, not
        // a scheme address). All other ops resolve their handler from
        // statement.target's scheme.
        // COPY/MOVE write the DEST (statement.body), not the source (target): the
        // accept must reach the dest scheme's applyResolution (File writes disk).
        const schemeName = statement.op === "EXEC" ? "exec"
            : (statement.op === "COPY" || statement.op === "MOVE") ? schemeNameOf(statement.body as ParsedPath | null)
            : schemeNameOf(statement.target);
        if (schemeName === null) return resolution;
        const handler = this.#schemes.get(schemeName) as
            | { applyResolution?: (args: { attrs: object; body?: string }, ctx: PlurnkSchemeContext) => Promise<{ status: number; outcome?: string; body?: string }> }
            | undefined;
        if (handler === undefined || typeof handler.applyResolution !== "function") return resolution;
        try {
            // Build a ctx for the scheme's applyResolution. The proposal
            // was raised inside a specific (session, run, loop, turn);
            // the scheme uses ctx to write the entry that makes the
            // operation's artifact visible in the next packet's index.
            const applyCtx: PlurnkSchemeContext = {
                db: this.#db, sessionId, runId, loopId, turnId,
                writer: "model", signal: this.#loopSignal(loopId),
                streamEventNotify: this.#streamEventNotify,
                wakeRunNotify: this.#wakeRunNotify,
                tokenize: this.#tokenize,
                mimetypes: this.#mimetypes,
                pushTelemetry: (event) => this.#telemetry.push(sessionId, loopId, event),
                executors: this.#executors(),
            };
            const applyResult = await handler.applyResolution({
                attrs: (originalResult.attrs ?? {}) as object,
                body: resolution.body,
            }, applyCtx);
            if (applyResult.status >= 400) {
                return {
                    decision: "reject",
                    outcome: applyResult.outcome ?? "apply_failed",
                    body: applyResult.body,
                };
            }
            // Propagate applyResolution.outcome onto the accepted resolution
            // (operational metadata, e.g. exec's "exit_N") AND its body — an
            // inline (read/pure) run returns its output as the body, which has
            // to reach the model-facing result this turn, not just stream to
            // the entry. Host accepts carry no body (fire-and-forget).
            const withOutcome = applyResult.outcome !== undefined && resolution.outcome === undefined
                ? { ...resolution, outcome: applyResult.outcome }
                : resolution;
            return applyResult.body === undefined ? withOutcome : { ...withOutcome, body: applyResult.body };
        } catch (err) {
            return {
                decision: "reject",
                outcome: "apply_threw",
                body: err instanceof Error ? err.message : String(err),
            };
        }
    }

    async applyResolution(logEntryId: number, resolution: ProposalResolution): Promise<DispatchResult> {
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default) §proposal-reject-fails
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default) §proposal-cancel-aborts
        // resolution.outcome wins over the default when supplied; this is how
        // veto filters (Phase E.2 proposal.accepting) can specify a more
        // precise outcome string like 'policy_veto' or 'timeout'.
        const decision = resolution.decision;
        const state = decision === "accept" ? "resolved"
            : decision === "reject" ? "failed"
            : "cancelled";
        const status = decision === "accept" ? 200
            : decision === "reject" ? 400
            : 499;
        const defaultOutcome = decision === "accept" ? null
            : decision === "reject" ? "rejected"
            : "loop_aborted";
        const outcome = resolution.outcome ?? defaultOutcome;
        // rx is the model-facing operation result. Status always. Body is normally dropped —
        // the propose preview was an input echo — EXCEPT an inline auto-run (read/pure) carries
        // its run output AS the body, the "what happened" the model needs this turn. A non-accept
        // carries the outcome TOKEN as its terse error (write_failed / rejected / timeout — one
        // word, never prose): a bare {"status":400} left the model blind to a mechanically failed
        // apply and parking on a phantom worker (the fan-out digest).
        const rx = (decision === "accept" && resolution.body !== undefined)
            ? JSON.stringify({ status, body: resolution.body })
            : decision === "accept"
                ? JSON.stringify({ status })
                : JSON.stringify({ status, error: outcome });
        await (this.#db.engine_resolve_log_entry as PrepMethod).run({
            id: logEntryId, state, outcome, status_rx: status, rx,
        });
        return { status, outcome, body: resolution.body };
    }
}
