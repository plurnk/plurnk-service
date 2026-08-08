import type {
    CopyStatement,
    EditStatement,
    ForkStatement,
    LineMarker,
    MoveStatement,
    OpenStatement,
    FoldStatement,
    ParsedPath,
    PlurnkOp,
    PlurnkStatement,
    ReadStatement,
    ResourceSelection,
    WorkStatement,
} from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import Owner from "./Owner.ts";
import WorkerName, { WorkerNameError } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalResolution, ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { entryPathnameOf, foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import Namespace from "./namespace.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";
import ChannelWrite, { type StreamEventNotify, type WakeWorkerNotify, type InjectWorkerNotify, type BranchWorkerNotify, type BranchCompletionGate, type CancelWorkerNotify, type CancelDescendantsNotify } from "./ChannelWrite.ts";
import {
    assertEditBatchReceipt,
    assertEditReceipt,
    assertResourceEffects,
    editReceipt,
    LineMarkerOps,
    MimetypeBinary,
    PathMimetype,
    projectEditReceipt,
    type EditBatchReceipt,
    type ResourceEffect,
    type ResourceEffectAction,
} from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import EntryOps from "../schemes/_entry-ops.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import Results from "./results.ts";
import { OperationFailureError } from "./results.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import { CoreSchemeAdapterBase, type CoreEntryAddress } from "./CoreSchemeServices.ts";
import {
    type EntryAddress,
    InvalidOperationResultError,
    NetworkAddress,
    type ScopeNormalization,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { ProviderEncryptedReasoningItem } from "@plurnk/plurnk-providers";
import DurableStatement from "./DurableStatement.ts";

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy.
// OPEN/FOLD/READ/FIND are not gated — they curate the log or read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL", "FORK", "WORK"]);

export type DispatchContext = {
    statement: PlurnkStatement;
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    onDispatch?: (logEntryId: number) => void;
};

export type DispatchResult = SchemeResult;

export interface ResolvedClientEntryAddress {
    readonly ownerId: number;
    readonly scheme: string;
    readonly pathname: string;
    readonly target: string;
}

import type { SchemeCtx, SchemeHandler } from "@plurnk/plurnk-schemes";
type SchemeMethod = (statement: PlurnkStatement, ctx: SchemeCtx) => Promise<DispatchResult>;
type LogCurationHandler = {
    open(statement: OpenStatement, ctx: SchemeCtx): Promise<DispatchResult>;
    fold(statement: FoldStatement, ctx: SchemeCtx): Promise<DispatchResult>;
};
type PreparedEditBatch = {
    readonly initial: DispatchResult;
    readonly settled: Promise<DispatchResult>;
    aggregate: EditBatchReceipt | undefined;
    settle(result: DispatchResult): void;
};

type PreparedEdit = {
    readonly first: boolean;
    readonly index: number;
    readonly normalizationIndex: number | null;
    readonly batch: PreparedEditBatch;
};

interface SchemeWithCrud {
    readEntry?: (pathname: string, ctx: SchemeCtx) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: SchemeCtx) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
    deleteChannel?: (pathname: string, channel: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
}

interface SchemeWithEntryAddress {
    resolveEntryAddress?: (
        target: ParsedPath,
        ctx: SchemeCtx,
    ) => Promise<EntryAddress | CoreEntryAddress | null>;
}

type ResolvedResourceSelection = {
    readonly target: ParsedPath;
    readonly lineMarker: LineMarker | null;
    readonly scheme: string;
    readonly pathname: string;
    readonly identityPathname: string;
    readonly channel: string;
    readonly manifest: SchemeManifest;
};

type SelectedSource = ResolvedResourceSelection & {
    readonly content: string;
    readonly mimetype: string;
    readonly scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
};

type DeferredMoveSource = {
    readonly target: ParsedPath;
    readonly lineMarker: LineMarker | null;
    readonly scheme: string;
    readonly pathname: string;
    readonly channel: string;
    readonly destination: string;
};

type PendingResourceEffect = Pick<ResourceEffect, "target" | "action">;

type OrchestrationProposalAttrs = {
    readonly proposalScheme?: string;
    readonly proposalTarget?: {
        readonly scheme: string;
        readonly pathname: string;
    };
    readonly proposalEffects?: readonly PendingResourceEffect[];
    readonly moveSource?: DeferredMoveSource;
    readonly moveDestinationWritten?: string;
    readonly moveDestinationEffects?: readonly ResourceEffect[];
};

// Op dispatch ({§op-methods-op-dispatch}): gates (writableBy, loop flags), the
// engine-owned op orchestrations (COPY/MOVE/KILL/SEND), scheme
// routing, the durable log write, and the proposal pause.
export default class Dispatcher {
    static #failure(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): DispatchResult {
        return Results.failure("engine:dispatcher", code, status, detail, fields, extensions);
    }

    static #statusResult(
        status: number,
        code: string,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
    ): DispatchResult {
        return status >= 400
            ? Dispatcher.#failure(code, status, detail, fields, { retryable: false })
            : { ...fields, status };
    }

    #db: Db;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #tokenize: (text: string) => number;
    #notices: NoticeChannel;
    #proposals: ProposalLifecycle;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #injectWorker: InjectWorkerNotify | undefined;
    #branchWorker: BranchWorkerNotify | undefined;
    #branchCompletionGate: BranchCompletionGate | undefined;
    #cancelWorker: CancelWorkerNotify | undefined;
    #cancelDescendants: CancelDescendantsNotify | undefined;
    // {§send-premature-terminate}/SEND[202]<T> — the engine-owned park-deadline registry (loopId → seconds;
    // -1 = indefinite). The dispatcher WRITES at park; the daemon's drain park-exit consumes.
    #parkDeadlines: Map<number, number>;
    readonly #searchGate: import("./search-gate.ts").default | undefined;
    // Per-turn running-worker READ obligations. {§join-blocking-collect}
    #joinTargets: Set<number>;
    #liveSubscriptions: LiveSubscriptions;
    #lifecycle: LoopLifecycle;
    #preparedEdits = new WeakMap<EditStatement, PreparedEdit>();

    constructor({ db, schemes, mimetypes, tokenize, notices, proposals, executors, loopSignal, streamEventNotify, wakeWorkerNotify, injectWorker, branchWorker, branchCompletionGate, cancelWorker, cancelDescendants, searchGate, parkDeadlines, joinTargets, liveSubscriptions }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        tokenize: (text: string) => number;
        notices: NoticeChannel;
        proposals: ProposalLifecycle;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        branchWorker?: BranchWorkerNotify;
        branchCompletionGate?: BranchCompletionGate;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
        parkDeadlines?: Map<number, number>;
        searchGate?: import("./search-gate.ts").default;
        joinTargets?: Set<number>;
        liveSubscriptions: LiveSubscriptions;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#tokenize = tokenize;
        this.#notices = notices;
        this.#proposals = proposals;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#injectWorker = injectWorker;
        this.#branchWorker = branchWorker;
        this.#branchCompletionGate = branchCompletionGate;
        this.#cancelWorker = cancelWorker;
        this.#cancelDescendants = cancelDescendants;
        this.#parkDeadlines = parkDeadlines ?? new Map();
        this.#searchGate = searchGate;
        this.#joinTargets = joinTargets ?? new Set();
        this.#liveSubscriptions = liveSubscriptions;
        this.#lifecycle = new LoopLifecycle(db);
    }

    // workspace → project_root, memoized: {§fs-namespace} fixes the root immutably at
    // workspace creation, so a process-lifetime cache can never go stale.
    #rootCache = new Map<number, string | null>();

    #handlerContext(scheme: string, ctx: PlurnkSchemeContext): SchemeCtxImpl | null {
        const manifest = this.#schemes.manifestFor(scheme);
        return manifest === undefined ? null : new SchemeCtxImpl(ctx, scheme, manifest, this.#liveSubscriptions);
    }

    #entryContext(scheme: string, ctx: PlurnkSchemeContext): SchemeCtxImpl | null {
        const handlerCtx = this.#handlerContext(scheme, ctx);
        return this.#schemes.manifestFor(scheme)?.category === "data" ? handlerCtx : null;
    }

    async #readEntry(scheme: string, pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.readEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.readEntry(pathname, handlerCtx)) as ReadEntryResult;
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return Dispatcher.#failure(
                "entry-read-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry reads.`,
                { entry: null },
                {
                    stage: "entry-read",
                    scheme,
                    target: renderAddress(scheme, pathname),
                    retryable: false,
                },
            ) as ReadEntryResult;
        }
        const result = Results.assert(await caps.read(pathname, scheme === "prompt" ? "worker" : "commons"));
        return Results.assert({
            ...result,
            status: result.status,
            entry: result.entry === null
                ? null
                : { channels: { ...result.entry.channels }, tags: [...result.entry.tags] },
        }) as ReadEntryResult;
    }

    async #writeEntry(scheme: string, pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.writeEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.writeEntry(pathname, entry, handlerCtx)) as WriteEntryResult;
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return Dispatcher.#failure(
                "entry-write-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry writes.`,
                { created: false, entryId: null },
                {
                    stage: "entry-write",
                    scheme,
                    target: renderAddress(scheme, pathname),
                    retryable: false,
                },
            ) as WriteEntryResult;
        }
        return Results.assert(await caps.write(pathname, entry, scheme === "prompt" ? "worker" : "commons")) as WriteEntryResult;
    }

    async #deleteEntry(scheme: string, pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.deleteEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.deleteEntry(pathname, handlerCtx)) as DeleteEntryResult;
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return Dispatcher.#failure(
                "entry-delete-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry deletion.`,
                {},
                {
                    stage: "entry-delete",
                    scheme,
                    target: renderAddress(scheme, pathname),
                    retryable: false,
                },
            );
        }
        return Results.assert(await caps.delete(pathname, scheme === "prompt" ? "worker" : "commons"));
    }

    async #deleteChannel(
        scheme: string,
        pathname: string,
        channel: string,
        ctx: PlurnkSchemeContext,
    ): Promise<DeleteEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.deleteChannel === "function" && handlerCtx !== null) {
            return Results.assert(await handler.deleteChannel(pathname, channel, handlerCtx)) as DeleteEntryResult;
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return Dispatcher.#failure(
                "channel-delete-not-implemented",
                501,
                `The '${scheme}' scheme does not provide channel deletion.`,
                {},
                {
                    stage: "channel-delete",
                    scheme,
                    target: renderAddress(scheme, pathname),
                    channel,
                    retryable: false,
                },
            );
        }
        return Results.assert(
            await caps.delete(pathname, scheme === "prompt" ? "worker" : "commons", channel),
        );
    }
    async #workspaceRoot(workspaceId: number): Promise<string | null> {
        if (this.#rootCache.has(workspaceId)) return this.#rootCache.get(workspaceId) ?? null;
        const row = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        this.#rootCache.set(workspaceId, root);
        return root;
    }

    // {§fs-answer-in-canon} — a file-class target's engine-authored address COLUMNS carry
    // the canonical key; tx keeps the operation spelling after the one durable request-evidence
    // projection. An un-canonicalizable spelling keeps its raw form.
    async #canonColumns(target: { scheme: string | null; pathname: string | null }, workspaceId: number): Promise<void> {
        if (target.scheme !== null || target.pathname === null) return;
        const key = Namespace.canonicalizeSpelling(target.pathname, await this.#workspaceRoot(workspaceId));
        if (key !== null) target.pathname = key;
    }

    async prepareEditBatches(statements: readonly EditStatement[], context: Omit<DispatchContext, "statement" | "sequence">): Promise<void> {
        const { workspaceId, workerId, loopId, turnId, origin } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId, origin });
        const groups = new Map<string, EditStatement[]>();
        for (const statement of statements) {
            const target = this.#extractTarget(statement.target);
            await this.#canonColumns(target, workspaceId);
            const key = JSON.stringify([
                schemeNameOf(statement.target),
                target.scheme,
                target.hostname,
                target.pathname,
                target.fragment,
            ]);
            const group = groups.get(key);
            if (group === undefined) groups.set(key, [statement]);
            else group.push(statement);
        }
        for (const group of groups.values()) {
            const first = group[0];
            const schemeName = schemeNameOf(first.target);
            let initial: DispatchResult;
            let denial = group.map((statement) => this.#checkWritable(statement, origin)).find((result) => result !== null) ?? null;
            if (denial === null) {
                for (const statement of group) {
                    denial = await this.#checkFlagsGate(statement, loopId);
                    if (denial !== null) break;
                }
            }
            if (denial !== null) {
                initial = denial;
            } else if (schemeName === null) {
                initial = Dispatcher.#failure(
                    "target-required",
                    400,
                    "EDIT requires a target scheme.",
                    {},
                    { retryable: false },
                );
            } else {
                const handler = this.#schemes.get(schemeName) as SchemeHandler | undefined;
                const method = handler?.editBatch;
                const manifest = this.#schemes.manifestFor(schemeName);
                if (typeof method !== "function" || manifest === undefined) {
                    initial = Dispatcher.#failure(
                        "operation-not-implemented",
                        501,
                        `Scheme '${schemeName}' does not implement EDIT batches.`,
                        {},
                        {
                            scheme: schemeName,
                            operation: "EDIT",
                            retryable: false,
                        },
                    );
                } else {
                    try {
                        const addressedScheme = first.target?.kind === "url" ? first.target.scheme : schemeName;
                        initial = Results.assert(await method.call(handler, group, new SchemeCtxImpl(schemeCtx, addressedScheme ?? schemeName, manifest, this.#liveSubscriptions)));
                    } catch (err) {
                        if (err instanceof InvalidOperationResultError) throw err;
                        console.error(`Scheme '${schemeName}' EDIT batch threw outside its operation result contract:`, err);
                        initial = Dispatcher.#failure(
                            "scheme-handler-threw",
                            500,
                            `The '${schemeName}' scheme did not produce an EDIT result.`,
                            {},
                            {
                                stage: "scheme-dispatch",
                                scheme: schemeName,
                                operation: "EDIT",
                            },
                        );
                    }
                }
            }
            let resolveSettled!: (result: DispatchResult) => void;
            const settled = new Promise<DispatchResult>((resolve) => { resolveSettled = resolve; });
            const candidate = initial.editReceipt;
            const expectedNormalizations = group.filter(({ lineMarker }) =>
                lineMarker?.marks.length === 3).length;
            if (
                initial.status < 400
                && (initial.scopeNormalizations?.length ?? 0) !== expectedNormalizations
            ) {
                throw new InvalidOperationResultError(
                    `EDIT batch normalized ${initial.scopeNormalizations?.length ?? 0} scope(s), expected ${expectedNormalizations}.`,
                );
            }
            const batch: PreparedEditBatch = {
                initial,
                settled,
                aggregate: candidate === undefined || candidate === null
                    ? undefined
                    : assertEditBatchReceipt(candidate),
                settle: resolveSettled,
            };
            let normalizationIndex = 0;
            for (const [index, statement] of group.entries()) {
                const ownsNormalization = statement.lineMarker?.marks.length === 3 && initial.status < 400;
                this.#preparedEdits.set(statement, {
                    first: index === 0,
                    index,
                    normalizationIndex: ownsNormalization ? normalizationIndex++ : null,
                    batch,
                });
            }
        }
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const result = await this.#dispatchOne(context);
        if (context.statement.op === "EDIT") {
            const prepared = this.#preparedEdits.get(context.statement);
            if (prepared?.first === true) {
                const normalizations = prepared.batch.initial.scopeNormalizations;
                prepared.batch.settle(normalizations === undefined
                    ? result
                    : Results.assert({ ...result, scopeNormalizations: normalizations }));
            }
        }
        return result;
    }

    async #dispatchOne(context: DispatchContext): Promise<DispatchResult> {
        const {
            statement,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence,
            origin,
            onDispatch,
        } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId, origin });
        let result: DispatchResult;
        let denial = this.#checkWritable(statement, origin);
        if (denial === null) denial = await this.#checkFlagsGate(statement, loopId);
        if (denial !== null) {
            result = denial;
        } else {
            // {§scheme-surface-exception-500} Scheme-handler
            // exceptions become the action-entry's outcome (status 500), not a
            // thrown bubble. The log_entry is the durable record; engine never
            // skips it. Logging failures (#writeLog throws) are NOT caught —
            // those are system failures.
            try {
                if (statement.op === "EDIT") {
                    const prepared = this.#preparedEdits.get(statement);
                    if (prepared === undefined) {
                        throw new InvalidOperationResultError("EDIT reached dispatch without a prepared resource batch.");
                    } else {
                        const settled = prepared.first
                            ? prepared.batch.initial
                            : await prepared.batch.settled;
                        const normalization = prepared.normalizationIndex === null
                            ? undefined
                            : settled.scopeNormalizations?.[prepared.normalizationIndex];
                        const {
                            scopeNormalizations: _scopeNormalizations,
                            ...projectedSettlement
                        } = settled;
                        const statementResult = normalization === undefined
                            ? projectedSettlement
                            : { ...projectedSettlement, scopeNormalizations: [normalization] };
                        const aggregate = prepared.batch.aggregate;
                        if (aggregate !== undefined) {
                            const receipt = assertEditBatchReceipt(aggregate);
                            const { editReceipt: _editReceipt, ...withoutAggregate } = statementResult;
                            result = {
                                ...withoutAggregate,
                                receipt: projectEditReceipt(receipt, prepared.index),
                            };
                        } else {
                            result = statementResult;
                        }
                    }
                } else if (statement.op === "SEND" && statement.target === null) {
                    result = await this.#handleSendBroadcast(statement, { workspaceId, workerId, loopId, turnId, sequence });
                } else if (statement.op === "OPEN" || statement.op === "FOLD") {
                    result = await this.#runLogCuration(statement, schemeCtx);
                } else if (statement.op === "FORK" || statement.op === "WORK") {
                    result = await this.#handleWorkerControl(statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL") {
                    result = await this.#handleKill(statement, schemeCtx);
                } else if (statement.op === "PLAN") {
                    result = this.#handlePlan(statement);
                } else if (statement.op === "EXEC") {
                    // EXEC's target slot is `cwd`, not a scheme address.
                    // Per plurnk.md the op routes unconditionally to the
                    // exec scheme; the scheme handler reads runtime
                    // (signal), cwd (target), and command (body).
                    result = await this.#gatedExec(statement, schemeCtx, loopId, turnId);
                } else {
                    result = await this.#run(schemeNameOf(statement.target), statement, schemeCtx); // {§op-methods-op-dispatch}
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — {§scheme-surface-exception-500}
                if (err instanceof InvalidOperationResultError) throw err;
                const scheme = schemeNameOf(statement.target);
                console.error(`Scheme '${scheme ?? "unknown"}' ${statement.op} threw outside its operation result contract:`, err);
                result = err instanceof OperationFailureError
                    ? err.result
                    : Dispatcher.#failure(
                        "scheme-handler-threw",
                        500,
                        `The '${scheme ?? "unknown"}' scheme did not produce a ${statement.op} result.`,
                        {},
                        {
                            stage: "scheme-dispatch",
                            scheme,
                            operation: statement.op,
                        },
                    );
            }
        }
        // {§fold-open-meta-operations} — persist OPEN/FOLD for forensics;
        // packet rendering suppresses their successful receipts.
        // A running-worker READ arms this turn's blocking collect.
        // {§join-blocking-collect}
        if (typeof (result as { awaitWorker?: unknown }).awaitWorker === "string") this.#joinTargets.add(loopId);
        const logEntryId = await this.#writeLog({ statement, result, workspaceId, workerId, loopId, turnId, sequence, origin });
        // {§search-gate} — register successful searches AFTER #writeLog stamps the runtime
        // entry's coordinate onto result.attrs.pathname (the gate's dedup serves from it).
        if (statement.op === "EXEC" && result.status < 400) {
            const rt = ("signal" in statement && typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
            const cmd = ("body" in statement && typeof statement.body === "string") ? statement.body : "";
            const attrPath = (result.attrs as { pathname?: string } | undefined)?.pathname;
            if (typeof attrPath === "string") this.#searchGate?.registerPending(loopId, turnId, rt, cmd, attrPath);
        }
        onDispatch?.(logEntryId);
        // Proposal lifecycle (SPEC.md {§engine-rails} + {§methods-proposal-resolve}; {§proposal-202-pauses}). When a
        // side-effecting op returns status 202 (a broadcast SEND[202] park is model
        // speech, not a proposal — #isProposal), the entry is written
        // state='proposed'; dispatch then PAUSES on a per-entry waiter until
        // resolution arrives via Engine.resolveProposal (from a client-interface resume,
        // core-owned disposition, or timeout). The post-resolution status replaces 202 in the
        // result the caller sees, so runTurn never branches on a pending state.
        if (Dispatcher.#isProposal(statement, result)) {
            // Effect-gated auto-run (read/pure runtimes, {§exec-readpure-ungated}):
            // EXEC stores its one canonical effect fact before admission. Reuse
            // that exact fact here; no human gate or loop/proposal notification.
            const effect = (result.attrs as { effect?: unknown } | undefined)?.effect;
            let autoAccept = false;
            if (statement.op === "EXEC") {
                if (!EffectPolicy.isEffect(effect)) {
                    throw new InvalidOperationResultError("EXEC proposal omitted its canonical effect fact.");
                }
                autoAccept = EffectPolicy.decide(effect) === "auto";
            }
            if (autoAccept) {
                const initialSettlement = await this.#proposals.workerApply(
                    statement,
                    result,
                    { decision: "accept" },
                    { workspaceId, workerId, loopId, turnId },
                );
                const settlement = Dispatcher.#settleProposalEffects(
                    result,
                    initialSettlement,
                );
                const effective = await this.#settleMoveProposal({
                    statement,
                    result,
                    settlement,
                    ctx: schemeCtx,
                    ids: { workspaceId, workerId, loopId, turnId },
                });
                this.#recordEditSettlement(statement, effective);
                return this.#proposals.applyResolution(logEntryId, effective);
            }
            // Register the resolution waiter SYNCHRONOUSLY before any await
            // yields. A same-tick resolveProposal() (e.g. from a test that
            // awaits the onDispatch callback and immediately resolves) must
            // find the waiter registered — adding an await between insert
            // and waiter-registration would open a race window.
            // Core derives one validated projection from the durable row for both
            // this live event and reconnect discovery ({§proposal-projection}). Its
            // disposition is also the one automatic settlement decision: policy is
            // not an observer and cannot silently degrade into client ownership.
            let resolutionPromise: Promise<ProposalResolution>;
            try {
                resolutionPromise = this.#proposals.awaitResolution(logEntryId);
                const event = await this.#proposals.pending(logEntryId);
                this.#proposals.settleOwned(event);
                this.#proposals.notifyPending(event);
            } catch (cause) {
                await this.#proposals.failPreparation(logEntryId, cause);
                throw cause;
            }
            const resolution = await resolutionPromise;
            // Run the scheme's applyResolution hook on accept (writes the
            // file, spawns the process, etc.). Its operation result is
            // preserved: an apply failure keeps its original status and
            // Problem Details instead of masquerading as a client rejection.
            const initialSettlement = await this.#proposals.workerApply(
                statement,
                result,
                resolution,
                { workspaceId, workerId, loopId, turnId },
            );
            const settlement = Dispatcher.#settleProposalEffects(
                result,
                initialSettlement,
            );
            const effective = await this.#settleMoveProposal({
                statement,
                result,
                settlement,
                ctx: schemeCtx,
                ids: { workspaceId, workerId, loopId, turnId },
            });
            this.#recordEditSettlement(statement, effective);
            const post = await this.#proposals.applyResolution(logEntryId, effective);
            return post;
        }
        return result;
    }

    // {§op-look}: resolve a READ and return its content without writing a
    // log_entries row: the client's out-of-band inspection primitive (LOOK → READ,
    // invisible to the model). READ never mutates and never proposes, so this is
    // dispatch's resolve path minus #writeLog. Runs on the client loop, so the
    // human's inspection is never constrained by a model loop's flags. {§op-look}
    async look(context: {
        statement: PlurnkStatement;
        workspaceId: number; workerId: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, origin = "client" } = context;
        if (statement.op !== "READ") throw new Error(`look resolves READ only; got ${statement.op}`);
        // turnId is a write-time FK only — a look writes no row, so 0 (no turn) is inert.
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId: 0, origin });
        const denial = await this.#checkFlagsGate(statement, loopId);
        if (denial !== null) return denial;
        return this.#run(schemeNameOf(statement.target), statement, schemeCtx);
    }

    // Resolve the client selector through the owning scheme before persistence
    // is consulted. Public schemes choose a semantic owner; core-owned authority
    // schemes may return the already-authorized principal key.
    async resolveEntryAddress(context: {
        target: ParsedPath;
        workspaceId: number;
        workerId: number;
    }): Promise<ResolvedClientEntryAddress | null> {
        const { target, workspaceId, workerId } = context;
        const routedScheme = schemeNameOf(target);
        if (routedScheme === null) return null;
        const handler = this.#schemes.get(routedScheme) as SchemeWithEntryAddress | undefined;
        const manifest = this.#schemes.manifestFor(routedScheme);
        if (handler === undefined || manifest?.category !== "data") return null;

        const addressedScheme = target.kind === "url" ? target.scheme : routedScheme;
        const coreCtx = this.#buildSchemeCtx({
            workspaceId,
            workerId,
            loopId: 0,
            turnId: 0,
            origin: "client",
        });
        const schemeCtx = new SchemeCtxImpl(
            coreCtx,
            addressedScheme,
            manifest,
            this.#liveSubscriptions,
        );
        const resolved = handler.resolveEntryAddress === undefined
            ? { pathname: entryPathnameOf(target), owner: "commons" as const }
            : await handler.resolveEntryAddress(target, schemeCtx);
        if (resolved === null) return null;
        if (typeof resolved.pathname !== "string") {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry pathname.`);
        }

        let ownerId: number;
        if ("ownerId" in resolved) {
            if (!(handler instanceof CoreSchemeAdapterBase)) {
                throw new TypeError(`Scheme '${routedScheme}' returned a core-only entry owner id.`);
            }
            ownerId = resolved.ownerId;
        } else if (resolved.owner === "worker") {
            ownerId = workerId;
        } else if (resolved.owner === "commons") {
            ownerId = await Owner.commonsId(this.#db, workspaceId);
        } else {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry owner.`);
        }
        if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry owner id.`);
        }

        const rendered = target.kind === "url"
            ? renderTarget({ ...target, fragment: null })
            : renderTarget({ scheme: null, pathname: target.raw, fragment: null });
        if (rendered === null) throw new TypeError("Resolved entry target did not render.");
        return {
            ownerId,
            scheme: manifest.storedScheme ?? addressedScheme,
            pathname: resolved.pathname,
            target: rendered,
        };
    }

    // An accepted EXEC reads a non-file source through the same registered
    // handler and addressed context as an authored READ. {§exec-target-routing}
    async readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const schemeName = schemeNameOf(statement.target);
        const manifest = schemeName === null ? undefined : this.#schemes.manifestFor(schemeName);
        if (manifest !== undefined && manifest.category !== "data") {
            return Dispatcher.#failure(
                "exec-source-not-data",
                501,
                `Scheme '${schemeName}' is not a data source for EXEC.`,
                {},
                {
                    scheme: schemeName,
                    category: manifest.category,
                    retryable: false,
                },
            );
        }
        return Results.assertReadResult(await this.#run(schemeName, statement, ctx));
    }

    #buildSchemeCtx(ids: { workspaceId: number; workerId: number; loopId: number; turnId: number; origin: WriterTier }): PlurnkSchemeContext {
        const { workspaceId, workerId, loopId, turnId, origin } = ids;
        return {
            db: this.#db,
            workspaceId, workerId, loopId, turnId,
            writer: origin,
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            injectWorker: this.#injectWorker,
            mimetypes: this.#mimetypes,
            tokenize: this.#tokenize,
            pushNotice: (notice) => this.#notices.push(workspaceId, loopId, notice),
            executors: this.#executors(),
        };
    }

    // SPEC {§scheme-surface}: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ, FIND, OPEN, FOLD) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    #checkWritable(statement: PlurnkStatement, origin: WriterTier): DispatchResult | null {
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (statement.op === "SEND" && statement.target === null) return null;

        // EXEC's target slot is `cwd`, not a scheme address. The op's
        // authority always belongs to the exec scheme regardless of cwd.
        if (statement.op === "EXEC") {
            return this.#denyIfDisallowed("exec", origin);
        }

        // Worker control (FORK/WORK → worker://<name>, spawn or fork) is gated by worker://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // {§machine-processes}
        if (this.#isWorkerControl(statement)) return this.#denyIfDisallowed("worker", origin);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.body?.target ?? null;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        return this.#denyIfDisallowed(target, origin);
    }

    // {§search-gate} — gate only configured search runtimes; duplicates serve
    // the prior durable digest and the per-turn cap refuses without execution.
    async #gatedExec(statement: PlurnkStatement, ctx: PlurnkSchemeContext, loopId: number, turnId: number): Promise<DispatchResult> {
        const runtime = ("signal" in statement && typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
        const command = ("body" in statement && typeof statement.body === "string") ? statement.body : "";
        const verdict = this.#searchGate?.check(loopId, turnId, runtime, command) ?? { verdict: "pass" as const };
        if (verdict.verdict === "capped") {
            return Dispatcher.#failure(
                "search-limit-reached",
                429,
                `This turn already used its ${verdict.cap} permitted searches.`,
                {},
                {
                    searchLimit: verdict.cap,
                    stage: "search-admission",
                    recovery: "Continue without another search in this turn.",
                    retryable: false,
                },
            );
        }
        if (verdict.verdict === "duplicate") {
            // {§stream-owner-scoped} — the prior ranked digest is the CALLER's own stream entry.
            const prior = await EntryCrud.readEntry(verdict.priorPathname, ctx, runtime, ctx.workerId);
            const raw = prior.entry?.channels["#results"]?.content ?? "";
            let results: unknown = raw;
            try { results = JSON.parse(raw); } catch { /* non-JSON results serve verbatim */ }
            return Dispatcher.#failure(
                "duplicate-search",
                409,
                "This search already ran in the current loop; the prior results are attached.",
                { results },
                {
                    recovery: "Use the attached prior results.",
                    retryable: false,
                },
            );
        }
        return this.#run("exec", statement, ctx);
    }

    #denyIfDisallowed(schemeName: string | null, origin: WriterTier): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName);
        if (handler === undefined) return null;
        const manifest = this.#schemes.manifestFor(schemeName);
        if (manifest === undefined) throw new Error(`registered scheme '${schemeName}' has no manifest`);
        if (manifest.writableBy.includes(origin)) return null;
        return Dispatcher.#failure(
            "writer-forbidden",
            403,
            `Writer '${origin}' cannot modify scheme '${schemeName}'.`,
            {},
            {
                writer: origin,
                scheme: schemeName,
                allowedWriters: [...manifest.writableBy],
                retryable: false,
            },
        ); // {§scheme-surface-writableby-403}
    }

    // Per-loop flag gating. Schemes self-declare their flag affinity in
    // their manifest (excludedInAsk / requiresWeb /
    // requiresInteraction); SchemeRegistry.resolveForLoop returns the
    // active set under the loop's persisted flags. A registered scheme outside
    // that set returns 403; unknown names continue to their operation owner for
    // the ordinary registration failure. Action-entry-as-outcome carries either.
    async #checkFlagsGate(statement: PlurnkStatement, loopId: number): Promise<DispatchResult | null> {
        // Broadcast SEND has no scheme to gate.
        if (statement.op === "SEND" && statement.target === null) return null;

        const flags = await LoopFlagsReader.read(this.#db, loopId);
        // Fast path: default flags gate nothing. (auto never gates.)
        if (!flags.noWeb && !flags.noInteraction && flags.mode === "act") return null;

        // {§mode-ask-read-only} — the ancient contract: an ask-mode loop NEVER changes the world. The
        // filesystem writes (EDIT/COPY-dest/MOVE/KILL touching the `file` scheme — each proposes disk
        // egress, {§membership}) are refused HERE, regardless of the scheme's read-activity, because
        // `file` stays active for READs. The EXEC host runtime is refused by its excludedInAsk scheme
        // below. This lived only in SPEC (line 65) with no anchor → no guard → it silently regressed.
        if (flags.mode === "ask") {
            const isFile = (t: PlurnkStatement["target"]): boolean => schemeNameOf(t) === "file";
            // Each branch narrows statement.op so statement.body is correctly typed (COPY dest is a
            // resource selection). EDIT/KILL write the target; COPY writes the dest;
            // MOVE deletes the source AND writes the dest - any `file` touch is a write.
            let writesFilesystem = false;
            if (statement.op === "EDIT" || statement.op === "KILL") writesFilesystem = isFile(statement.target);
            else if (statement.op === "COPY") writesFilesystem = isFile(statement.body?.target ?? null);
            else if (statement.op === "MOVE") writesFilesystem = isFile(statement.target) || isFile(statement.body?.target ?? null);
            if (writesFilesystem) {
                return Dispatcher.#failure(
                    "ask-mode-read-only",
                    403,
                    `${statement.op} cannot change the filesystem in an ask-mode loop.`,
                    {},
                    {
                        mode: flags.mode,
                        operation: statement.op,
                        recovery: "Answer or advise the user without changing the filesystem.",
                        retryable: false,
                    },
                );
            }
        }

        const active = this.#schemes.resolveForLoop(flags);
        // {§tools-loop-affinity}: name the non-retryable restriction so the model changes course.
        const restriction = flags.mode === "ask"
            ? "this is an ask-mode (read-only) loop — you cannot run commands or take host actions here"
            : flags.noWeb && flags.noInteraction ? "web and interaction are disabled for this loop"
            : flags.noWeb ? "web access is disabled for this loop"
            : "interaction is disabled for this loop";
        const checkScheme = (scheme: string | null): DispatchResult | null => {
            if (scheme === null || !this.#schemes.has(scheme)) return null;
            if (active.has(scheme)) return null;
            return Dispatcher.#failure(
                "scheme-unavailable",
                403,
                `Scheme '${scheme}' is unavailable because ${restriction}.`,
                {},
                {
                    scheme,
                    recovery: "Answer or advise the user without using the unavailable scheme.",
                    retryable: false,
                },
            );
        };
        const check = (target: PlurnkStatement["target"]): DispatchResult | null => checkScheme(schemeNameOf(target));

        if (this.#isWorkerControl(statement)) return check(statement.target); // body is a spawn/fork task, not a dst path
        if (statement.op === "COPY" || statement.op === "MOVE") {
            return check(statement.target) ?? check(statement.body?.target ?? null);
        }
        // {§exec-target-routing} — the operation owner and a non-file source
        // are independent authorities; local/file targets stay executor-local.
        if (statement.op === "EXEC") {
            const operationDenial = checkScheme("exec");
            if (operationDenial !== null) return operationDenial;
            const sourceScheme = schemeNameOf(statement.target);
            return sourceScheme === null || sourceScheme === "file" ? null : checkScheme(sourceScheme);
        }
        return check(statement.target);
    }

    // Worker control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new worker's seed prompt, not a destination path. The COPY gates and #handleCopy
    // branch on this so they never parse the prompt as a dst path.
    #isWorkerControl(statement: PlurnkStatement): boolean {
        return statement.op === "FORK" || statement.op === "WORK"; // worker control targets worker://<name> (grammar 0.74.55)
    }

    // WORK and FORK name the new worker in the target authority and carry its seed task in the body.
    // Their distinct fresh/branched histories are specified by {§worker-scheme-spawn} and {§worker-scheme-fork}.
    async #handleWorkerControl(statement: WorkStatement | ForkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const address = WorkerControlAddress.resolve(statement.target, statement.op);
        if (!address.ok) return address.result;
        const name = address.authority;
        try {
            WorkerName.assert(name); // {§worker-name-minting}
        } catch (error) {
            if (!(error instanceof WorkerNameError)) throw error;
            return Dispatcher.#failure(
                `worker-${error.code}`,
                400,
                error.message,
                {},
                {
                    operation: statement.op,
                    worker: error.workerName,
                    recovery: error.recovery,
                    retryable: false,
                },
            );
        }
        if (ctx.injectWorker === undefined) throw new Error("worker control: injectWorker capability absent");
        const denied = await WorkerCap.deny(this.#db, ctx.workspaceId);
        if (denied !== null) return denied;
        const prompt = statement.body;

        // {§worker-delegation-inherits-flags} — authority flows down the delegation edge: the child's live
        // loop runs with ITS DELEGATOR'S flags. A flagless (non-auto) child's every side-effecting op
        // proposes into a resolver-less void — 300s auto-cancel per attempt was the fan-out wedge.
        const flags = await LoopFlagsReader.read(this.#db, ctx.loopId);

        // A name is frozen per worker but reclaimable across time ({§machine-processes-worker-origin}): a LIVE
        // sister holding it is a 409 (legible, never a raw UNIQUE 500); a free/terminated name reclaims.
        const live = await this.#db.worker_live_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
        if (live !== undefined) {
            return Dispatcher.#failure(
                "worker-already-running",
                409,
                `Worker '${name}' is already running.`,
                {},
                { worker: name, retryable: false },
            );
        }

        if (typeof statement.signal === "string") {
            if (this.#branchWorker === undefined) throw new Error("branch worker control: branchWorker capability absent");
            const child = await this.#branchWorker({
                workspaceId: ctx.workspaceId,
                parentWorkerId: ctx.workerId,
                parentLoopId: ctx.loopId,
                parentTurnId: ctx.turnId,
                op: statement.op as "WORK" | "FORK",
                name,
                branch: statement.signal,
                prompt,
                flags,
                origin: ctx.writer,
            });
            return {
                status: 200,
                body: name,
                attrs: { branch: statement.signal, workerId: child.workerId, loopId: child.loopId },
            };
        }

        if (statement.op === "FORK") {
            // Branch the current worker's log into a named sister.
            const branchWorkerId = await Fork.fork(this.#db, ctx.workerId, name);
            await ctx.injectWorker({ workspaceId: ctx.workspaceId, workerId: branchWorkerId, prompt, flags });
            return { status: 200, body: name };
        }
        // WORK — a fresh worker sister named <name>.
        const row = await this.#db.fork_insert_worker.get<{ id: number }>({
            workspace_id: ctx.workspaceId, name, parent_worker_id: ctx.workerId, origin: ctx.writer,
        });
        if (row === undefined) throw new Error("worker spawn: worker insert returned no row");
        await ctx.injectWorker({ workspaceId: ctx.workspaceId, workerId: row.id, prompt, flags });
        return { status: 200, body: name };
    }

    async #handleCopy(statement: CopyStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.target === null) {
            return Dispatcher.#failure("copy-source-required", 400, "COPY requires a source path.", {}, { retryable: false });
        }
        if (statement.body === null) {
            return Dispatcher.#failure(
                "copy-destination-required",
                400,
                "COPY requires a destination.",
                {},
                { retryable: false },
            );
        }
        return this.#copyOrchestration({
            statement,
            source: {
                target: statement.target,
                lineMarker: statement.lineMarker,
            },
            destination: statement.body,
            ctx,
        });
    }

    async #handleMove(statement: MoveStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.target === null) {
            return Dispatcher.#failure("move-source-required", 400, "MOVE requires a source path.", {}, { retryable: false });
        }
        // MOVE is relocation only - deletion is KILL's job ({§move}, {§move-dev-null-not-special}). The /dev/null
        // and null-body delete-by-MOVE has no alternate meaning.
        if (statement.body === null) {
            return Dispatcher.#failure(
                "move-destination-required",
                400,
                "MOVE requires a destination.",
                {},
                {
                    recovery: "Use KILL when the intended operation is deletion.",
                    retryable: false,
                },
            );
        }
        return this.#moveOrchestration({
            statement,
            source: {
                target: statement.target,
                lineMarker: statement.lineMarker,
            },
            destination: statement.body,
            ctx,
        });
    }

    // KILL is target-polymorphic. Scheme handlers own the optional numeric code's
    // meaning; core retains worker and entry dispatch. {§operation-code-polymorphism}
    async #handleKill(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "KILL") throw new Error("unreachable");
        const path = statement.target;
        if (path === null) {
            return Dispatcher.#failure("kill-target-required", 400, "KILL requires a target path.", {}, { retryable: false });
        }
        const schemeName = schemeNameOf(path);
        if (schemeName === null) {
            return Dispatcher.#failure(
                "kill-target-scheme-required",
                400,
                "KILL target requires a scheme.",
                {},
                { retryable: false },
            );
        }
        // Log targets use the same killable dispatch as streams; erasure is their
        // permanent curation operation. {§model-entry-log-curation}
        // Process-KILL: any scheme whose handler exposes kill() aborts a live stream — the
        // exec handler, registered as "exec" + under every runtime tag (sh/node), so a tag-
        // addressed stream (sh:///l/t/s) routes here, not to deleteEntry. {§exec}
        const killable = this.#schemes.get(schemeName) as { kill?: (pathname: string, signal: number | null, ctx: SchemeCtx, scheme?: string) => Promise<SchemeResult> } | undefined;
        if (killable !== undefined && typeof killable.kill === "function") {
            // Pass the model's OWN scheme so a stream-KILL error answers in the runtime tag the
            // model addressed (sh:///…), not the internal `exec` ({§fs-answer-in-canon}).
            const handlerCtx = this.#handlerContext(schemeName, ctx);
            if (handlerCtx === null) {
                throw new InvalidOperationResultError(`Registered scheme '${schemeName}' has no dispatch context.`);
            }
            return await killable.kill(entryPathnameOf(path), statement.signal, handlerCtx, schemeName);
        }
        if (schemeName === "worker") {
            // Entry-path present → KILL a private owner-held entry (delete it), self-only —
            // NOT worker cancellation. The authority (hostname) names the owner, the pathname the
            // entry; only the path-ABSENT form (worker://<name>) terminates the worker-as-actor. {§worker-scheme}
            const entryPath = path.kind === "url" ? (path.pathname ?? "") : "";
            if (entryPath !== "" && entryPath !== "/") {
                const workerHandler = this.#schemes.get("worker") as { killEntry: (s: PlurnkStatement, c: SchemeCtx) => Promise<SchemeResult> };
                const handlerCtx = this.#handlerContext("worker", ctx);
                if (handlerCtx === null) {
                    throw new InvalidOperationResultError("Registered scheme 'worker' has no dispatch context.");
                }
                return await workerHandler.killEntry(statement, handlerCtx);
            }
            const address = WorkerControlAddress.resolve(path, "KILL");
            if (!address.ok) return address.result;
            // `~` is the sole current-worker sigil; every other authority is a literal name.
            // An idle worker is a no-op 200; a missing named worker is 404. {§worker-control-addressing}
            const name = address.authority;
            let workerId = ctx.workerId;
            if (name !== "~") {
                const row = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
                if (row === undefined) {
                    return Dispatcher.#failure(
                        "worker-not-found",
                        404,
                        `Worker '${name}' does not exist in this workspace.`,
                        {},
                        { worker: name, retryable: false },
                    );
                }
                workerId = row.id;
            }
            if (this.#cancelWorker === undefined) throw new Error("worker kill: cancelWorker capability absent");
            // {§op-synchronous} — KILL is decisive. Await the one lifecycle owner so the
            // same-turn pending-work gate observes the complete subtree as terminal.
            await this.#cancelWorker(workerId, "killed via worker:// KILL");
            return { status: 200 };
        }
        if (!this.#schemes.has(schemeName)) {
            return Dispatcher.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        // A host-effecting delete (file) returns 202 to PROPOSE — pass its attrs through so the proposal
        // carries the delete target to review (#isProposal fires on 202). Plurnk-internal deletes execute inline.
        return this.#deleteEntry(schemeName, entryPathnameOf(path), ctx);
    }

    // {§model-entry} — mirror an admitted model emission back as an actionless `model` log row, so
    // the model can inspect and curate its own prior behavior.
    // Born FOLDED by default (budget-neutral until OPENed); the turn-0 exemplar passes folded:false
    // (born open — the one worked example the model orients on, thinning the grammar). text/vnd.plurnk.
    async writeModelEntry({ verbatim, workerId, loopId, turnId, sequence, folded, origin = "model", reasoningItems }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number; folded: boolean; origin?: WriterTier;
        // {§encrypted-reasoning-carrier} — relay provider-normalized encrypted
        // reasoning items as opaque mirror-row evidence.
        reasoningItems?: ReadonlyArray<ProviderEncryptedReasoningItem>;
    }): Promise<number> {
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
            origin, source: null, op: "model", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ content: verbatim, mimetype: "text/vnd.plurnk" }),
            mimetype_rx: "application/json",
            status_rx: 200, tokens: this.#tokenize(verbatim), state: "resolved", outcome: null,
            attrs: reasoningItems !== undefined && reasoningItems.length > 0 ? JSON.stringify({ reasoning: reasoningItems }) : "{}",
        });
        if (row === undefined) throw new Error("Dispatcher.writeModelEntry: insert returned no row");
        if (folded) await this.#db.engine_fold_log_entry.run({ id: row.id });
        return row.id;
    }

    // PLAN — the model's intended-goals op. An ordinary op: dispatched like any
    // other, logged, and broadcast to the client as a log entry — but a pure no-op for
    // state (PLAN ∉ MUTATING_OPS); its body serializes into the log row's tx, no effect.
    #handlePlan(statement: PlurnkStatement): DispatchResult {
        if (statement.op !== "PLAN") throw new Error("unreachable");
        return { status: 200 };
    }

    static #isDispatchResult(
        value: ResolvedResourceSelection | SelectedSource | DispatchResult,
    ): value is DispatchResult {
        return "status" in value;
    }

    async #resolveResourceSelection(
        selection: ResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<ResolvedResourceSelection | DispatchResult> {
        const { target, lineMarker } = selection;
        const scheme = schemeNameOf(target);
        if (scheme === null) {
            return Dispatcher.#failure(
                "resource-scheme-required",
                400,
                "COPY and MOVE resources require a scheme.",
                {},
                { retryable: false },
            );
        }
        if (target.kind === "url" && target.scheme === "worker" && (target.hostname ?? "") !== "") {
            return Dispatcher.#failure(
                "worker-copy-address-invalid",
                400,
                "COPY and MOVE do not address named worker spaces.",
                {},
                {
                    recovery: "Move worker-space content with READ and EDIT.",
                    retryable: false,
                },
            );
        }
        const handler = this.#schemes.get(scheme);
        const manifest = this.#schemes.manifestFor(scheme);
        if (handler === undefined || manifest === undefined) {
            return Dispatcher.#failure(
                "scheme-not-found",
                501,
                `COPY or MOVE addressed the unregistered scheme '${scheme}'.`,
                {},
                {
                    scheme,
                    retryable: false,
                },
            );
        }
        if (manifest.category !== "data") {
            return Dispatcher.#failure(
                "entry-operation-unsupported",
                400,
                `COPY and MOVE require entry-bearing resources; '${scheme}' is a ${manifest.category} scheme.`,
                {},
                {
                    scheme,
                    category: manifest.category,
                    retryable: false,
                },
            );
        }
        const fragment = target.kind === "url" ? target.fragment : null;
        const channel = fragment ?? manifest.defaultChannel;
        if (channel.length === 0) {
            return Dispatcher.#failure(
                "channel-required",
                400,
                `The '${scheme}' scheme has no default channel.`,
                {},
                {
                    scheme,
                    recovery: "Address a named channel with a URI fragment.",
                    retryable: false,
                },
            );
        }
        if (
            fragment !== null
            && fragment !== manifest.defaultChannel
            && !Object.hasOwn(manifest.channels, fragment)
        ) {
            const availableChannels = [
                ...new Set([manifest.defaultChannel, ...Object.keys(manifest.channels)]),
            ].filter((candidate) => candidate.length > 0);
            return Dispatcher.#failure(
                "channel-not-found",
                400,
                `Channel #${fragment} is not declared by the '${scheme}' scheme.`,
                {},
                {
                    requestedChannel: fragment,
                    availableChannels,
                    retryable: false,
                },
            );
        }
        const pathname = entryPathnameOf(target);
        const canonicalFilePath = scheme === "file"
            ? Namespace.canonicalizeSpelling(pathname, await this.#workspaceRoot(ctx.workspaceId))
            : pathname;
        return {
            target,
            lineMarker,
            scheme,
            pathname,
            identityPathname: canonicalFilePath ?? pathname,
            channel,
            manifest,
        };
    }

    async #selectSource(
        selection: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<SelectedSource | DispatchResult> {
        const read = await this.#readEntry(selection.scheme, selection.pathname, ctx);
        if (read.status >= 400) return read;
        if (read.status !== 200 || read.entry === null) {
            throw new InvalidOperationResultError(
                `The '${selection.scheme}' scheme returned status ${read.status} without a COPY/MOVE source entry.`,
            );
        }
        const selected = read.entry.channels[selection.channel];
        if (selected === undefined) {
            return Dispatcher.#failure(
                "channel-not-found",
                404,
                `No channel named #${selection.channel} exists at ${renderAddress(selection.scheme, selection.identityPathname)}.`,
                {},
                {
                    target: renderAddress(selection.scheme, selection.identityPathname),
                    requestedChannel: selection.channel,
                    availableChannels: Object.keys(read.entry.channels),
                    retryable: false,
                },
            );
        }
        let content = selected.content;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        if (await MimetypeBinary.isBinaryMimetype(selected.mimetype, ctx.mimetypes)) {
            return Dispatcher.#failure(
                "binary-source-unsupported",
                415,
                `Channel #${selection.channel} is a binary marker and cannot be copied or moved.`,
                {},
                {
                    channel: selection.channel,
                    mimetype: selected.mimetype,
                    recovery: "Use a source with a readable text projection.",
                    retryable: false,
                },
            );
        }
        if (selection.lineMarker !== null) {
            const sliced = LineMarkerOps.sliceLinesRaw(content, selection.lineMarker);
            if (sliced.status !== 200) return Results.assert(sliced) as DispatchResult;
            content = sliced.text ?? "";
            scopeNormalizations = sliced.scopeNormalizations;
        }
        return {
            ...selection,
            content,
            mimetype: selected.mimetype,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };
    }

    static #prependScopeNormalizations(
        result: DispatchResult,
        scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined,
    ): DispatchResult {
        if (scopeNormalizations === undefined) return result;
        return Results.assert({
            ...result,
            scopeNormalizations: [
                ...scopeNormalizations,
                ...(result.scopeNormalizations ?? []),
            ],
        });
    }

    #resourceAddress(selection: ResolvedResourceSelection): string {
        const address = renderTarget({
            scheme: selection.scheme === "file" ? null : selection.scheme,
            pathname: selection.scheme === "file"
                ? selection.identityPathname.replace(/^\//, "")
                : selection.identityPathname,
            fragment: selection.channel === selection.manifest.defaultChannel
                ? null
                : selection.channel,
        });
        if (address === null) throw new Error("resolved resource selection has no renderable address");
        return address;
    }

    #pendingEffect(
        selection: ResolvedResourceSelection,
        action: ResourceEffectAction,
    ): PendingResourceEffect {
        return {
            target: this.#resourceAddress(selection),
            action,
        };
    }

    static #appliedEffects(
        result: DispatchResult,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        // {§edit-result-copy-move-effects} — only an applied mutation earns
        // engine-composed effects; native scheme receipts remain internal input.
        const exact = Results.assert(result);
        if (exact.status === 304 || exact.status === 202 || exact.status >= 300) return exact;
        if (exact.effects !== undefined) {
            throw new InvalidOperationResultError(
                "A COPY/MOVE mutation result supplied effects before engine composition.",
            );
        }
        const batch = exact.editReceipt === undefined
            ? undefined
            : assertEditBatchReceipt(exact.editReceipt);
        const single = batch === undefined && exact.receipt !== undefined
            ? assertEditReceipt(exact.receipt)
            : undefined;
        const batchSize = batch === undefined
            ? undefined
            : "disposition" in batch
                ? batch.superseded.length
                : batch.effects.length;
        if (batchSize !== undefined && batchSize !== pending.length) {
            throw new InvalidOperationResultError(
                `COPY/MOVE expected ${pending.length} receipt projections, got ${batchSize}.`,
            );
        }
        if (single !== undefined && pending.length !== 1) {
            throw new InvalidOperationResultError(
                `COPY/MOVE received one receipt for ${pending.length} resource effects.`,
            );
        }
        let effects: ResourceEffect[];
        if (batch !== undefined && "disposition" in batch) {
            const replacement = pending[0];
            if (replacement === undefined) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch has no resource effect.",
                );
            }
            if (pending.some(({ target, action }) =>
                target !== replacement.target || action !== replacement.action
            )) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch spans incompatible resource effects.",
                );
            }
            effects = [{
                ...replacement,
                receipt: projectEditReceipt(batch, 0),
            }];
        } else {
            effects = pending.map((effect, index): ResourceEffect => ({
                ...effect,
                ...(batch !== undefined
                    ? { receipt: projectEditReceipt(batch, index) }
                    : single !== undefined
                        ? { receipt: single }
                        : {}),
            }));
        }
        assertResourceEffects(effects);
        const {
            editReceipt: _editReceipt,
            receipt: _receipt,
            ...withoutInternalReceipts
        } = exact;
        return {
            ...withoutInternalReceipts,
            effects,
        };
    }

    // {§copy-move-observation} {§edit-result-copy-move-effects} — scoped
    // COPY/MOVE into an unscoped channel is a text materialization even when
    // CRUD creates the channel wholesale. Carry the receipt through synchronous
    // writes and proposals; the destination scheme owns reviewed output.
    static #withEditMaterialization(
        result: DispatchResult,
        receipt: EditBatchReceipt,
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status !== 200 && exact.status !== 201 && exact.status !== 202) return exact;
        const materialized = exact.editReceipt === undefined
            ? assertEditBatchReceipt(receipt)
            : assertEditBatchReceipt(exact.editReceipt);
        return {
            ...exact,
            editReceipt: materialized,
            ...(exact.status === 202
                ? {
                    attrs: {
                        ...(exact.attrs as Record<string, unknown> | undefined),
                        editReceipt: materialized,
                    },
                }
                : {}),
        };
    }

    #finalizeEffects(
        result: DispatchResult,
        selection: ResolvedResourceSelection,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        const routed = this.#withProposalRoute(result, selection);
        if (routed.status !== 202) return Dispatcher.#appliedEffects(routed, pending);
        return {
            ...routed,
            attrs: {
                ...(routed.attrs as Record<string, unknown> | undefined),
                proposalEffects: pending,
            },
        };
    }

    static #effectsOf(result: DispatchResult): readonly ResourceEffect[] {
        return result.effects === undefined
            ? []
            : assertResourceEffects(result.effects);
    }

    static #withCombinedEffects(
        result: DispatchResult,
        ...additional: ReadonlyArray<readonly ResourceEffect[]>
    ): DispatchResult {
        const existing = Dispatcher.#effectsOf(result);
        const effects = [...existing, ...additional.flat()];
        const { effects: _effects, ...withoutEffects } = result;
        return effects.length === 0
            ? withoutEffects
            : { ...withoutEffects, effects: assertResourceEffects(effects) };
    }

    static #settleProposalEffects(
        original: DispatchResult,
        settlement: ProposalSettlement,
    ): ProposalSettlement {
        const pending = (original.attrs as OrchestrationProposalAttrs | undefined)
            ?.proposalEffects;
        if (
            pending === undefined
            || settlement.resolution.decision !== "accept"
            || settlement.applied === undefined
            || settlement.applied.status >= 300
        ) {
            return settlement;
        }
        const projected = settlement.resolution.result ?? {};
        const aggregate = settlement.applied.editReceipt;
        const applied = Dispatcher.#appliedEffects(
            {
                ...projected,
                status: settlement.applied.status,
                ...(aggregate === undefined ? {} : { editReceipt: aggregate }),
            },
            pending,
        );
        const {
            status: _status,
            body: _body,
            ...result
        } = applied;
        const {
            body: _resolutionBody,
            ...resolution
        } = settlement.resolution;
        return {
            ...settlement,
            resolution: {
                ...resolution,
                result,
            },
        };
    }

    #recordEditSettlement(
        statement: PlurnkStatement,
        settlement: ProposalSettlement,
    ): void {
        if (statement.op !== "EDIT") return;
        const prepared = this.#preparedEdits.get(statement);
        if (prepared === undefined || !prepared.first) {
            throw new InvalidOperationResultError(
                "An EDIT proposal settled without its prepared batch owner.",
            );
        }
        const { resolution, applied } = settlement;
        if (
            resolution.decision !== "accept"
            || applied === undefined
            || applied.status >= 300
        ) {
            prepared.batch.aggregate = undefined;
            return;
        }
        if (applied.editReceipt === null) {
            prepared.batch.aggregate = undefined;
            return;
        }
        if (applied.editReceipt !== undefined) {
            prepared.batch.aggregate = assertEditBatchReceipt(applied.editReceipt);
            return;
        }
        if (resolution.body !== undefined) prepared.batch.aggregate = undefined;
    }

    static #settlementEffects(settlement: ProposalSettlement): readonly ResourceEffect[] {
        const effects = (settlement.resolution.result as Record<string, unknown> | undefined)
            ?.effects;
        return effects === undefined ? [] : assertResourceEffects(effects);
    }

    static #withSettlementEffects(
        settlement: ProposalSettlement,
        effects: readonly ResourceEffect[],
    ): ProposalSettlement {
        const projected = (settlement.resolution.result ?? {}) as Record<string, unknown>;
        const { effects: _effects, ...withoutEffects } = projected;
        const result = effects.length === 0
            ? withoutEffects
            : {
                ...withoutEffects,
                effects: assertResourceEffects(effects),
            };
        return {
            ...settlement,
            resolution: {
                ...settlement.resolution,
                result,
            },
        };
    }

    #sameChannel(
        left: ResolvedResourceSelection,
        right: ResolvedResourceSelection,
    ): boolean {
        return left.scheme === right.scheme
            && left.identityPathname === right.identityPathname
            && left.channel === right.channel;
    }

    #withProposalRoute(
        result: DispatchResult,
        selection: ResolvedResourceSelection,
    ): DispatchResult {
        if (result.status !== 202) return result;
        return {
            ...result,
            attrs: {
                ...(result.attrs as Record<string, unknown> | undefined),
                proposalScheme: selection.scheme,
                proposalTarget: {
                    scheme: selection.scheme,
                    pathname: selection.identityPathname,
                },
            },
        };
    }

    async #invokeEditBatch(
        selection: ResolvedResourceSelection,
        edits: ReadonlyArray<{
            readonly marker: LineMarker;
            readonly body: string;
            readonly tags: string[] | null;
            readonly position: EditStatement["position"];
        }>,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const handler = this.#schemes.get(selection.scheme) as SchemeHandler | undefined;
        if (typeof handler?.editBatch !== "function") {
            return Dispatcher.#failure(
                "operation-not-implemented",
                501,
                `Scheme '${selection.scheme}' does not implement EDIT batches.`,
                {},
                {
                    scheme: selection.scheme,
                    operation: "EDIT",
                    retryable: false,
                },
            );
        }
        const statements: EditStatement[] = edits.map(({ marker, body, tags, position }) => ({
            op: "EDIT",
            suffix: "",
            signal: tags,
            target: selection.target,
            lineMarker: marker,
            body,
            position,
        }));
        const addressedScheme = selection.target.kind === "url"
            ? selection.target.scheme
            : selection.scheme;
        try {
            const result = Results.assert(await handler.editBatch(
                statements,
                new SchemeCtxImpl(
                    ctx,
                    addressedScheme,
                    selection.manifest,
                    this.#liveSubscriptions,
                ),
            ));
            return this.#withProposalRoute(result, selection);
        } catch (err) {
            if (err instanceof InvalidOperationResultError) throw err;
            console.error(
                `Scheme '${selection.scheme}' COPY/MOVE edit threw outside its operation result contract:`,
                err,
            );
            return Dispatcher.#failure(
                "scheme-handler-threw",
                500,
                `The '${selection.scheme}' scheme did not produce a COPY/MOVE edit result.`,
                {},
                {
                    stage: "scheme-dispatch",
                    scheme: selection.scheme,
                    operation: "EDIT",
                },
            );
        }
    }

    async #writeDestination(
        statement: CopyStatement | MoveStatement,
        source: SelectedSource,
        destination: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const existingResult = await this.#readEntry(
            destination.scheme,
            destination.pathname,
            ctx,
        );
        if (existingResult.status >= 400 && existingResult.status !== 404) {
            return existingResult;
        }
        const existing = existingResult.status === 200
            ? existingResult.entry
            : null;
        if (existingResult.status === 200 && existing === null) {
            throw new InvalidOperationResultError(
                `The '${destination.scheme}' scheme returned 200 without a destination entry.`,
            );
        }
        const destinationChannel = existing?.channels[destination.channel];
        const expectedMimetype = destinationChannel?.mimetype
            ?? await PathMimetype.resolveEntryMimetype(
                destination.pathname,
                destination.manifest.channels[destination.channel] ?? source.mimetype,
                ctx.mimetypes,
            );
        if (source.mimetype !== expectedMimetype) {
            return Dispatcher.#failure(
                "mimetype-mismatch",
                415,
                `COPY or MOVE cannot write '${source.mimetype}' into a '${expectedMimetype}' channel.`,
                {},
                {
                    channel: destination.channel,
                    sourceMimetype: source.mimetype,
                    destinationMimetype: expectedMimetype,
                    retryable: false,
                },
            );
        }

        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        const destinationEffect = this.#pendingEffect(
            destination,
            destinationChannel === undefined ? "create" : "update",
        );
        if (destination.lineMarker !== null) {
            if (destinationChannel === undefined) {
                return Dispatcher.#failure(
                    "destination-region-not-found",
                    404,
                    `A destination region requires an existing #${destination.channel} channel.`,
                    {},
                    {
                        destination: this.#resourceAddress(destination),
                        retryable: false,
                    },
                );
            }
            if (await MimetypeBinary.isBinaryMimetype(destinationChannel.mimetype, ctx.mimetypes)) {
                return Dispatcher.#failure(
                    "binary-region-unsupported",
                    415,
                    `Channel #${destination.channel} is binary and cannot receive a textual region.`,
                    {},
                    {
                        channel: destination.channel,
                        mimetype: destinationChannel.mimetype,
                        retryable: false,
                    },
                );
            }
            const edited = await this.#invokeEditBatch(
                destination,
                [{
                    marker: destination.lineMarker,
                    body: source.content,
                    tags,
                    position: statement.position,
                }],
                ctx,
            );
            return this.#finalizeEffects(edited, destination, [destinationEffect]);
        }

        if (
            destinationChannel !== undefined
            && destinationChannel.content !== source.content
        ) {
            return Dispatcher.#failure(
                "copy-destination-exists",
                409,
                `COPY or MOVE destination ${this.#resourceAddress(destination)} already contains different content.`,
                {},
                {
                    destination: this.#resourceAddress(destination),
                    retryable: false,
                },
            );
        }
        const priorTags = existing?.tags ?? [];
        const mergedTags = [...new Set([...priorTags, ...tags])];
        const addsTags = mergedTags.length !== priorTags.length;
        if (destinationChannel !== undefined && !addsTags) return { status: 304 };

        const channels = {
            ...(existing?.channels ?? {}),
            [destination.channel]: {
                content: source.content,
                mimetype: source.mimetype,
            },
        };
        const written = await this.#writeEntry(
            destination.scheme,
            destination.pathname,
            { channels, tags: mergedTags },
            ctx,
        );
        const exactWritten = Results.assert(written);
        const materialized = source.lineMarker === null
            || (exactWritten.status !== 200 && exactWritten.status !== 201 && exactWritten.status !== 202)
            ? exactWritten
            : Dispatcher.#withEditMaterialization(
                exactWritten,
                editReceipt(
                    destinationChannel?.content ?? "",
                    source.content,
                    [{
                        marker: { marks: [1, -1] },
                        body: source.content,
                    }],
                ),
            );
        return this.#finalizeEffects(
            materialized,
            destination,
            [destinationEffect],
        );
    }

    async #copyOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: CopyStatement;
        source: ResourceSelection;
        destination: ResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#resolveResourceSelection(source, ctx);
        if (Dispatcher.#isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#resolveResourceSelection(destination, ctx);
        if (Dispatcher.#isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selectSource(resolvedSource, ctx);
        if (Dispatcher.#isDispatchResult(selected)) return selected;
        const result = await this.#writeDestination(statement, selected, resolvedDestination, ctx);
        return Dispatcher.#prependScopeNormalizations(result, selected.scopeNormalizations);
    }

    #deferredMoveSource(
        source: ResolvedResourceSelection,
        destination: ResolvedResourceSelection,
    ): DeferredMoveSource {
        return {
            target: source.target,
            lineMarker: source.lineMarker,
            scheme: source.scheme,
            pathname: source.pathname,
            channel: source.channel,
            destination: this.#resourceAddress(destination),
        };
    }

    #moveFailureAfterDestination(
        result: DispatchResult,
        destination: string,
        destinationEffects: readonly ResourceEffect[],
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status < 400) {
            throw new InvalidOperationResultError(
                "A successful MOVE source result was classified as a partial failure.",
            );
        }
        if (exact.problem === undefined) {
            throw new InvalidOperationResultError(
                "A failed MOVE source mutation has no Problem Details.",
            );
        }
        const failed = Results.assert({
            ...exact,
            problem: {
                ...exact.problem,
                operation: "MOVE",
                destinationWritten: true,
                destination,
            },
        });
        return Dispatcher.#withCombinedEffects(failed, destinationEffects);
    }

    async #removeMoveSource(
        statement: MoveStatement,
        source: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const effect = this.#pendingEffect(
            source,
            source.lineMarker === null ? "delete" : "update",
        );
        if (source.lineMarker === null) {
            const deleted = await this.#deleteChannel(
                source.scheme,
                source.pathname,
                source.channel,
                ctx,
            );
            return this.#finalizeEffects(Results.assert(deleted), source, [effect]);
        }
        const edited = await this.#invokeEditBatch(
            source,
            [{
                marker: source.lineMarker,
                body: "",
                tags: null,
                position: statement.position,
            }],
            ctx,
        );
        return this.#finalizeEffects(edited, source, [effect]);
    }

    async #moveWithinChannel(
        statement: MoveStatement,
        source: SelectedSource,
        destination: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (source.lineMarker === null) {
            if (destination.lineMarker !== null) {
                return Dispatcher.#failure(
                    "move-region-overlap",
                    409,
                    "MOVE cannot insert a whole channel into itself and then remove that channel.",
                    {},
                    {
                        source: this.#resourceAddress(source),
                        destination: this.#resourceAddress(destination),
                        retryable: false,
                    },
                );
            }
            return this.#writeDestination(statement, source, destination, ctx);
        }
        if (destination.lineMarker === null) {
            return this.#writeDestination(statement, source, destination, ctx);
        }
        const moved = await this.#invokeEditBatch(
            destination,
            [
                {
                    marker: destination.lineMarker,
                    body: source.content,
                    tags: Array.isArray(statement.signal) ? statement.signal : [],
                    position: statement.position,
                },
                {
                    marker: source.lineMarker,
                    body: "",
                    tags: null,
                    position: statement.position,
                },
            ],
            ctx,
        );
        const effect = this.#pendingEffect(destination, "update");
        return this.#finalizeEffects(moved, destination, [effect, effect]);
    }

    async #moveOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: MoveStatement;
        source: ResourceSelection;
        destination: ResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#resolveResourceSelection(source, ctx);
        if (Dispatcher.#isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#resolveResourceSelection(destination, ctx);
        if (Dispatcher.#isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selectSource(resolvedSource, ctx);
        if (Dispatcher.#isDispatchResult(selected)) return selected;

        if (this.#sameChannel(resolvedSource, resolvedDestination)) {
            const result = await this.#moveWithinChannel(
                statement,
                selected,
                resolvedDestination,
                ctx,
            );
            return resolvedDestination.lineMarker === null
                ? Dispatcher.#prependScopeNormalizations(result, selected.scopeNormalizations)
                : result;
        }

        const destinationResult = Dispatcher.#prependScopeNormalizations(
            await this.#writeDestination(
                statement,
                selected,
                resolvedDestination,
                ctx,
            ),
            selected.scopeNormalizations,
        );
        if (destinationResult.status >= 400) return destinationResult;
        const destinationAddress = this.#resourceAddress(resolvedDestination);
        const destinationEffects = Dispatcher.#effectsOf(destinationResult);
        if (destinationResult.status === 202) {
            return {
                ...destinationResult,
                attrs: {
                    ...(destinationResult.attrs as Record<string, unknown> | undefined),
                    moveSource: this.#deferredMoveSource(
                        resolvedSource,
                        resolvedDestination,
                    ),
                },
            };
        }

        const sourceResult = await this.#removeMoveSource(
            statement,
            resolvedSource,
            ctx,
        );
        if (sourceResult.status === 202) {
            return {
                ...sourceResult,
                ...(destinationResult.scopeNormalizations === undefined
                    ? {}
                    : { scopeNormalizations: destinationResult.scopeNormalizations }),
                attrs: {
                    ...(sourceResult.attrs as Record<string, unknown> | undefined),
                    moveDestinationWritten: destinationAddress,
                    moveDestinationEffects: destinationEffects,
                },
            };
        }
        if (sourceResult.status >= 400) {
            return this.#moveFailureAfterDestination(
                destinationResult.scopeNormalizations === undefined
                    ? sourceResult
                    : Results.assert({
                        ...sourceResult,
                        scopeNormalizations: destinationResult.scopeNormalizations,
                    }),
                destinationAddress,
                destinationEffects,
            );
        }
        const base = destinationResult.status === 304
            ? { ...destinationResult, status: 200 }
            : destinationResult;
        return Dispatcher.#withCombinedEffects(
            base,
            Dispatcher.#effectsOf(sourceResult),
        );
    }

    async #settleMoveProposal({
        statement,
        result,
        settlement,
        ctx,
        ids,
    }: {
        statement: PlurnkStatement;
        result: DispatchResult;
        settlement: ProposalSettlement;
        ctx: PlurnkSchemeContext;
        ids: {
            workspaceId: number;
            workerId: number;
            loopId: number;
            turnId: number;
        };
    }): Promise<ProposalSettlement> {
        if (statement.op !== "MOVE") return settlement;
        const attrs = result.attrs as OrchestrationProposalAttrs | undefined;
        const destinationWritten = attrs?.moveDestinationWritten;
        if (destinationWritten !== undefined) {
            const destinationEffects = attrs?.moveDestinationEffects === undefined
                ? []
                : assertResourceEffects(attrs.moveDestinationEffects);
            if (settlement.resolution.decision !== "accept") {
                const decision = settlement.resolution.decision;
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        Dispatcher.#failure(
                            "move-source-not-applied",
                            decision === "cancel" ? 499 : 409,
                            `The MOVE destination was written, but source removal was ${decision === "cancel" ? "cancelled" : "rejected"}.`,
                            {},
                            {
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied === undefined) {
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        Dispatcher.#failure(
                            "proposal-apply-missing",
                            500,
                            "The source scheme accepted its MOVE proposal without applying the source mutation.",
                            {},
                            {
                                stage: "proposal-application",
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied.status >= 400) {
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        settlement.applied,
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            return Dispatcher.#withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...Dispatcher.#settlementEffects(settlement),
                ],
            );
        }

        const deferred = attrs?.moveSource;
        if (
            deferred === undefined
            || settlement.resolution.decision !== "accept"
            || (settlement.applied?.status ?? 200) >= 400
        ) {
            return settlement;
        }
        if (settlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: Dispatcher.#failure(
                    "proposal-apply-missing",
                    500,
                    "The destination scheme accepted its MOVE proposal without applying the destination mutation.",
                    {},
                    {
                        stage: "proposal-application",
                        retryable: false,
                    },
                ),
            };
        }
        const destinationEffects = Dispatcher.#settlementEffects(settlement);

        const resolvedSource = await this.#resolveResourceSelection(
            {
                target: deferred.target,
                lineMarker: deferred.lineMarker,
            },
            ctx,
        );
        if (Dispatcher.#isDispatchResult(resolvedSource)) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    resolvedSource,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (
            resolvedSource.scheme !== deferred.scheme
            || resolvedSource.pathname !== deferred.pathname
            || resolvedSource.channel !== deferred.channel
        ) {
            throw new InvalidOperationResultError(
                "A deferred MOVE source no longer resolves to its recorded identity.",
            );
        }

        const removed = await this.#removeMoveSource(statement, resolvedSource, ctx);
        if (removed.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    removed,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (removed.status !== 202) {
            return Dispatcher.#withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...Dispatcher.#effectsOf(removed),
                ],
            );
        }

        const initialSourceSettlement = await this.#proposals.workerApply(
            statement,
            removed,
            { decision: "accept" },
            ids,
        );
        const sourceSettlement = Dispatcher.#settleProposalEffects(
            removed,
            initialSourceSettlement,
        );
        if (sourceSettlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    Dispatcher.#failure(
                        "proposal-apply-missing",
                        500,
                        "The source scheme accepted its MOVE proposal without applying the source mutation.",
                        {},
                        {
                            stage: "proposal-application",
                            retryable: false,
                        },
                    ),
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (sourceSettlement.applied.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    sourceSettlement.applied,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        return Dispatcher.#withSettlementEffects(
            settlement,
            [
                ...destinationEffects,
                ...Dispatcher.#settlementEffects(sourceSettlement),
            ],
        );
    }

    // {§send-premature-terminate} — the unified PENDING SET, judged at the terminal's OWN dispatch
    // (post-batch: the emission's earlier ops already executed, so a same-turn KILL+[200] repairs in
    // ONE turn, and a same-turn WORK+[200] is caught — the spawn is live by the time the SEND lands).
    // pending = open streams ∪ live children ∪ THIS turn's retrievals (READ/FIND/OPEN, results unseen
    // until next packet). Failed operations are the separate next-packet leg shared by explicit
    // completion and empty-join completion. Nothing pending may be silently discarded; 499 discards
    // BY STATED INTENT and is never gated.
    async #pendingSet(workerId: number, turnId: number): Promise<string[]> {
        const pending: string[] = [];
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        if (openSubs.length > 0 || execHandler?.hasActiveSpawns?.(workerId) === true) pending.push("surviving streams");
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        if (liveChild !== undefined) pending.push("surviving workers");
        const observations = await this.#pendingObservations(workerId, turnId);
        if (observations.retrievals) pending.push("this turn's retrieval results (they land in the NEXT packet's Log)");
        if (observations.streamTerminations) {
            pending.push("completed stream results that land in the NEXT packet's Log");
        }
        if (observations.childTerminations) pending.push("worker results that arrived during this turn (they land NEXT turn)");
        return pending;
    }

    // Results cross an observation boundary only when they have appeared in a
    // packet. Completion alone is not delivery. Keep the three next-packet
    // producers in one classifier so SEND[200]'s discard gate and SEND[202]'s
    // empty-join decision cannot disagree about what remains unseen.
    async #pendingObservations(workerId: number, turnId: number): Promise<{
        retrievals: boolean;
        streamTerminations: boolean;
        childTerminations: boolean;
    }> {
        const [retrievals, streamTermination, childTermination] = await Promise.all([
            this.#db.engine_turn_retrievals.all<{ id: number }>({ turn_id: turnId }),
            this.#db.engine_worker_has_undelivered_stream_term
                .get<{ pending: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_undelivered_child_term
                .get<{ pending: number }>({ worker_id: workerId }),
        ]);
        return {
            retrievals: retrievals.length > 0,
            streamTerminations: streamTermination !== undefined,
            childTerminations: childTermination !== undefined,
        };
    }

    // A failed operation is also an unobserved result: it does not enter the
    // model's Log until the next packet. Both explicit completion and an
    // already-drained join must cross that observation boundary before they
    // can honestly finish the loop.
    async #unobservedFailureCount(turnId: number): Promise<number> {
        const failedRows = await this.#db.engine_turn_failures.all<{ id: number }>({ turn_id: turnId });
        return failedRows.length;
    }

    static #unobservedFailures(failCount: number): DispatchResult {
        return Dispatcher.#failure(
            "unobserved-failures",
            409,
            `Completion was refused because ${failCount} failed operation(s) from this turn have not been observed.`,
            {},
            {
                failures: failCount,
                stage: "completion",
                recovery: "Review the failed log items before concluding.",
                retryable: false,
            },
        );
    }

    // J — a live obligation to WAIT on: a spawned child or an open stream (NOT retrievals, which land
    // next turn regardless). The wait-side twin of #pendingSet's stream+child legs ({§wait-obligation-matrix}).
    async #hasLiveWork(workerId: number): Promise<boolean> {
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return true;
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        if (execHandler?.hasActiveSpawns?.(workerId) === true) return true;
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        return liveChild !== undefined;
    }

    async #handleSendBroadcast(statement: PlurnkStatement, ctx: {
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
    }): Promise<DispatchResult> {
        if (statement.op !== "SEND") throw new Error("unreachable");
        const { workerId, loopId, turnId } = ctx;
        const status = statement.signal;
        if (status === null) {
            return Dispatcher.#failure(
                "send-status-required",
                400,
                "SEND requires a numeric status.",
                {},
                { retryable: false },
            );
        }
        const raw = statement.body === null ? "" : statement.body.raw;

        // The park rides SEND[202] only ({§park-202-only}). A scoped SEND[102] is neither
        // a wait nor a meaningful continuation, so reject it instead of preserving the
        // retired dual spelling.
        if (status === 102 && statement.lineMarker !== null) {
            return Dispatcher.#failure(
                "send-scope-invalid",
                400,
                "SEND[102] does not accept a scope.",
                {},
                {
                    requestedStatus: 102,
                    scope: statement.lineMarker,
                    recovery: "Use SEND[202] with a scope to wait, or remove the scope to continue.",
                    retryable: false,
                },
            );
        }

        // A bare continue after an armed running-worker READ becomes an
        // indefinite park. {§join-blocking-collect}
        const joinArmed = this.#joinTargets.delete(loopId);
        if (status === 102 && statement.lineMarker === null && joinArmed) {
            if (!await this.#lifecycle.park(loopId, raw.length > 0 ? raw : "parked — awaiting a worker's result (blocking collect)")) {
                return Dispatcher.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to park it.");
            }
            this.#parkDeadlines.set(loopId, -1); // indefinite: the bounded child's terminal is the wake edge
            return { status: 102, attrs: { parked: -1, join: true } };
        }

        // {§wait-obligation-matrix} — SEND[202] is the obligation-checked join. A live
        // obligation (a spawned child or open stream, J) BLOCKS the loop until it concludes and
        // reawakens it ({§worker-lifecycle-child-wake}); a wait on nothing (∅) is already satisfied and
        // resolves like 200, so <-1>+∅ self-resolves rather than hang the agent; a pending own
        // retrieval (R) just lands next turn, so the wait continues.
        if (status === 202) {
            const marks = statement.lineMarker?.marks[0];
            const seconds = typeof marks === "number" ? marks : -1; // bare 202 / absent T = indefinite, bounded by the join
            if (await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId, raw.length > 0 ? raw : "waiting on live work")) {
                    return Dispatcher.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to wait.");
                }
                this.#parkDeadlines.set(loopId, seconds);
                return { status: 202, attrs: { waiting: seconds } };
            }
            // Retrievals, fast stream conclusions, and child conclusions are
            // all complete-but-unobserved. Their wake edge may already have
            // fired, so do not park; continue directly to the packet that
            // materializes them.
            const observations = await this.#pendingObservations(workerId, turnId);
            if (observations.retrievals || observations.streamTerminations || observations.childTerminations) {
                return { status: 102 };
            }
            const failCount = await this.#unobservedFailureCount(turnId);
            if (failCount > 0) return Dispatcher.#unobservedFailures(failCount);
            const branchDenial = await this.#branchCompletionGate?.(workerId) ?? null;
            if (branchDenial !== null) return branchDenial;
            // The joined set is already drained. Awaiting an empty task group completes
            // immediately; it never parks and needs no corrective model turn.
            const finished = await this.#lifecycle.finish(
                loopId,
                { status: 200 },
                { message: raw === "" ? null : raw },
            );
            return {
                status: finished !== null ? 200 : await this.#lifecycle.status(loopId),
                attrs: { joined: true, pending: 0 },
            };
        }

        // {§send-300-choices} — ask the operator and park (the answer returns via loop.inject).
        // The three-state cascade (owner design): PLURNK_QUESTIONS unset = ALLOWED (not enabled);
        // =0 = DENIED servicewide (a ceiling the client cannot override); ENABLED requires the
        // client to affirmatively pass it per workspace (settings.questions — the interactive client
        // with a human enables its own workspaces; headless/bench never asks). Enabled workspaces ALSO
        // get the questions.md teaching injected (docEntries) — capability and teaching gate as one.
        // Disabled → refused with a self-decide steer, never a park into the void.
        if (status === 300) {
            if (!(await WorkspaceSettings.questionsEnabled(this.#db, ctx.workspaceId))) {
                return Dispatcher.#failure(
                    "operator-questions-disabled",
                    409,
                    "Operator questions are disabled in this workspace.",
                    {},
                    {
                        recovery: "Decide from the available evidence and continue or conclude.",
                        retryable: false,
                    },
                );
            }
            // {§send-300-choices} — return a proposal whose accepted body becomes
            // the answer; zero choices denotes an open question.
            const parts = raw.split(";").map((x: string) => x.trim()).filter((x: string) => x.length > 0);
            const [question = "", ...choices] = parts;
            return { status: 202, attrs: choices.length > 0 ? { question, choices } : { question } };
        }

        // [200] — terminate, gated by the pending set (post-batch). The row records the refused
        // attempt faithfully (status_rx=409, never erased); the loop stays a continue; the strike
        // couples in runTurn. [499] abandons and cancels the descendant scope.
        if (status === 200) {
            // {§send-premature-terminate} — same-turn failures are unobserved
            // pending results and therefore refuse completion.
            const failCount = await this.#unobservedFailureCount(turnId);
            if (failCount > 0) return Dispatcher.#unobservedFailures(failCount);
            const pending = await this.#pendingSet(workerId, turnId);
            if (pending.length > 0) {
                // A retrieval-only refusal needs no KILL/park remedy menu: the results simply
                // arrive in the next packet. Streams and children retain their remedy steer.
                const retrievalsOnly = pending.every((k) => k.startsWith("this turn's retrieval results"));
                if (retrievalsOnly) {
                    return Dispatcher.#failure(
                        "retrieval-results-unobserved",
                        409,
                        "Last turn both performed retrieval operations and attempted to terminate. Retrieval operations force an additional turn so their results can be reviewed.",
                        {},
                        {
                            pending: [...pending],
                            stage: "completion",
                            recovery: "Review the results, then use only PLAN and SEND[200] to conclude.",
                            retryable: false,
                        },
                    );
                }
                return Dispatcher.#failure(
                    "work-remains",
                    409,
                    `Completion was refused while work remains: ${pending.join("; ")}.`,
                    {},
                    {
                        pending: [...pending],
                        stage: "completion",
                        recovery: "Resolve the listed pending work before concluding.",
                        retryable: false,
                    },
                );
            }
            const branchDenial = await this.#branchCompletionGate?.(workerId) ?? null;
            if (branchDenial !== null) return branchDenial;
            const finished = await this.#lifecycle.finish(
                loopId,
                { status: 200 },
                { message: raw === "" ? null : raw },
            );
            return Dispatcher.#statusResult(
                finished !== null ? 200 : await this.#lifecycle.status(loopId),
                "loop-already-terminal",
                "The loop was already terminal when SEND attempted to conclude it.",
            );
        }
        if (status === 499) {
            const branchDenial = await this.#branchCompletionGate?.(workerId) ?? null;
            if (branchDenial !== null) return branchDenial;
            const failure = Dispatcher.#failure(
                "scope-abandoned",
                499,
                raw === "" ? "The worker abandoned its scope." : raw,
            );
            const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId,
                turn_id: turnId,
            });
            if (seqs === undefined) {
                throw new Error(`SEND[499]: no coordinate for loop=${loopId} turn=${turnId}`);
            }
            Results.attachInstance(
                failure,
                `log:///${seqs.loop_seq}/${seqs.turn_seq}/${ctx.sequence}/SEND`,
            );
            const finished = await this.#lifecycle.finish(loopId, failure);
            if (finished === null) return Dispatcher.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to abandon it.");
            await this.#cancelDescendants?.(workerId, raw === "" ? "parent abandoned its scope" : raw);
            return failure;
        }
        // Every other signal — 102 bare, 202 (retired as a terminal; now ordinary mid-comms), 1xx —
        // is a plain broadcast row: no loop transition.
        return Dispatcher.#statusResult(
            status,
            "send-broadcast-failed",
            raw === "" ? `SEND broadcast reported status ${status}.` : raw,
        );
    }

    async #run(
        schemeName: string | null,
        statement: PlurnkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (schemeName === null) {
            return Dispatcher.#failure(
                "target-scheme-required",
                400,
                `${statement.op} requires a target scheme.`,
                {},
                { operation: statement.op, retryable: false },
            );
        }
        if (statement.op === "SEND" && statement.signal === 499 && statement.target?.kind === "url") {
            const addressedScheme = statement.target.scheme;
            const entry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: await Owner.commonsId(this.#db, ctx.workspaceId),
                scheme: addressedScheme,
                pathname: entryPathnameOf(statement.target),
            });
            if (entry !== undefined) {
                const subscription = await ChannelWrite.findActiveSubscription(this.#db, {
                    workerId: ctx.workerId,
                    entryId: entry.id,
                });
                if (subscription !== null && subscription.scheme === addressedScheme) {
                    const cancelled = await this.#liveSubscriptions.cancel(subscription.id);
                    if (!cancelled) {
                        throw new InvalidOperationResultError(
                            `Subscription ${subscription.id} is durable but has no live cancellation handle.`,
                        );
                    }
                    return { status: 200 };
                }
            }
        }
        const handler = this.#schemes.get(schemeName) as Partial<Record<keyof SchemeHandler, SchemeMethod>> | undefined;
        if (handler === undefined) {
            return Dispatcher.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const methodName = statement.op.toLowerCase() as keyof SchemeHandler;
        const method = handler[methodName];
        const addressedScheme = statement.target?.kind === "url" ? statement.target.scheme : null;
        const manifest = this.#schemes.manifestFor(schemeName);
        if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
        const schemeCtx = new SchemeCtxImpl(ctx, addressedScheme ?? schemeName, manifest, this.#liveSubscriptions);
        if (typeof method === "function") return Results.assert(await method.call(handler, statement, schemeCtx));
        if (statement.op !== "FIND" || manifest.category !== "data") {
            return Dispatcher.#failure(
                "operation-not-implemented",
                501,
                `Scheme '${schemeName}' does not implement ${statement.op}.`,
                {},
                {
                    scheme: schemeName,
                    operation: statement.op,
                    retryable: false,
                },
            );
        }
        const prepareFind = handler.prepareFind;
        if (typeof prepareFind === "function") {
            const prepared = await prepareFind.call(handler, statement, schemeCtx);
            if (prepared.status >= 300) return Results.assert(prepared);
        }
        return Results.assert(await schemeCtx.entries.operations.find(statement));
    }

    async #runLogCuration(
        statement: OpenStatement | FoldStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const addressedScheme = schemeNameOf(statement.target);
        if (addressedScheme !== null && addressedScheme !== "log") {
            return Dispatcher.#failure(
                "operation-not-implemented",
                501,
                `Scheme '${addressedScheme}' does not implement ${statement.op}.`,
                {},
                {
                    scheme: addressedScheme,
                    operation: statement.op,
                    retryable: false,
                },
            );
        }
        const handler = this.#schemes.get("log") as LogCurationHandler | undefined;
        const manifest = this.#schemes.manifestFor("log");
        if (handler === undefined || manifest === undefined) {
            throw new Error("the core log curation owner is not registered");
        }
        const schemeCtx = new SchemeCtxImpl(ctx, "log", manifest, this.#liveSubscriptions);
        return statement.op === "OPEN"
            ? Results.assert(await handler.open(statement, schemeCtx))
            : Results.assert(await handler.fold(statement, schemeCtx));
    }

    // {§proposal}/{§send} — status 202 is a proposal except for broadcast
    // SEND[202], which parks the loop. The operation disambiguates the status.
    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        // {§send-300-choices} — SEND[300] is the proposal exception.
        if (result.status !== 202) return false;
        if (statement.op === "SEND" && statement.signal === 300) return true;
        return !(statement.op === "SEND" && statement.target === null);
    }

    async #writeLog({
        statement, result, workspaceId, workerId, loopId, turnId, sequence, origin,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; workerId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
    }): Promise<number> {
        const durableStatement = DurableStatement.project(statement);
        const target = this.#extractTarget(durableStatement.target);
        await this.#canonColumns(target, workspaceId); // {§fs-answer-in-canon}
        const lineMarkerJson = "lineMarker" in durableStatement && durableStatement.lineMarker !== null
            ? JSON.stringify(durableStatement.lineMarker as LineMarker)
            : null;
        // A proposal (status 202 from a side-effecting op) is written to the log in
        // state='proposed' until the proposal lifecycle resolves it; attrs holds the
        // scheme-supplied payload (file diff, exec command, etc.) the client renders
        // for review and the scheme consumes on accept. A broadcast SEND[202] is a
        // parked-terminal, not a proposal (#isProposal) → state='resolved'.
        const isProposed = Dispatcher.#isProposal(statement, result);
        let attrsObj: Record<string, unknown> = (result.attrs !== undefined && result.attrs !== null)
            ? { ...(result.attrs as Record<string, unknown>) }
            : {};
        const seqs = statement.op === "EXEC" || result.problem !== undefined
            ? await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId,
                turn_id: turnId,
            })
            : undefined;
        if ((statement.op === "EXEC" || result.problem !== undefined) && seqs === undefined) {
            throw new Error(`Dispatcher.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
        }
        if (statement.op === "READ") Results.assertReadResult(result);
        if (result.problem !== undefined && seqs !== undefined) {
            Results.attachInstance(result, `log:///${seqs.loop_seq}/${seqs.turn_seq}/${sequence}/${statement.op}`);
        } else {
            Results.assert(result);
        }
        // EXEC produces a stream entry addressed by RUNTIME TAG as authority ({§exec}): it lives
        // at <runtime>:///<loop_seq>/<turn_seq>/<sequence> (e.g. sh:///1/1/2). That address is a
        // SEPARATE `stream` link in attrs — NOT an overload of `target`, which stays faithful to
        // the EXEC's own slot (the cwd, or the path to the executable). The log:/// coordinate
        // shares the trailing <loop>/<turn>/<seq>, so the op still correlates to its stream.
        // Runtime comes from statement.signal (EXEC's runtime slot), resolvable for failed execs
        // too; empty/absent = the default shell.
        if (statement.op === "EXEC") {
            if (seqs === undefined) throw new Error("Dispatcher.#writeLog: EXEC coordinate was not resolved");
            const runtime = (typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
            const coordPathname = `/${seqs.loop_seq}/${seqs.turn_seq}/${sequence}`;
            attrsObj.pathname = coordPathname;
            attrsObj.stream = `${runtime}://${coordPathname}`;
            // Mutate the in-memory result.attrs too: the dispatch path
            // hands originalResult.attrs to handler.applyResolution after
            // proposal accept (see ProposalLifecycle.workerApply). Both views —
            // the stored row AND the in-memory proposal — need the same
            // pathname so applyResolution writes the entry at the same URI.
            if (result.attrs !== undefined && result.attrs !== null) {
                (result.attrs as Record<string, unknown>).pathname = coordPathname;
            }
        }
        const attrs = JSON.stringify(attrsObj);
        const txJson = JSON.stringify(durableStatement);
        const rxJson = JSON.stringify(result);
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: sequence,
            origin,
            source: null,  // dispatch entries are self-authored; {§env-delta} deltas set this
            op: durableStatement.op,
            suffix: durableStatement.suffix,
            signal: this.#signalToJson(durableStatement.signal),
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
            lineMarker: lineMarkerJson,
            tx: txJson,
            mimetype_tx: "application/json",
            rx: rxJson,
            mimetype_rx: "application/json",
            status_rx: result.status,
            tokens: this.#tokenize(txJson) + this.#tokenize(rxJson),
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
        });
        if (row === undefined) throw new Error("Dispatcher.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // Normalize a parsed target for log storage. Bare paths and `file:///...`
    // inputs collapse to scheme=null in log target metadata because both render
    // as bare paths. Addressable file entries separately persist under the
    // reserved `file` identity scheme ({§entry-identity-no-null}).
    #extractTarget(path: ParsedPath | null): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        query: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, query: null, fragment: null };
        // `local` (bare path) carries no URL parts — store the raw text as the pathname for the log record, scheme=null.
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: PathSyntax.decodeParens(path.raw), query: null, fragment: null }; // {§path-parentheses}
        const scheme = path.scheme === "file" ? null : path.scheme;
        // {§scheme-address-namespace-fold} — a registered non-network scheme folds its
        // namespace authority into the canonical pathname. Network authorities remain hosts;
        // worker:// is the registered exception because its authority selects the owner.
        const foldNs = scheme !== null
            && scheme !== "worker"
            && !NetworkAddress.supports(scheme)
            && this.#schemes.has(scheme);
        return {
            scheme, username: path.username, password: path.password,
            hostname: foldNs ? null : path.hostname, port: path.port,
            pathname: PathSyntax.decodeParens(foldNs ? foldAuthorityIntoPath(path.hostname, path.pathname) : path.pathname), // {§path-parentheses}
            query: path.query, fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
