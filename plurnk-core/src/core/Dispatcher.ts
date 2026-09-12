import { PlurnkParser, TurnDisposition } from "@plurnk/plurnk-contracts";
import type { BareStatement, CapabilityProjection, EditStatement, ForkStatement, KillStatement, ParsedPath, PlurnkOp, PlurnkStatement, ReadStatement, SendStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type ClientInteractions from "./ClientInteractions.ts";
import type { ProposalResolution } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { foldAuthorityIntoPath, promptLoopPrefix, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import Namespace from "./namespace.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";
import { type StreamEventNotify, type WakeWorkerNotify, type InjectWorkerNotify, type CancelWorkerNotify, type CancelDescendantsNotify } from "./ChannelWrite.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import Results from "./results.ts";
import { OperationFailureError } from "./results.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import { CoreSchemeAdapterBase, type ExecSource } from "./CoreSchemeServices.ts";
import { InvalidOperationResultError, type SchemeCtx, type SchemeHandler, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { LogCurationOutcome, LogCurationPlan } from "../schemes/Log.ts";
import ResourceMutations from "./ResourceMutations.ts";
import { primaryTargetOf } from "./statement-primary.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import EntryAddressBinding, { type BoundEntryAddress as ResolvedDataEntryAddress, type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import WorkerControlHandler from "./WorkerControlHandler.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import KillHandler from "./KillHandler.ts";
import TurnDispositionHandler, { type CompletionEvidence, type PacketBoundaries } from "./TurnDispositionHandler.ts";
import LogWriter from "./LogWriter.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import DataStatementRunner from "./DataStatementRunner.ts";
import ResourceBindings from "./ResourceBindings.ts";
import type EditSequence from "./EditSequence.ts";

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy.
// READ/FIND are not gated — they read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL", "FORK", "WORK"]);


export type DispatchContext = {
    statement: PlurnkStatement;
    workspaceId: number;
    workerId: number;
    // {§actor-boundary-attached-functionality} — absent means the dispatching
    // Worker's own Functionality; a client operation names its attached Worker.
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    // The append-only log boundary visible when this admitted program entered
    // execution. Direct single-operation dispatch captures its own boundary.
    logSelectionMaxId?: number;
    editSequence?: EditSequence;
    // {§send-final-strike-retrieval}: private loop-rail decision, never a model operand.
    allowUnobservedRetrievalCompletion?: boolean;
    // Durable identity is available before a proposal can be resolved; the
    // terminal row becomes externally visible only after that proposal settles.
    onDispatch?: (logEntryId: number) => void;
    onSettled?: (logEntryId: number) => void | Promise<void>;
};

export type DispatchResult = SchemeResult;

export interface ResolvedClientEntryAddress {
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
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #injectWorker: InjectWorkerNotify | undefined;
    #cancelWorker: CancelWorkerNotify | undefined;
    #cancelDescendants: CancelDescendantsNotify | undefined;
    // Per-turn running-worker READ obligations. {§join-blocking-collect}
    #liveSubscriptions: LiveSubscriptions;
    #lifecycle: LoopLifecycle;
    #resourceMutations: ResourceMutations;
    #entryAddresses: EntryAddressBinding;
    #capabilities: CapabilityResolver;
    readonly #workerControl: WorkerControlHandler;
    readonly #kill: KillHandler;
    readonly #disposition: TurnDispositionHandler;
    readonly #logWriter: LogWriter;
    readonly #dataRun: DataStatementRunner;

    constructor({ db, lifecycle, schemes, mimetypes, weigh, notices, proposals, interactions, executors, loopSignal, settleDerivations, streamEventNotify, wakeWorkerNotify, injectWorker,             cancelWorker, cancelDescendants, liveSubscriptions, entryAddresses }: {
        db: Db;
        lifecycle: LoopLifecycle;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        proposals: ProposalLifecycle;
        interactions: ClientInteractions;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
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
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#injectWorker = injectWorker;
        this.#cancelWorker = cancelWorker;
        this.#cancelDescendants = cancelDescendants;
        this.#liveSubscriptions = liveSubscriptions;
        this.#entryAddresses = entryAddresses;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        this.#lifecycle = lifecycle;
        this.#resourceMutations = new ResourceMutations({
            schemes,
            liveSubscriptions,
            run: (schemeName, statement, ctx) => this.#dataRun.run(schemeName, statement, ctx),
            checkWritable: (statement, origin, workspaceId) => this.#checkWritable(statement, origin, workspaceId),
            checkCapabilities: (statement, ctx) => this.#checkCapabilities(statement, ctx),
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
        this.#workerControl = new WorkerControlHandler({ db: this.#db, failure: Dispatcher.#failure });
        this.#kill = new KillHandler({ db: this.#db, schemes: this.#schemes, liveSubscriptions: this.#liveSubscriptions, cancelWorker: this.#cancelWorker, resolveDataEntryAddress: this.#resolveDataEntryAddress.bind(this), boundEntryContext: this.#boundEntryContext.bind(this), handlerContext: this.#handlerContext.bind(this), deleteEntry: this.#deleteEntry.bind(this), failure: Dispatcher.#failure });
        this.#disposition = new TurnDispositionHandler({ db: this.#db, cancelDescendants: this.#cancelDescendants, lifecycle: this.#lifecycle, nextPacketBoundaries: this.#nextPacketBoundaries.bind(this), unobservedFailureCount: this.#unobservedFailureCount.bind(this), pendingSet: this.#pendingSet.bind(this), hasLiveWork: this.hasLiveWork.bind(this), failure: Dispatcher.#failure, statusResult: Dispatcher.#statusResult, unobservedFailures: Dispatcher.#unobservedFailures });
        this.#logWriter = new LogWriter({ db: this.#db, weighContent: this.#weighContent, extractTarget: this.#extractTarget.bind(this), canonColumns: this.#canonColumns.bind(this), signalToJson: this.#signalToJson.bind(this), isProposal: Dispatcher.#isProposal });
        this.#dataRun = new DataStatementRunner({ schemes: this.#schemes, liveSubscriptions: this.#liveSubscriptions, resolveDataEntryAddress: this.#resolveDataEntryAddress.bind(this), prepareDataRepresentation: this.#prepareDataRepresentation.bind(this), failure: Dispatcher.#failure });
    }

    // workspace → project_root, memoized: {§fs-namespace} fixes the root immutably at
    // workspace creation, so a process-lifetime cache can never go stale.
    #rootCache = new Map<number, string | null>();

    evictWorkspaceCache(workspaceId: number): void {
        this.#rootCache.delete(workspaceId);
    }

    async #handlerContext(scheme: string, ctx: PlurnkSchemeContext, authority = ""): Promise<SchemeCtxImpl | null> {
        const manifest = this.#schemes.manifestFor(scheme, ctx.workspaceId);
        return manifest === undefined
            ? null
            : new SchemeCtxImpl(ctx, scheme, manifest, this.#liveSubscriptions, {
                authority,
            });
    }

    #boundEntryContext(
        routedScheme: string,
        address: ResolvedDataEntryAddress,
        ctx: PlurnkSchemeContext,
    ): SchemeCtxImpl | null {
        const manifest = this.#schemes.manifestFor(routedScheme, ctx.workspaceId);
        return manifest?.category === "data"
            ? new SchemeCtxImpl(ctx, address.scheme, manifest, this.#liveSubscriptions, {
                authority: address.authority,
            })
            : null;
    }

    #coreCrud(scheme: string, workspaceId: number): CoreSchemeWithCrud | undefined {
        const handler = this.#schemes.get(scheme, workspaceId);
        return handler instanceof CoreSchemeAdapterBase
            ? handler as CoreSchemeAdapterBase & CoreSchemeWithCrud
            : undefined;
    }

    async #readEntry(scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
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
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
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
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
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
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
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
        _workerId: number,
    ): Promise<string | null> {
        const target = this.#extractTarget(statement.target, workspaceId);
        await this.#canonColumns(target, workspaceId);
        return renderTarget(target);
    }

    // {§kill-scope-entry} — a scoped KILL on an entry-bearing scheme is one EDIT with an empty
    // body over the same marker: prepared, gated, and merged as an EDIT while its log row
    // records the model's KILL. Schemes that implement kill() (streams) take the scope themselves;
    // the log's scoped KILL is curation.
    readonly #scopedEntryEdits = new WeakMap<KillStatement, EditStatement>();

    #scopedEntryEdit(statement: PlurnkStatement, workspaceId: number): EditStatement | null {
        if (statement.op === "EDIT") return statement;
        // {§kill-scope-entry} a scoped KILL of an entry empties the span; {§kill-pattern} a KILL with
        // a matcher removes every whole line the pattern selects, inside its scope when one is given.
        // Both are emptying EDITs; the log and every scheme with its own kill() keep their own path.
        if (statement.op !== "KILL" || (statement.lineMarker === null && statement.matcher === null)) return null;
        const cached = this.#scopedEntryEdits.get(statement);
        if (cached !== undefined) return cached;
        const schemeName = schemeNameOf(statement.target);
        if (schemeName === null || schemeName === "log") return null;
        const handler = this.#schemes.get(schemeName, workspaceId) as { kill?: unknown } | undefined;
        if (handler === undefined || typeof handler.kill === "function") return null;
        const edit: EditStatement = {
            op: "EDIT",
            aside: statement.aside,
            metadata: statement.metadata,
            target: statement.target,
            lineMarker: statement.lineMarker,
            matcher: statement.matcher,
            body: "",
            position: statement.position,
        };
        this.#scopedEntryEdits.set(statement, edit);
        if (statement.matcher !== null) this.#resourceMutations.markLineDeletion(edit);
        return edit;
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        let result = await ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(context),
            (ctx) => this.#dispatchOne(context, ctx));
        const edit = context.statement.op === "EDIT" ? context.statement : this.#scopedEntryEdits.get(context.statement as KillStatement);
        if (edit !== undefined) {
            // {§edit-batch-merges} — a proposal's apply result replaces the projected one; the
            // statement's merge facts ride every EDIT result, whichever route produced it.
            result = this.#resourceMutations.withMergeFacts(edit, result);
            this.#resourceMutations.settleEdit(edit, result);
        }
        return result;
    }

    async #dispatchOne(context: DispatchContext, schemeCtx: PlurnkSchemeContext): Promise<DispatchResult> {
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
        let result: DispatchResult;
        let curationPlan: LogCurationPlan | null = null;
        // {§send-prompt-acceptance} — a model SEND addressed to one of this loop's own prompts
        // means what an untargeted SEND means; the address the packet showed it is accepted.
        const ownPrompt = statement.op === "SEND" && origin === "model" && await this.#isOwnPromptAddress(statement.target, workerId, loopId);
        const denial = ownPrompt ? null : (this.#checkWritable(statement, origin, workspaceId)
            ?? await this.#checkCapabilities(statement, schemeCtx));
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
                    result = await this.#resourceMutations.edit(statement, schemeCtx, context.editSequence);
                } else if (statement.op === "SEND" && (statement.target === null || ownPrompt)) {
                    result = await this.#respond(statement, schemeCtx, origin, workerId, loopId);
                } else if (TurnDisposition.is(statement)) {
                    result = await this.#disposition.handle(statement, {
                        workspaceId,
                        workerId,
                        loopId,
                        turnId,
                        sequence,
                        origin,
                        allowUnobservedRetrievalCompletion: context.allowUnobservedRetrievalCompletion,
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
                    // {§worker-spawn-prompt-resource} — a non-address path is the child's prompt resource.
                    const seeded = await this.#seedSpawnPrompt(statement, schemeCtx);
                    result = "result" in seeded ? seeded.result : await this.#workerControl.handleWorkerControl(seeded.statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#resourceMutations.handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#resourceMutations.handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL" && this.#scopedEntryEdit(statement, workspaceId) !== null) {
                    result = await this.#resourceMutations.edit(this.#scopedEntryEdits.get(statement)!, schemeCtx, context.editSequence);
                } else if (statement.op === "KILL") {
                    result = await this.#kill.handleKill(statement, schemeCtx);
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
                        `The '${scheme ?? "unknown"}' scheme did not produce a result for ${statement.op}.`,
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
        const logEntryId = await this.#logWriter.writeLog({
            statement,
            result,
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
        // side-effecting op returns status 202 (a waiting TASK parks rather
        // than proposing — #isProposal), the entry is written
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
            if (statement.op === "EXEC" || (statement.op === "SEND"
                && this.#schemes.isRuntimeScheme(schemeNameOf(statement.target) ?? "", workspaceId))) {
                if (!EffectPolicy.isEffect(effect)) {
                    throw new InvalidOperationResultError("Execution proposal omitted its canonical effect fact.");
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
                const effective = await this.#resourceMutations.settleProposal({
                    statement,
                    result,
                    settlement: initialSettlement,
                    ctx: schemeCtx,
                    ids: { workspaceId, workerId, loopId, turnId },
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
                { workspaceId, workerId, loopId, turnId },
            );
            const effective = await this.#resourceMutations.settleProposal({
                statement,
                result,
                settlement: initialSettlement,
                ctx: schemeCtx,
                ids: { workspaceId, workerId, loopId, turnId },
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
        workspaceId: number; workerId: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, origin = "client" } = context;
        if (statement.op !== "READ") throw new Error(`look resolves READ only; got ${statement.op}`);
        // turnId is a write-time FK only — a look writes no row, so 0 (no turn) is inert.
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId: 0, origin });
        return ResourceBindings.using(this.#schemes, schemeCtx, async (ctx) => {
            try {
                const denial = await this.#checkCapabilities(statement, ctx);
                return denial ?? await this.#dataRun.run(schemeNameOf(statement.target), statement, ctx);
            } catch (error) {
                if (error instanceof OperationFailureError) return error.result;
                throw error;
            }
        });
    }

    capabilityProjection(workspaceId: number): Promise<CapabilityProjection> {
        return this.#capabilities.projection(workspaceId);
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
        const coreCtx = this.#buildSchemeCtx({
            workspaceId,
            workerId,
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
        return ResourceBindings.using(this.#schemes, ctx, async (boundCtx) => {
            try {
                const binding = await ResourceBindings.resolve(target, boundCtx);
                if (binding?.manifest.category !== "data") return null;
                return this.#resolveDataEntryAddress({ target, routedScheme,
                    handler: binding.handler as SchemeWithEntryAddress, manifest: binding.manifest, ctx: boundCtx });
            } catch (error) {
                if (error instanceof OperationFailureError) return { address: null, result: error.result };
                throw error;
            }
        });
    }

    async #resolveDataEntryAddress({
        target,
        routedScheme,
        handler,
        manifest,
        ctx,
        access = "read",
    }: {
        target: ParsedPath;
        routedScheme: string;
        handler: SchemeWithEntryAddress;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        access?: "read" | "write";
    }): Promise<PreparedRepresentation> {
        if (manifest.category !== "data") {
            throw new TypeError(`Scheme '${routedScheme}' is not entry-bearing.`);
        }
        return this.#entryAddresses.resolve({ target, routedScheme, handler, manifest, ctx, access });
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
                    `Scheme '${routedScheme}' does not accept the [metadata] modifier.`,
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
    async readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ExecSource> {
        return ResourceBindings.using(this.#schemes, ctx,
            (boundCtx) => this.#readExecSource(statement, boundCtx));
    }

    async #readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ExecSource> {
        const schemeName = schemeNameOf(statement.target);
        const binding = await ResourceBindings.resolve(statement.target, ctx);
        const manifest = binding?.manifest;
        if (manifest !== undefined && manifest.category !== "data") {
            return { nativePath: null, result: Dispatcher.#failure(
                "exec-source-not-data",
                501,
                `Scheme '${schemeName}' is not a data source for EXEC.`,
                {},
                {
                    scheme: schemeName,
                    category: manifest.category,
                    retryable: false,
                },
            ) };
        }
        const result = Results.assertReadResult(await this.#dataRun.run(schemeName, statement, ctx));
        const target = statement.target;
        const handler = binding?.handler as SchemeHandler | undefined;
        const selectedChannel = target?.kind === "url" ? target.fragment : null;
        if (result.status !== 200 || target === null || handler === undefined || manifest?.category !== "data"
            || (selectedChannel !== null && selectedChannel !== manifest.defaultChannel)) {
            return { result, nativePath: null };
        }
        const resolved = await this.#resolveDataEntryAddress({ target, routedScheme: schemeName!, handler, manifest, ctx });
        if (resolved.result !== null) return { result: resolved.result, nativePath: null };
        const source = resolved.address === null ? undefined : handler.byteSource?.(resolved.address, EntryAddressBinding.addressContext(ctx));
        if (source?.nativePath === undefined) return { result, nativePath: null };
        const nativePath = await source.nativePath();
        if (nativePath === null) return { nativePath: null, result: Dispatcher.#failure(
            "entry-not-found", 404, "The EXEC source file no longer exists.", {}, { target: target.raw },
        ) };
        return { result, nativePath };
    }

    // The one place per-dispatch coordinates are built; a caller that carries no
    // explicit Functionality coordinate acts in its own Worker's
    // ({§actor-boundary-attached-functionality}). Consumers read the built
    // PlurnkSchemeContext and never re-derive.
    #buildSchemeCtx(ids: { workspaceId: number; workerId: number; loopId: number; turnId: number; origin: WriterTier }): PlurnkSchemeContext {
        const { workspaceId, workerId, loopId, turnId, origin } = ids;
        const context: PlurnkSchemeContext = {
            db: this.#db,
            workspaceId, workerId, loopId, turnId,
            writer: origin,
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            injectWorker: this.#injectWorker,
            mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            // {§exec-stream} — a runtime scheme's default channel is its own (stdout), never the
            // catalog fallback `body`; resolved through the same registry the writable gate reads.
            defaultChannelFor: (scheme) => this.#schemes.defaultChannelFor(scheme, context.workspaceId),
            settleDerivations: () => this.#settleDerivations(context),
            pushNotice: (notice) => this.#notices.push(workspaceId, workerId, loopId, notice),
            requestInteraction: (request, signal = this.#loopSignal(loopId)) => this.#interactions.request(
                request,
                { workspaceId, workerId, loopId, turnId },
                signal,
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
    #checkWritable(statement: PlurnkStatement, origin: WriterTier, workspaceId: number): DispatchResult | null {
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (TurnDisposition.is(statement) || statement.op === "SEND" && statement.target === null) return null;

        // EXEC's operation authority always belongs to the exec scheme;
        // runtime-specific resource authority is gated separately below.
        if (statement.op === "EXEC") {
            return this.#denyIfDisallowed("exec", origin, workspaceId);
        }

        // {§stream-control}, {§exec-input}: process control is not a write to
        // stored output. The workspace execution binding owns KILL and SEND.
        if (statement.op === "KILL" || statement.op === "SEND") {
            const target = schemeNameOf(statement.target);
            if (target !== null && this.#schemes.isRuntimeScheme(target, workspaceId)) return null;
        }

        // Worker control (FORK/WORK → worker://<name>, spawn or fork) is gated by worker://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // {§machine-processes}
        if (this.#isWorkerControl(statement)) return this.#denyIfDisallowed("worker", origin, workspaceId);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.destination.target;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin, workspaceId);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.source.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin, workspaceId);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        const denial = this.#denyIfDisallowed(target, origin, workspaceId);
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

    #denyIfDisallowed(schemeName: string | null, origin: WriterTier, workspaceId: number): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName, workspaceId);
        if (handler === undefined) return null;
        const manifest = this.#schemes.manifestFor(schemeName, workspaceId);
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
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult | null> {
        await LoopPolicyReader.read(this.#db, ctx.loopId);
        const denied = await this.#capabilities.denial(
            statement,
            ctx.workspaceId,
            ctx.writer,
            async (target) => (await ResourceBindings.resolve(target, ctx))?.manifest,
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

    capabilityDenial(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<SchemeResult | null> {
        return ResourceBindings.using(this.#schemes, ctx,
            (boundCtx) => this.#checkCapabilities(statement, boundCtx));
    }

    // Worker control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new worker's seed prompt, not a destination path. The COPY gates and ResourceMutations.handleCopy
    // branch on this so they never parse the prompt as a dst path.
    #isWorkerControl(statement: PlurnkStatement): statement is ForkStatement | WorkStatement {
        return statement.op === "FORK" || statement.op === "WORK"; // worker control targets worker://<name> (grammar 0.74.55)
    }

    // {§rejected-emission-entry} — rejected provider bytes, never an admitted program.
    async writeEmissionAttempt({ verbatim, workerId, loopId, turnId, sequence, modelCallId }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number;
        modelCallId: number;
    }): Promise<number> {
        const durableAttrs = { kind: "emissionAttempt" };
        const rx = JSON.stringify({ content: verbatim, mimetype: "text/vnd.plurnk" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
            origin: "model", source: null, model_call_id: modelCallId,
            op: null, signal: null,
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
            initial_folded: LogVisibility.serialize(LogVisibility.FOLDED),
        });
        if (row === undefined) throw new Error("Dispatcher.writeEmissionAttempt: insert returned no row");
        return row.id;
    }

    // {§worker-spawn-prompt-resource} WORK and FORK overload their slot by scheme: a `worker://`
    // path is always the child's address (and keeps the address rules); a path of any other scheme
    // is read whole and becomes the child's prompt, composed with the body as BARE's combined form.
    // The durable row keeps the authored statement; only the handler sees the composed one, with no
    // target, so the child is auto-named exactly as when the slot is empty.
    async #seedSpawnPrompt(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<{ statement: WorkStatement | ForkStatement } | { result: DispatchResult }> {
        if (statement.target === null || WorkerControlAddress.isWorkerScheme(statement.target)) return { statement };
        const read: ReadStatement = { ...statement, op: "READ", matcher: null, body: null, lineMarker: { marks: [1, -1] } };
        const denial = await this.#checkCapabilities(read, ctx);
        if (denial !== null) return { result: denial };
        const result = Results.assertReadResult(await this.#dataRun.run(schemeNameOf(read.target), read, ctx));
        if (result.status !== 200 && result.status !== 204) return { result };
        if (result.content !== null && typeof result.content !== "string") {
            throw new InvalidOperationResultError(`${statement.op} prompt resource READ returned non-text content.`);
        }
        const prompt = [result.content ?? "", statement.body ?? ""].filter((part) => part !== "").join("\n\n");
        if (prompt.trim() === "") {
            return { result: Dispatcher.#failure(
                "spawn-prompt-empty", 422, `${statement.op} has no prompt text: the resource is empty and there is no body.`, {}, { retryable: false },
            ) };
        }
        return { statement: { ...statement, target: null, body: prompt } };
    }

    // {§bare-inference} Reuse exact READ projection without its log/presentation layer.
    async prepareBarePrompt(
        context: Pick<DispatchContext, "workspaceId" | "workerId" | "loopId" | "turnId" | "origin"> & { statement: BareStatement },
    ): Promise<{ prompt: string } | { result: DispatchResult }> {
        return ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(context), async (ctx) => {
            try {
                return await this.#prepareBarePrompt(context.statement, ctx);
            } catch (error) {
                if (error instanceof OperationFailureError) return { result: error.result };
                throw error;
            }
        });
    }

    async #prepareBarePrompt(statement: BareStatement, ctx: PlurnkSchemeContext): Promise<{ prompt: string } | { result: DispatchResult }> {
        const denial = await this.#checkCapabilities(statement, ctx);
        if (denial !== null) return { result: denial };
        let resource = "";
        if (statement.target !== null) {
            const read: ReadStatement = {
                ...statement,
                op: "READ",
                matcher: null,
                body: null,
                lineMarker: { marks: [1, -1] },
            };
            const result = Results.assertReadResult(await this.#dataRun.run(schemeNameOf(read.target), read, ctx));
            if (result.status !== 200 && result.status !== 204) return { result };
            if (typeof result.content === "string") resource = result.content;
            else if (result.content !== null) {
                throw new InvalidOperationResultError("BARE source READ returned non-text content.");
            }
        }
        const prompt = [resource, statement.body].filter((part) => part !== "").join("\n\n");
        if (prompt.trim() === "") {
            return { result: Dispatcher.#failure(
                "bare-prompt-empty", 422, "BARE has no prompt text.", {}, { retryable: false },
            ) };
        }
        return { prompt };
    }

    // {§bare-inference} Provider work runs concurrently; receipts commit in authored order.
    async recordBareResult(
        context: Omit<DispatchContext, "statement"> & { statement: BareStatement },
        result: DispatchResult,
        modelCallId: number | null,
    ): Promise<DispatchResult> {
        Results.assert(result);
        const logEntryId = await this.#logWriter.writeLog({
            ...context,
            result,
            curationPlan: null,
            modelCallId,
        });
        context.onDispatch?.(logEntryId);
        await context.onSettled?.(logEntryId);
        return result;
    }


    // {§send-prompt-acceptance} `prompt://<this worker>/<this loop>/<id>` names a prompt the loop
    // contains; a SEND to it is the response, exactly as if untargeted. Another worker's or
    // another loop's prompt is not a recipient and keeps the ordinary refusal.
    // {§send-response-receipt} — a response names the prompts it answers, so the receipt
    // says where the text went. {§send-looks-like-operation} — a model response whose first
    // line is an operation heading is a mis-fenced operation, not a reply: the 2026-09-11
    // dogfood put four operations on the line after their fences, delivered all four to the
    // user as 200 replies, then waited fifteen minutes for receipts that could never come.
    async #respond(statement: SendStatement, schemeCtx: PlurnkSchemeContext, origin: WriterTier, workerId: number, loopId: number): Promise<DispatchResult> {
        if (origin === "model") {
            const heading = this.#operationHeading(statement.body?.raw ?? "", schemeCtx);
            if (heading !== null) {
                return Dispatcher.#failure(
                    "send-looks-like-operation",
                    400,
                    `The response begins with the operation heading \`${heading}\`; nothing ran and nothing was delivered.`,
                    {},
                    {
                        heading,
                        stage: "dispatch",
                        recovery: `An operation goes on the fence line (\`\`\`\`${heading}); a quoted example goes inside a SEND body.`,
                        retryable: false,
                    },
                );
            }
        }
        return { status: 200, recipients: await this.#activePrompts(workerId, loopId) };
    }

    // The first non-blank line, when it parses alone as one clean heading naming an operation
    // this worker could perform: a Plurnk operation, or a registered executor or MCP service.
    #operationHeading(body: string, schemeCtx: PlurnkSchemeContext): string | null {
        const line = body.split("\n").find((candidate) => candidate.trim().length > 0)?.trim();
        if (line === undefined || line.startsWith("`")) return null;
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(line, null));
        if (parsed.unparsedTail !== undefined || parsed.items.length !== 1 || parsed.items[0].kind !== "statement") return null;
        const { statement } = parsed.items[0];
        if (statement.op !== "EXEC") return line;
        const executor = statement.executor;
        if (executor === null || schemeCtx.executors?.entry(executor, schemeCtx.workspaceId) === undefined) return null;
        return line;
    }

    // The loop's Active Prompts, oldest first, exactly as the packet lists them.
    async #activePrompts(workerId: number, loopId: number): Promise<string[]> {
        const worker = await this.#db.worker_get.get<{ name: string }>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId} does not exist`);
        const loopSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        const prefix = promptLoopPrefix(loopSeq);
        const rows = await this.#db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({
            worker_id: workerId,
            pattern: `${prefix}%`,
            prefix_len: prefix.length,
        });
        return rows.map((row) => `prompt://${worker.name}${row.pathname}`);
    }

    async #isOwnPromptAddress(target: ParsedPath | null, workerId: number, loopId: number): Promise<boolean> {
        if (target === null || target.kind !== "url" || target.scheme !== "prompt") return false;
        const worker = await this.#db.worker_get.get<{ name: string }>({ id: workerId });
        if (worker === undefined || target.hostname !== worker.name) return false;
        const loopSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        return target.pathname.startsWith(promptLoopPrefix(loopSeq));
    }

    // {§send-premature-terminate} The pending set is judged at TASK's dispatch point,
    // after earlier operations have executed. Every non-SEND/TASK/KILL model operation
    // requires a new packet, independently of its result or log visibility.
    async #pendingSet(workerId: number, turnId: number): Promise<CompletionEvidence> {
        const pending: CompletionEvidence["pending"] = [];
        // {§worker-obligations} — the stream and child legs are one durable row.
        const held = await this.#db.worker_live_obligations.get<{ streams: 0 | 1; workers: 0 | 1 }>({ worker_id: workerId });
        if (held === undefined) throw new Error(`worker ${workerId} does not exist`);
        if (held.streams === 1) pending.push("streams");
        if (held.workers === 1) pending.push("workers");
        const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
        const receipts = [...new Set(boundaries.operations
            .filter(({ op }) => op !== "KILL")
            .map((row) => LogEntryProjection.leaf(row)))];
        if (boundaries.streamTerminations.length > 0) receipts.push("stream completion");
        if (receipts.length > 0) pending.push("receipts");
        // The final-strike escape hatch cannot discard an unobserved failure.
        if (boundaries.streamTerminations.some(({ closeStatus }) => closeStatus >= 400)) pending.push("failed-stream-results");
        if (boundaries.childTerminations) pending.push("worker-results");
        return { pending, receipts };
    }

    // {§wait-obligation-matrix}: completion and an empty wait use the same execution evidence.
    async #nextPacketBoundaries(workerId: number, turnId: number): Promise<PacketBoundaries> {
        const [turnBoundaries, streamTerminations, childTermination] = await Promise.all([
            this.#db.engine_turn_packet_boundaries.all<{ op: string; tx: string | null }>({ turn_id: turnId }),
            this.#db.engine_worker_has_undelivered_stream_term
                .all<{ closeStatus: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_undelivered_child_term
                .get<{ pending: number }>({ worker_id: workerId }),
        ]);
        return {
            operations: turnBoundaries,
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
            `Completion deferred: ${failCount} operation${failCount === 1 ? "" : "s"} failed in the same turn. The failure${failCount === 1 ? " is" : "s are"} in this packet; address ${failCount === 1 ? "it" : "them"} or complete with a TASK now.`,
            {},
            {
                failures: failCount,
                stage: "completion",
                retryable: true,
            },
        );
    }

    // A live obligation to wait on: a spawned child or an open stream (not retrievals, which land
    // next turn regardless). The wait-side twin of #pendingSet's stream+child legs ({§wait-obligation-matrix}).
    async hasLiveWork(workerId: number): Promise<boolean> {
        // {§worker-obligations} — one durable row answers both legs.
        const held = await this.#db.worker_live_obligations.get<{ streams: 0 | 1; workers: 0 | 1 }>({ worker_id: workerId });
        return held !== undefined && (held.streams === 1 || held.workers === 1);
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
        const schemeCtx = new SchemeCtxImpl(ctx, "log", manifest, this.#liveSubscriptions, { });
        const outcome = await handler.curate(statement, schemeCtx, maxId);
        return { result: Results.assert(outcome.result), plan: outcome.plan };
    }

    // {§proposal}/{§send} — native dispositions park; other 202 results propose.
    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        if (result.status !== 202) return false;
        return !TurnDisposition.is(statement);
    }

    // Normalize a parsed target for log storage. Bare paths and `file:///...`
    // inputs collapse to scheme=null in log target metadata because both render
    // as bare paths. Addressable file entries separately persist under the
    // reserved `file` identity scheme ({§entry-identity-no-null}).
    #extractTarget(path: ParsedPath | null, workspaceId: number): {
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
            : this.#schemes.manifestFor(routedScheme, workspaceId);
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
