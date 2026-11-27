import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import {
    Client,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
    Problems,
    Validator,
    type CredentialAuthority,
    type EntryReadResult,
    type JsonSchema,
    type ProposalPolicy,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort, HttpRouteHandler } from "@plurnk/plurnk-contracts/port";
import createModules from "./daemon-module.ts";
import McpServerModule from "./McpServerModule.ts";

const makeChannel = (
    content: string,
    state: "static" | "closed" | "active" | "errored" = "static",
    mimetype = "text/plain",
) => ({
    content,
    contentLength: content.length,
    contentOffset: 0,
    state,
    mimetype,
    weight: content.length,
});

interface FakeHarnessOptions {
    readonly auth?: {
        readonly tokens: Readonly<
            Record<
                string,
                {
                    readonly subject?: string;
                    readonly handle?: string;
                    readonly name?: string;
                    readonly canDelegateActor?: boolean;
                    readonly scopes?: readonly string[];
                }
            >
        >;
    };
    readonly initialWorkspaces?: ReadonlyArray<{ readonly id: number; readonly name: string; readonly archived?: boolean }>;
    readonly initialSessions?: ReadonlyArray<{ readonly workspaceId: number; readonly id: number; readonly name: string; readonly origin: "model" | "system" }>;
    readonly catalogTools?: ReadonlyArray<Record<string, unknown>>;
    readonly docsMarkdown?: string;
    readonly onDispatch?: (req: Parameters<ApplicationPort["dispatchClientAction"]>[0]) => Promise<ReadonlyArray<Record<string, unknown>>>;
    readonly entries?: Readonly<Record<string, EntryReadResult["entry"]>>;
    readonly entryFailures?: Readonly<Record<string, { readonly status: number; readonly detail: string }>>;
    readonly proposalPolicy?: ProposalPolicy;
    readonly allowOrigin?: string;
    readonly openStreams?: ReadonlyArray<{ readonly target: string; readonly channels: ReadonlyArray<{ readonly name: string; readonly state: "active" | "completed" | "errored" }> }>;
    readonly logRows?: ReadonlyArray<Record<string, unknown>>;
}

const createHarness = async (t: TestContext, options: FakeHarnessOptions = {}) => {
    let currentProposalPolicy: ProposalPolicy = options.proposalPolicy ?? "accept";
    const workspaces = new Map<number, { id: number; name: string; archived: boolean }>();
    for (const ws of options.initialWorkspaces ?? [{ id: 1, name: "default", archived: false }]) {
        workspaces.set(ws.id, { id: ws.id, name: ws.name, archived: ws.archived ?? false });
    }
    let nextWorkspaceId = Math.max(0, ...workspaces.keys()) + 1;

    const sessions = new Map<number, { workspaceId: number; id: number; name: string; origin: "model" | "system" }>();
    for (const s of options.initialSessions ?? [
        { workspaceId: 1, id: 1, name: "_plurnk", origin: "system" as const },
        { workspaceId: 1, id: 2, name: "user", origin: "model" as const },
    ]) {
        sessions.set(s.id, { ...s });
    }
    let nextSessionId = Math.max(0, ...sessions.keys()) + 1;

    const eventSubscribers = new Set<{
        readonly cb: (workspaceId: number | null, method: string, params: unknown) => void;
        readonly events?: ReadonlySet<string>;
    }>();
    const cancelledLoops: Array<{ workspaceId: number; loopId: number; reason: string }> = [];
    const dispatched: Array<Parameters<ApplicationPort["dispatchClientAction"]>[0]> = [];
    let routeHandler: HttpRouteHandler | null = null;

    let catalogJson = JSON.stringify({
        tools: options.catalogTools ?? [
            {
                name: "note",
                description: "Update session notes.",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                },
            },
            {
                name: "read",
                description: "Read a file or resource.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        effort: { $ref: "https://schemas.plurnk.xyz/v0/Effort.json" },
                    },
                    required: ["path"],
                    additionalProperties: false,
                },
            },
            {
                name: "sh",
                description: "Execute a POSIX shell script.",
                inputSchema: {
                    type: "object",
                    properties: {
                        script: { type: "string" },
                        detached: { type: "boolean" },
                    },
                    required: ["script"],
                    additionalProperties: false,
                },
            },
            {
                name: "env",
                description: "Manage workspace environment variables.",
                inputSchema: {
                    type: "object",
                    properties: {
                        action: { type: "string" },
                    },
                    additionalProperties: true,
                },
            },
        ],
    });
    const docsMd = options.docsMarkdown ?? "# Plurnk Server\n\nTools: note, read, sh, env.\n";

    const verifyToken = async (token: string) => {
        const found = options.auth?.tokens[token];
        if (found === undefined) return null;
        return {
            subject: found.subject ?? "test-subject",
            ...(found.handle !== undefined ? { handle: found.handle } : {}),
            ...(found.name !== undefined ? { name: found.name } : {}),
            ...(found.canDelegateActor === true ? { canDelegateActor: true } : {}),
            scopes: found.scopes ?? ["openid"],
            expiresAt: Date.now() + 60_000,
        };
    };

    const credentials: CredentialAuthority = {
        publish: () => {},
        face: () =>
            options.auth === undefined
                ? null
                : {
                      issuer: (req) =>
                          `http://${typeof req?.headers.host === "string" ? req.headers.host : "127.0.0.1"}`,
                      verify: verifyToken,
                  },
        verify: (token) => (options.auth === undefined ? null : verifyToken(token)),
    };

    const notFoundWorkspace = (detail: string): Error => {
        const err = new Error(detail);
        Object.assign(err, {
            problem: Problems.create("engine:workspace", "workspace-not-found", 404, detail, {
                code: "engine/workspace/workspace-not-found",
            }),
        });
        return err;
    };

    let boundPort = 0;
    const seam = {
        credentials,
        httpAddress: () => ({ host: "127.0.0.1", port: boundPort }),
        registerHttpRoute: (prefix: string, handler: HttpRouteHandler) => {
            assert.equal(prefix, "/mcp");
            routeHandler = handler;
        },
        subscribeToEvents: (
            cb: (workspaceId: number | null, method: string, params: unknown) => void,
            filter?: { readonly events?: readonly string[] },
        ) => {
            const sub = {
                cb,
                ...(filter?.events !== undefined ? { events: new Set(filter.events) } : {}),
            };
            eventSubscribers.add(sub);
            return () => eventSubscribers.delete(sub);
        },
        attachWorkspace: async (req: { workspaceId?: number; name?: string }) => {
            if (req.workspaceId !== undefined) {
                const ws = workspaces.get(req.workspaceId);
                if (ws === undefined || ws.archived) throw notFoundWorkspace(`Workspace ${req.workspaceId} not found.`);
                return { workspaceId: ws.id, name: ws.name, projectRoot: null };
            }
            const found = [...workspaces.values()].find((w) => w.name === req.name && !w.archived);
            if (found === undefined) throw notFoundWorkspace(`Workspace '${req.name}' not found.`);
            return { workspaceId: found.id, name: found.name, projectRoot: null };
        },
        createWorkspace: async (req: { name: string; projectRoot: string | null }) => {
            const id = nextWorkspaceId++;
            workspaces.set(id, { id, name: req.name, archived: false });
            const sysId = nextSessionId++;
            sessions.set(sysId, { workspaceId: id, id: sysId, name: "_plurnk", origin: "system" });
            return { workspaceId: id, name: req.name, projectRoot: req.projectRoot };
        },
        listWorkspaces: async (req?: { archived?: boolean }) => {
            return [...workspaces.values()]
                .filter((w) => (req?.archived === undefined ? true : w.archived === req.archived))
                .map((w) => ({ id: w.id, name: w.name, projectRoot: null, archived: w.archived }));
        },
        activateWorkspace: async () => undefined,
        ensureRuntimeSession: async (workspaceId: number) => {
            const existing = [...sessions.values()].find((s) => s.workspaceId === workspaceId && s.name === "_plurnk");
            if (existing !== undefined) return existing.id;
            const id = nextSessionId++;
            sessions.set(id, { workspaceId, id, name: "_plurnk", origin: "system" });
            return id;
        },
        readSession: async (req: { workspaceId: number; identity: { id?: number; name?: string } }) => {
            if (req.identity.id !== undefined) {
                const s = sessions.get(req.identity.id);
                if (s === undefined || s.workspaceId !== req.workspaceId) return null;
                return { id: s.id, name: s.name, origin: s.origin, archived: false, parentId: null, kind: null, persona: null, model: null };
            }
            const found = [...sessions.values()].find((s) => s.workspaceId === req.workspaceId && s.name === req.identity.name);
            if (found === undefined) return null;
            return { id: found.id, name: found.name, origin: found.origin, archived: false, parentId: null, kind: null, persona: null, model: null };
        },
        createSession: async (req: { workspaceId: number; name: string }) => {
            const id = nextSessionId++;
            sessions.set(id, { workspaceId: req.workspaceId, id, name: req.name, origin: "model" });
            return { sessionId: id, name: req.name };
        },
        listSessions: async (workspaceId: number) => {
            return [...sessions.values()]
                .filter((s) => s.workspaceId === workspaceId)
                .map((s) => ({ id: s.id, name: s.name, origin: s.origin, archived: false, parentId: null, kind: null, persona: null, model: null }));
        },
        readEntry: async (req: { workspaceId: number; sessionId: number; target: string }): Promise<EntryReadResult> => {
            if (req.target === "mcp:///plurnk.json") {
                return {
                    status: 200,
                    entry: {
                        entryId: null,
                        target: "mcp:///plurnk.json",
                        channels: {
                            body: makeChannel(catalogJson, "static", "application/json"),
                        },
                    },
                };
            }
            if (req.target === "mcp:///plurnk.md") {
                return {
                    status: 200,
                    entry: {
                        entryId: null,
                        target: "mcp:///plurnk.md",
                        channels: {
                            body: makeChannel(docsMd, "static", "text/markdown"),
                        },
                    },
                };
            }
            if (req.target === "plurnk:///status.json") {
                const s = sessions.get(req.sessionId);
                if (s === undefined || s.workspaceId !== req.workspaceId) {
                    return {
                        status: 404,
                        problem: Problems.create("scheme:plurnk", "session-not-found", 404, `Session ${req.sessionId} does not exist.`),
                        entry: null,
                    };
                }
                const payload = JSON.stringify(
                    {
                        workspaceId: req.workspaceId,
                        sessionId: req.sessionId,
                        isModelSession: s.origin === "model",
                        session: {
                            id: s.id,
                            name: s.name,
                            origin: s.origin,
                            archived: false,
                            parentId: null,
                            kind: null,
                            persona: null,
                            model: null,
                        },
                        loops: [{ id: 1, loopSeq: 1, terminatedAt: null }],
                        inbox: [],
                        openStreams: [...(options.openStreams ?? [])],
                        pendingProposals: [],
                        pendingInteractions: [],
                    },
                    null,
                    2,
                );
                return {
                    status: 200,
                    entry: {
                        entryId: null,
                        target: "plurnk:///status.json",
                        channels: {
                            body: makeChannel(payload, "static", "application/json"),
                        },
                    },
                };
            }
            if (req.target === "plurnk:///recent.json") {
                const runtimeSession = [...sessions.values()].find(
                    (s) => s.workspaceId === req.workspaceId && s.name === "_plurnk",
                );
                const runtimeSessionId = runtimeSession?.id ?? null;
                const stamp = (row: Record<string, unknown>) => ({
                    ...row,
                    coordinate:
                        typeof row.loopSeq === "number" &&
                        typeof row.turnSeq === "number" &&
                        typeof row.sequence === "number" &&
                        typeof row.op === "string" &&
                        row.op.length > 0
                            ? `log:///${row.loopSeq}/${row.turnSeq}/${row.sequence}/${row.op.toLowerCase()}`
                            : null,
                });
                const allRows = [...(options.logRows ?? [])];
                const sessionRows = allRows.filter((r) => r.sessionId === undefined || r.sessionId === req.sessionId);
                const runtimeRows =
                    runtimeSessionId !== null && runtimeSessionId !== req.sessionId
                        ? allRows.filter((r) => r.sessionId === runtimeSessionId)
                        : [];
                const payload = JSON.stringify(
                    {
                        workspaceId: req.workspaceId,
                        sessionId: req.sessionId,
                        entries: sessionRows.map(stamp),
                        runtimeEntries: runtimeRows.map(stamp),
                    },
                    null,
                    2,
                );
                return {
                    status: 200,
                    entry: {
                        entryId: null,
                        target: "plurnk:///recent.json",
                        channels: {
                            body: makeChannel(payload, "static", "application/json"),
                        },
                    },
                };
            }
            const failure = options.entryFailures?.[req.target];
            if (failure !== undefined) {
                return {
                    status: failure.status,
                    problem: Problems.create("engine:entry", "entry-failed", failure.status, failure.detail),
                    entry: null,
                };
            }
            const custom = options.entries?.[req.target];
            if (custom !== undefined && custom !== null) {
                return { status: 200, entry: custom };
            }
            return {
                status: 404,
                problem: Problems.create("engine:entry", "entry-not-found", 404, "Entry not found."),
                entry: null,
            };
        },
        readWorkspaceProposalPolicy: async () => ({
            policy: currentProposalPolicy,
            effective: currentProposalPolicy,
        }),
        executorTags: () => new Set(["sh", "js", "python3", "env", "mcp", "plurnk"]),
        dispatchClientAction: async (req: Parameters<ApplicationPort["dispatchClientAction"]>[0]) => {
            dispatched.push(req);
            if (options.onDispatch !== undefined) {
                return options.onDispatch(req);
            }
            const stmt = req.statements[0];
            if ("op" in stmt && stmt.op === "note") {
                return [{ status: 200, content: stmt.body ?? "" }];
            }
            if ("op" in stmt && stmt.op === "read") {
                return [{ status: 200, content: `read:${stmt.target?.raw ?? ""}` }];
            }
            return [{ status: 200, detail: "ok" }];
        },
        cancelLoop: async (req: { workspaceId: number; loopId: number; reason: string }) => {
            cancelledLoops.push(req);
            return { cancelled: true };
        },
        readLog: async (req: { loopSeq?: number; turnSeq?: number; sequence?: number; sessionId?: number }) => {
            const rows = [...(options.logRows ?? [])];
            return rows.filter((row) => {
                if (req.sessionId !== undefined && row.sessionId !== undefined && row.sessionId !== req.sessionId) {
                    return false;
                }
                if (req.loopSeq !== undefined && row.loopSeq !== req.loopSeq) return false;
                if (req.turnSeq !== undefined && row.turnSeq !== req.turnSeq) return false;
                if (req.sequence !== undefined && row.sequence !== req.sequence) return false;
                return true;
            });
        },
        readStreams: async () => [...(options.openStreams ?? [])],
        listSessionLoops: async () => [{ id: 1, loopSeq: 1, terminatedAt: null }],
        readInbox: async () => [],
        pendingProposals: async () => [],
        pendingClientInteractions: async () => [],
    } as unknown as ApplicationPort;

    const mod = McpServerModule.create(
        options.allowOrigin !== undefined ? { allowOrigin: options.allowOrigin } : {},
    );
    mod.start(seam);

    const server = createServer((req, res) => {
        assert.notEqual(routeHandler, null);
        void routeHandler!(req, res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    boundPort = port;

    t.after(async () => {
        await mod.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const emitEvent = (workspaceId: number | null, method: string, params: unknown): void => {
        for (const sub of eventSubscribers) {
            if (sub.events !== undefined && !sub.events.has(method)) continue;
            sub.cb(workspaceId, method, params);
        }
    };

    const setProposalPolicy = (policy: ProposalPolicy): void => {
        currentProposalPolicy = policy;
    };

    const setCatalogTools = (nextTools: ReadonlyArray<Record<string, unknown>>): void => {
        catalogJson = JSON.stringify({ tools: nextTools });
    };

    return {
        mod,
        seam,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        workspaces,
        sessions,
        dispatched,
        cancelledLoops,
        emitEvent,
        setProposalPolicy,
        setCatalogTools,
    };
};

test("{§mcp-module} {§mcp-http-server} daemon-module exports both the Functionality Module and McpServerModule", () => {
    const modules = createModules();
    assert.equal(modules.length, 2);
    assert.equal("mounts" in modules[0], false);
    assert.deepEqual(modules[1].mounts, ["/mcp"]);
});

test("{§mcp-http-server} McpServerModule enforces start/stop/close lifecycle invariants and returns 503 when stopped", async (t) => {
    const { mod, baseUrl } = await createHarness(t);
    assert.throws(() => mod.start({} as ApplicationPort), /already activated/u);

    mod.stop();
    const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    assert.equal(res.status, 503);
    const problem = (await res.json()) as { code: string };
    assert.equal(problem.code, "mcp/http/service-stopping");

    await mod.close();
    assert.throws(() => mod.start({} as ApplicationPort), /stopped server module cannot be activated/u);
});

test("{§mcp-http-server} Streamable HTTP client lists tools, reads resources, and executes synchronous tools across /mcp, /mcp/<workspace>, and /mcp/<workspace>/<session>", async (t) => {
    const { baseUrl, dispatched, workspaces, sessions } = await createHarness(t);

    // 1. Default route `/mcp` -> workspace 1 ('default'), session 2 ('user')
    const clientDefault = new Client({ name: "test-client", version: "1.0.0" });
    const transportDefault = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await clientDefault.connect(transportDefault);
    t.after(() => clientDefault.close());

    const { tools } = await clientDefault.listTools();
    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["note", "read", "sh", "env"],
    );
    const readTool = tools.find((tool) => tool.name === "read")!;
    assert.ok(readTool.inputSchema && typeof readTool.inputSchema === "object");

    const { resources } = await clientDefault.listResources();
    assert.deepEqual(
        resources.map((r) => r.uri),
        [
            "mcp:///plurnk.md",
            "mcp:///plurnk.json",
            "plurnk:///status.json",
            "plurnk:///recent.json",
        ],
    );

    const { resourceTemplates } = await clientDefault.listResourceTemplates();
    assert.deepEqual(
        resourceTemplates.map((rt) => rt.uriTemplate),
        [
            "log:///{loopSeq}/{turnSeq}/{sequence}/{op}",
            "mcp:///plurnk/{tool}.json",
            "workspace:///{+path}",
        ],
    );

    const mdRead = await clientDefault.readResource({ uri: "mcp:///plurnk.md" });
    assert.equal((mdRead.contents[0] as { text: string }).text, "# Plurnk Server\n\nTools: note, read, sh, env.\n");

    const jsonRead = await clientDefault.readResource({ uri: "mcp:///plurnk.json" });
    assert.ok(JSON.parse((jsonRead.contents[0] as { text: string }).text).tools.length === 4);

    const statusRead = await clientDefault.readResource({ uri: "plurnk:///status.json" });
    const statusJson = JSON.parse((statusRead.contents[0] as { text: string }).text) as {
        workspaceId: number;
        sessionId: number;
        isModelSession: boolean;
        session: { name: string };
        loops: Array<{ id: number }>;
    };
    assert.equal(statusJson.workspaceId, 1);
    assert.equal(statusJson.sessionId, 2);
    assert.equal(statusJson.isModelSession, true);
    assert.equal(statusJson.session.name, "user");
    assert.equal(statusJson.loops.length, 1);

    const noteCall = await clientDefault.callTool({ name: "note", arguments: { text: "hello world" } });
    assert.equal(noteCall.isError, undefined);
    assert.equal((noteCall.content[0] as { text: string }).text, "hello world");
    assert.equal(dispatched.at(-1)?.workspaceId, 1);
    assert.equal(dispatched.at(-1)?.contextSessionId, 2);

    // 2. Named workspace + session `/mcp/alpha/agent-2` auto-creates both
    const clientScoped = new Client({ name: "scoped-client", version: "1.0.0" });
    const transportScoped = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/alpha/agent-2`));
    await clientScoped.connect(transportScoped);
    t.after(() => clientScoped.close());

    const readCall = await clientScoped.callTool({ name: "read", arguments: { path: "README.md" } });
    assert.equal((readCall.content[0] as { text: string }).text, "read:README.md");
    const alphaWs = [...workspaces.values()].find((w) => w.name === "alpha");
    assert.ok(alphaWs !== undefined);
    const agentSession = [...sessions.values()].find((s) => s.workspaceId === alphaWs.id && s.name === "agent-2");
    assert.ok(agentSession !== undefined);
    assert.equal(dispatched.at(-1)?.workspaceId, alphaWs.id);
    assert.equal(dispatched.at(-1)?.contextSessionId, agentSession.id);

    // 3. Runtime session `/mcp/1/_plurnk` omits contextSessionId (system session)
    const clientRuntime = new Client({ name: "runtime-client", version: "1.0.0" });
    const transportRuntime = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/1/_plurnk`));
    await clientRuntime.connect(transportRuntime);
    t.after(() => clientRuntime.close());

    await clientRuntime.callTool({ name: "note", arguments: { text: "sys" } });
    assert.equal(dispatched.at(-1)?.workspaceId, 1);
    assert.equal(dispatched.at(-1)?.contextSessionId, undefined);
});

test("{§mcp-http-server} fallback target resolution selects first unarchived workspace or creates default, and resolves numeric IDs", async (t) => {
    const { baseUrl, workspaces, sessions, dispatched } = await createHarness(t, {
        initialWorkspaces: [{ id: 7, name: "custom-ws", archived: false }],
        initialSessions: [
            { workspaceId: 7, id: 10, name: "_plurnk", origin: "system" },
            { workspaceId: 7, id: 11, name: "coder", origin: "model" },
        ],
    });

    // `/mcp/` falls back to workspace 7 ('custom-ws') and first model session 11 ('coder')
    const client1 = new Client({ name: "fallback-client", version: "1.0.0" });
    await client1.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/`)));
    t.after(() => client1.close());
    await client1.callTool({ name: "note", arguments: { text: "check" } });
    assert.equal(dispatched.at(-1)?.workspaceId, 7);
    assert.equal(dispatched.at(-1)?.contextSessionId, 11);

    // Numeric workspace and session `/mcp/7/11`
    const client2 = new Client({ name: "numeric-client", version: "1.0.0" });
    await client2.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/7/11`)));
    t.after(() => client2.close());
    await client2.callTool({ name: "note", arguments: { text: "numeric" } });
    assert.equal(dispatched.at(-1)?.workspaceId, 7);
    assert.equal(dispatched.at(-1)?.contextSessionId, 11);

    // When all workspaces are archived, `/mcp` creates `default` and `user`
    workspaces.set(7, { id: 7, name: "custom-ws", archived: true });
    sessions.clear();
    const client3 = new Client({ name: "empty-fallback", version: "1.0.0" });
    await client3.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    t.after(() => client3.close());
    await client3.callTool({ name: "note", arguments: { text: "fresh" } });
    const createdDefault = [...workspaces.values()].find((w) => w.name === "default");
    assert.ok(createdDefault !== undefined);
    assert.equal(dispatched.at(-1)?.workspaceId, createdDefault.id);
});

test("{§mcp-http-server} invalid routes, missing numeric IDs, and malformed encoding return RFC 9457 Problem Details", async (t) => {
    const { baseUrl } = await createHarness(t);

    const tooManySegments = await fetch(`${baseUrl}/mcp/a/b/c`, { method: "POST" });
    assert.equal(tooManySegments.status, 404);
    assert.equal(((await tooManySegments.json()) as { code: string }).code, "mcp/http/route-not-found");

    const badEncoding = await fetch(`${baseUrl}/mcp/%E0%A4%A`, { method: "POST" });
    assert.equal(badEncoding.status, 400);
    assert.equal(((await badEncoding.json()) as { code: string }).code, "mcp/http/request-target-invalid");

    const missingWorkspace = await fetch(`${baseUrl}/mcp/999`, { method: "POST" });
    assert.equal(missingWorkspace.status, 404);
    assert.equal(((await missingWorkspace.json()) as { code: string }).code, "engine/workspace/workspace-not-found");

    const missingSession = await fetch(`${baseUrl}/mcp/default/999`, { method: "POST" });
    assert.equal(missingSession.status, 404);
    assert.equal(((await missingSession.json()) as { code: string }).code, "mcp/http/session-not-found");
});

test("{§mcp-http-server} credential authority enforces bearer tokens and browser origin CSRF protection", async (t) => {
    const { baseUrl } = await createHarness(t, {
        auth: {
            tokens: {
                "valid-mcp": { subject: "alice", scopes: ["openid"] },
            },
        },
    });

    // 1. Missing token -> 401 bearer-token-required
    const noToken = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get("www-authenticate") ?? "", /Bearer realm="plurnk"/u);
    assert.equal(((await noToken.json()) as { code: string }).code, "mcp/http/bearer-token-required");

    // 2. Unknown token -> 401 bearer-token-invalid
    const badRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer unknown" },
        body: "{}",
    });
    assert.equal(badRes.status, 401);
    assert.match(badRes.headers.get("www-authenticate") ?? "", /error="invalid_token"/u);
    assert.equal(((await badRes.json()) as { code: string }).code, "mcp/http/bearer-token-invalid");

    // 3. Cross-origin browser CSRF when PLURNK_MCP_ALLOW_ORIGIN="" -> 403 cross-origin-forbidden
    const { baseUrl: sameOriginUrl } = await createHarness(t, { allowOrigin: "" });
    const crossSite = await fetch(`${sameOriginUrl}/mcp`, {
        method: "POST",
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: "{}",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(((await crossSite.json()) as { code: string }).code, "mcp/http/cross-origin-forbidden");

    // 4. Valid bearer token connects and lists tools
    const client = new Client({ name: "auth-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer valid-mcp" } },
    });
    await client.connect(transport);
    t.after(() => client.close());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
});

test("{§mcp-http-server} execution verbs settle via stream/concluded and surface errors", async (t) => {
    let mode: "settled-sh" | "settled-result-channel" | "failed-op" = "settled-sh";
    const { baseUrl, emitEvent } = await createHarness(t, {
        logRows: [],
        openStreams: [
            { target: "sh:///1/1/1", channels: [{ name: "stdout", state: "active" }] },
            { target: "plurnk:///1/1/2", channels: [{ name: "result", state: "active" }] },
        ],
        entries: {
            "sh:///1/1/1": {
                entryId: 1,
                target: "sh:///1/1/1",
                channels: {
                    stdout: makeChannel("build succeeded\n", "closed"),
                },
            },
            "plurnk:///1/1/2": {
                entryId: 2,
                target: "plurnk:///1/1/2",
                channels: {
                    result: makeChannel('{"variables":[]}', "closed", "application/json"),
                },
            },
        },
        onDispatch: async (req) => {
            req.onLoop?.({ sessionId: 2, loopId: 1 });
            if (mode === "failed-op") {
                return [
                    {
                        status: 422,
                        problem: {
                            detail: "Invalid shell command.",
                            recovery: "Provide a non-empty script.",
                        },
                    },
                ];
            }
            if (mode === "settled-result-channel") {
                setTimeout(() => {
                    emitEvent(1, "stream/concluded", {
                        sessionId: 2,
                        target: "plurnk:///1/1/2",
                        result: { status: 200 },
                    });
                }, 5);
                return [{ status: 202, attrs: { pathname: "1/1/2", stream: "plurnk:///1/1/2" } }];
            }
            queueMicrotask(() => {
                emitEvent(1, "stream/concluded", {
                    sessionId: 2,
                    target: "sh:///1/1/1",
                    result: { status: 200 },
                });
            });
            return [{ status: 202, attrs: { pathname: "1/1/1", stream: "sh:///1/1/1" } }];
        },
    });

    const client = new Client({ name: "exec-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    t.after(() => client.close());

    // 1. Settled subprocess execution (`sh`)
    const shRes = await client.callTool({ name: "sh", arguments: { script: "echo build succeeded" } });
    assert.equal(shRes.isError, undefined);
    assert.equal((shRes.content[0] as { text: string }).text, "build succeeded\n");

    // 2. Settled Functionality execution (`env` -> `result` channel)
    mode = "settled-result-channel";
    const envRes = await client.callTool({ name: "env", arguments: { action: "list" } });
    assert.equal(envRes.isError, undefined);
    assert.equal((envRes.content[0] as { text: string }).text, '{"variables":[]}');

    // 3. Operation failure with recovery
    mode = "failed-op";
    const failedRes = await client.callTool({ name: "sh", arguments: { script: "bad" } });
    assert.equal(failedRes.isError, true);
    assert.equal(
        (failedRes.content[0] as { text: string }).text,
        "Invalid shell command.\nRecovery: Provide a non-empty script.",
    );
});

test("{§mcp-http-server} plurnk:///recent.json, resource templates (log:///, mcp:///plurnk/, workspace:///), and _meta.logCoordinate expose durable log and workspace inspection", async (t) => {
    const { baseUrl } = await createHarness(t, {
        logRows: [
            {
                id: 101,
                sessionId: 2,
                sessionName: "user",
                loopId: 1,
                loopSeq: 1,
                turnId: 1,
                turnSeq: 1,
                sequence: 1,
                op: "READ",
                tx: "src/index.ts",
                rx: "export const ok = true;\n",
                statusRx: 200,
                state: "resolved",
            },
            {
                id: 102,
                sessionId: 1,
                sessionName: "_plurnk",
                loopId: 2,
                loopSeq: 2,
                turnSeq: 1,
                sequence: 1,
                op: "NOTE",
                tx: null,
                rx: "saved note",
                statusRx: 200,
                state: "resolved",
            },
        ],
        entries: {
            "mcp:///plurnk/read.json": {
                entryId: null,
                target: "mcp:///plurnk/read.json",
                channels: {
                    body: makeChannel('{"name":"read","inputSchema":{"type":"object"}}', "static", "application/json"),
                },
            },
            "workspace:///src/index.ts": {
                entryId: null,
                target: "workspace:///src/index.ts",
                channels: {
                    body: makeChannel("export const ok = true;\n", "static", "text/plain"),
                },
            },
        },
        onDispatch: async (req) => {
            req.onLoop?.({ sessionId: 1, loopId: 2 });
            return [{ status: 200, content: "saved note" }];
        },
    });

    const client = new Client({ name: "resource-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    t.after(() => client.close());

    // 1. `log:///recent.json` stamps canonical `log:///...` coordinates on both session and runtime rows
    const recentRead = await client.readResource({ uri: "plurnk:///recent.json" });
    const recentJson = JSON.parse((recentRead.contents[0] as { text: string }).text) as {
        entries: Array<{ coordinate: string; op: string }>;
        runtimeEntries: Array<{ coordinate: string; op: string }>;
    };
    assert.equal(recentJson.entries.length, 1);
    assert.equal(recentJson.entries[0].coordinate, "log:///1/1/1/read");
    assert.equal(recentJson.runtimeEntries.length, 1);
    assert.equal(recentJson.runtimeEntries[0].coordinate, "log:///2/1/1/note");

    // 2. `log:///{loopSeq}/{turnSeq}/{sequence}/{op}` resolves session and fallback runtime rows by coordinate
    const logItemRead = await client.readResource({ uri: "log:///1/1/1/read" });
    const logItem = JSON.parse((logItemRead.contents[0] as { text: string }).text) as {
        coordinate: string;
        rx: string;
    };
    assert.equal(logItem.coordinate, "log:///1/1/1/read");
    assert.equal(logItem.rx, "export const ok = true;\n");

    const runtimeItemRead = await client.readResource({ uri: "log:///2/1/1/note" });
    const runtimeItem = JSON.parse((runtimeItemRead.contents[0] as { text: string }).text) as {
        coordinate: string;
        rx: string;
    };
    assert.equal(runtimeItem.coordinate, "log:///2/1/1/note");
    assert.equal(runtimeItem.rx, "saved note");

    // 3. `mcp:///plurnk/{tool}.json` and `workspace:///{+path}` templates
    const schemaRead = await client.readResource({ uri: "mcp:///plurnk/read.json" });
    assert.equal(JSON.parse((schemaRead.contents[0] as { text: string }).text).name, "read");

    const wsRead = await client.readResource({ uri: "workspace:///src/index.ts" });
    assert.equal((wsRead.contents[0] as { text: string }).text, "export const ok = true;\n");

    // 4. `tools/call` stamps `_meta.logCoordinate` when a durable log row is recorded
    const noteRes = await client.callTool({ name: "note", arguments: { text: "saved note" } });
    assert.equal(noteRes.isError, undefined);
    assert.equal((noteRes._meta as { logCoordinate?: string } | undefined)?.logCoordinate, "log:///2/1/1/note");
});

const waitForCondition = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 2_000,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            assert.fail(`Timed out waiting for ${label}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
};

test("{§mcp-http-server} server/discover advertises listChanged and subscribe capabilities and subscriptions/listen pushes daemon notifications", async (t) => {
    const { baseUrl, emitEvent } = await createHarness(t);

    const client = new Client(
        { name: "modern-listen-client", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    assert.equal(client.getProtocolEra(), "modern");
    const discovered = client.getDiscoverResult();
    assert.ok(discovered !== undefined);
    assert.equal(discovered.capabilities.tools?.listChanged, true);
    assert.equal(discovered.capabilities.resources?.subscribe, true);
    assert.equal(discovered.capabilities.resources?.listChanged, true);

    const received: Array<{ kind: string; uri?: string }> = [];
    client.setNotificationHandler("notifications/tools/list_changed", () => {
        received.push({ kind: "tools_list_changed" });
    });
    client.setNotificationHandler("notifications/resources/list_changed", () => {
        received.push({ kind: "resources_list_changed" });
    });
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
        received.push({ kind: "resource_updated", uri: notification.params.uri });
    });

    const sub = await client.listen({
        toolsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: [
            "plurnk:///status.json",
            "plurnk:///recent.json",
            "workspace:///notes.md",
        ],
    });
    t.after(async () => {
        await sub.close();
        await client.close();
    });
    assert.deepEqual(sub.honoredFilter, {
        toolsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: [
            "plurnk:///status.json",
            "plurnk:///recent.json",
            "workspace:///notes.md",
        ],
    });

    // 1. `functionality/changed` for `mcp` pushes `tools/list_changed` and `resources/list_changed`
    emitEvent(1, "functionality/changed", {
        workspaceId: 1,
        sessionId: null,
        family: "mcp",
    });
    await waitForCondition(
        () =>
            received.some((item) => item.kind === "tools_list_changed") &&
            received.some((item) => item.kind === "resources_list_changed"),
        "functionality/changed (mcp) notifications",
    );
    assert.deepEqual(received, [
        { kind: "tools_list_changed" },
        { kind: "resources_list_changed" },
    ]);
    received.length = 0;

    // 2. Second listener subscribing to `mcp:///plurnk.md`, `mcp:///plurnk.json`, and `mcp:///plurnk/<family>.json`
    const catalogUpdates: string[] = [];
    const catalogClient = new Client(
        { name: "catalog-listen-client", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
    );
    await catalogClient.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    catalogClient.setNotificationHandler("notifications/resources/updated", (notification) => {
        catalogUpdates.push(notification.params.uri);
    });
    const catalogSub = await catalogClient.listen({
        resourceSubscriptions: [
            "mcp:///plurnk.md",
            "mcp:///plurnk.json",
            "mcp:///plurnk/skills.json",
            "mcp:///plurnk/env.json",
        ],
    });
    t.after(async () => {
        await catalogSub.close();
        await catalogClient.close();
    });

    emitEvent(1, "functionality/changed", {
        workspaceId: 1,
        sessionId: null,
        family: "skills",
    });
    emitEvent(1, "functionality/changed", {
        workspaceId: 1,
        sessionId: 2,
        family: "env",
    });
    await waitForCondition(
        () => catalogUpdates.includes("mcp:///plurnk/env.json"),
        "catalog resource_updated notifications",
    );
    assert.deepEqual(catalogUpdates, [
        "mcp:///plurnk.md",
        "mcp:///plurnk.json",
        "mcp:///plurnk/skills.json",
        "mcp:///plurnk/env.json",
    ]);
    await waitForCondition(() => received.length === 3, "primary client skills+env list_changed");
    assert.deepEqual(received, [
        { kind: "tools_list_changed" },
        { kind: "resources_list_changed" },
        { kind: "resources_list_changed" },
    ]);
    received.length = 0;

    // 3. `log/entry` mutating `workspace:///notes.md` (and local project file `notes.md`) pushes log, status, workspace URI, and resources_list_changed
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    await waitForCondition(() => received.length === 4, "log/entry workspace:///notes.md notifications");
    assert.deepEqual(received, [
        { kind: "resource_updated", uri: "plurnk:///recent.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resource_updated", uri: "workspace:///notes.md" },
        { kind: "resources_list_changed" },
    ]);
    received.length = 0;

    // Local project file (`scheme: null`) edit also updates `workspace:///notes.md`, whereas failed (`statusRx >= 400`) or read-only ops only update log + session status
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: null,
            pathname: "notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 422,
            state: "failed",
        },
    });
    await waitForCondition(() => received.length === 6, "local + failed log/entry notifications");
    assert.deepEqual(received, [
        { kind: "resource_updated", uri: "plurnk:///recent.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resource_updated", uri: "workspace:///notes.md" },
        { kind: "resources_list_changed" },
        { kind: "resource_updated", uri: "plurnk:///recent.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
    ]);
    received.length = 0;

    // 4. `loop/started`, `loop/parked`, `loop/terminated`, session lifecycle, and session/gate updates push `plurnk:///status.json` and `resources_list_changed`
    emitEvent(1, "loop/started", {
        sessionId: 2,
        loopId: 1,
        loopSeq: 1,
    });
    emitEvent(1, "loop/parked", {
        sessionId: 2,
        loopId: 1,
        loopSeq: 1,
        status: 202,
    });
    emitEvent(1, "loop/terminated", {
        sessionId: 2,
        loopId: 1,
        result: { status: 200 },
    });
    emitEvent(1, "session/titled", {
        id: 2,
        title: "Investigate notifications",
    });
    emitEvent(1, "session/created", {
        id: 9,
        workspaceId: 1,
        name: "worker",
    });
    await waitForCondition(() => received.length === 5, "loop + session notifications");
    assert.deepEqual(received, [
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resource_updated", uri: "plurnk:///status.json" },
        { kind: "resources_list_changed" },
    ]);
});

test("{§mcp-http-server} subscriptions/listen enforces tenant isolation across workspaces and sessions", async (t) => {
    const { baseUrl, emitEvent } = await createHarness(t, {
        initialWorkspaces: [
            { id: 1, name: "ws-a", archived: false },
            { id: 2, name: "ws-b", archived: false },
        ],
        initialSessions: [
            { workspaceId: 1, id: 1, name: "_plurnk", origin: "system" },
            { workspaceId: 1, id: 2, name: "session-a", origin: "model" },
            { workspaceId: 1, id: 3, name: "session-b", origin: "model" },
            { workspaceId: 2, id: 4, name: "_plurnk", origin: "system" },
            { workspaceId: 2, id: 5, name: "session-a", origin: "model" },
        ],
    });

    const connectListener = async (route: string) => {
        const events: Array<{ kind: string; uri?: string }> = [];
        const client = new Client(
            { name: `listener-${route}`, version: "1.0.0" },
            { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${route}`)));
        client.setNotificationHandler("notifications/tools/list_changed", () => {
            events.push({ kind: "tools_list_changed" });
        });
        client.setNotificationHandler("notifications/resources/list_changed", () => {
            events.push({ kind: "resources_list_changed" });
        });
        client.setNotificationHandler("notifications/resources/updated", (notification) => {
            events.push({ kind: "resource_updated", uri: notification.params.uri });
        });
        const sub = await client.listen({
            toolsListChanged: true,
            resourcesListChanged: true,
            resourceSubscriptions: [
                "plurnk:///status.json",
                "plurnk:///recent.json",
                "workspace:///notes.md",
                "mcp:///plurnk/env.json",
            ],
        });
        t.after(async () => {
            await sub.close();
            await client.close();
        });
        return events;
    };

    const wsASessionA = await connectListener("/mcp/ws-a/session-a");
    const wsASessionB = await connectListener("/mcp/ws-a/session-b");
    const wsBSessionA = await connectListener("/mcp/ws-b/session-a");

    // 1. Events in workspace B never leak onto `/mcp/ws-a/session-a`
    emitEvent(2, "functionality/changed", { workspaceId: 2, sessionId: null, family: "mcp" });
    emitEvent(2, "log/entry", {
        entry: {
            sessionId: 5,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    emitEvent(2, "loop/terminated", { sessionId: 5, loopId: 77, result: { status: 200 } });
    emitEvent(2, "session/deleted", { id: 5, sessionIds: [5] });

    // 2. Session-scoped events in session B of workspace A never leak onto `/mcp/ws-a/session-a`
    emitEvent(1, "functionality/changed", { workspaceId: 1, sessionId: 3, family: "env" });
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 3,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    emitEvent(1, "session/policy", { sessionId: 3, model: null, childModel: null });
    emitEvent(1, "loop/proposal", { sessionId: 3, loopId: 88, logEntryId: 1 });
    emitEvent(1, "loop/interaction", { sessionId: 3, loopId: 88, interactionId: 1 });
    emitEvent(1, "loop/gate-settled", {
        kind: "interaction",
        sessionId: 3,
        loopId: 88,
        interactionId: 1,
        action: "accept",
    });
    emitEvent(1, "loop/terminated", { sessionId: 3, loopId: 88, result: { status: 200 } });

    await waitForCondition(() => wsBSessionA.length === 8, "workspace B listener notifications");
    await waitForCondition(() => wsASessionB.length === 11, "session B listener notifications");
    assert.deepEqual(wsASessionA, []);

    // 3. Sentinel event targeting `/mcp/ws-a/session-a` arrives cleanly on `wsASessionA` alone
    emitEvent(1, "loop/terminated", { sessionId: 2, loopId: 99, result: { status: 200 } });
    await waitForCondition(() => wsASessionA.length === 1, "ws-a/session-a sentinel notification");
    assert.deepEqual(wsASessionA, [{ kind: "resource_updated", uri: "plurnk:///status.json" }]);
    assert.equal(wsASessionB.length, 11);
    assert.equal(wsBSessionA.length, 8);
});

test("{§mcp-http-server} resources/read throws JSON-RPC protocol errors on missing or refused entries and emits base64 blob contents for binary mimetypes", async (t) => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngBase64 = pngBytes.toString("base64");
    const binBase64 = Buffer.from([0x00, 0xff, 0x42]).toString("base64");
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

    const { baseUrl } = await createHarness(t, {
        logRows: [
            {
                id: 1,
                sessionId: 2,
                loopSeq: 1,
                turnSeq: 1,
                sequence: 1,
                op: "READ",
                rx: "ok",
                statusRx: 200,
                state: "resolved",
            },
        ],
        entries: {
            "workspace:///assets/logo.png": {
                entryId: 10,
                target: "workspace:///assets/logo.png",
                channels: {
                    body: makeChannel(pngBase64, "static", "image/png"),
                },
            },
            "workspace:///assets/raw.bin": {
                entryId: 11,
                target: "workspace:///assets/raw.bin",
                channels: {
                    body: makeChannel(binBase64, "static", "application/octet-stream"),
                },
            },
            "workspace:///assets/icon.svg": {
                entryId: 12,
                target: "workspace:///assets/icon.svg",
                channels: {
                    body: makeChannel(svgText, "static", "image/svg+xml"),
                },
            },
        },
        entryFailures: {
            "workspace:///forbidden.txt": { status: 403, detail: "Path is outside workspace membership." },
            "workspace:///oversized.bin": { status: 413, detail: "Entry exceeds maximum materialization size." },
            "workspace:///invalid..path": { status: 400, detail: "Workspace entry path is invalid." },
            "workspace:///broken.txt": { status: 500, detail: "Storage read failed." },
        },
    });

    const client = new Client(
        { name: "resource-error-blob-client", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    t.after(() => client.close());

    // 1. Missing workspace, tool schema, and log coordinates reject as ResourceNotFoundError (never 200 error text)
    for (const missingUri of [
        "workspace:///missing.ts",
        "mcp:///plurnk/nonexistent.json",
        "log:///99/1/1/read",
        "log:///1/1/1/edit",
    ]) {
        await assert.rejects(
            () => client.readResource({ uri: missingUri }),
            (err: unknown) => {
                assert.ok(err instanceof ResourceNotFoundError, `expected ResourceNotFoundError for ${missingUri}`);
                assert.equal(err.uri, missingUri);
                return true;
            },
        );
    }

    // 2. 400 / 403 / 413 failures reject with InvalidParams (-32602) carrying problem.detail; 500 rejects with InternalError (-32603)
    for (const [uri, expectedStatus, expectedDetail] of [
        ["workspace:///invalid..path", 400, "Workspace entry path is invalid."],
        ["workspace:///forbidden.txt", 403, "Path is outside workspace membership."],
        ["workspace:///oversized.bin", 413, "Entry exceeds maximum materialization size."],
    ] as const) {
        await assert.rejects(
            () => client.readResource({ uri }),
            (err: unknown) => {
                assert.ok(err instanceof ProtocolError);
                assert.equal(err.code, ProtocolErrorCode.InvalidParams);
                assert.match(err.message, new RegExp(expectedDetail.replaceAll(".", "\\."), "u"));
                assert.equal((err.data as { status?: number } | undefined)?.status, expectedStatus);
                return true;
            },
        );
    }

    await assert.rejects(
        () => client.readResource({ uri: "workspace:///broken.txt" }),
        (err: unknown) => {
            assert.ok(err instanceof ProtocolError);
            assert.equal(err.code, ProtocolErrorCode.InternalError);
            assert.match(err.message, /Storage read failed\./u);
            return true;
        },
    );

    await assert.rejects(
        () => client.readResource({ uri: "log:///not-a-number/1/1/read" }),
        (err: unknown) => {
            assert.ok(err instanceof ProtocolError);
            assert.equal(err.code, ProtocolErrorCode.InvalidParams);
            return true;
        },
    );

    // 3. Binary channels emit `{ uri, mimeType, blob }`; structured +xml text channels emit `{ uri, mimeType, text }`
    const pngRead = await client.readResource({ uri: "workspace:///assets/logo.png" });
    assert.deepEqual(pngRead.contents, [
        {
            uri: "workspace:///assets/logo.png",
            mimeType: "image/png",
            blob: pngBase64,
        },
    ]);

    const binRead = await client.readResource({ uri: "workspace:///assets/raw.bin" });
    assert.deepEqual(binRead.contents, [
        {
            uri: "workspace:///assets/raw.bin",
            mimeType: "application/octet-stream",
            blob: binBase64,
        },
    ]);

    const svgRead = await client.readResource({ uri: "workspace:///assets/icon.svg" });
    assert.deepEqual(svgRead.contents, [
        {
            uri: "workspace:///assets/icon.svg",
            mimeType: "image/svg+xml",
            text: svgText,
        },
    ]);
});

test("{§mcp-http-server} workspace ProposalPolicy gates host-effecting tools/call under reject and review while non-MCP probes never auto-create workspaces", async (t) => {
    const { baseUrl, dispatched, workspaces, sessions, setProposalPolicy } = await createHarness(t, {
        proposalPolicy: "reject",
        auth: {
            tokens: {
                "mcp-token": { subject: "alice", scopes: ["openid"] },
            },
        },
        catalogTools: [
            {
                name: "note",
                description: "Update session notes.",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                },
            },
            {
                name: "read",
                description: "Read a file or resource.",
                inputSchema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                    additionalProperties: false,
                },
            },
            {
                name: "edit",
                description: "Edit a file or entry.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        range: { type: "string" },
                        content: { type: "string" },
                    },
                    required: ["path", "content"],
                    additionalProperties: false,
                },
            },
            {
                name: "sh",
                description: "Execute a POSIX shell script.",
                inputSchema: {
                    type: "object",
                    properties: { script: { type: "string" } },
                    required: ["script"],
                    additionalProperties: false,
                },
            },
            {
                name: "env",
                description: "Manage workspace environment variables.",
                inputSchema: {
                    type: "object",
                    properties: {
                        action: { type: "string" },
                        name: { type: "string" },
                        value: { type: "string" },
                    },
                    additionalProperties: true,
                },
            },
        ],
        openStreams: [
            { target: "sh:///1/1/1", channels: [{ name: "stdout", state: "active" }] },
            { target: "plurnk:///1/1/2", channels: [{ name: "result", state: "active" }] },
        ],
        entries: {
            "sh:///1/1/1": {
                entryId: 1,
                target: "sh:///1/1/1",
                channels: { stdout: makeChannel("ran under accept\n", "closed") },
            },
            "plurnk:///1/1/2": {
                entryId: 2,
                target: "plurnk:///1/1/2",
                channels: { result: makeChannel('{"variables":[]}', "closed", "application/json") },
            },
        },
        onDispatch: async (req) => {
            req.onLoop?.({ sessionId: 1, loopId: 1 });
            const stmt = req.statements[0];
            if ("runtime" in stmt && stmt.runtime === "sh") {
                return [{ status: 200, content: "ran under accept\n" }];
            }
            if ("runtime" in stmt && stmt.runtime === "plurnk") {
                return [{ status: 200, content: '{"variables":[]}' }];
            }
            if ("op" in stmt && stmt.op === "note") {
                return [{ status: 200, content: stmt.body ?? "" }];
            }
            if ("op" in stmt && stmt.op === "read") {
                return [{ status: 200, content: `read:${stmt.target?.raw ?? ""}` }];
            }
            return [{ status: 200, content: "edited" }];
        },
    });

    // 1. Arbitrary GET / DELETE / PUT / malformed POST / unknown-method probes never auto-create workspaces or sessions
    const authHeaders = { Authorization: "Bearer mcp-token" };
    const getProbe = await fetch(`${baseUrl}/mcp/ghost-get/ghost-sess`, { method: "GET", headers: authHeaders });
    assert.equal(getProbe.status, 405);
    const deleteProbe = await fetch(`${baseUrl}/mcp/ghost-del/ghost-sess`, { method: "DELETE", headers: authHeaders });
    assert.equal(deleteProbe.status, 405);
    const putProbe = await fetch(`${baseUrl}/mcp/ghost-put`, { method: "PUT", headers: authHeaders });
    assert.equal(putProbe.status, 405);
    const badJsonProbe = await fetch(`${baseUrl}/mcp/ghost-json`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: "{not-json",
    });
    assert.equal(badJsonProbe.status, 404);
    const unknownMethodProbe = await fetch(`${baseUrl}/mcp/ghost-rpc`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown/probe", params: {} }),
    });
    assert.equal(unknownMethodProbe.status, 404);
    assert.deepEqual(
        [...workspaces.values()].map((w) => w.name),
        ["default"],
        "non-MCP HTTP probes never allocate workspaces",
    );
    assert.equal(sessions.size, 2, "non-MCP HTTP probes never allocate sessions");

    const client = new Client({ name: "policy-client", version: "1.0.0" });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
            requestInit: { headers: authHeaders },
        }),
    );
    t.after(() => client.close());

    // 2. Under `reject`, host-effecting `sh`, disk `edit`, and mutating `env` are refused before dispatch
    for (const call of [
        { name: "sh", arguments: { script: "rm -rf /tmp/x" } },
        { name: "edit", arguments: { path: "src/index.ts", range: "1,-1", content: "pwned\n" } },
        { name: "env", arguments: { action: "add", name: "FOO", value: "bar" } },
    ]) {
        const res = await client.callTool(call);
        assert.equal(res.isError, true);
        assert.match((res.content[0] as { text: string }).text, /policy 'reject' forbids host-effecting tool/u);
    }
    assert.equal(dispatched.length, 0, "rejected host-effecting calls never reach dispatchClientAction");

    // Read-only, pure, and in-database `workspace:///` operations remain permitted under `reject`
    const readRes = await client.callTool({ name: "read", arguments: { path: "src/index.ts" } });
    assert.equal(readRes.isError, undefined);
    const noteRes = await client.callTool({ name: "note", arguments: { text: "safe note" } });
    assert.equal(noteRes.isError, undefined);
    const envListRes = await client.callTool({ name: "env", arguments: { action: "list" } });
    assert.equal(envListRes.isError, undefined);
    const wsEditRes = await client.callTool({
        name: "edit",
        arguments: { path: "workspace:///scratch.md", range: "1,-1", content: "scratch\n" },
    });
    assert.equal(wsEditRes.isError, undefined);
    assert.equal(dispatched.length, 4);

    // 3. Under `review`, host-effecting calls are also refused instead of bypassing review as client_operation
    setProposalPolicy("review");
    dispatched.length = 0;
    const reviewSh = await client.callTool({ name: "sh", arguments: { script: "echo unsafe" } });
    assert.equal(reviewSh.isError, true);
    assert.match((reviewSh.content[0] as { text: string }).text, /policy 'review' requires interactive approval/u);
    const reviewEdit = await client.callTool({
        name: "edit",
        arguments: { path: "src/index.ts", range: "1,-1", content: "unsafe\n" },
    });
    assert.equal(reviewEdit.isError, true);
    assert.equal(dispatched.length, 0);

    // 4. Switching workspace policy to `accept` admits host-effecting calls
    setProposalPolicy("accept");
    const acceptSh = await client.callTool({ name: "sh", arguments: { script: "echo ok" } });
    assert.equal(acceptSh.isError, undefined);
    assert.equal((acceptSh.content[0] as { text: string }).text, "ran under accept\n");
    const acceptEdit = await client.callTool({
        name: "edit",
        arguments: { path: "src/index.ts", range: "1,-1", content: "safe\n" },
    });
    assert.equal(acceptEdit.isError, undefined);
    assert.equal(dispatched.length, 2);
});

test("{§mcp-http-server} {§mcp-configuration} standard 2025-06-18 clients interoperate via ping, resources/subscribe, resources/unsubscribe, stateful SSE, and PLURNK_MCP_ALLOW_ORIGIN CORS", async (t) => {
    const { baseUrl, emitEvent } = await createHarness(t, {
        auth: {
            tokens: {
                "valid-mcp": { subject: "alice", scopes: ["openid"] },
            },
        },
    });

    // 1. Unauthenticated OPTIONS preflight succeeds with 204 and exposes Mcp-Session-Id + requested Mcp-Param-* headers
    const preflight = await fetch(`${baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: {
            Origin: "http://localhost:6274",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type, mcp-session-id, mcp-param-workspace",
        },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-session-id/u);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-param-workspace/u);
    assert.equal(preflight.headers.get("access-control-expose-headers"), "Mcp-Session-Id");

    // 401 responses also carry CORS headers so browser Inspector clients can read WWW-Authenticate / Problem JSON
    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");

    // 2. Standard 2025-era Client (legacy handshake) negotiates Mcp-Session-Id, pings, subscribes/unsubscribes, and receives GET SSE updates
    const legacyClient = new Client({ name: "cursor-like-client", version: "1.0.0" });
    const legacyTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer valid-mcp" } },
    });
    await legacyClient.connect(legacyTransport);
    t.after(() => legacyClient.close());

    assert.equal(legacyClient.getProtocolEra(), "legacy");
    assert.ok(typeof legacyTransport.sessionId === "string" && legacyTransport.sessionId.length > 0);
    const activeSessionId = legacyTransport.sessionId;

    await legacyClient.ping();

    const updatedUris: string[] = [];
    legacyClient.setNotificationHandler("notifications/resources/updated", (notification) => {
        updatedUris.push(notification.params.uri);
    });

    await legacyClient.subscribeResource({ uri: "workspace:///notes.md" });
    await assert.rejects(
        () => legacyClient.subscribeResource({ uri: "unknown:///missing" }),
        (err: unknown) => err instanceof ResourceNotFoundError,
    );

    // Wait briefly so the standalone GET SSE stream opened after `notifications/initialized` is established
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: "workspace",
            pathname: "/other.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    await waitForCondition(() => updatedUris.includes("workspace:///notes.md"), "2025 GET SSE resource_updated");
    assert.deepEqual(updatedUris, ["workspace:///notes.md"], "only subscribed URIs fire notifications/resources/updated");

    // Unsubscribe stops further notifications for that URI
    updatedUris.length = 0;
    await legacyClient.unsubscribeResource({ uri: "workspace:///notes.md" });
    emitEvent(1, "log/entry", {
        entry: {
            sessionId: 2,
            op: "edit",
            scheme: "workspace",
            pathname: "/notes.md",
            statusRx: 200,
            state: "resolved",
        },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(updatedUris, []);

    // DELETE /mcp terminates the session; reusing its Mcp-Session-Id returns 404 (-32001)
    await legacyTransport.terminateSession();
    const afterDelete = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            Authorization: "Bearer valid-mcp",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": activeSessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    });
    assert.equal(afterDelete.status, 404);
    assert.equal(((await afterDelete.json()) as { error: { code: number } }).error.code, -32_001);

    // 3. Explicit origin and empty PLURNK_MCP_ALLOW_ORIGIN="" behave identically to PLURNK_ACP_ALLOW_ORIGIN
    await t.test("{§mcp-http-server} {§mcp-configuration} explicit origin restricts Access-Control-Allow-Origin and empty value omits CORS headers", async (subT) => {
        const pinned = await createHarness(subT, { allowOrigin: "https://inspector.example" });
        const pinnedOpt = await fetch(`${pinned.baseUrl}/mcp`, { method: "OPTIONS" });
        assert.equal(pinnedOpt.status, 204);
        assert.equal(pinnedOpt.headers.get("access-control-allow-origin"), "https://inspector.example");
        assert.equal(pinnedOpt.headers.get("access-control-expose-headers"), "Mcp-Session-Id");

        const disabled = await createHarness(subT, { allowOrigin: "" });
        const disabledOpt = await fetch(`${disabled.baseUrl}/mcp`, { method: "OPTIONS" });
        assert.equal(disabledOpt.status, 204);
        assert.equal(disabledOpt.headers.get("access-control-allow-origin"), null);
        assert.equal(disabledOpt.headers.get("access-control-expose-headers"), null);
    });
});

test("{§mcp-http-server} caches compiled tool schemas across stateless requests and refreshes immediately when mcp:///plurnk.json changes", async (t) => {
    const { baseUrl, setCatalogTools, emitEvent } = await createHarness(t, {
        catalogTools: [
            {
                name: "note",
                description: "Initial note tool.",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                },
            },
        ],
    });

    const seenSchemas: JsonSchema[] = [];
    const origValidate = Validator.validateJsonSchemaInstance.bind(Validator);
    t.mock.method(Validator, "validateJsonSchemaInstance", (schema: JsonSchema, value: unknown) => {
        seenSchemas.push(schema);
        return origValidate(schema, value);
    });

    const connectModern = async (routePath: string): Promise<Client> => {
        const client = new Client(
            { name: "modern-cache-client", version: "1.0.0" },
            { versionNegotiation: { mode: "auto" } },
        );
        await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${routePath}`)));
        t.after(() => client.close());
        assert.equal(client.getProtocolEra(), "modern");
        return client;
    };

    const defaultClient = await connectModern("/mcp");
    const secondaryClient = await connectModern("/mcp/default/secondary");

    // 1. Repeated stateless calls against the same (workspaceId, sessionId) reuse the exact compiled schema object
    seenSchemas.length = 0;
    const firstCall = await defaultClient.callTool({ name: "note", arguments: { text: "first" } });
    assert.equal(firstCall.isError, undefined);
    const secondCall = await defaultClient.callTool({ name: "note", arguments: { text: "second" } });
    assert.equal(secondCall.isError, undefined);
    assert.equal(seenSchemas.length, 2);
    const initialSchema = seenSchemas[0];
    assert.equal(seenSchemas[1], initialSchema, "unchanged mcp:///plurnk.json reuses cached compiled schema");

    // 2. Another session caches independently per (workspaceId, sessionId) and reuses its own compiled entry
    seenSchemas.length = 0;
    await secondaryClient.callTool({ name: "note", arguments: { text: "s1" } });
    await secondaryClient.callTool({ name: "note", arguments: { text: "s2" } });
    assert.equal(seenSchemas.length, 2);
    assert.equal(seenSchemas[1], seenSchemas[0]);

    // 3. Updating mcp:///plurnk.json immediately recompiles schemas and refreshes tools/list without stale state
    setCatalogTools([
        {
            name: "note",
            description: "Updated note tool.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string" },
                    tag: { type: "string" },
                },
                required: ["text"],
                additionalProperties: false,
            },
        },
        {
            name: "read",
            description: "Newly added read tool.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
            },
        },
    ]);

    const { tools: refreshedTools } = await defaultClient.listTools();
    assert.deepEqual(
        refreshedTools.map((tool) => ({ name: tool.name, description: tool.description })),
        [
            { name: "note", description: "Updated note tool." },
            { name: "read", description: "Newly added read tool." },
        ],
    );

    seenSchemas.length = 0;
    await defaultClient.callTool({ name: "note", arguments: { text: "third" } });
    await defaultClient.callTool({ name: "note", arguments: { text: "fourth" } });
    assert.equal(seenSchemas.length, 2);
    assert.notEqual(seenSchemas[0], initialSchema, "changed mcp:///plurnk.json compiles fresh schema");
    assert.equal(seenSchemas[1], seenSchemas[0], "subsequent calls reuse newly compiled schema");

    // 4. functionality/changed for mcp invalidates cached entries for that workspace
    const beforeInvalidation = seenSchemas[0];
    emitEvent(1, "functionality/changed", { family: "mcp", sessionId: null });
    seenSchemas.length = 0;
    await defaultClient.callTool({ name: "note", arguments: { text: "fifth" } });
    assert.equal(seenSchemas.length, 1);
    assert.notEqual(seenSchemas[0], beforeInvalidation, "functionality/changed invalidates cached compiled schema");
});

test("{§mcp-http-server} external /mcp send exposes optional actor, honors loopback multiplexing, and enforces OIDC subject authority (#1548)", async (t) => {
    const sendCatalog = [
        {
            name: "send",
            description: "Send a message.",
            inputSchema: {
                type: "object",
                properties: {
                    target: { type: "string" },
                    text: { type: "string" },
                },
                required: ["text"],
                additionalProperties: false,
            },
        },
    ];

    // 1. Loopback (unauthenticated): exposes actor on send schema, honors valid actor, rejects invalid actor
    const loopback = await createHarness(t, { catalogTools: sendCatalog });
    const loopbackClient = new Client({ name: "mcp-actor-loopback", version: "1.0.0" });
    await loopbackClient.connect(new StreamableHTTPClientTransport(new URL(`${loopback.baseUrl}/mcp`)));
    t.after(() => loopbackClient.close());

    const listed = await loopbackClient.listTools();
    const sendTool = listed.tools.find((tool) => tool.name === "send");
    assert.ok(sendTool, "send tool advertised");
    assert.ok(
        sendTool.inputSchema &&
            typeof sendTool.inputSchema === "object" &&
            "properties" in sendTool.inputSchema &&
            "actor" in (sendTool.inputSchema.properties as Record<string, unknown>),
        "external /mcp send tool exposes optional actor property",
    );

    const defaultSend = await loopbackClient.callTool({
        name: "send",
        arguments: { target: "session://worker", text: "Hello default" },
    });
    assert.equal(defaultSend.isError, undefined);
    assert.equal(loopback.dispatched.at(-1)?.actor, "mcp:///owner");
    const defaultStmt = loopback.dispatched.at(-1)?.statements[0];
    assert.equal(defaultStmt?.op, "send");
    assert.equal(defaultStmt?.op === "send" ? (defaultStmt.actor ?? null) : "unexpected", null);

    const multiplexedSend = await loopbackClient.callTool({
        name: "send",
        arguments: { target: "session://worker", actor: "hazool17", text: "Hello from hazool17" },
    });
    assert.equal(multiplexedSend.isError, undefined);
    assert.equal(loopback.dispatched.at(-1)?.actor, "mcp:///owner");
    const multiplexedStmt = loopback.dispatched.at(-1)?.statements[0];
    assert.equal(multiplexedStmt?.op === "send" ? multiplexedStmt.actor : undefined, "hazool17");

    const structuredSend = await loopbackClient.callTool({
        name: "send",
        arguments: {
            target: "session://worker",
            actor: { id: "U123", handle: "alice", name: "Alice Smith" },
            text: "Hello from structured Alice",
        },
    });
    assert.equal(structuredSend.isError, undefined);
    const structuredStmt = loopback.dispatched.at(-1)?.statements[0];
    assert.deepEqual(structuredStmt?.op === "send" ? structuredStmt.actor : undefined, {
        id: "U123",
        handle: "alice",
        name: "Alice Smith",
    });

    const beforeInvalidCount = loopback.dispatched.length;
    for (const badActor of ["_plurnk", "session://worker", "mcp://bridge/extra"]) {
        const badRes = await loopbackClient.callTool({
            name: "send",
            arguments: { target: "session://worker", actor: badActor, text: "bad" },
        });
        assert.equal(badRes.isError, true, `rejects invalid actor ${JSON.stringify(badActor)}`);
        assert.match((badRes.content[0] as { text: string }).text, /actor-invalid/u);
    }
    const emptyActorRes = await loopbackClient.callTool({
        name: "send",
        arguments: { target: "session://worker", actor: "", text: "bad" },
    });
    assert.equal(emptyActorRes.isError, true);
    assert.match((emptyActorRes.content[0] as { text: string }).text, /non-empty string/u);
    assert.equal(loopback.dispatched.length, beforeInvalidCount, "invalid actors never dispatch");

    // 2. OIDC active: attributes caller to mcp://<subject>, enriches profile handle/name, admits matching actor & delegates, refuses mismatched actor
    const authed = await createHarness(t, {
        catalogTools: sendCatalog,
        auth: {
            tokens: {
                "scout-token": { subject: "auth0|507f1f77", handle: "alice", name: "Alice Smith" },
                "delegate-token": { subject: "plurnkbot", canDelegateActor: true },
            },
        },
    });
    const authedClient = new Client({ name: "mcp-actor-oidc", version: "1.0.0" });
    await authedClient.connect(
        new StreamableHTTPClientTransport(new URL(`${authed.baseUrl}/mcp`), {
            requestInit: { headers: { Authorization: "Bearer scout-token" } },
        }),
    );
    t.after(() => authedClient.close());

    const implicitSelf = await authedClient.callTool({
        name: "send",
        arguments: { target: "session://worker", text: "Implicit self" },
    });
    assert.equal(implicitSelf.isError, undefined);
    assert.equal(authed.dispatched.at(-1)?.actor, "mcp://auth0%7C507f1f77");
    const implicitStmt = authed.dispatched.at(-1)?.statements[0];
    assert.deepEqual(implicitStmt?.op === "send" ? implicitStmt.actor : undefined, {
        id: "auth0|507f1f77",
        handle: "alice",
        name: "Alice Smith",
    });

    const explicitSelf = await authedClient.callTool({
        name: "send",
        arguments: { target: "session://worker", actor: "mcp://auth0%7C507f1f77", text: "Explicit self" },
    });
    assert.equal(explicitSelf.isError, undefined);
    assert.equal(authed.dispatched.at(-1)?.actor, "mcp://auth0%7C507f1f77");
    const explicitStmt = authed.dispatched.at(-1)?.statements[0];
    assert.deepEqual(explicitStmt?.op === "send" ? explicitStmt.actor : undefined, {
        id: "auth0|507f1f77",
        handle: "alice",
        name: "Alice Smith",
    });

    const beforeSpoofCount = authed.dispatched.length;
    const spoofed = await authedClient.callTool({
        name: "send",
        arguments: { target: "session://worker", actor: "hazool17", text: "Spoofed" },
    });
    assert.equal(spoofed.isError, true);
    assert.match((spoofed.content[0] as { text: string }).text, /actor-not-authorized/u);
    assert.equal(authed.dispatched.length, beforeSpoofCount, "spoofed OIDC actor never dispatches");

    const delegateClient = new Client({ name: "mcp-actor-delegate", version: "1.0.0" });
    await delegateClient.connect(
        new StreamableHTTPClientTransport(new URL(`${authed.baseUrl}/mcp`), {
            requestInit: { headers: { Authorization: "Bearer delegate-token" } },
        }),
    );
    t.after(() => delegateClient.close());
    const delegatedSend = await delegateClient.callTool({
        name: "send",
        arguments: {
            target: "session://worker",
            actor: { id: "tg:99", handle: "bob", name: "Bob" },
            text: "Bridged over MCP",
        },
    });
    assert.equal(delegatedSend.isError, undefined);
    const delegatedStmt = authed.dispatched.at(-1)?.statements[0];
    assert.deepEqual(delegatedStmt?.op === "send" ? delegatedStmt.actor : undefined, {
        id: "tg:99",
        handle: "bob",
        name: "Bob",
    });
});
