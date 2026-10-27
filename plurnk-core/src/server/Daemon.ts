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
import { Validator, isRecord, isSafeInteger, type ApplicationServiceUpdateResult, type ApplicationSessionOverview, type ClientDisplayCapabilities, type FunctionalityPreparationActivity, type CapabilityProjection, type ClientInteractionProjection, type ClientInteractionResolution, type ApplicationLoopProjection, type ApplicationGauge, type ApplicationSessionIdentity, type ApplicationSessionProjection, type ApplicationSessionQuery, type ApplicationSessionHiding, type ApplicationWorkspaceHiding, type ClientEntryChannel, type ModelCatalogPage, type ModelCatalogQuery, type ModelRoute, type Notice, type ProposalProjection, type Effort, type PlurnkStatement, type RollbackReport, type ApplicationOwnerIdentity, type ApplicationSessionCreation, type SessionOwner, type ApplicationMessage, type ApplicationInboxMessage, type MessageResource, type CapabilityPolicy, type ClientEnvelope, type FunctionalityFamilyHandle, type ProposalResolution } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type HttpListener from "./HttpListener.ts";
import Credentials from "./Credentials.ts";
import Envelope, { projectSessionRow, type WorkspaceEnvelope, type WorkspaceRow } from "./envelope.ts";
import SessionReferences from "./SessionReferences.ts";
import SessionOverview from "./SessionOverview.ts";
import Places, { type PlaceGates } from "./Places.ts";
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
import Fork from "../core/fork.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { Knob } from "@plurnk/plurnk-meta";
import ProposalPolicies from "../core/ProposalPolicies.ts";
import SessionOwners from "../core/SessionOwners.ts";
import RuntimeSession from "../core/RuntimeSession.ts";
import { contentWeight } from "../core/content-weight.ts";
import MessageResources from "../core/MessageResources.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import { resolveActiveRoute } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import type { ApplicationPort, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import StopDeadline from "../core/StopDeadline.ts";
import { SessionNameConflictError } from "../core/SessionName.ts";
import WorkspaceResidency from "./WorkspaceResidency.ts";
import type { DaemonModule, ModuleActionContext, ModuleActionDescriptor, ModuleActionRegistration } from "@plurnk/plurnk-modules";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginSet } from "@plurnk/plurnk-agent-plugins";
import type { AgentRootScope } from "./AgentRoots.ts";
import type { HostFunctionalityAdapter, HostSetupSeam, WorkspaceCapabilityProvider, WorkspaceCapabilityPublication, WorkspaceCapabilityReplacement } from "./ModuleHost.ts";
import Functionality from "./Functionality.ts";
import { observed, observedSync } from "../observe/spans.ts";
import { daemonFailure } from "./daemon-results.ts";
import SessionModels, { type EffortSource } from "./SessionModels.ts";
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
            // {§loop-completion} — the daemon answers, 499, what an ended loop left unanswered.
            completeAbandonedMessages: (workspaceId, sessionId, loopId, status) =>
                MessageAbandonment.complete(this.#engine, this.#db, workspaceId, sessionId, loopId, status),
            lifecycle: this.#lifecycle,
            injectPrompt: (loopId, prompt, openPaths, source, evidence, messageAddress, opener) => this.#engine.injectIntoLoop(loopId, prompt, openPaths, source, evidence, messageAddress, opener),
            assertInjectionCompatibility: (args) => this.#sessionModels.assertInjectionCompatibility(args),
            runLoop: (args) => this.#runDrainLoop(args),
            loopUsage: (loopId) => this.#engine.loopUsage(loopId),
            loopAttributions: (loopId) => this.#engine.loopAttributions(loopId),
            discardLoopNotices: (loopId) => this.#engine.discardLoopNotices(loopId),
            cancelSubscription: (subscriptionId) => this.#engine.cancelSubscription(subscriptionId),
            subscriptionConcluded: (subscriptionId) => this.#engine.subscriptionConcluded(subscriptionId),
            reapLoopStreams: (loopId) => this.#engine.reapLoopStreams(loopId),
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
        this.#clientOperations = new ClientOperations({
            db, engine: this.#engine, residency: this.#residency, workspaceGate: this.#workspaceGate,
            assertModelSession: (workspaceId, sessionId) => this.#sessionModels.assertModelSession(workspaceId, sessionId),
            assertSessionOwned: (workspaceId, sessionId) => this.#assertSessionOwned(workspaceId, sessionId),
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

    async registerSessionOwner(workspaceId: number, owner: SessionOwner): Promise<void> {
        const id = ClientInput.assertId("registerSessionOwner", "workspaceId", workspaceId);
        await SessionOwners.register(this.#db, id, owner);
    }

    async claimSessionOwner(args: { workspaceId: number; sessionId: number; owner: string }): Promise<SessionOwner> {
        const workspaceId = ClientInput.assertId("claimSessionOwner", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("claimSessionOwner", "sessionId", args.sessionId);
        const session = await this.readSession({ workspaceId, identity: { id: sessionId } });
        if (session === null) throw daemonFailure("session:owner", "session-not-found", 404,
            `Session ${sessionId} does not belong to workspace ${workspaceId}.`, { workspaceId, sessionId });
        return SessionOwners.claim(this.#db, workspaceId, sessionId, args.owner);
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

    async ensureRuntimeSession(workspaceId: number): Promise<number> {
        const checked = ClientInput.assertId("session.ensure-runtime", "workspaceId", workspaceId);
        if (await this.#db.envelope_get_workspace.get({ id: checked }) === undefined) {
            throw daemonFailure("session:owner", "workspace-not-found", 404, `Workspace ${checked} does not exist.`);
        }
        return RuntimeSession.ensure(this.#db, checked);
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

    async #assertSessionOwned(workspaceId: number, sessionId: number): Promise<void> {
        const owner = await this.#db.envelope_get_session_by_id.get<{ workspace_id: number }>({ id: sessionId });
        if (owner === undefined) {
            throw daemonFailure(
                "daemon:session",
                "session-not-found",
                404,
                `Session ${sessionId} does not exist.`,
                { sessionId },
            );
        }
        if (owner.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:session",
                "workspace-mismatch",
                409,
                `Session ${sessionId} does not belong to workspace ${workspaceId}.`,
                { sessionId, workspaceId, actualWorkspaceId: owner.workspace_id },
            );
        }
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

    async listWorkspaces(query: { readonly hidden?: boolean } = {}): Promise<Array<WorkspaceRow & { project_label: string | null }>> {
        const hidden = query.hidden === undefined ? undefined : ClientInput.assertFlag("workspace.list", "hidden", query.hidden);
        return (await Envelope.listWorkspaces(this.#db, hidden)).map((row) => ({ ...row, project_label: this.#projectLabel(row.project_root) }));
    }

    // {§execution-output-identity} — the folder as the daemon spells it for display: the spelling a default name takes.
    #projectLabel(projectRoot: string | null): string | null {
        return projectRoot === null ? null : this.#hostPaths.abbreviateUserPath(projectRoot);
    }

    #labelled(envelope: WorkspaceEnvelope): ClientEnvelope {
        return { ...envelope, projectLabel: this.#projectLabel(envelope.projectRoot) };
    }
    async listSessions(
        workspaceId: number,
        query: ApplicationSessionQuery = {},
    ): Promise<ApplicationSessionProjection[]> {
        const origin = query.origin;
        if (origin !== undefined && !["model", "client", "_plurnk"].includes(origin)) {
            throw daemonFailure(
                "daemon:session",
                "origin-invalid",
                400,
                `Session origin '${origin}' is invalid.`,
                { origin, retryable: false },
            );
        }
        const parentSessionId = query.parentSessionId === undefined
            ? undefined
            : query.parentSessionId === null
                ? null
                : ClientInput.assertId("workspace.sessions", "parentSessionId", query.parentSessionId);
        const hidden = query.hidden === undefined ? undefined : ClientInput.assertFlag("workspace.sessions", "hidden", query.hidden);
        // {§methods-workspace-create} — an omitted parent filter must stay absent:
        // the envelope keys the filter on the property's presence, not its value.
        return await Envelope.listSessionsForWorkspace(
            this.#db,
            ClientInput.assertId("workspace.sessions", "workspaceId", workspaceId),
            {
                ...(origin === undefined ? {} : { origin }),
                ...(parentSessionId === undefined ? {} : { parentSessionId }),
                ...(hidden === undefined ? {} : { hidden }) },
        );
    }

    async readSession(args: {
        workspaceId: number;
        identity: ApplicationSessionIdentity;
    }): Promise<ApplicationSessionProjection | null> {
        const workspaceId = ClientInput.assertId("session.read", "workspaceId", args.workspaceId);
        const hasId = Object.hasOwn(args.identity, "id");
        const hasName = Object.hasOwn(args.identity, "name");
        if (hasId === hasName) {
            throw daemonFailure(
                "daemon:session",
                "identity-invalid",
                400,
                "Session observation requires exactly one id or name.",
                { retryable: false },
            );
        }
        type Row = Omit<ApplicationSessionProjection, "lifecycle"> & { workspace_id: number; loopObservations: string };
        // {§session-scheme} — a lookup is no minting door: it resolves any name a listing returns,
        // the runtime session's `_plurnk` among them.
        const row = hasId
            ? await this.#db.envelope_get_session_by_id.get<Row>({
                id: ClientInput.assertId("session.read", "id", args.identity.id) })
            : await this.#db.envelope_get_session_by_name.get<Row>({
                workspace_id: workspaceId,
                name: ClientInput.assertOptionalName("session.read", "name", args.identity.name)! });
        if (row === undefined || row.workspace_id !== workspaceId) return null;
        const { workspace_id: _workspaceId, ...projection } = projectSessionRow(row);
        return projection;
    }

    // {§methods-workspace-create}
    async sessionAccounting(args: { workspaceId: number; sessionId: number }): Promise<ProviderAccounting> {
        const workspaceId = ClientInput.assertId("session.accounting", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.accounting", "sessionId", args.sessionId);
        await this.#assertSessionOwned(workspaceId, sessionId);
        return this.#engine.sessionAccounting(sessionId);
    }

    // {§methods-workspace-create}
    async sessionGauge(args: { workspaceId: number; sessionId: number }): Promise<ApplicationGauge> {
        const workspaceId = ClientInput.assertId("session.gauge", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.gauge", "sessionId", args.sessionId);
        await this.#assertSessionOwned(workspaceId, sessionId);
        const latest = await this.#db.application_latest_packet_loop.get<{ id: number }>({ session_id: sessionId });
        if (latest === undefined) return { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };
        return Engine.clientGauge(await this.#engine.loopGauge(latest.id));
    }

    async listSessionLoops(args: {
        workspaceId: number;
        sessionId: number;
    }): Promise<ApplicationLoopProjection[]> {
        const workspaceId = ClientInput.assertId("session.loops", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.loops", "sessionId", args.sessionId);
        await this.#assertSessionOwned(workspaceId, sessionId);
        const rows = await this.#db.application_list_session_loops.all<{
            id: number;
            sessionId: number;
            sequence: number;
            status: number;
            prompt: string;
            promptSource: string | null;
            claimedAt: string | null;
            terminatedAt: string | null;
            terminalResult: string | null;
            packetCount: number;
            waitUntil: number | null;
            invocationSessionId: number | null;
            invocation: string | null;
        }>({ session_id: sessionId });
        return rows.map((row) => ({
            id: row.id,
            sessionId: row.sessionId,
            sequence: row.sequence,
            status: row.status,
            prompt: row.prompt,
            promptSource: row.promptSource,
            claimedAt: row.claimedAt,
            terminatedAt: row.terminatedAt,
            packetCount: row.packetCount,
            waitUntil: row.waitUntil,
            invocation: row.invocation === null || row.invocationSessionId === null ? null : { sessionId: row.invocationSessionId, address: row.invocation },
            // {§db-migrations}: a stored result is chapter 3's (`loops_terminal_result_contract`); it is parsed, not re-asserted.
            terminalResult: row.terminalResult === null ? null : Results.fromRow(row.terminalResult) }));
    }

    // {§methods-workspace-create} The places of the daemon, or of one workspace, with what waits there.
    async readSessionOverview(args: { readonly workspaceId?: number; readonly limit: number; readonly excerptChars: number }): Promise<ApplicationSessionOverview> {
        const workspaceId = args.workspaceId === undefined ? null : ClientInput.assertId("session.overview", "workspaceId", args.workspaceId);
        const { limit, excerptChars } = args;
        if (!isSafeInteger(limit) || limit < 1 || !isSafeInteger(excerptChars) || excerptChars < 1) {
            throw new TypeError("readSessionOverview takes a positive limit and excerpt length.");
        }
        if (workspaceId !== null && await this.#db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId }) === undefined) {
            throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, { workspaceId });
        }
        return await SessionOverview.read(this.#db, {
            workspaceId, limit, excerptChars, projectLabel: (projectRoot) => this.#projectLabel(projectRoot),
            // {§acp-status-descendants} The gates the status tree counts: the pending proposals and client interactions.
            pending: async (id) => [...await this.#engine.pendingProposals(id), ...await this.#engine.pendingClientInteractions(id)],
        });
    }

    // {§methods-workspace-create}: root-session loop seeds, newest-first.
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
        const checkedWorkspaceId = ClientInput.assertId("workspace.prompts", "workspaceId", workspaceId);
        const checkedLimit = ClientInput.assertLimit("workspace.prompts", limit);
        const checkedSessionId = sessionId === undefined ? null : ClientInput.assertId("workspace.prompts", "sessionId", sessionId);
        return Envelope.listPromptsForWorkspace(this.#db, checkedWorkspaceId, checkedLimit ?? Knob.integer("PLURNK_SERVICE_PROMPTS_PAGE", 1), checkedSessionId);
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
        // {§execution-output-identity} — with a project root and no name, the workspace is named after the root with
        // the daemon's home abbreviated to `~`, and that name selects the existing workspace when one exists:
        // a default is a convention shared by every client, never a second workspace.
        const derived = explicit === undefined && projectRoot !== null ? this.#hostPaths.abbreviateUserPath(projectRoot) : undefined;
        const selected = async (): Promise<ClientEnvelope | undefined> => {
            if (derived === undefined) return undefined;
            const existing = await this.#db.envelope_get_workspace_by_name.get<{ id: number; hidden_at: string | null }>({ name: derived });
            if (existing === undefined) return undefined;
            // {§machine-processes} Creating by the folder selects a hidden workspace and shows it.
            if (existing.hidden_at !== null) await this.setWorkspaceHidden({ workspaceId: existing.id, hidden: false });
            return this.#labelled(await Envelope.attachToWorkspace(this.#db, existing.id));
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

    // {§methods-workspace-create} Selection is passive and never searches by the stored project folder.
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

    // {§session-external-reference} The adapter interprets the key; core retains its target by identity.
    async readSessionReference(args: Parameters<ApplicationPort["readSessionReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["readSessionReference"]>>> {
        return SessionReferences.read(this.#db, args);
    }

    async ensureSessionReference(args: Parameters<ApplicationPort["ensureSessionReference"]>[0]): Promise<Awaited<ReturnType<ApplicationPort["ensureSessionReference"]>>> {
        const { binding, created } = await SessionReferences.ensure(this.#db, args);
        if (created) {
            const env = await this.attachWorkspace(binding);
            this.#broadcast("all", "workspace/created", { id: env.workspaceId, name: env.workspaceName, projectRoot: env.projectRoot, projectLabel: env.projectLabel });
        }
        return binding;
    }

    async listSessionReferences({ workspaceId, sessionId, namespace }: Parameters<ApplicationPort["listSessionReferences"]>[0]): Promise<string[]> {
        await this.#assertSessionOwned(workspaceId, sessionId);
        return (await this.#db.session_reference_list.all<{ reference: string }>({ namespace, session_id: sessionId })).map(({ reference }) => reference);
    }

    rollback(args: { workspaceId: number; sessionId: number; actor: string; to: string }): Promise<RollbackReport> {
        return this.#clientOperations.rollback(args);
    }

    async renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.rename", "workspaceId", workspaceId);
        const checkedName = ClientInput.assertOptionalWorkspaceName("workspace.rename", "name", name);
        if (checkedName === undefined) throw new Error("ClientInput.assertOptionalWorkspaceName accepted a required name as undefined");
        const renamed = { id: checkedWorkspaceId, name: await Envelope.updateWorkspaceName(this.#db, checkedWorkspaceId, checkedName) };
        // {§notifications}
        this.#broadcast({ workspaceId: checkedWorkspaceId }, "workspace/renamed", renamed);
        return renamed;
    }

    // {§methods-workspace-create} {§machine-processes}
    async setWorkspaceHidden(args: { readonly workspaceId: number; readonly hidden: boolean }): Promise<ApplicationWorkspaceHiding> {
        const workspaceId = ClientInput.assertId("workspace.hidden", "workspaceId", args.workspaceId);
        const hidden = ClientInput.assertFlag("workspace.hidden", "hidden", args.hidden);
        const { hiding, changed } = await Places.setWorkspaceHidden(this.#db, (id) => this.#placeGates(id), workspaceId, hidden);
        // {§notifications}
        if (changed) this.#broadcast({ workspaceId }, "workspace/hidden", hiding);
        return hiding;
    }

    // {§methods-workspace-create} {§machine-processes}
    async setSessionHidden(args: { readonly workspaceId: number; readonly sessionId: number; readonly hidden: boolean }): Promise<ApplicationSessionHiding> {
        const workspaceId = ClientInput.assertId("session.hidden", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.hidden", "sessionId", args.sessionId);
        const hidden = ClientInput.assertFlag("session.hidden", "hidden", args.hidden);
        const hiding = await Places.setSessionHidden(this.#db, (id) => this.#placeGates(id), workspaceId, sessionId, hidden);
        // {§notifications}
        if (hiding.sessionIds.length > 0) this.#broadcast({ workspaceId }, "session/hidden", hiding);
        return hiding;
    }

    // The gates a hide is refused over, as the overview counts them.
    async #placeGates(workspaceId: number): ReturnType<PlaceGates> {
        return {
            proposals: await this.#engine.pendingProposals(workspaceId),
            questions: await this.#engine.pendingClientInteractions(workspaceId),
        };
    }

    // {§methods-workspace-create}: a fresh session is model-origin, with an empty private log.
    // {§machine-processes} Sessions have independent histories within a shared workspace.
    async createSession(args: ApplicationSessionCreation): Promise<{ sessionId: number; sessionName: string }> {
        const workspaceId = ClientInput.assertId("session.create", "workspaceId", args.workspaceId);
        const name = ClientInput.assertOptionalSessionName("session.create", "name", args.name);
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
        const parentSessionId = args.parentSessionId === undefined ? undefined : ClientInput.assertId("session.create", "parentSessionId", args.parentSessionId);
        if (parentSessionId !== undefined) {
            if (args.owner !== undefined) throw daemonFailure("session:owner", "child-owner-inherited", 400,
                "A child inherits its parent's owner.", { workspaceId, parentSessionId });
            const parent = await this.readSession({ workspaceId, identity: { id: parentSessionId } });
            if (parent === null) throw daemonFailure("session:owner", "session-not-found", 404,
                `Parent session ${parentSessionId} does not belong to workspace ${workspaceId}.`, { workspaceId, parentSessionId });
        } else if (args.owner !== undefined) {
            await SessionOwners.registered(this.#db, workspaceId, args.owner);
        }
        let session;
        try { session = await Envelope.createModelSession(this.#db, workspaceId, name, parentSessionId, args.owner); }
        catch (error) {
            if (name === undefined || !(error instanceof SessionNameConflictError)) throw error;
            throw await this.#sessionNameConflict(workspaceId, name);
        }
        return { sessionId: session.id, sessionName: session.name };
    }

    // {§methods-workspace-create} The claim decides a name, so a request that loses it to another, at any moment, is refused alike.
    async #sessionNameConflict(workspaceId: number, name: string): Promise<Error> {
        const taken = await this.#db.envelope_get_session_by_name.get<{ id: number; origin: string }>({ workspace_id: workspaceId, name });
        return daemonFailure(
            "daemon:session",
            "name-conflict",
            409,
            `Session name '${name}' is already in use in workspace ${workspaceId}${taken === undefined ? "" : ` by a ${taken.origin} session`}.`,
            { workspaceId, name, ...(taken === undefined ? {} : { actualOrigin: taken.origin }), recovery: "Choose another session name.", retryable: false },
        );
    }

    // {§session-scheme} — branch a session's log while sharing its workspace.
    // Core owns the workspace check and immutable session-name admission.
    async forkSession(args: { workspaceId: number; sessionId: number; name?: string }): Promise<{ sessionId: number; sessionName: string | null; parentSessionId: number }> {
        const workspaceId = ClientInput.assertId("run.fork", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("run.fork", "sessionId", args.sessionId);
        const name = ClientInput.assertOptionalSessionName("run.fork", "name", args.name);
        // {§machine-processes} A branch is a model's: only a model session's log forks.
        await this.#sessionModels.assertModelSession(workspaceId, sessionId);
        let branchSessionId;
        try { branchSessionId = await Fork.fork(this.#db, sessionId, name); }
        catch (error) {
            if (name === undefined || !(error instanceof SessionNameConflictError)) throw error;
            throw await this.#sessionNameConflict(workspaceId, name);
        }
        const branch = await this.#db.envelope_get_session_by_id.get<{ name: string }>({ id: branchSessionId });
        return { sessionId: branchSessionId, sessionName: branch?.name ?? null, parentSessionId: sessionId };
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

    // {§module-functionality-adapter}
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

    // {§mcp-launch-environment}
    operatorEnvironment(): NodeJS.ProcessEnv {
        return ExecEnv.withoutOwnSecrets(process.env, this.#hostPaths);
    }

    async readSessionEnvironment(workspaceId: number, sessionId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
        await this.#assertSessionOwned(workspaceId, sessionId);
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
            session_id: number;
            origin: string;
        }>({});
        const invalidOrphan = orphanSources.find(({ origin }) => origin !== "model");
        if (invalidOrphan !== undefined) {
            throw new Error(
                `Orphaned provider work belongs to ${invalidOrphan.origin} session ${invalidOrphan.session_id}; only model sessions may enter inference.`,
            );
        }
        for (const source of orphanSources) {
            await this.#drains.reconcileOrphanedMessages(source.session_id, source.loop_id);
        }

        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§packet-inject}
        const queued = await this.#db.recovery_queued_sessions.all<{
            session_id: number;
            workspace_id: number;
            origin: string;
        }>({});
        const invalidQueued = queued.find(({ origin }) => origin !== "model");
        if (invalidQueued !== undefined) {
            throw new Error(
                `Queued provider work belongs to ${invalidQueued.origin} session ${invalidQueued.session_id}; only model sessions may enter inference.`,
            );
        }
        const parked = await this.#db.recovery_parked_sessions.all<{
            session_id: number;
            workspace_id: number;
            origin: string;
        }>({});
        const invalidParked = parked.find(({ origin }) => origin !== "model");
        if (invalidParked !== undefined) {
            throw new Error(
                `Parked provider work belongs to ${invalidParked.origin} session ${invalidParked.session_id}; only model sessions may enter inference.`,
            );
        }
        for (const row of queued) {
            const started = await this.#drains.ensureDrain({
                workspaceId: row.workspace_id,
                sessionId: row.session_id,
                systemPrompt });
            started?.drainPromise.catch((err: unknown) => {
                if (this.#started) {
                    console.error(`recovered drain failed for session ${row.session_id}:`, err);
                }
            });
        }
        for (const row of parked) {
            await this.#drains.scheduleWakes(
                row.workspace_id,
                row.session_id,
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
        // closure before cancelling active sessions: an SSE connection may itself be
        // waiting for the session cancellation that follows.
        const modulePhases = this.#modules.beginStop();
        const moduleStop = shutdown.settle("modules stop", () => modulePhases.stop());

        // Drain order: (1) tell the supervisor to abort session scopes so
        // strike paths don't keep going, (2) await its active drains
        // to completion, (3) drain streaming schemes' background work
        // (exec spawn cleanup, channel writes). Only THEN close the DB
        // upstream — drain queries hit the DB right up until they exit.
        // Abort every session's cancellation scope — stops in-flight loops AND the
        // streams (background execs) linked to them, so idle() doesn't block on
        // a long-running command. Covers sessions whose drain already exited but
        // whose exec is still in flight.
        // Settle the stopped world FIRST: a drain paused at a pending proposal awaits a resolution
        // that will never arrive once clients are gone — allSettled(drains) below would deadlock
        // the stop forever (a daemon with a pending HITL proposal could not shut down).
        // {§module-shutdown-order} — the settle sequence is DEADLINE-BOUNDED: a child
        // that never closes (a wedged MCP server, a stuck stream) must not hang
        // the daemon forever. Past the deadline the waits are abandoned; the
        // process may exit with the WAL in place (SQLite recovers) rather than
        // leak as a live-but-wedged tree.
        const drainResult = await shutdown.settle("drains idle", () => this.#drains.idle());
        const clientResult = await shutdown.settle("client operations idle", () => this.#clientOperations.idle());
        const residencyResult = await shutdown.settle("workspace Functionality transitions", () => this.#residency.settle());
        // A boundary publication queued behind the last turn settles before
        // modules close and before the DB goes away ({§functionality-coordinator}).
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
        // {§content-store} — the last database step before the caller closes SQLite:
        // planner statistics refreshed on the writer, bounded by SQLite's own analysis limit.
        // {§content-store} — the operator's retention runs once more before the statistics.
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
        await this.#assertSessionOwned(workspaceId, sessionId);
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
