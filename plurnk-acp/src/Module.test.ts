import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PLURNK_FENCE,
    Problems,
    requestOrigin,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type Effort,
    type LogEntryWire,
    type ProposalProjection,
    type ProposalResolution,
    type WorkerOwner,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";
import Module, { type AcpPort, type AcpSetupSeam, type ModuleOptions } from "./Module.ts";
import MessageAddress from "./MessageAddress.ts";

const { default: Credentials } = await import("../../plurnk-core/src/server/Credentials.ts") as {
    default: new (options?: { readonly operatorSecret?: string | null }) => ApplicationPort["credentials"];
};

const wireRow = (partial: Partial<LogEntryWire> & { id: number; op: LogEntryWire["op"] }): LogEntryWire => ({
    worker_id: 77,
    worker_name: "main",
    loop_id: 1,
    loop_seq: 1,
    turn_id: 1,
    turn_seq: 1,
    sequence: partial.id,
    at: "2026-01-01T00:00:00.000Z",
    origin: "model",
    source: "worker:///main",
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
    tx: { body: null },
    mimetype_tx: "application/json",
    rx: { status: 200 },
    mimetype_rx: "application/json",
    status_rx: 200,
    weight: 10,
    attrs: {},
    state: "resolved",
    ...partial,
});

const loopUsage = () => ({
    accounting: {
        requests: [],
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        knownUsage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        costUsd: "0.001",
        knownCostUsd: "0.001",
    },
    curationWeight: 100,
    curationBudget: 4000,
    contextTokens: 500,
    contextCapacity: 8000,
    meta: {},
});

const mockSeam = (operatorSecret: string | null = null) => {
    const schemes = new Map<string, unknown>();
    const owners = new Map<string, WorkerOwner>();
    const claims: Array<{ workspaceId: number; workerId: number; owner: string }> = [];
    const loopRuns: Array<{ workspaceId: number; workerId: number; prompt: string; selector?: string; maxTurns?: number }> = [];
    const proposalResolves: Array<{ logEntryId: number; resolution: ProposalResolution; actor: { workspaceId: number; address: string } }> = [];
    const interactionResolves: Array<{ interactionId: number; resolution: ClientInteractionResolution; actor: { workspaceId: number; address: string } }> = [];
    const handlers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();
    const externalRefs = new Map<string, { workspaceId: number; workerId: number }>();
    const credentials = new Credentials({ operatorSecret });

    const seam: AcpPort & AcpSetupSeam = {
        registerScheme: async (name, scheme) => {
            schemes.set(name, scheme);
        },
        credentials,
        httpAddress: () => ({ host: "127.0.0.1", port: 0 }),
        registerHttpRoute: () => {},
        registerHttpUpgrade: () => {},
        subscribeToEvents: (h) => {
            handlers.add(h);
            return () => {
                handlers.delete(h);
            };
        },
        configurationNotices: () => [],
        listClientDisplayCapabilities: async () => [],
        listModuleActions: () => [{
            name: "custom.inspect",
            scope: "workspace" as const,
            inputSchema: { type: "object", additionalProperties: true },
            outputSchema: { type: "object", additionalProperties: true },
        }],
        invokeModuleAction: async (name, params, ctx) => ({ name, params, ctx }),
        attachWorkspace: async (sel) => ({
            workspaceId: "workspaceId" in sel && typeof sel.workspaceId === "number" ? sel.workspaceId : 3,
            workspaceName: "name" in sel && typeof sel.name === "string" ? sel.name : "ws-main",
            projectRoot: "projectRoot" in sel && typeof sel.projectRoot === "string" ? sel.projectRoot : "/work/project",
            projectLabel: "project",
        }),
        createWorkspace: async (a) => ({
            workspaceId: 3,
            workspaceName: a.name ?? "ws-created",
            projectRoot: a.projectRoot ?? null,
            projectLabel: null,
        }),
        registerWorkerOwner: async (_wsId, owner) => {
            owners.set(owner.address, owner);
        },
        claimWorkerOwner: async (c) => {
            claims.push(c);
            return owners.get(c.owner) ?? { address: c.owner, tools: [], interactive: true };
        },
        readWorker: async ({ identity }) => {
            if ("name" in identity && identity.name === "missing") return null;
            return {
                id: "id" in identity && typeof identity.id === "number" ? identity.id : 77,
                name: "name" in identity && typeof identity.name === "string" ? identity.name : "main",
                created_at: "2026-01-01T00:00:00.000Z",
                origin: "model" as const,
                owner: MessageAddress.OWNER,
                parentWorkerId: null,
                kind: "root" as const,
                lifecycle: "idle" as const,
                hidden_at: null,
            };
        },
        createWorker: async (a) => ({
            workerId: 77,
            workerName: a.name ?? "main",
        }),
        forkWorker: async (a) => ({
            workerId: 88,
            workerName: a.name ?? "fork-main",
            parentWorkerId: a.workerId,
        }),
        readWorkerReference: async ({ namespace, reference }) => externalRefs.get(`${namespace}:${reference}`) ?? null,
        ensureWorkerReference: async ({ namespace, reference }) => {
            const key = `${namespace}:${reference}`;
            const existing = externalRefs.get(key);
            if (existing !== undefined) return existing;
            const created = { workspaceId: 3, workerId: 77 };
            externalRefs.set(key, created);
            return created;
        },
        listWorkspaces: async () => [{
            id: 3,
            name: "ws-main",
            project_root: "/work/project",
            project_label: "project",
            created_at: "2026-01-01T00:00:00.000Z",
            hidden_at: null,
        }],
        listWorkers: async () => [{
            id: 77,
            name: "main",
            created_at: "2026-01-01T00:00:00.000Z",
            origin: "model" as const,
            owner: MessageAddress.OWNER,
            parentWorkerId: null,
            kind: "root" as const,
            lifecycle: "idle" as const,
            hidden_at: null,
        }],
        listWorkerLoops: async () => [{
            id: 1,
            workerId: 77,
            sequence: 1,
            status: 200,
            prompt: "Investigate the failing test.",
            promptSource: "acp://operator/sessions/3%23main/messages/m1",
            claimedAt: "2026-01-01T00:00:00.000Z",
            terminatedAt: "2026-01-01T00:00:01.000Z",
            terminalResult: { status: 200 },
            packetCount: 1,
            waitUntil: null,
            invocation: null,
        }],
        listPrompts: async () => ["Investigate the failing test."],
        readWorkerOverview: async () => ({
            workers: [],
            workspaces: [],
            omitted: 0,
        }),
        readLog: async () => [
            wireRow({
                id: 1,
                op: "SEND",
                origin: "_plurnk",
                attrs: { kind: "message", source: "acp://operator/sessions/3%23main/messages/m1", content: "Hello agent" },
            }),
            wireRow({
                id: 2,
                op: "READ",
                origin: "model",
                pathname: "README.md",
                rx: { status: 200, content: "# Project\n" },
            }),
            wireRow({
                id: 3,
                op: "SEND",
                origin: "model",
                tx: { body: "All set!" },
                rx: { status: 200, content: "All set!" },
            }),
        ],
        readInbox: async () => [],
        readStreams: async () => [],
        pendingProposals: async () => [],
        pendingClientInteractions: async () => [],
        resolveProposal: async (logEntryId, resolution, actor) => {
            proposalResolves.push({ logEntryId, resolution, actor });
        },
        resolveClientInteraction: async (interactionId, resolution, actor) => {
            interactionResolves.push({ interactionId, resolution, actor });
        },
        runLoop: async (a) => {
            loopRuns.push({
                workspaceId: a.workspaceId,
                workerId: a.workerId,
                prompt: a.prompt,
                ...(a.selector === undefined ? {} : { selector: a.selector }),
                ...(a.maxTurns === undefined ? {} : { maxTurns: a.maxTurns }),
            });
            setImmediate(() => {
                handlers.forEach((h) => h(a.workspaceId, "reasoning/event", {
                    workerId: a.workerId,
                    loopId: 9,
                    turnId: 1,
                    loopSeq: 2,
                    turnSeq: 1,
                    modelCallId: 1,
                    requestSequence: 1,
                    phase: "content",
                    delta: "Thinking step...",
                }));
                handlers.forEach((h) => h(a.workspaceId, "log/entry", {
                    entry: wireRow({
                        id: 10,
                        worker_id: a.workerId,
                        loop_id: 9,
                        loop_seq: 2,
                        op: "SEND",
                        origin: "model",
                        tx: { body: "Reply from loop 9." },
                        rx: { status: 200, content: "Reply from loop 9." },
                    }),
                }));
                handlers.forEach((h) => h(a.workspaceId, "loop/terminated", {
                    workerId: a.workerId,
                    loopId: 9,
                    loopSeq: 2,
                    turnIds: [1],
                    attributions: ["acp://operator"],
                    terminatedAt: 1_792_008_205_250,
                    hitMaxTurns: false,
                    result: { status: 200 },
                    usage: loopUsage(),
                }));
            });
            return { status: 100 as const, action: "enqueued_new_loop" as const, loopId: 9 };
        },
        cancelDrain: () => true,
        executorTags: () => ["sh"],
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200, content: "ok" })),
        readEntry: async ({ target }) => ({
            status: 200,
            entry: {
                entryId: 1,
                target,
                channels: {
                    "": {
                        content: "hello",
                        contentOffset: 0,
                        contentLength: 5,
                        mimetype: "text/plain",
                        weight: 5,
                        state: "static" as const,
                    },
                },
            },
        }),
        readEntryChannel: async ({ target }) => target.includes("missing")
            ? {
                status: 404,
                entry: null,
                problem: Problems.create("daemon:entry", "entry-not-found", 404, `Missing ${target}`),
            }
            : {
                status: 200,
                entry: {
                    entryId: 1,
                    target,
                    channels: {
                        "": {
                            content: "Full oversized content",
                            contentOffset: 0,
                            contentLength: 22,
                            mimetype: "text/plain",
                            weight: 22,
                            state: "static" as const,
                        },
                    },
                },
            },
        listProviders: () => ({
            aliases: [{ alias: "fast", provider: "google", model: "gemini-3-flash", active: true, inputCapacity: 1_000_000 }],
        }),
        listModels: (q) => ({
            items: [],
            offset: q.offset ?? 0,
            total: 0,
        }),
        readWorkerModel: async () => ({
            model: { alias: "fast", provider: "google", model: "gemini-3-flash" },
            spawnModel: null,
        }),
        setWorkerModel: async ({ selector }) => ({
            alias: selector,
            provider: "google",
            model: "gemini-3-flash",
        }),
        setWorkerSpawnModel: async ({ selector }) => selector === null ? null : {
            alias: selector,
            provider: "google",
            model: "gemini-3-flash",
        },
        readWorkerEffort: async () => ({
            effort: "medium",
            source: "explicit",
            supportedEfforts: ["off", "low", "medium", "high"],
        }),
        setWorkerEffort: async ({ effort }) => ({
            effort: (typeof effort === "string" ? effort : "high") as Effort,
            source: "explicit" as const,
            supportedEfforts: ["off", "low", "medium", "high"] as const,
        }),
        readWorkspaceCapabilities: async () => ({ service: {}, workspace: {}, effective: {} }),
        setWorkspaceCapabilities: async ({ policy }) => ({ service: {}, workspace: policy, effective: policy }),
        renameWorkspace: async (id, name) => ({ id, name }),
        shareWorkspace: async ({ folder }) => ({ folder }),
        setWorkspaceHidden: async ({ workspaceId, hidden }) => ({ id: workspaceId, hidden_at: hidden ? "2026-01-02T00:00:00.000Z" : null }),
        setWorkerHidden: async ({ workerId, hidden }) => ({ id: workerId, hidden_at: hidden ? "2026-01-02T00:00:00.000Z" : null, workerIds: [workerId] }),
        rollback: async ({ to }) => ({ to, restored: [], skipped: [], stopped: null }),
        workerAccounting: async () => ({ requests: [], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null }),
        workerGauge: async () => ({ curationWeight: 0, curationBudget: 4000, contextTokens: 0, contextCapacity: 8000 }),
        workspaceDerivationStatus: () => null,
        workspacePreparationStatus: () => [],
    };

    const emit = (workspaceId: number | null, method: string, params: unknown): void => {
        handlers.forEach((h) => h(workspaceId, method, params));
    };

    return {
        seam,
        schemes,
        owners,
        claims,
        loopRuns,
        proposalResolves,
        interactionResolves,
        emit,
    };
};

const hostModule = async (seam: AcpPort & AcpSetupSeam, opts: ModuleOptions = {}) => {
    const routes = new Map<string, HttpRouteHandler>();
    const upgrades = new Map<string, HttpUpgradeHandler>();
    const port: AcpPort & AcpSetupSeam = Object.assign(Object.create(seam) as AcpPort & AcpSetupSeam, {
        registerHttpRoute: (prefix: string, handler: HttpRouteHandler) => {
            routes.set(prefix, handler);
        },
        registerHttpUpgrade: (prefix: string, handler: HttpUpgradeHandler) => {
            upgrades.set(prefix, handler);
        },
    });
    const module = Module.create(opts);
    await module.setup(port);
    await module.start(port);
    const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const handler = [...routes.entries()].find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
        if (handler === undefined) {
            res.writeHead(404).end();
            return;
        }
        void handler(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const handler = [...upgrades.entries()].find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
        if (handler === undefined) {
            socket.destroy();
            return;
        }
        void handler(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const boundPort = (server.address() as AddressInfo).port;
    port.httpAddress = () => ({ host: "127.0.0.1", port: boundPort });
    return {
        module,
        port: boundPort,
        close: async () => {
            await module.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

test("{§acp-daemon-module} {§acp-transport} {§acp-session-binding} {§acp-projection} WebSocket upgrade runs initialize, session/new, and session/prompt with streamed updates", async () => {
    const { seam, schemes, claims, loopRuns } = mockSeam();
    const hosted = await hostModule(seam);
    try {
        assert.deepEqual(hosted.module.mounts, ["/acp"]);
        assert.ok(schemes.has("acp"), "registers the acp:// message scheme at setup");

        const ws = new WebSocket(`ws://127.0.0.1:${hosted.port}/acp`);
        const frames: Array<Record<string, unknown>> = [];
        const waiter = () => new Promise<void>((resolve) => {
            const onMsg = () => {
                ws.removeEventListener("message", onMsg);
                resolve();
            };
            ws.addEventListener("message", onMsg);
        });
        ws.addEventListener("message", (ev) => {
            frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", reject, { once: true });
        });

        // 1. initialize
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }));
        while (!frames.some((f) => f.id === 1)) await waiter();
        const initResp = frames.find((f) => f.id === 1)!;
        assert.equal((initResp.result as { protocolVersion: number }).protocolVersion, 2);

        // 2. session/new
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: "/work/project", workerName: "main" },
        }));
        while (!frames.some((f) => f.id === 2)) await waiter();
        const newResp = frames.find((f) => f.id === 2)!.result as { sessionId: string; workspaceId: number; workerId: number };
        assert.equal(newResp.sessionId, "3#main");
        assert.equal(newResp.workspaceId, 3);
        assert.equal(newResp.workerId, 77);
        assert.equal(claims.at(-1)?.owner, "acp://operator");

        // 3. session/prompt
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: {
                sessionId: "3#main",
                prompt: [{ type: "text", text: "Fix the bug." }],
            },
        }));
        while (!frames.some((f) => f.id === 3)) await waiter();
        const promptResp = frames.find((f) => f.id === 3)!.result as { stopReason: string; loopId: number };
        assert.equal(promptResp.stopReason, "end_turn");
        assert.equal(promptResp.loopId, 9);
        assert.equal(loopRuns.length, 1);
        assert.equal(loopRuns[0].prompt, "Fix the bug.");

        const updates = frames
            .filter((f) => f.method === "session/update")
            .map((f) => (f.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
        assert.ok(updates.includes("agent_thought_chunk"));
        assert.ok(updates.includes("agent_message_chunk"));
        assert.ok(updates.includes("usage_update"));

        ws.close();
    } finally {
        await hosted.close();
    }
});

test("{§acp-session-load} {§acp-transport} Streamable HTTP POST /acp supports JSON and SSE replay and GET /acp/entry serves channels", async () => {
    const { seam } = mockSeam();
    const hosted = await hostModule(seam, { allowOrigin: "https://client.example" });
    try {
        // OPTIONS preflight
        const preflight = await fetch(`http://127.0.0.1:${hosted.port}/acp`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "https://client.example");

        // SSE session/load
        const sseRes = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "load-1",
                method: "session/load",
                params: { sessionId: "3#main" },
            }),
        });
        assert.equal(sseRes.status, 200);
        assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
        const sseText = await sseRes.text();
        const events = sseText
            .split("\n\n")
            .filter((chunk) => chunk.startsWith("data: "))
            .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
        const replayedKinds = events
            .filter((e) => e.method === "session/update")
            .map((e) => (e.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
        assert.deepEqual(replayedKinds, ["user_message_chunk", "tool_call", "agent_message_chunk"]);
        const terminal = events.find((e) => e.id === "load-1")!;
        assert.equal((terminal.result as { sessionId: string }).sessionId, "3#main");

        // Unqualified sessionId resolution with create: true
        const extRes = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "load-ext",
                method: "session/resume",
                params: { sessionId: "external-uuid-1", create: true },
            }),
        });
        assert.equal(extRes.status, 200);
        const extBody = await extRes.json() as { result: { sessionId: string; workerId: number; notifications: unknown[] } };
        assert.equal(extBody.result.sessionId, "external-uuid-1");
        assert.equal(extBody.result.workerId, 77);
        assert.equal(extBody.result.notifications.length, 3);

        // GET /acp/entry
        const entryOk = await fetch(`http://127.0.0.1:${hosted.port}/acp/entry?workspaceId=3&workerId=77&target=${encodeURIComponent("worker:///main#1")}`);
        assert.equal(entryOk.status, 200);
        assert.equal(await entryOk.text(), "Full oversized content");

        const entryBad = await fetch(`http://127.0.0.1:${hosted.port}/acp/entry?workspaceId=0`);
        assert.equal(entryBad.status, 400);
        assert.equal((await entryBad.json() as { type: string }).type, "https://problems.plurnk.xyz/acp/entry-query-invalid");

        const entryMissing = await fetch(`http://127.0.0.1:${hosted.port}/acp/entry?workspaceId=3&workerId=77&target=missing`);
        assert.equal(entryMissing.status, 404);
    } finally {
        await hosted.close();
    }
});

test("{§acp-http-authorization} Bearer token admission enforces the acp scope and revokes active connections", async () => {
    const { seam } = mockSeam("operator-secret-123");
    seam.credentials.publish({
        issuer: (req) => requestOrigin(req ?? { headers: {} }, seam.httpAddress()),
    });
    const hosted = await hostModule(seam);
    try {
        // 1. Unauthenticated HTTP request -> 401
        const unauth = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        });
        assert.equal(unauth.status, 401);
        assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata=/);

        // 2. Token without acp scope -> 403
        const aguiOnly = seam.credentials.issue({
            kind: "access",
            subject: "operator",
            clientId: "operator",
            family: "fam-agui",
            scopes: ["agui"],
            ttlMs: 60_000,
        });
        const forbidden = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${aguiOnly.token}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        });
        assert.equal(forbidden.status, 403);
        assert.equal((await forbidden.json() as { type: string }).type, "https://problems.plurnk.xyz/acp/insufficient-scope");

        // 3. Token with acp scope -> 200 and WebSocket revocation closes peer
        const acpGrant = seam.credentials.issue({
            kind: "access",
            subject: "operator",
            clientId: "operator",
            family: "fam-acp",
            scopes: ["acp"],
            ttlMs: 60_000,
        });
        const okRes = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${acpGrant.token}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        });
        assert.equal(okRes.status, 200);

        const ws = new WebSocket(`ws://127.0.0.1:${hosted.port}/acp?access_token=${encodeURIComponent(acpGrant.token)}`);
        const frames: Array<Record<string, unknown>> = [];
        ws.addEventListener("message", (ev) => {
            frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", reject, { once: true });
        });
        const closed = new Promise<void>((resolve) => {
            ws.addEventListener("close", () => resolve(), { once: true });
        });
        const claims = seam.credentials.verify(acpGrant.token)!;
        seam.credentials.revokeFamily(claims.family);
        await closed;
        const errFrame = frames.find((f) => f.method === "_plurnk/error");
        assert.equal(
            (errFrame?.params as { problem: { type: string } })?.problem.type,
            "https://problems.plurnk.xyz/acp/credential-revoked",
        );
    } finally {
        await hosted.close();
    }
});

test("{§acp-hitl} proposals and client interactions emit server requests on WebSocket and settle via JSON-RPC response or explicit method", async () => {
    const { seam, proposalResolves, interactionResolves, emit } = mockSeam();
    const hosted = await hostModule(seam);
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${hosted.port}/acp`);
        const frames: Array<Record<string, unknown>> = [];
        const nextFrame = () => new Promise<void>((resolve) => {
            const onMsg = () => {
                ws.removeEventListener("message", onMsg);
                resolve();
            };
            ws.addEventListener("message", onMsg);
        });
        ws.addEventListener("message", (ev) => {
            frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));

        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "new-1",
            method: "session/new",
            params: { workspaceId: 3, workerName: "main" },
        }));
        while (!frames.some((f) => f.id === "new-1")) await nextFrame();

        const proposal: ProposalProjection = {
            logEntryId: 42,
            workerId: 77,
            worker: "main",
            loopId: 2,
            turnId: 1,
            coordinate: "1/1/1",
            op: "sh",
            target: { scheme: null, authority: null, pathname: null },
            body: "npm test",
            attrs: {},
            owner: MessageAddress.OWNER,
            disposition: { decision: "review" },
        };
        emit(3, "loop/proposal", proposal);
        while (!frames.some((f) => f.method === "session/request_permission")) await nextFrame();
        const permReq = frames.find((f) => f.method === "session/request_permission")!;
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: permReq.id,
            result: { outcome: { outcome: "selected", optionId: "accept" } },
        }));

        const interaction: ClientInteractionProjection = {
            interactionId: 99,
            workerId: 77,
            loopId: 2,
            turnId: 1,
            recipient: MessageAddress.OWNER,
            request: {
                toolName: "ask_user",
                message: "Which branch?",
                arguments: {},
                responseSchema: { type: "string" },
            },
        };
        emit(3, "loop/interaction", interaction);
        while (!frames.some((f) => f.method === "_plurnk/question")) await nextFrame();
        const qReq = frames.find((f) => f.method === "_plurnk/question")!;
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: qReq.id,
            result: { payload: "main" },
        }));

        // Also exercise explicit session/resolve_permission and _plurnk/interaction.resolve RPC calls
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "explicit-perm",
            method: "session/resolve_permission",
            params: { sessionId: "3#main", logEntryId: 43, decision: "reject", outcome: "Too risky" },
        }));
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: "explicit-int",
            method: "_plurnk/interaction.resolve",
            params: { sessionId: "3#main", interactionId: 100, status: "cancelled" },
        }));
        while (!frames.some((f) => f.id === "explicit-perm") || !frames.some((f) => f.id === "explicit-int")) {
            await nextFrame();
        }

        assert.equal(proposalResolves.length, 2);
        assert.deepEqual(proposalResolves[0].resolution, { decision: "accept" });
        assert.deepEqual(proposalResolves[1].resolution, { decision: "reject", outcome: "Too risky" });
        assert.equal(interactionResolves.length, 2);
        assert.deepEqual(interactionResolves[0].resolution, { status: "resolved", payload: "main" });
        assert.deepEqual(interactionResolves[1].resolution, { status: "cancelled" });

        ws.close();
    } finally {
        await hosted.close();
    }
});

test("{§acp-extensions} {§module-route-settlement} session management, _plurnk/* extensions, and module close settlement", async () => {
    const { seam } = mockSeam();
    const hosted = await hostModule(seam);
    try {
        const rpc = async (method: string, params: Record<string, unknown> = {}) => {
            const res = await fetch(`http://127.0.0.1:${hosted.port}/acp`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            assert.equal(res.status, 200);
            return await res.json() as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: { problem?: { type: string } } } };
        };

        const list = await rpc("session/list");
        assert.equal((list.result!.sessions as unknown[]).length, 1);

        const fork = await rpc("session/fork", { sessionId: "3#main", name: "branch-a" });
        assert.equal(fork.result!.sessionId, "3#branch-a");
        assert.equal(fork.result!.parentWorkerId, 77);

        const cfg = await rpc("session/set_config_option", { sessionId: "3#main", configId: "effort", value: "high" });
        assert.ok(Array.isArray(cfg.result!.configOptions));

        const cancel = await rpc("session/cancel", { sessionId: "3#main" });
        assert.equal(cancel.result!.cancelled, true);

        const closeResp = await rpc("session/close", { sessionId: "3#main" });
        assert.equal(closeResp.result!.closed, true);

        const discover = await rpc("_plurnk/discover");
        assert.equal(discover.result!.protocolVersion, 2);
        assert.ok("custom.inspect" in (discover.result!.actions as Record<string, unknown>));

        const overview = await rpc("_plurnk/overview", { workspaceId: 3 });
        assert.deepEqual(overview.result, { workers: [], workspaces: [], omitted: 0 });

        const customAction = await rpc("_plurnk/action", {
            sessionId: "3#main",
            kind: "custom.inspect",
            params: { deep: true },
        });
        assert.equal((customAction.result as { name: string }).name, "custom.inspect");

        const parseAction = await rpc("_plurnk/action", {
            sessionId: "3#main",
            kind: "op.parse",
            params: { text: `${PLURNK_FENCE}NOTE\nhello\n${PLURNK_FENCE}\n` },
        });
        assert.equal(((parseAction.result as { results: Array<{ status: number }> }).results)[0].status, 200);

        const badParse = await rpc("_plurnk/action", {
            sessionId: "3#main",
            kind: "op.parse",
            params: { text: `${PLURNK_FENCE}READ [unclosed\n${PLURNK_FENCE}\n` },
        });
        assert.equal(
            ((badParse.result as { results: Array<{ problem?: { type: string } }> }).results)[0].problem?.type,
            "https://problems.plurnk.xyz/acp/parse-failed",
        );

        const missingSession = await rpc("session/load", { sessionId: "3#missing" });
        assert.equal(missingSession.error?.data?.problem?.type, "https://problems.plurnk.xyz/acp/session-not-found");

        const badAddress = await rpc("session/load", { sessionId: "0#bad" });
        assert.equal(badAddress.error?.data?.problem?.type, "https://problems.plurnk.xyz/acp/session-address-invalid");
    } finally {
        await hosted.close();
    }
});
