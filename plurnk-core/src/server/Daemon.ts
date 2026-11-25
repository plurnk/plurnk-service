// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the transport-free module seam ({§rpc}).

import { dirname, resolve } from "node:path";
import {
    MCP_WORKSPACE_TRANSPORTS,
    Validator,
    isRecord,
    type ApplicationDaemonPolicy,
    type ApplicationEventHandler,
    type ApplicationMcpPolicy,
    type McpWorkspaceTransport,
    type ApplicationGauge,
    type ApplicationInboxMessage,
    type ApplicationLoopProjection,
    type ApplicationMessage,
    type ApplicationOwnerIdentity,
    type ApplicationPersonaProjection,
    type ApplicationRuntimeStreamHandler,
    type ApplicationServiceUpdateResult,
    type ApplicationSessionArchiving,
    type ApplicationSessionCreation,
    type ApplicationSessionDeletion,
    type ApplicationSessionIdentity,
    type ApplicationSessionOverview,
    type ApplicationSessionProjection,
    type ApplicationSessionQuery,
    type ApplicationSessionTitling,
    type ApplicationWorkspaceArchiving,
    type ClientDisplayCapabilities,
    type ClientEntryChannel,
    type ClientEnvelope,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type DaemonNotificationPayloadMap,
    type Effort,
    type FunctionalityFamilyHandle,
    type FunctionalityPreparationActivity,
    type MessageResource,
    type ModelCatalogPage,
    type ModelCatalogQuery,
    type ModelRoute,
    type Notice,
    type NotificationFilter,
    type NotificationReplayResult,
    type PlurnkStatement,
    type ProposalPolicy,
    type ProposalProjection,
    type ProposalResolution,
    type RollbackReport,
    type SessionOwner,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";
import { Share } from "@plurnk/plurnk-digest";
import { RuntimeDeclaration, type RuntimeRegistration } from "@plurnk/plurnk-execs";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { loadCatalogCache } from "@plurnk/plurnk-models";
import type {
    ClientToolCallInput,
    DaemonModule,
    ModuleActionContext,
    ModuleActionDescriptor,
    ModuleActionRegistration,
} from "@plurnk/plurnk-modules";
import { resolveActiveRoute, type Provider, type ProviderAccounting } from "@plurnk/plurnk-providers";
import type { ResourceTreeSource, SchemeHandler } from "@plurnk/plurnk-schemes";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { SERVICE_VERSION } from "../build-info.ts";
import type { StreamEventPayload } from "../core/ChannelWrite.ts";
import { contentWeight } from "../core/content-weight.ts";
import type { Db } from "../core/Db.ts";
import Engine, { type WorkspaceDerivationStatus } from "../core/Engine.ts";
import ExecutorRegistry, { type RegistryEntry } from "../core/ExecutorRegistry.ts";
import FileCreationPolicy from "../core/file-creation-policy.ts";
import HostPaths from "../core/HostPaths.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import MessageResources from "../core/MessageResources.ts";
import ProjectRootPolicy from "../core/ProjectRootPolicy.ts";
import ProposalPolicies from "../core/ProposalPolicies.ts";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import type { ReasoningEventPayload } from "../core/ReasoningEvent.ts";
import { OperationFailureError, type SchemeResult } from "../core/results.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import ServiceUpdater from "../core/ServiceUpdater.ts";
import type StopDeadline from "../core/StopDeadline.ts";
import { readInstructionsSystem } from "../core/teaching-corpus.ts";
import TurnDispositionHandler from "../core/TurnDispositionHandler.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import Exec from "../schemes/Exec.ts";
import ExecEnv from "../schemes/exec-env.ts";
import ResourceTreeScheme from "../schemes/ResourceTreeScheme.ts";
import { agentRootScopes, workspacePaths } from "./AgentRoots.ts";
import ClientInput from "./client-input.ts";
import { lowerClientToolCalls } from "./ClientCallLowering.ts";
import ClientOperations from "./ClientOperations.ts";
import ClientReads from "./ClientReads.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import Credentials from "./Credentials.ts";
import { recoverDaemonLifecycle, stopDaemon } from "./DaemonLifecycle.ts";
import DaemonModules from "./DaemonModules.ts";
import {
    readPendingClientInteractions,
    readPendingProposals,
    readSessionPolicy,
    readWorkspacePolicy,
    resolvePendingClientInteraction,
    resolvePendingProposal,
    setSessionPolicy,
    setWorkspacePolicy,
    type DaemonProposalPolicyResult,
} from "./DaemonProposalPolicies.ts";
import DrainSupervisor, { type DrainInjectionArgs, type DrainInjectionResult } from "./DrainSupervisor.ts";
import EnvFunctionality, { ENV_OWNER } from "./EnvFunctionality.ts";
import { bindDaemonExecScheme, createDaemonEnvFunctionality } from "./EnvSchemeWiring.ts";
import Functionality from "./Functionality.ts";
import FunctionalityManager from "./FunctionalityManager.ts";
import type HttpListener from "./HttpListener.ts";
import LogEntry from "./logEntry.ts";
import MembersFunctionality, { modelScope, serviceMembers } from "./MembersFunctionality.ts";
import MessageDelivery from "./MessageDelivery.ts";
import type {
    HostFunctionalityAdapter,
    HostSetupSeam,
    WorkspaceCapabilityProvider,
    WorkspaceCapabilityPublication,
    WorkspaceCapabilityReplacement,
} from "./ModuleHost.ts";
import NotificationHub, { type NotifyTarget } from "./NotificationHub.ts";
import NotificationsEndpoint from "./NotificationsEndpoint.ts";
import PlurnkSkill from "./PlurnkSkill.ts";
import Retention, { retentionPolicy } from "./Retention.ts";
import SessionModels, { type EffortSource } from "./SessionModels.ts";
import WorkspacePlaces from "./WorkspacePlaces.ts";
import WorkspaceResidency from "./WorkspaceResidency.ts";
import WorkspaceStorage from "./WorkspaceStorage.ts";

export type { NotifyTarget };
export type ChannelRow = { name: string } & ClientEntryChannel;
type DrainCallbacks = ConstructorParameters<typeof DrainSupervisor>[0];
type DrainRunLoopArgs = Parameters<DrainCallbacks["runLoop"]>[0];
type DrainRunLoopResult = Awaited<ReturnType<DrainCallbacks["runLoop"]>>;

export default class Daemon implements ApplicationPort, HostSetupSeam {
    static validateConfiguration(): void {
        ProjectRootPolicy.parse();
        FileCreationPolicy.serviceScope();
        EffectPolicy.validateConfiguration();
        ProposalPolicies.read();
        TurnDispositionHandler.configuredWaitSeconds();
        retentionPolicy();
        Exec.validateConfiguration();
        ExecutorRegistry.validateConfiguration();
        ServiceUpdater.validateConfiguration();
        NotificationsEndpoint.heartbeatMs();
        NotificationsEndpoint.bufferSize();
    }

    static validateWorkspaceConfiguration(): void {
        agentRootScopes();
        serviceMembers();
        modelScope();
    }

    static captureReloadableConfiguration(configuration: ConfigurationDiagnostics, hostPaths: HostPaths): void {
        configuration.captureSync("project-root-confinement", () => ProjectRootPolicy.parse(process.env, hostPaths.home));
        configuration.captureSync("file-creation", () => FileCreationPolicy.serviceScope());
        configuration.captureSync("effect-policy", () => EffectPolicy.validateConfiguration());
        configuration.captureSync("proposal-policy", () => ProposalPolicies.read());
        configuration.captureSync("wait", () => TurnDispositionHandler.configuredWaitSeconds());
        configuration.captureSync("retention", () => retentionPolicy());
        configuration.captureSync("execution", () => Exec.validateConfiguration(hostPaths));
        configuration.captureSync("executor-config", () => ExecutorRegistry.validateConfiguration());
        configuration.captureSync("updater", () => ServiceUpdater.validateConfiguration());
        configuration.captureSync("notifications", () => {
            NotificationsEndpoint.heartbeatMs();
            NotificationsEndpoint.bufferSize();
        });
        configuration.captureSync("workspace-config", () => {
            agentRootScopes();
            serviceMembers();
            modelScope();
        });
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
    readonly #http: HttpListener | null; // {§http-host}
    readonly serviceVersion = SERVICE_VERSION;
    readonly credentials: Credentials; // {§credential-authority} {§methods}
    #discoveryCwd: string;
    #started = false; // {§module-lifecycle}
    readonly #modules: DaemonModules;
    readonly #clientOperations: ClientOperations; // {§connection-lifecycle}
    readonly #delivery: MessageDelivery; // {§methods} {§machine-processes}
    #residency: WorkspaceResidency; // {§module-workspace-residency}
    readonly #functionality: Functionality; // {§functionality-coordinator}
    #retention: Retention | null = null; // {§content-store}
    #personaReader: ((workspaceId: number) => Promise<readonly ApplicationPersonaProjection[]>) | null = null;
    readonly #members: MembersFunctionality; // {§tools-resource-materialization}
    readonly #notifications = new NotificationHub();
    readonly notificationEpoch = this.#notifications.epoch;
    readonly #sessionModels: SessionModels;
    readonly #reads: ClientReads;
    readonly #storage: WorkspaceStorage;
    readonly #configuration: ConfigurationDiagnostics;
    readonly #places: WorkspacePlaces;
    readonly #reloadEnvironment: ((options?: { readonly force?: boolean }) => { readonly generation: number }) | undefined;
    readonly #workspaceEnvGenerations = new Map<number, number>();

    constructor({
        db,
        schemes,
        mimetypes,
        provider,
        nodeModulesPath,
        hostPaths = new HostPaths(),
        http = null,
        dbPath,
        configuration = new ConfigurationDiagnostics(),
        reloadEnvironment,
    }: {
        db: Db;
        schemes?: SchemeRegistry;
        mimetypes?: Mimetypes;
        provider?: Provider | null;
        nodeModulesPath?: string;
        hostPaths?: HostPaths;
        dbPath?: string; // {§share}
        http?: HttpListener | null;
        configuration?: ConfigurationDiagnostics;
        reloadEnvironment?: (options?: { readonly force?: boolean }) => { readonly generation: number };
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        try {
            loadCatalogCache(hostPaths.modelsCacheFile);
        } catch {
            /* ignore unreadable cache on boot */
        }
        this.#dbPath = dbPath;
        this.#http = http;
        this.#configuration = configuration;
        this.#reloadEnvironment = reloadEnvironment;
        this.credentials = new Credentials();
        this.#storage = new WorkspaceStorage(db, hostPaths);
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes ?? new SchemeRegistry();
        this.#provider = provider ?? null;
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
        this.#discoveryCwd = dirname(this.#nodeModulesPath);
        // {§copy} {§mimetype}
        this.#ownsMimetypes = mimetypes === undefined;
        this.#mimetypes = mimetypes ?? new Mimetypes({ discoverOptions: { cwd: this.#discoveryCwd } });
        const bootSpec = this.#provider === null ? null : resolveActiveRoute();
        if (this.#provider !== null && bootSpec !== null) {
            ProviderInstantiate.registerInstance(this.#provider, bootSpec);
        }
        this.#workspaceGate = new WorkspaceGate(async (sessionId, rootSessionId) => {
            const row = await this.#db.session_lineage_contains.get<{ member: number }>({
                session_id: sessionId,
                root_session_id: rootSessionId,
            });
            return row !== undefined;
        });
        this.#residency = new WorkspaceResidency({
            db,
            engine: () => this.#engine,
            workspaceGate: this.#workspaceGate,
            normalizeRuntime: (registration) => this.#normalizeRuntime(registration),
        });
        this.#modules = new DaemonModules({
            db,
            http: this.#http,
            configuration: this.#configuration,
            residency: this.#residency,
            workspaceGate: this.#workspaceGate,
            syncEnvironment: () => {
                this.#syncEnvironment();
            },
        });
        if (this.#http !== null) {
            this.#modules.register(new NotificationsEndpoint(), "@plurnk/plurnk-service");
        }
        this.#functionality = new Functionality({
            signal: this.#residency.signal,
            registerModuleAction: (registration) => this.registerModuleAction(registration),
            invokeModuleAction: (name, params, context) => this.invokeModuleAction(name, params, context),
            registerWorkspaceCapabilityProvider: (owner, capabilities) =>
                this.registerWorkspaceCapabilityProvider(owner, capabilities),
            readWorkspaceModuleState: (workspaceId, owner) => this.readWorkspaceModuleState(workspaceId, owner),
            replaceWorkspaceCapabilities: (replacement, options) =>
                this.replaceWorkspaceCapabilities(replacement, options),
            readSessionModuleState: (sessionId, owner) => this.#residency.readSessionModuleState(sessionId, owner),
            replaceSessionModuleState: (sessionId, owner, state) =>
                this.#residency.replaceSessionModuleState(sessionId, owner, state),
            withWorkspaceGate: (workspaceId, owner, gate, run, signal) =>
                this.#residency.exclusively(workspaceId, owner, gate, run, signal),
            atWorkspaceBoundary: (workspaceId, run) => this.#workspaceGate.atBoundary(workspaceId, run),
            retainWorkspace: (workspaceId) => this.#residency.retain(workspaceId),
            preparationChanged: (workspaceId, preparation) =>
                this.#notifications.emitRuntimeStream(workspaceId, "workspace/preparation", { workspaceId, preparation }),
            functionalityChanged: (workspaceId, sessionId, family) =>
                this.#notifications.broadcast({ workspaceId }, "functionality/changed", { workspaceId, sessionId, family }),
        });
        this.#members = new MembersFunctionality({ db, engine: () => this.#engine, home: this.#hostPaths.home, handle: () => membersHandle });
        const membersHandle = this.#functionality.register(this.#members);
        this.#functionality.register(
            createDaemonEnvFunctionality({
                db: this.#db,
                hostPaths: this.#hostPaths,
                mimetypes: this.#mimetypes,
                nodeModulesPath: this.#nodeModulesPath,
                functionality: this.#functionality,
                readSession: (a) => this.readSession(a),
                listSessions: (wsId) => this.listSessions(wsId),
            }),
        );
        bindDaemonExecScheme({
            db: this.#db,
            mimetypes: this.#mimetypes,
            schemes: this.#schemes,
            residency: this.#residency,
            functionality: this.#functionality,
        });
        this.#engine = new Engine({
            db,
            lifecycle: this.#lifecycle,
            schemes: this.#schemes,
            mimetypes: this.#mimetypes,
            hostPaths: this.#hostPaths,
            weigh: contentWeight, // {§tokenomics}
            streamEventNotify: (workspaceId, event) => this.notifyStreamEvent(workspaceId, event),
            operationSettledNotify: (workspaceId, logEntryId) => this.#drains.operationSettled(workspaceId, logEntryId),
            reasoningEventNotify: (workspaceId, event) => this.notifyReasoningEvent(workspaceId, event),
            wakeSessionNotify: (payload) => this.#drains.notifyWakeSession(payload),
            injectSession: (args) => this.#delivery.injectSession(args),
            resolvePersona: async (workspaceId, personaName) => {
                const personas = await (this.#personaReader?.(workspaceId) ?? Promise.resolve([]));
                return personas.find((p) => p.name === personaName) ?? null;
            },
            preflightSpawn: (args) => this.#delivery.preflightSpawn(args),
            withWorkspaceTurn: (workspaceId, sessionId, run, signal) =>
                this.#workspaceGate.withTurn(workspaceId, sessionId, run, signal),
            // {§functionality-inspection}
            workspaceTurnStarting: async ({ workspaceId }) => {
                const { generation } = this.#syncEnvironment();
                if (this.#workspaceEnvGenerations.get(workspaceId) !== generation) {
                    await this.#functionality.refreshAllIfChanged({ workspaceId }, { gate: "none" });
                    this.#workspaceEnvGenerations.set(workspaceId, generation);
                }
                await this.#functionality.refreshChanged({ workspaceId });
                return this.configurationNotices(workspaceId);
            },
            cancelSession: async (sessionId, reason) => this.#drains.cancelSessionTree(sessionId, reason),
            // {§membership-auto-add}
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
                this.#notifications.emitRuntimeStream(workspaceId, "loop/packet", payload);
            },
        });
        this.#drains = new DrainSupervisor({
            db,
            engine: this.#engine,
            lifecycle: this.#lifecycle,
            runLoop: (args) => this.#runDrainLoop(args),
            hasActiveStreams: (sessionId) => this.#sessionHasActiveStreams(sessionId),
            readSystemPrompt: () => readInstructionsSystem(), // {§packet-inject}
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#notifications.broadcast({ workspaceId }, "log/entry", { entry });
            },
            emit: (workspaceId, method, params) => {
                if (method === "notice/event") {
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- method narrowed to "notice/event"
                    this.notifyNotice(workspaceId, params as DaemonNotificationPayloadMap["notice/event"]);
                    return;
                }
                this.#notifications.broadcast({ workspaceId }, method, params);
            },
        });
        this.#engine.onProposalPending((event) => {
            const { workspaceId, ...proposal } = event;
            this.#notifications.broadcast({ workspaceId }, "loop/proposal", proposal);
        });
        this.#engine.onClientInteractionPending((event) => {
            const { workspaceId, ...interaction } = event;
            this.#notifications.broadcast({ workspaceId }, "loop/interaction", interaction);
        });
        this.#engine.onGateSettled((event) => {
            const { workspaceId, ...settled } = event;
            this.#notifications.broadcast({ workspaceId }, "loop/gate-settled", settled);
        });
        this.#sessionModels = new SessionModels({
            db: this.#db,
            provider: this.#provider,
            policyChanged: (sessionId) => this.#announceSessionPolicy(sessionId),
            sessionCurationOverflow: (sessionId, selectedProvider) =>
                this.#engine.sessionCurationOverflow(sessionId, selectedProvider),
        });
        this.#delivery = new MessageDelivery({
            db,
            sessionModels: this.#sessionModels,
            mimetypes: this.#mimetypes,
            inject: (args) => this.inject(args),
            sessionCreated: (workspaceId, sessionId) => this.#places.announceSessionCreated(workspaceId, sessionId),
        });
        this.#reads = new ClientReads({
            db: this.#db,
            engine: this.#engine,
            workspaceGate: this.#workspaceGate,
            residency: this.#residency,
        });
        this.#places = new WorkspacePlaces({
            db: this.#db,
            hostPaths: this.#hostPaths,
            engine: () => this.#engine,
            sessionModels: () => this.#sessionModels,
            resolvePersona: async (workspaceId, personaName) => {
                const personas = await (this.#personaReader?.(workspaceId) ?? Promise.resolve([]));
                return personas.find((p) => p.name === personaName) ?? null;
            },
            personaPolicyChanged: (sessionId, persona) => this.#announceSessionPolicy(sessionId, { persona }),
            broadcast: (target, method, params) => this.#notifications.broadcast(target, method, params),
        });
        this.#clientOperations = new ClientOperations({
            db,
            engine: this.#engine,
            residency: this.#residency,
            workspaceGate: this.#workspaceGate,
            assertModelSession: (workspaceId, sessionId) =>
                this.#sessionModels.assertModelSession(workspaceId, sessionId),
            assertSessionOwned: (workspaceId, sessionId) => this.#places.assertSessionOwned(workspaceId, sessionId),
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#notifications.broadcast({ workspaceId }, "log/entry", { entry });
            },
        });
    }

    #syncEnvironment(options?: { readonly force?: boolean }): { readonly generation: number } {
        const result = this.#reloadEnvironment?.(options) ?? { generation: 0 };
        if (result.generation > 0) ProviderInstantiate.advanceGeneration(result.generation);
        return result;
    }

    async reloadEnvironmentNow(options: { readonly force?: boolean } = {}): Promise<void> {
        const { generation } = this.#syncEnvironment(options);
        if (!this.#started) return;
        for (const workspaceId of this.#residency.activeWorkspaceIds()) {
            if (this.#workspaceEnvGenerations.get(workspaceId) === generation) continue;
            try {
                await this.#functionality.refreshAllIfChanged({ workspaceId }, { gate: "try" });
                this.#workspaceEnvGenerations.set(workspaceId, generation);
            } catch (cause) {
                if (cause instanceof OperationFailureError && cause.result.status === 409) continue;
                throw cause;
            }
        }
    }

    async #runDrainLoop({
        workspaceId,
        sessionId,
        loopId,
        maxTurns,
        prompt,
        systemPrompt,
        signal,
        onSettled,
    }: DrainRunLoopArgs): Promise<DrainRunLoopResult> {
        this.#syncEnvironment();
        await this.#sessionModels.assertModelSession(workspaceId, sessionId);
        const releaseCapabilities = await this.#residency.acquire(workspaceId);
        try {
            await this.#residency.reconcile(workspaceId);
            const { provider: loopProvider, childProvider } = await this.#sessionModels.providersForLoop(loopId);
            return await this.#engine.runLoop({
                provider: loopProvider,
                childProvider,
                resolveProviders: () => {
                    this.#syncEnvironment();
                    return this.#sessionModels.providersForLoop(loopId);
                },
                workspaceId,
                sessionId,
                loopId,
                maxTurns,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt },
                ],
                signal,
                onSettled,
            });
        } finally {
            releaseCapabilities();
        }
    }

    subscribeToEvents(handler: ApplicationEventHandler, filter?: NotificationFilter): () => void {
        return this.#notifications.subscribeToEvents(handler, filter);
    }

    subscribeToRuntimeStream(handler: ApplicationRuntimeStreamHandler): () => void {
        return this.#notifications.subscribeToRuntimeStream(handler);
    }

    replayNotifications(args: {
        readonly lastEventId: string;
        readonly filter?: NotificationFilter;
    }): NotificationReplayResult {
        return this.#notifications.replay(args);
    }

    registerSessionOwner(workspaceId: number, owner: SessionOwner): Promise<void> {
        return this.#places.registerSessionOwner(workspaceId, owner);
    }

    claimSessionOwner(args: { workspaceId: number; sessionId: number; owner: string }): Promise<SessionOwner> {
        return this.#places.claimSessionOwner(args);
    }

    pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        return readPendingProposals(this.#engine, workspaceId);
    }

    resolveProposal(logEntryId: number, resolution: ProposalResolution, owner: ApplicationOwnerIdentity): Promise<void> {
        return resolvePendingProposal(this.#db, this.#engine, logEntryId, resolution, owner);
    }

    pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]> {
        return readPendingClientInteractions(this.#engine, workspaceId);
    }

    resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
        respondent: ApplicationOwnerIdentity,
        message?: { readonly body: string; readonly source: string; readonly envelope: Readonly<Record<string, unknown>> },
    ): Promise<void> {
        return resolvePendingClientInteraction(this.#engine, interactionId, resolution, respondent, message);
    }

    async readMessages(args: { workspaceId: number; sessionId: number; loopId?: number }): Promise<ApplicationMessage[]> {
        await this.#sessionModels.assertModelSession(args.workspaceId, args.sessionId);
        return MessageResources.read(this.#db, args);
    }

    async readInbox(args: { workspaceId: number; sessionId: number }): Promise<ApplicationInboxMessage[]> {
        await this.#sessionModels.assertModelSession(args.workspaceId, args.sessionId);
        return MessageResources.inbox(this.#db, args);
    }

    async readOpenMessages(args: { workspaceId: number; sessionId: number }): Promise<ApplicationInboxMessage[]> {
        await this.#sessionModels.assertModelSession(args.workspaceId, args.sessionId);
        return MessageResources.open(this.#db, args);
    }

    async messageAdmission(args: { workspaceId: number; address: string; body: string }): Promise<"new" | "accepted"> {
        const workspaceId = ClientInput.assertId("messageAdmission", "workspaceId", args.workspaceId);
        return await MessageResources.admission(this.#db, workspaceId, args.address, args.body);
    }

    runLoop(args: {
        workspaceId: number;
        sessionId: number;
        loopId?: number;
        prompt: string;
        source?: string;
        messageAddress?: string;
        attachments?: readonly MessageResource[];
        envelope?: Readonly<Record<string, unknown>>;
        maxTurns?: number;
        openPaths?: string[];
        selector?: string;
        childSelector?: string | null;
        proposalPolicy?: ProposalPolicy | null;
    }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        this.#syncEnvironment();
        return this.#delivery.runLoop(args);
    }

    ensureRuntimeSession(workspaceId: number): Promise<number> {
        return this.#places.ensureRuntimeSession(workspaceId);
    }

    readWorkspaceProposalPolicy(args: { readonly workspaceId: number }): Promise<DaemonProposalPolicyResult> {
        this.#syncEnvironment();
        return readWorkspacePolicy(this.#db, args.workspaceId);
    }

    readSessionProposalPolicy(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<DaemonProposalPolicyResult> {
        this.#syncEnvironment();
        return readSessionPolicy(this.#db, this.#sessionModels, args.workspaceId, args.sessionId);
    }

    setSessionProposalPolicy(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly policy: ProposalPolicy | null;
    }): Promise<DaemonProposalPolicyResult> {
        this.#syncEnvironment();
        return setSessionPolicy({
            db: this.#db,
            engine: this.#engine,
            sessionModels: this.#sessionModels,
            announceSessionPolicy: (sessionId) => this.#announceSessionPolicy(sessionId),
            ...args,
        });
    }

    setWorkspaceProposalPolicy(args: {
        readonly workspaceId: number;
        readonly policy: ProposalPolicy | null;
    }): Promise<DaemonProposalPolicyResult> {
        this.#syncEnvironment();
        return setWorkspacePolicy(this.#db, args.workspaceId, args.policy);
    }

    // {§session-model-selection}
    readSessionModel(args: { workspaceId: number; sessionId: number }): Promise<{ model: ModelRoute | null; childModel: ModelRoute | null }> {
        this.#syncEnvironment();
        return this.#sessionModels.readSessionModel(args);
    }

    setSessionModel(args: { workspaceId: number; sessionId: number; selector: string; effort?: unknown }): Promise<ModelRoute> {
        this.#syncEnvironment();
        return this.#sessionModels.setSessionModel(args);
    }

    readSessionEffort(args: { workspaceId: number; sessionId: number }): Promise<{ effort: Effort | null; source: EffortSource; supportedEfforts: readonly Effort[] }> {
        this.#syncEnvironment();
        return this.#sessionModels.readSessionEffort(args);
    }

    setSessionEffort(args: { workspaceId: number; sessionId: number; effort: unknown }): Promise<{ effort: Effort; source: "explicit"; supportedEfforts: readonly Effort[] }> {
        this.#syncEnvironment();
        return this.#sessionModels.setSessionEffort(args);
    }

    setSessionChildModel(args: { workspaceId: number; sessionId: number; selector: string | null }): Promise<ModelRoute | null> {
        this.#syncEnvironment();
        return this.#sessionModels.setSessionChildModel(args);
    }

    // {§functionality-model-projection}
    async settleFunctionality(workspaceId?: number): Promise<void> {
        await this.#functionality.settle(workspaceId);
    }

    executorTags(workspaceId: number): readonly string[] {
        return this.#engine.executorTags(workspaceId);
    }

    dispatchClientAction(args: {
        workspaceId: number;
        actor: string;
        contextSessionId?: number;
        statements: PlurnkStatement[];
        onLoop?: (loop: { sessionId: number; loopId: number }) => void;
    }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        this.#syncEnvironment();
        return this.#clientOperations.dispatchClientAction(args);
    }

    cancelLoop(args: { workspaceId: number; loopId: number; reason?: string }): Promise<boolean> {
        return this.#clientOperations.cancelLoop(args);
    }

    cancelStream(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly entryId?: number;
        readonly target?: string;
        readonly coordinate?: string;
    }): Promise<boolean> {
        return this.#clientOperations.cancelStream(args);
    }

    listProviders(): ReturnType<ApplicationPort["listProviders"]> {
        this.#syncEnvironment();
        return this.#sessionModels.listProviders();
    }

    listModels(query: ModelCatalogQuery): ModelCatalogPage {
        this.#syncEnvironment();
        return this.#sessionModels.listModels(query);
    }

    // {§mcp-server-definition}
    async listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities> {
        const schemes: ClientDisplayCapabilities = this.#schemes
            .list()
            .filter((scheme) => scheme !== "exec")
            .map((scheme) => {
                const glyph = this.#schemes.manifestFor(scheme)?.glyph;
                return {
                    kind: "scheme" as const,
                    scheme,
                    display: glyph === undefined ? {} : { glyph },
                };
            });
        const mimetypes: ClientDisplayCapabilities = (await this.#mimetypes.displayMetadata()).map(
            ({ mimetype, glyph }) => ({
                kind: "mimetype" as const,
                mimetype,
                display: glyph.length === 0 ? {} : { glyph },
            }),
        );
        return Validator.assertClientDisplayCapabilities([...schemes, ...mimetypes]);
    }

    listWorkspaces(query: { readonly archived?: boolean } = {}): ReturnType<ApplicationPort["listWorkspaces"]> {
        return this.#places.listWorkspaces(query);
    }

    async listPersonas(args: { readonly workspaceId: number }): Promise<readonly ApplicationPersonaProjection[]> {
        const workspaceId = ClientInput.assertId("workspace.personas.list", "workspaceId", args.workspaceId);
        return await (this.#personaReader?.(workspaceId) ?? Promise.resolve([]));
    }

    setSessionPersona(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly persona: string | null;
    }): Promise<{ readonly persona: string | null }> {
        this.#syncEnvironment();
        return this.#places.setSessionPersona(args);
    }

    listSessions(workspaceId: number, query: ApplicationSessionQuery = {}): Promise<ApplicationSessionProjection[]> {
        return this.#places.listSessions(workspaceId, query);
    }

    readSession(args: { workspaceId: number; identity: ApplicationSessionIdentity }): Promise<ApplicationSessionProjection | null> {
        return this.#places.readSession(args);
    }

    sessionAccounting(args: { workspaceId: number; sessionId: number }): Promise<ProviderAccounting> {
        return this.#places.sessionAccounting(args);
    }

    sessionGauge(args: { workspaceId: number; sessionId: number }): Promise<ApplicationGauge> {
        return this.#places.sessionGauge(args);
    }

    listSessionLoops(args: { workspaceId: number; sessionId: number }): Promise<ApplicationLoopProjection[]> {
        return this.#places.listSessionLoops(args);
    }

    readSessionOverview(args: { readonly workspaceId?: number; readonly limit: number; readonly excerptChars: number }): Promise<ApplicationSessionOverview> {
        return this.#places.readSessionOverview(args);
    }

    // {§share}
    async shareWorkspace({ workspaceId, folder }: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.share", "workspaceId", workspaceId);
        const checkedFolder = ClientInput.assertShareFolder("workspace.share", folder);
        if (this.#dbPath === undefined) throw new Error("this daemon was started without its database path");
        return await Share.write({
            openEvidence: EvidenceReader.open,
            dbPath: this.#dbPath,
            folder: checkedFolder,
            workspaceId: checkedWorkspaceId,
        });
    }

    // {§startup-admission}
    async updateService(): Promise<ApplicationServiceUpdateResult> {
        return await ServiceUpdater.run({ hostPaths: this.#hostPaths });
    }

    listPrompts(workspaceId: number, limit?: number, sessionId?: number): Promise<string[]> {
        return this.#places.listPrompts(workspaceId, limit, sessionId);
    }

    // {§methods-workspace-create}
    async activateWorkspace(args: { readonly workspaceId: number }): Promise<void> {
        this.#syncEnvironment();
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

    // {§operator-config-workspace-settings}
    daemonPolicy(): ApplicationDaemonPolicy {
        this.#syncEnvironment();
        let projectRoot: ApplicationDaemonPolicy["projectRoot"] = "none";
        try {
            projectRoot = ProjectRootPolicy.parse(process.env, this.#hostPaths.home).mode;
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
        }
        const rawMcp = this.#functionality.policy("mcp");
        let mcp: ApplicationMcpPolicy | undefined;
        if (
            isRecord(rawMcp)
            && Array.isArray(rawMcp.workspaceTransports)
            && rawMcp.workspaceTransports.every((item): item is McpWorkspaceTransport =>
                typeof item === "string" && (MCP_WORKSPACE_TRANSPORTS as readonly string[]).includes(item))
            && typeof rawMcp.publicOnly === "boolean"
        ) {
            mcp = {
                workspaceTransports: [...rawMcp.workspaceTransports],
                publicOnly: rawMcp.publicOnly,
            };
        }
        return {
            projectRoot,
            ...(mcp === undefined ? {} : { mcp }),
        };
    }

    createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object }): Promise<ClientEnvelope> {
        this.#syncEnvironment();
        return this.#places.createWorkspace(args);
    }

    attachWorkspace(args: Parameters<ApplicationPort["attachWorkspace"]>[0]): Promise<ClientEnvelope> {
        this.#syncEnvironment();
        return this.#places.attachWorkspace(args);
    }

    readSessionReference(args: Parameters<ApplicationPort["readSessionReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["readSessionReference"]>>> {
        return this.#places.readSessionReference(args);
    }

    ensureSessionReference(args: Parameters<ApplicationPort["ensureSessionReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["ensureSessionReference"]>>> {
        return this.#places.ensureSessionReference(args);
    }

    listSessionReferences(args: Parameters<ApplicationPort["listSessionReferences"]>[0]): Promise<string[]> {
        return this.#places.listSessionReferences(args);
    }

    rollback(args: { workspaceId: number; sessionId: number; actor: string; to: string }): Promise<RollbackReport> {
        return this.#clientOperations.rollback(args);
    }

    renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        return this.#places.renameWorkspace(workspaceId, name);
    }

    setWorkspaceArchived(args: { readonly workspaceId: number; readonly archived: boolean }): Promise<ApplicationWorkspaceArchiving> {
        return this.#places.setWorkspaceArchived(args);
    }

    setSessionArchived(args: { readonly workspaceId: number; readonly sessionId: number; readonly archived: boolean }): Promise<ApplicationSessionArchiving> {
        return this.#places.setSessionArchived(args);
    }

    deleteSession(args: { readonly workspaceId: number; readonly sessionId: number }): Promise<ApplicationSessionDeletion> {
        return this.#places.deleteSession(args);
    }

    setSessionTitle(args: { readonly workspaceId: number; readonly sessionId: number; readonly title: string }): Promise<ApplicationSessionTitling> {
        return this.#places.setSessionTitle(args);
    }

    createSession(args: ApplicationSessionCreation): Promise<{ sessionId: number; sessionName: string }> {
        this.#syncEnvironment();
        return this.#places.createSession(args);
    }

    forkSession(args: { workspaceId: number; sessionId: number; name?: string }): Promise<{ sessionId: number; sessionName: string | null; parentSessionId: number }> {
        this.#syncEnvironment();
        return this.#places.forkSession(args);
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
        if (this.#residency.published) await this.#configuration.capture("schemes", () => this.#schemes.ready());
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
                available: availability.available,
                detail: availability.detail,
            },
            scheme,
        };
    }

    // {§http-host} {§module-contract} {§module-seam-slices}
    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void {
        this.#modules.registerHttpRoute(prefix, handler);
    }

    registerHttpUpgrade(prefix: string, handler: HttpUpgradeHandler): void {
        this.#modules.registerHttpUpgrade(prefix, handler);
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
        this.#syncEnvironment();
        return this.#modules.invokeAction(name, params, context);
    }

    registerWorkspaceCapabilityProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void {
        this.#residency.registerProvider(namespaceOwner, provider);
    }

    registerFunctionalityAdapter(adapter: HostFunctionalityAdapter): FunctionalityFamilyHandle {
        return this.#functionality.register(adapter);
    }

    registerPersonaReader(reader: (workspaceId: number) => Promise<readonly ApplicationPersonaProjection[]>): void {
        if (this.#personaReader !== null) throw new Error("registerPersonaReader: persona reader is already registered");
        this.#personaReader = reader;
    }

    async readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        const snapshot = await EnvFunctionality.workspace(this.#db, workspaceId, this.#hostPaths);
        return (ambient) => snapshot(ambient).env;
    }

    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string> {
        return this.#storage.directory(workspaceId, namespaceOwner);
    }

    async workspacePaths(workspaceId: number): ReturnType<HostSetupSeam["workspacePaths"]> {
        const workspace = await this.#db.envelope_get_workspace.get<{ name: string; project_root: string | null }>({
            id: workspaceId,
        });
        return {
            ...workspacePaths(this.#hostPaths, workspace?.project_root ?? null),
            ...(workspace === undefined ? {} : { workspaceName: workspace.name }),
        };
    }

    async readProvidedSkills(): ReturnType<HostSetupSeam["readProvidedSkills"]> {
        const tree = await PlurnkSkill.load(this.#nodeModulesPath);
        return new Map([[tree.document.name, tree]]);
    }

    // {§mcp-module}
    operatorEnvironment(): NodeJS.ProcessEnv {
        return ExecEnv.withoutOwnSecrets(process.env, this.#hostPaths);
    }

    async readSessionEnvironment(workspaceId: number, sessionId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        await this.#places.assertSessionOwned(workspaceId, sessionId);
        const shared = await EnvFunctionality.workspace(this.#db, workspaceId, this.#hostPaths);
        const row = await this.#db.session_module_state_get.get<{ state: string }>({
            session_id: sessionId,
            namespace_owner: ENV_OWNER,
        });
        const state: unknown = row === undefined ? { version: 1, definitions: {} } : JSON.parse(row.state);
        return (ambient) => EnvFunctionality.compose(shared(ambient).env, state).env;
    }

    async readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown> {
        return this.#residency.readModuleState(workspaceId, namespaceOwner);
    }

    async writeWorkspaceModuleState(workspaceId: number, namespaceOwner: string, state: unknown): Promise<void> {
        const key = { workspace_id: workspaceId, namespace_owner: namespaceOwner };
        if (state === null || state === undefined) {
            await this.#db.workspace_module_state_delete.run(key);
        } else {
            await this.#db.workspace_module_state_put.run({ ...key, state: JSON.stringify(state) });
        }
    }

    async lowerClientCalls(calls: readonly ClientToolCallInput[], workspaceId?: number): Promise<readonly PlurnkStatement[]> {
        return lowerClientToolCalls(calls, this.#engine.executors, workspaceId);
    }

    async replaceWorkspaceCapabilities(
        replacement: WorkspaceCapabilityReplacement,
        options: WorkspaceCapabilityPublication = {},
    ): Promise<void> {
        await this.#residency.replace(replacement, options);
    }

    get engine(): Engine { return this.#engine; }
    get drains(): DrainSupervisor { return this.#drains; }
    configurationNotices(workspaceId?: number): readonly Notice[] {
        this.#syncEnvironment();
        if (workspaceId === undefined) return this.#configuration.notices();
        const combined = new Map<string, Notice>();
        for (const notice of [
            ...this.#configuration.notices(),
            ...this.#functionality.configurationNotices(workspaceId),
        ]) {
            combined.set(JSON.stringify(notice), notice);
        }
        return [...combined.values()];
    }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    registerModule(module: DaemonModule<HostSetupSeam>, owner: string): void {
        if (this.#started) throw new Error("registerModule: modules must be registered before daemon start");
        this.#modules.register(module, owner);
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("daemon already started");
        await this.#configuration.capture("project-root-confinement", () => ProjectRootPolicy.parse(process.env, this.#hostPaths.home));
        await this.#configuration.capture("file-creation", () => FileCreationPolicy.serviceScope());
        await this.#configuration.capture("effect-policy", () => EffectPolicy.validateConfiguration());
        await this.#configuration.capture("proposal-policy", () => ProposalPolicies.read());
        await this.#configuration.capture("wait", () => TurnDispositionHandler.configuredWaitSeconds());
        await this.#configuration.capture("execution", () => Exec.validateConfiguration(this.#hostPaths));
        await this.#configuration.capture("notifications", () => {
            NotificationsEndpoint.heartbeatMs();
            NotificationsEndpoint.bufferSize();
        });
        this.#retention = await this.#configuration.capture("retention", () => new Retention(this.#db, retentionPolicy()));
        this.#clientOperations.start();
        this.#started = true;
        if (this.#retention !== null) {
            const storage = await this.#retention.prepareStorage();
            if (storage.converted) {
                console.error(`database: converted to auto_vacuum=${this.#retention.policy.autoVacuum} (${storage.pagesBefore} → ${storage.pagesAfter} pages)`);
            }
        }
        this.#drains.start();
        this.#retention?.start((cause) => {
            console.error("retention pass failed:", cause instanceof Error ? cause.message : String(cause));
        });
        await this.#mimetypes.ready();
        const executors = await ExecutorRegistry.build({ cwd: this.#discoveryCwd });
        for (const { runtime, error } of executors.configurationErrors()) {
            this.#configuration.record(`executor:${runtime}`, error);
        }
        this.#engine.setExecutors(executors);
        this.#engine.setFunctionalityDocuments((workspaceId) => this.#functionality.documents(workspaceId)); // {§exec-target-routing}
        this.#schemes.registerRuntimeSchemes(executors); // {§exec}
        await this.#configuration.capture("schemes", () => this.#schemes.discoverExternal(this.#discoveryCwd)); // {§extension-discovery}
        await this.#modules.setup(this);
        // {§functionality-model-projection} {§question-tool}
        await this.#functionality.ready();
        this.#engine.registerRuntimes(FunctionalityManager.runtimeRegistrations(this.#functionality));
        await this.#configuration.capture("schemes", () => this.#schemes.ready());
        this.#residency.publish();
        await recoverDaemonLifecycle({
            db: this.#db,
            drains: this.#drains,
            isStarted: () => this.#started,
        });
        await this.#modules.start(this);
        this.#modules.admitMounts();
    }

    async stop(deadline?: StopDeadline): Promise<void> {
        if (!this.#started) return;
        this.#started = false;
        await stopDaemon({
            db: this.#db,
            engine: this.#engine,
            drains: this.#drains,
            clientOperations: this.#clientOperations,
            residency: this.#residency,
            functionality: this.#functionality,
            modules: this.#modules,
            schemes: this.#schemes,
            mimetypes: this.#mimetypes,
            ownsMimetypes: this.#ownsMimetypes,
            retention: this.#retention,
            deadline,
        });
    }

    notifyStreamEvent(workspaceId: number, event: StreamEventPayload): void {
        this.#notifications.notifyStreamEvent(workspaceId, event);
    }

    notifyReasoningEvent(workspaceId: number, event: ReasoningEventPayload): void {
        this.#notifications.notifyReasoningEvent(workspaceId, event);
    }

    notifyNotice(workspaceId: number, payload: { sessionId: number | null; loopId: number; notice: Notice }): void {
        this.#notifications.notifyNotice(workspaceId, payload);
    }

    inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        return this.#drains.inject(args);
    }

    cancelDrain(sessionId: number, reason: string = "user_cancelled"): boolean {
        return this.#drains.cancel(sessionId, reason);
    }

    async cancelSession(args: { workspaceId: number; sessionId: number; reason?: string }): Promise<void> {
        const workspaceId = ClientInput.assertId("session.cancel", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.cancel", "sessionId", args.sessionId);
        await this.#places.assertSessionOwned(workspaceId, sessionId);
        await this.#drains.cancelSessionTree(sessionId, args.reason ?? "user_cancelled");
    }

    #sessionHasActiveStreams(sessionId: number): boolean {
        const exec = this.#schemes.get("exec");
        return exec instanceof Exec && exec.hasActiveSpawns(sessionId);
    }

    async #announceSessionPolicy(sessionId: number, override?: { readonly persona: string | null }): Promise<void> {
        const workspaceId = (
            await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: sessionId })
        )?.workspace_id;
        if (workspaceId === undefined) return;
        const [{ model, childModel }, session] = await Promise.all([
            this.#sessionModels.readSessionModel({ workspaceId, sessionId }),
            this.#places.readSession({ workspaceId, identity: { id: sessionId } }),
        ]);
        const persona = override !== undefined ? override.persona : session?.persona;
        this.#notifications.broadcast({ workspaceId }, "session/policy", {
            sessionId,
            model,
            childModel,
            ...(override !== undefined || persona != null ? { persona: persona ?? null } : {}),
        });
    }

    async readEntry(...args: Parameters<ClientReads["readEntry"]>): ReturnType<ClientReads["readEntry"]> {
        return this.#reads.readEntry(...args);
    }

    async readLog(...args: Parameters<ClientReads["readLog"]>): ReturnType<ClientReads["readLog"]> {
        return this.#reads.readLog(...args);
    }

    async readEntryChannel(...args: Parameters<ClientReads["readEntryChannel"]>): ReturnType<ClientReads["readEntryChannel"]> {
        return this.#reads.readEntryChannel(...args);
    }

    async readStreams(...args: Parameters<ClientReads["readStreams"]>): ReturnType<ClientReads["readStreams"]> {
        return this.#reads.readStreams(...args);
    }
}
