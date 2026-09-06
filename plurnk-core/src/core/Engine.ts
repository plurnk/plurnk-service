import { Policy as RuntimePolicy, RuntimeInvocation, RuntimeTag } from "@plurnk/plurnk-execs";
import type { ClientInteractionProjection, ClientInteractionResolution, CapabilityProjection, PlurnkStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import Meta from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type { EntryData } from "../schemes/_entry-crud.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import SearchIndex from "../schemes/_search-index.ts";
import GitMembership from "./git-membership.ts";
import type { WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { RegistryEntry, RuntimeRegistryRegistration } from "./ExecutorRegistry.ts";
import type { StreamEventNotify, NoticeNotify, WakeWorkerNotify, InjectWorkerNotify, CancelWorkerNotify, CancelDescendantsNotify } from "./ChannelWrite.ts";
import type { ReasoningEventNotify } from "./ReasoningEvent.ts";
import type { LoopPacketNotify } from "./LoopPacket.ts";
import { promptPathname, promptLoopPrefix } from "./plurnk-uri.ts";
import { contentWeight } from "./content-weight.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";

// The engine's collaborators — each owns one machine; Engine owns the loop/turn
// lifecycle and wires them together as the public facade.
import NoticeChannel from "./NoticeChannel.ts";
import ProblemLog from "./ProblemLog.ts";
import StrikeRail from "./StrikeRail.ts";
import PacketBuilder from "./PacketBuilder.ts";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";
import ClientInteractions, { type ClientInteractionPendingEvent } from "./ClientInteractions.ts";
import type { ProposalProjection } from "@plurnk/plurnk-contracts";
import Dispatcher from "./Dispatcher.ts";
import EntryAddressBinding from "./EntryAddressBinding.ts";
import type { DispatchContext, DispatchResult, ResolvedClientEntryAddress } from "./Dispatcher.ts";
import TurnRunner from "./TurnRunner.ts";
import { observed } from "../observe/spans.ts";
import { providerRequestFromStorageRow, type ProviderRequestStorageRow } from "./provider-accounting.ts";

// Proposal types are part of Engine's public API (resolveProposal/onProposalPending);
// their definitions live with the lifecycle.
export type { ProposalDecision, ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";
export type WorkspaceDerivationStatus = {
    phase: "preparing" | "indexing" | "complete" | "failed";
    completed: number;
    total: number;
    percent: number;
    message: string;
    level: "info" | "error";
};
export type AcquireWorkspaceTurn = (workspaceId: number, workerId: number) => Promise<() => void>;
export type WorkspaceTurnStarting = (args: {
    workspaceId: number;
    workerId: number;
    loopId: number;
}) => Promise<void>;



// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { ProviderAccounting } from "@plurnk/plurnk-providers";
import { aggregateProviderAccounting } from "@plurnk/plurnk-providers";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";
import LoopDriver from "./LoopDriver.ts";

type ModuleRuntimeRegistration = RuntimeRegistryRegistration & {
    readonly scheme?: RuntimeSchemeFacet;
};

export type LoopUsage = {
    accounting: ProviderAccounting;
    curationWeight: number | null;
    curationBudget: number | null;
    contextTokens: number | null;
    contextCapacity: number | null;
    meta: Record<string, unknown>;
};



// The wall's abort reason — runLoop branches a mid-turn teardown to the 504 terminal on it.
export default class Engine {
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>): string {
        return StrikeRail.fingerprintTurn(ops);
    }

    static detectCycle(
        history: ReadonlyArray<string>,
        minCycles: number,
        maxCyclePeriod: number,
    ): { detected: false } | { detected: true; period: number; cycles: number } {
        return StrikeRail.detectCycle(history, minCycles, maxCyclePeriod);
    }

    #db: Db;
    #lifecycle: LoopLifecycle;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    // {§tokenomics-agnostic-ruler} — the stable model-independent ruler used
    // for write-time, catalog, receipt, and packet weights.
    #weighContent: (text: string) => number;
    // Boot-discovered runtime executors. Daemon builds + sets via
    // setExecutors at start(); undefined until then (and in bare tests).
    #executors: ExecutorRegistry | undefined;
    // {§send-premature-terminate}/scoped SEND signal 202 — park deadlines by loopId, written at dispatch (the
    // marker's seconds; -1 = indefinite), consumed by the daemon's drain park-exit to schedule
    // the deadline wake. In-memory: a daemon restart drops pending deadlines (documented).
    readonly parkDeadlines: Map<number, number> = new Map();
    // Per-turn running-worker READ obligations. {§join-blocking-collect}
    readonly joinTargets: Set<number> = new Set();

    // The collaborators. Engine constructs them (they share its deps via
    // thunks where the value is late-injected — executors, loop signals)
    // and fronts their public surface.
    #notices: NoticeChannel;
    #problems: ProblemLog;
    #strikes: StrikeRail;
    #packets: PacketBuilder;
    #proposals: ProposalLifecycle;
    #interactions: ClientInteractions;
    #dispatcher: Dispatcher;
    #turnRunner: TurnRunner;
    readonly #liveSubscriptions = new LiveSubscriptions();

    // Per-loop AbortController for cancellation propagation into scheme
    // ctx.signal. runLoop creates one at entry, cleans up at end. Engine
    // cancellation paths (strikes, max_turns, external) abort it.
    // Streaming schemes (exec) chain their per-spawn controllers off
    // ctx.signal so cancelled loops tear down their background spawns.
    #loopAborts = new Map<number, AbortController>();
    // {§prompt-loop-containment}: one worker's prompt-frame allocation and
    // persistence is a serial critical section. A completed later frame can
    // therefore never overtake or replace an earlier concurrent arrival.
    #promptWriteLocks = new Map<number, Promise<unknown>>();
    // One coalesced warm per workspace. Explicit membership changes may start it as soon
    // as content exists; the first model turn always joins it, so no operation observes
    // partial graph/FTS coverage. A request arriving mid-pass marks the workspace
    // dirty and guarantees one final exhaustive rescan.
    #workspaceWarms = new Map<number, {
        dirty: boolean;
        materialize: boolean;
        ctx: PlurnkSchemeContext;
        abort: AbortController;
        promise: Promise<void>;
    }>();
    #workspaceWarmStatus = new Map<number, WorkspaceDerivationStatus>();
    #queueWorkspaceWarm(ctx: PlurnkSchemeContext, invalidate = true, materialize = true): Promise<void> {
        const workspaceId = ctx.workspaceId;
        const existing = this.#workspaceWarms.get(workspaceId);
        if (existing !== undefined) {
            if (invalidate) existing.dirty = true;
            if (materialize) existing.materialize = true;
            existing.ctx = ctx;
            return existing.promise;
        }
        if (!invalidate && this.#workspaceWarmStatus.get(workspaceId)?.phase === "complete") {
            return Promise.resolve();
        }

        const state = {
            dirty: false,
            materialize,
            ctx,
            abort: new AbortController(),
            promise: Promise.resolve() };
        // Register before publishing the first synchronous Notice. A
        // listener may request another warm from that callback; it must join
        // this state rather than opening a second pump in the re-entrant gap.
        this.#workspaceWarms.set(workspaceId, state);
        const publish = (current: PlurnkSchemeContext, status: WorkspaceDerivationStatus): void => {
            this.#workspaceWarmStatus.set(workspaceId, status);
            current.pushNotice?.({
                source: "engine:derivation", kind: "search_progress", ...status });
        };
        const promise = (async () => {
            do {
                state.dirty = false;
                const shouldMaterialize = state.materialize;
                state.materialize = false;
                const current = state.ctx;
                let terminalPublished = false;
                try {
                    const signal = current.signal === undefined
                        ? state.abort.signal
                        : AbortSignal.any([current.signal, state.abort.signal]);
                    const cancellable = { ...current, signal };
                    if (shouldMaterialize) await GitMembership.indexGitMembership(cancellable);
                    await SearchIndex.maintain({
                        ...cancellable,
                        pushNotice: (notice) => {
                            if (notice.kind === "search_progress"
                                && (notice.phase === "preparing"
                                    || notice.phase === "indexing"
                                    || notice.phase === "complete"
                                    || notice.phase === "failed")
                                && typeof notice.completed === "number"
                                && typeof notice.total === "number"
                                && typeof notice.percent === "number") {
                                this.#workspaceWarmStatus.set(workspaceId, {
                                    phase: notice.phase,
                                    completed: notice.completed,
                                    total: notice.total,
                                    percent: notice.percent,
                                    message: notice.message ?? "Indexing repository search",
                                    level: notice.level === "error" ? "error" : "info" });
                                terminalPublished = notice.phase === "complete" || notice.phase === "failed";
                            }
                            current.pushNotice?.(notice);
                        } });
                } catch (error) {
                    if (!terminalPublished) {
                        publish(current, {
                            phase: "failed",
                            message: `Search indexing failed: ${error instanceof Error ? error.message : String(error)}`,
                            completed: 0, total: 1, percent: 0, level: "error" });
                    }
                    throw error;
                }
            } while (state.dirty);
        })().finally(() => {
            if (this.#workspaceWarms.get(workspaceId) === state) this.#workspaceWarms.delete(workspaceId);
        });
        state.promise = promise;
        return promise;
    }

    workspaceDerivationStatus(workspaceId: number): WorkspaceDerivationStatus | null {
        return this.#workspaceWarmStatus.get(workspaceId) ?? null;
    }

    evictWorkspaceCaches(workspaceId: number): void {
        if (!this.#workspaceWarms.has(workspaceId)) {
            this.#workspaceWarmStatus.delete(workspaceId);
        }
        this.#dispatcher.evictWorkspaceCache(workspaceId);
    }

    cancelDerivations(reason: unknown = new DOMException("derivations cancelled", "AbortError")): void {
        for (const state of this.#workspaceWarms.values()) {
            if (!state.abort.signal.aborted) state.abort.abort(reason);
        }
    }

    // Awaited by Daemon.stop before the db closes. Shutdown supplies the exact
    // cancellation reason it owns; every unrelated failure remains visible.
    async drainDerivations(ignoredReason?: unknown): Promise<void> {
        const results = await Promise.allSettled(
            [...this.#workspaceWarms.values()].map((state) => state.promise),
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason])
            .filter((error) => error !== ignoredReason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "derivation drain failed");
    }

    async drainWorkspaceDerivations(workspaceId: number): Promise<void> {
        await this.#workspaceWarms.get(workspaceId)?.promise;
    }
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly #acquireWorkspaceTurn: AcquireWorkspaceTurn;
    readonly #workspaceTurnStarting: WorkspaceTurnStarting | undefined;
    readonly #loopDriver: LoopDriver;

    constructor({ db, schemes, mimetypes, streamEventNotify, reasoningEventNotify, loopPacketNotify, wakeWorkerNotify, injectWorker, cancelWorker, cancelDescendants, acquireWorkspaceTurn, workspaceTurnStarting, noticeNotify, weigh }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes?: Mimetypes;
        streamEventNotify?: StreamEventNotify;
        reasoningEventNotify?: ReasoningEventNotify;
        loopPacketNotify?: LoopPacketNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
        acquireWorkspaceTurn?: AcquireWorkspaceTurn;
        workspaceTurnStarting?: WorkspaceTurnStarting;
        noticeNotify?: NoticeNotify;
        weigh?: (text: string) => number;
    }) {
        this.#db = db;
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#acquireWorkspaceTurn = acquireWorkspaceTurn ?? (async () => () => {});
        this.#workspaceTurnStarting = workspaceTurnStarting;
        // Default to empty discovery — standalone Engine construction (in
        // tests) gets no handlers, and content flows through the framework's
        // raw-content fitContent fallback. Daemon-managed Engine receives a
        // production-configured Mimetypes via the constructor arg.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] } });
        // {§tokenomics-agnostic-ruler} — standalone construction and the daemon
        // use the same default; provider request counting remains confined to
        // provider-owned capacity assessment.
        this.#weighContent = weigh ?? contentWeight;

        const executors = (): ExecutorRegistry | undefined => this.#executors;
        const loopSignal = (loopId: number): AbortSignal | undefined => this.#loopAborts.get(loopId)?.signal;
        this.#notices = new NoticeChannel({ notify: noticeNotify });
        this.#problems = new ProblemLog(db, this.#weighContent);
        this.#strikes = new StrikeRail();
        this.#packets = new PacketBuilder({
            db,
            schemes,
            executors });
        this.#interactions = new ClientInteractions(db);
        const entryAddresses = new EntryAddressBinding(db);
        this.#proposals = new ProposalLifecycle({
            db, schemes, notices: this.#notices,
            streamEventNotify, wakeWorkerNotify,
            weigh: this.#weighContent, mimetypes: this.#mimetypes, executors, loopSignal,
            liveSubscriptions: this.#liveSubscriptions,
            interactions: this.#interactions,
            entryAddresses });
        this.#dispatcher = new Dispatcher({
            db, schemes, mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            notices: this.#notices, proposals: this.#proposals,
            interactions: this.#interactions,
            executors, loopSignal,
            settleDerivations: (context) => this.#queueWorkspaceWarm(context),
            streamEventNotify, wakeWorkerNotify, injectWorker, cancelWorker, cancelDescendants,
            parkDeadlines: this.parkDeadlines,
            joinTargets: this.joinTargets,
            liveSubscriptions: this.#liveSubscriptions,
            entryAddresses });
        this.#turnRunner = new TurnRunner({
            db,
            schemes,
            mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            notices: this.#notices,
            problems: this.#problems,
            strikes: this.#strikes,
            packets: this.#packets,
            dispatcher: this.#dispatcher,
            liveSubscriptions: this.#liveSubscriptions,
            streamEventNotify,
            reasoningEventNotify,
            loopPacketNotify,
            wakeWorkerNotify,
            executors,
            loopSignal,
            interactions: this.#interactions,
            warmWorkspace: (context, invalidate, materialize) =>
                this.#queueWorkspaceWarm(context, invalidate, materialize),
            dispatch: (context) => this.dispatch(context),
            resolveWorkerProviderIdentity: (workerId) => this.resolveWorkerProviderIdentity(workerId) });
        schemes.bindCore({
            db,
            mimetypes: this.#mimetypes,
            executors,
            weigh: this.#weighContent,
            streamEventNotify,
            wakeWorkerNotify,
            injectWorker,
            pushNotice: (workspaceId, workerId, loopId, notice) => this.#notices.push(workspaceId, workerId, loopId, notice),
            defaultChannelFor: (scheme, workerId) => schemes.defaultChannelFor(scheme, workerId),
            settleDerivations: (context) => this.#queueWorkspaceWarm(context),
            resolveEntryAddress: (target, ctx) => this.#dispatcher.bindEntryAddress(target, ctx),
            readExecSource: (statement, ctx) => this.#dispatcher.readExecSource(statement, ctx),
            requestInteraction: (request, ids, signal) => this.#interactions.request(request, ids, signal),
            liveSubscriptions: this.#liveSubscriptions });
        this.#loopDriver = new LoopDriver({ loopAborts: this.#loopAborts, db: this.#db, lifecycle: this.#lifecycle, schemes: this.#schemes, notices: this.#notices, strikes: this.#strikes, acquireWorkspaceTurn: this.#acquireWorkspaceTurn, workspaceTurnStarting: this.#workspaceTurnStarting, runTurn: this.runTurn.bind(this) });
    }

    // Late injection: the executor registry is async-built at daemon start()
    // (discover + probe), after Engine construction.
    setExecutors(executors: ExecutorRegistry): void {
        this.#executors = executors;
    }

    // {§functionality-documents} — the coordinator's per-Worker generated
    // documents join the Worker's reference entries.
    setFunctionalityDocuments(documents: (workerId: number) => Array<{ pathname: string; content: string }>): void {
        this.#packets.setFunctionalityDocuments(documents);
    }

    static #enabledRuntimes(registrations: readonly ModuleRuntimeRegistration[]): ModuleRuntimeRegistration[] {
        return registrations.map(({ tag, entry, scheme }) => {
            RuntimeTag.assert(tag, "module runtime");
            return {
                tag,
                entry: {
                    ...entry,
                    invocation: RuntimeInvocation.assert(entry.invocation, entry.namespaceOwner.name, tag),
                },
                scheme,
            };
        }).filter(({ tag }) => RuntimePolicy.isEnabled(tag));
    }

    // {§plugin-namespace-arbitration} Both registries prepare before either publishes.
    registerRuntimes(registrations: readonly ModuleRuntimeRegistration[]): void {
        if (this.#executors === undefined) throw new Error("registerRuntimes: executor registry not wired yet");
        const normalized = Engine.#enabledRuntimes(registrations);
        const commitExecutors = this.#executors.prepareRegistrations(normalized);
        const commitSchemes = this.#schemes.prepareRuntimeSchemes(
            normalized.map(({ tag, entry, scheme }) => ({
                tag,
                executor: entry.executor,
                owner: entry.namespaceOwner,
                facet: scheme })),
        );
        commitSchemes();
        commitExecutors();
    }

    registerRuntime(tag: string, entry: RegistryEntry, scheme?: RuntimeSchemeFacet): void {
        this.registerRuntimes([{ tag, entry, scheme }]);
    }

    async prepareWorkerRuntimes(
        workerId: number,
        namespaceOwner: string,
        registrations: readonly ModuleRuntimeRegistration[],
    ): Promise<() => () => void> {
        if (this.#executors === undefined) {
            throw new Error("prepareWorkerRuntimes: executor registry not wired yet");
        }
        const normalized = Engine.#enabledRuntimes(registrations);
        const commitExecutors = this.#executors.prepareWorkerRegistrations(
            workerId,
            namespaceOwner,
            normalized,
        );
        const commitSchemes = await this.#schemes.prepareWorkerRuntimeSchemes(
            workerId,
            namespaceOwner,
            normalized.map(({ tag, entry, scheme }) => ({
                tag,
                executor: entry.executor,
                owner: entry.namespaceOwner,
                facet: scheme })),
        );
        return () => {
            const rollbackSchemes = commitSchemes();
            const rollbackExecutors = commitExecutors();
            let pending = true;
            return () => {
                if (!pending) return;
                pending = false;
                rollbackExecutors();
                rollbackSchemes();
            };
        };
    }

    // A lineage's no-parent root; a root worker resolves to itself. Fail hard
    // when corruption leaves a worker without one. {§worker-primary}
    async resolveWorkerPrimary(workerId: number): Promise<number> {
        const root = await this.#db.engine_worker_lineage_root.get<{ id: number }>({ worker_id: workerId });
        if (root === undefined) throw new Error(`resolveWorkerPrimary: worker ${workerId} has no lineage root — corrupt parent chain`);
        return root.id;
    }

    async resolveWorkerProviderIdentity(workerId: number): Promise<{
        workerId: string;
        primaryWorkerId: string;
    }> {
        const identity = await this.#db.engine_worker_provider_identity.get<{
            worker_id: string;
            primary_worker_id: string;
        }>({ worker_id: workerId });
        if (identity === undefined) {
            throw new Error(`resolveWorkerProviderIdentity: worker ${workerId} has no lineage root — corrupt parent chain`);
        }
        return {
            workerId: identity.worker_id,
            primaryWorkerId: identity.primary_worker_id };
    }

    // {§attribution} — reporting derives from exact provider-request evidence;
    // malformed durable tags fail here instead of being silently filtered.
    async loopAttributions(loopId: number): Promise<string[]> {
        const rows = await this.#db.engine_loop_attributions.all<{ attribution: unknown }>({ loop_id: loopId });
        const tags = rows.map(({ attribution }, index) => {
            if (typeof attribution !== "string" || attribution.length === 0) {
                throw new TypeError(`loop ${loopId} attribution row ${index} is not a non-empty string`);
            }
            return attribution;
        });
        return [...Meta.composeAttributions(tags)];
    }

    // The request ledger is cardinal evidence; its aggregate and the latest-turn
    // occupancy gauge are derived projections. {§tokenomics-client-gauge},
    // {§notifications-loop-terminated}, {§provider-accounting}
    async loopUsage(loopId: number): Promise<LoopUsage> {
        const row = await this.#db.engine_loop_usage.get<{
            context_tokens: number | null;
            curation_weight: number | null;
            curation_budget: number | null;
            context_capacity: number | null;
            meta: string | null;
        }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loopUsage: loop ${loopId} does not exist`);
        const requests = await this.#db.engine_loop_provider_requests.all<ProviderRequestStorageRow>({ loop_id: loopId });
        return {
            accounting: aggregateProviderAccounting(requests.map(providerRequestFromStorageRow)),
            // Latest assembled request's stable model-independent weight.
            curationWeight: row.curation_weight,
            // Latest provider-derived calibration used only for curation.
            curationBudget: row.curation_budget,
            // Latest emission call's last physical request, not the billed total.
            contextTokens: row.context_tokens,
            // Request-shaped physical capacity from that same latest emission call.
            contextCapacity: row.context_capacity,
            // Latest turn's opaque provider metadata. {§meta-passthrough}
            meta: JSON.parse(row.meta ?? "{}") as Record<string, unknown> };
    }

    runTurn(args: Parameters<TurnRunner["runTurn"]>[0]): ReturnType<TurnRunner["runTurn"]> {
        return this.#turnRunner.runTurn(args);
    }
    executeAdmittedTurn(
        args: Parameters<TurnRunner["executeAdmittedTurn"]>[0],
    ): ReturnType<TurnRunner["executeAdmittedTurn"]> {
        return this.#turnRunner.executeAdmittedTurn(args);
    }
    referenceEntries(workspaceId: number, workerId: number): Promise<Array<{ pathname: string; content: string }>> {
        return this.#packets.referenceEntries(workspaceId, workerId);
    }

    // {§env-delta-log-pull} — materialize one closed interval of the ambient
    // occurrence journal into this worker's self-contained log. #67 owns only
    // the remaining model-facing actor-name projection.
    cancelSubscription(subscriptionId: number): Promise<boolean> {
        return this.#liveSubscriptions.cancel(subscriptionId);
    }

    // {§env-delta} — exec streams as an instance of the ambient-observe machine:
    // each turn, emit each owned channel's next publishable content as a foisted READ row. It is
    // 200 while the channel streams and preserves the exact terminal result when closed. Intermediate
    // observations stay out of the log; the terminal observation becomes visible. The cursor is the
    // streamEnd recorded on the channel's prior observation. {§exec-stream}
    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        return observed( // {§observability-boundary}
            "op.dispatch",
            { op: context.statement.op },
            async (span) => {
                if (context.statement.op === "EDIT" || (context.statement.op === "KILL" && context.statement.lineMarker !== null)) {
                    const { statement, sequence: _sequence, ...batchContext } = context;
                    await this.#dispatcher.prepareEditBatches([statement], batchContext);
                }
                const result = await this.#dispatcher.dispatch(context);
                span.setAttribute("status", result.status);
                return result;
            },
        );
    }

    // {§op-look}: resolve a READ without writing a log_entries row.
    async look(context: {
        statement: PlurnkStatement;
        workspaceId: number; workerId: number; functionalityWorkerId?: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        return this.#dispatcher.look(context);
    }

    capabilityProjection(workspaceId: number, workerId: number): Promise<CapabilityProjection> {
        return this.#dispatcher.capabilityProjection(workspaceId, workerId);
    }

    async resolveEntryAddress(context: {
        target: ParsedPath;
        workspaceId: number;
        workerId: number;
    }): Promise<ResolvedClientEntryAddress | null> {
        return this.#dispatcher.resolveEntryAddress(context);
    }

    cancelAllProposals(outcome: string): void {
        this.#proposals.cancelAll(outcome);
    }

    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        this.#proposals.resolve(logEntryId, resolution);
    }

    // Snapshot of pending proposals for client-interface discovery.
    pendingProposalIds(): number[] {
        return this.#proposals.pendingIds();
    }

    // Subscribe to proposal-pending observations. Automatic settlement is
    // core-owned and happens before observers run.
    onProposalPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#proposals.onPending(listener);
    }

    async pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        return this.#proposals.list(workspaceId);
    }

    onClientInteractionPending(listener: (event: ClientInteractionPendingEvent) => void): void {
        this.#interactions.onPending(listener);
    }

    async pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]> {
        return this.#interactions.list(workspaceId);
    }

    async resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
    ): Promise<void> {
        await this.#interactions.resolve(interactionId, resolution);
    }

    // Used by wake-on-completion (daemon side): "is there any loop in this
    // worker still accepting turns?" If yes, skip the wake — the active loop
    // will pick up the channel transition at its next turn boundary. If no,
    // the daemon opens a fresh loop with the wake prompt.
    async hasActiveLoopForWorker(workerId: number): Promise<boolean> {
        const row = await this.#db.engine_count_active_loops_for_worker.get<{ n: number }>({ worker_id: workerId });
        return (row?.n ?? 0) > 0;
    }

    // Workspace-scope eager warm for explicit membership changes. The seam call returns
    // while progress live-fans-out at loopId 0; a model turn joins this same coalesced
    // promise and cannot reach its provider until coverage is complete.
    async warmWorkspaceDerivations(workspaceId: number): Promise<void> {
        const ctx: PlurnkSchemeContext = {
            db: this.#db, workspaceId, workerId: 0, functionalityWorkerId: 0, loopId: 0, turnId: 0,
            writer: "_plurnk",
            signal: undefined,
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            weigh: this.#weighContent,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s),
            pushNotice: (notice) => this.#notices.notify(workspaceId, null, 0, notice) };
        await this.#queueWorkspaceWarm(ctx); // materialize first; overlapping requests coalesce and rescan
    }

    // Inject a prompt into the worker's current non-terminal loop. Writes the
    // next owner-keyed prompt:///<loop>/<N> entry; the next turn publishes it
    // as one actionless prompt row. Prompt-frame writes serialize per worker,
    // so concurrent arrivals retain distinct ordered ordinals.
    //
    // Returns null when no loop in the worker is active or parked (102/202).
    // The daemon-side inject path then enqueues a fresh loop with this
    // prompt; engine doesn't open loops itself.
    inject(workerId: number, prompt: string, openPaths: readonly string[] = [], source?: string): Promise<
        { loopId: number; turnSeq: number } | null
    > {
        if (source !== undefined && source.length === 0) {
            throw new TypeError("Engine.inject: source must be a non-empty string when present");
        }
        return this.#withPromptWriteLock(workerId, () => this.#injectPrompt(workerId, prompt, openPaths, source));
    }

    #withPromptWriteLock<T>(workerId: number, write: () => Promise<T>): Promise<T> {
        const previous = this.#promptWriteLocks.get(workerId) ?? Promise.resolve();
        const run = previous.then(write, write);
        const tail = run.catch(() => {});
        this.#promptWriteLocks.set(workerId, tail);
        void tail.then(() => {
            if (this.#promptWriteLocks.get(workerId) === tail) this.#promptWriteLocks.delete(workerId);
        });
        return run;
    }

    async #injectPrompt(workerId: number, prompt: string, openPaths: readonly string[], source?: string): Promise<
        { loopId: number; turnSeq: number } | null
    > {
        const loopRow = await this.#db.drain_current_loop_for_worker.get<{ id: number; sequence: number }>({ worker_id: workerId });
        if (loopRow === undefined) return null;
        const loopId = loopRow.id;
        const turnRow = await this.#db.drain_next_turn_seq_for_loop.get<{ next: number }>({ loop_id: loopId });
        const turnSeq = turnRow?.next ?? 1;
        const workspaceRow = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: workerId });
        if (workspaceRow === undefined) throw new Error(`Engine.inject: worker ${workerId} not found`);
        // {§prompt-loop-containment} — the frame is the loop's NEXT prompt ordinal, never a turn
        // slot: rapid arrivals land as N and N+1, both contained, nothing superseded.
        const prefix = promptLoopPrefix(loopRow.sequence);
        const ordinalRow = await this.#db.drain_next_prompt_ordinal_for_loop.get<{ next: number }>({
            owner_id: workerId,
            pattern: `${prefix}%`,
            prefix_len: prefix.length });
        const pathname = promptPathname(loopRow.sequence, ordinalRow?.next ?? 2);
        const ctx: PlurnkSchemeContext = {
            db: this.#db, workspaceId: workspaceRow.workspace_id, workerId, functionalityWorkerId: workerId, loopId,
            turnId: 0,                   // no turn open at inject time; entries don't pin turnId
            writer: "_plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            weigh: this.#weighContent,
            pushNotice: (notice) => this.#notices.push(workspaceRow.workspace_id, workerId, loopId, notice) };
        const entry: EntryData = {
            channels: { body: { content: prompt, mimetype: "text/markdown" } },
            attributes: { openPaths, ...(source === undefined ? {} : { source }) } };
        await EntryCrud.writeEntry({ authority: "", pathname }, entry, ctx, "prompt", workerId);
        return { loopId, turnSeq };
    }

    //  — can this op open a wake edge mid-turn? The grounding scan for a
    // same-turn spawn-then-hibernate: an EXEC (stream conclusion / poll cadence wakes), a COPY to
    // worker:// (child-conclusion wake, {§worker-lifecycle-child-wake}), a directed SEND to worker:// (irc — the
    // addressee can act and conclude back), or an http READ (a web fetch streams into a subscription).
    // Conservative on purpose: a false PERMIT risks a dead park only in the spawn-failed corner; a
    // false REFUSE breaks legitimate hibernation.

    // A worker "holds a live thing" iff it has an open stream/spawn (subscription registry or an
    // exec spawn) OR a non-terminal child worker — the structured-concurrency invariant a terminal
    // SEND must respect ({§send-premature-terminate}, {§worker-loop-lifecycle}:
    // children and streams are the same kind of live thing a worker holds).

    async runLoop(...args: Parameters<LoopDriver["runLoop"]>): ReturnType<LoopDriver["runLoop"]> {
        return this.#loopDriver.runLoop(...args);
    }
}
