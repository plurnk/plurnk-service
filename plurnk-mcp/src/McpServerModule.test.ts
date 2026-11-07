import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Problems, type CredentialAuthority, type EntryReadResult } from "@plurnk/plurnk-contracts";
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
        readonly tokens: Readonly<Record<string, { readonly kind: "access" | "refresh"; readonly scopes: readonly string[]; readonly family: string }>>;
    };
    readonly initialWorkspaces?: ReadonlyArray<{ readonly id: number; readonly name: string; readonly archived?: boolean }>;
    readonly initialSessions?: ReadonlyArray<{ readonly workspaceId: number; readonly id: number; readonly name: string; readonly origin: "model" | "system" }>;
    readonly catalogTools?: ReadonlyArray<Record<string, unknown>>;
    readonly docsMarkdown?: string;
    readonly onDispatch?: (req: Parameters<ApplicationPort["dispatchClientAction"]>[0]) => Promise<ReadonlyArray<Record<string, unknown>>>;
    readonly entries?: Readonly<Record<string, EntryReadResult["entry"]>>;
    readonly openStreams?: ReadonlyArray<{ readonly target: string; readonly channels: ReadonlyArray<{ readonly name: string; readonly state: "active" | "completed" | "errored" }> }>;
    readonly logRows?: ReadonlyArray<Record<string, unknown>>;
}

const createHarness = async (t: TestContext, options: FakeHarnessOptions = {}) => {
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

    const eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();
    const revokedListeners = new Set<(family: string) => void>();
    const cancelledLoops: Array<{ workspaceId: number; loopId: number; reason: string }> = [];
    const dispatched: Array<Parameters<ApplicationPort["dispatchClientAction"]>[0]> = [];
    let routeHandler: HttpRouteHandler | null = null;

    const catalogJson = JSON.stringify({
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

    const credentials = {
        enabled: options.auth !== undefined,
        face: () =>
            options.auth === undefined
                ? null
                : {
                      issuer: (req?: { readonly headers: Readonly<Record<string, unknown>> }) =>
                          `http://${typeof req?.headers.host === "string" ? req.headers.host : "127.0.0.1"}`,
                  },
        verify: (token: string) => {
            const found = options.auth?.tokens[token];
            if (found === undefined) return null;
            return {
                kind: found.kind,
                subject: "test-subject",
                clientId: "test-client",
                scopes: [...found.scopes],
                family: found.family,
                expiresAt: Date.now() + 60_000,
            };
        },
        onRevoked: (cb: (family: string) => void) => {
            revokedListeners.add(cb);
            return () => {
                revokedListeners.delete(cb);
            };
        },
    } as unknown as CredentialAuthority;

    const notFoundWorkspace = (detail: string): Error => {
        const err = new Error(detail);
        Object.assign(err, {
            problem: Problems.create("engine:workspace", "workspace-not-found", 404, detail, {
                code: "engine/workspace/workspace-not-found",
            }),
        });
        return err;
    };

    const seam = {
        credentials,
        registerHttpRoute: (prefix: string, handler: HttpRouteHandler) => {
            assert.equal(prefix, "/mcp");
            routeHandler = handler;
        },
        subscribeToEvents: (cb: (workspaceId: number | null, method: string, params: unknown) => void) => {
            eventSubscribers.add(cb);
            return () => eventSubscribers.delete(cb);
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
                if (req.sessionId !== undefined && row.session_id !== undefined && row.session_id !== req.sessionId) {
                    return false;
                }
                if (req.loopSeq !== undefined && row.loop_seq !== req.loopSeq) return false;
                if (req.turnSeq !== undefined && row.turn_seq !== req.turnSeq) return false;
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

    const mod = McpServerModule.create();
    mod.start(seam);

    const server = createServer((req, res) => {
        assert.notEqual(routeHandler, null);
        void routeHandler!(req, res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    t.after(async () => {
        await mod.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const emitEvent = (workspaceId: number | null, method: string, params: unknown): void => {
        for (const sub of eventSubscribers) sub(workspaceId, method, params);
    };
    const revokeFamily = (family: string): void => {
        for (const sub of revokedListeners) sub(family);
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
        revokeFamily,
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
            "session:///status.json",
            "log:///recent.json",
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

    const statusRead = await clientDefault.readResource({ uri: "session:///status.json" });
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

test("{§mcp-http-server} credential authority enforces bearer tokens, scopes, and family revocation", async (t) => {
    const { baseUrl, revokeFamily } = await createHarness(t, {
        auth: {
            tokens: {
                "valid-mcp": { kind: "access", scopes: ["mcp"], family: "fam-1" },
                "valid-acp": { kind: "access", scopes: ["acp"], family: "fam-2" },
                "refresh-only": { kind: "refresh", scopes: ["mcp"], family: "fam-3" },
                "wrong-scope": { kind: "access", scopes: ["other"], family: "fam-4" },
            },
        },
    });

    // 1. Missing token -> 401 bearer-token-required
    const noToken = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get("www-authenticate") ?? "", /Bearer realm="plurnk"/u);
    assert.equal(((await noToken.json()) as { code: string }).code, "mcp/http/bearer-token-required");

    // 2. Unknown or refresh token -> 401 bearer-token-invalid
    for (const bad of ["unknown", "refresh-only"]) {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${bad}` },
            body: "{}",
        });
        assert.equal(res.status, 401);
        assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/u);
        assert.equal(((await res.json()) as { code: string }).code, "mcp/http/bearer-token-invalid");
    }

    // 3. Insufficient scope -> 403 bearer-scope-insufficient
    const badScope = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-scope" },
        body: "{}",
    });
    assert.equal(badScope.status, 403);
    assert.match(badScope.headers.get("www-authenticate") ?? "", /error="insufficient_scope", scope="mcp"/u);
    assert.equal(((await badScope.json()) as { code: string }).code, "mcp/http/bearer-scope-insufficient");

    // 4. Valid `mcp` token connects and lists tools
    const client = new Client({ name: "auth-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer valid-mcp" } },
    });
    await client.connect(transport);
    t.after(() => client.close());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);

    revokeFamily("fam-1");
});

test("{§mcp-http-server} execution verbs settle via stream/concluded, support detached mode, and surface errors", async (t) => {
    let mode: "settled-sh" | "settled-result-channel" | "detached" | "failed-op" = "settled-sh";
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
            if (mode === "detached") {
                return [{ status: 202, attrs: { pathname: "1/1/1", stream: "sh:///1/1/1", detached: true } }];
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

    // 3. Detached subprocess execution
    mode = "detached";
    const detachedRes = await client.callTool({ name: "sh", arguments: { script: "sleep 10", detached: true } });
    assert.equal(detachedRes.isError, undefined);
    assert.deepEqual(JSON.parse((detachedRes.content[0] as { text: string }).text), {
        status: 202,
        outcome: "started",
        stream: "sh:///1/1/1",
    });

    // 4. Operation failure with recovery
    mode = "failed-op";
    const failedRes = await client.callTool({ name: "sh", arguments: { script: "bad" } });
    assert.equal(failedRes.isError, true);
    assert.equal(
        (failedRes.content[0] as { text: string }).text,
        "Invalid shell command.\nRecovery: Provide a non-empty script.",
    );
});

test("{§mcp-http-server} log:///recent.json, resource templates (log:///, mcp:///plurnk/, workspace:///), and _meta.logCoordinate expose durable log and workspace inspection", async (t) => {
    const { baseUrl } = await createHarness(t, {
        logRows: [
            {
                id: 101,
                session_id: 2,
                session_name: "user",
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 1,
                op: "READ",
                tx: "src/index.ts",
                rx: "export const ok = true;\n",
                status_rx: 200,
                state: "resolved",
            },
            {
                id: 102,
                session_id: 1,
                session_name: "_plurnk",
                loop_id: 2,
                loop_seq: 2,
                turn_seq: 1,
                sequence: 1,
                op: "NOTE",
                tx: null,
                rx: "saved note",
                status_rx: 200,
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
    const recentRead = await client.readResource({ uri: "log:///recent.json" });
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
