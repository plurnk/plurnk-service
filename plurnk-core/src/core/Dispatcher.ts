import type { BareStatement, CapabilityProjection, EditStatement, ForkStatement, KillStatement, ParsedPath, PlurnkOp, PlurnkStatement, ReadStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type ClientInteractions from "./ClientInteractions.ts";
import type { ProposalResolution } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import Namespace from "./namespace.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import { type StreamEventNotify, type WakeWorkerNotify, type InjectWorkerNotify, type CancelWorkerNotify, type CancelDescendantsNotify } from "./ChannelWrite.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import Results from "./results.ts";
import { OperationFailureError } from "./results.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import { CoreSchemeAdapterBase } from "./CoreSchemeServices.ts";
import { InvalidOperationResultError, type SchemeCtx, type SchemeHandler, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ProviderEncryptedReasoningItem } from "@plurnk/plurnk-providers";
import type { LogCurationOutcome, LogCurationPlan } from "../schemes/Log.ts";
import ResourceMutations from "./ResourceMutations.ts";
import { primaryTargetOf } from "./statement-primary.ts";
import LogBody, { type ActionlessLogKind } from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import EntryAddressBinding, { type BoundEntryAddress as ResolvedDataEntryAddress, type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import WorkerControlHandler from "./WorkerControlHandler.ts";
import KillHandler from "./KillHandler.ts";
import SendBroadcastHandler from "./SendBroadcastHandler.ts";
import LogWriter from "./LogWriter.ts";
import DataStatementRunner from "./DataStatementRunner.ts";

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy.
// READ/FIND are not gated — they read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL", "FORK", "WORK"]);


export type DispatchContext = {
    statement: PlurnkStatement;
    workspaceId: number;
    workerId: number;
    // {§actor-boundary-attached-functionality} — absent means the dispatching
    // Worker's own Functionality; a client operation names its attached Worker.
    functionalityWorkerId?: number;
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    // The append-only log boundary visible when this admitted program entered
    // execution. Direct single-operation dispatch captures its own boundary.
    logSelectionMaxId?: number;
    // Durable identity is available before a proposal can be resolved; the
    // terminal row becomes externally visible only after that proposal settles.
    onDispatch?: (logEntryId: number) => void;
    onSettled?: (logEntryId: number) => void | Promise<void>;
};

export type DispatchResult = SchemeResult;

export interface ResolvedClientEntryAddress {
    readonly ownerId: number;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly target: string;
}

export type SchemeMethod = (statement: PlurnkStatement, ctx: SchemeCtx) => Promise<DispatchResult>;
export type UnaryStatement = Exclude<PlurnkStatement, { op: "COPY" | "MOVE" }>;
type LogCurationHandler = {
    curate(statement: KillStatement, ctx: SchemeCtx, maxLogEntryId: number): Promise<LogCurationOutcome>;
};
interface CoreSchemeWithCrud {
    readEntry?: (pathname: string, ctx: SchemeCtx) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: SchemeCtx) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
    deleteChannel?: (pathname: string, channel: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
}

export type SchemeWithEntryAddress = Pick<SchemeHandler, "resolveEntryAddress">;

// Op dispatch ({§op-methods-op-dispatch}): admission, operation-owner routing,
// durable log writing, and proposal lifecycle.
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
    #weighContent: (text: string) => number;
    #notices: NoticeChannel;
    #proposals: ProposalLifecycle;
    #interactions: ClientInteractions;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    // {§relation-indexed-dialects} — the engine's derivation pump, awaited by a scheme whose
    // indexed dialect met a still-deriving index.
    #settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
    #settleVectors: (context: PlurnkSchemeContext, hashes: readonly string[]) => Promise<void>;
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #injectWorker: InjectWorkerNotify | undefined;
    #cancelWorker: CancelWorkerNotify | undefined;
    #cancelDescendants: CancelDescendantsNotify | undefined;
    // {§send-premature-terminate}/SEND signal 202 with scope — the engine-owned park-deadline registry (loopId → seconds;
    // -1 = indefinite). The dispatcher WRITES at park; the daemon's drain park-exit consumes.
    #parkDeadlines: Map<number, number>;
    // Per-turn running-worker READ obligations. {§join-blocking-collect}
    #joinTargets: Set<number>;
    #liveSubscriptions: LiveSubscriptions;
    #lifecycle: LoopLifecycle;
    #resourceMutations: ResourceMutations;
    #entryAddresses: EntryAddressBinding;
    #capabilities: CapabilityResolver;
    readonly #workerControl: WorkerControlHandler;
    readonly #kill: KillHandler;
    readonly #sendBroadcast: SendBroadcastHandler;
    readonly #logWriter: LogWriter;
    readonly #dataRun: DataStatementRunner;

    constructor({ db, schemes, mimetypes, weigh, notices, proposals, interactions, executors, loopSignal, settleDerivations, settleVectors, streamEventNotify, wakeWorkerNotify, injectWorker,             cancelWorker, cancelDescendants, parkDeadlines, joinTargets, liveSubscriptions, entryAddresses }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        proposals: ProposalLifecycle;
        interactions: ClientInteractions;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
        settleVectors: (context: PlurnkSchemeContext, hashes: readonly string[]) => Promise<void>;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
        parkDeadlines?: Map<number, number>;
        joinTargets?: Set<number>;
        liveSubscriptions: LiveSubscriptions;
        entryAddresses: EntryAddressBinding;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#weighContent = weigh;
        this.#notices = notices;
        this.#proposals = proposals;
        this.#interactions = interactions;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#settleDerivations = settleDerivations;
        this.#settleVectors = settleVectors;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#injectWorker = injectWorker;
        this.#cancelWorker = cancelWorker;
        this.#cancelDescendants = cancelDescendants;
        this.#parkDeadlines = parkDeadlines ?? new Map();
        this.#joinTargets = joinTargets ?? new Set();
        this.#liveSubscriptions = liveSubscriptions;
        this.#entryAddresses = entryAddresses;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        this.#lifecycle = new LoopLifecycle(db);
        this.#resourceMutations = new ResourceMutations({
            schemes,
            liveSubscriptions,
            run: (schemeName, statement, ctx) => this.#dataRun.run(schemeName, statement, ctx),
            checkWritable: (statement, origin, workerId) => this.#checkWritable(statement, origin, workerId),
            checkCapabilities: (statement, workspaceId, loopId, workerId) =>
                this.#checkCapabilities(statement, workspaceId, loopId, workerId),
            editTargetIdentity: (statement, workspaceId, workerId) => this.#editTargetIdentity(statement, workspaceId, workerId),
            canonicalFilePath: (pathname, workspaceId) => this.#canonicalFilePath(pathname, workspaceId),
            prepareDataRepresentation: (args) => this.#prepareDataRepresentation({
                ...args,
                handler: args.handler as SchemeWithEntryAddress & SchemeHandler,
            }),
            resolveDataEntryAddress: (args) => this.#entryAddresses.resolve(args),
            readEntry: (scheme, address, ctx) => this.#readEntry(scheme, address, ctx),
            writeEntry: (scheme, address, entry, ctx) => this.#writeEntry(scheme, address, entry, ctx),
            deleteChannel: (scheme, address, channel, ctx) =>
                this.#deleteChannel(scheme, address, channel, ctx),
            applyProposal: (statement, result, resolution, ids) =>
                this.#proposals.workerApply(statement, result, resolution, ids),
        });
        this.#workerControl = new WorkerControlHandler({ db: this.#db, schemes: this.#schemes, failure: Dispatcher.#failure });
        this.#kill = new KillHandler({ db: this.#db, schemes: this.#schemes, liveSubscriptions: this.#liveSubscriptions, cancelWorker: this.#cancelWorker, resolveDataEntryAddress: this.#resolveDataEntryAddress.bind(this), boundEntryContext: this.#boundEntryContext.bind(this), handlerContext: this.#handlerContext.bind(this), deleteEntry: this.#deleteEntry.bind(this), failure: Dispatcher.#failure });
        this.#sendBroadcast = new SendBroadcastHandler({ db: this.#db, cancelDescendants: this.#cancelDescendants, parkDeadlines: this.#parkDeadlines, joinTargets: this.#joinTargets, lifecycle: this.#lifecycle, nextPacketBoundaries: this.#nextPacketBoundaries.bind(this), unobservedFailureCount: this.#unobservedFailureCount.bind(this), pendingSet: this.#pendingSet.bind(this), hasLiveWork: this.hasLiveWork.bind(this), failure: Dispatcher.#failure, statusResult: Dispatcher.#statusResult, unobservedFailures: Dispatcher.#unobservedFailures });
        this.#logWriter = new LogWriter({ db: this.#db, weighContent: this.#weighContent, extractTarget: this.#extractTarget.bind(this), canonColumns: this.#canonColumns.bind(this), signalToJson: this.#signalToJson.bind(this), isProposal: Dispatcher.#isProposal });
        this.#dataRun = new DataStatementRunner({ schemes: this.#schemes, liveSubscriptions: this.#liveSubscriptions, resolveDataEntryAddress: this.#resolveDataEntryAddress.bind(this), fixedEntryOwnerId: this.#fixedEntryOwnerId.bind(this), prepareDataRepresentation: this.#prepareDataRepresentation.bind(this), failure: Dispatcher.#failure });
    }

    // workspace → project_root, memoized: {§fs-namespace} fixes the root immutably at
    // workspace creation, so a process-lifetime cache can never go stale.
    #rootCache = new Map<number, string | null>();

    evictWorkspaceCache(workspaceId: number): void {
        this.#rootCache.delete(workspaceId);
    }

    async #fixedEntryOwnerId(manifest: SchemeManifest, ctx: PlurnkSchemeContext): Promise<number | null> {
        return this.#entryAddresses.fixedOwnerId(manifest, ctx);
    }

    async #handlerContext(scheme: string, ctx: PlurnkSchemeContext, authority = ""): Promise<SchemeCtxImpl | null> {
        const manifest = this.#schemes.manifestFor(scheme, ctx.functionalityWorkerId);
        return manifest === undefined
            ? null
            : new SchemeCtxImpl(ctx, scheme, manifest, this.#liveSubscriptions, {
                authority,
                ownerId: await this.#fixedEntryOwnerId(manifest, ctx),
            });
    }

    #boundEntryContext(
        routedScheme: string,
        address: ResolvedDataEntryAddress,
        ctx: PlurnkSchemeContext,
    ): SchemeCtxImpl | null {
        const manifest = this.#schemes.manifestFor(routedScheme, ctx.functionalityWorkerId);
        return manifest?.category === "data"
            ? new SchemeCtxImpl(ctx, address.scheme, manifest, this.#liveSubscriptions, {
                authority: address.authority,
                ownerId: address.ownerId,
            })
            : null;
    }

    #coreCrud(scheme: string, workerId: number): CoreSchemeWithCrud | undefined {
        const handler = this.#schemes.get(scheme, workerId);
        return handler instanceof CoreSchemeAdapterBase
            ? handler as CoreSchemeAdapterBase & CoreSchemeWithCrud
            : undefined;
    }

    async #readEntry(scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.functionalityWorkerId);
        const handlerCtx = this.#boundEntryContext(scheme, address, ctx);
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
                    target: renderAddress(address),
                    retryable: false,
                },
            ) as ReadEntryResult;
        }
        const result = Results.assert(await caps.read(pathname));
        return Results.assert({
            ...result,
            status: result.status,
            entry: result.entry === null
                ? null
                : {
                    channels: { ...result.entry.channels },
                    ...(result.entry.attributes === undefined
                        ? {}
                        : { attributes: { ...result.entry.attributes } }),
                },
        }) as ReadEntryResult;
    }

    async #writeEntry(scheme: string, address: ResolvedDataEntryAddress, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.functionalityWorkerId);
        const handlerCtx = this.#boundEntryContext(scheme, address, ctx);
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
                    target: renderAddress(address),
                    retryable: false,
                },
            ) as WriteEntryResult;
        }
        return Results.assert(await caps.write(pathname, entry)) as WriteEntryResult;
    }

    async #deleteEntry(scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.functionalityWorkerId);
        const handlerCtx = this.#boundEntryContext(scheme, address, ctx);
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
                    target: renderAddress(address),
                    retryable: false,
                },
            );
        }
        return Results.assert(await caps.delete(pathname));
    }

    async #deleteChannel(
        scheme: string,
        address: ResolvedDataEntryAddress,
        channel: string,
        ctx: PlurnkSchemeContext,
    ): Promise<DeleteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.functionalityWorkerId);
        const handlerCtx = this.#boundEntryContext(scheme, address, ctx);
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
                    target: renderAddress(address),
                    channel,
                    retryable: false,
                },
            );
        }
        return Results.assert(
            await caps.delete(pathname, channel),
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

    async #canonicalFilePath(pathname: string, workspaceId: number): Promise<string | null> {
        return Namespace.canonicalizeSpelling(pathname, await this.#workspaceRoot(workspaceId));
    }

    async #editTargetIdentity(
        statement: EditStatement,
        workspaceId: number,
        workerId: number,
    ): Promise<{ readonly key: string; readonly identity: string | null }> {
        const target = this.#extractTarget(statement.target, workerId);
        await this.#canonColumns(target, workspaceId);
        return {
            key: JSON.stringify([
                schemeNameOf(statement.target),
                target.scheme,
                target.hostname,
                target.pathname,
                target.fragment,
            ]),
            identity: renderTarget(target),
        };
    }

    // {§kill-scope-entry} — a scoped KILL on an entry-bearing scheme is one EDIT with an empty
    // body over the same marker: prepared, gated, and merged as an EDIT while its log row
    // records the model's KILL. Schemes that implement kill() (streams) take the scope themselves;
    // the log's scoped KILL is curation.
    readonly #scopedEntryEdits = new WeakMap<KillStatement, EditStatement>();

    #scopedEntryEdit(statement: PlurnkStatement, functionalityWorkerId: number): EditStatement | null {
        if (statement.op === "EDIT") return statement;
        // A body pattern is a log selector; a scoped KILL carrying one is not an EDIT — the KILL
        // handler refuses it ({§kill-scope-entry}).
        if (statement.op !== "KILL" || statement.lineMarker === null || statement.body !== null) return null;
        const cached = this.#scopedEntryEdits.get(statement);
        if (cached !== undefined) return cached;
        const schemeName = schemeNameOf(statement.target);
        if (schemeName === null || schemeName === "log") return null;
        const handler = this.#schemes.get(schemeName, functionalityWorkerId) as { kill?: unknown } | undefined;
        if (handler === undefined || typeof handler.kill === "function") return null;
        const edit: EditStatement = {
            op: "EDIT",
            delimiter: statement.delimiter,
            annotation: statement.annotation,
            metadata: statement.metadata,
            target: statement.target,
            lineMarker: statement.lineMarker,
            body: "",
            position: statement.position,
        };
        this.#scopedEntryEdits.set(statement, edit);
        return edit;
    }

    async prepareEditBatches(
        statements: readonly PlurnkStatement[],
        context: Omit<DispatchContext, "statement" | "sequence">,
    ): Promise<void> {
        const { workspaceId, workerId, functionalityWorkerId, loopId, turnId, origin } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId, loopId, turnId, origin });
        const edits = statements.flatMap((statement) => {
            const edit = this.#scopedEntryEdit(statement, schemeCtx.functionalityWorkerId);
            return edit === null ? [] : [edit];
        });
        await this.#resourceMutations.prepareEditBatches(edits, context, schemeCtx);
    }


    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        let result = await this.#dispatchOne(context);
        const edit = context.statement.op === "EDIT" ? context.statement : this.#scopedEntryEdits.get(context.statement as KillStatement);
        if (edit !== undefined) {
            // {§edit-batch-merges} — a proposal's apply result replaces the projected one; the
            // statement's merge facts ride every EDIT result, whichever route produced it.
            result = this.#resourceMutations.withMergeFacts(edit, result);
            this.#resourceMutations.settleEdit(edit, result);
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
            onSettled,
        } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId: context.functionalityWorkerId, loopId, turnId, origin });
        const { functionalityWorkerId } = schemeCtx;
        let result: DispatchResult;
        let curationPlan: LogCurationPlan | null = null;
        let denial = this.#checkWritable(statement, origin, functionalityWorkerId);
        if (denial === null) denial = await this.#checkCapabilities(statement, workspaceId, loopId, functionalityWorkerId);
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
                    result = await this.#resourceMutations.preparedEditResult(statement);
                } else if (statement.op === "SEND" && statement.target === null) {
                    result = await this.#sendBroadcast.handleSendBroadcast(statement, {
                        workspaceId,
                        workerId,
                        loopId,
                        turnId,
                        sequence,
                        origin,
                    });
                } else if (
                    statement.op === "KILL" && schemeNameOf(statement.target) === "log"
                ) {
                    const curation = await this.#runLogCuration(
                        statement,
                        schemeCtx,
                        context.logSelectionMaxId,
                    );
                    result = curation.result;
                    curationPlan = curation.plan;
                } else if (statement.op === "FORK" || statement.op === "WORK") {
                    result = await this.#workerControl.handleWorkerControl(statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#resourceMutations.handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#resourceMutations.handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL" && this.#scopedEntryEdits.has(statement)) {
                    result = await this.#resourceMutations.preparedEditResult(this.#scopedEntryEdits.get(statement)!);
                } else if (statement.op === "KILL") {
                    result = await this.#kill.handleKill(statement, schemeCtx);
                } else if (statement.op === "PLAN") {
                    result = this.#handlePlan(statement);
                } else if (statement.op === "EXEC") {
                    // EXEC routes unconditionally to its operation owner after
                    // the shared capability resolver admits its runtime/tool.
                    result = await this.#dataRun.run("exec", statement, schemeCtx);
                } else {
                    result = await this.#dataRun.run(schemeNameOf(statement.target), statement, schemeCtx); // {§op-methods-op-dispatch}
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — {§scheme-surface-exception-500}
                if (err instanceof InvalidOperationResultError) throw err;
                if (err instanceof OperationFailureError) {
                    result = err.result;
                } else {
                    const scheme = schemeNameOf(primaryTargetOf(statement));
                    console.error(`Scheme '${scheme ?? "unknown"}' ${statement.op} threw outside its operation result contract:`, err);
                    result = Dispatcher.#failure(
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
        }
        // Persist log curation for forensics; packet rendering suppresses its
        // successful receipts while the exact state effects remain durable.
        // A running-worker READ arms this turn's blocking collect.
        // {§join-blocking-collect}
        if (typeof (result as { awaitWorker?: unknown }).awaitWorker === "string") this.#joinTargets.add(loopId);
        const logEntryId = await this.#logWriter.writeLog({
            statement,
            result,
            functionalityWorkerId,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence,
            origin,
            curationPlan,
            modelCallId: null,
        });
        onDispatch?.(logEntryId);
        // Proposal lifecycle (SPEC.md {§engine-rails} + {§methods-proposal-resolve}; {§proposal-202-pauses}). When a
        // side-effecting op returns status 202 (a broadcast SEND signal 202 park is model
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
                    { workspaceId, workerId, functionalityWorkerId, loopId, turnId },
                );
                const effective = await this.#resourceMutations.settleProposal({
                    statement,
                    result,
                    settlement: initialSettlement,
                    ctx: schemeCtx,
                    ids: { workspaceId, workerId, functionalityWorkerId, loopId, turnId },
                });
                const post = await this.#proposals.applyResolution(logEntryId, effective);
                await onSettled?.(logEntryId);
                return post;
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
                await onSettled?.(logEntryId);
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
                { workspaceId, workerId, functionalityWorkerId, loopId, turnId },
            );
            const effective = await this.#resourceMutations.settleProposal({
                statement,
                result,
                settlement: initialSettlement,
                ctx: schemeCtx,
                ids: { workspaceId, workerId, functionalityWorkerId, loopId, turnId },
            });
            const post = await this.#proposals.applyResolution(logEntryId, effective);
            await onSettled?.(logEntryId);
            return post;
        }
        await onSettled?.(logEntryId);
        return result;
    }

    // {§op-look}: resolve a READ and return its content without writing a
    // log_entries row: the client's out-of-band inspection primitive (LOOK → READ,
    // invisible to the model). READ never mutates and never proposes, so this is
    // dispatch's resolve path minus #writeLog. Runs on the client loop, so the
    // human's inspection is never constrained by a model loop's flags. {§op-look}
    async look(context: {
        statement: PlurnkStatement;
        workspaceId: number; workerId: number; functionalityWorkerId?: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, origin = "client" } = context;
        if (statement.op !== "READ") throw new Error(`look resolves READ only; got ${statement.op}`);
        // turnId is a write-time FK only — a look writes no row, so 0 (no turn) is inert.
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId: context.functionalityWorkerId, loopId, turnId: 0, origin });
        const denial = await this.#checkCapabilities(statement, schemeCtx.workspaceId, loopId, schemeCtx.functionalityWorkerId);
        if (denial !== null) return denial;
        return this.#dataRun.run(schemeNameOf(statement.target), statement, schemeCtx);
    }

    capabilityProjection(workspaceId: number, workerId: number): Promise<CapabilityProjection> {
        return this.#capabilities.projection(workspaceId, workerId);
    }

    // Resolve the client selector through the owning scheme before persistence
    // is consulted. Public schemes choose a semantic owner; core-owned authority
    // schemes may return the already-authorized principal key.
    async resolveEntryAddress(context: {
        target: ParsedPath;
        workspaceId: number;
        workerId: number;
        functionalityWorkerId?: number;
    }): Promise<ResolvedClientEntryAddress | null> {
        const { target, workspaceId, workerId } = context;
        const coreCtx = this.#buildSchemeCtx({
            workspaceId,
            workerId,
            functionalityWorkerId: context.functionalityWorkerId,
            loopId: 0,
            turnId: 0,
            origin: "client",
        });
        const resolved = await this.bindEntryAddress(target, coreCtx);
        if (resolved === null) return null;
        if (resolved.address === null) return null;

        const rendered = target.kind === "url"
            ? renderTarget({ ...target, fragment: null })
            : renderTarget({ scheme: null, pathname: target.raw, fragment: null });
        if (rendered === null) throw new TypeError("Resolved entry target did not render.");
        return {
            ownerId: resolved.address.ownerId,
            scheme: resolved.address.scheme,
            authority: resolved.address.authority,
            pathname: resolved.address.pathname,
            target: rendered,
        };
    }

    async bindEntryAddress(
        target: ParsedPath,
        ctx: PlurnkSchemeContext,
    ): Promise<PreparedRepresentation | null> {
        const routedScheme = schemeNameOf(target);
        if (routedScheme === null) return null;
        const handler = this.#schemes.get(routedScheme, ctx.functionalityWorkerId) as SchemeWithEntryAddress | undefined;
        const manifest = this.#schemes.manifestFor(routedScheme, ctx.functionalityWorkerId);
        if (handler === undefined || manifest?.category !== "data") return null;
        return this.#resolveDataEntryAddress({ target, routedScheme, handler, manifest, ctx });
    }

    async #resolveDataEntryAddress({
        target,
        routedScheme,
        handler,
        manifest,
        ctx,
    }: {
        target: ParsedPath;
        routedScheme: string;
        handler: SchemeWithEntryAddress;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
    }): Promise<PreparedRepresentation> {
        if (manifest.category !== "data") {
            throw new TypeError(`Scheme '${routedScheme}' is not entry-bearing.`);
        }
        return this.#entryAddresses.resolve({ target, routedScheme, handler, manifest, ctx });
    }

    async #prepareDataRepresentation({
        target,
        metadata,
        routedScheme,
        handler,
        manifest,
        ctx,
        publishedChannel,
        resolved: priorResolution,
    }: {
        target: ParsedPath;
        metadata: readonly string[] | null;
        routedScheme: string;
        handler: SchemeWithEntryAddress & SchemeHandler;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        publishedChannel: string | null;
        resolved?: PreparedRepresentation;
    }): Promise<PreparedRepresentation> {
        if (metadata !== null && manifest.metadataModifier !== true) {
            return {
                address: null,
                result: Dispatcher.#failure(
                    "scheme-metadata-unsupported",
                    400,
                    `Scheme '${routedScheme}' does not accept the {metadata} modifier.`,
                    {},
                    { scheme: routedScheme, retryable: false },
                ),
            };
        }
        const resolved = priorResolution ?? await this.#resolveDataEntryAddress({
            target, routedScheme, handler, manifest, ctx,
        });
        if (
            resolved.address === null
            || resolved.result !== null
            || typeof handler.prepareRepresentation !== "function"
        ) {
            return resolved;
        }
        const address = resolved.address;
        const selectionNeutralTarget = target.kind === "url"
            ? {
                ...target,
                raw: renderTarget({ ...target, fragment: null }) ?? target.raw,
                fragment: null,
            }
            : target;
        const preparationCtx = new SchemeCtxImpl(
            ctx,
            target.kind === "url" ? target.scheme : routedScheme,
            manifest,
            this.#liveSubscriptions,
            {
                authority: address.authority,
                ownerId: address.ownerId,
                publishedChannel,
            },
        );
        const prepared = Results.assertRepresentationPreparation(
            await handler.prepareRepresentation({
                target: selectionNeutralTarget,
                metadata,
                authority: address.authority,
                pathname: address.pathname,
            }, preparationCtx),
        );
        return {
            address,
            result: prepared.status === 200 ? null : prepared,
        };
    }

    // An accepted EXEC reads a non-file source through the same registered
    // handler and addressed context as an authored READ. {§exec-target-routing}
    async readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const schemeName = schemeNameOf(statement.target);
        const manifest = schemeName === null ? undefined : this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
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
        return Results.assertReadResult(await this.#dataRun.run(schemeName, statement, ctx));
    }

    // The one place per-dispatch coordinates are built; a caller that carries no
    // explicit Functionality coordinate acts in its own Worker's
    // ({§actor-boundary-attached-functionality}). Consumers read the built
    // PlurnkSchemeContext and never re-derive.
    #buildSchemeCtx(ids: { workspaceId: number; workerId: number; functionalityWorkerId?: number; loopId: number; turnId: number; origin: WriterTier }): PlurnkSchemeContext {
        const { workspaceId, workerId, loopId, turnId, origin } = ids;
        const functionalityWorkerId = ids.functionalityWorkerId ?? workerId;
        const context: PlurnkSchemeContext = {
            db: this.#db,
            workspaceId, workerId, functionalityWorkerId, loopId, turnId,
            writer: origin,
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            injectWorker: this.#injectWorker,
            mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            // {§exec-stream} — a runtime scheme's default channel is its own (stdout), never the
            // catalog fallback `body`; resolved through the same registry the writable gate reads.
            defaultChannelFor: (scheme) => this.#schemes.defaultChannelFor(scheme, functionalityWorkerId),
            settleDerivations: () => this.#settleDerivations(context),
            settleVectors: (hashes) => this.#settleVectors(context, hashes),
            pushNotice: (notice) => this.#notices.push(workspaceId, workerId, loopId, notice),
            requestInteraction: (request) => this.#interactions.request(
                request,
                { workspaceId, workerId, loopId, turnId },
                this.#loopSignal(loopId),
            ),
            executors: this.#executors(),
        };
        return context;
    }

    // SPEC {§scheme-surface}: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ and FIND) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    #checkWritable(statement: PlurnkStatement, origin: WriterTier, functionalityWorkerId: number): DispatchResult | null {
        const workerId = functionalityWorkerId;
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (statement.op === "SEND" && statement.target === null) return null;

        // EXEC's operation authority always belongs to the exec scheme;
        // runtime-specific resource authority is gated separately below.
        if (statement.op === "EXEC") {
            return this.#denyIfDisallowed("exec", origin, workerId);
        }

        // {§stream-control} — a KILL of a runtime stream terminates the caller's own process; it
        // writes nothing into that read-only output scheme (writableBy plugin), so the writer rule
        // does not speak. Exec.kill scopes the stream to the caller ({§stream-owner-scoped}).
        if (statement.op === "KILL") {
            const target = schemeNameOf(statement.target);
            if (target !== null && this.#schemes.isRuntimeScheme(target, workerId)) return null;
        }

        // Worker control (FORK/WORK → worker://<name>, spawn or fork) is gated by worker://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // {§machine-processes}
        if (this.#isWorkerControl(statement)) return this.#denyIfDisallowed("worker", origin, workerId);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.destination.target;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin, workerId);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.source.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin, workerId);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        const denial = this.#denyIfDisallowed(target, origin, workerId);
        // {§send-target-recipient} — SEND addresses recipients, not otherwise
        // read-only resources. State that boundary without guessing whether the
        // model intended a reply, deletion, or directed message.
        if (denial !== null && statement.op === "SEND" && origin === "model") {
            return Dispatcher.#failure(
                "send-target-not-a-recipient",
                400,
                "The addressed scheme is not a SEND recipient.",
                {},
                {
                    target: statement.target?.raw ?? String(target),
                    stage: "dispatch",
                    recovery: "A targetless SEND answers the active prompt; a directed SEND requires a recipient that implements SEND.",
                    retryable: false,
                },
            );
        }
        return denial;
    }

    #denyIfDisallowed(schemeName: string | null, origin: WriterTier, workerId: number): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName, workerId);
        if (handler === undefined) return null;
        const manifest = this.#schemes.manifestFor(schemeName, workerId);
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

    // {§capability-admission} — one resolver gates every operation route before
    // execution or proposal handling. Unknown routes continue to their ordinary
    // owner; a known policy denial is one factual, non-presumptuous 403.
    async #checkCapabilities(
        statement: PlurnkStatement,
        workspaceId: number,
        loopId: number,
        functionalityWorkerId: number,
    ): Promise<DispatchResult | null> {
        const denied = await this.#capabilities.denial(
            statement,
            workspaceId,
            functionalityWorkerId,
            loopId,
        );
        if (denied === null) return null;
        const { descriptor, scope } = denied;
        const route = [
            descriptor.operation,
            descriptor.scheme,
            descriptor.runtime,
            descriptor.tool,
        ].filter((part) => part !== undefined).join("/");
        return Dispatcher.#failure(
            "capability-denied",
            403,
            `Capability '${route}' is denied by ${scope} policy.`,
            {},
            {
                ...descriptor,
                policyScope: scope,
                retryable: false,
            },
        );
    }

    // Worker control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new worker's seed prompt, not a destination path. The COPY gates and ResourceMutations.handleCopy
    // branch on this so they never parse the prompt as a dst path.
    #isWorkerControl(statement: PlurnkStatement): statement is ForkStatement | WorkStatement {
        return statement.op === "FORK" || statement.op === "WORK"; // worker control targets worker://<name> (grammar 0.74.55)
    }

    async #writeActionlessEntry({ verbatim, workerId, loopId, turnId, sequence, origin, kind, folded, modelCallId = null, attrs = {} }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number;
        origin: WriterTier; kind: ActionlessLogKind; folded: boolean;
        modelCallId?: number | null;
        attrs?: Readonly<Record<string, unknown>>;
    }): Promise<number> {
        const durableAttrs = { ...attrs, kind };
        const rx = JSON.stringify({ content: verbatim, mimetype: "text/vnd.plurnk" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
            origin, source: null, model_call_id: modelCallId,
            op: null, delimiter: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/vnd.plurnk",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: null,
                attrs: durableAttrs,
                tx: "",
                rx,
                mimetypeTx: "text/vnd.plurnk",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved", outcome: null,
            attrs: JSON.stringify(durableAttrs),
            initial_folded: LogVisibility.serialize(folded ? LogVisibility.FOLDED : LogVisibility.OPEN),
        });
        if (row === undefined) throw new Error("Dispatcher.#writeActionlessEntry: insert returned no row");
        return row.id;
    }

    // {§turn-ops-entry} — preserve exact admitted source beside, never instead
    // of, the ordinary operation-result rows produced by dispatch.
    async writeTurnOps({ verbatim, workerId, loopId, turnId, sequence, origin, folded, modelCallId = null, reasoningItems }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number;
        origin: WriterTier;
        folded: boolean;
        modelCallId?: number | null;
        // {§encrypted-reasoning-carrier} — relay provider-normalized encrypted
        // reasoning items as opaque source-row evidence.
        reasoningItems?: ReadonlyArray<ProviderEncryptedReasoningItem>;
    }): Promise<number> {
        return this.#writeActionlessEntry({
            verbatim, workerId, loopId, turnId, sequence,
            origin, kind: "turnOps", folded, modelCallId,
            attrs: {
                ...(reasoningItems !== undefined && reasoningItems.length > 0 ? { reasoning: reasoningItems } : {}),
            },
        });
    }

    // {§rejected-emission-entry} — provider bytes that fail admission are an
    // attempt artifact, never a turn program.
    async writeEmissionAttempt({ verbatim, workerId, loopId, turnId, sequence, modelCallId, reasoningItems }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number;
        modelCallId: number;
        reasoningItems?: ReadonlyArray<ProviderEncryptedReasoningItem>;
    }): Promise<number> {
        return this.#writeActionlessEntry({
            verbatim, workerId, loopId, turnId, sequence,
            origin: "model", kind: "emissionAttempt", folded: true, modelCallId,
            attrs: {
                ...(reasoningItems !== undefined && reasoningItems.length > 0 ? { reasoning: reasoningItems } : {}),
            },
        });
    }

    // PLAN — one installment of the model's running work journal. An ordinary op: dispatched like any
    // other, logged, and broadcast to the client as a log entry — but a pure no-op for
    // state (PLAN ∉ MUTATING_OPS); its body serializes into the log row's tx, no effect.
    #handlePlan(statement: PlurnkStatement): DispatchResult {
        if (statement.op !== "PLAN") throw new Error("unreachable");
        return { status: 200 };
    }

    // {§bare-inference} Provider work is prepared concurrently by Engine; the
    // dispatcher owns only the ordinary operation-result commit and notification.
    async recordBareResult(
        context: Omit<DispatchContext, "statement"> & { statement: BareStatement },
        result: DispatchResult,
        modelCallId: number,
    ): Promise<DispatchResult> {
        Results.assert(result);
        const logEntryId = await this.#logWriter.writeLog({
            ...context,
            functionalityWorkerId: context.functionalityWorkerId ?? context.workerId,
            result,
            curationPlan: null,
            modelCallId,
        });
        context.onDispatch?.(logEntryId);
        await context.onSettled?.(logEntryId);
        return result;
    }


    // {§send-premature-terminate} — the unified PENDING SET, judged at the terminal's OWN dispatch
    // (post-batch: the emission's earlier ops already executed, so a same-turn KILL+[200] repairs in
    // ONE turn, and a same-turn WORK+[200] is caught — the spawn is live by the time the SEND lands).
    // pending = open streams ∪ live children ∪ THIS turn's retrievals (READ/FIND/BARE, results unseen
    // until next packet). Failed operations are the separate next-packet leg shared by explicit
    // completion and empty-join completion. Nothing pending may be silently discarded; 499 discards
    // BY STATED INTENT and is never gated.
    async #pendingSet(workerId: number, turnId: number): Promise<Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results">> {
        const pending: Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results"> = [];
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean; isDetachedSpawn?: (subscriptionId: number) => boolean } | undefined;
        // {§exec-timeout} — a `<-1>` spawn outlives the loop and is nobody's obligation.
        const openSubs = (await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId }))
            .filter(({ id }) => execHandler?.isDetachedSpawn?.(id) !== true);
        if (openSubs.length > 0 || execHandler?.hasActiveSpawns?.(workerId) === true) pending.push("streams");
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        if (liveChild !== undefined) pending.push("workers");
        const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
        if (boundaries.retrievals) pending.push("receipts");
        // A stream that closed successfully is banked, not pending: concluding on its own
        // success is legitimate and its output stays in the Log. A failed close is an unseen
        // failure — named exactly (bench#5 requiem #9) so the model reads it, not guesses.
        if (boundaries.streamTerminations.some(({ closeStatus }) => closeStatus >= 400)) pending.push("failed-stream-results");
        if (boundaries.childTerminations) pending.push("worker-results");
        return pending;
    }

    // Results cross an observation boundary only when they have appeared in a packet;
    // successful log-curation effects likewise become useful through the curated next packet.
    // Keep every next-packet boundary in one classifier while letting the callers apply
    // their distinct contracts: retrievals block explicit completion, whereas log curation only
    // prevents an empty wait from being inferred as completion.
    async #nextPacketBoundaries(workerId: number, turnId: number): Promise<{
        retrievals: boolean;
        curations: boolean;
        streamTerminations: Array<{ handle: string; closeStatus: number }>;
        childTerminations: boolean;
    }> {
        const [turnBoundaries, streamTerminations, childTermination] = await Promise.all([
            this.#db.engine_turn_packet_boundaries.all<{ id: number; op: string }>({ turn_id: turnId }),
            this.#db.engine_worker_has_undelivered_stream_term
                .all<{ handle: string; closeStatus: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_undelivered_child_term
                .get<{ pending: number }>({ worker_id: workerId }),
        ]);
        return {
            // {§log-kill-scope} — a log KILL is housekeeping: it continues an empty (WAIT) but never
            // blocks an explicit (TERM); every other boundary row is a retrieval receipt.
            retrievals: turnBoundaries.some(({ op }) => op !== "KILL"),
            curations: turnBoundaries.some(({ op }) => op === "KILL"),
            streamTerminations,
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
            `This turn produced ${failCount} failed operation result(s) that have not yet entered a packet.`,
            {},
            {
                failures: failCount,
                stage: "completion",
                retryable: false,
            },
        );
    }

    // J — a live obligation to WAIT on: a spawned child or an open stream (NOT retrievals, which land
    // next turn regardless). The wait-side twin of #pendingSet's stream+child legs ({§wait-obligation-matrix}).
    async hasLiveWork(workerId: number): Promise<boolean> {
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean; isDetachedSpawn?: (subscriptionId: number) => boolean } | undefined;
        // {§exec-timeout} — a `<-1>` spawn outlives the loop and is nobody's obligation.
        const openSubs = (await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId }))
            .filter(({ id }) => execHandler?.isDetachedSpawn?.(id) !== true);
        if (openSubs.length > 0) return true;
        if (execHandler?.hasActiveSpawns?.(workerId) === true) return true;
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        return liveChild !== undefined;
    }

    async #runLogCuration(
        statement: KillStatement,
        ctx: PlurnkSchemeContext,
        admittedMaxId: number | undefined,
    ): Promise<LogCurationOutcome> {
        const addressedScheme = schemeNameOf(statement.target);
        if (addressedScheme !== null && addressedScheme !== "log") {
            return {
                result: Dispatcher.#failure(
                    "operation-not-implemented",
                    501,
                    `Scheme '${addressedScheme}' does not implement ${statement.op}.`,
                    {},
                    {
                        scheme: addressedScheme,
                        operation: statement.op,
                        retryable: false,
                    },
                ),
                plan: null,
            };
        }
        const handler = this.#schemes.get("log") as LogCurationHandler | undefined;
        const manifest = this.#schemes.manifestFor("log");
        if (handler === undefined || manifest === undefined) {
            throw new Error("the core log curation owner is not registered");
        }
        const maxId = admittedMaxId ?? (await this.#db.engine_log_selection_high_water.get<{ max_id: number }>({
            worker_id: ctx.workerId,
        }))?.max_id;
        if (maxId === undefined) {
            throw new Error(`log selection boundary could not be resolved for worker ${ctx.workerId}`);
        }
        const schemeCtx = new SchemeCtxImpl(ctx, "log", manifest, this.#liveSubscriptions, { ownerId: null });
        const outcome = await handler.curate(statement, schemeCtx, maxId);
        return { result: Results.assert(outcome.result), plan: outcome.plan };
    }

    // {§proposal}/{§send} — status 202 is a proposal except for broadcast
    // SEND signal 202, which parks the loop. The operation disambiguates the status.
    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        if (result.status !== 202) return false;
        return !(statement.op === "SEND" && statement.target === null);
    }

    // Normalize a parsed target for log storage. Bare paths and `file:///...`
    // inputs collapse to scheme=null in log target metadata because both render
    // as bare paths. Addressable file entries separately persist under the
    // reserved `file` identity scheme ({§entry-identity-no-null}).
    #extractTarget(path: ParsedPath | null, workerId: number): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        query: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, query: null, fragment: null };
        // `local` (bare path) carries no URL parts — store the raw text as the pathname for the log record, scheme=null.
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: PathSyntax.decodeParens(path.raw), query: null, fragment: null }; // {§path-parentheses}
        const scheme = path.scheme === "file" ? null : path.scheme;
        // The registered scheme owns authority disposition. Namespace authority
        // is path syntax; resource and owner authorities remain explicit in the
        // durable operation evidence.
        const routedScheme = schemeNameOf(path);
        const manifest = routedScheme === null
            ? undefined
            : this.#schemes.manifestFor(routedScheme, workerId);
        const foldNs = scheme !== null
            && manifest !== undefined
            && (manifest.authority ?? "namespace") === "namespace";
        return {
            scheme, username: path.username, password: path.password,
            hostname: foldNs ? null : path.hostname, port: foldNs ? null : path.port,
            pathname: PathSyntax.decodeParens(foldNs ? foldAuthorityIntoPath(path.hostname, path.pathname) : path.pathname), // {§path-parentheses}
            query: path.query, fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
