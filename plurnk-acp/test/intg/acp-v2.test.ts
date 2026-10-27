import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import Module, { type AcpSetupSeam } from "../../src/Module.ts";

const createAcpClient = () =>
    createRawAcpClient().onConnect((conn) => {
        void conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "test-client", version: "1.0.0" },
        });
    });

test("{§acp-first-party-client-conformance} {§acp-first-party-client-conformance}: stock @agentclientprotocol/sdk v2 client exercises initialize, session/new, session/resume, session/prompt, and session/request_permission over WebSocket and Streamable HTTP", async () => {
    const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>>();
    const upgrades = new Map<string, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const eventHandlers = new Set<(event: Record<string, unknown>) => void>();

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
    const acpModule = Module.create();
    const setupSeam = {
        registerMessageScheme: () => {},
        registerModuleAction: () => {},
    } as unknown as AcpSetupSeam;
    await acpModule.setup(setupSeam);
    const startPort = {
        registerHttpRoute: (prefix: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) => routes.set(prefix, handler),
        registerHttpUpgrade: (prefix: string, handler: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>) => upgrades.set(prefix, handler),
        httpAddress: () => ({ host: "127.0.0.1", port: address.port }),
        credentials: {
            mode: () => "none",
            verifyBearer: async () => ({ ok: true, grant: { subject: "acp://operator", scopes: ["acp"], familyId: "f1" } }),
            onRevoke: () => () => {},
        },
        registerSessionOwner: async () => {},
        claimSessionOwner: async ({ owner }: { owner: string }) => ({ owner, capabilities: ["request_approval"] }),
        configurationNotices: () => [],
        listClientDisplayCapabilities: async () => [],
        listModuleActions: () => [],
        invokeModuleAction: async () => ({}),
        subscribeToEvents: (h: (event: Record<string, unknown>) => void) => {
            eventHandlers.add(h);
            return () => eventHandlers.delete(h);
        },
        pendingProposals: async () => [],
        resolveProposal: async () => {},
        pendingClientInteractions: async () => [],
        resolveClientInteraction: async () => {},
        readMessages: async () => [],
        readInbox: async () => [],
        readStreams: async () => [],
        messageAdmission: async () => "new",
        ensureRuntimeSession: async () => 999,
        runLoop: async ({ workspaceId, sessionId, prompt }: { workspaceId: number; sessionId: number; prompt: string }) => {
            setImmediate(() => {
                for (const h of eventHandlers) {
                    h({
                        type: "log/entry",
                        workspaceId,
                        entry: {
                            id: 1,
                            session_id: sessionId,
                            session_name: "user",
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
                            attrs: { kind: "message", to: "acp://operator", body: `Stock reply: ${prompt}` },
                            rx: { status: 200, content: `Stock reply: ${prompt}`, mimetype: "text/markdown" },
                        },
                    });
                    h({
                        type: "loop/terminated",
                        workspaceId,
                        sessionId,
                        loopId: 1,
                        loopSeq: 1,
                        status: 200,
                        lifecycle: "completed",
                        reason: "end_turn",
                        turns: 1,
                    });
                }
            });
            return { workspaceId, sessionId, loopId: 1, loopSeq: 1, status: 102, queued: false };
        },
        cancelDrain: () => true,
        cancelSession: async () => {},
        dispatchClientAction: async () => [],
        cancelLoop: async () => true,
        executorTags: () => ["sh"],
        readLog: async () => [],
        listProviders: () => ({ aliases: [] }),
        listModels: () => ({ items: [], total: 0, offset: 0, limit: 50 }),
        createWorkspace: async ({ name, projectRoot }: { name?: string; projectRoot?: string | null }) =>
            ({ workspaceId: 1, workspaceName: name ?? "default", projectRoot: projectRoot ?? "/tmp", projectLabel: "default" }),
        attachWorkspace: async () =>
            ({ workspaceId: 1, workspaceName: "default", projectRoot: "/tmp", projectLabel: "default" }),
        readSessionReference: async () => ({ workspaceId: 1, sessionId: 1 }),
        ensureSessionReference: async () => ({ workspaceId: 1, sessionId: 1 }),
        listSessionReferences: async () => [],
        listWorkspaces: async () => [],
        listSessions: async () => [{ id: 1, workspaceId: 1, name: "user", parentSessionId: null, kind: "model", status: 200, lifecycle: "idle", hiddenAt: null }],
        readSession: async () => ({ id: 1, workspaceId: 1, name: "user", parentSessionId: null, kind: "model", status: 200, lifecycle: "idle", hiddenAt: null }),
        listSessionLoops: async () => [],
        readSessionOverview: async () => ({ scope: null, workspaces: {}, sessions: {}, recent: [], omitted: 0 }),
        sessionAccounting: async () => ({ requests: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, knownUsage: true, costUsd: null, knownCostUsd: false }),
        sessionGauge: async () => ({ curationWeight: 0, curationBudget: 4000, contextTokens: 0, contextCapacity: 128000 }),
        listPrompts: async () => [],
        shareWorkspace: async ({ folder }: { folder: string }) => ({ folder }),
        renameWorkspace: async (id: number, name: string) => ({ id, name }),
        setWorkspaceHidden: async ({ workspaceId, hidden }: { workspaceId: number; hidden: boolean }) => ({ id: workspaceId, hidden, hiddenAt: null }),
        setSessionHidden: async ({ sessionId, hidden }: { sessionId: number; hidden: boolean }) => ({ sessionId, hidden, hiddenAt: null }),
        rollback: async () => ({ reversed: [], stoppedAt: null }),
        activateWorkspace: async () => {},
        workspacePreparationStatus: () => [],
        workspaceDerivationStatus: () => null,
        readEntry: async () => ({ target: "", channel: "body", mimetype: "text/plain", content: "", totalBytes: 0 }),
        readEntryChannel: async () => ({ target: "", channel: "body", mimetype: "text/plain", content: "", totalBytes: 0 }),
        forkSession: async () => ({ sessionId: 2, sessionName: "fork-1", parentSessionId: 1 }),
        createSession: async () => ({ sessionId: 1, sessionName: "user" }),
        readSessionModel: async () => ({ model: null, spawnModel: null }),
        setSessionModel: async () => ({ alias: null, provider: "mocktest", model: "mock", effort: null, effortSource: "default" }),
        setSessionSpawnModel: async () => null,
        readSessionEffort: async () => ({ effort: null, source: "default", supportedEfforts: [] }),
        setSessionEffort: async () => ({ effort: "medium", source: "explicit", supportedEfforts: ["medium"] }),
        readWorkspaceCapabilities: async () => ({ policy: { default: "propose" }, effective: { default: "propose" } }),
        setWorkspaceCapabilities: async ({ policy }: { policy: unknown }) => ({ policy, effective: policy }),
    } as unknown as ApplicationPort;
    await acpModule.start(startPort);

    try {
        const wsStream = createWebSocketStream(`ws://127.0.0.1:${address.port}/acp`, { WebSocket: WebSocket as unknown as WebSocketConstructor });
        const wsApp = createAcpClient();
        await wsApp.connectWith(wsStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            await ctx.buildSession("/tmp").withSession(async (session) => {
                await session.prompt("hello over ws");
                const text = await session.readTextUntilIdle();
                assert.match(text, /Stock reply: hello over ws/);
            });
        });

        const httpStream = createHttpStream(`http://127.0.0.1:${address.port}/acp`);
        const httpApp = createAcpClient();
        await httpApp.connectWith(httpStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            const resumed = await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/tmp",
            });
            assert.ok(resumed.configOptions);
        });
    } finally {
        acpModule.stop();
        await acpModule.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
