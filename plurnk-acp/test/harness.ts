import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type ClientApp,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import type {
    ApplicationEventHandler,
    ApplicationInboxMessage,
    ApplicationLoopProjection,
    ApplicationSessionProjection,
    ApplicationStream,
    CapabilityPolicy,
    ClientInteractionProjection,
    CredentialAuthority,
    CredentialClaims,
    CredentialFace,
    Effort,
    LogEntryWire,
    ModelRoute,
    ProblemDetails,
    ProposalProjection,
    TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import Module, { type AcpSetupSeam } from "../src/Module.ts";

export const WsConstructor = WebSocket as unknown as WebSocketConstructor;

export const createAcpClient = (): ClientApp =>
    createRawAcpClient().onConnect((conn) => {
        void conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "test-client", version: "1.0.0" },
        });
    });

export interface ProblemError extends Error {
    problem?: ProblemDetails;
}

export const makeLogEntry = (
    overrides: Partial<LogEntryWire> & Pick<LogEntryWire, "id" | "session_id" | "op">,
): LogEntryWire => ({
    session_name: "user",
    loop_id: 1,
    loop_seq: 1,
    turn_id: 1,
    turn_seq: 1,
    sequence: 1,
    at: "2026-10-25T00:00:00.000Z",
    origin: "model",
    source: null,
    signal: null,
    scheme: null,
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname: null,
    query: null,
    fragment: null,
    lineMarker: null,
    tx: null,
    mimetype_tx: "text/plain",
    rx: { status: 200, content: "", mimetype: "text/plain" },
    mimetype_rx: "text/plain",
    status_rx: 200,
    weight: 10,
    attrs: {},
    state: "resolved",
    ...overrides,
});

export const makeTerminatedEvent = (
    overrides: Partial<TerminatedNotification> & Pick<TerminatedNotification, "sessionId" | "loopId">,
): TerminatedNotification => ({
    loopSeq: 1,
    result: { status: 200 },
    hitMaxTurns: false,
    turnIds: [1],
    attributions: [],
    terminatedAt: 1700000001000,
    usage: {
        accounting: {
            requests: [],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            knownUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            costUsd: "0.001",
            knownCostUsd: "0.001",
        },
        curationWeight: 100,
        curationBudget: 4000,
        contextTokens: 150,
        contextCapacity: 128000,
        meta: {},
    },
    ...overrides,
});

export interface Harness {
    readonly port: ApplicationPort & {
        emitEvent(workspaceId: number, method: string, params: unknown): void;
        setAuthMode(mode: "none" | "oauth"): void;
        revokeFamily(familyId: string): void;
        readonly proposals: ProposalProjection[];
        readonly interactions: ClientInteractionProjection[];
        readonly streams: ApplicationStream[];
        readonly inbox: ApplicationInboxMessage[];
        readonly logs: LogEntryWire[];
        readonly entryContents: Map<string, string>;
        readonly sessions: Array<Omit<ApplicationSessionProjection, "hidden_at"> & { workspaceId: number; hidden_at: string | null }>;
        readonly workspaces: Array<{
            id: number;
            name: string;
            project_root: string | null;
            project_label: string | null;
            created_at: string;
            hidden_at: string | null;
        }>;
    };
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly acpModule: Module;
    close(): Promise<void>;
}

export const createHarness = async (options?: {
    authMode?: "none" | "oauth";
    env?: Record<string, string>;
}): Promise<Harness> => {
    const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>>();
    const upgrades = new Map<string, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const eventHandlers = new Set<ApplicationEventHandler>();
    const revocationHandlers = new Set<(familyId: string) => void>();
    let authMode: "none" | "oauth" = options?.authMode ?? "none";

    const workspaces: Harness["port"]["workspaces"] = [
        {
            id: 1,
            name: "alpha",
            project_root: "/workspace/alpha",
            project_label: "alpha",
            created_at: "2026-10-25T00:00:00.000Z",
            hidden_at: null,
        },
    ];
    const sessions: Harness["port"]["sessions"] = [
        {
            id: 1,
            workspaceId: 1,
            name: "user",
            created_at: "2026-10-25T00:00:00.000Z",
            origin: "model",
            owner: "acp://operator",
            parentSessionId: null,
            kind: "root",
            lifecycle: "idle",
            hidden_at: null,
        },
    ];
    const proposals: ProposalProjection[] = [];
    const interactions: ClientInteractionProjection[] = [];
    const streams: ApplicationStream[] = [];
    const inbox: ApplicationInboxMessage[] = [];
    const logs: LogEntryWire[] = [];
    const entryContents = new Map<string, string>();
    const messageAddresses = new Map<string, string>();
    const memberDefinitions = new Map<number, string[]>();
    const mcpDefinitions = new Map<number, Array<{ alias: string; definition: unknown }>>();
    let currentModel: ModelRoute = {
        alias: "fast",
        provider: "mocktest",
        model: "mock-v1",
        effort: "medium",
        effortSource: "default",
    };
    let currentSpawnModel: ModelRoute | null = null;
    let currentEffort: Effort = "medium";
    let currentEffortSource: "default" | "explicit" = "default";
    let currentPolicy: CapabilityPolicy = {};

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        for (const [prefix, handler] of [...routes.entries()].toSorted((a, b) => b[0].length - a[0].length)) {
            if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
                await handler(req, res);
                return;
            }
        }
        res.writeHead(404).end();
    });

    server.on("upgrade", async (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        for (const [prefix, handler] of [...upgrades.entries()].toSorted((a, b) => b[0].length - a[0].length)) {
            if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
                await handler(req, socket, head);
                return;
            }
        }
        socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const portNum = typeof address === "object" && address !== null ? address.port : 0;

    const oauthFace: CredentialFace = {
        issuer: () => `http://127.0.0.1:${portNum}`,
    };

    const credentials: CredentialAuthority = {
        operatorSecret: null,
        issue: ({ ttlMs }) => ({ token: "valid-token", expiresAt: Date.now() + ttlMs }),
        verify: (token): CredentialClaims | null => {
            if (token === "valid-token") {
                return {
                    kind: "access",
                    subject: "acp://operator",
                    clientId: "test-client",
                    scopes: ["acp"],
                    family: "fam-1",
                    expiresAt: Date.now() + 60_000,
                };
            }
            if (token === "no-scope-token") {
                return {
                    kind: "access",
                    subject: "acp://operator",
                    clientId: "test-client",
                    scopes: ["other"],
                    family: "fam-1",
                    expiresAt: Date.now() + 60_000,
                };
            }
            return null;
        },
        consume: () => ({ reusedFamily: null }),
        revokeFamily: (family) => {
            for (const handler of revocationHandlers) handler(family);
        },
        onRevoked: (listener) => {
            revocationHandlers.add(listener);
            return () => revocationHandlers.delete(listener);
        },
        sessions: () => [],
        registerClient: ({ id }) => ({ clientId: id, clientSecret: "secret" }),
        client: () => null,
        authenticateClient: () => false,
        publish: () => {},
        face: () => (authMode === "oauth" ? oauthFace : null),
    };

    const port: Harness["port"] = {
        workspaces,
        sessions,
        proposals,
        interactions,
        streams,
        inbox,
        logs,
        entryContents,
        emitEvent(workspaceId, method, params) {
            for (const handler of eventHandlers) handler(workspaceId, method, params);
        },
        setAuthMode(mode) {
            authMode = mode;
        },
        revokeFamily(familyId) {
            credentials.revokeFamily(familyId);
        },
        registerHttpRoute(prefix, handler) {
            routes.set(prefix, handler);
        },
        registerHttpUpgrade(prefix, handler) {
            upgrades.set(prefix, handler);
        },
        httpAddress() {
            return { host: "127.0.0.1", port: portNum };
        },
        credentials,
        registerSessionOwner: async () => {},
        claimSessionOwner: async ({ owner }) => ({
            address: owner,
            tools: ["request_approval", "question", "mcp_input_required"],
            interactive: true,
        }),
        configurationNotices: () => [],
        listClientDisplayCapabilities: async () => [],
        listModuleActions: () => [
            {
                name: "workspace.mcp.list",
                scope: "workspace",
                inputSchema: { type: "object", additionalProperties: false, properties: {} },
                outputSchema: {
                    type: "object",
                    required: ["items"],
                    additionalProperties: false,
                    properties: { items: { type: "array", items: { type: "object" } } },
                },
            },
            {
                name: "workspace.mcp.replace",
                scope: "workspace",
                inputSchema: {
                    type: "object",
                    additionalProperties: true,
                    required: ["alias"],
                    properties: { alias: { type: "string" } },
                },
                outputSchema: { type: "object" },
            },
            {
                name: "workspace.members.list",
                scope: "workspace",
                inputSchema: { type: "object", additionalProperties: false, properties: {} },
                outputSchema: {
                    type: "object",
                    required: ["definitions"],
                    additionalProperties: false,
                    properties: { definitions: { type: "array", items: { type: "object" } } },
                },
            },
            {
                name: "workspace.members.add",
                scope: "workspace",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["files"],
                    properties: { files: { type: "array", items: { type: "string" } } },
                },
                outputSchema: { type: "object" },
            },
        ],
        invokeModuleAction: async (name, input, context) => {
            const wsId = context.scope === "workspace" ? context.workspaceId : 1;
            if (name === "workspace.mcp.list") {
                const items = mcpDefinitions.get(wsId) ?? [];
                return {
                    items: items.map((d) => ({ alias: d.alias, definition: d.definition, state: "active", enabled: true })),
                };
            }
            if (name === "workspace.mcp.replace") {
                const { alias, ...definition } = input as { alias: string; [key: string]: unknown };
                const existing = mcpDefinitions.get(wsId) ?? [];
                const idx = existing.findIndex((d) => d.alias === alias);
                if (idx >= 0) existing[idx] = { alias, definition };
                else existing.push({ alias, definition });
                mcpDefinitions.set(wsId, existing);
                return { alias, definition, state: "active", enabled: true };
            }
            if (name === "workspace.members.add") {
                const { files } = input as { files: string[] };
                const existing = memberDefinitions.get(wsId) ?? [];
                for (const p of files) {
                    if (!existing.includes(p)) existing.push(p);
                }
                memberDefinitions.set(wsId, existing);
                return {
                    definitions: existing.map((alias) => ({ alias, state: "active", enabled: true })),
                };
            }
            if (name === "workspace.members.list") {
                const existing = memberDefinitions.get(wsId) ?? [];
                return {
                    definitions: existing.map((alias) => ({ alias, state: "active", enabled: true })),
                };
            }
            throw new Error(`Unexpected module action ${name}`);
        },
        subscribeToEvents: (handler) => {
            eventHandlers.add(handler);
            return () => eventHandlers.delete(handler);
        },
        pendingProposals: async () => proposals,
        resolveProposal: async (logEntryId) => {
            const idx = proposals.findIndex((p) => p.logEntryId === logEntryId);
            if (idx === -1) {
                const err: ProblemError = new Error(
                    `The named proposal or interaction interrupt '${logEntryId}' is not pending`,
                );
                err.problem = {
                    type: "https://plurnk.xyz/problems/acp/interrupt-not-pending",
                    title: "Conflict",
                    status: 409,
                    code: "acp/interrupt-not-pending",
                    detail: `The named proposal or interaction interrupt '${logEntryId}' is not pending`,
                };
                throw err;
            }
            proposals.splice(idx, 1);
        },
        pendingClientInteractions: async () => interactions,
        resolveClientInteraction: async (interactionId) => {
            const idx = interactions.findIndex((i) => i.interactionId === interactionId);
            if (idx === -1) {
                const err: ProblemError = new Error(
                    `The named proposal or interaction interrupt '${interactionId}' is not pending`,
                );
                err.problem = {
                    type: "https://plurnk.xyz/problems/acp/interrupt-not-pending",
                    title: "Conflict",
                    status: 409,
                    code: "acp/interrupt-not-pending",
                    detail: `The named proposal or interaction interrupt '${interactionId}' is not pending`,
                };
                throw err;
            }
            interactions.splice(idx, 1);
        },
        readMessages: async () => [],
        readInbox: async () => inbox,
        readStreams: async () => streams,
        messageAdmission: async ({ address: msgAddr, body }) => {
            const existing = messageAddresses.get(msgAddr);
            if (existing === undefined) {
                messageAddresses.set(msgAddr, body);
                return "new";
            }
            if (existing === body) return "accepted";
            const err: ProblemError = new Error("Message address reused with different body");
            err.problem = {
                type: "https://plurnk.xyz/problems/core/message-address-reused",
                title: "Unprocessable Entity",
                status: 422,
                code: "core/message-address-reused",
                detail: "Message address reused with different body.",
            };
            throw err;
        },
        ensureRuntimeSession: async () => 999,
        runLoop: async ({ workspaceId, sessionId, prompt }) => {
            setImmediate(() => {
                port.emitEvent(workspaceId, "log/entry", {
                    entry: makeLogEntry({
                        id: logs.length + 1,
                        session_id: sessionId,
                        session_name: sessions.find((w) => w.id === sessionId)?.name ?? "user",
                        op: "SEND",
                        attrs: { kind: "message", to: "acp://operator", body: `Echo: ${prompt}` },
                        rx: { status: 200, content: `Echo: ${prompt}`, mimetype: "text/markdown" },
                        mimetype_rx: "text/markdown",
                    }),
                });
                port.emitEvent(
                    workspaceId,
                    "loop/terminated",
                    makeTerminatedEvent({ sessionId, loopId: 1 }),
                );
            });
            return {
                status: 102,
                action: "enqueued_new_loop",
                loopId: 1,
            };
        },
        cancelDrain: () => true,
        cancelSession: async () => {},
        dispatchClientAction: async ({ statements }) => {
            for (const stmt of statements) {
                if (
                    stmt.op === "EDIT" &&
                    stmt.target?.kind === "url" &&
                    typeof stmt.body === "string"
                ) {
                    const ch = stmt.target.fragment ?? "body";
                    entryContents.set(`${stmt.target.raw}#${ch}`, stmt.body);
                }
            }
            return statements.map(() => ({
                status: 200,
                message: "OK",
                content: "executed",
                mimetype: "text/plain",
            }));
        },
        cancelLoop: async () => true,
        executorTags: () => ["sh", "js"],
        readLog: async ({ sessionId, loopSeq }) =>
            logs.filter((l) => l.session_id === sessionId && (loopSeq === undefined || l.loop_seq === loopSeq)),
        listProviders: () => ({
            aliases: [
                {
                    alias: "fast",
                    provider: "mocktest",
                    model: "mock-v1",
                    effort: "medium",
                    effortSource: "default",
                    active: true,
                    inputCapacity: 128000,
                },
            ],
        }),
        listModels: () => ({
            total: 1,
            offset: 0,
            items: [
                {
                    selector: "mocktest/mock-v1",
                    provider: "mocktest",
                    providerName: "MockTest",
                    model: "mock-v1",
                    modelName: "Mock V1",
                    limits: { contextTokens: 128000, inputTokens: 128000, outputTokens: 16000 },
                    capabilities: {
                        attachment: false,
                        reasoning: true,
                        efforts: ["low", "medium", "high"],
                        toolCall: false,
                        structuredOutput: false,
                        inputModalities: ["text"],
                        outputModalities: ["text"],
                    },
                    readiness: { ready: true, causes: [] },
                },
            ],
        }),
        createWorkspace: async ({ name, projectRoot }) => {
            const existing = workspaces.find((w) => (name ? w.name === name : w.project_root === projectRoot));
            if (existing) {
                return {
                    workspaceId: existing.id,
                    workspaceName: existing.name,
                    projectRoot: existing.project_root,
                    projectLabel: existing.project_label,
                };
            }
            const created = {
                id: workspaces.length + 1,
                name: name ?? `ws-${workspaces.length + 1}`,
                project_root: projectRoot ?? null,
                project_label: name ?? `ws-${workspaces.length + 1}`,
                created_at: new Date().toISOString(),
                hidden_at: null,
            };
            workspaces.push(created);
            return {
                workspaceId: created.id,
                workspaceName: created.name,
                projectRoot: created.project_root,
                projectLabel: created.project_label,
            };
        },
        attachWorkspace: async (args) => {
            const found = workspaces.find((w) =>
                "workspaceId" in args && args.workspaceId !== undefined
                    ? w.id === args.workspaceId
                    : "name" in args && args.name !== undefined
                      ? w.name === args.name
                      : "projectRoot" in args
                        ? w.project_root === args.projectRoot
                        : false,
            );
            if (!found) {
                const err: ProblemError = new Error("Workspace not found");
                err.problem = {
                    type: "https://plurnk.xyz/problems/core/workspace-not-found",
                    title: "Not Found",
                    status: 404,
                    code: "core/workspace-not-found",
                    detail: "Workspace not found.",
                };
                throw err;
            }
            return {
                workspaceId: found.id,
                workspaceName: found.name,
                projectRoot: found.project_root,
                projectLabel: found.project_label,
            };
        },
        readSessionReference: async ({ reference }) => {
            const found = sessions.find((w) => w.name === reference);
            return found ? { workspaceId: found.workspaceId, sessionId: found.id } : null;
        },
        ensureSessionReference: async ({ reference }) => {
            const found = sessions.find((w) => w.name === reference);
            if (found) return { workspaceId: found.workspaceId, sessionId: found.id };
            const created: ApplicationSessionProjection & { workspaceId: number } = {
                id: sessions.length + 1,
                workspaceId: 1,
                name: reference,
                created_at: "2026-10-25T00:00:00.000Z",
                origin: "model",
                owner: "acp://operator",
                parentSessionId: null,
                kind: "root",
                lifecycle: "idle",
                hidden_at: null,
            };
            sessions.push(created);
            return { workspaceId: 1, sessionId: created.id };
        },
        listSessionReferences: async () => [],
        listWorkspaces: async (query) =>
            workspaces.filter((w) =>
                query?.hidden === undefined ? true : query.hidden ? w.hidden_at !== null : w.hidden_at === null,
            ),
        listSessions: async (workspaceId, query) =>
            sessions.filter(
                (w) =>
                    w.workspaceId === workspaceId &&
                    (query?.hidden === undefined
                        ? true
                        : query.hidden
                          ? w.hidden_at !== null
                          : w.hidden_at === null),
            ),
        readSession: async ({ workspaceId, identity }) => {
            const found = sessions.find(
                (w) =>
                    w.workspaceId === workspaceId &&
                    ("id" in identity && identity.id !== undefined ? w.id === identity.id : w.name === identity.name),
            );
            return found ?? null;
        },
        listSessionLoops: async ({ sessionId }): Promise<ApplicationLoopProjection[]> => [
            {
                id: 1,
                sessionId,
                sequence: 1,
                status: 200,
                prompt: "Hello world",
                promptSource: "acp://operator/sessions/1%23user/messages/msg-1",
                claimedAt: "2026-10-25T00:00:00.000Z",
                terminatedAt: "2026-10-25T00:00:01.000Z",
                terminalResult: { status: 200 },
                packetCount: 1,
                waitUntil: null,
                invocation: null,
            },
        ],
        readSessionOverview: async ({ workspaceId }) => ({
            workspaces: workspaces.map((w) => ({
                id: w.id,
                name: w.name,
                projectRoot: w.project_root,
                projectLabel: w.project_label,
            })),
            sessions: sessions
                .filter((w) => w.hidden_at === null && (!workspaceId || w.workspaceId === workspaceId))
                .map((w) => ({
                    workspaceId: w.workspaceId,
                    id: w.id,
                    name: w.name,
                    parentSessionId: w.parentSessionId,
                    kind: w.kind,
                    lifecycle: w.lifecycle,
                    gates: 0,
                    reply: {
                        id: 1,
                        coordinate: "1/1/1",
                        completion: 200 as const,
                        at: 1700000001000,
                        excerpt: "Echo: hello",
                        continued: false,
                    },
                })),
            omitted: 0,
        }),
        sessionAccounting: async () => ({
            requests: [],
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            knownUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            costUsd: "0.0025",
            knownCostUsd: "0.0025",
        }),
        sessionGauge: async () => ({
            curationWeight: 120,
            curationBudget: 4000,
            contextTokens: 150,
            contextCapacity: 128000,
        }),
        listPrompts: async () => ["Hello world"],
        shareWorkspace: async ({ folder }) => ({ folder }),
        renameWorkspace: async (workspaceId, name) => {
            const ws = workspaces.find((w) => w.id === workspaceId);
            if (ws) ws.name = name;
            return { id: workspaceId, name };
        },
        setWorkspaceHidden: async ({ workspaceId, hidden }) => {
            const ws = workspaces.find((w) => w.id === workspaceId);
            if (ws) ws.hidden_at = hidden ? new Date().toISOString() : null;
            return { id: workspaceId, hidden_at: ws?.hidden_at ?? null };
        },
        setSessionHidden: async ({ sessionId, hidden }) => {
            const w = sessions.find((item) => item.id === sessionId);
            if (w) w.hidden_at = hidden ? new Date().toISOString() : null;
            return { id: sessionId, hidden_at: w?.hidden_at ?? null, sessionIds: [sessionId] };
        },
        rollback: async ({ to }) => ({
            to,
            restored: [],
            skipped: [],
            stopped: null,
        }),
        activateWorkspace: async () => {},
        workspacePreparationStatus: () => [],
        workspaceDerivationStatus: () => null,
        readEntry: async ({ target, channel = "body", offset = 0 }) => {
            const full = entryContents.get(`${target}#${channel}`) ?? `Body for ${target}`;
            const sliced = full.slice(offset);
            return {
                status: 200,
                entry: {
                    entryId: 1,
                    target,
                    channels: {
                        [channel]: {
                            content: sliced,
                            contentOffset: offset,
                            contentLength: full.length,
                            mimetype: "text/plain",
                            weight: 1,
                            state: "static",
                        },
                    },
                },
            };
        },
        readEntryChannel: async ({ target }) => {
            const full = entryContents.get(`${target}#body`) ?? `Body for ${target}`;
            return {
                status: 200,
                entry: {
                    entryId: 1,
                    target,
                    channels: {
                        body: {
                            content: full,
                            contentOffset: 0,
                            contentLength: full.length,
                            mimetype: "text/plain",
                            weight: 1,
                            state: "static",
                        },
                    },
                },
            };
        },
        forkSession: async ({ workspaceId, sessionId, name }) => {
            const created: ApplicationSessionProjection & { workspaceId: number } = {
                id: sessions.length + 1,
                workspaceId,
                name: name ?? `fork-${sessions.length + 1}`,
                created_at: "2026-10-25T00:00:00.000Z",
                origin: "model",
                owner: "acp://operator",
                parentSessionId: sessionId,
                kind: "fork",
                lifecycle: "idle",
                hidden_at: null,
            };
            sessions.push(created);
            return { sessionId: created.id, sessionName: created.name, parentSessionId: sessionId };
        },
        createSession: async ({ workspaceId, name }) => {
            if (name === "_plurnk") {
                const err: ProblemError = new Error("Reserved session name");
                err.problem = {
                    type: "https://plurnk.xyz/problems/core/session-name-reserved",
                    title: "Bad Request",
                    status: 400,
                    code: "core/session-name-reserved",
                    detail: "Session name '_plurnk' is reserved.",
                };
                throw err;
            }
            const existing = sessions.find((w) => w.workspaceId === workspaceId && w.name === name);
            if (existing) return { sessionId: existing.id, sessionName: existing.name };
            const created: ApplicationSessionProjection & { workspaceId: number } = {
                id: sessions.length + 1,
                workspaceId,
                name: name ?? `session-${sessions.length + 1}`,
                created_at: "2026-10-25T00:00:00.000Z",
                origin: "model",
                owner: "acp://operator",
                parentSessionId: null,
                kind: "root",
                lifecycle: "idle",
                hidden_at: null,
            };
            sessions.push(created);
            return { sessionId: created.id, sessionName: created.name };
        },
        readSessionModel: async () => ({ model: currentModel, spawnModel: currentSpawnModel }),
        setSessionModel: async ({ selector, effort }) => {
            const nextEffort = (effort as Effort | undefined) ?? currentEffort;
            currentModel = {
                ...(selector.includes("/") ? {} : { alias: selector }),
                provider: selector.includes("/") ? (selector.split("/")[0] ?? "mocktest") : "mocktest",
                model: selector.includes("/") ? (selector.split("/")[1] ?? selector) : selector,
                effort: nextEffort,
                effortSource: effort ? "explicit" : currentEffortSource,
            };
            return currentModel;
        },
        setSessionSpawnModel: async ({ selector }) => {
            currentSpawnModel = selector
                ? { provider: "mocktest", model: selector, effortSource: "default" }
                : null;
            return currentSpawnModel;
        },
        readSessionEffort: async () => ({
            effort: currentEffort,
            source: currentEffortSource,
            supportedEfforts: ["low", "medium", "high"],
        }),
        setSessionEffort: async ({ effort }) => {
            currentEffort = effort as Effort;
            currentEffortSource = "explicit";
            currentModel = {
                ...currentModel,
                effort: currentEffort,
                effortSource: "explicit",
            };
            return {
                effort: currentEffort,
                source: "explicit",
                supportedEfforts: ["low", "medium", "high"],
            };
        },
        readWorkspaceCapabilities: async () => ({
            service: {},
            workspace: currentPolicy,
            effective: currentPolicy,
        }),
        setWorkspaceCapabilities: async ({ policy }) => {
            currentPolicy = policy;
            return { service: {}, workspace: currentPolicy, effective: currentPolicy };
        },
        updateService: async () => ({
            catalog: {
                status: "updated",
                providers: 12,
                models: 450,
                addedModels: 3,
                updatedAt: "2026-10-26T00:00:00.000Z",
                path: "/tmp/models.json",
            },
            service: {
                package: "@plurnk/plurnk-service",
                version: "4.4.0",
                artifact: "source",
                upgradeCommand: "npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
            },
        }),
    };

    const acpModule = Module.create({ env: options?.env });
    const setupSeam: AcpSetupSeam = {
        registerScheme: async () => {},
        httpAddress: () => ({ host: "127.0.0.1", port: portNum }),
    };
    await acpModule.setup(setupSeam);
    await acpModule.start(port);

    return {
        port,
        baseUrl: `http://127.0.0.1:${portNum}/acp`,
        wsUrl: `ws://127.0.0.1:${portNum}/acp`,
        acpModule,
        async close() {
            acpModule.stop();
            await acpModule.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};
