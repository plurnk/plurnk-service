// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the transport-free module seam ({§rpc}).

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Share } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import type { Db } from "../core/Db.ts";
import type { StreamEventPayload } from "../core/ChannelWrite.ts";
import type { ReasoningEventPayload } from "../core/ReasoningEvent.ts";
import type { OutsideEventPayload } from "../core/OutsideEvent.ts";
import Paths from "../Paths.ts";
import Engine, { type WorkspaceDerivationStatus } from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import Exec from "../schemes/Exec.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { RuntimeDeclaration } from "@plurnk/plurnk-execs";
import type { Provider, ProviderAccounting } from "@plurnk/plurnk-providers";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import QuestionTool, { questionRuntimeDecl } from "../schemes/QuestionTool.ts";
// {§notifications-envelope-carries-workspaceid}: "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped.
export type NotifyTarget = "all" | { workspaceId: number };
import DrainSupervisor, { type DrainInjectionArgs, type DrainInjectionResult } from "./DrainSupervisor.ts";
import MessageAbandonment from "./MessageAbandonment.ts";
import Retention, { retentionPolicy } from "./Retention.ts";
import TurnDispositionHandler from "../core/TurnDispositionHandler.ts";
import { Validator, isRecord, type ClientDisplayCapabilities, type FunctionalityPreparationActivity, type CapabilityProjection, type ClientInteractionProjection, type ClientInteractionResolution, type ApplicationLoopProjection, type ApplicationGauge, type ApplicationWorkerIdentity, type ApplicationWorkerProjection, type ApplicationWorkerQuery, type ClientEntryChannel, type ModelCatalogPage, type ModelCatalogQuery, type ModelRoute, type Notice, type ProposalProjection, type Effort, type PlurnkStatement, type RollbackReport, type ApplicationOwnerIdentity, type ApplicationWorkerCreation, type WorkerOwner, type ApplicationMessage, type ApplicationInboxMessage, type MessageResource, type CapabilityPolicy, type ClientEnvelope, type FunctionalityFamilyHandle, type ProposalResolution } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type HttpListener from "./HttpListener.ts";
import Credentials from "./Credentials.ts";
import Envelope, { projectWorkerRow, type WorkspaceEnvelope, type WorkspaceRow } from "./envelope.ts";
import WorkerReferences from "./WorkerReferences.ts";
import ClientInput from "./client-input.ts";
import WorkspacePlugins from "./WorkspacePlugins.ts";
import { agentRootScopes, workspacePaths } from "./AgentRoots.ts";
import ExecEnv from "../schemes/exec-env.ts";
import PlurnkSkill from "./PlurnkSkill.ts";
import ResourceTreeScheme from "../schemes/ResourceTreeScheme.ts";
import type { ResourceTreeSource, SchemeHandler } from "@plurnk/plurnk-schemes";
import MembersFunctionality, { modelScope, serviceMembers } from "./MembersFunctionality.ts";
import FileCreationPolicy from "../core/file-creation-policy.ts";
import EnvFunctionality, { ENV_OWNER } from "./EnvFunctionality.ts";
import EnvScheme from "../schemes/Env.ts";
import HostPaths from "../core/HostPaths.ts";
import WorkspaceStorage from "./WorkspaceStorage.ts";
import Fork from "../core/fork.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { Knob } from "@plurnk/plurnk-meta";
import ProposalPolicies from "../core/ProposalPolicies.ts";
import WorkerOwners from "../core/WorkerOwners.ts";
import RuntimeWorker from "../core/RuntimeWorker.ts";
import { contentWeight } from "../core/content-weight.ts";
import MessageResources from "../core/MessageResources.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import { resolveActiveRoute } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import type { ApplicationPort, HttpRouteHandler } from "@plurnk/plurnk-contracts/port";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import StopDeadline from "../core/StopDeadline.ts";
import WorkspaceResidency from "./WorkspaceResidency.ts";
import type { DaemonModule, ModuleActionContext, ModuleActionDescriptor, ModuleActionRegistration } from "@plurnk/plurnk-modules";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginSet } from "@plurnk/plurnk-agent-plugins";
import type { AgentRootScope } from "./AgentRoots.ts";
import type { HostFunctionalityAdapter, HostSetupSeam, WorkspaceCapabilityProvider, WorkspaceCapabilityPublication, WorkspaceCapabilityReplacement } from "./ModuleHost.ts";
import Functionality from "./Functionality.ts";
import { observed, observedSync } from "../observe/spans.ts";
import { daemonFailure } from "./daemon-results.ts";
import WorkerModels, { type EffortSource } from "./WorkerModels.ts";
import ClientReads from "./ClientReads.ts";
import MessageDelivery from "./MessageDelivery.ts";
import DaemonModules from "./DaemonModules.ts";
import ClientOperations from "./ClientOperations.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";

export type ChannelRow = { name: string } & ClientEntryChannel;
// The callbacks the Daemon hands its engine and drain supervisor, by the types those owners declare.
type DrainCallbacks = ConstructorParameters<typeof DrainSupervisor>[0];
type DrainRunLoopArgs = Parameters<DrainCallbacks["runLoop"]>[0];
type DrainRunLoopResult = Awaited<ReturnType<DrainCallbacks["runLoop"]>>;

export default class Daemon implements ApplicationPort, HostSetupSeam {
    static validateConfiguration(): void {
        Credentials.posture();
        FileCreationPolicy.serviceScope();
        EffectPolicy.validateConfiguration();
        ProposalPolicies.read();
        TurnDispositionHandler.configuredWaitSeconds();
        retentionPolicy();
        Exec.validateConfiguration();
        ExecutorRegistry.validateConfiguration();
    }

    static validateWorkspaceConfiguration(): void {
        agentRootScopes();
        serviceMembers();
        modelScope();
    }

    #db: Db;
    readonly #dbPath: string | undefined;
    readonly #hostPaths: HostPaths;
    #engine: Engine;
    #workspaceGate: WorkspaceGate;
    #lifecycle: LoopLifecycle;
    #drains: DrainSupervisor;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    readonly #ownsMimetypes: boolean;
    #provider: Provider | null;
    #nodeModulesPath: string;
    // {§http-host} — the one listener, bound by the service before durable admission; null in
    // tests that never open a transport.
    readonly #http: HttpListener | null;
    // {§credential-authority} {§methods-credentials} — the one authority over credentials presented to
    // the listener, holding the operator's secret under the posture `PLURNK_AUTH` names.
    readonly credentials: Credentials;
    // The file beside the database where a minted operator secret is written for same-user clients;
    // null for a daemon started without its database path.
    readonly #secretPath: string | null;
    readonly #secretMinted: boolean;
    #discoveryCwd: string;
    #started = false; // {§module-lifecycle}: one discovery/module boot; no listener

    // {§module-discovery} — the daemon's modules, composed and discovered, with their mounts, phases and actions.
    readonly #modules: DaemonModules;
    // {§connection-lifecycle} — the client operations in flight: their loops, scopes and settlement.
    readonly #clientOperations: ClientOperations;
    // {§methods-loop-run} {§machine-processes} — a message's delivery to a worker: the loop it starts or continues.
    readonly #delivery: MessageDelivery;
    #residency: WorkspaceResidency;
    readonly #functionality: Functionality;
    // {§retention-policy} — the operator's retention, run on a cadence and at shutdown.
    #retention: Retention | null = null;
    readonly #plugins: WorkspacePlugins;
    readonly #members: MembersFunctionality;
    // {§methods-event-subscribe} — the broadcast's in-process event source. A transport
    // module (plurnk-agui) subscribes and fans out to its OWN clients; core emits, never owns
    // client transport or connection state.
    #eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();
    readonly #workerModels: WorkerModels;
    readonly #reads: ClientReads;
    readonly #storage: WorkspaceStorage;
    readonly #configuration: ConfigurationDiagnostics;

    constructor({
        db, schemes, mimetypes, provider, nodeModulesPath, hostPaths = new HostPaths(), http = null, dbPath,
        configuration = new ConfigurationDiagnostics() }: {
        db: Db;
        schemes?: SchemeRegistry;
        mimetypes?: Mimetypes;
        provider?: Provider | null;
        nodeModulesPath?: string;
        hostPaths?: HostPaths;
        // {§share} — the database file this daemon serves; a share snapshots it.
        dbPath?: string;
        http?: HttpListener | null;
        configuration?: ConfigurationDiagnostics;
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        this.#dbPath = dbPath;
        this.#http = http;
        this.#configuration = configuration;
        const posture = Credentials.posture();
        this.credentials = new Credentials({ operatorSecret: posture.secret });
        this.#secretPath = dbPath === undefined ? null : Credentials.secretPath(dbPath);
        this.#secretMinted = posture.minted;
        this.#storage = new WorkspaceStorage(db, hostPaths);
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes ?? new SchemeRegistry();
        this.#provider = provider ?? null;
        // Extension discovery resolves from the SERVICE's node_modules (its exec/scheme/mimetype
        // deps), NOT process.cwd() — else a globally-installed daemon started from a project dir
        // finds no extensions. The bin passes the package-relative path; cwd default holds for
        // in-repo tests. discover() takes a cwd and joins node_modules, so derive the parent.
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
        this.#discoveryCwd = dirname(this.#nodeModulesPath);
        // {§copy-destination-mimetype}: detection misses remain absent; resource
        // owners supply their creation type. {§mimetype-owned-lifecycle}
        this.#ownsMimetypes = mimetypes === undefined;
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discoverOptions: { cwd: this.#discoveryCwd } });
        const bootSpec = this.#provider === null ? null : resolveActiveRoute();
        if (this.#provider !== null && bootSpec !== null) {
            ProviderInstantiate.registerInstance(this.#provider, bootSpec);
        }
        this.#workspaceGate = new WorkspaceGate(async (workerId, rootWorkerId) => {
            const row = await this.#db.worker_lineage_contains.get<{ member: number }>({
                worker_id: workerId,
                root_worker_id: rootWorkerId });
            return row !== undefined;
        });
        // {§module-workspace-residency} — residency, activation/cooling, and
        // capability replacement live in their one owner; the Daemon delegates.
        this.#residency = new WorkspaceResidency({
            db,
            engine: () => this.#engine,
            workspaceGate: this.#workspaceGate,
            normalizeRuntime: (registration) => this.#normalizeRuntime(registration) });
        // {§module-discovery} — the modules' owner exists before Core registers its own families below: their
        // actions register through the same seam a module's do.
        this.#modules = new DaemonModules({
            db, http: this.#http, configuration: this.#configuration, residency: this.#residency, workspaceGate: this.#workspaceGate,
        });
        // {§functionality-coordinator} — the one owner above every family
        // adapter; Core hosts it, modules register adapters through the seam.
        this.#functionality = new Functionality({
            signal: this.#residency.signal,
            registerModuleAction: (registration) => this.registerModuleAction(registration),
            registerWorkspaceCapabilityProvider: (owner, capabilities) => this.registerWorkspaceCapabilityProvider(owner, capabilities),
            readWorkspaceModuleState: (workspaceId, owner) => this.readWorkspaceModuleState(workspaceId, owner),
            replaceWorkspaceCapabilities: (replacement, options) => this.replaceWorkspaceCapabilities(replacement, options),
            readWorkerModuleState: (workerId, owner) => this.#residency.readWorkerModuleState(workerId, owner),
            replaceWorkerModuleState: (workerId, owner, state) => this.#residency.replaceWorkerModuleState(workerId, owner, state),
            withWorkspaceGate: (workspaceId, owner, gate, run, signal) => this.#residency.exclusively(workspaceId, owner, gate, run, signal),
            atWorkspaceBoundary: (workspaceId, run) => this.#workspaceGate.atBoundary(workspaceId, run),
            retainWorkspace: (workspaceId) => this.#residency.retain(workspaceId),
            preparationChanged: (workspaceId, preparation) => this.#broadcast({ workspaceId }, "workspace/preparation", { workspaceId, preparation }) });
        this.#plugins = new WorkspacePlugins({ db, hostPaths, nodeModules: this.#nodeModulesPath });
        // {§members-functionality} — Core's own family: file membership on the same surface.
        this.#members = new MembersFunctionality({ db, engine: () => this.#engine });
        this.#functionality.register(this.#members);
        // {§env-functionality} — Core's own family: the environment a Worker's commands run in.
        // {§env-scheme} — the family's face: reads project the dispatching Worker's effective
        // environment, writes go through the family's own admission at the Worker's layer. The runtime
        // worker keeps none: its environment is the workspace's ({§actor-boundary-client-operations}).
        this.#functionality.register(new EnvFunctionality(
            EnvFunctionality.defaultsReader(Paths.packageRoot, this.#nodeModulesPath),
            new EnvScheme(
                (workspaceId, workerId) => EnvFunctionality.resolve(this.#db, workspaceId, workerId),
                (verb, params, identity) => this.#functionality.invoke("env", verb, params, identity, "operation"),
                async (workspaceId, workerId) => (await this.#db.runtime_worker_get.get<{ id: number }>({ workspace_id: workspaceId }))?.id === workerId
                    ? "workspace" : "worker",
            ),
        ));
        this.#engine = new Engine({
            db, lifecycle: this.#lifecycle, schemes: this.#schemes, mimetypes: this.#mimetypes,
            // {§tokenomics-agnostic-ruler} — stored and catalog curation weights
            // are workspace-wide across concurrent models, so they remain
            // model-independent. Request-shaped token facts stay provider-owned.
            weigh: contentWeight,
            streamEventNotify: (workspaceId, event) => this.notifyStreamEvent(workspaceId, event),
            operationSettledNotify: (workspaceId, logEntryId) => this.#drains.operationSettled(workspaceId, logEntryId),
            operationEventNotify: (workspaceId, event) => this.#broadcast({ workspaceId }, "operation/event", event),
            reasoningEventNotify: (workspaceId, event) => this.notifyReasoningEvent(workspaceId, event),
            outsideEventNotify: (workspaceId, event) => this.notifyOutsideEvent(workspaceId, event),
            wakeWorkerNotify: (payload) => this.#drains.notifyWakeWorker(payload),
            injectWorker: (args) => this.#delivery.injectWorker(args),
            withWorkspaceTurn: (workspaceId, workerId, run, signal) => this.#workspaceGate.withTurn(workspaceId, workerId, run, signal),
            // {§functionality-hotload} — skills and plugins change out of band.
            // Republish under the workspace turn gate before packet assembly so
            // the first subsequent model turn sees their exact result.
            workspaceTurnStarting: async ({ workspaceId }) => {
                await this.#functionality.refreshChanged({ workspaceId });
                return [...this.configurationNotices(), ...this.#functionality.configurationNotices(workspaceId), ...this.#plugins.notices(workspaceId)];
            },
            // worker:// KILL (terminate) — cancel the addressed worker subtree and
            // tear down its held streams before the operation completes.
            cancelWorker: async (workerId, reason) => this.#drains.cancelWorkerTree(workerId, reason),
            // {§membership-auto-add} — a READ or FIND admits what it reached for as the Worker's own
            // definition; the members scope's refusal admits nothing and is not a failure of the read.
            admitMembers: async (identity, files) => {
                try {
                    const result = await this.#functionality.invoke("members", "add", { files }, identity, "operation");
                    return result.status < 400 ? files : [];
                } catch (cause) {
                    if (cause instanceof OperationFailureError && cause.result.status < 500) return [];
                    throw cause;
                }
            },
            noticeNotify: (workspaceId, payload) => this.notifyNotice(workspaceId, payload),
            loopPacketNotify: (workspaceId, payload) => {
                this.#broadcast({ workspaceId }, "loop/packet", payload);
            } });
        this.#drains = new DrainSupervisor({
            db,
            // {§message-abandonment} — the daemon answers, 499, what an ended loop left unanswered.
            completeAbandonedMessages: (workspaceId, workerId, loopId, status) =>
                MessageAbandonment.complete(this.#engine, this.#db, workspaceId, workerId, loopId, status),
            lifecycle: this.#lifecycle,
            injectPrompt: (loopId, prompt, openPaths, source, evidence, messageAddress, opener) => this.#engine.injectIntoLoop(loopId, prompt, openPaths, source, evidence, messageAddress, opener),
            assertInjectionCompatibility: (args) => this.#workerModels.assertInjectionCompatibility(args),
            runLoop: (args) => this.#runDrainLoop(args),
            loopUsage: (loopId) => this.#engine.loopUsage(loopId),
            loopAttributions: (loopId) => this.#engine.loopAttributions(loopId),
            discardLoopNotices: (loopId) => this.#engine.discardLoopNotices(loopId),
            cancelSubscription: (subscriptionId) => this.#engine.cancelSubscription(subscriptionId),
            subscriptionConcluded: (subscriptionId) => this.#engine.subscriptionConcluded(subscriptionId),
            reapLoopStreams: (loopId) => this.#engine.reapLoopStreams(loopId),
            hasActiveStreams: (workerId) => this.#workerHasActiveStreams(workerId),
            readSystemPrompt: () => readFile(Paths.instructionsSystem, "utf8"), // {§card-read-per-wake}
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            },
            emit: (workspaceId, method, params) => this.#broadcast({ workspaceId }, method, params) });
        // Wire proposal-pending events to the loop/proposal WS notification.
        // Sessionid scopes the broadcast to clients on the same workspace.
        this.#engine.onProposalPending((event) => {
            const { workspaceId, ...proposal } = event;
            this.#broadcast({ workspaceId }, "loop/proposal", proposal);
        });
        // {§notifications-loop-interaction} — the projection is the payload; its scope is the envelope's.
        this.#engine.onClientInteractionPending((event) => {
            const { workspaceId, ...interaction } = event;
            this.#broadcast({ workspaceId }, "loop/interaction", interaction);
        });
        this.#workerModels = new WorkerModels({ db: this.#db, provider: this.#provider });
        this.#delivery = new MessageDelivery({
            db, workerModels: this.#workerModels, functionality: this.#functionality, mimetypes: this.#mimetypes,
            inject: (args) => this.inject(args),
        });
        this.#reads = new ClientReads({ db: this.#db, engine: this.#engine, workspaceGate: this.#workspaceGate, residency: this.#residency });
        this.#clientOperations = new ClientOperations({
            db, engine: this.#engine, residency: this.#residency, workspaceGate: this.#workspaceGate,
            assertModelWorker: (workspaceId, workerId) => this.#workerModels.assertModelWorker(workspaceId, workerId),
            assertWorkerOwned: (workspaceId, workerId) => this.#assertWorkerOwned(workspaceId, workerId),
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            },
        });
    }

    // The drain callback is the final provider/model boundary. Every admission path, including boot recovery,
    // terminates here.
    async #runDrainLoop({ workspaceId, workerId, loopId, maxTurns, prompt, systemPrompt, signal, onSettled }: DrainRunLoopArgs): Promise<DrainRunLoopResult> {
        // The drain callback is the final provider/model boundary. Every
        // admission path, including boot recovery, terminates here.
        await this.#workerModels.assertModelWorker(workspaceId, workerId);
        const releaseCapabilities = await this.#residency.acquire(workspaceId);
        try {
            // Worker settings can change while Functionality remains
            // resident. Reconcile the worker-private discovery surface
            // at the same pre-inference boundary used for activation.
            await this.#residency.reconcile(workspaceId);
            const { provider: loopProvider, childProvider } = await this.#workerModels.providersForLoop(loopId);
            return await this.#engine.runLoop({
                provider: loopProvider,
                childProvider,
                workspaceId,
                workerId,
                loopId,
                maxTurns,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt },
                ],
                signal,
                onSettled });
        } finally {
            releaseCapabilities();
        }
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

    async registerWorkerOwner(workspaceId: number, owner: WorkerOwner): Promise<void> {
        const id = ClientInput.assertId("registerWorkerOwner", "workspaceId", workspaceId);
        await WorkerOwners.register(this.#db, id, owner);
    }

    async claimWorkerOwner(args: { workspaceId: number; workerId: number; owner: string }): Promise<WorkerOwner> {
        const workspaceId = ClientInput.assertId("claimWorkerOwner", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("claimWorkerOwner", "workerId", args.workerId);
        const worker = await this.readWorker({ workspaceId, identity: { id: workerId } });
        if (worker === null) throw daemonFailure("worker:owner", "worker-not-found", 404,
            `Worker ${workerId} does not belong to workspace ${workspaceId}.`, { workspaceId, workerId });
        return WorkerOwners.claim(this.#db, workspaceId, workerId, args.owner);
    }

    // {§methods-proposal-resolve} — proposal HITL. A transport module reads the stopped-world
    // proposals for a workspace (rendering each as a TOOL_CALL) and feeds back the human's decision. The
    // gate, validation, and applyResolution stay core (Engine.resolveProposal); the seam is the read +
    // the resolve, never the mechanism. `resolveProposal` throws for an unknown/already-resolved id.
    async pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        const checkedWorkspaceId = ClientInput.assertId("pendingProposals", "workspaceId", workspaceId);
        return this.#engine.pendingProposals(checkedWorkspaceId);
    }

    async resolveProposal(logEntryId: number, resolution: ProposalResolution, owner: ApplicationOwnerIdentity): Promise<void> {
        const checkedLogEntryId = ClientInput.assertId("resolveProposal", "logEntryId", logEntryId);
        const checkedResolution = ClientInput.assertProposalResolution("resolveProposal", resolution);
        const workspaceId = ClientInput.assertId("resolveProposal", "workspaceId", owner.workspaceId);
        const pending = await this.#db.worker_owner_for_proposal.get<{ workspaceId: number; owner: string }>({ log_entry_id: checkedLogEntryId });
        if (pending !== undefined && (pending.workspaceId !== workspaceId || pending.owner !== owner.address)) {
            throw daemonFailure("proposal:resolution", "owner-mismatch", 403,
                "Only the worker's owner may resolve this proposal.", { logEntryId: checkedLogEntryId });
        }
        await this.#engine.resolveProposal(checkedLogEntryId, checkedResolution, owner.address);
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
        respondent: ApplicationOwnerIdentity,
        message?: { readonly body: string; readonly source: string; readonly envelope: Readonly<Record<string, unknown>> },
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
        if (message !== undefined) {
            ClientInput.assertPrompt("resolveClientInteraction", message.body);
            ClientInput.assertOptionalSource("resolveClientInteraction", message.source);
        }
        ClientInput.assertId("resolveClientInteraction", "workspaceId", respondent.workspaceId);
        await this.#engine.resolveClientInteraction(checkedInteractionId, checkedResolution, respondent, message);
    }

    async readMessages(args: { workspaceId: number; workerId: number; loopId?: number }): Promise<ApplicationMessage[]> {
        await this.#workerModels.assertModelWorker(args.workspaceId, args.workerId);
        return MessageResources.read(this.#db, args);
    }

    // {§methods-worker-inbox}
    async readInbox(args: { workspaceId: number; workerId: number }): Promise<ApplicationInboxMessage[]> {
        await this.#workerModels.assertModelWorker(args.workspaceId, args.workerId);
        return MessageResources.inbox(this.#db, args);
    }

    // {§message-idempotency}
    async messageAdmission(args: { workspaceId: number; address: string; body: string }): Promise<"new" | "accepted"> {
        const workspaceId = ClientInput.assertId("messageAdmission", "workspaceId", args.workspaceId);
        return await MessageResources.admission(this.#db, workspaceId, args.address, args.body);
    }

    // {§methods-loop-run} — a message delivered to a worker drives or steers its loop: the delivery's owner resolves
    // the worker's model and the card and injects into the drain; the port's entry point delegates.
    runLoop(args: { workspaceId: number; workerId: number; loopId?: number; prompt: string; source?: string; messageAddress?: string; attachments?: readonly MessageResource[]; envelope?: Readonly<Record<string, unknown>>; maxTurns?: number; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        return this.#delivery.runLoop(args);
    }

    async ensureRuntimeWorker(workspaceId: number): Promise<number> {
        const checked = ClientInput.assertId("worker.ensure-runtime", "workspaceId", workspaceId);
        if (await this.#db.envelope_get_workspace.get({ id: checked }) === undefined) {
            throw daemonFailure("worker:owner", "workspace-not-found", 404, `Workspace ${checked} does not exist.`);
        }
        return RuntimeWorker.ensure(this.#db, checked);
    }

    async readWorkspaceCapabilities(args: { workspaceId: number }): Promise<CapabilityProjection> {
        const workspaceId = ClientInput.assertId("workspace.capabilities.get", "workspaceId", args.workspaceId);
        return this.#engine.capabilityProjection(workspaceId);
    }

    // {§workspace-capability-policy} Policy changes share the workspace's
    // quiescent publication boundary; no in-flight proposal can change authority.
    async setWorkspaceCapabilities(args: { workspaceId: number; policy: CapabilityPolicy }): Promise<CapabilityProjection> {
        const workspaceId = ClientInput.assertId("workspace.capabilities.set", "workspaceId", args.workspaceId);
        const settings: unknown = JSON.parse(ClientInput.parseSettings({ capabilities: args.policy }));
        const capabilities = isRecord(settings) && settings.capabilities !== undefined ? Validator.assertCapabilityPolicy(settings.capabilities) : undefined;
        if (capabilities === undefined) throw daemonFailure(
            "daemon:input", "capability-policy-required", 400, "policy is required.", { field: "policy", retryable: false },
        );
        return this.#residency.exclusively(workspaceId, "capabilities", "try", async () => {
            const row = await this.#db.workspace_capability_policy_update.get({
                workspace_id: workspaceId, policy: JSON.stringify(capabilities),
            });
            if (row === undefined) throw daemonFailure(
                "daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, { workspaceId },
            );
            return await this.#engine.capabilityProjection(workspaceId);
        });
    }

    // {§worker-model-selection} {§worker-effort} — the worker's durable model, effort and spawn override are
    // WorkerModels' to read and set; the port's entry points delegate.
    readWorkerModel(args: { workspaceId: number; workerId: number }): Promise<{ model: ModelRoute | null; spawnModel: ModelRoute | null }> {
        return this.#workerModels.readWorkerModel(args);
    }

    setWorkerModel(args: { workspaceId: number; workerId: number; selector: string; effort?: unknown }): Promise<ModelRoute> {
        return this.#workerModels.setWorkerModel(args);
    }

    readWorkerEffort(args: { workspaceId: number; workerId: number }): Promise<{ effort: Effort | null; source: EffortSource; supportedEfforts: readonly Effort[] }> {
        return this.#workerModels.readWorkerEffort(args);
    }

    setWorkerEffort(args: { workspaceId: number; workerId: number; effort: unknown }): Promise<{ effort: Effort; source: "explicit"; supportedEfforts: readonly Effort[] }> {
        return this.#workerModels.setWorkerEffort(args);
    }

    setWorkerSpawnModel(args: { workspaceId: number; workerId: number; selector: string | null }): Promise<ModelRoute | null> {
        return this.#workerModels.setWorkerSpawnModel(args);
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

    // {§functionality-model-mutation} — await every queued Functionality
    // publication (a Worker's accepted mutation publishes at its turn boundary).
    async settleFunctionality(workspaceId?: number): Promise<void> {
        await this.#functionality.settle(workspaceId);
    }

    executorTags(workspaceId: number): readonly string[] {
        return this.#engine.executorTags(workspaceId);
    }

    // {§connection-lifecycle} A person's client operation: one administrative loop in the workspace's runtime
    // worker, attributed to its actor, reading `log:///` in the worker that person acts for
    // ({§actor-boundary-client-operations}). The operations' owner runs it; the port's entry points delegate.
    dispatchClientAction(args: {
        workspaceId: number;
        actor: string;
        contextWorkerId?: number;
        statements: PlurnkStatement[];
        onLoop?: (loop: { workerId: number; loopId: number }) => void;
    }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        return this.#clientOperations.dispatchClientAction(args);
    }

    cancelLoop(args: { workspaceId: number; loopId: number; reason?: string }): Promise<boolean> {
        return this.#clientOperations.cancelLoop(args);
    }

    // {§methods} — the module's render surface beyond the journal. Thin delegations
    // into core's envelope / membership / provider machinery; the module fans the results into its own views.
    listProviders(): ReturnType<ApplicationPort["listProviders"]> {
        return this.#workerModels.listProviders();
    }

    listModels(query: ModelCatalogQuery): ModelCatalogPage {
        return this.#workerModels.listModels(query);
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
                    display: glyph === undefined ? {} : { glyph } };
            });
        const mimetypes: ClientDisplayCapabilities = (await this.#mimetypes.displayMetadata())
            .map(({ mimetype, glyph }) => ({
                kind: "mimetype" as const,
                mimetype,
                display: glyph.length === 0 ? {} : { glyph } }));
        return Validator.assertClientDisplayCapabilities([...schemes, ...mimetypes]);
    }

    async listWorkspaces(): Promise<Array<WorkspaceRow & { project_label: string | null }>> {
        return (await Envelope.listWorkspaces(this.#db)).map((row) => ({ ...row, project_label: this.#projectLabel(row.project_root) }));
    }

    // {§workspace-label} — the folder as the daemon spells it for display: the spelling a default name takes.
    #projectLabel(projectRoot: string | null): string | null {
        return projectRoot === null ? null : this.#hostPaths.abbreviateUserPath(projectRoot);
    }

    #labelled(envelope: WorkspaceEnvelope): ClientEnvelope {
        return { ...envelope, projectLabel: this.#projectLabel(envelope.projectRoot) };
    }
    listWorkers(
        workspaceId: number,
        query: ApplicationWorkerQuery = {},
    ): Promise<ApplicationWorkerProjection[]> {
        const origin = query.origin;
        if (origin !== undefined && !["model", "client", "_plurnk"].includes(origin)) {
            throw daemonFailure(
                "daemon:worker",
                "origin-invalid",
                400,
                `Worker origin '${origin}' is invalid.`,
                { origin, retryable: false },
            );
        }
        const parentWorkerId = query.parentWorkerId === undefined
            ? undefined
            : query.parentWorkerId === null
                ? null
                : ClientInput.assertId("workspace.workers", "parentWorkerId", query.parentWorkerId);
        // {§methods-worker-list} — an omitted parent filter must stay absent:
        // the envelope keys the filter on the property's presence, not its value.
        return Envelope.listWorkersForWorkspace(
            this.#db,
            ClientInput.assertId("workspace.workers", "workspaceId", workspaceId),
            {
                ...(origin === undefined ? {} : { origin }),
                ...(parentWorkerId === undefined ? {} : { parentWorkerId }) },
        );
    }

    async readWorker(args: {
        workspaceId: number;
        identity: ApplicationWorkerIdentity;
    }): Promise<ApplicationWorkerProjection | null> {
        const workspaceId = ClientInput.assertId("worker.read", "workspaceId", args.workspaceId);
        const hasId = Object.hasOwn(args.identity, "id");
        const hasName = Object.hasOwn(args.identity, "name");
        if (hasId === hasName) {
            throw daemonFailure(
                "daemon:worker",
                "identity-invalid",
                400,
                "Worker observation requires exactly one id or name.",
                { retryable: false },
            );
        }
        type Row = Omit<ApplicationWorkerProjection, "lifecycle"> & { workspace_id: number; loopObservations: string };
        // {§worker-name-minting} — a lookup is no minting door: it resolves any name a listing returns,
        // the runtime worker's `_plurnk` among them.
        const row = hasId
            ? await this.#db.envelope_get_worker_by_id.get<Row>({
                id: ClientInput.assertId("worker.read", "id", args.identity.id) })
            : await this.#db.envelope_get_worker_by_name.get<Row>({
                workspace_id: workspaceId,
                name: ClientInput.assertOptionalName("worker.read", "name", args.identity.name)! });
        if (row === undefined || row.workspace_id !== workspaceId) return null;
        const { workspace_id: _workspaceId, ...projection } = projectWorkerRow(row);
        return projection;
    }

    // {§methods-worker-accounting}
    async workerAccounting(args: { workspaceId: number; workerId: number }): Promise<ProviderAccounting> {
        const workspaceId = ClientInput.assertId("worker.accounting", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.accounting", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        return this.#engine.workerAccounting(workerId);
    }

    // {§methods-worker-gauge}
    async workerGauge(args: { workspaceId: number; workerId: number }): Promise<ApplicationGauge> {
        const workspaceId = ClientInput.assertId("worker.gauge", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.gauge", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        const latest = await this.#db.application_latest_packet_loop.get<{ id: number }>({ worker_id: workerId });
        if (latest === undefined) return { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };
        return Engine.clientGauge(await this.#engine.loopGauge(latest.id));
    }

    async listWorkerLoops(args: {
        workspaceId: number;
        workerId: number;
    }): Promise<ApplicationLoopProjection[]> {
        const workspaceId = ClientInput.assertId("worker.loops", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.loops", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        const rows = await this.#db.application_list_worker_loops.all<{
            id: number;
            workerId: number;
            sequence: number;
            status: number;
            prompt: string;
            promptSource: string | null;
            claimedAt: string | null;
            terminatedAt: string | null;
            terminalResult: string | null;
            packetCount: number;
            waitUntil: number | null;
            invocationWorkerId: number | null;
            invocation: string | null;
        }>({ worker_id: workerId });
        return rows.map((row) => ({
            id: row.id,
            workerId: row.workerId,
            sequence: row.sequence,
            status: row.status,
            prompt: row.prompt,
            promptSource: row.promptSource,
            claimedAt: row.claimedAt,
            terminatedAt: row.terminatedAt,
            packetCount: row.packetCount,
            waitUntil: row.waitUntil,
            invocation: row.invocation === null || row.invocationWorkerId === null ? null : { workerId: row.invocationWorkerId, address: row.invocation },
            // {§validation-topology}: a stored result is chapter 3's (`loops_terminal_result_contract`); it is parsed, not re-asserted.
            terminalResult: row.terminalResult === null ? null : Results.fromRow(row.terminalResult) }));
    }
    // {§methods-workspace-prompts}: root-worker loop seeds, newest-first.
    // {§share} — one workspace's share. The daemon names its own database; the caller names an absolute folder.
    async shareWorkspace({ workspaceId, folder }: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.share", "workspaceId", workspaceId);
        const checkedFolder = ClientInput.assertShareFolder("workspace.share", folder);
        if (this.#dbPath === undefined) throw new Error("this daemon was started without its database path");
        return await Share.write({ openEvidence: EvidenceReader.open, dbPath: this.#dbPath, folder: checkedFolder, workspaceId: checkedWorkspaceId });
    }

    listPrompts(workspaceId: number, limit?: number, workerId?: number): Promise<string[]> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.prompts", "workspaceId", workspaceId);
        const checkedLimit = ClientInput.assertLimit("workspace.prompts", limit);
        const checkedWorkerId = workerId === undefined ? null : ClientInput.assertId("workspace.prompts", "workerId", workerId);
        return Envelope.listPromptsForWorkspace(this.#db, checkedWorkspaceId, checkedLimit ?? Knob.integer("PLURNK_SERVICE_PROMPTS_PAGE", 1), checkedWorkerId);
    }
    // {§methods-workspace-activate} — the demand a turn makes, without the turn: a cold workspace activates,
    // a concurrent demand shares that activation, and the release leaves it warm under the residency policy.
    async activateWorkspace(args: { readonly workspaceId: number }): Promise<void> {
        const workspaceId = ClientInput.assertId("workspace.activate", "workspaceId", args.workspaceId);
        const release = await this.#residency.acquire(workspaceId);
        release();
    }

    workspacePreparationStatus(workspaceId: number): readonly FunctionalityPreparationActivity[] {
        return this.#functionality.preparationStatus(
            ClientInput.assertId("workspace preparation", "workspaceId", workspaceId),
        );
    }

    workspaceDerivationStatus(workspaceId: number): WorkspaceDerivationStatus | null {
        return this.#engine.workspaceDerivationStatus(
            ClientInput.assertId("workspace.derivation", "workspaceId", workspaceId),
        );
    }

    // {§methods-workspace-create}: the module owns protocol decoding; core validates the typed seam
    // inputs and owns the envelope, its reserved-name + name-uniqueness invariants,
    // membership resolution and the workspace/created emit. No connection state
    // (which client is on which workspace) lives here — that's the module's.
    async createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object }): Promise<ClientEnvelope> {
        // The seam fails hard on malformed semantic input so every module inherits one wall:
        // the settings bag ({§operator-config-workspace-settings}) and absolute projectRoot.
        const explicit = ClientInput.assertOptionalWorkspaceName("workspace.create", "name", args.name);
        const projectRoot = ClientInput.assertProjectRoot("workspace.create", args.projectRoot);
        const settings = ClientInput.parseSettings(args.settings);
        // {§workspace-name} — with a project root and no name, the workspace is named after the root with
        // the daemon's home abbreviated to `~`, and that name selects the existing workspace when one exists:
        // a default is a convention shared by every client, never a second workspace.
        const derived = explicit === undefined && projectRoot !== null ? this.#hostPaths.abbreviateUserPath(projectRoot) : undefined;
        const selected = async (): Promise<ClientEnvelope | undefined> => {
            if (derived === undefined) return undefined;
            const existing = await this.#db.envelope_get_workspace_by_name.get<{ id: number }>({ name: derived });
            return existing === undefined ? undefined : this.#labelled(await Envelope.attachToWorkspace(this.#db, existing.id));
        };
        return observed( // {§observability-boundary}
            "workspace.create",
            {},
            async (span) => {
                const already = await selected();
                if (already !== undefined) {
                    span.setAttribute("workspace.id", already.workspaceId);
                    return already;
                }
                let envelope: ClientEnvelope;
                try {
                    envelope = this.#labelled(await Envelope.createClientEnvelope(this.#db, { name: explicit ?? derived, projectRoot, settings }));
                } catch (error) {
                    // A concurrent default launch created it first: select what it created.
                    const raced = derived !== undefined ? await selected() : undefined;
                    if (raced === undefined) throw error;
                    span.setAttribute("workspace.id", raced.workspaceId);
                    return raced;
                }
                span.setAttribute("workspace.id", envelope.workspaceId);
                this.#broadcast("all", "workspace/created", { id: envelope.workspaceId, name: envelope.workspaceName, projectRoot: envelope.projectRoot, projectLabel: envelope.projectLabel });
                return envelope;
            },
        );
    }

    // {§methods-workspace-attach} Selection is passive and never searches by the stored project folder.
    async attachWorkspace(args: Parameters<ApplicationPort["attachWorkspace"]>[0]): Promise<ClientEnvelope> {
        const selectors = (["workspaceId", "name", "projectRoot"] as const).filter((key) => Object.hasOwn(args, key));
        if (selectors.length !== 1 || args[selectors[0]] == null) {
            throw daemonFailure("daemon:workspace", "identity-invalid", 400,
                "Workspace selection requires exactly one ID, name or project root.", { retryable: false });
        }
        if (Object.hasOwn(args, "workspaceId")) {
            const workspaceId = ClientInput.assertId("workspace.attach", "workspaceId", args.workspaceId);
            return this.#labelled(await Envelope.attachToWorkspace(this.#db, workspaceId));
        }
        const name = Object.hasOwn(args, "name")
            ? ClientInput.assertOptionalName("workspace.attach", "name", args.name)!
            : this.#hostPaths.abbreviateUserPath(ClientInput.assertProjectRoot("workspace.attach", args.projectRoot)!);
        const existing = await this.#db.envelope_get_workspace_by_name.get<{ id: number }>({ name });
        if (existing === undefined) {
            throw daemonFailure("daemon:workspace", "workspace-not-found", 404,
                `Workspace ${JSON.stringify(name)} does not exist.`, { name });
        }
        return this.#labelled(await Envelope.attachToWorkspace(this.#db, existing.id));
    }

    // {§worker-external-reference} The adapter interprets the key; core retains its target by identity.
    async readWorkerReference(args: Parameters<ApplicationPort["readWorkerReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["readWorkerReference"]>>> {
        return WorkerReferences.read(this.#db, args);
    }

    async ensureWorkerReference(args: Parameters<ApplicationPort["ensureWorkerReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["ensureWorkerReference"]>>> {
        const { binding, created } = await WorkerReferences.ensure(this.#db, args);
        if (created) {
            const env = await this.attachWorkspace(binding);
            this.#broadcast("all", "workspace/created", { id: env.workspaceId, name: env.workspaceName, projectRoot: env.projectRoot, projectLabel: env.projectLabel });
        }
        return binding;
    }

    async listWorkerReferences({ workspaceId, workerId, namespace }: Parameters<ApplicationPort["listWorkerReferences"]>[0]): Promise<string[]> {
        await this.#assertWorkerOwned(workspaceId, workerId);
        return (await this.#db.worker_reference_list.all<{ reference: string }>({ namespace, worker_id: workerId })).map(({ reference }) => reference);
    }

    rollback(args: { workspaceId: number; workerId: number; actor: string; to: string }): Promise<RollbackReport> {
        return this.#clientOperations.rollback(args);
    }

    async renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.rename", "workspaceId", workspaceId);
        const checkedName = ClientInput.assertOptionalWorkspaceName("workspace.rename", "name", name);
        if (checkedName === undefined) throw new Error("ClientInput.assertOptionalWorkspaceName accepted a required name as undefined");
        return { id: checkedWorkspaceId, name: await Envelope.updateWorkspaceName(this.#db, checkedWorkspaceId, checkedName) };
    }

    // {§methods-worker-create}: a fresh worker is model-origin, with an empty private log.
    // {§machine-processes} Workers have independent histories within a shared workspace.
    async createWorker(args: ApplicationWorkerCreation): Promise<{ workerId: number; workerName: string }> {
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
        const parentWorkerId = args.parentWorkerId === undefined ? undefined : ClientInput.assertId("worker.create", "parentWorkerId", args.parentWorkerId);
        if (parentWorkerId !== undefined) {
            if (args.owner !== undefined) throw daemonFailure("worker:owner", "child-owner-inherited", 400,
                "A child inherits its parent's owner.", { workspaceId, parentWorkerId });
            const parent = await this.readWorker({ workspaceId, identity: { id: parentWorkerId } });
            if (parent === null) throw daemonFailure("worker:owner", "worker-not-found", 404,
                `Parent worker ${parentWorkerId} does not belong to workspace ${workspaceId}.`, { workspaceId, parentWorkerId });
        } else if (args.owner !== undefined) {
            await WorkerOwners.registered(this.#db, workspaceId, args.owner);
        }
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number; origin: string }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId} by a ${taken.origin} worker.`,
                    { workspaceId, name, actualOrigin: taken.origin, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const worker = await Envelope.createModelWorker(this.#db, workspaceId, name, parentWorkerId, args.owner);
        return { workerId: worker.id, workerName: worker.name };
    }

    // {§worker-scheme-fork} — branch a worker's log while sharing its workspace.
    // Core owns the workspace check and immutable worker-name admission.
    async forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }> {
        const workspaceId = ClientInput.assertId("run.fork", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("run.fork", "workerId", args.workerId);
        const name = ClientInput.assertOptionalWorkerName("run.fork", "name", args.name);
        // {§machine-processes-worker-origin} A branch is a model's: only a model worker's log forks.
        await this.#workerModels.assertModelWorker(workspaceId, workerId);
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number; origin: string }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId} by a ${taken.origin} worker.`,
                    { workspaceId, name, actualOrigin: taken.origin, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const branchWorkerId = await Fork.fork(
            this.#db,
            workerId,
            name,
        );
        const branch = await this.#db.envelope_get_worker_by_id.get<{ name: string }>({ id: branchWorkerId });
        return { workerId: branchWorkerId, workerName: branch?.name ?? null, parentWorkerId: workerId };
    }

    async registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void> {
        const normalized = registrations.map((registration) => this.#normalizeRuntime(registration));
        this.#engine.registerRuntimes(normalized);
        await this.#residency.rematerializeActive();
    }

    async registerRuntime(registration: RuntimeRegistration): Promise<void> {
        await this.registerRuntimes([registration]);
    }

    async registerScheme(name: string, handler: SchemeHandler): Promise<void> {
        this.#schemes.register(name, handler);
        if (this.#residency.published) await this.#schemes.ready();
        await this.#residency.rematerializeActive();
    }

    registerResourceTreeScheme(name: string, source: ResourceTreeSource): Promise<void> {
        return this.registerScheme(name, new ResourceTreeScheme(name, source));
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
                detail: availability.detail },
            scheme };
    }

    // {§http-host} {§module-http-mounts} — a module mounts on the daemon's one listener exactly what it claimed;
    // the modules' owner keeps the claims. {§module-action-registration}: a module's actions, registered, listed and invoked.
    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void {
        this.#modules.registerHttpRoute(prefix, handler);
    }

    httpAddress(): { readonly host: string; readonly port: number } {
        return this.#modules.httpAddress();
    }

    registerModuleAction(registration: ModuleActionRegistration): void {
        this.#modules.registerAction(registration);
    }

    listModuleActions(): ModuleActionDescriptor[] {
        return this.#modules.listActions();
    }

    invokeModuleAction(name: string, params: Readonly<Record<string, unknown>>, context: ModuleActionContext): Promise<unknown> {
        return this.#modules.invokeAction(name, params, context);
    }

    registerWorkspaceCapabilityProvider(
        namespaceOwner: string,
        provider: WorkspaceCapabilityProvider,
    ): void {
        this.#residency.registerProvider(namespaceOwner, provider);
    }

    // {§module-functionality-adapter}
    registerFunctionalityAdapter(adapter: HostFunctionalityAdapter): FunctionalityFamilyHandle {
        return this.#functionality.register(adapter);
    }

    async readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        const snapshot = await EnvFunctionality.workspace(this.#db, workspaceId);
        return (ambient) => snapshot(ambient).env;
    }

    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string> {
        return this.#storage.directory(workspaceId, namespaceOwner);
    }

    async workspacePaths(workspaceId: number): ReturnType<HostSetupSeam["workspacePaths"]> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return workspacePaths(this.#hostPaths, workspace?.project_root ?? null);
    }

    // {§agent-plugins-hosting}
    readWorkspacePlugins(workspaceId: number): Promise<WorkspacePluginSet<AgentRootScope>> {
        return this.#plugins.read(workspaceId);
    }

    async readProvidedSkills(): ReturnType<HostSetupSeam["readProvidedSkills"]> {
        const tree = await PlurnkSkill.load(this.#nodeModulesPath);
        return new Map([[tree.document.name, tree]]);
    }

    // {§mcp-launch-environment}
    operatorEnvironment(): NodeJS.ProcessEnv {
        return ExecEnv.withoutOwnSecrets();
    }

    async readWorkerEnvironment(workspaceId: number, workerId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        await this.#assertWorkerOwned(workspaceId, workerId);
        const shared = await EnvFunctionality.workspace(this.#db, workspaceId);
        const row = await this.#db.worker_module_state_get.get<{ state: string }>({ worker_id: workerId, namespace_owner: ENV_OWNER });
        const state: unknown = row === undefined ? { version: 1, definitions: {} } : JSON.parse(row.state);
        return (ambient) => EnvFunctionality.compose(shared(ambient).env, state).env;
    }

    async readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown> {
        return this.#residency.readModuleState(workspaceId, namespaceOwner);
    }

    async replaceWorkspaceCapabilities(
        replacement: WorkspaceCapabilityReplacement,
        options: WorkspaceCapabilityPublication = {},
    ): Promise<void> {
        await this.#residency.replace(replacement, options);
    }

    get engine(): Engine { return this.#engine; }
    // {§credential-authority} — the file holding this boot's minted operator secret; null when the
    // secret is configured, the posture is off, or the daemon has no database path.
    get secretFile(): string | null { return this.#secretMinted ? this.#secretPath : null; }
    configurationNotices(): readonly Notice[] { return this.#configuration.notices(); }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    // {§module-discovery} — `owner` is the module's package name; diagnostics name it.
    registerModule(module: DaemonModule<HostSetupSeam>, owner: string): void {
        if (this.#started) throw new Error("registerModule: modules must be registered before daemon start");
        this.#modules.register(module, owner);
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("daemon already started");
        await this.#configuration.capture("file-creation", () => FileCreationPolicy.serviceScope());
        await this.#configuration.capture("effect-policy", () => EffectPolicy.validateConfiguration());
        await this.#configuration.capture("proposal-policy", () => ProposalPolicies.read());
        await this.#configuration.capture("wait", () => TurnDispositionHandler.configuredWaitSeconds());
        await this.#configuration.capture("execution", () => Exec.validateConfiguration());
        this.#retention = await this.#configuration.capture("retention", () => new Retention(this.#db, retentionPolicy()));
        this.#clientOperations.start();
        this.#started = true;
        // {§db-space-reclamation} — the file is brought to the policy's auto-vacuum mode before any work.
        if (this.#retention !== null) {
            const storage = await this.#retention.prepareStorage();
            if (storage.converted) {
                console.error(`database: converted to auto_vacuum=${this.#retention.policy.autoVacuum} (${storage.pagesBefore} → ${storage.pagesAfter} pages)`);
            }
        }
        this.#drains.start();
        this.#retention?.start((cause) => { console.error("retention pass failed:", cause instanceof Error ? cause.message : String(cause)); });

        // Mimetypes owns its own discovery scan over @plurnk/plurnk-mimetypes-*
        // packages; pre-warm it so first index render doesn't pay the cost.
        await this.#mimetypes.ready();
        for (const name of await this.#mimetypes.skippedPackages()) {
            console.warn(`mimetype discovery: '${name}' is discovered but untrusted (PLURNK_EXTENSIONS_TRUSTED_ONLY); not registered`);
        }

        // Discover + probe the installed executor siblings, then hand the
        // registry to the engine for exec dispatch ({§exec-registry-resolves}).
        const executors = await ExecutorRegistry.build({ cwd: this.#discoveryCwd });
        for (const { runtime, error } of executors.configurationErrors()) {
            this.#configuration.record(`executor:${runtime}`, error);
        }
        this.#engine.setExecutors(executors);
        this.#engine.setFunctionalityDocuments((workspaceId) => this.#functionality.documents(workspaceId));
        // {§question-tool} — the native request-user-input runtime, process-wide;
        // workspace admission gates its doc visibility and dispatch ({§workspace-capability-policy}).
        this.#engine.registerRuntimes([{
            tag: "question",
            entry: {
                executor: new QuestionTool({ runtime: "question", glyph: "❓" }),
                namespaceOwner: { kind: "module", name: "core" },
                glyph: "❓",
                summary: questionRuntimeDecl.summary,
                invocation: questionRuntimeDecl.invocation,
                details: questionRuntimeDecl.details ?? "",
                available: true,
                detail: "in-process" } }]);
        // {§exec} — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for execution dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their context in SchemeCtxImpl ({§extension-discovery}).
        await this.#schemes.discoverExternal(this.#discoveryCwd);
        // {§module-discovery} — discovery composes beside the service's explicit modules, then every module sets
        // up against this daemon as the seam ({§module-lifecycle}).
        await this.#modules.setup(this, { cwd: this.#discoveryCwd, hostPaths: this.#hostPaths });
        // {§credential-authority} — the posture is never an inference: a listening daemon that
        // authenticates needs a module that issues, and it writes a minted secret where same-user
        // clients read it before any mount is admitted; a configured or absent secret leaves no file.
        if (this.#http !== null && this.credentials.operatorSecret !== null && this.credentials.face() === null) {
            throw new Error("PLURNK_AUTH=1, and no module publishes an authorization server to issue credentials: install the client interface, or set PLURNK_AUTH=0");
        }
        if (this.#secretPath !== null) {
            if (this.#secretMinted && this.credentials.operatorSecret !== null) await Credentials.writeSecret(this.#secretPath, this.credentials.operatorSecret);
            else await Credentials.removeSecret(this.#secretPath);
        }
        await this.#schemes.ready();
        this.#residency.publish();

        await this.#recoverLifecycle();

        // {§module-lifecycle} — the daemon opened its one transport before admission ({§http-host});
        // modules mount their routes on it here, only after capability publication and durable
        // lifecycle recovery are complete. None opens a listener of its own.
        await this.#modules.start(this);
        this.#modules.admitMounts();
    }

    async #recoverLifecycle(): Promise<void> {
        await this.#db.recovery_settle_process_owners({});

        const orphanSources = await this.#db.recovery_orphan_message_sources.all<{
            loop_id: number;
            worker_id: number;
            origin: string;
        }>({});
        const invalidOrphan = orphanSources.find(({ origin }) => origin !== "model");
        if (invalidOrphan !== undefined) {
            throw new Error(
                `Orphaned provider work belongs to ${invalidOrphan.origin} worker ${invalidOrphan.worker_id}; only model workers may enter inference.`,
            );
        }
        for (const source of orphanSources) {
            await this.#drains.reconcileOrphanedMessages(source.worker_id, source.loop_id);
        }

        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§card-read-per-wake}
        const queued = await this.#db.recovery_queued_workers.all<{
            worker_id: number;
            workspace_id: number;
            origin: string;
        }>({});
        const invalidQueued = queued.find(({ origin }) => origin !== "model");
        if (invalidQueued !== undefined) {
            throw new Error(
                `Queued provider work belongs to ${invalidQueued.origin} worker ${invalidQueued.worker_id}; only model workers may enter inference.`,
            );
        }
        const parked = await this.#db.recovery_parked_workers.all<{
            worker_id: number;
            workspace_id: number;
            origin: string;
        }>({});
        const invalidParked = parked.find(({ origin }) => origin !== "model");
        if (invalidParked !== undefined) {
            throw new Error(
                `Parked provider work belongs to ${invalidParked.origin} worker ${invalidParked.worker_id}; only model workers may enter inference.`,
            );
        }
        for (const row of queued) {
            const started = await this.#drains.ensureDrain({
                workspaceId: row.workspace_id,
                workerId: row.worker_id,
                systemPrompt });
            started?.drainPromise.catch((err: unknown) => {
                if (this.#started) {
                    console.error(`recovered drain failed for worker ${row.worker_id}:`, err);
                }
            });
        }
        for (const row of parked) {
            await this.#drains.scheduleWakes(
                row.workspace_id,
                row.worker_id,
                systemPrompt,
            );
        }
    }

    async stop(deadline?: StopDeadline): Promise<void> {
        if (!this.#started) return;
        this.#started = false;

        // Stop every producer before refusing capability acquisition. A drain
        // already between queue claim and activation must observe its own abort,
        // not misclassify orderly shutdown as a capability failure.
        const derivationAbort = new DOMException("daemon stopping", "AbortError");
        this.#retention?.stop();
        this.#engine.cancelAllProposals("daemon_stopping");
        this.#engine.cancelDerivations(derivationAbort);
        this.#drains.beginStop("daemon_stopping");
        this.#clientOperations.beginStop("daemon_stopping");
        this.#residency.beginStop();

        const shutdown = deadline ?? new StopDeadline();

        // Stop accepting external work immediately, but do not await listener
        // closure before cancelling active workers: an SSE connection may itself be
        // waiting for the worker cancellation that follows.
        const modulePhases = this.#modules.beginStop();
        const moduleStop = shutdown.settle("modules stop", () => modulePhases.stop());

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
        // {§crash-only-stop} — the settle sequence is DEADLINE-BOUNDED: a child
        // that never closes (a wedged MCP server, a stuck stream) must not hang
        // the daemon forever. Past the deadline the waits are abandoned; the
        // process may exit with the WAL in place (SQLite recovers) rather than
        // leak as a live-but-wedged tree.
        const drainResult = await shutdown.settle("drains idle", () => this.#drains.idle());
        const clientResult = await shutdown.settle("client operations idle", () => this.#clientOperations.idle());
        const residencyResult = await shutdown.settle("workspace Functionality transitions", () => this.#residency.settle());
        // A boundary publication queued behind the last turn settles before
        // modules close and before the DB goes away ({§functionality-publication}).
        const functionalityResult = await shutdown.settle("functionality publications", () => this.#functionality.settle());
        const moduleStopResult = await moduleStop;
        const streamingResult = await shutdown.settle("streaming schemes idle", () => this.#drainStreamingSchemes());
        const derivationResult = await shutdown.settle("derivation drain", () => this.#engine.drainDerivations(derivationAbort));
        const mimetypeResult = this.#ownsMimetypes
            ? await shutdown.settle("mimetypes dispose", () => this.#mimetypes.dispose())
            : null;
        const schemeResult = await shutdown.settle("schemes close", () => this.#schemes.close());
        // Streaming and scheme closure are the last producers of synchronous
        // conclusion notifications. Join the supervisor-owned async tails only
        // after those producers settle, before the caller may close SQLite.
        const wakeResult = await shutdown.settle("drains idle (wake)", () => this.#drains.idle());
        const moduleCloseResult = await shutdown.settle("modules close", () => modulePhases.close());
        // {§db-maintenance-optimize} — the last database step before the caller closes SQLite:
        // planner statistics refreshed on the writer, bounded by SQLite's own analysis limit.
        // {§retention-policy} — the operator's retention runs once more before the statistics.
        const collectResult = await shutdown.settle("retention", async () => this.#retention?.run());
        const optimizeResult = await shutdown.settle("database optimize", () => this.#db.maintenance_optimize.run({}));
        const closeErrors = [
            moduleStopResult,
            moduleCloseResult,
            residencyResult,
            functionalityResult,
            drainResult,
            clientResult,
            streamingResult,
            derivationResult,
            collectResult,
            ...(mimetypeResult === null ? [] : [mimetypeResult]),
            schemeResult,
            wakeResult,
            optimizeResult,
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
        const exec = this.#schemes.get("exec");
        if (!(exec instanceof Exec)) return;
        // {§exec-lifetime} — a detached spawn ends with the daemon: nothing else ever aborts it.
        exec.abortDetached();
        await exec.idle();
    }



    /**
     * Emit a stream/event notification scoped to the workspace containing the
     * entry. ChannelWrite helpers (src/core/ChannelWrite.ts) invoke this when
     * they update channel content or state. SPEC {§notifications}.
     */
    notifyStreamEvent(workspaceId: number, event: StreamEventPayload): void {
        this.#broadcast({ workspaceId }, "stream/event", event);
    }

    /** Emit transient readable reasoning for an in-flight model call. */
    notifyReasoningEvent(workspaceId: number, event: ReasoningEventPayload): void {
        this.#broadcast({ workspaceId }, "reasoning/event", event);
    }

    /** Emit one admitted emission's text outside every operation ({§notifications-outside-event}). */
    notifyOutsideEvent(workspaceId: number, event: OutsideEventPayload): void {
        this.#broadcast({ workspaceId }, "outside/event", event);
    }

    /**
     * Emit a transient notice scoped to the workspace containing the loop.
     */
    notifyNotice(workspaceId: number, payload: { workerId: number | null; loopId: number; notice: Notice }): void {
        this.#broadcast({ workspaceId }, "notice/event", payload);
    }

    inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        return this.#drains.inject(args);
    }

    cancelDrain(workerId: number, reason: string = "user_cancelled"): boolean {
        return this.#drains.cancel(workerId, reason);
    }

    async cancelWorker(args: {
        workspaceId: number;
        workerId: number;
        reason?: string;
    }): Promise<void> {
        const workspaceId = ClientInput.assertId("worker.cancel", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.cancel", "workerId", args.workerId);
        await this.#assertWorkerOwned(workspaceId, workerId);
        await this.#drains.cancelWorkerTree(workerId, args.reason ?? "user_cancelled");
    }

    // Process-local stream activity is supplied to the drain owner through the
    // scheme registry rather than exposing that registry across the boundary.
    #workerHasActiveStreams(workerId: number): boolean {
        const exec = this.#schemes.get("exec");
        return exec instanceof Exec && exec.hasActiveSpawns(workerId);
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
                // is each subscriber's edge concern; the seam hands (workspaceId, method, params) raw.
                this.#emitTo(target.workspaceId, method, params);
            },
        );
    }

    async readEntry(...args: Parameters<ClientReads["readEntry"]>): ReturnType<ClientReads["readEntry"]> {
        return this.#reads.readEntry(...args);
    }

    async readLog(...args: Parameters<ClientReads["readLog"]>): ReturnType<ClientReads["readLog"]> {
        return this.#reads.readLog(...args);
    }

    async readReasoning(...args: Parameters<ClientReads["readReasoning"]>): ReturnType<ClientReads["readReasoning"]> {
        return this.#reads.readReasoning(...args);
    }

    async readStreams(...args: Parameters<ClientReads["readStreams"]>): ReturnType<ClientReads["readStreams"]> {
        return this.#reads.readStreams(...args);
    }
}
