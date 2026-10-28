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
import FunctionalityManager, { plurnkRuntimeDecl } from "./FunctionalityManager.ts";
// {§notifications}: "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped.
export type NotifyTarget = "all" | { workspaceId: number };
import DrainSupervisor, { type DrainInjectionArgs, type DrainInjectionResult } from "./DrainSupervisor.ts";
import MessageAbandonment from "./MessageAbandonment.ts";
import Retention, { retentionPolicy } from "./Retention.ts";
import TurnDispositionHandler from "../core/TurnDispositionHandler.ts";
import { Validator, isRecord, type ApplicationServiceUpdateResult, type ApplicationSessionOverview, type ClientDisplayCapabilities, type FunctionalityPreparationActivity, type CapabilityProjection, type ClientInteractionProjection, type ClientInteractionResolution, type ApplicationLoopProjection, type ApplicationGauge, type ApplicationSessionIdentity, type ApplicationSessionProjection, type ApplicationSessionQuery, type ApplicationSessionHiding, type ApplicationWorkspaceHiding, type ClientEntryChannel, type ModelCatalogPage, type ModelCatalogQuery, type ModelRoute, type Notice, type ProposalProjection, type Effort, type PlurnkStatement, type RollbackReport, type ApplicationOwnerIdentity, type ApplicationSessionCreation, type SessionOwner, type ApplicationMessage, type ApplicationInboxMessage, type MessageResource, type CapabilityPolicy, type ClientEnvelope, type FunctionalityFamilyHandle, type ProposalResolution } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type HttpListener from "./HttpListener.ts";
import Credentials from "./Credentials.ts";
import type { WorkspaceRow } from "./envelope.ts";
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
import ServiceUpdater from "../core/ServiceUpdater.ts";
import { loadCatalogCache } from "@plurnk/plurnk-models";
import WorkspaceStorage from "./WorkspaceStorage.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import ProposalPolicies from "../core/ProposalPolicies.ts";
import { contentWeight } from "../core/content-weight.ts";
import MessageResources from "../core/MessageResources.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import { resolveActiveRoute } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import type { ApplicationPort, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";
import { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import type StopDeadline from "../core/StopDeadline.ts";
import WorkspaceResidency from "./WorkspaceResidency.ts";
import type { DaemonModule, ModuleActionContext, ModuleActionDescriptor, ModuleActionRegistration } from "@plurnk/plurnk-modules";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginSet } from "@plurnk/plurnk-agent-plugins";
import type { AgentRootScope } from "./AgentRoots.ts";
import type { HostFunctionalityAdapter, HostSetupSeam, WorkspaceCapabilityProvider, WorkspaceCapabilityPublication, WorkspaceCapabilityReplacement } from "./ModuleHost.ts";
import Functionality from "./Functionality.ts";
import { observedSync } from "../observe/spans.ts";
import { daemonFailure } from "./daemon-results.ts";
import SessionModels, { type EffortSource } from "./SessionModels.ts";
import ClientReads from "./ClientReads.ts";
import MessageDelivery from "./MessageDelivery.ts";
import DaemonModules from "./DaemonModules.ts";
import ClientOperations from "./ClientOperations.ts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import WorkspacePlaces from "./WorkspacePlaces.ts";
import { recoverDaemonLifecycle, stopDaemon } from "./DaemonLifecycle.ts";

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
        ServiceUpdater.validateConfiguration();
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
    // {§credential-authority} {§methods} — the one authority over credentials presented to
    // the listener, holding the operator's secret under the posture `PLURNK_AUTH` names.
    readonly credentials: Credentials;
    // The file beside the database where a minted operator secret is written for same-user clients;
    // null for a daemon started without its database path.
    readonly #secretPath: string | null;
    readonly #secretMinted: boolean;
    #discoveryCwd: string;
    #started = false; // {§module-lifecycle}: one discovery/module boot; no listener

    // {§module-lifecycle} — the daemon's modules, composed and discovered, with their mounts, phases and actions.
    readonly #modules: DaemonModules;
    // {§connection-lifecycle} — the client operations in flight: their loops, scopes and settlement.
    readonly #clientOperations: ClientOperations;
    // {§methods} {§machine-processes} — a message's delivery to a session: the loop it starts or continues.
    readonly #delivery: MessageDelivery;
    #residency: WorkspaceResidency;
    readonly #functionality: Functionality;
    // {§content-store} — the operator's retention, run on a cadence and at shutdown.
    #retention: Retention | null = null;
    readonly #plugins: WorkspacePlugins;
    readonly #members: MembersFunctionality;
    // {§methods} — the broadcast's in-process event source. A transport
    // module (plurnk-acp) subscribes and fans out to its OWN clients; core emits, never owns
    // client transport or connection state.
    #eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();
    readonly #sessionModels: SessionModels;
    readonly #reads: ClientReads;
    readonly #storage: WorkspaceStorage;
    readonly #configuration: ConfigurationDiagnostics;
    readonly #places: WorkspacePlaces;

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
        try { loadCatalogCache(hostPaths.modelsCacheFile); } catch { /* ignore unreadable cache on boot */ }
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
        // {§copy}: detection misses remain absent; resource
        // owners supply their creation type. {§mimetype}
        this.#ownsMimetypes = mimetypes === undefined;
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discoverOptions: { cwd: this.#discoveryCwd } });
        const bootSpec = this.#provider === null ? null : resolveActiveRoute();
        if (this.#provider !== null && bootSpec !== null) {
            ProviderInstantiate.registerInstance(this.#provider, bootSpec);
        }
        this.#workspaceGate = new WorkspaceGate(async (sessionId, rootSessionId) => {
            const row = await this.#db.session_lineage_contains.get<{ member: number }>({
                session_id: sessionId,
                root_session_id: rootSessionId });
            return row !== undefined;
        });
        // {§module-workspace-residency} — residency, activation/cooling, and
        // capability replacement live in their one owner; the Daemon delegates.
        this.#residency = new WorkspaceResidency({
            db,
            engine: () => this.#engine,
            workspaceGate: this.#workspaceGate,
            normalizeRuntime: (registration) => this.#normalizeRuntime(registration) });
        // {§module-lifecycle} — the modules' owner exists before Core registers its own families below: their
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
            readSessionModuleState: (sessionId, owner) => this.#residency.readSessionModuleState(sessionId, owner),
            replaceSessionModuleState: (sessionId, owner, state) => this.#residency.replaceSessionModuleState(sessionId, owner, state),
            withWorkspaceGate: (workspaceId, owner, gate, run, signal) => this.#residency.exclusively(workspaceId, owner, gate, run, signal),
            atWorkspaceBoundary: (workspaceId, run) => this.#workspaceGate.atBoundary(workspaceId, run),
            retainWorkspace: (workspaceId) => this.#residency.retain(workspaceId),
            preparationChanged: (workspaceId, preparation) => this.#broadcast({ workspaceId }, "workspace/preparation", { workspaceId, preparation }) });
        this.#plugins = new WorkspacePlugins({ db, hostPaths, nodeModules: this.#nodeModulesPath });
        // {§tools-resource-materialization} — Core's own family: file membership on the same surface.
        this.#members = new MembersFunctionality({ db, engine: () => this.#engine });
        this.#functionality.register(this.#members);
        // {§env-functionality} — Core's own family: the environment a Session's commands run in.
        // {§env-functionality} — the family's face: reads project the dispatching Session's effective
        // environment, writes go through the family's own admission at the Session's layer. The runtime
        // session keeps none: its environment is the workspace's ({§connection-lifecycle}).
        this.#functionality.register(new EnvFunctionality(
            EnvFunctionality.defaultsReader(Paths.packageRoot, this.#nodeModulesPath, this.#hostPaths),
            new EnvScheme(
                (workspaceId, sessionId) => EnvFunctionality.resolve(this.#db, workspaceId, sessionId, undefined, this.#hostPaths),
                (verb, params, identity) => this.#functionality.invoke("env", verb, params, identity, "operation"),
                async (workspaceId, sessionId) => (await this.#db.runtime_session_get.get<{ id: number }>({ workspace_id: workspaceId }))?.id === sessionId
                    ? "workspace" : "session",
            ),
            this.#hostPaths,
        ));
        this.#engine = new Engine({
            db, lifecycle: this.#lifecycle, schemes: this.#schemes, mimetypes: this.#mimetypes,
            hostPaths: this.#hostPaths,
            // {§tokenomics} — stored and catalog curation weights
            // are workspace-wide across concurrent models, so they remain
            // model-independent. Request-shaped token facts stay provider-owned.
            weigh: contentWeight,
            streamEventNotify: (workspaceId, event) => this.notifyStreamEvent(workspaceId, event),
            operationSettledNotify: (workspaceId, logEntryId) => this.#drains.operationSettled(workspaceId, logEntryId),
            operationEventNotify: (workspaceId, event) => this.#broadcast({ workspaceId }, "operation/event", event),
            reasoningEventNotify: (workspaceId, event) => this.notifyReasoningEvent(workspaceId, event),
            outsideEventNotify: (workspaceId, event) => this.notifyOutsideEvent(workspaceId, event),
            wakeSessionNotify: (payload) => this.#drains.notifyWakeSession(payload),
            injectSession: (args) => this.#delivery.injectSession(args),
            withWorkspaceTurn: (workspaceId, sessionId, run, signal) => this.#workspaceGate.withTurn(workspaceId, sessionId, run, signal),
            // {§functionality-inspection} — skills and plugins change out of band.
            // Republish under the workspace turn gate before packet assembly so
            // the first subsequent model turn sees their exact result.
            workspaceTurnStarting: async ({ workspaceId }) => {
                await this.#functionality.refreshChanged({ workspaceId });
                return [...this.configurationNotices(), ...this.#functionality.configurationNotices(workspaceId), ...this.#plugins.notices(workspaceId)];
            },
            // session:// KILL (terminate) — cancel the addressed session subtree and
            // tear down its held streams before the operation completes.
            cancelSession: async (sessionId, reason) => this.#drains.cancelSessionTree(sessionId, reason),
            // {§membership-auto-add} — a READ or FIND admits what it reached for as the Session's own
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
            engine: this.#engine,
            // {§loop-completion} — the daemon answers, 499, what an ended loop left unanswered.
            completeAbandonedMessages: (workspaceId, sessionId, loopId, status) =>
                MessageAbandonment.complete(this.#engine, this.#db, workspaceId, sessionId, loopId, status),
            lifecycle: this.#lifecycle,
            assertInjectionCompatibility: (args) => this.#sessionModels.assertInjectionCompatibility(args),
            runLoop: (args) => this.#runDrainLoop(args),
            hasActiveStreams: (sessionId) => this.#sessionHasActiveStreams(sessionId),
            readSystemPrompt: () => readFile(Paths.instructionsSystem, "utf8"), // {§packet-inject}
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
        // {§notifications} — the projection is the payload; its scope is the envelope's.
        this.#engine.onClientInteractionPending((event) => {
            const { workspaceId, ...interaction } = event;
            this.#broadcast({ workspaceId }, "loop/interaction", interaction);
        });
        this.#sessionModels = new SessionModels({
            db: this.#db,
            provider: this.#provider,
            policyChanged: (sessionId) => this.#announceSessionPolicy(sessionId),
            sessionCurationOverflow: (sessionId, selectedProvider) => this.#engine.sessionCurationOverflow(sessionId, selectedProvider),
        });
        this.#delivery = new MessageDelivery({
            db, sessionModels: this.#sessionModels, mimetypes: this.#mimetypes,
            inject: (args) => this.inject(args),
        });
        this.#reads = new ClientReads({ db: this.#db, engine: this.#engine, workspaceGate: this.#workspaceGate, residency: this.#residency });
        this.#places = new WorkspacePlaces({
            db: this.#db,
            hostPaths: this.#hostPaths,
            engine: () => this.#engine,
            sessionModels: () => this.#sessionModels,
            broadcast: (target, method, params) => this.#broadcast(target, method, params),
        });
        this.#clientOperations = new ClientOperations({
            db, engine: this.#engine, residency: this.#residency, workspaceGate: this.#workspaceGate,
            assertModelSession: (workspaceId, sessionId) => this.#sessionModels.assertModelSession(workspaceId, sessionId),
            assertSessionOwned: (workspaceId, sessionId) => this.#places.assertSessionOwned(workspaceId, sessionId),
            emitLogEntry: async (workspaceId, logEntryId) => {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            },
        });
    }

    // The drain callback is the final provider/model boundary. Every admission path, including boot recovery,
    // terminates here.
    async #runDrainLoop({ workspaceId, sessionId, loopId, maxTurns, prompt, systemPrompt, signal, onSettled }: DrainRunLoopArgs): Promise<DrainRunLoopResult> {
        // The drain callback is the final provider/model boundary. Every
        // admission path, including boot recovery, terminates here.
        await this.#sessionModels.assertModelSession(workspaceId, sessionId);
        const releaseCapabilities = await this.#residency.acquire(workspaceId);
        try {
            // Session settings can change while Functionality remains
            // resident. Reconcile the session-private discovery surface
            // at the same pre-inference boundary used for activation.
            await this.#residency.reconcile(workspaceId);
            const { provider: loopProvider, childProvider } = await this.#sessionModels.providersForLoop(loopId);
            return await this.#engine.runLoop({
                provider: loopProvider,
                childProvider,
                workspaceId,
                sessionId,
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


    // {§methods}. A transport module subscribes to the daemon's in-process
    // event source: it receives every workspace-scoped engine event as `(workspaceId, method, params)`
    // and fans out to its OWN clients — core emits, it never fans out for the module. Returns an
    // unsubscribe. `workspaceId` is the event's workspace, or null for a global event (e.g. workspace/created).
    // The engine and its events are core; the fan-out belongs to the module.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void {
        this.#eventSubscribers.add(handler);
        return () => { this.#eventSubscribers.delete(handler); };
    }

    registerSessionOwner(workspaceId: number, owner: SessionOwner): Promise<void> {
        return this.#places.registerSessionOwner(workspaceId, owner);
    }

    claimSessionOwner(args: { workspaceId: number; sessionId: number; owner: string }): Promise<SessionOwner> {
        return this.#places.claimSessionOwner(args);
    }

    // {§methods} — proposal HITL. A transport module reads the stopped-world
    // proposals for a workspace (presenting each via session/request_permission) and feeds back the human's decision. The
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
        const pending = await this.#db.session_owner_for_proposal.get<{ workspaceId: number; owner: string }>({ log_entry_id: checkedLogEntryId });
        if (pending !== undefined && (pending.workspaceId !== workspaceId || pending.owner !== owner.address)) {
            throw daemonFailure("proposal:resolution", "owner-mismatch", 403,
                "Only the session's owner may resolve this proposal.", { logEntryId: checkedLogEntryId });
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

    async readMessages(args: { workspaceId: number; sessionId: number; loopId?: number }): Promise<ApplicationMessage[]> {
        await this.#sessionModels.assertModelSession(args.workspaceId, args.sessionId);
        return MessageResources.read(this.#db, args);
    }

    // {§methods}
    async readInbox(args: { workspaceId: number; sessionId: number }): Promise<ApplicationInboxMessage[]> {
        await this.#sessionModels.assertModelSession(args.workspaceId, args.sessionId);
        return MessageResources.inbox(this.#db, args);
    }

    // {§methods}
    async messageAdmission(args: { workspaceId: number; address: string; body: string }): Promise<"new" | "accepted"> {
        const workspaceId = ClientInput.assertId("messageAdmission", "workspaceId", args.workspaceId);
        return await MessageResources.admission(this.#db, workspaceId, args.address, args.body);
    }

    // {§methods} — a message delivered to a session drives or steers its loop: the delivery's owner resolves
    // the session's model and the card and injects into the drain; the port's entry point delegates.
    runLoop(args: { workspaceId: number; sessionId: number; loopId?: number; prompt: string; source?: string; messageAddress?: string; attachments?: readonly MessageResource[]; envelope?: Readonly<Record<string, unknown>>; maxTurns?: number; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        return this.#delivery.runLoop(args);
    }

    ensureRuntimeSession(workspaceId: number): Promise<number> {
        return this.#places.ensureRuntimeSession(workspaceId);
    }

    async readWorkspaceCapabilities(args: { workspaceId: number }): Promise<CapabilityProjection> {
        const workspaceId = ClientInput.assertId("workspace.capabilities.get", "workspaceId", args.workspaceId);
        return this.#engine.capabilityProjection(workspaceId);
    }

    // {§capability-admission} Policy changes share the workspace's
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

    // {§session-model-selection} {§session-model-selection} — the session's durable model, effort and spawn override are
    // SessionModels' to read and set; the port's entry points delegate.
    readSessionModel(args: { workspaceId: number; sessionId: number }): Promise<{ model: ModelRoute | null; spawnModel: ModelRoute | null }> {
        return this.#sessionModels.readSessionModel(args);
    }

    setSessionModel(args: { workspaceId: number; sessionId: number; selector: string; effort?: unknown }): Promise<ModelRoute> {
        return this.#sessionModels.setSessionModel(args);
    }

    readSessionEffort(args: { workspaceId: number; sessionId: number }): Promise<{ effort: Effort | null; source: EffortSource; supportedEfforts: readonly Effort[] }> {
        return this.#sessionModels.readSessionEffort(args);
    }

    setSessionEffort(args: { workspaceId: number; sessionId: number; effort: unknown }): Promise<{ effort: Effort; source: "explicit"; supportedEfforts: readonly Effort[] }> {
        return this.#sessionModels.setSessionEffort(args);
    }

    setSessionSpawnModel(args: { workspaceId: number; sessionId: number; selector: string | null }): Promise<ModelRoute | null> {
        return this.#sessionModels.setSessionSpawnModel(args);
    }

    // {§functionality-model-projection} — await every queued Functionality
    // publication (a Session's accepted mutation publishes at its turn boundary).
    async settleFunctionality(workspaceId?: number): Promise<void> {
        await this.#functionality.settle(workspaceId);
    }

    executorTags(workspaceId: number): readonly string[] {
        return this.#engine.executorTags(workspaceId);
    }

    // {§connection-lifecycle} A person's client operation: one administrative loop in the workspace's runtime
    // session, attributed to its actor, reading `log:///` in the session that person acts for
    // ({§connection-lifecycle}). The operations' owner runs it; the port's entry points delegate.
    dispatchClientAction(args: {
        workspaceId: number;
        actor: string;
        contextSessionId?: number;
        statements: PlurnkStatement[];
        onLoop?: (loop: { sessionId: number; loopId: number }) => void;
    }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        return this.#clientOperations.dispatchClientAction(args);
    }

    cancelLoop(args: { workspaceId: number; loopId: number; reason?: string }): Promise<boolean> {
        return this.#clientOperations.cancelLoop(args);
    }

    // {§methods} — the module's render surface beyond the journal. Thin delegations
    // into core's envelope / membership / provider machinery; the module fans the results into its own views.
    listProviders(): ReturnType<ApplicationPort["listProviders"]> {
        return this.#sessionModels.listProviders();
    }

    listModels(query: ModelCatalogQuery): ModelCatalogPage {
        return this.#sessionModels.listModels(query);
    }

    // {§mcp-server-definition} Core composes the installed family
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

    listWorkspaces(query: { readonly hidden?: boolean } = {}): Promise<Array<WorkspaceRow & { project_label: string | null }>> {
        return this.#places.listWorkspaces(query);
    }

    listSessions(
        workspaceId: number,
        query: ApplicationSessionQuery = {},
    ): Promise<ApplicationSessionProjection[]> {
        return this.#places.listSessions(workspaceId, query);
    }

    readSession(args: {
        workspaceId: number;
        identity: ApplicationSessionIdentity;
    }): Promise<ApplicationSessionProjection | null> {
        return this.#places.readSession(args);
    }

    sessionAccounting(args: { workspaceId: number; sessionId: number }): Promise<ProviderAccounting> {
        return this.#places.sessionAccounting(args);
    }

    sessionGauge(args: { workspaceId: number; sessionId: number }): Promise<ApplicationGauge> {
        return this.#places.sessionGauge(args);
    }

    listSessionLoops(args: {
        workspaceId: number;
        sessionId: number;
    }): Promise<ApplicationLoopProjection[]> {
        return this.#places.listSessionLoops(args);
    }

    readSessionOverview(args: { readonly workspaceId?: number; readonly limit: number; readonly excerptChars: number }): Promise<ApplicationSessionOverview> {
        return this.#places.readSessionOverview(args);
    }

    // {§share} — one workspace's share. The daemon names its own database; the caller names an absolute folder.
    async shareWorkspace({ workspaceId, folder }: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.share", "workspaceId", workspaceId);
        const checkedFolder = ClientInput.assertShareFolder("workspace.share", folder);
        if (this.#dbPath === undefined) throw new Error("this daemon was started without its database path");
        return await Share.write({ openEvidence: EvidenceReader.open, dbPath: this.#dbPath, folder: checkedFolder, workspaceId: checkedWorkspaceId });
    }

    // {§startup-admission} — explicit operator-triggered model-catalog and package update.
    async updateService(): Promise<ApplicationServiceUpdateResult> {
        return await ServiceUpdater.run({ hostPaths: this.#hostPaths });
    }

    listPrompts(workspaceId: number, limit?: number, sessionId?: number): Promise<string[]> {
        return this.#places.listPrompts(workspaceId, limit, sessionId);
    }

    // {§methods-workspace-create} — the demand a turn makes, without the turn: a cold workspace activates,
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

    createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object }): Promise<ClientEnvelope> {
        return this.#places.createWorkspace(args);
    }

    attachWorkspace(args: Parameters<ApplicationPort["attachWorkspace"]>[0]): Promise<ClientEnvelope> {
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

    setWorkspaceHidden(args: { readonly workspaceId: number; readonly hidden: boolean }): Promise<ApplicationWorkspaceHiding> {
        return this.#places.setWorkspaceHidden(args);
    }

    setSessionHidden(args: { readonly workspaceId: number; readonly sessionId: number; readonly hidden: boolean }): Promise<ApplicationSessionHiding> {
        return this.#places.setSessionHidden(args);
    }

    createSession(args: ApplicationSessionCreation): Promise<{ sessionId: number; sessionName: string }> {
        return this.#places.createSession(args);
    }

    forkSession(args: { workspaceId: number; sessionId: number; name?: string }): Promise<{ sessionId: number; sessionName: string | null; parentSessionId: number }> {
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

    // {§http-host} {§module-contract} — a module mounts on the daemon's one listener exactly what it claimed;
    // the modules' owner keeps the claims. {§module-seam-slices}: a module's actions, registered, listed and invoked.
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
        return this.#modules.invokeAction(name, params, context);
    }

    registerWorkspaceCapabilityProvider(
        namespaceOwner: string,
        provider: WorkspaceCapabilityProvider,
    ): void {
        this.#residency.registerProvider(namespaceOwner, provider);
    }

    // {§module-seam-slices}
    registerFunctionalityAdapter(adapter: HostFunctionalityAdapter): FunctionalityFamilyHandle {
        return this.#functionality.register(adapter);
    }

    async readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        const snapshot = await EnvFunctionality.workspace(this.#db, workspaceId, this.#hostPaths);
        return (ambient) => snapshot(ambient).env;
    }

    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string> {
        return this.#storage.directory(workspaceId, namespaceOwner);
    }

    async workspacePaths(workspaceId: number): ReturnType<HostSetupSeam["workspacePaths"]> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return workspacePaths(this.#hostPaths, workspace?.project_root ?? null);
    }

    // {§functionality-inspection}
    readWorkspacePlugins(workspaceId: number): Promise<WorkspacePluginSet<AgentRootScope>> {
        return this.#plugins.read(workspaceId);
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
        const row = await this.#db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: ENV_OWNER });
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

    // {§module-lifecycle} — `owner` is the module's package name; diagnostics name it.
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
        await this.#configuration.capture("execution", () => Exec.validateConfiguration(this.#hostPaths));
        this.#retention = await this.#configuration.capture("retention", () => new Retention(this.#db, retentionPolicy()));
        this.#clientOperations.start();
        this.#started = true;
        // {§content-store} — the file is brought to the policy's auto-vacuum mode before any work.
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
        // registry to the engine for exec dispatch ({§exec-target-routing}).
        const executors = await ExecutorRegistry.build({ cwd: this.#discoveryCwd });
        for (const { runtime, error } of executors.configurationErrors()) {
            this.#configuration.record(`executor:${runtime}`, error);
        }
        this.#engine.setExecutors(executors);
        this.#engine.setFunctionalityDocuments((workspaceId) => this.#functionality.documents(workspaceId));
        // {§functionality-model-projection} {§question-tool} — the model-facing `plurnk`
        // runtime exposes workspace Functionality families and `question` under `/tools/plurnk.md`.
        this.#engine.registerRuntimes([{
            tag: "plurnk",
            entry: {
                executor: new FunctionalityManager({
                    coordinator: this.#functionality,
                    entries: (workspaceId) => this.#functionality.familyEntries(workspaceId),
                    includeQuestion: true,
                }),
                namespaceOwner: { kind: "module", name: "core" },
                glyph: plurnkRuntimeDecl.glyph,
                summary: plurnkRuntimeDecl.summary,
                invocation: plurnkRuntimeDecl.invocation,
                details: plurnkRuntimeDecl.details ?? "",
                resourcesPath: plurnkRuntimeDecl.resourcesPath,
                expandTools: plurnkRuntimeDecl.expandTools,
                available: true,
                detail: "in-process" } }]);
        // {§exec} — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for execution dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their context in SchemeCtxImpl ({§extension-discovery}).
        await this.#schemes.discoverExternal(this.#discoveryCwd);
        // {§module-lifecycle} — discovery composes beside the service's explicit modules, then every module sets
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

        await recoverDaemonLifecycle({
            db: this.#db,
            drains: this.#drains,
            isStarted: () => this.#started,
        });

        // {§module-lifecycle} — the daemon opened its one transport before admission ({§http-host});
        // modules mount their routes on it here, only after capability publication and durable
        // lifecycle recovery are complete. None opens a listener of its own.
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

    /** Emit one admitted emission's text outside every operation ({§notifications}). */
    notifyOutsideEvent(workspaceId: number, event: OutsideEventPayload): void {
        this.#broadcast({ workspaceId }, "outside/event", event);
    }

    /**
     * Emit a transient notice scoped to the workspace containing the loop.
     */
    notifyNotice(workspaceId: number, payload: { sessionId: number | null; loopId: number; notice: Notice }): void {
        this.#broadcast({ workspaceId }, "notice/event", payload);
    }

    inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        return this.#drains.inject(args);
    }

    cancelDrain(sessionId: number, reason: string = "user_cancelled"): boolean {
        return this.#drains.cancel(sessionId, reason);
    }

    async cancelSession(args: {
        workspaceId: number;
        sessionId: number;
        reason?: string;
    }): Promise<void> {
        const workspaceId = ClientInput.assertId("session.cancel", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.cancel", "sessionId", args.sessionId);
        await this.#places.assertSessionOwned(workspaceId, sessionId);
        await this.#drains.cancelSessionTree(sessionId, args.reason ?? "user_cancelled");
    }

    // Process-local stream activity is supplied to the drain owner through the
    // scheme registry rather than exposing that registry across the boundary.
    #sessionHasActiveStreams(sessionId: number): boolean {
        const exec = this.#schemes.get("exec");
        return exec instanceof Exec && exec.hasActiveSpawns(sessionId);
    }

    // {§methods} — subscriber failures are transport-local:
    // log them at this boundary and never re-enter engine control flow.
    #emitTo(workspaceId: number | null, method: string, params?: unknown): void {
        for (const sub of this.#eventSubscribers) {
            try { sub(workspaceId, method, params); }
            catch (e) { console.error(`seam subscriber failed on ${method}:`, e instanceof Error ? e.message : String(e)); }
        }
    }

    // {§notifications} A session's generation policy, as readSessionModel reads it, to its workspace.
    async #announceSessionPolicy(sessionId: number): Promise<void> {
        const workspaceId = (await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: sessionId }))?.workspace_id;
        if (workspaceId === undefined) return;
        const { model, spawnModel } = await this.#sessionModels.readSessionModel({ workspaceId, sessionId });
        this.#broadcast({ workspaceId }, "session/policy", { sessionId, model, spawnModel });
    }

    #broadcast(target: NotifyTarget, method: string, params?: unknown): void {
        observedSync( // {§observability-boundary}
            "stream.broadcast",
            { method, ...(target === "all" ? {} : { "workspace.id": target.workspaceId }) },
            () => {
                if (target === "all") {
                    // {§notifications}: global events carry workspaceId null.
                    this.#emitTo(null, method, params);
                    return;
                }
                // {§methods}: publish to the in-process source; transport modules subscribe
                // here (plurnk-acp renders to ACP v2). Each subscriber owns its own fan-out; core just emits.
                // Scope-stamping onto the notification envelope ({§notifications})
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

    async readEntryChannel(...args: Parameters<ClientReads["readEntryChannel"]>): ReturnType<ClientReads["readEntryChannel"]> {
        return this.#reads.readEntryChannel(...args);
    }

    async readStreams(...args: Parameters<ClientReads["readStreams"]>): ReturnType<ClientReads["readStreams"]> {
        return this.#reads.readStreams(...args);
    }
}
