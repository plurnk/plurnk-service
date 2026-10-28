// {§methods-workspace-create} {§machine-processes} {§session-scheme} {§session-external-reference}
// Workspace and session envelope operations, listing, overview, hiding, references, and forking.

import {
    isSafeInteger,
    type ApplicationGauge,
    type ApplicationLoopProjection,
    type ApplicationSessionCreation,
    type ApplicationSessionHiding,
    type ApplicationSessionIdentity,
    type ApplicationSessionOverview,
    type ApplicationSessionProjection,
    type ApplicationSessionQuery,
    type ApplicationWorkspaceHiding,
    type ClientEnvelope,
    type SessionOwner,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Knob } from "@plurnk/plurnk-meta";
import type { ProviderAccounting } from "@plurnk/plurnk-providers";
import type { Db } from "../core/Db.ts";
import Engine from "../core/Engine.ts";
import Fork from "../core/fork.ts";
import type HostPaths from "../core/HostPaths.ts";
import Results from "../core/results.ts";
import RuntimeSession from "../core/RuntimeSession.ts";
import { SessionNameConflictError } from "../core/SessionName.ts";
import SessionOwners from "../core/SessionOwners.ts";
import { observed } from "../observe/spans.ts";
import ClientInput from "./client-input.ts";
import type { NotifyTarget } from "./Daemon.ts";
import { daemonFailure } from "./daemon-results.ts";
import Envelope, { projectSessionRow, type WorkspaceEnvelope, type WorkspaceRow } from "./envelope.ts";
import Places, { type PlaceGates } from "./Places.ts";
import type SessionModels from "./SessionModels.ts";
import SessionOverview from "./SessionOverview.ts";
import SessionReferences from "./SessionReferences.ts";

export default class WorkspacePlaces {
    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #engine: () => Engine;
    readonly #sessionModels: () => SessionModels;
    readonly #broadcast: (target: NotifyTarget, method: string, params?: unknown) => void;

    constructor(args: {
        readonly db: Db;
        readonly hostPaths: HostPaths;
        readonly engine: () => Engine;
        readonly sessionModels: () => SessionModels;
        readonly broadcast: (target: NotifyTarget, method: string, params?: unknown) => void;
    }) {
        this.#db = args.db;
        this.#hostPaths = args.hostPaths;
        this.#engine = args.engine;
        this.#sessionModels = args.sessionModels;
        this.#broadcast = args.broadcast;
    }

    // {§execution-output-identity} — the folder as the daemon spells it for display: the spelling a default name takes.
    #projectLabel(projectRoot: string | null): string | null {
        return projectRoot === null ? null : this.#hostPaths.abbreviateUserPath(projectRoot);
    }

    #labelled(envelope: WorkspaceEnvelope): ClientEnvelope {
        return { ...envelope, projectLabel: this.#projectLabel(envelope.projectRoot) };
    }

    async assertSessionOwned(workspaceId: number, sessionId: number): Promise<void> {
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

    async ensureRuntimeSession(workspaceId: number): Promise<number> {
        const checked = ClientInput.assertId("session.ensure-runtime", "workspaceId", workspaceId);
        if (await this.#db.envelope_get_workspace.get({ id: checked }) === undefined) {
            throw daemonFailure("session:owner", "workspace-not-found", 404, `Workspace ${checked} does not exist.`);
        }
        return RuntimeSession.ensure(this.#db, checked);
    }

    async listWorkspaces(query: { readonly hidden?: boolean } = {}): Promise<Array<WorkspaceRow & { project_label: string | null }>> {
        const hidden = query.hidden === undefined ? undefined : ClientInput.assertFlag("workspace.list", "hidden", query.hidden);
        return (await Envelope.listWorkspaces(this.#db, hidden)).map((row) => ({ ...row, project_label: this.#projectLabel(row.project_root) }));
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
        await this.assertSessionOwned(workspaceId, sessionId);
        return this.#engine().sessionAccounting(sessionId);
    }

    // {§methods-workspace-create}
    async sessionGauge(args: { workspaceId: number; sessionId: number }): Promise<ApplicationGauge> {
        const workspaceId = ClientInput.assertId("session.gauge", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.gauge", "sessionId", args.sessionId);
        await this.assertSessionOwned(workspaceId, sessionId);
        const latest = await this.#db.application_latest_packet_loop.get<{ id: number }>({ session_id: sessionId });
        if (latest === undefined) return { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };
        return Engine.clientGauge(await this.#engine().loopGauge(latest.id));
    }

    async listSessionLoops(args: {
        workspaceId: number;
        sessionId: number;
    }): Promise<ApplicationLoopProjection[]> {
        const workspaceId = ClientInput.assertId("session.loops", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.loops", "sessionId", args.sessionId);
        await this.assertSessionOwned(workspaceId, sessionId);
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
        const engine = this.#engine();
        return await SessionOverview.read(this.#db, {
            workspaceId, limit, excerptChars, projectLabel: (projectRoot) => this.#projectLabel(projectRoot),
            // {§acp-status-descendants} The gates the status tree counts: the pending proposals and client interactions.
            pending: async (id) => [...await engine.pendingProposals(id), ...await engine.pendingClientInteractions(id)],
        });
    }

    listPrompts(workspaceId: number, limit?: number, sessionId?: number): Promise<string[]> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.prompts", "workspaceId", workspaceId);
        const checkedLimit = ClientInput.assertLimit("workspace.prompts", limit);
        const checkedSessionId = sessionId === undefined ? null : ClientInput.assertId("workspace.prompts", "sessionId", sessionId);
        return Envelope.listPromptsForWorkspace(this.#db, checkedWorkspaceId, checkedLimit ?? Knob.integer("PLURNK_SERVICE_PROMPTS_PAGE", 1), checkedSessionId);
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
        await this.assertSessionOwned(workspaceId, sessionId);
        return (await this.#db.session_reference_list.all<{ reference: string }>({ namespace, session_id: sessionId })).map(({ reference }) => reference);
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
        const engine = this.#engine();
        return {
            proposals: await engine.pendingProposals(workspaceId),
            questions: await engine.pendingClientInteractions(workspaceId),
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
        await this.#sessionModels().assertModelSession(workspaceId, sessionId);
        let branchSessionId;
        try { branchSessionId = await Fork.fork(this.#db, sessionId, name); }
        catch (error) {
            if (name === undefined || !(error instanceof SessionNameConflictError)) throw error;
            throw await this.#sessionNameConflict(workspaceId, name);
        }
        const branch = await this.#db.envelope_get_session_by_id.get<{ name: string }>({ id: branchSessionId });
        return { sessionId: branchSessionId, sessionName: branch?.name ?? null, parentSessionId: sessionId };
    }
}
