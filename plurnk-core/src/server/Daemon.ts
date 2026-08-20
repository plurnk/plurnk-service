// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the transport-free plugin-module seam ({§rpc}).

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Db } from "../core/Db.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import type { StreamEventPayload } from "../core/ChannelWrite.ts";
import Paths from "../Paths.ts";
import Engine from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { RuntimeDeclaration } from "@plurnk/plurnk-execs";
import type { Provider, ProviderAlias } from "@plurnk/plurnk-providers";
import { routeForSpec, specForRoute } from "./model-route.ts";
import { discoverDaemonModules } from "./module-discovery.ts";
import WorkerSettingsReader from "../core/worker-settings.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import QuestionTool, { questionRuntimeDecl } from "../schemes/QuestionTool.ts";
// {§notifications-envelope-carries-workspaceid}: "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped.
export type NotifyTarget = "all" | { workspaceId: number };
import DrainSupervisor, {
    type DrainInjectionArgs,
    type DrainInjectionResult,
    type TurnCeilingSelection,
} from "./DrainSupervisor.ts";
export type { DrainLoopResult } from "./DrainSupervisor.ts";
import {
    parsePath,
    Validator,
    type ClientDisplayCapabilities,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ClientEntryChannel,
    type EntryReadResult,
    type Notice,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
export type { ProposalProjection as PendingProposal } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type { LogEntryWire } from "./logEntry.ts";
import Envelope from "./envelope.ts";
import ClientInput from "./client-input.ts";
import type { ClientEnvelope } from "./envelope.ts";
import JournalTurn from "../core/JournalTurn.ts";
import LoopDocs from "./loopDocs.ts";
import SkillDocs from "./skillDocs.ts";
import GitMembership from "../core/git-membership.ts";
import Fork from "../core/fork.ts";
import WorkerName from "../core/WorkerName.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { contentWeight } from "../core/content-weight.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopAlias } from "./loop-model.ts";
import type { LoopFlags } from "../core/types.ts";
import LoopFlagsReader from "../core/LoopFlagsReader.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import BranchBatches from "./BranchBatches.ts";
import type {
    DaemonModule,
    ModuleActionContext,
    ModuleActionDescriptor,
    ModuleActionRegistration,
    ModuleSetupSeam,
    RuntimeRegistration,
    StartedModule,
    WorkspaceCapabilityProvider,
    WorkspaceCapabilityReplacement,
} from "./DaemonModule.ts";
import { observed, observedSync } from "../observe/spans.ts";

const clientActionFailure = (error: unknown): SchemeResult => {
    if (error instanceof OperationFailureError) return error.result;
    console.error("Client action failed outside its operation result contract:", error);
    return Results.failure(
        "daemon:client",
        "action-threw",
        500,
        "The client action failed outside its operation result contract.",
        {},
        {
            stage: "client-action",
            retryable: false,
        },
    );
};

const daemonFailure = (
    owner: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure(owner, code, status, detail, {}, extensions),
);

type ChannelRow = { name: string } & ClientEntryChannel;
const entryReadResult = (result: unknown): EntryReadResult =>
    Validator.assertEntryReadResult(result as EntryReadResult);

export default class Daemon {
    #db: Db;
    #engine: Engine;
    #workspaceGate: WorkspaceGate;
    #branchBatches: BranchBatches;
    #lifecycle: LoopLifecycle;
    #drains: DrainSupervisor;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    readonly #ownsMimetypes: boolean;
    #provider: Provider | null;
    #nodeModulesPath: string;
    #discoveryCwd: string;
    #started = false; // {§module-lifecycle}: one discovery/module boot; no listener
    #capabilitiesPublished = false;
    #modules: Array<DaemonModule<CoreSeam>> = [];
    #moduleClosers: StartedModule[] = [];
    #moduleActions = new Map<string, ModuleActionRegistration>();
    #workspaceCapabilityProviders = new Map<string, WorkspaceCapabilityProvider>();
    // {§methods-event-subscribe} — the broadcast's in-process event source. A transport
    // module (plurnk-agui) subscribes and fans out to its OWN clients; core emits, never owns
    // client transport or connection state.
    #eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();

    constructor({
        db, schemes, mimetypes, provider, nodeModulesPath,
    }: {
        db: Db;
        schemes?: SchemeRegistry;
        mimetypes?: Mimetypes;
        provider?: Provider | null;
        nodeModulesPath?: string;
    }) {
        this.#db = db;
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes ?? new SchemeRegistry();
        this.#provider = provider ?? null;
        // Plugin discovery resolves from the SERVICE's node_modules (its exec/scheme/mimetype
        // deps), NOT process.cwd() — else a globally-installed daemon started from a project dir
        // finds no plugins. The bin passes the package-relative path; cwd default holds for
        // in-repo tests. discover() takes a cwd and joins node_modules, so derive the parent.
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
        this.#discoveryCwd = dirname(this.#nodeModulesPath);
        // Mimetypes owns discovery + detection; default mimetype text/markdown. (Token counting
        // is NOT wired here — the engine's ruler below is {§tokenomics-agnostic-ruler}.)
        // Constructor ownership is the lifecycle boundary
        // ({§mimetype-owned-lifecycle}).
        this.#ownsMimetypes = mimetypes === undefined;
        this.#mimetypes = mimetypes ?? new Mimetypes({
            defaultMimetype: "text/markdown",
            discoverOptions: { cwd: this.#discoveryCwd },
        });
        const bootSpec = resolveActiveAlias();
        if (this.#provider !== null && bootSpec !== null) {
            ProviderInstantiate.registerInstance(this.#provider, bootSpec);
        }
        this.#workspaceGate = new WorkspaceGate(async (workerId, rootWorkerId) => {
            const row = await this.#db.branch_batch_worker_lineage.get<{ member: number }>({
                worker_id: workerId,
                root_worker_id: rootWorkerId,
            });
            return row !== undefined;
        });
        this.#branchBatches = new BranchBatches(db, this.#workspaceGate, {
            settleWorkspace: async (workspaceId) => this.#engine.drainWorkspaceDerivations(workspaceId),
            createChild: async ({ workspaceId, parentWorkerId, parentLoopId, op, name, prompt, flags, origin }) => {
                const parentPolicy = await this.#providerPolicyForLoop(parentLoopId);
                const providerSpec = parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
                const workerName = WorkerName.assert(name);
                const workerId = op === "FORK"
                    ? await Fork.fork(this.#db, parentWorkerId, workerName)
                    : (await this.#db.fork_insert_worker.get<{ id: number }>({
                        workspace_id: workspaceId,
                        name: workerName,
                        parent_worker_id: parentWorkerId,
                        origin,
                    }))?.id;
                if (workerId === undefined) throw new Error("Branch worker insert returned no row");
                // {§worker-model-selection} — lineage inheritance by value: the branch
                // child begins with the spawning loop's effective spawn model.
                await this.#db.worker_model_route_update.run({
                    id: workerId,
                    model_route_id: await routeForSpec(this.#db, providerSpec),
                    spawn_model_route_id: null,
                });
                const loopId = await this.#drains.enqueueFreshLoop({
                    workerId,
                    prompt,
                    providerSpec,
                    childProviderSpec: parentPolicy.childProviderSpec,
                    flags,
                });
                return { workerId, loopId };
            },
            startChild: async (workspaceId, workerId, loopId) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const started = await this.#drains.ensureDrain({ workspaceId, workerId, systemPrompt });
                if (started === null) throw new Error(`Branch worker ${workerId} already has a live drain`);
                const result = await started.firstLoopPromise;
                if (result.loopId !== loopId) {
                    throw new Error(`Branch worker ${workerId} drained loop ${result.loopId}, expected ${loopId}`);
                }
                return result.result;
            },
            wakeParent: async (workspaceId, workerId) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                await this.#drains.settleCompletionWake(workspaceId, workerId, systemPrompt, false);
            },
            notify: (workspaceId, payload) => {
                this.#broadcast({ workspaceId }, "workspace/branch-batch", payload);
            },
        });
        this.#engine = new Engine({
            db, schemes: this.#schemes, mimetypes: this.#mimetypes,
            // {§tokenomics-agnostic-ruler} — stored and catalog curation weights
            // are workspace-wide across concurrent models, so they remain
            // model-independent. Request-shaped token facts stay provider-owned.
            weigh: contentWeight,
            streamEventNotify: (workspaceId, event) => this.notifyStreamEvent(workspaceId, event),
            wakeWorkerNotify: (payload) => this.#drains.notifyWakeWorker(payload),
            // worker:// loop-start primitive — spawn/fork/irc deliver through
            // Daemon.inject (active sister → fold; idle → enqueue + drain). The
            // daemon owns provider + the law-file system prompt; the worker scheme
            // handler carries neither. Fire-and-forget: the returned drain runs
            // independently (the sister is its own worker). {§machine-processes}
            injectWorker: async ({ workspaceId, workerId, prompt, flags, parentLoopId }) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const parentPolicy = parentLoopId === undefined
                    ? null
                    : await this.#providerPolicyForLoop(parentLoopId);
                const providerSpec = parentPolicy === null
                    ? resolveActiveAlias()
                    : parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
                if (providerSpec === null) throw new Error("injectWorker: active provider has no resolvable alias");
                // {§worker-model-selection} — lineage inheritance by value: the child worker
                // begins with the spawning loop's effective spawn model, no inherited override.
                await this.#db.worker_model_route_update.run({
                    id: workerId,
                    model_route_id: await routeForSpec(this.#db, providerSpec),
                    spawn_model_route_id: null,
                });
                const { action, loopId } = await this.inject({
                    workspaceId,
                    workerId,
                    prompt,
                    providerSpec,
                    ...(parentPolicy === null ? {} : { childProviderSpec: parentPolicy.childProviderSpec }),
                    systemPrompt,
                    ...(flags === undefined ? {} : { flags }),
                });
                return { action, loopId };
            },
            branchWorker: async (args) => this.#branchBatches.enqueue(args),
            branchCompletionGate: async (workerId) => this.#branchBatches.completionGate(workerId),
            acquireWorkspaceTurn: async (workspaceId, workerId) => this.#workspaceGate.acquireTurn(workspaceId, workerId),
            workspaceTurnCompleted: async ({ workspaceId, turnId }) => {
                await this.#branchBatches.sealTurn(turnId);
                // {§skills-materialization} — EXEC[skills] mutations become
                // discoverable on the following turn.
                await SkillDocs.refreshIfChanged(this.#engine, this.#db, workspaceId);
            },
            // worker:// KILL (terminate) — cancel the addressed worker subtree and
            // tear down its held streams before the operation completes.
            cancelWorker: async (workerId, reason) => this.#drains.cancelWorkerTree(workerId, reason),
            cancelDescendants: async (workerId, reason) => this.#drains.cancelDescendants(workerId, reason),
            noticeNotify: (workspaceId, payload) => this.notifyNotice(workspaceId, payload),
        });
        this.#drains = new DrainSupervisor({
            db,
            lifecycle: this.#lifecycle,
            injectPrompt: (workerId, prompt, openPaths) => this.#engine.inject(workerId, prompt, openPaths),
            assertInjectionCompatibility: async ({
                workerId,
                loopId,
                providerSpec,
                providerSpecExplicit,
                childProviderSpec,
                turnCeiling,
                flags,
            }) => {
                await this.#assertFoldPosture(workerId, flags, loopId);
                // An omitted selector keeps the loop's durable provider; only an
                // explicit selection is checked against it (a deliberate switch).
                if (providerSpecExplicit !== false) {
                    await this.#assertLoopProvider(loopId, providerSpec);
                }
                if (childProviderSpec !== undefined) {
                    await this.#assertLoopChildProvider(loopId, childProviderSpec);
                }
                await this.#assertLoopMaxTurns(
                    loopId,
                    turnCeiling?.source === "explicit" ? turnCeiling.effective : undefined,
                );
            },
            reconcilePrompts: (workerId, endedLoopId) => this.#reconcileOrphanedPrompts(workerId, endedLoopId),
            runLoop: async ({
                workspaceId,
                workerId,
                loopId,
                maxTurns,
                prompt,
                systemPrompt,
                signal,
                onDispatch,
            }) => {
                const { provider, childProvider } = await this.#providersForLoop(loopId);
                return this.#engine.runLoop({
                    provider,
                    childProvider,
                    workspaceId,
                    workerId,
                    loopId,
                    maxTurns,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt },
                    ],
                    origin: "model",
                    signal,
                    onDispatch,
                });
            },
            loopUsage: (loopId) => this.#engine.loopUsage(loopId),
            loopAttributions: (loopId) => this.#engine.loopAttributions(loopId),
            takeParkDeadline: (loopId) => {
                const deadline = this.#engine.parkDeadlines.get(loopId);
                this.#engine.parkDeadlines.delete(loopId);
                return deadline;
            },
            cancelSubscription: (subscriptionId) => this.#engine.cancelSubscription(subscriptionId),
            hasActiveStreams: (workerId) => this.#workerHasActiveStreams(workerId),
            readSystemPrompt: () => readFile(Paths.instructionsSystem, "utf8"),
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            },
            emit: (workspaceId, method, params) => this.#broadcast({ workspaceId }, method, params),
        });
        // Wire proposal-pending events to the loop/proposal WS notification.
        // Sessionid scopes the broadcast to clients on the same workspace.
        this.#engine.onProposalPending((event) => {
            const { workspaceId, ...proposal } = event;
            this.#broadcast({ workspaceId }, "loop/proposal", proposal);
        });
        this.#engine.onClientInteractionPending((event) => {
            const { workspaceId, ...interaction } = event;
            this.#broadcast({ workspaceId }, "loop/interaction", interaction);
        });
    }


    // {§methods-event-subscribe}. A transport module subscribes to the daemon's in-process
    // event source: it receives every workspace-scoped engine event as `(workspaceId, method, params)`
    // and fans out to its OWN clients — core emits, it never fans out for the module. Returns an
    // unsubscribe. `workspaceId` is the event's workspace, or null for a global event (e.g. workspace/created).
    // The engine and its events are core; the fan-out belongs to the module.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void {
        this.#eventSubscribers.add(handler);
        return () => { this.#eventSubscribers.delete(handler); };
    }

    // {§methods-proposal-resolve} — proposal HITL. A transport module reads the stopped-world
    // proposals for a workspace (rendering each as a TOOL_CALL) and feeds back the human's decision. The
    // gate, validation, and applyResolution stay core (Engine.resolveProposal); the seam is the read +
    // the resolve, never the mechanism. `resolveProposal` throws for an unknown/already-resolved id.
    async pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        const checkedWorkspaceId = ClientInput.assertId("pendingProposals", "workspaceId", workspaceId);
        return this.#engine.pendingProposals(checkedWorkspaceId);
    }

    resolveProposal(logEntryId: number, resolution: Omit<ProposalResolution, "result">): void {
        const checkedLogEntryId = ClientInput.assertId("resolveProposal", "logEntryId", logEntryId);
        const checkedResolution = ClientInput.assertProposalResolution("resolveProposal", resolution);
        this.#engine.resolveProposal(checkedLogEntryId, checkedResolution);
    }

    async pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]> {
        const checkedWorkspaceId = ClientInput.assertId(
            "pendingClientInteractions",
            "workspaceId",
            workspaceId,
        );
        return this.#engine.pendingClientInteractions(checkedWorkspaceId);
    }

    async resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
    ): Promise<void> {
        const checkedInteractionId = ClientInput.assertId(
            "resolveClientInteraction",
            "interactionId",
            interactionId,
        );
        const checkedResolution = ClientInput.assertClientInteractionResolution(
            "resolveClientInteraction",
            resolution,
        );
        await this.#engine.resolveClientInteraction(checkedInteractionId, checkedResolution);
    }

    // {§methods-loop-run} — drive/steer a loop. The module supplies only workspace/worker/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: Partial<LoopFlags>; openPaths?: string[]; alias?: string; model?: string; childAlias?: string | null; childModel?: string }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        const workspaceId = ClientInput.assertId("runLoop", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("runLoop", "workerId", args.workerId);
        const prompt = ClientInput.assertPrompt("runLoop", args.prompt);
        const requestedMaxTurns = ClientInput.assertMaxTurns("runLoop", args.maxTurns);
        const openPaths = ClientInput.assertOpenPaths("runLoop", args.openPaths);
        const alias = ClientInput.assertOptionalSelector("runLoop", "alias", args.alias);
        const model = ClientInput.assertOptionalSelector("runLoop", "model", args.model);
        const childAlias = ClientInput.assertOptionalChildAlias("runLoop", args.childAlias);
        const childModel = ClientInput.assertOptionalSelector("runLoop", "childModel", args.childModel);
        if (childAlias === null && childModel !== undefined) {
            throw daemonFailure(
                "daemon:input",
                "child-provider-conflict",
                400,
                "childModel cannot accompany an inherited child provider policy.",
                { field: "childModel", recovery: "Omit childModel or select a child alias.", retryable: false },
            );
        }
        const flags = ClientInput.normalizeLoopFlags("runLoop", args.flags) as Partial<LoopFlags> | undefined;
        // {§worker-model-selection} — the worker owns the model. An explicit selector
        // persists onto the worker; an omitted selector resolves the worker's durable model
        // (seeded once from the daemon default). The loop then snapshots the resolved route.
        // A continuation's omitted selector must still keep the loop's durable provider.
        const selectorExplicit = alias !== undefined || model !== undefined;
        const selection = await this.#resolveWorkerModel(workerId, alias, model);
        if (selection === null) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "not-configured",
                501,
                "No provider is configured for this worker.",
                {},
                {
                    stage: "provider-selection",
                    recovery: "Select a configured model provider.",
                    retryable: false,
                },
            ));
        }
        // {§methods-loop-run-child-provider} — the worker's persistent spawn override.
        const childSelection = await this.#resolveWorkerSpawnModel(workerId, childAlias, childModel);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        // {§machine-processes} — the model NEVER runs in a client-origin worker (its packets would carry
        // client-action rows). The module resolves the model worker via ensureModelWorker and passes it (or a
        // fork); a client worker here is a caller error, refused loudly rather than silently rehomed.
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number; origin: string }>({ id: workerId });
        if (target === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (target.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: target.workspace_id,
                    retryable: false,
                },
            );
        }
        if (target.origin === "client") {
            throw daemonFailure(
                "daemon:worker",
                "model-worker-required",
                409,
                `Worker ${workerId} is not a model worker.`,
                {
                    workerId,
                    recovery: "Select or create a model worker for this loop.",
                    retryable: false,
                },
            );
        }
        // {§operator-config-max-turns-ceiling} — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "-1");
        const requested = requestedMaxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const turnCeiling: TurnCeilingSelection = {
            effective: maxTurns,
            source: requestedMaxTurns === undefined ? "implicit" : "explicit",
        };
        const { action, loopId, turnSeq } = await this.inject({
            workspaceId,
            workerId,
            prompt,
            ...(flags !== undefined ? { flags } : {}),
            ...(openPaths !== undefined ? { openPaths } : {}),
            turnCeiling,
            providerSpec: selection,
            providerSpecExplicit: selectorExplicit,
            childProviderSpec: childSelection,
            systemPrompt,
        });
        return { status: 100, action, loopId, ...(turnSeq !== undefined ? { turnSeq } : {}) };
    }

    // {§methods-loop-run-model} — resolve a per-loop model override to a cached Provider. `model`
    // (<provider>/<model>, client-resolved) wins over a named `alias`; absent both, the
    // boot default. A named alias missing from the env cascade, or a malformed model spec, throws
    // legibly rather than silently running the wrong model.
    async #resolveLoopProvider(alias: string | undefined, model: string | undefined): Promise<ProviderAlias | null> {
        const requested = resolveLoopAlias(alias, model, parseAliasesFromEnv());
        if (requested === null && this.#provider === null) return null;
        const spec = requested ?? resolveActiveAlias();
        if (spec === null) {
            throw daemonFailure(
                "daemon:provider",
                "active-alias-unresolved",
                500,
                "The active provider has no resolvable alias.",
                { stage: "provider-selection", retryable: false },
            );
        }
        // Resolve eagerly so runLoop fails before enqueue when the provider
        // cannot be constructed. The drain later retrieves this cached handle
        // from the loop's durable spec at the claim boundary.
        try {
            await ProviderInstantiate.instantiateProvider(spec);
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            console.error(`Provider alias '${spec.alias}' could not be instantiated:`, cause);
            throw daemonFailure(
                "daemon:provider",
                "provider-unavailable",
                503,
                `Provider alias '${spec.alias}' is unavailable.`,
                {
                    alias: spec.alias,
                    provider: spec.provider,
                    model: spec.model,
                    stage: "provider-selection",
                    retryable: false,
                },
            );
        }
        return spec;
    }

    // {§worker-model-selection} — a model worker owns one durable model. An explicit
    // selector persists onto the worker; an omitted selector resolves the worker's
    // durable model, seeded once from the daemon default. A deliberately modelless
    // daemon leaves the worker unset until an explicit selection arrives.
    async #resolveWorkerModel(workerId: number, alias: string | undefined, model: string | undefined): Promise<ProviderAlias | null> {
        const worker = await this.#db.worker_model_route_read.get<{ model_route_id: number | null; spawn_model_route_id: number | null }>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        if (alias !== undefined || model !== undefined) {
            const spec = await this.#resolveLoopProvider(alias, model);
            await this.#db.worker_model_route_update.run({
                id: workerId,
                model_route_id: spec === null ? null : await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
            });
            return spec;
        }
        if (worker.model_route_id !== null) return specForRoute(this.#db, worker.model_route_id);
        if (this.#provider === null) return null;
        const spec = resolveActiveAlias();
        if (spec !== null) {
            await this.#db.worker_model_route_update.run({
                id: workerId,
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
            });
        }
        return spec;
    }

    // {§worker-model-selection} — the persistent spawn override. An explicit child
    // selector persists onto the worker (null clears it back to inherit); an omitted
    // selector resolves the persisted override, seeded once from the operator's
    // PLURNK_MODEL_CHILD default.
    async #resolveWorkerSpawnModel(workerId: number, childAlias: string | null | undefined, childModel: string | undefined): Promise<ProviderAlias | null> {
        const worker = await this.#db.worker_model_route_read.get<{ model_route_id: number | null; spawn_model_route_id: number | null }>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        if (childAlias !== undefined || childModel !== undefined) {
            const spec = childAlias === null && childModel === undefined
                ? null
                : await this.#resolveLoopProvider(childAlias ?? undefined, childModel);
            await this.#db.worker_model_route_update.run({
                id: workerId,
                model_route_id: worker.model_route_id,
                spawn_model_route_id: spec === null ? null : await routeForSpec(this.#db, spec),
            });
            return spec;
        }
        if (worker.spawn_model_route_id !== null) return specForRoute(this.#db, worker.spawn_model_route_id);
        const configured = process.env.PLURNK_MODEL_CHILD;
        if (configured === undefined || configured.length === 0) return null;
        const spec = await this.#resolveLoopProvider(configured, undefined);
        if (spec !== null) {
            await this.#db.worker_model_route_update.run({
                id: workerId,
                model_route_id: worker.model_route_id,
                spawn_model_route_id: await routeForSpec(this.#db, spec),
            });
        }
        return spec;
    }

    // {§worker-model-selection} — the loop's durable snapshot is the immutable route ids,
    // resolved through model_routes at the claim boundary; never re-resolved through the
    // alias cascade (a changed alias declaration must not rewrite history).
    async #providerPolicyForLoop(loopId: number): Promise<{ providerSpec: ProviderAlias; childProviderSpec: ProviderAlias | null }> {
        const row = await this.#db.drain_loop_route_ids.get<{ model_route_id: number | null; spawn_model_route_id: number | null }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId}: provider selection row is missing`);
        const providerSpec = await specForRoute(this.#db, row.model_route_id);
        if (providerSpec === null) {
            throw new Error(`loop ${loopId}: persisted provider selection is missing — refusing boot-default substitution`);
        }
        return {
            providerSpec,
            childProviderSpec: await specForRoute(this.#db, row.spawn_model_route_id),
        };
    }

    async #providerSpecForLoop(loopId: number): Promise<ProviderAlias> {
        return (await this.#providerPolicyForLoop(loopId)).providerSpec;
    }

    async #providersForLoop(loopId: number): Promise<{ provider: Provider; childProvider: Provider }> {
        const policy = await this.#providerPolicyForLoop(loopId);
        const provider = await ProviderInstantiate.instantiateProvider(policy.providerSpec);
        const childProvider = policy.childProviderSpec === null
            ? provider
            : await ProviderInstantiate.instantiateProvider(policy.childProviderSpec);
        return { provider, childProvider };
    }

    async #assertLoopProvider(loopId: number, requested: ProviderAlias): Promise<void> {
        const selected = await this.#providerSpecForLoop(loopId);
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-provider-conflict",
                409,
                `Loop ${loopId} uses provider alias '${selected.alias}', not '${requested.alias}'.`,
                {
                    loopId,
                    selectedAlias: selected.alias,
                    selectedModel: `${selected.provider}/${selected.model}`,
                    requestedAlias: requested.alias,
                    requestedModel: `${requested.provider}/${requested.model}`,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another provider.",
                    retryable: false,
                },
            );
        }
    }

    async #assertLoopChildProvider(loopId: number, requested: ProviderAlias | null): Promise<void> {
        const selected = (await this.#providerPolicyForLoop(loopId)).childProviderSpec;
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-child-provider-conflict",
                409,
                `Loop ${loopId} already has a different child provider policy.`,
                {
                    loopId,
                    selectedChildAlias: selected?.alias ?? null,
                    requestedChildAlias: requested?.alias ?? null,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before changing its child provider policy.",
                    retryable: false,
                },
            );
        }
    }

    async #assertLoopMaxTurns(loopId: number, requested: number | undefined): Promise<void> {
        if (requested === undefined) return;
        const durable = await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId });
        if (durable === undefined) throw new Error(`inject: loop ${loopId} has no durable turn ceiling`);
        if (durable.max_turns !== requested) {
            throw daemonFailure(
                "daemon:loop",
                "turn-ceiling-conflict",
                409,
                `Loop ${loopId} has turn ceiling ${durable.max_turns}, not ${requested}.`,
                {
                    loopId,
                    selectedMaximumTurns: durable.max_turns,
                    requestedMaximumTurns: requested,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another turn ceiling.",
                    retryable: false,
                },
            );
        }
    }

    // {§methods-model-worker} — the workspace's model worker (created on first use), distinct from the client
    // worker so the model's packets never carry client-action rows. The module binds its threads to this.
    // Optional worker settings ({§worker-settings}) ride the client's per-run declaration: merged in on
    // creation AND on every subsequent ensure, so a client can change its mind between loops.
    async ensureModelWorker(workspaceId: number, settings?: { requestUserInput?: boolean }): Promise<number> {
        const checked = ClientInput.assertId("worker.ensure-model", "workspaceId", workspaceId);
        const created = await Envelope.ensureModelWorker(this.#db, checked);
        if (settings !== undefined) await this.#mergeWorkerSettings(created, settings);
        return created;
    }

    // {§worker-settings} — merge known keys into the worker's behavioral-rules bag.
    // Validated at the boundary; unprovided keys keep their durable value.
    async #mergeWorkerSettings(workerId: number, settings: { requestUserInput?: boolean }): Promise<void> {
        const current = await WorkerSettingsReader.read(this.#db, workerId);
        const merged = {
            requestUserInput: settings.requestUserInput ?? current.requestUserInput,
        };
        await this.#db.worker_settings_update.run({ id: workerId, settings: JSON.stringify(merged) });
    }

    // {§worker-settings} — project the worker's behavioral rules for a client-interface surface.
    async readWorkerSettings(args: { workspaceId: number; workerId: number }): Promise<{ requestUserInput: boolean }> {
        const workspaceId = ClientInput.assertId("worker.settings.get", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.settings.get", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        const settings = await WorkerSettingsReader.read(this.#db, workerId);
        return { requestUserInput: settings.requestUserInput };
    }

    // {§worker-settings} — persist known behavioral-rule keys; unknown keys are
    // rejected at the input boundary, never persisted.
    async setWorkerSettings(args: { workspaceId: number; workerId: number; settings: { requestUserInput?: boolean } }): Promise<{ requestUserInput: boolean }> {
        const workspaceId = ClientInput.assertId("worker.settings.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.settings.set", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        ClientInput.parseWorkerSettings(args.settings);
        await this.#mergeWorkerSettings(workerId, args.settings);
        const settings = await WorkerSettingsReader.read(this.#db, workerId);
        return { requestUserInput: settings.requestUserInput };
    }

    // {§worker-model-selection} — project a worker's durable model and spawn override
    // for a client-interface get/set surface. Ownership is checked at this boundary.
    async readWorkerModel(args: { workspaceId: number; workerId: number }): Promise<{ model: ProviderAlias | null; spawnModel: ProviderAlias | null }> {
        const workspaceId = ClientInput.assertId("worker.model.get", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.model.get", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        const row = await this.#db.worker_model_route_read.get<{ model_route_id: number | null; spawn_model_route_id: number | null }>({ id: workerId });
        if (row === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        return {
            model: await specForRoute(this.#db, row.model_route_id),
            spawnModel: await specForRoute(this.#db, row.spawn_model_route_id),
        };
    }

    // {§worker-model-selection} — persist an explicit model selection onto the worker
    // and return the resolved spec. An unresolvable selector fails loud here.
    async setWorkerModel(args: { workspaceId: number; workerId: number; alias?: string; model?: string }): Promise<ProviderAlias> {
        const workspaceId = ClientInput.assertId("worker.model.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.model.set", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        await this.#assertWorkerSelectable(workerId);
        const spec = await this.#resolveWorkerModel(workerId, args.alias, args.model);
        if (spec === null) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "not-configured",
                501,
                "No provider is configured for this worker.",
                {},
                { stage: "provider-selection", recovery: "Select a configured model provider.", retryable: false },
            ));
        }
        return spec;
    }

    // {§worker-model-selection} — persist the worker's spawn override; `alias: null`
    // with no model means inherit (clears the override).
    async setWorkerSpawnModel(args: { workspaceId: number; workerId: number; alias?: string | null; model?: string }): Promise<ProviderAlias | null> {
        const workspaceId = ClientInput.assertId("worker.child.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.child.set", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        await this.#assertWorkerSelectable(workerId);
        return this.#resolveWorkerSpawnModel(workerId, args.alias, args.model);
    }

    // {§worker-model-selection} — a selection must not mutate underneath active
    // work: a live or parked loop is a precise 409, never a silent retroactive
    // switch of the immutable loop snapshot.
    async #assertWorkerSelectable(workerId: number): Promise<void> {
        if (await this.#drains.hasLiveWork(workerId)) {
            throw daemonFailure(
                "daemon:worker",
                "worker-loop-active",
                409,
                `Worker ${workerId} has a live or parked loop; select a model after concluding or cancelling it.`,
                {
                    workerId,
                    stage: "model-selection",
                    recovery: "Conclude or cancel the active loop before selecting a model.",
                    retryable: false,
                },
            );
        }
    }

    async #assertWorkerOwned(workspaceId: number, workerId: number): Promise<void> {
        const owner = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (owner === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (owner.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                { workerId, workspaceId, actualWorkspaceId: owner.workspace_id },
            );
        }
    }

    // {§methods-op-mirror} — execute parsed ops on behalf of a client, journaled as a
    // client-origin turn (the log is core's, a client op is a first-class citizen), dispatched through
    // the engine, then emitted as log/entry on the event source. One seam op backs the whole op_*
    // family (read/edit/copy/find/fold/look/move/open/send/exec); the module parses at its edge with the
    // grammar package and hands over the statement, then fans the emitted entry out to its own clients.
    async dispatchAsClient(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const workspaceId = ClientInput.assertId("operation.dispatch", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.dispatch", "workerId", args.workerId);
        const { statement } = args;
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const result = await this.#dispatchClientStatement({ workspaceId, workerId, loopId: clientLoopId, statement });
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return result;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        }
    }

    // The client-interface action contract: one AG-UI action owns one journal segment,
    // regardless of how many statements op.parse produced. A proposed statement may
    // keep this promise (and segment) open across interrupt/resume; settlement closes
    // it. The journal is durable evidence for the action, not a second client lifecycle.
    async dispatchClientAction(args: { workspaceId: number; workerId: number; statements: PlurnkStatement[] }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        const workspaceId = ClientInput.assertId("operation.dispatch-batch", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.dispatch-batch", "workerId", args.workerId);
        const { statements } = args;
        if (statements.length === 0) return [];
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const results = [];
            for (const statement of statements) {
                results.push(await this.#dispatchClientStatement({ workspaceId, workerId, loopId: clientLoopId, statement }));
            }
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return results;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        }
    }

    async #dispatchClientStatement(args: { workspaceId: number; workerId: number; loopId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, workerId, loopId, statement } = args;
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        try {
            const { id: turnId } = await JournalTurn.insert(this.#db, loopId);
            const entryIds: number[] = [];
            const result = await this.#engine.dispatch({
                statement, workspaceId, workerId, loopId, turnId, sequence: 1,
                origin: "client", onDispatch: (logEntryId: number) => { entryIds.push(logEntryId); },
            });
            await this.#branchBatches.sealTurn(turnId);
            for (const logEntryId of entryIds) {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            }
            return result as { status: number; [key: string]: unknown };
        } finally {
            release();
        }
    }

    // {§op-look} — the pure READ-projection query on the seam: resolve a READ through the
    // full scheme resolver and return its content, writing NO log row — the client's out-of-band
    // inspection primitive (the module rewrites LOOK→READ and parses at its edge, exactly like
    // dispatchClientAction). Its closed observation segment supplies the numeric loop coordinate
    // required by plugin context and relative log:/// addresses without impersonating an active
    // client lifecycle. It creates no turn or log row. Engine.look enforces READ-only.
    async look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const workspaceId = ClientInput.assertId("operation.look", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.look", "workerId", args.workerId);
        const { statement } = args;
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const result = await this.#engine.look({ statement, workspaceId, workerId, loopId: clientLoopId }) as { status: number; [key: string]: unknown };
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return result;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        } finally {
            release();
        }
    }

    // {§methods-log-read} — a workspace's journal, the module's primary render input. The worker is
    // ownership-verified against the workspace (a workspace reads only its own workers — the model worker included,
    // {§methods-log-coordinate}); entries filter by loop/turn/since-id or the full L/T/S display coordinate. Core owns the
    // journal + the invariant; the module shapes the entries into AG-UI messages at its edge.
    async readLog(args: {
        workspaceId: number; workerId: number;
        loopId?: number; turnId?: number; sinceId?: number; limit?: number;
        loopSeq?: number; turnSeq?: number; sequence?: number;
    }): Promise<LogEntryWire[]> {
        const workspaceId = ClientInput.assertId("log.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("log.read", "workerId", args.workerId);
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (target === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (target.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: target.workspace_id,
                    retryable: false,
                },
            );
        }
        const coordinateFields = {
            loopId: args.loopId,
            turnId: args.turnId,
            sinceId: args.sinceId,
            loopSeq: args.loopSeq,
            turnSeq: args.turnSeq,
            sequence: args.sequence,
        };
        for (const [field, value] of Object.entries(coordinateFields)) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw daemonFailure(
                    "daemon:log",
                    "coordinate-invalid",
                    400,
                    `Log coordinate field '${field}' is not a non-negative safe integer.`,
                    {
                        field,
                        value,
                        stage: "log-read",
                        recovery: "Use a non-negative integer coordinate.",
                        retryable: false,
                    },
                );
            }
        }
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
            throw daemonFailure(
                "daemon:log",
                "limit-invalid",
                400,
                `Log limit ${args.limit} is not a positive safe integer.`,
                {
                    field: "limit",
                    value: args.limit,
                    stage: "log-read",
                    recovery: "Use a positive integer log limit.",
                    retryable: false,
                },
            );
        }
        const rows = await this.#db.log_read_recent_ids.all<{ id: number }>({
            worker_id: workerId,
            loop_id: args.loopId ?? null, turn_id: args.turnId ?? null, since_id: args.sinceId ?? null,
            loop_seq: args.loopSeq ?? null, turn_seq: args.turnSeq ?? null, sequence: args.sequence ?? null,
            limit: Math.min(args.limit ?? 100, 1000),
        });
        const entries: LogEntryWire[] = [];
        for (const r of rows) entries.push(await LogEntry.fetchLogEntry(this.#db, r.id));
        return entries;
    }

    // {§methods} — the module's render surface beyond the journal. Thin delegations
    // into core's envelope / membership / provider machinery; the module fans the results into its own views.
    listProviders(): { aliases: Array<{ alias: string; provider: string; model: string; active: boolean; inputCapacity: number | null }> } {
        const active = resolveActiveAlias();
        return {
            aliases: parseAliasesFromEnv().map((a) => {
                const isActive = active !== null && active.alias === a.alias;
                return {
                    alias: a.alias, provider: a.provider, model: a.model, active: isActive,
                    inputCapacity: isActive && this.#provider !== null ? this.#provider.inputCapacity : null,
                };
            }),
        };
    }

    // {§client-display-capabilities} Core composes the installed family
    // declarations; interface modules expose this contracts-owned wire without
    // inventing presentation policy. `exec` is operation machinery, not an
    // addressable URI scheme; its runtime-tag scheme faces remain discoverable.
    async listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities> {
        const schemes: ClientDisplayCapabilities = this.#schemes.list()
            .filter((scheme) => scheme !== "exec")
            .map((scheme) => {
                const glyph = this.#schemes.manifestFor(scheme)?.glyph;
                return {
                    kind: "scheme" as const,
                    scheme,
                    display: glyph === undefined ? {} : { glyph },
                };
            });
        const mimetypes: ClientDisplayCapabilities = (await this.#mimetypes.displayMetadata())
            .map(({ mimetype, glyph }) => ({
                kind: "mimetype" as const,
                mimetype,
                display: glyph.length === 0 ? {} : { glyph },
            }));
        return Validator.assertClientDisplayCapabilities([...schemes, ...mimetypes]);
    }

    listWorkspaces() { return Envelope.listWorkspaces(this.#db); }
    listWorkers(workspaceId: number) {
        return Envelope.listWorkersForWorkspace(
            this.#db,
            ClientInput.assertId("workspace.workers", "workspaceId", workspaceId),
        );
    }
    // {§methods-workspace-prompts}: root-conversation loop seeds, newest-first.
    listPrompts(workspaceId: number, limit?: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.prompts", "workspaceId", workspaceId);
        const checkedLimit = ClientInput.assertLimit("workspace.prompts", limit);
        return Envelope.listPromptsForWorkspace(this.#db, checkedWorkspaceId, checkedLimit ?? 100);
    }
    async listMembers(workspaceId: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.members", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            return await GitMembership.resolveMembershipEffects(this.#db, checkedWorkspaceId, undefined);
        } finally {
            release();
        }
    }
    listConstraints(workspaceId: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.constraints", "workspaceId", workspaceId);
        return this.#db.crud_list_workspace_constraints.all<{ effect: string; glob: string }>({ workspace_id: checkedWorkspaceId });
    }
    workspaceDerivationStatus(workspaceId: number) {
        return this.#engine.workspaceDerivationStatus(
            ClientInput.assertId("workspace.derivation", "workspaceId", workspaceId),
        );
    }

    // {§methods-workspace-create}: the module owns protocol decoding; core validates the typed seam
    // inputs and owns the envelope, its reserved-name + name-uniqueness invariants,
    // membership resolution, warmWorkspaceDerivations, and the workspace/created emit. No connection state
    // (which client is on which workspace) lives here — that's the module's.
    async createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object; constraints?: Array<{ effect: string; glob: string }> }): Promise<ClientEnvelope> {
        // The seam fails hard on malformed semantic input so every module inherits one wall:
        // the settings bag
        // ({§operator-config-workspace-settings}),
        // constraints, and absolute projectRoot.
        const name = ClientInput.assertOptionalName("workspace.create", "name", args.name);
        const projectRoot = ClientInput.assertProjectRoot("workspace.create", args.projectRoot);
        const settings = ClientInput.parseSettings(args.settings);
        const constraints = ClientInput.parseConstraints(args.constraints);
        return observed( // {§observability-boundary}
            "workspace.create",
            {},
            async (span) => {
                const envelope = await Envelope.createClientEnvelope(this.#db, { name, projectRoot, settings });
                span.setAttribute("workspace.id", envelope.workspaceId);
                for (const { effect, glob } of constraints) {
                    await this.#db.crud_insert_workspace_constraint.run({ workspace_id: envelope.workspaceId, effect, glob });
                }
                if (constraints.length > 0) await GitMembership.resolveGitMembership(this.#db, envelope.workspaceId, undefined);
                for (const provider of this.#workspaceCapabilityProviders.values()) {
                    await provider.hydrate(envelope.workspaceId);
                }
                await LoopDocs.materialize(this.#engine, this.#db, envelope.workspaceId);
                await SkillDocs.materialize(this.#engine, this.#db, envelope.workspaceId);
                void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
                this.#broadcast("all", "workspace/created", { id: envelope.workspaceId, name: envelope.workspaceName, projectRoot: envelope.projectRoot });
                return envelope;
            },
        );
    }

    async attachWorkspace(args: { workspaceId: number; workerId?: number; workerName?: string }): Promise<ClientEnvelope> {
        // attachToWorkspace owns the reserved-name + worker-ownership invariants; the seam just delegates + warms.
        const workspaceId = ClientInput.assertId("workspace.attach", "workspaceId", args.workspaceId);
        const workerId = args.workerId === undefined
            ? undefined
            : ClientInput.assertId("workspace.attach", "workerId", args.workerId);
        const workerName = ClientInput.assertOptionalWorkerName("workspace.attach", "workerName", args.workerName);
        const envelope = await Envelope.attachToWorkspace(this.#db, workspaceId, { workerId, workerName });
        void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
        return envelope;
    }

    async renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.rename", "workspaceId", workspaceId);
        const checkedName = ClientInput.assertOptionalName("workspace.rename", "name", name);
        if (checkedName === undefined) throw new Error("ClientInput.assertOptionalName accepted a required name as undefined");
        return { id: checkedWorkspaceId, name: await Envelope.updateWorkspaceName(this.#db, checkedWorkspaceId, checkedName) };
    }

    async constrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.constrain", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.constrain", effect, glob);
            await this.#db.crud_insert_workspace_constraint.run({ workspace_id: checkedWorkspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, checkedWorkspaceId, undefined);
            // Members may have just landed — begin warming now, but return the constraint response
            // immediately so prompts do not wait for the complete derivation corpus.
            void this.#engine.warmWorkspaceDerivations(checkedWorkspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    async unconstrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.unconstrain", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.unconstrain", effect, glob);
            await this.#db.crud_delete_workspace_constraint.run({ workspace_id: checkedWorkspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, checkedWorkspaceId, undefined);
            void this.#engine.warmWorkspaceDerivations(checkedWorkspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    // Contracts {§entry-read-result}: resolve through the scheme's address law,
    // then project one owner-scoped entry without exposing persistence columns.
    async readEntry(args: {
        workspaceId: number;
        workerId: number;
        target: string;
        channel?: string;
        offset?: number;
    }): Promise<EntryReadResult> {
        const workspaceId = ClientInput.assertId("entry.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("entry.read", "workerId", args.workerId);
        if (typeof args.target !== "string" || args.target.length === 0) {
            throw daemonFailure(
                "daemon:input",
                "target-invalid",
                400,
                "target is not a non-empty string.",
                {
                    context: "entry.read",
                    field: "target",
                    stage: "input-validation",
                    recovery: "Provide an entry URI.",
                    retryable: false,
                },
            );
        }
        const channel = ClientInput.assertOptionalChannel("entry.read", args.channel);
        const worker = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (worker === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (worker.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: worker.workspace_id,
                    retryable: false,
                },
            );
        }
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        try {
            let parsed;
            try {
                parsed = parsePath(args.target);
            } catch {
                parsed = null;
            }
            if (parsed === null || parsed.kind !== "url") {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "target-invalid",
                    400,
                    `The entry target '${args.target}' is not URL-shaped.`,
                    { entry: null },
                    {
                        target: args.target,
                        stage: "entry-read",
                        recovery: "Use a scheme://path target.",
                        retryable: false,
                    },
                ));
            }
            if (args.offset !== undefined && channel === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-channel-required",
                    400,
                    "An entry offset requires a channel.",
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Select the channel to read from the offset.",
                        retryable: false,
                    },
                ));
            }
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-invalid",
                    400,
                    `Entry offset ${args.offset} is not a non-negative safe integer.`,
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Use a non-negative integer offset.",
                        retryable: false,
                    },
                ));
            }
            if (parsed.username !== null || parsed.password !== null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "userinfo-not-allowed",
                    400,
                    "Entry target URL userinfo is not allowed.",
                    { entry: null },
                    {
                        stage: "entry-read",
                        recovery: "Remove credentials from the entry URL.",
                        retryable: false,
                    },
                ));
            }
            const location = await this.#engine.resolveEntryAddress({
                workspaceId,
                workerId,
                target: parsed,
            });
            if (location === null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    "No visible entry exists at the requested target.",
                    { entry: null },
                    { target: args.target },
                ));
            }
            const row = await this.#db.entry_read_lookup.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: location.ownerId,
                scheme: location.scheme,
                pathname: location.pathname,
            });
            if (row === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    `No visible entry exists at ${location.target}.`,
                    { entry: null },
                    { target: location.target },
                ));
            }
            let channelRows: ChannelRow[];
            if (channel === undefined) {
                channelRows = await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id });
            } else {
                const r = await this.#db.entry_read_channel_slice.get<ChannelRow>({ entry_id: row.id, channel, offset: args.offset ?? 0 });
                if (r === undefined) {
                    const availableChannels = (await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id }))
                        .map(({ name }) => name);
                    return entryReadResult(Results.failure(
                        "daemon:entry",
                        "channel-not-found",
                        404,
                        `Channel #${channel} does not exist at ${location.target}.`,
                        { entry: null },
                        {
                            target: location.target,
                            requestedChannel: channel,
                            availableChannels,
                            ...(availableChannels.length === 0
                                ? {}
                                : { recovery: `Use one of the available channels: ${availableChannels.map((channel) => `#${channel}`).join(", ")}.` }),
                            retryable: false,
                        },
                    ));
                }
                channelRows = [r];
            }
            const channels: Record<string, ClientEntryChannel> = {};
            for (const c of channelRows) {
                channels[c.name] = {
                    content: c.content,
                    contentOffset: c.contentOffset,
                    contentLength: c.contentLength,
                    mimetype: c.mimetype,
                    weight: c.weight,
                    state: c.state,
                };
            }
            return entryReadResult({
                status: 200,
                entry: {
                    entryId: row.id,
                    target: location.target,
                    channels,
                },
            });
        } finally {
            release();
        }
    }

    // {§methods-conversation-worker}: a fresh conversation is a model-origin root worker with an empty private log.
    // AG-UI threads map to these workers while the workspace world remains shared ({§machine-processes}).
    async createConversationWorker(args: { workspaceId: number; name?: string; settings?: { requestUserInput?: boolean } }): Promise<{ workerId: number; workerName: string }> {
        const workspaceId = ClientInput.assertId("worker.create", "workspaceId", args.workspaceId);
        const name = ClientInput.assertOptionalWorkerName("worker.create", "name", args.name);
        const workspace = await this.#db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
        if (workspace === undefined) {
            throw daemonFailure(
                "daemon:workspace",
                "workspace-not-found",
                404,
                `Workspace ${workspaceId} does not exist.`,
                { workspaceId },
            );
        }
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId}.`,
                    { workspaceId, name, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const worker = await Envelope.createModelWorker(this.#db, workspaceId, name);
        if (args.settings !== undefined) {
            await this.#mergeWorkerSettings(worker.id, args.settings);
        }
        return { workerId: worker.id, workerName: worker.name };
    }

    // {§worker-scheme-fork} — branch a worker's log while sharing the workspace world.
    // Core owns the workspace check and immutable worker-name admission.
    async forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }> {
        const workspaceId = ClientInput.assertId("worker.fork", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.fork", "workerId", args.workerId);
        const name = ClientInput.assertOptionalWorkerName("worker.fork", "name", args.name);
        const owner = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (owner === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (owner.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: owner.workspace_id,
                    retryable: false,
                },
            );
        }
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId}.`,
                    { workspaceId, name, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const branchWorkerId = await Fork.fork(this.#db, workerId, name);
        const branch = await this.#db.envelope_get_worker_by_id.get<{ name: string }>({ id: branchWorkerId });
        return { workerId: branchWorkerId, workerName: branch?.name ?? null, parentWorkerId: workerId };
    }

    async registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void> {
        const normalized = registrations.map((registration) => this.#normalizeRuntime(registration));
        this.#engine.registerRuntimes(normalized);
        if (this.#capabilitiesPublished) {
            for (const workspace of await Envelope.listWorkspaces(this.#db)) {
                await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
                await SkillDocs.materialize(this.#engine, this.#db, workspace.id);
            }
        }
    }

    async registerRuntime(registration: RuntimeRegistration): Promise<void> {
        await this.registerRuntimes([registration]);
    }

    async registerScheme(name: string, handler: object): Promise<void> {
        this.#schemes.register(name, handler);
        if (this.#capabilitiesPublished) {
            await this.#schemes.ready();
            for (const workspace of await Envelope.listWorkspaces(this.#db)) {
                await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
                await SkillDocs.materialize(this.#engine, this.#db, workspace.id);
            }
        }
    }

    #normalizeRuntime({ namespaceOwner, decl, executor, availability, scheme }: RuntimeRegistration): {
        tag: string;
        entry: RegistryEntry;
        scheme: RuntimeRegistration["scheme"];
    } {
        if (typeof namespaceOwner !== "string" || namespaceOwner.trim().length === 0) {
            throw new Error("runtime registration namespaceOwner must be a non-empty string");
        }
        const runtime = RuntimeDeclaration.assert(decl, namespaceOwner);
        return {
            tag: runtime.name,
            entry: {
                executor,
                namespaceOwner: { kind: "module", name: namespaceOwner },
                glyph: runtime.glyph ?? "",
                summary: runtime.summary,
                invocation: runtime.invocation,
                details: runtime.details ?? "",
                ...(runtime.resourcesPath === undefined ? {} : { resourcesPath: runtime.resourcesPath }),
                ...(runtime.expandTools === undefined ? {} : { expandTools: runtime.expandTools }),
                available: availability.available,
                detail: availability.detail,
            },
            scheme,
        };
    }

    registerModuleAction(registration: ModuleActionRegistration): void {
        const { name, scope, handler } = registration;
        if (name.length === 0) throw new Error("registerModuleAction: action name must not be empty");
        if (scope !== "worldless" && scope !== "workspace") {
            throw new Error(`module action '${name}' has invalid scope '${String(scope)}'`);
        }
        if (typeof handler !== "function") throw new Error(`module action '${name}' has no handler`);
        if (this.#moduleActions.has(name)) throw new Error(`module action '${name}' is already registered`);
        this.#moduleActions.set(name, registration);
    }

    listModuleActions(): ModuleActionDescriptor[] {
        return [...this.#moduleActions.values()]
            .map(({ name, scope }) => ({ name, scope }))
            .toSorted((left, right) => left.name.localeCompare(right.name));
    }

    async invokeModuleAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ModuleActionContext,
    ): Promise<unknown> {
        const registration = this.#moduleActions.get(name);
        if (registration === undefined) throw new Error(`module action '${name}' is not registered`);
        if (registration.scope !== context.scope) {
            throw new Error(
                `module action '${name}' requires ${registration.scope} context, not ${context.scope}`,
            );
        }
        if (context.scope === "workspace") {
            ClientInput.assertId(`module action '${name}'`, "workspaceId", context.workspaceId);
        }
        return registration.handler(params, context);
    }

    registerWorkspaceCapabilityProvider(
        namespaceOwner: string,
        provider: WorkspaceCapabilityProvider,
    ): void {
        if (namespaceOwner.trim().length === 0) {
            throw new Error("workspace capability provider requires a non-empty namespace owner");
        }
        if (this.#workspaceCapabilityProviders.has(namespaceOwner)) {
            throw new Error(`workspace capability provider '${namespaceOwner}' is already registered`);
        }
        this.#workspaceCapabilityProviders.set(namespaceOwner, provider);
    }

    async readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null> {
        const checkedWorkspaceId = ClientInput.assertId(
            "workspace module state",
            "workspaceId",
            workspaceId,
        );
        if (namespaceOwner.trim().length === 0) {
            throw new Error("workspace module state requires a non-empty namespace owner");
        }
        const row = await this.#db.workspace_module_state_get.get<{ state: string }>({
            workspace_id: checkedWorkspaceId,
            namespace_owner: namespaceOwner,
        });
        return row === undefined ? null : JSON.parse(row.state) as unknown;
    }

    async replaceWorkspaceCapabilities({
        workspaceId,
        namespaceOwner,
        state,
        runtimes,
    }: WorkspaceCapabilityReplacement): Promise<void> {
        const checkedWorkspaceId = ClientInput.assertId(
            "workspace capability replacement",
            "workspaceId",
            workspaceId,
        );
        if (namespaceOwner.trim().length === 0) {
            throw new Error("workspace capability replacement requires a non-empty namespace owner");
        }
        const workspace = await this.#db.envelope_get_workspace.get({ id: checkedWorkspaceId });
        if (workspace === undefined) {
            throw daemonFailure(
                "daemon:workspace-capability",
                "workspace-not-found",
                404,
                `Workspace ${checkedWorkspaceId} does not exist.`,
                { workspaceId: checkedWorkspaceId, retryable: false },
            );
        }
        const encoded = state === null ? null : JSON.stringify(state);
        if (state !== null && encoded === undefined) {
            throw daemonFailure(
                "daemon:workspace-capability",
                "state-not-json",
                400,
                "Workspace module state is not JSON-serializable.",
                { namespaceOwner, retryable: false },
            );
        }
        if (encoded !== null) JSON.parse(encoded);
        const normalized = runtimes.map((registration) => {
            if (registration.namespaceOwner !== namespaceOwner) {
                throw new Error(
                    `workspace runtime owner '${registration.namespaceOwner}' does not match '${namespaceOwner}'`,
                );
            }
            return this.#normalizeRuntime(registration);
        });
        const gate = this.#workspaceGate.tryExclusive(checkedWorkspaceId);
        if (gate === null) {
            throw daemonFailure(
                "daemon:workspace-capability",
                "workspace-busy",
                409,
                `Workspace ${checkedWorkspaceId} is running an operation or another capability change.`,
                {
                    workspaceId: checkedWorkspaceId,
                    namespaceOwner,
                    recovery: "Settle the current operation and retry the capability change.",
                    retryable: true,
                },
            );
        }
        await gate.acquired;
        const prior = await this.#db.workspace_module_state_get.get<{ state: string }>({
            workspace_id: checkedWorkspaceId,
            namespace_owner: namespaceOwner,
        });
        let rollbackRuntimes: (() => void) | undefined;
        let stateChanged = false;
        try {
            const commitRuntimes = await this.#engine.prepareWorkspaceRuntimes(
                checkedWorkspaceId,
                namespaceOwner,
                normalized,
            );
            if (encoded === null) {
                await this.#db.workspace_module_state_delete.run({
                    workspace_id: checkedWorkspaceId,
                    namespace_owner: namespaceOwner,
                });
            } else {
                await this.#db.workspace_module_state_put.run({
                    workspace_id: checkedWorkspaceId,
                    namespace_owner: namespaceOwner,
                    state: encoded,
                });
            }
            stateChanged = true;
            rollbackRuntimes = commitRuntimes();
            if (this.#capabilitiesPublished) {
                await LoopDocs.materialize(this.#engine, this.#db, checkedWorkspaceId);
                    await SkillDocs.materialize(this.#engine, this.#db, checkedWorkspaceId);
            }
        } catch (cause) {
            rollbackRuntimes?.();
            const rollbackErrors: unknown[] = [];
            if (stateChanged) {
                try {
                    if (prior === undefined) {
                        await this.#db.workspace_module_state_delete.run({
                            workspace_id: checkedWorkspaceId,
                            namespace_owner: namespaceOwner,
                        });
                    } else {
                        await this.#db.workspace_module_state_put.run({
                            workspace_id: checkedWorkspaceId,
                            namespace_owner: namespaceOwner,
                            state: prior.state,
                        });
                    }
                } catch (rollbackCause) {
                    rollbackErrors.push(rollbackCause);
                }
                if (this.#capabilitiesPublished) {
                    try {
                        await LoopDocs.materialize(this.#engine, this.#db, checkedWorkspaceId);
                    await SkillDocs.materialize(this.#engine, this.#db, checkedWorkspaceId);
                    } catch (rollbackCause) {
                        rollbackErrors.push(rollbackCause);
                    }
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [cause, ...rollbackErrors],
                    "Workspace capability replacement and rollback failed",
                );
            }
            throw cause;
        } finally {
            gate.release();
        }
    }
    get engine(): Engine { return this.#engine; }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    registerModule(module: DaemonModule<CoreSeam>): void {
        if (this.#started) throw new Error("registerModule: modules must be registered before daemon start");
        this.#modules.push(module);
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("daemon already started");
        this.#started = true;
        this.#drains.start();

        // Mimetypes owns its own discovery scan over @plurnk/plurnk-mimetypes-*
        // packages; pre-warm it so first index render doesn't pay the cost.
        await this.#mimetypes.ready();
        for (const name of await this.#mimetypes.skippedPackages()) {
            console.warn(`mimetype discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }

        // Discover + probe the installed executor siblings, then hand the
        // registry to the engine for exec dispatch ({§exec-registry-resolves}). The
        // shell is the default runtime, so its executor must boot usable.
        const executors = await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: this.#discoveryCwd });
        this.#engine.setExecutors(executors);
        // {§question-tool} — the native request-user-input runtime, process-wide;
        // per-worker admission gates its doc visibility and dispatch ({§worker-settings}).
        await this.#engine.registerRuntimes([{
            tag: "question",
            entry: {
                executor: new QuestionTool({ runtime: "question", glyph: "❓" }),
                namespaceOwner: { kind: "module", name: "core" },
                glyph: "❓",
                summary: questionRuntimeDecl.summary,
                invocation: questionRuntimeDecl.invocation,
                details: questionRuntimeDecl.details ?? "",
                available: true,
                detail: "in-process",
            },
        }]);
        // {§effect-policy-tunable} — invalid operator policy fails boot, not the first EXEC.
        EffectPolicy.validateConfiguration();
        // {§exec} — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for the EXEC op dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their context in SchemeCtxImpl ({§plugin-discovery}).
        await this.#schemes.discoverExternal(this.#discoveryCwd);
        // {§module-discovery} — third-party daemon-module composition: trusted
        // packages declaring `plurnk.kind: "module"` register beside the
        // service's explicit composition before any module setup runs.
        const discoveredModules = await discoverDaemonModules({ cwd: this.#discoveryCwd });
        for (const packageName of discoveredModules.skipped) {
            console.warn(`module discovery: '${packageName}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }
        for (const module of discoveredModules.modules) {
            this.#modules.push(module);
        }
        const setupSeam: ModuleSetupSeam = this;
        for (const module of this.#modules) {
            if (module.close !== undefined) this.#moduleClosers.push(module as StartedModule);
            await module.setup?.(setupSeam);
        }
        for (const workspace of await Envelope.listWorkspaces(this.#db)) {
            for (const provider of this.#workspaceCapabilityProviders.values()) {
                await provider.hydrate(workspace.id);
            }
        }
        await this.#schemes.ready();

        // Reconcile the kernel-published documentation surface once per existing workspace.
        // Installed capabilities and operator configuration are now fully known; model loops
        // consume this workspace state but never republish it.
        for (const workspace of await Envelope.listWorkspaces(this.#db)) {
            await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
                await SkillDocs.materialize(this.#engine, this.#db, workspace.id);
        }
        this.#capabilitiesPublished = true;

        await this.#recoverLifecycle();

        // {§module-lifecycle} — the daemon opens no transport. Modules start their listeners only
        // after capability publication and durable lifecycle recovery are complete.
        for (const module of this.#modules) {
            const started = await module.start?.(this);
            if (started !== undefined && !this.#moduleClosers.includes(started)) {
                this.#moduleClosers.push(started);
            }
        }
    }

    async #recoverLifecycle(): Promise<void> {
        await this.#db.recovery_fail_active_loops.run({});
        await this.#db.recovery_settle_open_provider_requests.run({});
        await this.#db.recovery_fail_open_model_calls.run({});
        await this.#db.recovery_fail_ownerless_proposals.run({});
        await this.#db.recovery_remove_ownerless_client_interactions.run({});
        await this.#db.recovery_error_orphan_subscription_channels.run({});
        await this.#db.recovery_fail_orphan_subscriptions.run({});
        await this.#db.recovery_resume_unblocked_parks.run({});
        await this.#branchBatches.recover();

        const orphanSources = await this.#db.recovery_orphan_prompt_sources.all<{
            loop_id: number;
            worker_id: number;
        }>({});
        for (const source of orphanSources) {
            await this.#drains.reconcileOrphanedPrompts(source.worker_id, source.loop_id);
        }

        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        const queued = await this.#db.recovery_queued_workers.all<{
            worker_id: number;
            workspace_id: number;
        }>({});
        for (const row of queued) {
            const started = await this.#drains.ensureDrain({
                workspaceId: row.workspace_id,
                workerId: row.worker_id,
                systemPrompt,
            });
            started?.drainPromise.catch((err: unknown) => {
                console.error(`recovered drain failed for worker ${row.worker_id}:`, err);
            });
        }

        const parked = await this.#db.recovery_parked_workers.all<{
            worker_id: number;
            workspace_id: number;
        }>({});
        for (const row of parked) {
            await this.#drains.schedulePollWake(
                row.workspace_id,
                row.worker_id,
                systemPrompt,
            );
        }
    }

    // {§crash-only-stop} — the settle deadline. Default 30s; an operator can
    // raise it for slow hosts or lower it for tests. 0 is refused (an unbounded
    // stop is exactly the wedge this exists to prevent).
    static #stopDeadlineMs(): number {
        const raw = Number(process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS ?? 30_000);
        if (!Number.isSafeInteger(raw) || raw <= 0) {
            throw new Error(`PLURNK_SERVICE_STOP_TIMEOUT_MS must be a positive integer; got ${JSON.stringify(process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS)}.`);
        }
        return raw;
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        this.#started = false;

        const stopDeadlineMs = Daemon.#stopDeadlineMs();
        const deadline = Date.now() + stopDeadlineMs;
        const settle = <T>(label: string, wait: () => Promise<T>): Promise<PromiseSettledResult<T>> =>
            new Promise((resolve) => {
                let settled = false;
                const finish = (result: PromiseSettledResult<T>): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(result);
                };
                const timer = setTimeout(
                    () => finish({ status: "rejected", reason: new Error(`stop deadline exceeded waiting for ${label}`) }),
                    Math.max(0, deadline - Date.now()),
                );
                Promise.resolve().then(wait).then(
                    (value) => finish({ status: "fulfilled", value }),
                    (reason: unknown) => finish({ status: "rejected", reason }),
                );
            });

        // Stop accepting external work immediately, but do not await listener
        // closure before cancelling active workers: an SSE connection may itself be
        // waiting for the worker cancellation that follows.
        const moduleClose = Promise.allSettled(
            this.#moduleClosers
                .toReversed()
                .map((module) => Promise.resolve().then(() => module.close())),
        );
        this.#moduleClosers = [];

        // Drain order: (1) tell the supervisor to abort worker scopes so
        // strike paths don't keep going, (2) await its active drains
        // to completion, (3) drain streaming schemes' background work
        // (exec spawn cleanup, channel writes). Only THEN close the DB
        // upstream — drain queries hit the DB right up until they exit.
        // Abort every worker's cancellation scope — stops in-flight loops AND the
        // streams (background execs) linked to them, so idle() doesn't block on
        // a long-running command. Covers workers whose drain already exited but
        // whose exec is still in flight.
        // Settle the stopped world FIRST: a drain paused at a pending proposal awaits a resolution
        // that will never arrive once clients are gone — allSettled(drains) below would deadlock
        // the stop forever (a daemon with a pending HITL proposal could not shut down).
        const derivationAbort = new DOMException("daemon stopping", "AbortError");
        this.#engine.cancelAllProposals("daemon_stopping");
        this.#engine.cancelDerivations(derivationAbort);
        this.#branchBatches.beginStop();
        this.#drains.beginStop("daemon_stopping");
        // {§crash-only-stop} — the settle sequence is DEADLINE-BOUNDED: a child
        // that never closes (a wedged MCP server, a stuck stream) must not hang
        // the daemon forever. Past the deadline the waits are abandoned; the
        // process may exit with the WAL in place (SQLite recovers) rather than
        // leak as a live-but-wedged tree.
        const branchResult = await settle("branch batches idle", () => this.#branchBatches.idle());
        const drainResult = await settle("drains idle", () => this.#drains.idle());
        const moduleResult = await settle("modules close", async () => {
            const results = await moduleClose;
            if (results.some((r) => r.status === "rejected")) throw new AggregateError(
                results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason),
                "module close failed");
        });
        const streamingResult = await settle("streaming schemes idle", () => this.#drainStreamingSchemes());
        const derivationResult = await settle("derivation drain", () => this.#engine.drainDerivations(derivationAbort));
        const mimetypeResult = this.#ownsMimetypes
            ? await settle("mimetypes dispose", () => this.#mimetypes.dispose())
            : null;
        const schemeResult = await settle("schemes close", () => this.#schemes.close());
        // Streaming and scheme closure are the last producers of synchronous
        // conclusion notifications. Join the supervisor-owned async tails only
        // after those producers settle, before the caller may close SQLite.
        const wakeResult = await settle("drains idle (wake)", () => this.#drains.idle());
        const closeErrors = [
            moduleResult,
            branchResult,
            drainResult,
            streamingResult,
            derivationResult,
            ...(mimetypeResult === null ? [] : [mimetypeResult]),
            schemeResult,
            wakeResult,
        ]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (closeErrors.length > 0) throw new AggregateError(closeErrors, "daemon shutdown failed");
    }

    // Per-scheme idle awaits for clean shutdown. New streaming schemes
    // (SSE, WS) add themselves here as they land.
    async #drainStreamingSchemes(): Promise<void> {
        const exec = this.#schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
        if (exec?.idle !== undefined) await exec.idle();
    }



    /**
     * Emit a stream/event notification scoped to the workspace containing the
     * entry. ChannelWrite helpers (src/core/ChannelWrite.ts) invoke this when
     * they update channel content or state. SPEC {§notifications}.
     */
    notifyStreamEvent(workspaceId: number, event: StreamEventPayload): void {
        this.#broadcast({ workspaceId }, "stream/event", event);
    }

    /**
     * Emit a transient notice scoped to the workspace containing the loop.
     */
    notifyNotice(workspaceId: number, payload: { loopId: number; notice: Notice }): void {
        this.#broadcast({ workspaceId }, "notice/event", payload);
    }

    // {§methods-loop-run-fold-consistency} — a folded prompt cannot reconfigure its loop.
    async #assertFoldPosture(workerId: number, flags: Partial<LoopFlags> | undefined, loopId: number): Promise<void> {
        if (flags === undefined || Object.keys(flags).length === 0) return;
        const effective = await LoopFlagsReader.read(this.#db, loopId);
        const requested = Object.entries(flags) as Array<[keyof LoopFlags, LoopFlags[keyof LoopFlags] | undefined]>;
        const conflicts = requested
            .filter(([key, value]) => value !== undefined && effective[key] !== value)
            .map(([key, value]) => `${key}: ${JSON.stringify(effective[key])} -> ${JSON.stringify(value)}`);
        if (conflicts.length > 0) {
            throw daemonFailure(
                "daemon:loop",
                "loop-flags-conflict",
                409,
                "The requested loop flags differ from the active loop flags.",
                {
                    workerId,
                    loopId,
                    conflicts,
                    stage: "loop-injection",
                    recovery: "Cancel the active loop before changing flags, or omit flags to keep its current posture.",
                    retryable: false,
                },
            );
        }
    }

    inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        return this.#drains.inject(args);
    }

    // Durable prompt promotion remains daemon policy; DrainSupervisor invokes
    // it under the same worker lock as enqueue and drain teardown.
    async #reconcileOrphanedPrompts(workerId: number, endedLoopId: number): Promise<void> {
        const endedSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: endedLoopId }))?.sequence ?? endedLoopId;
        const prefix = promptLoopPrefix(endedSeq);
        const frames = await this.#db.drain_orphaned_prompts_for_loop.all<{
            body: string;
            flags: string;
            model_route_id: number | null;
            spawn_model_route_id: number | null;
            max_turns: number;
            open_paths: string | null;
        }>({ loop_id: endedLoopId, owner_id: workerId, pattern: `${prefix}%`, prefix_len: prefix.length });
        const first = frames[0];
        if (first === undefined) return;
        const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({ worker_id: workerId });
        if (seqRow === undefined) throw new Error("reconcileOrphanedPrompts: next-sequence query returned no row");
        const recovery = await this.#db.drain_enqueue_orphan_recovery_loop.get<{
            id: number;
            sequence: number;
            status: number;
        }>({
            worker_id: workerId,
            sequence: seqRow.next,
            prompt: first.body,
            flags: first.flags,
            model_route_id: first.model_route_id,
            spawn_model_route_id: first.spawn_model_route_id,
            max_turns: first.max_turns,
            open_paths: first.open_paths ?? "[]",
            orphan_source_loop_id: endedLoopId,
        });
        if (recovery === undefined) throw new Error("reconcileOrphanedPrompts: enqueue returned no row");
        if (recovery.status !== 100) return;
        const moved = await this.#db.drain_rehome_orphaned_prompt_frames.all<{ id: number; pathname: string }>({
            owner_id: workerId,
            source_loop_id: endedLoopId,
            source_pattern: `${prefix}%`,
            source_prefix_len: prefix.length,
            target_prefix: promptLoopPrefix(recovery.sequence),
        });
        if (moved.length !== frames.length) {
            throw new Error(`reconcileOrphanedPrompts: expected to re-home ${frames.length} frames, moved ${moved.length}`);
        }
    }

    cancelDrain(workerId: number, reason: string = "user_cancelled"): boolean {
        return this.#drains.cancel(workerId, reason);
    }

    // Process-local stream activity is supplied to the drain owner through the
    // scheme registry rather than exposing that registry across the boundary.
    #workerHasActiveStreams(workerId: number): boolean {
        const exec = this.#schemes.get("exec") as {
            hasActiveSpawns?: (workerId: number) => boolean;
        } | undefined;
        return exec?.hasActiveSpawns?.(workerId) ?? false;
    }

    // {§methods-event-subscribe} — subscriber failures are transport-local:
    // log them at this boundary and never re-enter engine control flow.
    #emitTo(workspaceId: number | null, method: string, params?: unknown): void {
        for (const sub of this.#eventSubscribers) {
            try { sub(workspaceId, method, params); }
            catch (e) { console.error(`seam subscriber failed on ${method}:`, e instanceof Error ? e.message : String(e)); }
        }
    }

    #broadcast(target: NotifyTarget, method: string, params?: unknown): void {
        observedSync( // {§observability-boundary}
            "stream.broadcast",
            { method, ...(target === "all" ? {} : { "workspace.id": target.workspaceId }) },
            () => {
                if (target === "all") {
                    // {§notifications-envelope-carries-workspaceid}: global events carry workspaceId null.
                    this.#emitTo(null, method, params);
                    return;
                }
                // {§methods-event-subscribe}: publish to the in-process source; transport modules subscribe
                // here (plurnk-agui renders to AG-UI+). Each subscriber owns its own fan-out; core just emits.
                // Scope-stamping onto the notification envelope ({§notifications-envelope-carries-workspaceid})
                // is each subscriber's edge concern now — the seam hands (workspaceId, method, params) raw.
                this.#emitTo(target.workspaceId, method, params);
            },
        );
    }
}

// {§methods} — the curated seam handed to a plugin module at boot is the client-interface contract,
// not the daemon's guts. A module couples to this (or its own structural mirror) and nothing else; the
// non-seam surface (start/stop/#internals) is not part of the contract. Derived from Daemon so the two
// never drift.
export type CoreSeam = Pick<Daemon,
    | "subscribeToEvents"
    | "pendingProposals" | "resolveProposal"
    | "pendingClientInteractions" | "resolveClientInteraction"
    | "runLoop" | "cancelDrain" | "dispatchClientAction" | "ensureModelWorker"
    | "readWorkerModel" | "setWorkerModel" | "setWorkerSpawnModel"
    | "readWorkerSettings" | "setWorkerSettings"
    | "readLog" | "readEntry" | "look"
    | "listProviders" | "listWorkspaces" | "listWorkers" | "listPrompts" | "listMembers" | "listConstraints" | "workspaceDerivationStatus"
    | "listClientDisplayCapabilities"
    | "createWorkspace" | "attachWorkspace" | "createConversationWorker" | "renameWorkspace" | "constrain" | "unconstrain"
    | "forkWorker"
    | "listModuleActions" | "invokeModuleAction"
>;
