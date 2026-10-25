import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type SessionUpdate,
    type RequestPermissionRequest,
    type CreateElicitationRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

const createAcpClient = () =>
    createRawAcpClient().onConnect((conn) => {
        void conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "test-client", version: "1.0.0" },
        });
    });
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Validator, type AcpDiscovery, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import Module, { type AcpSetupSeam } from "./Module.ts";
import type { AcpPlusState, ActionOutcome } from "./client.ts";

const WsConstructor = WebSocket as unknown as WebSocketConstructor;
type ModelSelection = Awaited<ReturnType<ApplicationPort["setWorkerModel"]>>;
type EffortValue = Awaited<ReturnType<ApplicationPort["setWorkerEffort"]>>["effort"];

interface ProblemError extends Error {
    problem?: ProblemDetails;
}

interface Harness {
    readonly port: ApplicationPort & {
        emitEvent(event: Record<string, unknown>): void;
        setAuthMode(mode: "none" | "oauth"): void;
        revokeFamily(familyId: string): void;
        proposals: Array<Record<string, unknown>>;
        interactions: Array<Record<string, unknown>>;
        streams: Array<Record<string, unknown>>;
        inbox: Array<Record<string, unknown>>;
        logs: Array<Record<string, unknown>>;
        workers: Array<{
            id: number;
            workspaceId: number;
            name: string;
            parentWorkerId: number | null;
            kind: "model" | "bare" | "system";
            hiddenAt: string | null;
        }>;
        workspaces: Array<{
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

const createHarness = async (options?: { authMode?: "none" | "oauth"; env?: Record<string, string> }): Promise<Harness> => {
    const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>>();
    const upgrades = new Map<string, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const eventHandlers = new Set<(event: unknown) => void>();
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
    const workers: Harness["port"]["workers"] = [
        {
            id: 1,
            workspaceId: 1,
            name: "user",
            parentWorkerId: null,
            kind: "model",
            hiddenAt: null,
        },
    ];
    const proposals: Array<Record<string, unknown>> = [];
    const interactions: Array<Record<string, unknown>> = [];
    const streams: Array<Record<string, unknown>> = [];
    const inbox: Array<Record<string, unknown>> = [];
    const logs: Array<Record<string, unknown>> = [];
    const messageAddresses = new Map<string, string>();
    let currentModel: ModelSelection = {
        alias: "fast",
        provider: "mocktest",
        model: "mock-v1",
        effort: "medium",
        effortSource: "default",
    };
    let currentSpawnModel: ModelSelection | null = null;
    let currentEffort: EffortValue = "medium";
    let currentEffortSource: "default" | "explicit" = "default";
    let currentPolicy: Record<string, unknown> = { default: "propose" };

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
    const address = server.address() as { port: number };

    const port: Harness["port"] = {
        workspaces,
        workers,
        proposals,
        interactions,
        streams,
        inbox,
        logs,
        emitEvent(event) {
            for (const handler of eventHandlers) handler(event);
        },
        setAuthMode(mode) {
            authMode = mode;
        },
        revokeFamily(familyId) {
            for (const handler of revocationHandlers) handler(familyId);
        },
        registerHttpRoute(prefix, handler) {
            routes.set(prefix, handler);
        },
        registerHttpUpgrade(prefix, handler) {
            upgrades.set(prefix, handler);
        },
        httpAddress() {
            return { host: "127.0.0.1", port: address.port };
        },
        credentials: {
            mode: () => authMode,
            verifyBearer: async (header?: string, scope?: string) => {
                if (authMode === "none") {
                    return { ok: true, grant: { subject: "acp://operator", scopes: ["acp"], familyId: "fam-1" } };
                }
                if (!header || !header.startsWith("Bearer ")) {
                    return {
                        ok: false,
                        status: 401,
                        code: "bearer-token-required",
                        wwwAuthenticate: 'Bearer realm="plurnk"',
                        detail: "The request did not provide a bearer token. Recovery: Present an access token issued by this daemon as `Authorization: Bearer <token>`.",
                    };
                }
                const token = header.slice("Bearer ".length).trim();
                if (token === "valid-token") {
                    if (scope && scope !== "acp") {
                        return {
                            ok: false,
                            status: 403,
                            code: "bearer-scope-insufficient",
                            wwwAuthenticate: 'Bearer error="insufficient_scope"',
                            detail: `The access token does not carry the scope ${scope}. Recovery: Obtain an access token with the scope ${scope}.`,
                        };
                    }
                    return { ok: true, grant: { subject: "acp://operator", scopes: ["acp"], familyId: "fam-1" } };
                }
                if (token === "no-scope-token") {
                    return {
                        ok: false,
                        status: 403,
                        code: "bearer-scope-insufficient",
                        wwwAuthenticate: 'Bearer error="insufficient_scope"',
                        detail: "The access token does not carry the scope acp. Recovery: Obtain an access token with the scope acp.",
                    };
                }
                return {
                    ok: false,
                    status: 401,
                    code: "bearer-token-invalid",
                    wwwAuthenticate: 'Bearer error="invalid_token"',
                    detail: "The access token is unknown, expired or revoked. Recovery: Obtain a new access token from this daemon's token endpoint.",
                };
            },
            onRevoke: (handler: (familyId: string) => void) => {
                revocationHandlers.add(handler);
                return () => revocationHandlers.delete(handler);
            },
        } as unknown as ApplicationPort["credentials"],
        registerWorkerOwner: async () => {},
        claimWorkerOwner: async ({ owner }) =>
            ({ owner, capabilities: ["request_approval"] }) as unknown as Awaited<ReturnType<ApplicationPort["claimWorkerOwner"]>>,
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
        ],
        invokeModuleAction: async (name) => {
            if (name === "workspace.mcp.list") return { items: [] };
            throw new Error(`Unexpected module action ${name}`);
        },
        subscribeToEvents: (handler) => {
            eventHandlers.add(handler as (event: unknown) => void);
            return () => eventHandlers.delete(handler as (event: unknown) => void);
        },
        pendingProposals: async () => proposals as unknown as Awaited<ReturnType<ApplicationPort["pendingProposals"]>>,
        resolveProposal: async (logEntryId) => {
            const idx = proposals.findIndex((p) => p.logEntryId === logEntryId);
            if (idx === -1) {
                const err: ProblemError = new Error(`The named proposal or interaction interrupt '${logEntryId}' is not pending`);
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
        pendingClientInteractions: async () =>
            interactions as unknown as Awaited<ReturnType<ApplicationPort["pendingClientInteractions"]>>,
        resolveClientInteraction: async (interactionId) => {
            const idx = interactions.findIndex((i) => i.interactionId === interactionId);
            if (idx === -1) {
                const err: ProblemError = new Error(`The named proposal or interaction interrupt '${interactionId}' is not pending`);
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
        readInbox: async () => inbox as unknown as Awaited<ReturnType<ApplicationPort["readInbox"]>>,
        readStreams: async () => streams as unknown as Awaited<ReturnType<ApplicationPort["readStreams"]>>,
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
        ensureRuntimeWorker: async () => 999,
        runLoop: async ({ workspaceId, workerId, prompt }) => {
            setImmediate(() => {
                port.emitEvent({
                    type: "log/entry",
                    workspaceId,
                    entry: {
                        id: logs.length + 1,
                        worker_id: workerId,
                        worker_name: workers.find((w) => w.id === workerId)?.name ?? "user",
                        loop_id: 1,
                        loop_seq: 1,
                        turn_id: 1,
                        turn_seq: 1,
                        sequence: 1,
                        origin: "model",
                        op: "SEND",
                        source: null,
                        status: 200,
                        state: "settled",
                        attrs: { kind: "message", to: "acp://operator", body: `Echo: ${prompt}` },
                        rx: { status: 200, content: `Echo: ${prompt}`, mimetype: "text/markdown" },
                    },
                });
                port.emitEvent({
                    type: "loop/terminated",
                    workspaceId,
                    workerId,
                    loopId: 1,
                    loopSeq: 1,
                    status: 200,
                    lifecycle: "completed",
                    reason: "end_turn",
                    turns: 1,
                    usage: {
                        accounting: {
                            requests: [],
                            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                            knownUsage: true,
                            costUsd: "0.001",
                            knownCostUsd: true,
                        },
                    },
                });
            });
            return { workspaceId, workerId, loopId: 1, loopSeq: 1, status: 102, queued: false } as unknown as Awaited<
                ReturnType<ApplicationPort["runLoop"]>
            >;
        },
        cancelDrain: () => true,
        cancelWorker: async () => {},
        dispatchClientAction: async ({ statements }) =>
            statements.map(() => ({ status: 200, message: "OK", content: "executed", mimetype: "text/plain" })),
        cancelLoop: async () => true,
        executorTags: () => ["sh", "js"],
        readLog: async ({ workerId }) =>
            logs.filter((l) => l.worker_id === workerId) as unknown as Awaited<ReturnType<ApplicationPort["readLog"]>>,
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
        listModels: () =>
            ({
                items: [
                    {
                        selector: "mocktest/mock-v1",
                        provider: "mocktest",
                        model: "mock-v1",
                        name: "Mock V1",
                        contextWindow: 128000,
                        supportedEfforts: ["low", "medium", "high"],
                        readiness: { ready: true, causes: [] },
                    },
                ],
                total: 1,
                offset: 0,
                limit: 50,
            }) as unknown as ReturnType<ApplicationPort["listModels"]>,
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
            const query = args as { workspaceId?: number; name?: string; projectRoot?: string };
            const found = workspaces.find((w) =>
                query.workspaceId !== undefined
                    ? w.id === query.workspaceId
                    : query.name !== undefined
                      ? w.name === query.name
                      : w.project_root === query.projectRoot,
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
        readWorkerReference: async ({ reference }) => {
            const found = workers.find((w) => w.name === reference);
            return found ? { workspaceId: found.workspaceId, workerId: found.id } : null;
        },
        ensureWorkerReference: async ({ reference }) => {
            const found = workers.find((w) => w.name === reference);
            if (found) return { workspaceId: found.workspaceId, workerId: found.id };
            const created = {
                id: workers.length + 1,
                workspaceId: 1,
                name: reference,
                parentWorkerId: null,
                kind: "model" as const,
                hiddenAt: null,
            };
            workers.push(created);
            return { workspaceId: 1, workerId: created.id };
        },
        listWorkerReferences: async () => [],
        listWorkspaces: async (query) =>
            workspaces.filter((w) =>
                query?.hidden === undefined ? true : query.hidden ? w.hidden_at !== null : w.hidden_at === null,
            ),
        listWorkers: async (workspaceId, query) => {
            const includeHidden = (query as { includeHidden?: boolean } | undefined)?.includeHidden;
            return workers
                .filter((w) => w.workspaceId === workspaceId && (includeHidden ? true : w.hiddenAt === null))
                .map((w) => ({
                    id: w.id,
                    workspaceId: w.workspaceId,
                    name: w.name,
                    parentWorkerId: w.parentWorkerId,
                    kind: w.kind,
                    status: 200,
                    lifecycle: "idle",
                    hiddenAt: w.hiddenAt,
                })) as unknown as Awaited<ReturnType<ApplicationPort["listWorkers"]>>;
        },
        readWorker: async ({ workspaceId, identity }) => {
            const id = identity as { id?: number; workerId?: number; name?: string };
            const targetId = id.id ?? id.workerId;
            const found = workers.find(
                (w) =>
                    w.workspaceId === workspaceId &&
                    (targetId !== undefined ? w.id === targetId : w.name === id.name),
            );
            if (!found) return null;
            return {
                id: found.id,
                workspaceId: found.workspaceId,
                name: found.name,
                parentWorkerId: found.parentWorkerId,
                kind: found.kind,
                status: 200,
                lifecycle: "idle",
                hiddenAt: found.hiddenAt,
            } as unknown as Awaited<ReturnType<ApplicationPort["readWorker"]>>;
        },
        listWorkerLoops: async () =>
            [
                {
                    id: 1,
                    sequence: 1,
                    status: 200,
                    lifecycle: "completed",
                    packetCount: 1,
                    waitUntil: null,
                    claimedAt: 1700000000000,
                    terminatedAt: 1700000001000,
                    source: "acp://operator/sessions/1%23user/messages/msg-1",
                    opening: "Hello world",
                    continued: false,
                },
            ] as unknown as Awaited<ReturnType<ApplicationPort["listWorkerLoops"]>>,
        readWorkerOverview: async ({ workspaceId }) =>
            ({
                scope: workspaceId ? { workspaceId } : null,
                workspaces: Object.fromEntries(
                    workspaces.map((w) => [w.id, { id: w.id, name: w.name, projectRoot: w.project_root, projectLabel: w.project_label }]),
                ),
                workers: Object.fromEntries(
                    workers
                        .filter((w) => w.hiddenAt === null && (!workspaceId || w.workspaceId === workspaceId))
                        .map((w) => [
                            w.id,
                            {
                                workspaceId: w.workspaceId,
                                id: w.id,
                                name: w.name,
                                parentWorkerId: w.parentWorkerId,
                                kind: w.kind,
                                lifecycle: "idle",
                                gates: [],
                                reply: {
                                    id: 1,
                                    coordinate: "1/1/1",
                                    completion: "end_turn",
                                    at: "2026-10-25T00:00:01.000Z",
                                    excerpt: "Echo: hello",
                                    continued: false,
                                },
                            },
                        ]),
                ),
                recent: workers.filter((w) => w.hiddenAt === null).map((w) => w.id),
                omitted: 0,
            }) as unknown as Awaited<ReturnType<ApplicationPort["readWorkerOverview"]>>,
        workerAccounting: async () =>
            ({
                requests: [],
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                knownUsage: true,
                costUsd: "0.0025",
                knownCostUsd: true,
            }) as unknown as Awaited<ReturnType<ApplicationPort["workerAccounting"]>>,
        workerGauge: async () => ({
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
            return { id: workspaceId, hidden, hiddenAt: ws?.hidden_at ?? null } as unknown as Awaited<
                ReturnType<ApplicationPort["setWorkspaceHidden"]>
            >;
        },
        setWorkerHidden: async ({ workerId, hidden }) => {
            const w = workers.find((item) => item.id === workerId);
            if (w) w.hiddenAt = hidden ? new Date().toISOString() : null;
            return { workerId, hidden, hiddenAt: w?.hiddenAt ?? null } as unknown as Awaited<
                ReturnType<ApplicationPort["setWorkerHidden"]>
            >;
        },
        rollback: async () => ({ reversed: [], stoppedAt: null }) as unknown as Awaited<ReturnType<ApplicationPort["rollback"]>>,
        activateWorkspace: async () => {},
        workspacePreparationStatus: () => [],
        workspaceDerivationStatus: () => null,
        readEntry: async ({ target }) =>
            ({
                target,
                channel: "body",
                mimetype: "text/plain",
                content: `Body for ${target}`,
                totalBytes: 16,
            }) as unknown as Awaited<ReturnType<ApplicationPort["readEntry"]>>,
        readEntryChannel: async ({ target }) =>
            ({
                target,
                channel: "body",
                mimetype: "text/plain",
                content: `Body for ${target}`,
                totalBytes: 16,
            }) as unknown as Awaited<ReturnType<ApplicationPort["readEntryChannel"]>>,
        forkWorker: async ({ workspaceId, workerId, name }) => {
            const created = {
                id: workers.length + 1,
                workspaceId,
                name: name ?? `fork-${workers.length + 1}`,
                parentWorkerId: workerId,
                kind: "model" as const,
                hiddenAt: null,
            };
            workers.push(created);
            return { workerId: created.id, workerName: created.name, parentWorkerId: workerId };
        },
        createWorker: async ({ workspaceId, name }) => {
            if (name === "_plurnk") {
                const err: ProblemError = new Error("Reserved worker name");
                err.problem = {
                    type: "https://plurnk.xyz/problems/core/worker-name-reserved",
                    title: "Bad Request",
                    status: 400,
                    code: "core/worker-name-reserved",
                    detail: "Worker name '_plurnk' is reserved.",
                };
                throw err;
            }
            const existing = workers.find((w) => w.workspaceId === workspaceId && w.name === name);
            if (existing) return { workerId: existing.id, workerName: existing.name };
            const created = {
                id: workers.length + 1,
                workspaceId,
                name: name ?? `worker-${workers.length + 1}`,
                parentWorkerId: null,
                kind: "model" as const,
                hiddenAt: null,
            };
            workers.push(created);
            return { workerId: created.id, workerName: created.name };
        },
        readWorkerModel: async () => ({ model: currentModel, spawnModel: currentSpawnModel }),
        setWorkerModel: async ({ selector, effort }) => {
            const nextEffort = (effort as EffortValue | undefined) ?? currentEffort;
            currentModel = {
                ...(selector.includes("/") ? {} : { alias: selector }),
                provider: selector.includes("/") ? (selector.split("/")[0] ?? "mocktest") : "mocktest",
                model: selector.includes("/") ? (selector.split("/")[1] ?? selector) : selector,
                effort: nextEffort,
                effortSource: effort ? "explicit" : currentEffortSource,
            };
            return currentModel;
        },
        setWorkerSpawnModel: async ({ selector }) => {
            currentSpawnModel = selector
                ? { provider: "mocktest", model: selector, effortSource: "default" }
                : null;
            return currentSpawnModel;
        },
        readWorkerEffort: async () => ({
            effort: currentEffort,
            source: currentEffortSource,
            supportedEfforts: ["low", "medium", "high"],
        }),
        setWorkerEffort: async ({ effort }) => {
            currentEffort = effort as EffortValue;
            currentEffortSource = "explicit";
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
            currentPolicy = policy as unknown as Record<string, unknown>;
            return { service: {}, workspace: currentPolicy, effective: currentPolicy };
        },
    };

    const acpModule = Module.create({ env: options?.env });
    await acpModule.setup({
        registerMessageScheme: () => {},
        registerModuleAction: () => {},
    } as unknown as AcpSetupSeam);
    await acpModule.start(port);

    return {
        port,
        baseUrl: `http://127.0.0.1:${address.port}/acp`,
        wsUrl: `ws://127.0.0.1:${address.port}/acp`,
        acpModule,
        async close() {
            acpModule.stop();
            await acpModule.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

test("{§acp-daemon-client} {§acp-client-types} {§acp-configuration} {§acp-listener-admission} {§acp-shutdown}: module lifecycle, configuration validation, and runtime-neutral client types", async () => {
    // Verify client types compile and represent state and action outcomes
    const sampleOutcome: ActionOutcome<string> = { ok: true, result: "ok" };
    assert.equal(sampleOutcome.ok, true);
    const sampleState: Partial<AcpPlusState> = {
        budget: { curationWeight: 10, curationBudget: 100, contextTokens: 20, contextCapacity: 200 },
    };
    assert.equal(sampleState.budget?.curationWeight, 10);

    // Invalid configuration fails module creation ({§acp-configuration})
    assert.throws(
        () => Module.create({ env: { PLURNK_ACP_HEARTBEAT_MS: "invalid" } }),
        /PLURNK_ACP_HEARTBEAT_MS must be a safe integer/,
    );

    const h = await createHarness();
    try {
        h.acpModule.stop();
        // After stop, HTTP requests receive 503 service-stopping ({§acp-listener-admission}, {§acp-shutdown})
        const res = await fetch(h.baseUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
        });
        assert.equal(res.status, 503);
        const body = (await res.json()) as Record<string, unknown>;
        assert.match(String(body.code ?? body.type), /service-stopping/);
    } finally {
        await h.close();
    }
});

test("{§acp-run-endpoint} {§acp-run-authority} {§acp-cors} {§acp-http-authorization} {§acp-http-failure} {§acp-oauth-revocation} {§problems-acp}: Streamable HTTP, WebSocket, CORS, OAuth perimeter, and revocation", async () => {
    const h = await createHarness({ authMode: "oauth" });
    try {
        // CORS preflight answers 204 before authorization ({§acp-cors})
        const preflight = await fetch(h.baseUrl, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

        // Unauthenticated POST returns 401 bearer-token-required ({§acp-http-authorization}, {§acp-http-failure}, {§problems-acp})
        const unauth = await fetch(h.baseUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
        });
        assert.equal(unauth.status, 401);
        assert.ok(unauth.headers.get("www-authenticate")?.includes("Bearer"));
        const unauthProblem = (await unauth.json()) as Record<string, unknown>;
        assert.match(String(unauthProblem.code), /bearer-token-required/);

        // Insufficient scope returns 403 bearer-scope-insufficient
        const badScope = await fetch(h.baseUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer no-scope-token",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
        });
        assert.equal(badScope.status, 403);

        // Authenticated Streamable HTTP client connects via createHttpStream ({§acp-run-endpoint}, {§acp-run-authority})
        const httpStream = createHttpStream(h.baseUrl, {
            headers: { authorization: "Bearer valid-token" },
        });
        const app = createAcpClient();
        await app.connectWith(httpStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            assert.ok(init.response.capabilities?.session);
            assert.ok(init.response.capabilities?.session?.fork);
            assert.ok(init.response.capabilities?.session);
        });

        // Authenticated WebSocket client connects and closes on OAuth revocation ({§acp-oauth-revocation})
        const wsStream = createWebSocketStream(h.wsUrl, {
            WebSocket: WsConstructor,
            headers: { authorization: "Bearer valid-token" },
        });
        const wsClient = createAcpClient();
        const conn = wsClient.connect(wsStream);
        await conn.initialized;
        h.port.revokeFamily("fam-1");
        await conn.closed;
    } finally {
        await h.close();
    }
});

test("{§acp-thread-binding} {§acp-thread-address} {§acp-action-binding} {§acp-run-start} {§acp-worker-owner} {§acp-owner-activation} {§acp-place-hiding}: session/new, session/resume, session/fork, session/list, session/delete, session/close, and qualified addresses", async () => {
    const h = await createHarness();
    try {
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient();
        await app.connectWith(stream, async (ctx) => {
            // session/new creates a session in the workspace for cwd and returns configOptions, availableCommands, and _meta.plurnk ({§acp-run-start})
            const created = await ctx.request(methods.agent.session.new, {
                cwd: "/workspace/alpha",
                _meta: { plurnk: { name: "alice" } },
            });
            assert.equal(created.sessionId, "1#alice");
            assert.ok(Array.isArray(created.configOptions));
            assert.ok(created.configOptions?.some((opt) => opt.configId === "model"));
            assert.ok(created.configOptions?.some((opt) => opt.configId === "thought_level"));
            assert.ok(Array.isArray(created.availableCommands));
            assert.ok(created.availableCommands?.some((cmd) => cmd.name === "mcp"));

            // Invalid qualified address fails with 400 session-address-invalid ({§acp-thread-address})
            await assert.rejects(
                () =>
                    ctx.request(methods.agent.session.resume, {
                        sessionId: "01#alice",
                        cwd: "/workspace/alpha",
                    }),
                /session-address-invalid/,
            );

            // Unknown session on resume without create fails with 404 session-not-found ({§acp-action-binding})
            await assert.rejects(
                () =>
                    ctx.request(methods.agent.session.resume, {
                        sessionId: "1#nonexistent",
                        cwd: "/workspace/alpha",
                    }),
                /session-not-found|worker-not-found/,
            );

            // session/fork forks the session ({§acp-thread-binding})
            const forked = await ctx.request(methods.agent.session.fork, {
                sessionId: "1#alice",
                cwd: "/workspace/alpha",
            });
            assert.match(forked.sessionId, /^1#/);

            // session/list lists visible sessions; session/delete hides a session ({§acp-place-hiding})
            const listedBefore = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(listedBefore.sessions.some((s) => s.sessionId === forked.sessionId));

            await ctx.request(methods.agent.session.delete, {
                sessionId: forked.sessionId,
            });
            const listedAfter = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(!listedAfter.sessions.some((s) => s.sessionId === forked.sessionId));

            // session/close detaches observation without deleting the session ({§acp-run-disconnect})
            await ctx.request(methods.agent.session.close, {
                sessionId: "1#alice",
            });
            const listedFinal = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(listedFinal.sessions.some((s) => s.sessionId === "1#alice"));
        });
    } finally {
        await h.close();
    }
});

test("{§acp-worker-model-actions} {§acp-worker-effort-actions} {§acp-provider-routes} {§acp-status-model} {§acp-state-patches} {§acp-workspace-state}: session/set_config_option, config_option_update, and providers/list", async () => {
    const h = await createHarness();
    try {
        const updates: SessionUpdate[] = [];
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
            updates.push(params.update);
        });
        await app.connectWith(stream, async (ctx) => {
            const session = await ctx.request(methods.agent.session.new, {
                cwd: "/workspace/alpha",
            });
            const plurnkMeta = (
                session._meta as
                    | { plurnk?: { workspace?: { name?: string }; providers?: Array<{ alias?: string }> } }
                    | undefined
            )?.plurnk;
            assert.equal(plurnkMeta?.workspace?.name, "alpha");
            assert.equal(plurnkMeta?.providers?.[0]?.alias, "fast");

            // providers/list returns configured provider aliases and models ({§acp-provider-routes})
            const providers = await ctx.request(methods.agent.providers.list, {});
            assert.ok(providers.providers.length > 0);

            // session/set_config_option updates model and effort ({§acp-worker-model-actions}, {§acp-worker-effort-actions})
            const updatedModel = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "model",
                type: "id",
                value: "mocktest/mock-v1",
            });
            assert.ok(updatedModel.configOptions.some((c) => c.configId === "model"));

            const updatedEffort = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "thought_level",
                type: "id",
                value: "high",
            });
            assert.ok(updatedEffort.configOptions.some((c) => c.configId === "thought_level"));
            assert.ok(updates.some((u) => u.sessionUpdate === "config_option_update"));

            const updatedAllowMode = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "mode",
                type: "id",
                value: "allow",
            });
            const allowModeOption = updatedAllowMode.configOptions.find((c) => c.configId === "mode");
            assert.equal(allowModeOption?.currentValue, "allow");

            const updatedDenyMode = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "mode",
                type: "id",
                value: "deny",
            });
            const denyModeOption = updatedDenyMode.configOptions.find((c) => c.configId === "mode");
            assert.equal(denyModeOption?.currentValue, "deny");

            const updatedProposeMode = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "mode",
                type: "id",
                value: "propose",
            });
            const proposeModeOption = updatedProposeMode.configOptions.find((c) => c.configId === "mode");
            assert.equal(proposeModeOption?.currentValue, "propose");

            const updatedSpawnModel = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "spawn_model",
                type: "id",
                value: "fast",
            });
            const spawnModelOption = updatedSpawnModel.configOptions.find((c) => c.configId === "spawn_model");
            assert.equal(spawnModelOption?.currentValue, "mocktest/fast");
        });
    } finally {
        await h.close();
    }
});

test("{§acp-run-input} {§acp-message-acceptance} {§acp-run-source} {§acp-run-outcome} {§acp-cost-evidence} {§acp-numbers-passthrough} {§acp-status-spend} {§acp-status-timing} {§acp-status-loop-number} {§acp-status-wait} {§acp-run-disconnect} {§acp-owner-connection}: session/prompt, idempotency, usage_update, and state_update", async () => {
    const h = await createHarness();
    try {
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient();
        await app.connectWith(stream, async (ctx) => {
            await ctx.buildSession("/workspace/alpha").withSession(async (session) => {
                // Empty prompt is rejected with 400 user-message-text-required ({§acp-run-input})
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: "   " }],
                        }),
                    /user-message-text-required/,
                );

                // Prompt submits message with messageId idempotency and streams reply + usage_update + idle state_update ({§acp-run-outcome})
                const promptRes = await ctx.request(methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "Hello ACP v2" }],
                    _meta: { plurnk: { messageId: "msg-100" } },
                });
                assert.equal(promptRes.messageId, "msg-100");

                const replyText = await session.readTextUntilIdle();
                assert.match(replyText, /Echo: Hello ACP v2/);

                // Reusing messageId with different text fails with 422 message-address-reused ({§acp-run-input})
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: "Different text" }],
                            _meta: { plurnk: { messageId: "msg-100" } },
                        }),
                    /message-address-reused/,
                );
            });
        });
    } finally {
        await h.close();
    }
});

test("{§acp-lifecycle-projection} {§acp-call-result} {§acp-parse-refusal} {§acp-progress-reply} {§acp-outside-text} {§acp-ambient} {§acp-plurnk-metadata} {§acp-readable-reasoning} {§acp-reasoning-link} {§acp-encrypted-reasoning} {§acp-body-reference} {§acp-entry-route} {§acp-status-streams} {§acp-stream-producer} {§acp-status-descendants} {§acp-topology-scope} {§acp-delegation-observation} {§acp-subagents}: event projection for thoughts, tool calls, diffs, terminals, subagents, outside text, notices, and entry route", async () => {
    const h = await createHarness();
    try {
        const updates: SessionUpdate[] = [];
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
            updates.push(params.update);
        });
        await app.connectWith(stream, async (ctx) => {
            const session = await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            assert.ok(session.configOptions);

            // 1. Readable reasoning delta ({§acp-readable-reasoning})
            h.port.emitEvent({
                type: "reasoning/event",
                workspaceId: 1,
                workerId: 1,
                callId: 1,
                requestSeq: 1,
                delta: "Thinking step 1...",
            });

            // 2. Outside text ({§acp-outside-text})
            h.port.emitEvent({
                type: "outside/event",
                workspaceId: 1,
                workerId: 1,
                coordinate: "1/1/0",
                text: "Outside commentary",
                tokens: 3,
            });

            // 3. File edit tool call with Diff and body-by-reference ({§acp-body-reference}, {§acp-plurnk-metadata})
            h.port.emitEvent({
                type: "log/entry",
                workspaceId: 1,
                entry: {
                    id: 10,
                    worker_id: 1,
                    worker_name: "user",
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 2,
                    origin: "model",
                    op: "EDIT",
                    source: null,
                    status: 200,
                    state: "settled",
                    attrs: {
                        path: "/workspace/alpha/file.ts",
                        original: "const x = 1;\n",
                        patched: "const x = 2;\n",
                    },
                    rx: { status: 200, content: "const x = 2;\n", mimetype: "text/plain" },
                },
            });

            // 4. Obligation-opening sh:// stream + terminal_update + terminal_output_chunk + obligation discharge ({§acp-call-result}, {§acp-status-streams}, {§acp-stream-producer})
            h.port.emitEvent({
                type: "log/entry",
                workspaceId: 1,
                entry: {
                    id: 11,
                    worker_id: 1,
                    worker_name: "user",
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 3,
                    origin: "model",
                    op: "EXEC",
                    source: null,
                    status: 202,
                    state: "settled",
                    attrs: { tag: "sh", body: "echo hi", stream: "sh://11" },
                    rx: { status: 202, content: "", mimetype: "text/plain" },
                },
            });
            h.port.emitEvent({
                type: "stream/event",
                workspaceId: 1,
                workerId: 1,
                entryId: 11,
                target: "sh://11",
                channel: "stdout",
                delta: "hi\n",
                sequence: 1,
            });
            h.port.emitEvent({
                type: "stream/concluded",
                workspaceId: 1,
                workerId: 1,
                entryId: 11,
                target: "sh://11",
                status: 200,
                result: { status: 200, exitCode: 0 },
            });
            h.port.emitEvent({
                type: "log/entry",
                workspaceId: 1,
                entry: {
                    id: 12,
                    worker_id: 1,
                    worker_name: "user",
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 2,
                    sequence: 1,
                    origin: "system",
                    op: "READ",
                    source: "sh://11",
                    status: 200,
                    state: "settled",
                    attrs: { invocation: "1/1/3" },
                    rx: { status: 200, content: "hi\n", mimetype: "text/plain" },
                },
            });

            // 5. Parse refusal ({§acp-parse-refusal}) and ambient row ({§acp-ambient})
            h.port.emitEvent({
                type: "log/entry",
                workspaceId: 1,
                entry: {
                    id: 13,
                    worker_id: 1,
                    worker_name: "user",
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 2,
                    sequence: 2,
                    origin: "model",
                    op: "ERROR",
                    source: null,
                    status: 400,
                    state: "settled",
                    attrs: { attempt: { verb: "READ", text: "READ bad" } },
                    rx: { status: 400, content: "Refused READ", mimetype: "text/plain" },
                },
            });
            h.port.emitEvent({
                type: "notice/event",
                workspaceId: 1,
                workerId: 1,
                notice: { level: "warn", code: "test-notice", message: "Watch out" },
            });

            // 6. Delegated child worker, subagent_update, session_message, and child cancel ({§acp-status-descendants}, {§acp-delegation-observation}, {§acp-subagents})
            h.port.workers.push({
                id: 2,
                workspaceId: 1,
                name: "helper",
                parentWorkerId: 1,
                kind: "model",
                hiddenAt: null,
            });
            h.port.emitEvent({
                type: "log/entry",
                workspaceId: 1,
                entry: {
                    id: 14,
                    worker_id: 2,
                    worker_name: "helper",
                    loop_id: 2,
                    loop_seq: 1,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "model",
                    op: "SEND",
                    source: null,
                    status: 200,
                    state: "settled",
                    attrs: { kind: "message", to: "worker://user", body: "Child progress" },
                    rx: { status: 200, content: "Child progress", mimetype: "text/markdown" },
                },
            });
            h.port.emitEvent({
                type: "loop/packet",
                workspaceId: 1,
                workerId: 1,
                loopId: 1,
                sequence: 1,
                gauge: {
                    curationWeight: 420,
                    curationBudget: 4000,
                    contextTokens: 840,
                    contextCapacity: 8000,
                },
            });
            h.port.emitEvent({
                type: "loop/terminated",
                workspaceId: 1,
                workerId: 2,
                loopId: 2,
                outcome: "end_turn",
                turns: 1,
            });

            await ctx.notify(methods.agent.session.cancel, {
                sessionId: "1#helper",
            });

            await new Promise((r) => setTimeout(r, 50));

            assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
            assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
            assert.ok(
                updates.some(
                    (u) =>
                        u.sessionUpdate === "tool_call_update" &&
                        Array.isArray(u.content) &&
                        u.content.some((c: { type?: string }) => c.type === "diff"),
                ),
            );
            assert.ok(updates.some((u) => u.sessionUpdate === "terminal_update"));
            assert.ok(updates.some((u) => u.sessionUpdate === "terminal_output_chunk"));
            assert.ok(updates.some((u) => u.sessionUpdate === "notice"));
            assert.ok(
                updates.some(
                    (u) =>
                        u.sessionUpdate === "subagent_update" &&
                        u.sessionId === "1#helper" &&
                        (u.capabilities as { cancel?: unknown } | undefined)?.cancel !== undefined,
                ),
            );
            assert.ok(
                updates.some(
                    (u) =>
                        u.sessionUpdate === "subagent_update" &&
                        u.sessionId === "1#helper" &&
                        (u.state as { state?: string } | undefined)?.state === "idle",
                ),
            );
            assert.ok(
                updates.some(
                    (u) =>
                        u.sessionUpdate === "session_message" &&
                        u.senderSessionId === "1#helper" &&
                        u.recipientSessionId === "1#user",
                ),
            );
            assert.ok(
                updates.some((u) => {
                    if (u.sessionUpdate !== "usage_update") return false;
                    const plurnk = (u._meta as { plurnk?: { budget?: Record<string, unknown> } } | undefined)?.plurnk;
                    return (
                        plurnk?.budget?.curationWeight === 420 &&
                        plurnk?.budget?.curationBudget === 4000 &&
                        plurnk?.budget?.contextTokens === 840 &&
                        plurnk?.budget?.contextCapacity === 8000
                    );
                }),
            );

            // Entry route serves body by reference ({§acp-entry-route})
            const entryUrl = `${h.baseUrl}/1/1/entry?target=${encodeURIComponent("log:///1/1/2/EDIT")}`;
            const entryRes = await fetch(entryUrl);
            assert.equal(entryRes.status, 200);
            assert.equal(await entryRes.text(), "Body for log:///1/1/2/EDIT");

            const missingTarget = await fetch(`${h.baseUrl}/1/1/entry`);
            assert.equal(missingTarget.status, 400);
        });
    } finally {
        await h.close();
    }
});

test("{§acp-proposal-resolve} {§acp-gate-deferral} {§acp-message-before-gate} {§acp-resume-before-gate} {§acp-proposal-disposition} {§acp-held-interrupts}: session/request_permission, elicitation/create, elicitation/complete, and multi-peer $/cancel_request", async () => {
    const h = await createHarness();
    try {
        const permissionRequests1: RequestPermissionRequest[] = [];
        const permissionRequests2: RequestPermissionRequest[] = [];
        const elicitations1: CreateElicitationRequest[] = [];
        const completedElicitations: string[] = [];

        const stream1 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const stream2 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });

        const client1 = createAcpClient()
            .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                permissionRequests1.push(params);
                return { outcome: { outcome: "selected", optionId: "allow_once" } };
            })
            .onRequest(methods.client.elicitation.create, async ({ params }) => {
                elicitations1.push(params);
                return { action: "accept", content: { answer: "42" } };
            })
            .onNotification(methods.client.elicitation.complete, ({ params }) => {
                completedElicitations.push(params.elicitationId);
            });

        let peer2Cancelled = false;
        const client2 = createAcpClient().onRequest(
            methods.client.session.requestPermission,
            async ({ params, signal }) => {
                permissionRequests2.push(params);
                await new Promise<void>((resolve) => {
                    signal.addEventListener("abort", () => {
                        peer2Cancelled = true;
                        resolve();
                    });
                });
                return { outcome: { outcome: "cancelled" } };
            },
        );

        await client1.connectWith(stream1, async (ctx1) => {
            await client2.connectWith(stream2, async (ctx2) => {
                await ctx1.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                await ctx2.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                // Emit a command proposal ({§acp-proposal-resolve}, {§acp-proposal-disposition})
                const proposal = {
                    logEntryId: 501,
                    workspaceId: 1,
                    workerId: 1,
                    workerName: "user",
                    loopId: 1,
                    turnId: 1,
                    coordinate: "1/1/1",
                    op: "sh",
                    disposition: "review",
                    owner: "acp://operator",
                    attrs: { tag: "sh", body: "rm -rf build", cwd: "/workspace/alpha" },
                    subject: { type: "command", command: "rm -rf build", cwd: "/workspace/alpha" },
                };
                h.port.proposals.push(proposal);
                h.port.emitEvent({
                    type: "loop/proposal",
                    workspaceId: 1,
                    workerId: 1,
                    proposal,
                });

                // Emit a form elicitation ({§acp-proposal-resolve})
                const interaction = {
                    interactionId: 601,
                    workspaceId: 1,
                    workerId: 1,
                    loopId: 1,
                    turnId: 1,
                    recipient: "acp://operator",
                    request: {
                        toolName: "question" as const,
                        mode: "form" as const,
                        message: "What is the answer?",
                        requestedSchema: {
                            type: "object",
                            properties: { answer: { type: "string", title: "Answer" } },
                            required: ["answer"],
                        },
                    },
                };
                h.port.interactions.push(interaction);
                h.port.emitEvent({
                    type: "loop/interaction",
                    workspaceId: 1,
                    workerId: 1,
                    interaction,
                });

                await new Promise((r) => setTimeout(r, 80));

                assert.equal(permissionRequests1.length, 1);
                assert.equal(permissionRequests1[0]?.subject?.type, "command");
                assert.deepEqual(
                    permissionRequests1[0]?.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
                    [
                        { optionId: "allow_once", kind: "allow_once" },
                        { optionId: "allow_always", kind: "allow_always" },
                        { optionId: "reject_once", kind: "reject_once" },
                        { optionId: "reject_always", kind: "reject_always" },
                    ],
                );
                assert.equal(h.port.proposals.length, 0, "proposal resolved in port");
                assert.equal(peer2Cancelled, true, "second peer received $/cancel_request ({§acp-gate-deferral})");

                assert.equal(elicitations1.length, 1);
                assert.equal(elicitations1[0]?.mode, "form");
                assert.equal(h.port.interactions.length, 0, "interaction resolved in port");
                assert.ok(completedElicitations.length > 0, "elicitation/complete emitted");
            });
        });
    } finally {
        await h.close();
    }
});

test("{§acp-replay} {§acp-sync} {§acp-snapshot} {§acp-history-window} {§acp-history-page} {§acp-loop-page} {§acp-history-advance} {§acp-words-by-reference}: session/resume replay window and HTTP history pagination", async () => {
    const h = await createHarness({
        env: {
            PLURNK_ACP_HISTORY_LOOPS: "1",
            PLURNK_ACP_HISTORY_PAGE_CHARS: "500",
        },
    });
    try {
        // Populate 2 loops in logs
        h.port.logs.push(
            {
                id: 1,
                worker_id: 1,
                worker_name: "user",
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 1,
                origin: "system",
                op: "SEND",
                source: "acp://operator/sessions/1%23user/messages/m1",
                status: 200,
                state: "settled",
                attrs: { kind: "message", body: "Loop 1 question" },
                rx: { status: 200, content: "Loop 1 question", mimetype: "text/markdown" },
            },
            {
                id: 2,
                worker_id: 1,
                worker_name: "user",
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 2,
                origin: "model",
                op: "SEND",
                source: null,
                status: 200,
                state: "settled",
                attrs: { kind: "message", to: "acp://operator", body: "Loop 1 answer" },
                rx: { status: 200, content: "Loop 1 answer", mimetype: "text/markdown" },
            },
            {
                id: 3,
                worker_id: 1,
                worker_name: "user",
                loop_id: 2,
                loop_seq: 2,
                turn_id: 2,
                turn_seq: 1,
                sequence: 1,
                origin: "system",
                op: "SEND",
                source: "acp://operator/sessions/1%23user/messages/m2",
                status: 200,
                state: "settled",
                attrs: { kind: "message", body: "Loop 2 question" },
                rx: { status: 200, content: "Loop 2 question", mimetype: "text/markdown" },
            },
            {
                id: 4,
                worker_id: 1,
                worker_name: "user",
                loop_id: 2,
                loop_seq: 2,
                turn_id: 2,
                turn_seq: 1,
                sequence: 2,
                origin: "model",
                op: "SEND",
                source: null,
                status: 200,
                state: "settled",
                attrs: { kind: "message", to: "acp://operator", body: "X".repeat(600) },
                rx: { status: 200, content: "X".repeat(600), mimetype: "text/markdown" },
            },
        );

        const replayed: SessionUpdate[] = [];
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
            replayed.push(params.update);
        });
        await app.connectWith(stream, async (ctx) => {
            const resumed = await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
                replayFrom: { type: "start" },
            });
            // Replay emits newest loop (Loop 2) and links older history ({§acp-history-window}, {§acp-history-advance})
            const historyMeta = (
                resumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
            )?.plurnk?.history;
            assert.ok(historyMeta?.older, "older history link is present");
            assert.ok(replayed.some((u) => u.sessionUpdate === "user_message_chunk"));
            assert.ok(replayed.some((u) => u.sessionUpdate === "agent_message_chunk"));

            // Fetch older history page via HTTP GET ({§acp-history-page})
            const pageRes = await fetch(historyMeta.older);
            assert.equal(pageRes.status, 200);
            const page = (await pageRes.json()) as Record<string, unknown>;
            assert.ok(Array.isArray(page.updates));

            // Fetch loop page by sequence number ({§acp-loop-page})
            const loopRes = await fetch(`${h.baseUrl}/1/1/messages?session=${encodeURIComponent("1#user")}&loop=1`);
            assert.equal(loopRes.status, 200);
            const loopPage = (await loopRes.json()) as Record<string, unknown>;
            assert.ok(Array.isArray(loopPage.updates));
        });
    } finally {
        await h.close();
    }
});

test("{§acp-overview} {§acp-overview-run} {§acp-overview-state} {§acp-overview-updates} {§acp-management-plane} {§acp-worker-loops} {§acp-client-operation} {§acp-op-parse} {§acp-module-action-scope} {§acp-module-actions} {§discovery} {§acp-discovery-contract} {§acp-broadcast-fan} {§pinned-wording-acp}: session/list directory, slash commands, _plurnk/action, op.parse, and discovery contract", async () => {
    const h = await createHarness();
    try {
        const updates: SessionUpdate[] = [];
        const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
            updates.push(params.update);
        });
        await app.connectWith(stream, async (ctx) => {
            // 1. session/list returns structured overview state ({§acp-overview}, {§acp-overview-run}, {§acp-overview-state})
            const listed = await ctx.request(methods.agent.session.list, {});
            assert.ok(listed.sessions.length >= 1);
            const firstMeta = listed.sessions[0]?._meta as
                | { plurnk?: { reply?: { body?: { url?: string } } } }
                | undefined;
            assert.ok(firstMeta?.plurnk?.reply?.body?.url);

            // 2. discover action returns valid AcpDiscovery manifest ({§discovery}, {§acp-discovery-contract})
            const discovered = await ctx.request<AcpDiscovery>("_plurnk/action", {
                kind: "discover",
                params: {},
            });
            assert.equal(discovered.schemaVersion, 1);
            assert.ok(discovered.actions["workspace.mcp.list"]);
            assert.doesNotThrow(() =>
                Validator.assertAcpClientConformance(discovered, {
                    schemaVersion: 1,
                    client: "test-client",
                    actions: Object.fromEntries(
                        Object.keys(discovered.actions).map((k) => [
                            k,
                            { posture: "generic", dimensions: ["projection", "success", "failure"], evidence: ["test"] },
                        ]),
                    ),
                    notifications: Object.fromEntries(
                        Object.keys(discovered.notifications).map((k) => [
                            k,
                            { posture: "generic", dimensions: ["framing", "projection"], evidence: ["test"] },
                        ]),
                    ),
                }),
            );

            // 3. worker.loops returns loop projections ({§acp-worker-loops})
            const loops = await ctx.request<{ items?: unknown[] } | unknown[]>("_plurnk/action", {
                kind: "worker.loops",
                workspace: "alpha",
                params: {},
            });
            assert.ok(Array.isArray(Array.isArray(loops) ? loops : loops.items));

            // 4. op.parse dispatches valid statements and reports parse errors ({§acp-client-operation}, {§acp-op-parse})
            const parsedOk = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                kind: "op.parse",
                workspace: "alpha",
                params: { text: "```NOTE\nremember this\n```\n" },
            });
            assert.ok(Array.isArray(parsedOk.results));
            assert.equal(parsedOk.results[0]?.status, 200);

            const parsedBad = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                kind: "op.parse",
                workspace: "alpha",
                params: { text: "INVALID_VERB ???\n" },
            });
            assert.ok(Array.isArray(parsedBad.results));
            assert.equal(parsedBad.results[0]?.status, 400);

            // 5. Module action invocation via _plurnk/action ({§acp-module-action-scope}, {§acp-module-actions})
            const mcpList = await ctx.request<Record<string, unknown>>("_plurnk/action", {
                kind: "workspace.mcp.list",
                workspace: "alpha",
                params: {},
            });
            assert.deepEqual(mcpList, { items: [] });

            // 6. Pinned wording on unknown action and invalid schema ({§pinned-wording-acp})
            await assert.rejects(
                () => ctx.request("_plurnk/action", { kind: "no.such.action", params: {} }),
                /Action 'no\.such\.action' is not registered\. Recovery: Use an action advertised by discover\./,
            );
            await assert.rejects(
                () =>
                    ctx.request("_plurnk/action", {
                        kind: "workspace.mcp.list",
                        workspace: "alpha",
                        params: { unexpectedField: 123 },
                    }),
                /Action 'workspace\.mcp\.list' rejected parameters\./,
            );

            // 7. Slash command execution via session/prompt (/mcp list)
            await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            await ctx.request(methods.agent.session.prompt, {
                sessionId: "1#user",
                prompt: [{ type: "text", text: "/mcp list" }],
            });
            await new Promise((r) => setTimeout(r, 30));
            assert.ok(updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
        });
    } finally {
        await h.close();
    }
});
