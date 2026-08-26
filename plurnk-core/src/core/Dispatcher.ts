import type {
    BareStatement,
    EditStatement,
    ForkStatement,
    OpenStatement,
    FoldStatement,
    ParsedPath,
    PlurnkOp,
    PlurnkStatement,
    ReadStatement,
    WorkStatement,
} from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import WorkerName, { WorkerNameError } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type ClientInteractions from "./ClientInteractions.ts";
import type { ProposalResolution } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { entryCoordinateOf, foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import { PathSyntax, TagSignal } from "@plurnk/plurnk-contracts";
import Namespace from "./namespace.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";
import ChannelWrite, { type StreamEventNotify, type WakeWorkerNotify, type InjectWorkerNotify, type BranchWorkerNotify, type BranchCompletionGate, type CancelWorkerNotify, type CancelDescendantsNotify } from "./ChannelWrite.ts";
import { ReadProjector } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryOps from "../schemes/_entry-ops.ts";
import EntryFind from "../schemes/_entry-find.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import Results from "./results.ts";
import { OperationFailureError } from "./results.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import WorkerSettingsReader from "./worker-settings.ts";
import { CoreSchemeAdapterBase, type CoreRepresentationProvider } from "./CoreSchemeServices.ts";
import {
    InvalidOperationResultError,
    type SchemeCtx,
    type SchemeHandler,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { ProviderEncryptedReasoningItem } from "@plurnk/plurnk-providers";
import DurableStatement from "./DurableStatement.ts";
import type { LogCurationOutcome, LogCurationPlan } from "../schemes/Log.ts";
import ResourceMutations from "./ResourceMutations.ts";
import LogBody, { type ActionlessLogKind } from "./LogBody.ts";
import EntryAddressBinding, {
    type BoundEntryAddress as ResolvedDataEntryAddress,
    type EntryAddressResolution as PreparedRepresentation,
} from "./EntryAddressBinding.ts";

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy.
// OPEN/FOLD/READ/FIND are not gated — they curate the log or read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL", "FORK", "WORK"]);

const assertClassifyingSignal = (statement: PlurnkStatement): void => {
    if (
        statement.op === "FIND"
        || statement.op === "READ"
        || statement.op === "EDIT"
        || statement.op === "COPY"
        || statement.op === "MOVE"
        || statement.op === "BARE"
    ) {
        TagSignal.applied(statement.signal);
    }
    if (statement.op === "EXEC") TagSignal.applied(statement.tags ?? null); // {§exec-tag-signal}
};

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
    onDispatch?: (logEntryId: number) => void;
};

export type DispatchResult = SchemeResult;

export interface ResolvedClientEntryAddress {
    readonly ownerId: number;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly target: string;
}

type SchemeMethod = (statement: PlurnkStatement, ctx: SchemeCtx) => Promise<DispatchResult>;
type LogCurationHandler = {
    curate(statement: OpenStatement | FoldStatement, ctx: SchemeCtx): Promise<LogCurationOutcome>;
};
interface CoreSchemeWithCrud {
    readEntry?: (pathname: string, ctx: SchemeCtx) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: SchemeCtx) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
    deleteChannel?: (pathname: string, channel: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
}

type SchemeWithEntryAddress = Pick<SchemeHandler, "resolveEntryAddress">;

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
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #injectWorker: InjectWorkerNotify | undefined;
    #branchWorker: BranchWorkerNotify | undefined;
    #branchCompletionGate: BranchCompletionGate | undefined;
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

    constructor({ db, schemes, mimetypes, weigh, notices, proposals, interactions, executors, loopSignal, streamEventNotify, wakeWorkerNotify, injectWorker, branchWorker, branchCompletionGate,             cancelWorker, cancelDescendants, parkDeadlines, joinTargets, liveSubscriptions, entryAddresses }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        proposals: ProposalLifecycle;
        interactions: ClientInteractions;
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
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#injectWorker = injectWorker;
        this.#branchWorker = branchWorker;
        this.#branchCompletionGate = branchCompletionGate;
        this.#cancelWorker = cancelWorker;
        this.#cancelDescendants = cancelDescendants;
        this.#parkDeadlines = parkDeadlines ?? new Map();
        this.#joinTargets = joinTargets ?? new Set();
        this.#liveSubscriptions = liveSubscriptions;
        this.#entryAddresses = entryAddresses;
        this.#lifecycle = new LoopLifecycle(db);
        this.#resourceMutations = new ResourceMutations({
            schemes,
            liveSubscriptions,
            run: (schemeName, statement, ctx) => this.#run(schemeName, statement, ctx),
            checkWritable: (statement, origin, workerId) => this.#checkWritable(statement, origin, workerId),
            checkFlagsGate: (statement, loopId, workerId) => this.#checkFlagsGate(statement, loopId, workerId),
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

    async prepareEditBatches(
        statements: readonly EditStatement[],
        context: Omit<DispatchContext, "statement" | "sequence">,
    ): Promise<void> {
        for (const statement of statements) assertClassifyingSignal(statement); // {§log-tag-signal}
        const { workspaceId, workerId, functionalityWorkerId, loopId, turnId, origin } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId, loopId, turnId, origin });
        await this.#resourceMutations.prepareEditBatches(statements, context, schemeCtx);
    }


    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        assertClassifyingSignal(context.statement); // {§log-tag-signal}
        const result = await this.#dispatchOne(context);
        if (context.statement.op === "EDIT") {
            this.#resourceMutations.settleEdit(context.statement, result);
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
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId: context.functionalityWorkerId, loopId, turnId, origin });
        const { functionalityWorkerId } = schemeCtx;
        let result: DispatchResult;
        let curationPlan: LogCurationPlan | null = null;
        let denial = this.#checkWritable(statement, origin, functionalityWorkerId);
        if (denial === null) denial = await this.#checkFlagsGate(statement, loopId, functionalityWorkerId);
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
                    result = await this.#handleSendBroadcast(statement, {
                        workspaceId,
                        workerId,
                        loopId,
                        turnId,
                        sequence,
                        origin,
                    });
                } else if (statement.op === "OPEN" || statement.op === "FOLD") {
                    const curation = await this.#runLogCuration(statement, schemeCtx);
                    result = curation.result;
                    curationPlan = curation.plan;
                } else if (statement.op === "FORK" || statement.op === "WORK") {
                    result = await this.#handleWorkerControl(statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#resourceMutations.handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#resourceMutations.handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL") {
                    result = await this.#handleKill(statement, schemeCtx);
                } else if (statement.op === "PLAN") {
                    result = this.#handlePlan(statement);
                } else if (statement.op === "EXEC") {
                    // {§worker-tool-admission} — the question runtime is admitted
                    // per worker: a worker whose own rules don't request user input
                    // gets the explicit not-available outcome, never a parked loop.
                    if (("signal" in statement && typeof statement.signal === "string")
                        && !(await WorkerSettingsReader.toolAvailable(this.#db, schemeCtx.functionalityWorkerId, statement.signal))) {
                        result = Dispatcher.#failure(
                            "question-tool-unavailable",
                            404,
                            "The question tool is not available to this worker.",
                            {},
                            {
                                stage: "tool-admission",
                                recovery: "This worker does not request user input; continue from the available evidence.",
                                retryable: false,
                            },
                        );
                    } else {
                        // EXEC routes unconditionally to its operation owner. The
                        // resolved runtime declaration owns body/target semantics.
                        result = await this.#run("exec", statement, schemeCtx);
                    }
                } else {
                    result = await this.#run(schemeNameOf(statement.target), statement, schemeCtx); // {§op-methods-op-dispatch}
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — {§scheme-surface-exception-500}
                if (err instanceof InvalidOperationResultError) throw err;
                if (err instanceof OperationFailureError) {
                    result = err.result;
                } else {
                    const scheme = schemeNameOf(statement.target);
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
        // {§fold-open-meta-operations} — persist OPEN/FOLD for forensics;
        // packet rendering suppresses their successful receipts.
        // A running-worker READ arms this turn's blocking collect.
        // {§join-blocking-collect}
        if (typeof (result as { awaitWorker?: unknown }).awaitWorker === "string") this.#joinTargets.add(loopId);
        const logEntryId = await this.#writeLog({
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
        workspaceId: number; workerId: number; functionalityWorkerId?: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, origin = "client" } = context;
        if (statement.op !== "READ") throw new Error(`look resolves READ only; got ${statement.op}`);
        // turnId is a write-time FK only — a look writes no row, so 0 (no turn) is inert.
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, functionalityWorkerId: context.functionalityWorkerId, loopId, turnId: 0, origin });
        const denial = await this.#checkFlagsGate(statement, loopId, schemeCtx.functionalityWorkerId);
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
        routedScheme,
        handler,
        manifest,
        ctx,
        publishedChannel,
        resolved: priorResolution,
    }: {
        target: ParsedPath;
        routedScheme: string;
        handler: SchemeWithEntryAddress & SchemeHandler;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        publishedChannel: string | null;
        resolved?: PreparedRepresentation;
    }): Promise<PreparedRepresentation> {
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
        return Results.assertReadResult(await this.#run(schemeName, statement, ctx));
    }

    // The one place per-dispatch coordinates are built; a caller that carries no
    // explicit Functionality coordinate acts in its own Worker's
    // ({§actor-boundary-attached-functionality}). Consumers read the built
    // PlurnkSchemeContext and never re-derive.
    #buildSchemeCtx(ids: { workspaceId: number; workerId: number; functionalityWorkerId?: number; loopId: number; turnId: number; origin: WriterTier }): PlurnkSchemeContext {
        const { workspaceId, workerId, loopId, turnId, origin } = ids;
        const functionalityWorkerId = ids.functionalityWorkerId ?? workerId;
        return {
            db: this.#db,
            workspaceId, workerId, functionalityWorkerId, loopId, turnId,
            writer: origin,
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            injectWorker: this.#injectWorker,
            mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            pushNotice: (notice) => this.#notices.push(workspaceId, loopId, notice),
            requestInteraction: (request) => this.#interactions.request(
                request,
                { workspaceId, workerId, loopId, turnId },
                this.#loopSignal(loopId),
            ),
            executors: this.#executors(),
        };
    }

    // SPEC {§scheme-surface}: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ, FIND, OPEN, FOLD) are not gated.
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

        // Worker control (FORK/WORK → worker://<name>, spawn or fork) is gated by worker://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // {§machine-processes}
        if (this.#isWorkerControl(statement)) return this.#denyIfDisallowed("worker", origin, workerId);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.body?.target ?? null;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin, workerId);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin, workerId);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        return this.#denyIfDisallowed(target, origin, workerId);
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

    // Per-loop flag gating. Schemes self-declare their flag affinity in
    // their manifest (excludedInAsk / requiresWeb /
    // requiresInteraction); SchemeRegistry.resolveForLoop returns the
    // active set under the loop's persisted flags. A registered scheme outside
    // that set returns 403; unknown names continue to their operation owner for
    // the ordinary registration failure. Action-entry-as-outcome carries either.
    async #checkFlagsGate(statement: PlurnkStatement, loopId: number, functionalityWorkerId: number): Promise<DispatchResult | null> {
        const workerId = functionalityWorkerId;
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

        const active = this.#schemes.resolveForLoop(flags, workerId);
        // {§mode-ask-read-only}: name the non-retryable restriction so the model changes course.
        const restriction = flags.mode === "ask"
            ? "this is an ask-mode (read-only) loop — you cannot run commands or take host actions here"
            : flags.noWeb && flags.noInteraction ? "web and interaction are disabled for this loop"
            : flags.noWeb ? "web access is disabled for this loop"
            : "interaction is disabled for this loop";
        const checkScheme = (scheme: string | null): DispatchResult | null => {
            if (scheme === null || !this.#schemes.has(scheme, workerId)) return null;
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
        // {§exec-target-routing} — only a runtime-declared resource target adds
        // source authority. Literal identifiers and path targets stay executor-local.
        if (statement.op === "EXEC") {
            const operationDenial = checkScheme("exec");
            if (operationDenial !== null) return operationDenial;
            const requested = typeof statement.signal === "string" ? statement.signal : "";
            const runtime = requested === "" ? "sh" : requested;
            // {§manifest-flag-affinity} — a runtime alias is a registered scheme
            // with its own affinity: the one resolver gates the selected runtime
            // exactly as it gates the exec family (e.g. `question` under noInteraction).
            const runtimeDenial = checkScheme(runtime);
            if (runtimeDenial !== null) return runtimeDenial;
            const targetKind = this.#executors()?.entry(runtime, workerId)?.invocation.target?.kind;
            if (targetKind !== "resource") return null;
            const sourceScheme = schemeNameOf(statement.target);
            return sourceScheme === null || sourceScheme === "file" ? null : checkScheme(sourceScheme);
        }
        return check(statement.target);
    }

    // Worker control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new worker's seed prompt, not a destination path. The COPY gates and ResourceMutations.handleCopy
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
            const branchWorkerId = await Fork.fork(
                this.#db,
                ctx.workerId,
                name,
                (scheme) => this.#schemes.entryInheritanceForStoredScheme(scheme, ctx.workerId),
            );
            await ctx.injectWorker({
                workspaceId: ctx.workspaceId,
                workerId: branchWorkerId,
                sourceWorkerId: ctx.workerId,
                prompt,
                flags,
                parentLoopId: ctx.loopId,
            });
            return { status: 200, body: name };
        }
        // WORK — a fresh worker sister named <name>.
        const row = await this.#db.fork_insert_worker.get<{ id: number }>({
            workspace_id: ctx.workspaceId, name, parent_worker_id: ctx.workerId, origin: ctx.writer,
            fork_snapshot: 0,
        });
        if (row === undefined) throw new Error("worker spawn: worker insert returned no row");
        await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId: row.id,
            sourceWorkerId: ctx.workerId,
            prompt,
            flags,
            parentLoopId: ctx.loopId,
        });
        return { status: 200, body: name };
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
        const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
        const coordinate = entryCoordinateOf(path, manifest?.authority ?? "namespace");
        // Log targets use the same killable dispatch as streams; erasure is their
        // permanent curation operation. {§turn-ops-log-curation}
        // Process-KILL: any scheme whose handler exposes kill() aborts a live stream — the
        // exec handler, registered as "exec" + under every runtime tag (sh/node), so a tag-
        // addressed stream (sh:///l/t/s) routes here, not to deleteEntry. {§exec}
        const killable = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as { kill?: (pathname: string, signal: number | null, ctx: SchemeCtx, scheme?: string) => Promise<SchemeResult> } | undefined;
        if (killable !== undefined && typeof killable.kill === "function") {
            // Pass the model's OWN scheme so a stream-KILL error answers in the runtime tag the
            // model addressed (sh:///…), not the internal `exec` ({§fs-answer-in-canon}).
            let handlerCtx: SchemeCtxImpl | null;
            if (manifest?.category === "data") {
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: schemeName,
                    handler: killable as SchemeWithEntryAddress,
                    manifest,
                    ctx,
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    return Dispatcher.#failure(
                        "entry-not-found",
                        404,
                        `No entry exists at ${renderAddress({ scheme: schemeName, ...coordinate })}.`,
                    );
                }
                handlerCtx = this.#boundEntryContext(schemeName, resolved.address, ctx);
            } else {
                handlerCtx = await this.#handlerContext(schemeName, ctx, coordinate.authority);
            }
            if (handlerCtx === null) {
                throw new InvalidOperationResultError(`Registered scheme '${schemeName}' has no dispatch context.`);
            }
            return await killable.kill(coordinate.pathname, statement.signal, handlerCtx, schemeName);
        }
        if (schemeName === "worker") {
            // Entry-path present → KILL a private owner-held entry (delete it), self-only —
            // NOT worker cancellation. The authority (hostname) names the owner, the pathname the
            // entry; only the path-ABSENT form (worker://<name>) terminates the worker-as-actor. {§worker-scheme}
            const entryPath = path.kind === "url" ? (path.pathname ?? "") : "";
            if (entryPath !== "" && entryPath !== "/") {
                const workerHandler = this.#schemes.get("worker") as SchemeWithEntryAddress & { killEntry: (s: PlurnkStatement, c: SchemeCtx) => Promise<SchemeResult> };
                if (manifest?.category !== "data") {
                    throw new InvalidOperationResultError("Registered scheme 'worker' is not entry-bearing.");
                }
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: "worker",
                    handler: workerHandler,
                    manifest,
                    ctx,
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    return Dispatcher.#failure("entry-not-found", 404, "The worker entry does not exist.");
                }
                const handlerCtx = this.#boundEntryContext("worker", resolved.address, ctx);
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
        if (!this.#schemes.has(schemeName, ctx.functionalityWorkerId)) {
            return Dispatcher.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as SchemeWithEntryAddress | undefined;
        if (handler === undefined || manifest?.category !== "data") {
            return Dispatcher.#failure(
                "entry-operation-unsupported",
                400,
                `KILL requires an entry-bearing target; '${schemeName}' does not provide one.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const resolved = await this.#resolveDataEntryAddress({
            target: path,
            routedScheme: schemeName,
            handler,
            manifest,
            ctx,
        });
        if (resolved.result !== null) return resolved.result;
        if (resolved.address === null) {
            return Dispatcher.#failure("entry-not-found", 404, "The KILL target does not exist.");
        }
        // A host-effecting delete (file) returns 202 to PROPOSE — pass its attrs through so the proposal
        // carries the delete target to review (#isProposal fires on 202). Plurnk-internal deletes execute inline.
        return this.#deleteEntry(schemeName, resolved.address, ctx);
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
        });
        if (row === undefined) throw new Error("Dispatcher.#writeActionlessEntry: insert returned no row");
        if (folded) await this.#db.engine_fold_log_entry.run({ id: row.id });
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

    // PLAN — the model's complete current Plan. An ordinary op: dispatched like any
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
        assertClassifyingSignal(context.statement);
        Results.assert(result);
        const logEntryId = await this.#writeLog({
            ...context,
            functionalityWorkerId: context.functionalityWorkerId ?? context.workerId,
            result,
            curationPlan: null,
            modelCallId,
        });
        context.onDispatch?.(logEntryId);
        return result;
    }


    // {§send-premature-terminate} — the unified PENDING SET, judged at the terminal's OWN dispatch
    // (post-batch: the emission's earlier ops already executed, so a same-turn KILL+[200] repairs in
    // ONE turn, and a same-turn WORK+[200] is caught — the spawn is live by the time the SEND lands).
    // pending = open streams ∪ live children ∪ THIS turn's retrievals (READ/FIND/OPEN/BARE, results unseen
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
        const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
        if (boundaries.retrievals) pending.push("this turn's receipts (READ/FIND/OPEN/BARE results and EDIT/COPY/MOVE effects land in the NEXT packet's Log)");
        // A stream that closed successfully is banked, not pending: concluding on its own
        // success is legitimate and its output stays in the Log. A failed close is an unseen
        // failure — named exactly (bench#5 requiem #9) so the model reads it, not guesses.
        const failedStreams = boundaries.streamTerminations
            .filter(({ closeStatus }) => closeStatus >= 400)
            .map(({ handle }) => handle);
        if (failedStreams.length > 0) pending.push(`failed stream results that land in the NEXT packet's Log: ${failedStreams.join("; ")}`);
        if (boundaries.childTerminations) pending.push("worker results that arrived during this turn (they land NEXT turn)");
        return pending;
    }

    // Results cross an observation boundary only when they have appeared in a packet;
    // successful FOLD effects likewise become useful through the curated next packet.
    // Keep every next-packet boundary in one classifier while letting the callers apply
    // their distinct contracts: retrievals block explicit completion, whereas FOLD only
    // prevents an empty wait from being inferred as completion.
    async #nextPacketBoundaries(workerId: number, turnId: number): Promise<{
        retrievals: boolean;
        folds: boolean;
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
            retrievals: turnBoundaries.some(({ op }) => op !== "FOLD"),
            folds: turnBoundaries.some(({ op }) => op === "FOLD"),
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
        origin: WriterTier;
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

        // The park rides SEND signal 202 only ({§park-202-only}). A scoped signal 102 is neither
        // a wait nor a meaningful continuation, so reject it instead of preserving the
        // retired dual spelling.
        if (status === 102 && statement.lineMarker !== null) {
            return Dispatcher.#failure(
                "send-scope-invalid",
                400,
                "`## SEND0 [102]` does not accept a scope.",
                {},
                {
                    requestedStatus: 102,
                    scope: statement.lineMarker,
                    recovery: "Use `## SEND0 [202] <scope>` to wait, or remove the scope to continue.",
                    retryable: false,
                },
            );
        }

        // A bare continue after an armed running-worker READ becomes an
        // indefinite park. {§join-blocking-collect}
        const joinArmed = this.#joinTargets.delete(loopId);
        if (status === 102 && statement.lineMarker === null && joinArmed) {
            if (!await this.#lifecycle.park(loopId)) {
                return Dispatcher.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to park it.");
            }
            this.#parkDeadlines.set(loopId, -1); // indefinite: the bounded child's terminal is the wake edge
            return { status: 102, attrs: { parked: -1, join: true } };
        }

        // {§wait-obligation-matrix} — SEND signal 202 is the obligation-checked join. A live
        // obligation (a spawned child or open stream, J) BLOCKS the loop until it concludes and
        // reawakens it ({§worker-lifecycle-child-wake}); a wait on nothing (∅) is already satisfied and
        // resolves like 200, so <-1>+∅ self-resolves rather than hang the agent; a pending own
        // retrieval (R) just lands next turn, so the wait continues.
        if (status === 202) {
            const marks = statement.lineMarker?.marks[0];
            const seconds = typeof marks === "number" ? marks : -1; // bare 202 / absent T = indefinite, bounded by the join
            if (await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId)) {
                    return Dispatcher.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to wait.");
                }
                this.#parkDeadlines.set(loopId, seconds);
                return { status: 202, attrs: { waiting: seconds } };
            }
            // Retrievals, fast stream conclusions, and child conclusions are
            // all complete-but-unobserved. Their wake edge may already have
            // fired, so do not park; continue directly to the packet that
            // materializes them.
            const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
            if (boundaries.retrievals || boundaries.folds || boundaries.streamTerminations.length > 0 || boundaries.childTerminations) {
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
                TerminalResult.success(raw),
            );
            return {
                status: finished !== null ? 200 : await this.#lifecycle.status(loopId),
                attrs: { joined: true, pending: 0 },
            };
        }

        // [200] — terminate, gated by the pending set (post-batch). The row records the refused
        // attempt faithfully (status_rx=409, never erased); the loop stays a continue; the strike
        // couples in runTurn. [499] abandons and cancels the descendant scope.
        if (status === 200) {
            // Model completion is a claim about the Worker's observed work and
            // therefore crosses the pending-result rails. A `_plurnk`
            // maintenance program closes only its own administrative loop; it
            // must not claim, consume, or be blocked by model work elsewhere in
            // the same Worker.
            if (ctx.origin === "model") {
                // {§send-premature-terminate} — same-turn failures are unobserved
                // pending results and therefore refuse completion.
                const failCount = await this.#unobservedFailureCount(turnId);
                if (failCount > 0) return Dispatcher.#unobservedFailures(failCount);
                const pending = await this.#pendingSet(workerId, turnId);
                if (pending.length > 0) {
                    // A receipts-only refusal needs no KILL/park remedy menu: the results simply
                    // arrive in the next packet. Streams and children retain their remedy steer.
                    const receiptsOnly = pending.every((k) => k.startsWith("this turn's receipts"));
                    if (receiptsOnly) {
                        return Dispatcher.#failure(
                            "retrieval-results-unobserved",
                            409,
                            "Last turn both performed operations whose receipts land in the next packet and attempted to terminate. Retrievals and mutations force an additional turn so their results can be reviewed.",
                            {},
                            {
                                pending: [...pending],
                                stage: "completion",
                                recovery: "Review the results, then use only `# PLAN0` and `## SEND0 [200]` to conclude.",
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
            }
            const finished = await this.#lifecycle.finish(
                loopId,
                TerminalResult.success(raw),
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
                throw new Error(`SEND signal 499: no coordinate for loop=${loopId} turn=${turnId}`);
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
            const fields = statement.op === "READ"
                ? { content: null, mimetype: null, channel: null }
                : statement.op === "FIND"
                    ? {
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsWeightTotal: 0,
                        returnedItemsWeightTotal: 0,
                        matchingPathCount: 0,
                        matchLocationCount: 0,
                    }
                    : {};
            return Dispatcher.#failure(
                "target-scheme-required",
                400,
                `${statement.op} requires a target scheme.`,
                fields,
                { operation: statement.op, retryable: false },
            );
        }
        const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
        const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as Partial<Record<keyof SchemeHandler, SchemeMethod>> | undefined;
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
        if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
        const publishedChannel = statement.target?.kind === "url"
            ? statement.target.fragment ?? manifest.defaultChannel
            : manifest.defaultChannel;
        const authoredCoordinate = statement.target === null
            ? { authority: "", pathname: "" }
            : entryCoordinateOf(statement.target, manifest.authority ?? "namespace");
        // EXEC's authored target belongs to its declared invocation contract;
        // a resource target is input to the executor, never the output-stream
        // address owned by the internal exec scheme. {§exec-target-routing}
        const addressResolution = manifest.category === "data"
            && statement.target !== null
            && statement.op !== "EXEC"
            ? await this.#resolveDataEntryAddress({
                target: statement.target,
                routedScheme: schemeName,
                handler: handler as unknown as SchemeWithEntryAddress,
                manifest,
                ctx,
            })
            : null;
        if (addressResolution?.result !== null && addressResolution?.result !== undefined) {
            return addressResolution.result;
        }
        const operationAddress = addressResolution?.address ?? null;
        const schemeCtx = new SchemeCtxImpl(
            ctx,
            addressedScheme ?? schemeName,
            manifest,
            this.#liveSubscriptions,
            {
                authority: operationAddress?.authority ?? authoredCoordinate.authority,
                ownerId: operationAddress?.ownerId ?? await this.#fixedEntryOwnerId(manifest, ctx),
                publishedChannel,
            },
        );
        if (
            statement.op === "SEND"
            && statement.signal === 499
            && statement.target?.kind === "url"
            && operationAddress !== null
        ) {
            const addressedScheme = statement.target.scheme;
            const entry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: operationAddress.ownerId,
                scheme: operationAddress.scheme,
                authority: operationAddress.authority,
                pathname: operationAddress.pathname,
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
        if (
            statement.op === "READ"
            && handler instanceof CoreSchemeAdapterBase
            && typeof (handler as Partial<CoreRepresentationProvider>).resolveCoreRepresentation === "function"
        ) {
            const selectionNeutralTarget = statement.target?.kind === "url"
                ? {
                    ...statement.target,
                    raw: renderTarget({ ...statement.target, fragment: null }) ?? statement.target.raw,
                    fragment: null,
                }
                : statement.target;
            const resolved = await (handler as unknown as CoreRepresentationProvider)
                .resolveCoreRepresentation(selectionNeutralTarget, schemeCtx);
            if ("result" in resolved) return Results.assertReadResult(resolved.result);
            if (selectionNeutralTarget === null) {
                throw new InvalidOperationResultError(
                    `Core scheme '${schemeName}' resolved a targetless READ representation.`,
                );
            }
            const target = renderTarget(selectionNeutralTarget.kind === "url"
                ? selectionNeutralTarget
                : { scheme: null, pathname: selectionNeutralTarget.raw });
            if (target === null) {
                throw new TypeError(`Core scheme '${schemeName}' resolved an unrenderable READ target.`);
            }
            return Results.assertReadResult(await ReadProjector.project({
                statement,
                manifest,
                target,
                identity: target,
                representation: resolved.representation,
                mimetypes: ctx.mimetypes,
            }));
        }
        if (statement.op === "READ" && manifest.category === "data") {
            const prepared = statement.target === null
                ? { address: null, result: null }
                : await this.#prepareDataRepresentation({
                    target: statement.target,
                    routedScheme: schemeName,
                    handler: handler as unknown as SchemeWithEntryAddress & SchemeHandler,
                    manifest,
                    ctx,
                    publishedChannel,
                    ...(addressResolution === null ? {} : { resolved: addressResolution }),
                });
            if (prepared.result !== null) return prepared.result;
            const resolved = prepared.address;
            if (statement.target !== null && resolved === null) {
                const target = renderTarget(statement.target.kind === "url"
                    ? statement.target
                    : { scheme: null, pathname: statement.target.raw });
                return Results.failure(
                    `scheme:${schemeName}`,
                    "entry-not-found",
                    404,
                    `No entry exists at ${target ?? "the requested address"}.`,
                    { content: null, mimetype: null, channel: null },
                    { target },
                );
            }
            const storageScheme = resolved?.scheme ?? manifest.storedScheme ?? addressedScheme ?? schemeName;
            const projected = Results.assertReadResult(await EntryOps.readWorkspaceEntry(
                statement,
                ctx,
                { ...manifest, name: storageScheme, storedScheme: storageScheme },
                resolved === null
                    ? null
                    : {
                        ownerId: resolved.ownerId,
                        authority: resolved.authority,
                        pathname: resolved.pathname,
                    },
            ));
            return projected;
        }
        if (statement.op !== "FIND" || manifest.category !== "data") {
            if (typeof method === "function") {
                return Results.assert(await method.call(handler, statement, schemeCtx));
            }
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
        const targetPathname = statement.target?.kind === "url"
            ? statement.target.pathname
            : statement.target?.raw ?? "";
        const collectionTarget = manifest.folderScopes === true
            && (targetPathname === "" || targetPathname.endsWith("/"));
        const exactTarget = statement.target !== null
            && !collectionTarget
            && !PathSyntax.hasGlob(authoredCoordinate.pathname);
        if (exactTarget && statement.target !== null) {
            const prepared = await this.#prepareDataRepresentation({
                target: statement.target,
                routedScheme: schemeName,
                handler: handler as unknown as SchemeWithEntryAddress & SchemeHandler,
                manifest,
                ctx,
                publishedChannel,
                ...(addressResolution === null ? {} : { resolved: addressResolution }),
            });
            if (prepared.result !== null) return prepared.result;
            if (prepared.address === null) {
                const target = renderTarget(statement.target.kind === "url"
                    ? statement.target
                    : { scheme: null, pathname: statement.target.raw });
                return Results.failure(
                    `scheme:${schemeName}`,
                    "entry-not-found",
                    404,
                    `No entry exists at ${target ?? "the requested address"}.`,
                    {
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsWeightTotal: 0,
                        returnedItemsWeightTotal: 0,
                        matchingPathCount: 0,
                        matchLocationCount: 0,
                    },
                    { target },
                );
            }
            const storageScheme = prepared.address.scheme
                ?? manifest.storedScheme
                ?? addressedScheme
                ?? schemeName;
            return Results.assert(await EntryFind.findWorkspaceEntries(
                statement,
                ctx,
                { ...manifest, name: storageScheme, storedScheme: storageScheme },
                {
                    ownerId: prepared.address.ownerId,
                    authority: prepared.address.authority,
                    pathname: prepared.address.pathname,
                },
            ));
        }
        if (typeof method === "function") {
            return Results.assert(await method.call(handler, statement, schemeCtx));
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
        const schemeCtx = new SchemeCtxImpl(ctx, "log", manifest, this.#liveSubscriptions, { ownerId: null });
        const outcome = await handler.curate(statement, schemeCtx);
        return { result: Results.assert(outcome.result), plan: outcome.plan };
    }

    // {§proposal}/{§send} — status 202 is a proposal except for broadcast
    // SEND signal 202, which parks the loop. The operation disambiguates the status.
    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        if (result.status !== 202) return false;
        return !(statement.op === "SEND" && statement.target === null);
    }

    async #writeLog({
        statement, result, workspaceId, workerId, functionalityWorkerId, loopId, turnId, sequence, origin, curationPlan, modelCallId,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; workerId: number; functionalityWorkerId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
    }): Promise<number> {
        const durableStatement = DurableStatement.project(statement);
        const target = this.#extractTarget(durableStatement.target, functionalityWorkerId);
        await this.#canonColumns(target, workspaceId); // {§fs-answer-in-canon}
        const lineMarkerJson = "lineMarker" in durableStatement && durableStatement.lineMarker !== null
            ? JSON.stringify(durableStatement.lineMarker)
            : null;
        // A proposal (status 202 from a side-effecting op) is written to the log in
        // state='proposed' until the proposal lifecycle resolves it; attrs holds the
        // scheme-supplied payload (file diff, exec command, etc.) the client renders
        // for review and the scheme consumes on accept. A broadcast SEND signal 202 is a
        // parked-terminal, not a proposal (#isProposal) → state='resolved'.
        const isProposed = Dispatcher.#isProposal(statement, result);
        let attrsObj: Record<string, unknown> = (result.attrs !== undefined && result.attrs !== null)
            ? { ...(result.attrs as Record<string, unknown>) }
            : {};
        if (curationPlan !== null) {
            if (Object.hasOwn(attrsObj, "__plurnk_curation")) {
                throw new Error("Dispatcher.#writeLog: result attrs collide with private log curation state");
            }
            attrsObj.__plurnk_curation = {
                targets: curationPlan.targets,
                add: curationPlan.add,
                remove: curationPlan.remove,
            };
        }
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
            model_call_id: modelCallId,
            op: durableStatement.op,
            delimiter: durableStatement.delimiter,
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
            weight: LogBody.weight({
                op: durableStatement.op,
                attrs,
                tx: txJson,
                rx: rxJson,
                mimetypeTx: "application/json",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
        });
        // {§exec-tag-signal} — an EXEC row's signal is its runtime; its tag signal classifies
        // through the same idempotent primitive the log-write trigger uses for tag operations.
        if (row !== undefined && statement.op === "EXEC" && statement.tags !== undefined && statement.tags !== null) {
            for (const tag of TagSignal.applied(statement.tags).add) {
                await this.#db.log_write_tag.run({ log_entry_id: row.id, tag });
            }
        }
        if (row === undefined) throw new Error("Dispatcher.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
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
