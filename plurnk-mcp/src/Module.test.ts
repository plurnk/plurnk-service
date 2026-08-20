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
import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import type McpExecutor from "./McpExecutor.ts";
import type McpResources from "./McpResources.ts";
import Module, { closeConnections } from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const legacyFixture = fileURLToPath(new URL("./fixtures/legacy-server.mjs", import.meta.url));
const taskFixture = fileURLToPath(new URL("./fixtures/task-server.mjs", import.meta.url));
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

const interactiveOAuthFixture = async (
    t: import("node:test").TestContext,
): Promise<{ origin: string; served: Awaited<ReturnType<typeof serveMcpHttp>> }> => {
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
    return { origin, served };
};

interface PendingAuthorization {
    readonly status: number;
    readonly authorization: { readonly url: string };
}

const beginInteractiveAuthorization = async (
    h: ReturnType<typeof harness>,
    workspaceId: number,
    served: { url: string },
    origin: string,
): Promise<PendingAuthorization> => {
    const pending = await h.invoke(workspaceId, "workspace.mcp.add", {
        alias: "oauth",
        target: served.url,
        options: {
            authorization: {
                type: "oauth",
                redirectUrl: `${origin}/callback`,
                clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
                scope: "mcp:read",
            },
        },
    }) as PendingAuthorization;
    assert.equal(pending.status, 202);
    return pending;
};

const completeAuthorization = async (
    h: ReturnType<typeof harness>,
    workspaceId: number,
    pending: PendingAuthorization,
    origin: string,
): Promise<void> => {
    const state = new URL(pending.authorization.url).searchParams.get("state");
    assert.ok(state);
    const completed = await h.invoke(workspaceId, "workspace.mcp.oauth.complete", {
        alias: "oauth",
        callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
    }) as { status: number };
    assert.equal(completed.status, 200);
};

const callbackWithState = (state: string, origin: string): string =>
    `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`;

test("{§mcp-management-actions} cold service definitions remain available while workspace enabledness overrides defaults", async () => {
    const env = {
        ...floor,
        PLURNK_MCP_ATLAS: process.execPath,
        PLURNK_MCP_ATLAS_ARGS: JSON.stringify([fixture]),
        PLURNK_MCP_ECHO: process.execPath,
        PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        PLURNK_MCP_ENABLED: '["echo"]',
    };
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    assert.deepEqual(firstHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["echo"]);
    assert.deepEqual(
        (await firstHarness.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; enabled: boolean; state: string }>;
        }).servers.map(({ alias, enabled, state }) => ({ alias, enabled, state })),
        [
            { alias: "atlas", enabled: false, state: "disabled" },
            { alias: "echo", enabled: true, state: "connected" },
        ],
    );

    await firstHarness.invoke(1, "workspace.mcp.enable", { alias: "atlas" });
    await firstHarness.invoke(1, "workspace.mcp.disable", { alias: "echo" });
    assert.deepEqual(firstHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["atlas"]);
    assert.match(JSON.stringify(durable.get(1)), /"atlas".*"enabled":true/);
    assert.match(JSON.stringify(durable.get(1)), /"echo".*"enabled":false/);
    await first.close();

    const restored = Module.init({ env });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        assert.deepEqual(restoredHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["atlas"]);
        await rejectsManagementProblem(
            () => restoredHarness.invoke(1, "workspace.mcp.remove", { alias: "atlas" }),
            "server-service-owned",
            409,
        );
    } finally {
        await restored.close();
    }
});

test("{§mcp-configuration-cascade} listing projects client-only definitions without connecting or persisting them", async () => {
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_GITEA: "gitea-mcp",
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const calls = h.replacementCalls();
        const listed = await h.invoke(1, "workspace.mcp.list", {
            overlay: {
                PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
                PLURNK_MCP_LOCAL: process.execPath,
                PLURNK_MCP_LOCAL_ARGS: JSON.stringify([fixture]),
            },
        }) as {
            servers: Array<{
                alias: string;
                source: string;
                enabled: boolean;
                state: string;
            }>;
        };
        assert.deepEqual(
            listed.servers.map(({ alias, source, enabled, state }) => ({
                alias,
                source,
                enabled,
                state,
            })),
            [
                { alias: "gitea", source: "service", enabled: false, state: "disabled" },
                { alias: "local", source: "client", enabled: false, state: "disabled" },
            ],
        );
        assert.equal(h.replacementCalls(), calls);
        assert.deepEqual(h.snapshots.get(1), []);
        assert.equal(h.durable.get(1), null);
    } finally {
        await module.close();
    }
});

test("{§mcp-configuration-cascade} customized enable persists one shadowing definition and remove reveals its service baseline disabled", async () => {
    const env = {
        ...floor,
        PLURNK_MCP_GITEA: process.execPath,
    };
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    const enabled = await firstHarness.invoke(1, "workspace.mcp.enable", {
        alias: "gitea",
        overlay: { PLURNK_MCP_GITEA_ARGS: '["discarded-by-options"]' },
        options: { args: [fixture], tools: ["echo"], read: ["echo"] },
    }) as { server: { source: string; state: string } };
    assert.equal(enabled.server.source, "workspace");
    assert.equal(enabled.server.state, "connected");
    assert.deepEqual(firstHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["gitea"]);
    assert.deepEqual(durable.get(1), {
        version: 1,
        servers: {
            gitea: {
                kind: "workspace",
                definition: {
                    name: "gitea",
                    transport: "stdio",
                    command: process.execPath,
                    args: [fixture],
                    tools: ["echo"],
                    read: ["echo"],
                },
                enabled: true,
            },
        },
    });
    await first.close();

    const restored = Module.init({ env });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const before = await restoredHarness.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; source: string; state: string }>;
        };
        assert.deepEqual(
            before.servers.map(({ alias, source, state }) => ({ alias, source, state })),
            [{ alias: "gitea", source: "workspace", state: "connected" }],
        );

        await restoredHarness.invoke(1, "workspace.mcp.remove", { alias: "gitea" });
        const after = await restoredHarness.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; source: string; enabled: boolean; state: string }>;
        };
        assert.deepEqual(after.servers, [{
            alias: "gitea",
            source: "service",
            transport: "stdio",
            target: process.execPath,
            enabled: false,
            state: "disabled",
            enabledTools: null,
            read: [],
        }]);
        assert.deepEqual(durable.get(1), {
            version: 1,
            servers: { gitea: { kind: "service", enabled: false } },
        });
    } finally {
        await restored.close();
    }
});

test("{§mcp-configuration-cascade} enable admits a complete client-only definition", async () => {
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const result = await h.invoke(1, "workspace.mcp.enable", {
            alias: "local",
            overlay: {
                PLURNK_MCP_LOCAL: process.execPath,
                PLURNK_MCP_LOCAL_ARGS: JSON.stringify([fixture]),
            },
        }) as { server: { alias: string; source: string; state: string } };
        assert.equal(result.server.alias, "local");
        assert.equal(result.server.source, "workspace");
        assert.equal(result.server.state, "connected");
        assert.match(JSON.stringify(h.durable.get(1)), /"kind":"workspace"/u);
    } finally {
        await module.close();
    }
});

test("service defaults hydrate as workspace-local executor and resource snapshots", async () => {
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_ENABLED: '["echo"]',
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        assert.deepEqual(
            [...h.actions.values()].map(({ name, scope }) => ({ name, scope })),
            [
                "workspace.mcp.list",
                "workspace.mcp.add",
                "workspace.mcp.enable",
                "workspace.mcp.disable",
                "workspace.mcp.remove",
                "workspace.mcp.oauth.complete",
                "workspace.mcp.complete",
            ].map((name) => ({ name, scope: "workspace" })),
        );
        await h.hydrate(1);
        const [registration] = h.snapshots.get(1) ?? [];
        assert.equal(registration?.namespaceOwner, "@plurnk/plurnk-mcp");
        assert.equal(registration?.decl.name, "echo");
        assert.equal(registration?.decl.summary, "Tools: echo, fail.");
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
            servers: Array<{ alias: string; source: string; state: string }>;
        };
        assert.deepEqual(listed.servers.map(({ alias, source, state }) => ({ alias, source, state })), [{
            alias: "echo",
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

test("add and remove change only the bound workspace and persist an unexpanded definition", async () => {
    const module = Module.init({ env: { ...floor, MCP_TOKEN: "secret" } });
    const h = harness();
    try {
        await module.setup(h.seam);
        await Promise.all([h.hydrate(1), h.hydrate(2)]);
        const result = await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: process.execPath,
            options: {
                args: [fixture],
                env: { TOKEN: "${MCP_TOKEN}" },
                tools: ["echo"],
                read: ["echo"],
            },
        }) as { status: number };
        assert.equal(result.status, 201);
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["echo"]);
        assert.deepEqual(h.snapshots.get(2), []);
        assert.match(JSON.stringify(h.durable.get(1)), /\$\{MCP_TOKEN\}/);

        await h.invoke(1, "workspace.mcp.remove", { alias: "echo" });
        assert.deepEqual(h.snapshots.get(1), []);
        assert.equal(h.durable.get(1), null);
    } finally {
        await module.close();
    }
});

test("{§mcp-management-actions} disable and enable retire then rebuild one complete attachment", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-replace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "obsolete.closed");
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: process.execPath,
            options: {
                args: [fixture],
                env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker },
                tools: ["echo"],
                read: ["echo"],
            },
        });
        const first = h.snapshots.get(1)?.[0];
        assert.deepEqual(first?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);

        const disabled = await h.invoke(1, "workspace.mcp.disable", { alias: "echo" }) as { status: number };
        assert.equal(disabled.status, 200);
        assert.deepEqual(h.snapshots.get(1), []);
        await waitForFile(marker);

        await rm(marker, { force: true });
        const enabled = await h.invoke(1, "workspace.mcp.enable", {
            alias: "echo",
        }) as { status: number };
        assert.equal(enabled.status, 200);
        const second = h.snapshots.get(1)?.[0];
        assert.notEqual(second, first);
        assert.deepEqual(second?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);
    } finally {
        await module.close();
    }
});

test("{§mcp-setup} a workspace-added server reconstructs from its durable unexpanded definition", async () => {
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env: floor });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    await firstHarness.invoke(1, "workspace.mcp.add", {
        alias: "echo",
        target: process.execPath,
        options: { args: [fixture], tools: ["echo"], read: ["echo"] },
    });
    await first.close();

    const restored = Module.init({ env: floor });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const listed = await restoredHarness.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; source: string; state: string }>;
        };
        assert.deepEqual(listed.servers.map(({ alias, source, state }) => ({ alias, source, state })), [{
            alias: "echo",
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
            () => h.invoke(1, "workspace.mcp.list", { server: "legacy-shape" }),
            "parameters-invalid",
            400,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.list", {
                overlay: { PLURNK_MCP_ENABLED: '["echo"]' },
            }),
            "configuration-invalid",
            400,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.add", {
                alias: "echo",
                target: process.execPath,
                options: { transport: "stdio" },
            }),
            "definition-invalid",
            400,
        );
        assert.deepEqual(h.snapshots.get(1), []);

        await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: process.execPath,
            options: { args: [fixture] },
        });
        const priorState = structuredClone(h.durable.get(1));
        const priorRuntime = h.snapshots.get(1)?.[0];
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.add", {
                alias: "echo",
                target: process.execPath,
                options: { args: [fixture] },
            }),
            "server-exists",
            409,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.enable", { alias: "missing" }),
            "server-not-found",
            404,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.disable", { alias: "missing" }),
            "server-not-found",
            404,
        );
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.remove", { alias: "missing" }),
            "server-not-found",
            404,
        );
        assert.deepEqual(h.durable.get(1), priorState);
        assert.equal(h.snapshots.get(1)?.[0], priorRuntime);
    } finally {
        await module.close();
    }
});

test("OAuth completion rebases add and customized enable onto current workspace state", async (t) => {
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
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_OAUTH: served.url,
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const pending = await h.invoke(1, "workspace.mcp.add", {
            alias: "added-oauth",
            target: served.url,
            options: {
                authorization: {
                    type: "oauth",
                    redirectUrl: `${origin}/callback`,
                    clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
                    scope: "mcp:read",
                },
            },
        }) as { status: number; authorization: { url: string } };
        assert.equal(pending.status, 202);

        await h.invoke(1, "workspace.mcp.add", {
            alias: "local",
            target: process.execPath,
            options: { args: [fixture] },
        });
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["local"]);

        const state = new URL(pending.authorization.url).searchParams.get("state");
        assert.ok(state);
        const completed = await h.invoke(1, "workspace.mcp.oauth.complete", {
            alias: "added-oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }) as { status: number };
        assert.equal(completed.status, 200);
        assert.deepEqual(
            h.snapshots.get(1)?.map(({ decl }) => decl.name).toSorted(),
            ["added-oauth", "local"],
        );
        assert.match(JSON.stringify(h.durable.get(1)), /"local"/);
        assert.match(JSON.stringify(h.durable.get(1)), /"added-oauth"/);

        await h.hydrate(2);
        const specialized = await h.invoke(2, "workspace.mcp.enable", {
            alias: "oauth",
            options: {
                authorization: {
                    type: "oauth",
                    redirectUrl: `${origin}/callback`,
                    clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
                    scope: "mcp:read",
                },
                tools: ["echo"],
                read: ["echo"],
            },
        }) as { status: number; authorization: { url: string } };
        assert.equal(specialized.status, 202);
        const specializedState = new URL(specialized.authorization.url).searchParams.get("state");
        assert.ok(specializedState);
        await h.invoke(2, "workspace.mcp.oauth.complete", {
            alias: "oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(specializedState)}&iss=${encodeURIComponent(origin)}`,
        });
        assert.deepEqual(h.snapshots.get(2)?.map(({ decl }) => decl.name), ["oauth"]);
        assert.match(
            JSON.stringify(h.durable.get(2)),
            /"kind":"workspace".*"authorization".*"tools":\["echo"\]/u,
        );
    } finally {
        await module.close();
    }
});

test("{§tasks-lifetime} daemon restart leaves no task material and a re-run drives a fresh in-process task", async () => {
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env: floor });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    await firstHarness.invoke(1, "workspace.mcp.add", {
        alias: "tasks",
        target: process.execPath,
        options: { args: [taskFixture] },
    });
    const executor = firstHarness.snapshots.get(1)?.[0]?.executor;
    assert.ok(executor);
    const run = async (target: NonNullable<typeof executor>): Promise<{ status: number }> => {
        const result = await target.run({
            runtime: "tasks",
            body: JSON.stringify({ topic: "module lifetime" }),
            target: "stdio-defer",
            cwd: null,
            signal: new AbortController().signal,
            write: () => undefined,
            setState: () => undefined,
            emit: () => undefined,
            interact: async () => {
                throw new Error("the plain task fixture never requests input");
            },
        });
        return result as { status: number };
    };
    assert.equal((await run(executor)).status, 200);
    assert.doesNotMatch(JSON.stringify(durable.get(1)), /stdio-task-1/, "task handles never reach durable state");
    await first.close();

    const restored = Module.init({ env: floor });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const replayed = restoredHarness.snapshots.get(1)?.[0]?.executor;
        assert.ok(replayed);
        const result = await run(replayed);
        assert.equal(result.status, 200, "a re-run completes a fresh task instead of resuming the abandoned one");
    } finally {
        await restored.close();
    }
});

test("{§oauth-lifetime} daemon restart during pending authorization leaves nothing and requires starting over", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env: floor });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    const pending = await beginInteractiveAuthorization(firstHarness, 1, served, origin);
    await first.close();

    const restored = Module.init({ env: floor });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const list = await restoredHarness.invoke(1, "workspace.mcp.list", {}) as {
            servers: Array<{ alias: string }>;
        };
        assert.deepEqual(list.servers.map(({ alias }) => alias), []);
        await rejectsManagementProblem(
            () => restoredHarness.invoke(1, "workspace.mcp.oauth.complete", {
                alias: "oauth",
                callbackUrl: callbackWithState("lost", origin),
            }),
            "oauth-not-pending",
            404,
        );
        assert.equal(durable.get(1), null, "a pending candidate never reaches durable state");
    } finally {
        await restored.close();
    }
});

test("{§oauth-lifetime} a restart reconstructs an authorized server as authorization-required", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env: floor });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    const pending = await beginInteractiveAuthorization(firstHarness, 1, served, origin);
    await completeAuthorization(firstHarness, 1, pending, origin);
    assert.deepEqual(firstHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["oauth"]);
    assert.match(JSON.stringify(durable.get(1)), /"kind":"workspace"/);
    assert.doesNotMatch(JSON.stringify(durable.get(1)), /access-token|refresh_token|verifier|fixture-code/);
    await first.close();

    const restored = Module.init({ env: floor });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        const list = await restoredHarness.invoke(1, "workspace.mcp.list", {}) as {
            servers: Array<{ alias: string; state: string }>;
        };
        assert.deepEqual(
            list.servers.map(({ alias, state }) => ({ alias, state })),
            [{ alias: "oauth", state: "authorization-required" }],
        );
        const reauthorize = await restoredHarness.invoke(1, "workspace.mcp.enable", {
            alias: "oauth",
        }) as PendingAuthorization;
        assert.equal(reauthorize.status, 202);
        assert.notEqual(reauthorize.authorization.url, pending.authorization.url);
        await completeAuthorization(restoredHarness, 1, reauthorize, origin);
        assert.deepEqual(restoredHarness.snapshots.get(1)?.map(({ decl }) => decl.name), ["oauth"]);
        assert.doesNotMatch(JSON.stringify(durable.get(1)), /access-token|refresh_token|verifier/);
    } finally {
        await restored.close();
    }
});

test("{§oauth-lifetime} a superseded authorization attempt cannot complete a replacement", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const first = await beginInteractiveAuthorization(h, 1, served, origin);
        const firstState = new URL(first.authorization.url).searchParams.get("state");
        assert.ok(firstState);
        const replacement = await beginInteractiveAuthorization(h, 1, served, origin);
        assert.notEqual(replacement.authorization.url, first.authorization.url);

        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.oauth.complete", {
                alias: "oauth",
                callbackUrl: callbackWithState(firstState, origin),
            }),
            "oauth-callback-invalid",
            400,
        );
        await completeAuthorization(h, 1, replacement, origin);
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["oauth"]);
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
        await h.invoke(1, "workspace.mcp.add", {
            alias: "dynamic",
            target: served.url,
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

test("disabling a service default writes a positive override that survives module restart", async () => {
    const env = {
        ...floor,
        PLURNK_MCP_ECHO: process.execPath,
        PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        PLURNK_MCP_ENABLED: '["echo"]',
    };
    const durable = new Map<number, unknown | null>();
    const first = Module.init({ env });
    const firstHarness = harness(durable);
    await first.setup(firstHarness.seam);
    await firstHarness.hydrate(1);
    await firstHarness.invoke(1, "workspace.mcp.disable", { alias: "echo" });
    assert.match(JSON.stringify(durable.get(1)), /"kind":"service","enabled":false/);
    await first.close();

    const restored = Module.init({ env });
    const restoredHarness = harness(durable);
    try {
        await restored.setup(restoredHarness.seam);
        await restoredHarness.hydrate(1);
        assert.deepEqual(restoredHarness.snapshots.get(1), []);
        assert.deepEqual(
            (await restoredHarness.invoke(1, "workspace.mcp.list") as {
                servers: Array<{ alias: string; enabled: boolean; state: string }>;
            }).servers.map(({ alias, enabled, state }) => ({ alias, enabled, state })),
            [{ alias: "echo", enabled: false, state: "disabled" }],
        );
    } finally {
        await restored.close();
    }
});

test("failed enable leaves durable state and Registry authoritative", async () => {
    const module = Module.init({
        env: {
            ...floor,
            PLURNK_MCP_BROKEN: "/definitely/missing/plurnk-mcp-server",
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const priorState = structuredClone(h.durable.get(1));
        const calls = h.replacementCalls();
        await assert.rejects(
            () => h.invoke(1, "workspace.mcp.enable", { alias: "broken" }),
            /Configured MCP server 'broken' is unavailable/,
        );
        assert.equal(h.replacementCalls(), calls, "the failed candidate never reaches core commit");
        assert.deepEqual(h.durable.get(1), priorState);
        assert.deepEqual(h.snapshots.get(1), []);
    } finally {
        await module.close();
    }
});

test("{§oauth-client-credentials} a rejected grant crosses the boundary as an authorization problem", async (t) => {
    let servedUrl = "";
    let tokenPosts = 0;
    const served = await serveMcpHttp(t, httpHandler(), (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
            return Response.json({
                resource: servedUrl,
                authorization_servers: [servedUrl],
            });
        }
        if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json({
                issuer: servedUrl,
                authorization_endpoint: `${servedUrl}/authorize`,
                token_endpoint: `${servedUrl}/token`,
                scopes_supported: [],
            });
        }
        if (url.pathname.endsWith("/token")) {
            tokenPosts += 1;
            return Response.json({ error: "invalid_client" }, { status: 400 });
        }
        if (authorization === "Bearer granted-access-token") return null;
        return new Response("unauthorized", { status: 401 });
    });
    servedUrl = served.url;

    const module = Module.init({
        env: { ...floor, MCP_CC_SECRET: "client-secret-value" },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await rejectsManagementProblem(
            () => h.invoke(1, "workspace.mcp.add", {
                alias: "grant",
                target: served.url,
                options: {
                    authorization: {
                        type: "client-credentials",
                        clientId: "app-id",
                        clientSecret: "${MCP_CC_SECRET}",
                    },
                },
            }),
            "oauth-client-credentials-failed",
            502,
        );
        assert.ok(tokenPosts >= 1, "the grant was actually attempted");
        assert.deepEqual(h.snapshots.get(1), []);
        assert.equal(h.durable.get(1), null);
    } finally {
        await module.close();
    }
});

test("{§mcp-authority} a legacy peer negotiates below the pin and serves its standard catalog", async () => {
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: process.execPath,
            options: { args: [legacyFixture] },
        });
        const list = await h.invoke(1, "workspace.mcp.list", {}) as {
            servers: Array<Record<string, unknown>>;
        };
        const echo = list.servers.find((server) => server.alias === "echo");
        assert.ok(echo !== undefined, "the legacy peer is listed");
        assert.equal(echo?.state, "connected", "a negotiated legacy peer connects instead of being rejected");
        assert.equal(echo?.protocolVersion, "2025-06-18", "the negotiated revision is the honest wire fact");
        assert.deepEqual(echo?.tools, ["legacy_echo"], "the legacy peer's tool list is admitted");
        assert.equal((echo?.server as { name?: string } | undefined)?.name, "legacy-echo", "the initialize serverInfo is the legacy identity");
    } finally {
        await module.close();
    }
});

test("{§mcp-hydration-isolation} partial hydration publishes healthy servers and isolates unavailable ones", async (t) => {
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
            PLURNK_MCP_ENABLED: '["alpha","zbroken"]',
        },
    });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        assert.equal(h.replacementCalls(), 1);
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["alpha"]);
        const listed = await h.invoke(1, "workspace.mcp.list") as {
            servers: Array<{
                alias: string;
                state: string;
                problem?: { status?: number; retryable?: boolean };
            }>;
        };
        assert.deepEqual(
            listed.servers.map(({ alias, state }) => ({ alias, state })),
            [
                { alias: "alpha", state: "connected" },
                { alias: "zbroken", state: "unavailable" },
            ],
        );
        assert.equal(listed.servers[1]?.problem?.status, 502);
        assert.equal(listed.servers[1]?.problem?.retryable, true);

        await h.invoke(1, "workspace.mcp.disable", { alias: "zbroken" });
        const disabled = await h.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; state: string }>;
        };
        assert.equal(disabled.servers.find(({ alias }) => alias === "zbroken")?.state, "disabled");
    } finally {
        await module.close();
    }
    await waitForFile(marker);
});

test("{§mcp-hydration-isolation} workspace-owned unavailable servers can be removed or explicitly retried", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-retry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const retryTarget = join(root, "retry-node");
    const removeTarget = join(root, "remove-node");
    const durable = new Map<number, unknown | null>([[1, {
        version: 1,
        servers: {
            remove: {
                kind: "workspace",
                definition: {
                    name: "remove",
                    transport: "stdio",
                    command: removeTarget,
                    args: [fixture],
                },
                enabled: true,
            },
            retry: {
                kind: "workspace",
                definition: {
                    name: "retry",
                    transport: "stdio",
                    command: retryTarget,
                    args: [fixture],
                },
                enabled: true,
            },
        },
    }]]);
    const module = Module.init({ env: floor });
    const h = harness(durable);
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        const initial = await h.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; state: string }>;
        };
        assert.deepEqual(
            initial.servers.map(({ alias, state }) => ({ alias, state })),
            [
                { alias: "remove", state: "unavailable" },
                { alias: "retry", state: "unavailable" },
            ],
        );

        await h.invoke(1, "workspace.mcp.remove", { alias: "remove" });
        await assert.rejects(
            () => h.invoke(1, "workspace.mcp.enable", { alias: "retry" }),
            /Configured MCP server 'retry' is unavailable/,
        );
        const preserved = await h.invoke(1, "workspace.mcp.list") as {
            servers: Array<{ alias: string; state: string }>;
        };
        assert.deepEqual(
            preserved.servers.map(({ alias, state }) => ({ alias, state })),
            [{ alias: "retry", state: "unavailable" }],
        );

        await symlink(process.execPath, retryTarget);
        const retried = await h.invoke(1, "workspace.mcp.enable", { alias: "retry" }) as {
            server: { state: string };
        };
        assert.equal(retried.server.state, "connected");
        assert.deepEqual(h.snapshots.get(1)?.map(({ decl }) => decl.name), ["retry"]);
    } finally {
        await module.close();
    }
});

test("remove closes the exact workspace connection after the replacement commits", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-detach-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "echo.closed");
    const module = Module.init({ env: floor });
    const h = harness();
    try {
        await module.setup(h.seam);
        await h.hydrate(1);
        await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: process.execPath,
            options: {
                args: [fixture],
                env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker },
            },
        });
        await h.invoke(1, "workspace.mcp.remove", { alias: "echo" });
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
        await h.invoke(1, "workspace.mcp.add", {
            alias: "echo",
            target: command,
            options: { args: [fixture] },
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
