import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    McpServer,
    createMcpHandler,
    type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { McpServerDefinition } from "@plurnk/plurnk-contracts";
import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import type McpExecutor from "./McpExecutor.ts";
import type McpResources from "./McpResources.ts";
import Module, { closeConnections } from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const legacyFixture = fileURLToPath(new URL("./fixtures/legacy-server.mjs", import.meta.url));
const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};

interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: McpExecutor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: McpResources;
}

type ActionContext =
    | { readonly scope: "worldless" }
    | { readonly scope: "workspace"; readonly workspaceId: number };

interface ActionRegistration {
    readonly name: string;
    readonly scope: "worldless" | "workspace";
    readonly handler: (
        params: Readonly<Record<string, unknown>>,
        context: ActionContext,
    ) => unknown | Promise<unknown>;
}

const harness = (durable = new Map<number, unknown | null>()) => {
    const actions = new Map<string, ActionRegistration>();
    const snapshots = new Map<number, readonly RuntimeRegistration[]>();
    let provider: { hydrate(workspaceId: number): void | Promise<void> } | undefined;
    let replacementCalls = 0;
    const seam = {
        registerModuleAction: (registration: ActionRegistration): void => {
            actions.set(registration.name, registration);
        },
        registerWorkspaceCapabilityProvider: (
            namespaceOwner: string,
            candidate: { hydrate(workspaceId: number): void | Promise<void> },
        ): void => {
            assert.equal(namespaceOwner, "@plurnk/plurnk-mcp");
            provider = candidate;
        },
        readWorkspaceModuleState: async (workspaceId: number): Promise<unknown | null> =>
            durable.get(workspaceId) ?? null,
        replaceWorkspaceCapabilities: async ({
            workspaceId,
            namespaceOwner,
            state,
            runtimes,
        }: {
            workspaceId: number;
            namespaceOwner: string;
            state: unknown | null;
            runtimes: readonly RuntimeRegistration[];
        }): Promise<void> => {
            assert.equal(namespaceOwner, "@plurnk/plurnk-mcp");
            replacementCalls += 1;
            durable.set(workspaceId, structuredClone(state));
            snapshots.set(workspaceId, [...runtimes]);
        },
    };
    return {
        actions,
        durable,
        snapshots,
        seam,
        replacementCalls: () => replacementCalls,
        hydrate: async (workspaceId: number): Promise<void> => {
            if (provider === undefined) throw new Error("MCP provider was not registered.");
            await provider.hydrate(workspaceId);
        },
        invoke: async (
            workspaceId: number,
            name: string,
            params: Readonly<Record<string, unknown>> = {},
        ): Promise<unknown> => {
            const action = actions.get(name);
            if (action === undefined) throw new Error(`Missing action '${name}'.`);
            return action.handler(params, { scope: "workspace", workspaceId });
        },
    };
};

const echoDefinition = (
    overrides: Partial<McpServerDefinition> = {},
): McpServerDefinition => ({
    name: "echo",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    ...overrides,
});

const httpHandler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "workspace-oauth-fixture", version: "1.0.0" });
    server.registerTool(
        "echo",
        {
            description: "Echo one message.",
            inputSchema: z.object({ message: z.string() }),
        },
        async ({ message }) => ({
            content: [{ type: "text", text: String(message) }],
        }),
    );
    return server;
}, {
    legacy: "reject",
    responseMode: "auto",
    keepAliveMs: 0,
});

const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(pathname);
            return;
        } catch {
            await delay(10);
        }
    }
    await access(pathname);
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await delay(10);
    }
    assert.ok(predicate(), "condition did not become true");
};

const rejectsManagementProblem = async (
    run: () => Promise<unknown>,
    code: string,
    status: number,
): Promise<void> => {
    await assert.rejects(run, (error: unknown) => {
        const problem = (error as { problem?: Record<string, unknown> }).problem;
        assert.equal(
            problem?.type,
            `https://problems.plurnk.dev/mcp/management/${code}`,
        );
        assert.equal(problem?.status, status);
        assert.equal(problem?.retryable, false);
        return true;
    });
};

test("service defaults hydrate as workspace-local executor and resource snapshots", async () => {
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        assert.deepEqual(
            [...h.actions.values()].map(({ name, scope }) => ({ name, scope })),
            [
                "workspace.mcp.list",
                "workspace.mcp.attach",
                "workspace.mcp.replace",
                "workspace.mcp.detach",
                "workspace.mcp.reconnect",
                "workspace.mcp.oauth.complete",
                "workspace.mcp.complete",
            ].map((name) => ({ name, scope: "workspace" })),
        );
        await h.hydrate(1);
        const [registration] = h.snapshots.get(1) ?? [];
        assert.equal(registration?.namespaceOwner, "@plurnk/plurnk-mcp");
        assert.equal(registration?.decl.name, "echo");
        assert.equal(registration?.availability.available, true);
        assert.match(registration?.availability.detail ?? "", /MCP 2026-07-28/);
        assert.deepEqual(
            registration?.executor.toolRegistry().tools.map((tool) => tool.target),
            ["echo", "fail"],
        );
        assert.equal(registration?.scheme?.claims("/resources/item"), true);
        assert.equal(registration?.scheme?.claims("/prompts/example"), true);
        assert.equal(registration?.scheme?.claims("/1/1/1"), false);

        const listed = await h.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ name: string; source: string; state: string }>;
        };
        assert.deepEqual(listed.servers.map(({ name, source, state }) => ({ name, source, state })), [{
            name: "echo",
            source: "service",
            state: "connected",
        }]);

        const completion = await h.invoke(1, "workspace.mcp.complete", {
            server: "echo",
            ref: { type: "ref/prompt", name: "summarize" },
            argument: { name: "topic", value: "M" },
        }) as { completion: { values: string[] } };
        assert.deepEqual(completion.completion.values, ["MCP"]);
    } finally {
        await module.close();
    }
});

test("attach and detach change only the bound workspace and persist an unexpanded definition", async () => {
    const module = Module.init({ env: { ...floor, MCP_TOKEN: "secret" } });
    const h = harness();
    try {
        await module.setup(h.seam);
        await Promise.all([h.hydrate(1), h.hydrate(2)]);
        const result = await h.invoke(1, "workspace.mcp.attach", {
            server: echoDefinition({
                env: { TOKEN: "${MCP_TOKEN}" },
                tools: ["echo"],
                read: ["echo"],
            }),
        }) as { status: number };
        assert.equal(result.status, 201);
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["echo"]);
        assert.deepEqual(h.snapshots.get(2), []);
        assert.match(JSON.stringify(h.durable.get(1)), /\$\{MCP_TOKEN\}/);

        await h.invoke(1, "workspace.mcp.detach", { name: "echo" });
        assert.deepEqual(h.snapshots.get(1), []);
        assert.equal(h.durable.get(1), null);
    } finally {
        await module.close();
    }
});

test("{§mcp-management-actions} replace and reconnect publish one fresh complete attachment", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-replace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "obsolete.closed");
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.attach", {
            server: echoDefinition({
                env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker },
                tools: ["echo"],
                read: ["echo"],
            }),
        });
        const first = h.snapshots.get(1)?.[0];
        assert.deepEqual(first?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);

        const replaced = await h.invoke(1, "workspace.mcp.replace", {
            server: echoDefinition({
                env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker },
                tools: ["fail"],
            }),
        }) as { status: number };
        assert.equal(replaced.status, 200);
        const second = h.snapshots.get(1)?.[0];
        assert.notEqual(second, first);
        assert.deepEqual(second?.executor.toolRegistry().tools.map(({ target }) => target), ["fail"]);
        assert.match(JSON.stringify(h.durable.get(1)), /"tools":\["fail"\]/);
        await waitForFile(marker);

        await rm(marker, { force: true });
        const reconnected = await h.invoke(1, "workspace.mcp.reconnect", {
            name: "echo",
        }) as { status: number };
        assert.equal(reconnected.status, 200);
        const third = h.snapshots.get(1)?.[0];
        assert.notEqual(third, second);
        assert.deepEqual(third?.executor.toolRegistry().tools.map(({ target }) => target), ["fail"]);
        await waitForFile(marker);
    } finally {
        await module.close();
    }
});

test("{§mcp-setup} a workspace attachment reconstructs from its durable unexpanded definition", async () => {
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env: floor });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    await firstHarness.invoke(1, "workspace.mcp.attach", {
        server: echoDefinition({ tools: ["echo"], read: ["echo"] }),
    });
    await first.close();

    const restored = Module.init({ env: floor });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const listed = await restoredHarness.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ name: string; source: string; state: string }>;
        };
        assert.deepEqual(listed.servers.map(({ name, source, state }) => ({ name, source, state })), [{
            name: "echo",
            source: "workspace",
            state: "connected",
        }]);
        assert.deepEqual(
            restoredHarness.snapshots.get(1)?.[0]?.executor.toolRegistry().tools
                .map(({ target }) => target),
            ["echo"],
        );
    } finally {
        await restored.close();
    }
});

test("{§mcp-management-actions} management conflicts preserve exact Problems and prior state", async () => {
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.attach", { server: {} }),
            "definition-invalid",
            400,
        );
        assert.deepEqual(h.snapshots.get(1), []);

        await h.invoke(1, "workspace.mcp.attach", { server: echoDefinition() });
        const priorState = structuredClone(h.durable.get(1));
        const priorRuntime = h.snapshots.get(1)?.[0];
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.attach", { server: echoDefinition() }),
            "server-exists",
            409,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.replace", {
                server: echoDefinition({ name: "missing" }),
            }),
            "server-not-found",
            404,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.detach", { name: "missing" }),
            "server-not-found",
            404,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.reconnect", { name: "missing" }),
            "server-not-found",
            404,
        );
        assert.deepEqual(h.durable.get(1), priorState);
        assert.equal(h.snapshots.get(1)?.[0], priorRuntime);
    } finally {
        await module.close();
    }
});

test("OAuth completion rebases its target onto unrelated committed workspace changes", async (t) => {
    let origin = "";
    const served = await serveMcpHttp(t, httpHandler(), (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
            if (request.headers.get("authorization") === "Bearer access-token") return null;
            return new Response("unauthorized", {
                status: 401,
                headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                },
            });
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({
                resource: `${origin}/mcp`,
                authorization_servers: [origin],
                scopes_supported: ["mcp:read"],
            });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                client_id_metadata_document_supported: true,
                authorization_response_iss_parameter_supported: true,
            });
        }
        if (url.pathname === "/token") {
            return Response.json({
                access_token: "access-token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "mcp:read",
            });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const pending = await h.invoke(1, "workspace.mcp.attach", {
            server: {
                name: "oauth",
                transport: "http",
                url: served.url,
                authorization: {
                    type: "oauth",
                    redirectUrl: `${origin}/callback`,
                    clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
                    scope: "mcp:read",
                },
            },
        }) as { status: number; authorization: { url: string } };
        assert.equal(pending.status, 202);

        await h.invoke(1, "workspace.mcp.attach", {
            server: echoDefinition({ name: "local" }),
        });
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["local"]);

        const state = new URL(pending.authorization.url).searchParams.get("state");
        assert.ok(state);
        const completed = await h.invoke(1, "workspace.mcp.oauth.complete", {
            name: "oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }) as { status: number };
        assert.equal(completed.status, 200);
        assert.deepEqual(
            h.snapshots.get(1)?.map(({ decl }) => decl.name).toSorted(),
            ["local", "oauth"],
        );
        assert.match(JSON.stringify(h.durable.get(1)), /"local"/);
        assert.match(JSON.stringify(h.durable.get(1)), /"oauth"/);
    } finally {
        await module.close();
    }
});

test("list change refreshes the workspace snapshot without replacing its connection", async (t) => {
    let expanded = false;
    const dynamicHandler = createMcpHandler(() => {
        const server = new McpServer({ name: "workspace-list-fixture", version: "1.0.0" });
        server.registerTool(
            "echo",
            {
                description: "Echo one message.",
                inputSchema: z.object({ message: z.string() }),
            },
            async ({ message }) => ({ content: [{ type: "text", text: String(message) }] }),
        );
        if (expanded) {
            server.registerTool(
                "inspect",
                {
                    description: "Inspect one message.",
                    inputSchema: z.object({ message: z.string() }),
                },
                async ({ message }) => ({ content: [{ type: "text", text: String(message) }] }),
            );
        }
        return server;
    }, {
        legacy: "reject",
        responseMode: "auto",
        keepAliveMs: 0,
    });
    const served = await serveMcpHttp(t, dynamicHandler);
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.attach", {
            server: { name: "dynamic", transport: "http", url: served.url },
        });
        assert.deepEqual(
            h.snapshots.get(1)?.[0]?.executor.toolRegistry().tools.map(({ target }) => target),
            ["echo"],
        );
        await waitFor(() =>
            (dynamicHandler.bus as { readonly listenerCount?: number }).listenerCount === 1);

        expanded = true;
        dynamicHandler.notify.toolsChanged();
        await waitFor(() =>
            h.snapshots.get(1)?.[0]?.executor.toolRegistry().tools.length === 2);
        assert.deepEqual(
            h.snapshots.get(1)?.[0]?.executor.toolRegistry().tools.map(({ target }) => target),
            ["echo", "inspect"],
        );
        assert.equal(
            served.requests.filter(({ body }) =>
                (body as { method?: string }).method === "server/discover").length,
            1,
            "catalog invalidation reuses the negotiated connection",
        );
    } finally {
        await module.close();
    }
});

test("detaching a service default writes a tombstone that survives module restart", async () => {
    const env = {
        ...floor,
        PLURNK_MCP_ECHO: process.execPath,
        PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
    };
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    await firstHarness.invoke(1, "workspace.mcp.detach", { name: "echo" });
    assert.match(JSON.stringify(durable.get(1)), /"kind":"detached"/);
    await first.close();

    const restored = Module.init({ env });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        assert.deepEqual(restoredHarness.snapshots.get(1), []);
        assert.deepEqual(
            (await restoredHarness.invoke(1, "workspace.mcp.list") as { servers: unknown[] }).servers,
            [],
        );
    } finally {
        await restored.close();
    }
});

test("failed replacement leaves durable state, Registry, and prior connection authoritative", async () => {
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.attach", { server: echoDefinition() });
        const priorState = structuredClone(h.durable.get(1));
        const priorRuntime = h.snapshots.get(1)?.[0];
        const calls = h.replacementCalls();
        await assert.rejects(
            () => h.invoke(1, "workspace.mcp.replace", {
                server: echoDefinition({ command: "/definitely/missing/plurnk-mcp-server" }),
            }),
            /Configured MCP server 'echo' is unavailable/,
        );
        assert.equal(h.replacementCalls(), calls, "the failed candidate never reaches core commit");
        assert.deepEqual(h.durable.get(1), priorState);
        assert.equal(h.snapshots.get(1)?.[0], priorRuntime);
    } finally {
        await module.close();
    }
});

test("{§mcp-management-actions} a legacy endpoint is attributed at the public action boundary", async () => {
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await assert.rejects(
            () => h.invoke(1, "workspace.mcp.attach", {
                server: echoDefinition({ args: [legacyFixture] }),
            }),
            (error: unknown) => {
                const problem = (error as { problem?: Record<string, unknown> }).problem;
                assert.equal(
                    problem?.type,
                    "https://problems.plurnk.dev/mcp/management/protocol-revision-unsupported",
                );
                assert.equal(problem?.status, 502);
                assert.equal(problem?.retryable, false);
                assert.equal(problem?.server, "echo");
                assert.equal(problem?.requiredRevision, "2026-07-28");
                assert.equal(problem?.requiredMethod, "server/discover");
                assert.match(String(problem?.detail ?? ""), /upgrade or replace the legacy endpoint/i);
                return true;
            },
        );
        assert.deepEqual(h.snapshots.get(1), [], "the rejected endpoint publishes no capability");
    } finally {
        await module.close();
    }
});

test("partial multi-server hydration closes acquired candidates and publishes nothing", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-partial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "alpha.closed");
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_ALPHA: process.execPath,
            PLURNK_MCP_ALPHA_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_ALPHA_ENV: JSON.stringify({
                PLURNK_MCP_TEST_CLOSE_MARKER: marker,
            }),
            PLURNK_MCP_ZBROKEN: join(root, "missing-server"),
        },
    });
    const h = harness();
    await module.setup(h.seam);
    await assert.rejects(
        () => h.hydrate(1),
        /Configured MCP server 'zbroken' is unavailable/,
    );
    assert.equal(h.replacementCalls(), 0);
    await waitForFile(marker);
    await module.close();
});

test("detach closes the exact workspace connection after the replacement commits", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-detach-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "echo.closed");
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.attach", {
            server: echoDefinition({
                env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker },
            }),
        });
        await h.invoke(1, "workspace.mcp.detach", { name: "echo" });
        await waitForFile(marker);
    } finally {
        await module.close();
    }
});

test("a whitespace-bearing executable path remains one exact attachment command", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk mcp executable "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = join(root, "node with spaces");
    await symlink(process.execPath, command);
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.attach", {
            server: echoDefinition({ command }),
        });
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["echo"]);
    } finally {
        await module.close();
    }
});

test("connection shutdown attempts all connections and aggregates every failure", async () => {
    const first = new Error("first close failed");
    const second = new Error("second close failed");
    let successfulClose = false;

    await assert.rejects(
        () => closeConnections([
            { close: async () => { throw first; } },
            { close: async () => { successfulClose = true; } },
            { close: async () => { throw new AggregateError([second], "nested close"); } },
        ]),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [first, second]);
            return true;
        },
    );
    assert.equal(successfulClose, true);
});
