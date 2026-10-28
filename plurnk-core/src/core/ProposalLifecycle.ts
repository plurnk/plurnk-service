import {
    CapabilityAdmission,
    InvalidOperationResultError,
    isPlurnkOp,
    toolKindOf,
    TurnDisposition,
    Validator,
    isExecution,
    isExecutionOp,
    isRecord,
    type CapabilityDescriptor,
    type CapabilityPolicy,
    type CapabilitySelector,
    type OperationResult,
    type PlurnkStatement,
    type ProposalDisposition,
    type ProposalProjection,
    type ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { EngineNotifications } from "./notifications.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { observedSync } from "../observe/spans.ts";
import ProposalPolicies from "./ProposalPolicies.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { entryCoordinateOf, foldAuthorityIntoPath, schemeNameOf } from "./plurnk-uri.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import Results, { OperationFailureError } from "./results.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type ClientInteractions from "./ClientInteractions.ts";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { OrchestrationProposalAttrs } from "./mutation-types.ts";

// Proposal lifecycle types. A scheme returns DispatchResult{status:202,attrs}
// to propose; dispatch writes a state='proposed' log entry, registers a waiter
// in #pending, and awaits resolution. Resolution arrives via
// Engine.resolveProposal(id, decision, body?) — from the ApplicationPort resolution call,
// core-owned disposition, or a timeout.
// The resolution as the port states it (`ProposalResolution`: decision, the resolver's body —
// INPUT to applyResolution, not echoed back — and the operational outcome stored on the
// log_entries.outcome column, which a NON-accept also carries as the rx's terse error token),
// plus what the accepted scheme apply actually landed: the structured model-facing result.
export interface AppliedProposalResolution extends ProposalResolution {
    readonly result?: object;
}
interface ProposalWaiter {
    disposition: ProposalDisposition | null;
    workspaceId?: number;
    selector?: CapabilitySelector;
    // {§proposal} When the armed timeout cancels it; null while it waits indefinitely.
    readonly expiresAt: string | null;
    resolve: (resolution: AppliedProposalResolution) => void;
    reject: (cause: unknown) => void;
    // Drops whatever the wait armed — its timer, its abort listener — on every exit path.
    release: () => void;
}

// A loop's abort reason is already a descriptive string on every local path ("loop_timeout",
// "loop_forceful_termination"); anything else records that the loop ended and nothing more.
const abortOutcome = (reason: unknown): string =>
    typeof reason === "string" && reason.length > 0 ? reason : "loop_cancelled";

// {§proposal} — the settlements nobody was present to explain; an outcome token
// alone ("no_review_channel") names a condition the reader cannot act on.
const HARNESS_SETTLEMENTS: Readonly<Record<string, { readonly condition: string; readonly recovery: string }>> = {
    no_review_channel: {
        condition: "this session's owner does not implement proposal review",
        recovery: "Attach a review-capable owner or configure server approval.",
    },
    timeout: {
        condition: "no answer arrived before the operator's proposal deadline",
        recovery: "Answer the proposal, or give the loop a longer proposal deadline.",
    },
    daemon_stopping: {
        condition: "the daemon stopped while this proposal was still waiting for an answer",
        recovery: "Run the operation again once the daemon is running.",
    },
    loop_timeout: {
        condition: "the loop reached its deadline while this proposal was waiting for an answer",
        recovery: "Answer proposals before the loop's deadline, or give the loop a longer one.",
    },
    loop_forceful_termination: {
        condition: "the loop was terminated while this proposal was waiting for an answer",
        recovery: "Run the operation again in a loop that is not being terminated.",
    },
    loop_cancelled: {
        condition: "the loop was cancelled while this proposal was waiting for an answer",
        recovery: "Run the operation again in a loop that is not being cancelled.",
    },
};

export interface ProposalSettlement {
    resolution: AppliedProposalResolution;
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
    sessionId: number;
    session: string;
    loopId: number;
    turnId: number;
    loopSeq: number;
    turnSeq: number;
    sequence: number;
    op: string;
    signal: string | null;
    scheme: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    query: string | null;
    rx: string;
    attrs: string;
    owner: string;
    owner_tools: string;
    owner_interactive: number;
    turn_kind: string;
    turn_producer: string;
    project_root?: string | null;
    workspace_settings?: string;
}


// {§proposal} — empty means an indefinite wait; a positive
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

// The proposal lifecycle (SPEC.md {§engine-rails} + {§methods}): a
// side-effecting op that returns 202 pauses in dispatch until a resolution
// arrives — from a client-interface resume, core-owned disposition, or the
// timeout — then the scheme's applyResolution hook applies the accept.
// Where a proposal is applied: the coordinates it was raised in, the row it settles, and the capture capability.
// `resources` is the dispatcher's own capture capability. An applied operation may need
// it — an outbound SEND snapshots its attachments when the settlement accepts, not when the
// proposal was raised — and the fallback in SchemeCtxImpl refuses any non-empty capture.
type ApplyIds = {
    workspaceId: number; sessionId: number; loopId: number; turnId: number;
    // {§log-wire-format} — the operation row this application settles, so a scheme can keep
    // what it did on that row.
    logEntryId?: number;
    resources?: PlurnkSchemeContext["resources"];
};

// What an entry address is bound with at application time, as the binding declares it.
type ApplyBinding = Parameters<EntryAddressBinding["resolve"]>[0];

export default class ProposalLifecycle {
    #db: Db;
    #schemes: SchemeRegistry;
    #notices: NoticeChannel;
    readonly #notify: EngineNotifications;
    #weighContent: (text: string) => number;
    #mimetypes: Mimetypes | undefined;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    #liveSubscriptions: LiveSubscriptions;
    #interactions: ClientInteractions;
    #entryAddresses: EntryAddressBinding;
    // Proposal lifecycle: pending dispatch pauses waiting for resolution.
    // Dispatch awaits the promise when a scheme returns status 202;
    // Engine.resolveProposal feeds the resolution back in. Map is per-log-
    // entry-id; entries clear on resolution. SPEC.md {§engine-rails} + {§methods}.
    #pending = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Correctness policy is
    // deliberately absent: loop-owned settlement happens in this owner before
    // observers run, so an observer cannot become a hidden policy fallback.
    #listeners: Array<(payload: ProposalPendingEvent) => void> = [];

    constructor({ db, schemes, notices, notify, weigh, mimetypes, executors, loopSignal, liveSubscriptions, interactions, entryAddresses }: {
        db: Db;
        schemes: SchemeRegistry;
        notices: NoticeChannel;
        notify: EngineNotifications;
        weigh: (text: string) => number;
        mimetypes?: Mimetypes;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        liveSubscriptions: LiveSubscriptions;
        interactions: ClientInteractions;
        entryAddresses: EntryAddressBinding;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#notices = notices;
        this.#notify = notify;
        this.#weighContent = weigh;
        this.#mimetypes = mimetypes;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#liveSubscriptions = liveSubscriptions;
        this.#interactions = interactions;
        this.#entryAddresses = entryAddresses;
    }

    // External API to feed a resolution into a pending proposal. Called by
    // the ApplicationPort resolution call, core-owned disposition, or the timeout
    // watcher. Throws when the logEntryId has no
    // pending waiter — duplicate resolutions, IDs for non-proposed entries,
    // or entries already-resolved are caller errors.
    resolve(logEntryId: number, resolution: ProposalResolution, resolver: string = "_plurnk"): Promise<void> {
        return observedSync( // {§observability-boundary}
            "proposal.resolve",
            { "entry.id": logEntryId, decision: resolution.decision },
            () => {
                return this.#resolveSettled(logEntryId, resolution, resolver);
            },
        );
    }

    #resolveSettled(logEntryId: number, resolution: ProposalResolution, resolver: string): Promise<void> {
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
        waiter.release();
        this.#pending.delete(logEntryId);
        const effectiveOutcome = resolution.outcome ?? (
            resolution.scope === "always"
                ? (resolution.decision === "accept" ? "allow_always" : resolution.decision === "reject" ? "reject_always" : undefined)
                : undefined
        );
        const decision = Object.freeze({
            ...resolution,
            ...(effectiveOutcome === undefined ? {} : { outcome: effectiveOutcome }),
        });
        const recorded = this.recordDecision(logEntryId, decision, resolver, {
            ...(waiter.workspaceId === undefined ? {} : { workspaceId: waiter.workspaceId }),
            ...(waiter.selector === undefined ? {} : { selector: waiter.selector }),
        });
        // The dispatch owner receives persistence failures even when resolution
        // came from a timer or shutdown, rather than a waiting client.
        void recorded.then(() => waiter.resolve(decision), waiter.reject);
        return recorded;
    }

    async recordDecision(
        logEntryId: number,
        resolution: ProposalResolution,
        resolver: string = "_plurnk",
        standing?: { readonly workspaceId?: number; readonly selector?: CapabilitySelector },
    ): Promise<void> {
        try {
            if (
                resolution.scope === "always"
                && (resolution.decision === "accept" || resolution.decision === "reject")
                && standing?.workspaceId !== undefined
                && standing.selector !== undefined
                && this.#db.workspace_get_settings !== undefined
                && this.#db.workspace_capability_policy_update !== undefined
            ) {
                const current = await WorkspaceSettings.read(this.#db, standing.workspaceId);
                const selectorKey = (s: CapabilitySelector): string =>
                    JSON.stringify(Object.fromEntries(Object.entries(s).toSorted(([a], [b]) => a.localeCompare(b))));
                const targetKey = selectorKey(standing.selector);
                const remainingAllow = (current.capabilities.allow ?? []).filter((s) => selectorKey(s) !== targetKey);
                const remainingDeny = (current.capabilities.deny ?? []).filter((s) => selectorKey(s) !== targetKey);
                const nextPolicy: CapabilityPolicy = resolution.decision === "accept"
                    ? {
                        ...(current.capabilities.only !== undefined ? { only: current.capabilities.only } : {}),
                        ...(remainingDeny.length > 0 ? { deny: remainingDeny } : {}),
                        allow: [...remainingAllow, standing.selector],
                    }
                    : {
                        ...(current.capabilities.only !== undefined ? { only: current.capabilities.only } : {}),
                        deny: [...remainingDeny, standing.selector],
                        ...(remainingAllow.length > 0 ? { allow: remainingAllow } : {}),
                    };
                await this.#db.workspace_capability_policy_update.run({
                    workspace_id: standing.workspaceId,
                    policy: JSON.stringify(nextPolicy),
                });
            }
            await this.#db.proposal_record_decision.run({
                log_entry_id: logEntryId, resolver, decision: resolution.decision,
                body: resolution.body ?? null, outcome: resolution.outcome ?? null,
            });
        } catch (cause) {
            await this.#fail(logEntryId, cause, "decision_unrecorded", Results.failure(
                "proposal:decision", "proposal-decision-unrecorded", 500,
                "The approval decision could not be saved; the operation was not applied.",
                {}, { logEntryId, stage: "proposal-decision", retryable: false },
            ));
            throw cause;
        }
    }

    // Snapshot of pending proposals for client-interface discovery. Returns
    // the log entry IDs currently awaiting resolution.
    pendingIds(): number[] {
        return [...this.#pending.keys()];
    }

    async pending(logEntryId: number): Promise<ProposalPendingEvent | null> {
        const waiter = this.#pending.get(logEntryId);
        if (waiter === undefined) return null;
        const row = await this.#db.proposal_get_pending.get<ProposalRow>({ log_entry_id: logEntryId });
        if (row === undefined) throw new Error(`Pending proposal ${logEntryId} has no durable proposed row.`);
        return this.#project(row, waiter);
    }

    async list(workspaceId: number): Promise<ProposalProjection[]> {
        const rows = await this.#db.proposal_list_pending.all<ProposalRow>({ workspace_id: workspaceId });
        // {§methods} — the durable row carries review material, while
        // #pending carries this process's callable resolution owner. Discovery
        // exposes only their intersection; persistence alone cannot fabricate
        // a resolvable stopped world.
        const projected = rows.flatMap((row) => {
            const waiter = this.#pending.get(row.logEntryId);
            return waiter === undefined ? [] : [this.#project(row, waiter)];
        });
        return projected.map(({ workspaceId: _workspaceId, ...proposal }) => proposal);
    }

    settleOwned(proposal: ProposalPendingEvent): void {
        if (proposal.disposition.decision === "review" || !this.#pending.has(proposal.logEntryId)) return;
        const { decision, outcome } = proposal.disposition;
        void this.resolve(proposal.logEntryId, {
            decision,
            ...(outcome === undefined ? {} : { outcome }),
        });
    }

    #abandon(logEntryId: number): void {
        const waiter = this.#pending.get(logEntryId);
        if (waiter === undefined) return;
        waiter.release();
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
        await this.#fail(logEntryId, cause, "policy_failed", failure);
    }

    async #fail(logEntryId: number, cause: unknown, outcome: string, failure: DispatchResult): Promise<void> {
        try {
            await this.applyResolution(logEntryId, {
                resolution: { decision: "reject", outcome },
                applied: failure,
            });
        } catch (terminalCause) {
            throw new AggregateError(
                [cause, terminalCause],
                `Proposal ${logEntryId} failed and its durable row could not be terminalized.`,
            );
        }
    }

    // {§session-causal-admission}: shutdown cancels every process-local proposal waiter.
    cancelAll(outcome: string): void {
        for (const logEntryId of [...this.#pending.keys()]) {
            void this.resolve(logEntryId, { decision: "cancel", outcome });
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

    #project(row: ProposalRow, waiter: ProposalWaiter): ProposalPendingEvent {
        const tools: unknown = JSON.parse(row.owner_tools);
        const owner = Validator.assertSessionOwner({ address: row.owner, tools, interactive: row.owner_interactive === 1 });
        const op = ProposalLifecycle.#op(row);
        const attrs = ProposalLifecycle.#objectJson(row.logEntryId, "attrs", row.attrs);
        const result = ProposalLifecycle.#result(row.logEntryId, row.rx);
        const target = this.#target(row, op, attrs);
        const demand = this.#capabilityDemand(row, op, target, attrs);
        waiter.workspaceId = row.workspaceId;
        if (demand !== null) {
            waiter.selector = demand.selector;
        }
        const preapproved = demand === null ? false : ProposalLifecycle.#isPreapproved(row, demand.descriptor);
        waiter.disposition ??= ProposalPolicies.disposition(owner.tools, {
            maintenance: row.turn_kind === "maintenance",
            clientOperation: row.turn_producer === "client",
            preapproved,
        });
        const body = typeof result.body === "string" ? result.body : "";
        const subject = ProposalLifecycle.#subject(row, op, target, attrs, body);
        const proposal = Validator.assertProposalProjection({
            logEntryId: row.logEntryId,
            sessionId: row.sessionId,
            session: row.session,
            loopId: row.loopId,
            turnId: row.turnId,
            coordinate: `${row.loopSeq}/${row.turnSeq}/${row.sequence}`,
            op,
            target,
            body,
            attrs,
            owner: row.owner,
            disposition: waiter.disposition,
            ...(demand === null ? {} : { selector: demand.selector }),
            subject,
            ...(waiter.expiresAt === null ? {} : { expiresAt: waiter.expiresAt }),
        });
        return { ...proposal, workspaceId: row.workspaceId };
    }

    #capabilityDemand(
        row: ProposalRow,
        op: ProposalProjection["op"],
        target: { scheme: string | null; authority: string | null; pathname: string | null },
        attrs: Record<string, unknown>,
    ): { selector: CapabilitySelector; descriptor: CapabilityDescriptor } | null {
        if (op === "NOTE" || op === "WAIT") return null;
        if (isExecutionOp(op)) {
            const registry = this.#executors()?.toolRegistry(op, row.workspaceId) ?? null;
            const tool = registry !== null && typeof attrs.target === "string" && attrs.target.length > 0
                ? attrs.target
                : undefined;
            const traits = [...new Set([
                ...(this.#schemes.manifestFor("exec", row.workspaceId)?.traits ?? []),
                ...(this.#schemes.manifestFor(op, row.workspaceId)?.traits ?? []),
            ])].toSorted();
            const access = traits.includes("interaction") ? "interact" : "execute";
            return {
                selector: {
                    operation: op,
                    scheme: "exec",
                    runtime: op,
                    access,
                    ...(tool === undefined ? {} : { tool }),
                },
                descriptor: {
                    operation: op,
                    scheme: "exec",
                    runtime: op,
                    access,
                    traits,
                    ...(tool === undefined ? {} : { tool }),
                },
            };
        }
        const scheme = target.scheme ?? "file";
        const traits = [...(this.#schemes.manifestFor(scheme, row.workspaceId)?.traits ?? [])].toSorted();
        const access = op === "READ" || op === "FIND"
            ? "observe"
            : op === "WORK" || op === "FORK"
                ? "control"
                : op === "BARE"
                    ? "execute"
                    : (op === "KILL" || op === "SEND") && (scheme === "session" || this.#executors()?.entry(scheme, row.workspaceId) !== undefined)
                        ? "control"
                        : "mutate";
        return {
            selector: {
                operation: op,
                scheme,
                access,
            },
            descriptor: {
                operation: op,
                scheme,
                access,
                traits,
            },
        };
    }

    static #isPreapproved(row: ProposalRow, descriptor: CapabilityDescriptor): boolean {
        let workspaceCapabilities: CapabilityPolicy = {};
        if (typeof row.workspace_settings === "string" && row.workspace_settings.length > 0) {
            const parsedSettings = ProposalLifecycle.#objectJson(row.logEntryId, "workspace_settings", row.workspace_settings);
            if (parsedSettings.capabilities !== undefined) {
                workspaceCapabilities = Validator.assertCapabilityPolicy(parsedSettings.capabilities);
            }
        }
        let serviceCapabilities: CapabilityPolicy = {};
        try {
            serviceCapabilities = CapabilityPolicies.service();
        } catch {
            serviceCapabilities = {};
        }
        return CapabilityAdmission.preapprovesAcross([serviceCapabilities, workspaceCapabilities], descriptor);
    }

    static #subject(
        row: ProposalRow,
        op: ProposalProjection["op"],
        target: { scheme: string | null; authority: string | null; pathname: string | null },
        attrs: Record<string, unknown>,
        body: string,
    ): NonNullable<ProposalProjection["subject"]> {
        const isCommand = op === "sh"
            || target.scheme === "sh"
            || attrs.runtime === "sh"
            || attrs.tag === "sh"
            || typeof attrs.command === "string";
        if (isCommand) {
            const command = typeof attrs.command === "string"
                ? attrs.command
                : typeof attrs.body === "string" && attrs.body.length > 0
                    ? attrs.body
                    : typeof attrs.target === "string" && attrs.target.length > 0
                        ? attrs.target
                        : body.length > 0
                            ? body
                            : op;
            const cwd = typeof attrs.cwd === "string" && attrs.cwd.length > 0
                ? attrs.cwd
                : typeof row.project_root === "string" && row.project_root.length > 0
                    ? row.project_root
                    : "/";
            return { type: "command", command, cwd };
        }
        const targetPath = target.pathname
            ?? target.scheme
            ?? (typeof attrs.path === "string" ? attrs.path : null);
        const title = targetPath === null ? op : `${op} (${targetPath})`;
        const kind = ProposalLifecycle.#toolKindOf(op, target.scheme);
        const locations = targetPath !== null ? [{ path: targetPath }] : undefined;
        const diff = typeof attrs.original === "string" && typeof attrs.patched === "string"
            ? {
                path: targetPath ?? "",
                patch: ProposalLifecycle.#buildUnifiedDiff(targetPath ?? "", attrs.original, attrs.patched),
            }
            : undefined;
        return {
            type: "tool_call",
            kind,
            title,
            ...(locations === undefined ? {} : { locations }),
            ...(diff === undefined ? {} : { diff }),
        };
    }

    static #toolKindOf(
        op: string,
        scheme: string | null,
    ): Extract<NonNullable<ProposalProjection["subject"]>, { type: "tool_call" }>["kind"] {
        return toolKindOf(op, scheme);
    }

    static #buildUnifiedDiff(filePath: string, oldText: string, newText: string): string {
        const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
        const newLines = newText.length === 0 ? [] : newText.split("\n");
        const header = [
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ];
        const removed = oldLines.map((line) => `-${line}`);
        const added = newLines.map((line) => `+${line}`);
        return [...header, ...removed, ...added].join("\n");
    }

    static #op(row: ProposalRow): ProposalProjection["op"] {
        // An execution proposal's op is its runtime tag (plurnk-service #659).
        const invalid = (): Error => new Error(`Pending proposal ${row.logEntryId} has invalid operation ${JSON.stringify(row.op)}.`);
        if (TurnDisposition.isOp(row.op)) throw invalid();
        if (isExecutionOp(row.op)) return row.op;
        if (!isPlurnkOp(row.op)) throw invalid();
        return row.op;
    }

    static #objectJson(logEntryId: number, field: string, raw: string): Record<string, unknown> {
        try {
            const value: unknown = JSON.parse(raw);
            if (!isRecord(value)) throw new TypeError(`${field} is not an object`);
            return value;
        } catch (cause) {
            throw new Error(`Pending proposal ${logEntryId} has invalid ${field} JSON.`, { cause });
        }
    }

    static #result(logEntryId: number, raw: string): OperationResult {
        try {
            const value: unknown = JSON.parse(raw);
            const result = Validator.assertOperationResult(value);
            if (result.status !== 202) throw new TypeError(`status is ${result.status}, not 202`);
            return result;
        } catch (cause) {
            throw new Error(`Pending proposal ${logEntryId} has invalid proposed result JSON.`, { cause });
        }
    }

    #target(
        row: ProposalRow,
        op: string,
        attrs: Record<string, unknown>,
    ): { scheme: string | null; authority: string | null; pathname: string | null } {
        const routed = attrs.proposalTarget;
        if (routed === undefined) {
            if (op === "COPY" || op === "MOVE") {
                throw new Error(`Pending proposal ${row.logEntryId} has no canonical ${op} proposal target.`);
            }
            if (row.pathname === null) {
                return { scheme: row.scheme, authority: null, pathname: null };
            }
            const authorityMode = row.scheme === null
                ? "namespace"
                : this.#schemes.manifestFor(row.scheme, row.workspaceId)?.authority ?? "namespace";
            if (authorityMode === "resource") {
                const authority = row.hostname === null
                    ? ""
                    : `${row.hostname}${row.port === null ? "" : `:${row.port}`}`;
                return {
                    scheme: row.scheme,
                    authority,
                    pathname: `${row.pathname}${row.query === null ? "" : `?${row.query}`}`,
                };
            }
            return {
                scheme: row.scheme,
                authority: "",
                pathname: foldAuthorityIntoPath(row.hostname, row.pathname),
            };
        }
        if (!isRecord(routed) || typeof routed.scheme !== "string" || typeof routed.authority !== "string" || typeof routed.pathname !== "string") {
            throw new Error(`Pending proposal ${row.logEntryId} has an invalid canonical proposal target.`);
        }
        return {
            scheme: routed.scheme === "file" ? null : routed.scheme,
            authority: routed.authority,
            pathname: routed.pathname,
        };
    }

    // A proposal's routed target names its scheme, authority and pathname; absent when the proposal was not routed.
    static #proposalTargetOf(value: unknown): OrchestrationProposalAttrs["proposalTarget"] {
        if (value === undefined) return undefined;
        if (!isRecord(value) || typeof value.scheme !== "string" || typeof value.authority !== "string" || typeof value.pathname !== "string") {
            throw new TypeError("A proposal target names its scheme, authority and pathname.");
        }
        return { scheme: value.scheme, authority: value.authority, pathname: value.pathname };
    }

    // The wait is untimed by default because a decision belongs to whoever is deciding. It still
    // does not outlive its loop: an aborted loop settles the proposal the way shutdown already
    // does, carrying the abort's own reason as the outcome (#769).
    awaitResolution(logEntryId: number, signal?: AbortSignal): Promise<AppliedProposalResolution> {
        const timeoutMs = readProposalTimeoutMs();
        return new Promise<AppliedProposalResolution>((resolve, reject) => {
            // Synthesize a cancel resolution through the same path as any other decision. State
            // transitions to cancelled with this outcome. {§proposal}
            const cancel = (outcome: string): void => {
                if (!this.#pending.has(logEntryId)) return;
                void this.resolve(logEntryId, { decision: "cancel", outcome });
            };
            const onAbort = (): void => cancel(abortOutcome(signal?.reason));
            const timeoutHandle = timeoutMs === null ? null : setTimeout(() => cancel("timeout"), timeoutMs);
            this.#pending.set(logEntryId, {
                disposition: null,
                expiresAt: timeoutMs === null ? null : new Date(Date.now() + timeoutMs).toISOString(),
                resolve,
                reject,
                release: () => {
                    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
                    signal?.removeEventListener("abort", onAbort);
                },
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }

    // On accept, run the scheme's applyResolution — File writes disk, Exec spawns. {§proposal}
    async sessionApply(
        statement: PlurnkStatement,
        originalResult: DispatchResult,
        resolution: AppliedProposalResolution,
        ids: ApplyIds,
    ): Promise<ProposalSettlement> {
        const { workspaceId } = ids;
        if (resolution.decision !== "accept") return { resolution };
        // {§move}: once the destination is written, approval applies
        // to the source operand, including its metadata and manifest binding.
        const attrs = isRecord(originalResult.attrs) ? originalResult.attrs : undefined;
        const operand = statement.op === "MOVE" && attrs?.moveDestinationWritten !== undefined
            ? statement.source
            : statement.op === "COPY" || statement.op === "MOVE" ? statement.destination : statement;
        const routedScheme = attrs?.proposalScheme;
        const schemeName = typeof routedScheme === "string"
            ? routedScheme
            : isExecution(statement)
                ? "exec"
                : schemeNameOf(operand.target);
        if (schemeName === null) return { resolution };
        const handler = this.#schemes.get(schemeName, workspaceId);
        if (handler === undefined) {
            return {
                resolution: { ...resolution, outcome: "apply_failed" },
                applied: Results.failure("proposal:application", "handler-unavailable", 410,
                    `The proposed '${schemeName}' handler is no longer available.`, {}, { retryable: false }),
            };
        }
        if (typeof handler.applyResolution !== "function") return { resolution };
        try {
            const applyCtx = this.#applyContext(ids);
            const request = {
                attrs: isRecord(originalResult.attrs) ? originalResult.attrs : {},
                metadata: operand.metadata,
                body: resolution.body,
            };
            const proposalTarget = ProposalLifecycle.#proposalTargetOf(attrs?.proposalTarget);
            const authoredTarget = operand.target;
            // The manifest is resolved AT the target, not for the scheme name: a runtime scheme's
            // facet claims its own subtree with its own channels ({§network-address}), and a
            // settlement that applied under the executor's manifest would publish the facet's
            // resources into channels it never declared.
            const manifest = this.#schemes.manifestAt(schemeName, authoredTarget, workspaceId);
            if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
            const authority = await this.#applyAuthority({ statement, schemeName, handler, manifest, authoredTarget, proposalTarget, applyCtx, resolution });
            if (typeof authority !== "string") return authority;
            const applyResult = Results.assert(await handler.applyResolution(
                request,
                new SchemeCtxImpl(applyCtx, schemeName, manifest, this.#liveSubscriptions, { authority }),
            ));
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
            // model must see THIS turn: a file EDIT's line-numbered diff. An execution
            // never uses the body rail — its output streams uniformly ({§exec-stream}, NO same-turn
            // in-body exception; automatic admission only skips the review pause) and is READ next turn.
            const withOutcome = applyResult.outcome !== undefined && resolution.outcome === undefined
                ? { ...resolution, outcome: applyResult.outcome }
                : resolution;
            return {
                resolution: {
                    ...withOutcome,
                    ...(applyResult.body !== undefined ? { body: applyResult.body } : {}),
                    ...(applyResult.result !== undefined ? { result: applyResult.result } : {}),
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

    // The context a scheme's applyResolution runs under: the (workspace, session, loop, turn) the proposal was
    // raised in — the scheme uses it to write the entry that makes the operation's artifact visible in the next
    // packet's index — the row it settles, and the dispatcher's capture capability when the operation needs one.
    #applyContext(ids: ApplyIds): PlurnkSchemeContext {
        const { workspaceId, sessionId, loopId, turnId } = ids;
        return {
        db: this.#db, workspaceId, sessionId, loopId, turnId,
        ...(ids.logEntryId === undefined ? {} : { logEntryId: ids.logEntryId }),
        writer: "model", signal: this.#loopSignal(loopId),
        streamEventNotify: this.#notify.streamEventNotify,
        wakeSessionNotify: this.#notify.wakeSessionNotify,
        weigh: this.#weighContent,
        mimetypes: this.#mimetypes,
        ...(ids.resources === undefined ? {} : { resources: ids.resources }),
        pushNotice: (notice) => this.#notices.push(workspaceId, sessionId, loopId, notice),
        requestInteraction: (interaction, signal = this.#loopSignal(loopId)) => this.#interactions.request(
            interaction,
            { workspaceId, sessionId, loopId, turnId },
            signal,
        ),
        executors: this.#executors(),
        };
    }

    // The authority the application runs under: the proposal's recorded target, else the authored target's
    // coordinate. A data scheme's entry target is bound again at application time, and a binding that fails or
    // resolves to nothing is the settlement's failure.
    async #applyAuthority(args: {
        statement: PlurnkStatement;
        schemeName: string;
        handler: SchemeHandler;
        manifest: ApplyBinding["manifest"];
        authoredTarget: ApplyBinding["target"] | null;
        proposalTarget: OrchestrationProposalAttrs["proposalTarget"];
        applyCtx: PlurnkSchemeContext;
        resolution: AppliedProposalResolution;
    }): Promise<string | ProposalSettlement> {
        const { statement, schemeName, handler, manifest, authoredTarget, proposalTarget, applyCtx, resolution } = args;
        let authority = proposalTarget === undefined
            ? authoredTarget === null
                ? ""
                : entryCoordinateOf(authoredTarget, manifest.authority ?? "namespace").authority
            : proposalTarget.authority;
        if (
            manifest.category === "data"
            && !isExecution(statement)
            && authoredTarget !== null
        ) {
            const binding = await this.#entryAddresses.resolve({
                target: authoredTarget,
                routedScheme: schemeName,
                handler,
                manifest,
                ctx: applyCtx,
            });
            if (binding.result !== null) {
                return {
                    resolution: {
                        ...resolution,
                        outcome: typeof binding.result.outcome === "string"
                            ? binding.result.outcome
                            : "apply_failed",
                    },
                    applied: binding.result,
                };
            }
            if (binding.address === null) {
                const applied = Results.failure(
                    "proposal:application",
                    "entry-not-found",
                    404,
                    "The proposed entry target no longer resolves.",
                    {},
                    { stage: "proposal-application", retryable: false },
                );
                return {
                    resolution: { ...resolution, outcome: "apply_failed" },
                    applied,
                };
            }
            authority = binding.address.authority;
        }
        return authority;
    }

    async applyResolution(logEntryId: number, settlement: ProposalSettlement): Promise<DispatchResult> {
        const { resolution, applied } = settlement;
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default) {§proposal}
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default) {§proposal}
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
            : decision === "accept" ? applied?.status ?? 200
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
            const settled = outcome === null ? undefined : HARNESS_SETTLEMENTS[outcome];
            const detail = settled === undefined
                ? `The proposal was ${action}${outcome === null ? "." : ` (${outcome}).`}`
                : `The proposal was ${action}: ${settled.condition}.`;
            result = Results.failure("proposal", code, status, detail, {
                ...(outcome !== null ? { outcome } : {}),
            }, {
                stage: "proposal-settlement",
                retryable: false,
                ...(settled === undefined ? {} : { recovery: settled.recovery }),
            });
        }
        const coordinate = await this.#db.engine_log_entry_coordinate.get<{
            loop_seq: number;
            turn_seq: number;
            sequence: number;
            op: string;
            origin: string;
            attrs: string;
            tx: string;
            mimetype_tx: string;
            mimetype_rx: string;
        }>({ id: logEntryId });
        if (coordinate === undefined) throw new Error(`ProposalLifecycle.applyResolution: log entry ${logEntryId} has no coordinate`);
        const pathname = LogEntryProjection.coordinate(
            `${coordinate.loop_seq}/${coordinate.turn_seq}/${coordinate.sequence}`,
            coordinate,
        );
        if (result.problem?.instance === undefined) Results.attachInstance(result, `log:///${pathname}`);
        const rx = JSON.stringify(result);
        const weight = LogBody.weight({
            op: coordinate.op,
            attrs: coordinate.attrs,
            tx: coordinate.tx,
            rx,
            mimetypeTx: coordinate.mimetype_tx,
            mimetypeRx: coordinate.mimetype_rx,
        }, this.#weighContent);
        await this.#db.engine_resolve_log_entry.run({
            id: logEntryId, state, outcome, status_rx: status, rx, weight,
        });
        return result;
    }
}
