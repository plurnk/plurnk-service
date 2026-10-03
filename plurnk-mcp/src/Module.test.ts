// {§mcp-module} — the MCP family as a workspace Functionality adapter. These tests
// drive the adapter contract directly (configured definitions, two-phase
// preparation, OAuth continuation, isolation, refresh, hot reload, teardown). The lifecycle verbs, durable state, and both projections belong to
// the coordinator and are covered where it composes with this module.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { FunctionalityPreparedDefinition, McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { serveOAuthMcp } from "../test/oauth-fixture.ts";
import type McpExecutor from "./McpExecutor.ts";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import Module, { closeConnections } from "./Module.ts";
import ServerConnection from "./client.ts";
import { httpServer, stdioServer as stdio } from "../test/definitions.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const legacyFixture = fileURLToPath(new URL("./fixtures/legacy-server.mjs", import.meta.url));
const floor = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: McpExecutor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: object;
}

type Outcome =
    | { state: "active"; detail?: { tools?: string[]; protocolVersion?: string } }
    | { state: "unavailable"; problem: ProblemDetails }
    | { state: "authorization-required"; authorization: { url?: string } };

interface Prepared {
    readonly runtimes: readonly RuntimeRegistration[];
    readonly outcomes: ReadonlyMap<string, Outcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

interface Adapter {
    readonly family: string;
    readonly namespaceOwner: string;
    available(identity: { workspaceId: number }): Promise<readonly { alias: string; definition: object; enabled: boolean }[]>;
    readonly example?: { readonly alias: string; readonly definition: object };
    discover(query: { query?: string; source?: string; configuration?: object }, identity: { workspaceId: number }): Promise<readonly { alias?: string; summary?: string; definition: object; provenance: object }[]>;
    admit(input: unknown, identity: { workspaceId: number }): Promise<{ alias: string; definition: object }>;
    refreshIfChanged(identity: { workspaceId: number }): Promise<void>;
    prepare(preparation: {
        workspaceId: number;
        enabled: ReadonlyMap<string, FunctionalityPreparedDefinition>; previous: unknown | null;
        failure: "publish-unavailable" | "reject"; force?: string; retain(): () => void;
        progress(alias: string): void;
    }): Promise<Prepared>;
    teardown(snapshot: unknown, identity: { workspaceId: number }): Promise<void>;
}

interface ActionRegistration {
    readonly name: string;
    readonly handler: (params: Readonly<Record<string, unknown>>, context: { scope: "workspace"; workspaceId: number }) => unknown | Promise<unknown>;
}

// A harness that stands where the coordinator stands: it holds each workspace's
// enabled set and committed snapshot and calls the adapter's two phases. It
// decides nothing about lifecycle semantics — tests choose the enabled set.
const harness = (env: Record<string, string> = {}, beforeRefresh: () => Promise<void> = async () => {}) => {
    const environment: Record<string, string> = { ...floor, ...env };
    const module = Module.init({ env: environment });
    const stateRoot = mkdtempSync(join(tmpdir(), "plurnk-mcp-state-"));
    const stateDirectory = (workspaceId: number, owner: string): string => join(stateRoot, String(workspaceId), encodeURIComponent(owner));
    after(async () => { await module.stop(); await rm(stateRoot, { recursive: true, force: true }); });
    let refreshes = 0;
    const refreshOptions: unknown[] = [];
    const pendingRefreshes: Promise<void>[] = [];
    const actions = new Map<string, ActionRegistration>();
    const snapshots = new Map<number, { enabled: Map<string, object>; prepared: Prepared | null }>();
    let adapter: Adapter | undefined;
    let leases = 0;
    const retain = () => { leases++; let released = false; return () => { if (released) return; released = true; leases--; }; };
    const identity = (workspaceId: number) => ({ workspaceId });
    const lane = async (workspaceId: number, enabled: Map<string, object>, options: { failure?: "publish-unavailable" | "reject"; force?: string } = {}): Promise<Prepared> => {
        if (adapter === undefined) throw new Error("adapter not registered");
        const current = snapshots.get(workspaceId);
        const prepared = await adapter.prepare({
            ...identity(workspaceId), enabled: new Map([...enabled].map(([alias, definition]) => [alias, { definition }])), previous: current?.prepared?.snapshot ?? null,
            failure: options.failure ?? "publish-unavailable", ...(options.force ? { force: options.force } : {}), retain,
            progress: () => undefined,
        });
        await prepared.commit();
        snapshots.set(workspaceId, { enabled, prepared });
        return prepared;
    };
    const seam = {
        readWorkspacePlugins: async () => ({ plugins: [], roots: {} }),
        workspaceConfigurationDirectories: async () => [],
        workspaceStateDirectory: async (workspaceId: number, owner: string) => {
            const directory = stateDirectory(workspaceId, owner);
            mkdirSync(directory, { recursive: true });
            return directory;
        },
        readWorkspaceEnvironment: async () => (ambient = getDefaultEnvironment()) => ({ ...ambient }),
        operatorEnvironment: () => ({ ...getDefaultEnvironment() }),
        registerModuleAction: (registration: ActionRegistration): void => { actions.set(registration.name, registration); },
        registerFunctionalityAdapter: (candidate: Adapter) => {
            adapter = candidate;
            return {
                invoke: async (verb: string, params: unknown, id: { workspaceId: number }) => {
                    const current = snapshots.get(id.workspaceId);
                    if (current?.prepared == null) throw new Error("worker not prepared");
                    if (verb === "list") return { status: 200, body: { family: "mcp", definitions: [...current.prepared.outcomes].map(([alias, outcome]) => ({ alias, origin: "workspace", definition: current.enabled.get(alias), ...outcome })) } };
                    if (verb !== "enable") throw new Error(`harness does not emulate ${verb}`);
                    const alias = (params as { alias: string }).alias;
                    const prepared = await lane(id.workspaceId, current.enabled, { force: alias });
                    const outcome = prepared.outcomes.get(alias);
                    const status = outcome?.state === "authorization-required" ? 202 : 200;
                    return { status, body: { status, family: "mcp", alias, definition: { alias, origin: "workspace", ...outcome } } };
                },
                refresh: (id: { workspaceId: number }, options?: unknown) => {
                    refreshes++;
                    refreshOptions.push(options);
                    const pending = (async () => {
                        await beforeRefresh();
                        const current = snapshots.get(id.workspaceId);
                        if (current === undefined) return;
                        await lane(id.workspaceId, current.enabled);
                    })();
                    pendingRefreshes.push(pending);
                    return pending;
                },
            };
        },
    };
    return {
        module,
        seam,
        actions,
        snapshots,
        leases: () => leases,
        setup: () => module.setup(seam as never),
        environment,
        stateDirectory,
        refreshes: () => refreshes,
        refreshOptions: () => refreshOptions,
        settleRefreshes: () => Promise.all(pendingRefreshes),
        adapter: () => { if (adapter === undefined) throw new Error("adapter not registered"); return adapter; },
        identity,
        lane,
        teardown: async (workspaceId: number) => {
            const current = snapshots.get(workspaceId);
            await adapter!.teardown(current?.prepared?.snapshot ?? null, identity(workspaceId));
            snapshots.delete(workspaceId);
        },
        action: async (workspaceId: number, name: string, params: Readonly<Record<string, unknown>>) => {
            const registration = actions.get(name);
            if (registration === undefined) throw new Error(`missing action ${name}`);
            return registration.handler(params, { scope: "workspace", ...identity(workspaceId) });
        },
        runtimeTags: (workspaceId: number) => (snapshots.get(workspaceId)?.prepared?.runtimes ?? []).map(({ decl }) => decl.name),
    };
};


const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try { await access(pathname); return; } catch { await delay(10); }
    }
    await access(pathname);
};

const rejectsManagementProblem = async (run: () => Promise<unknown>, code: string, status: number): Promise<void> => {
    await assert.rejects(run, (error: unknown) => {
        const problem = (error as { problem?: Record<string, unknown> }).problem;
        assert.equal(problem?.type, `https://problems.plurnk.xyz/mcp/management/${code}`);
        assert.equal(problem?.status, status);
        return true;
    });
};

const httpHandler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "workspace-oauth-fixture", version: "1.0.0" });
    server.registerTool(
        "echo",
        { description: "Echo one message.", inputSchema: z.object({ message: z.string() }) },
        async ({ message }) => ({ content: [{ type: "text", text: String(message) }] }),
    );
    return server;
}, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

const interactiveOAuthFixture = (
    t: import("node:test").TestContext,
): ReturnType<typeof serveOAuthMcp> => serveOAuthMcp(t, httpHandler());

test("OAuth fixture denies missing, wrong, and replayed grants instead of rewarding sign-in bypass", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const token = (body: string) => fetch(`${origin}/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    for (const body of ["", "grant_type=client_credentials", "grant_type=authorization_code&code=wrong"]) {
        const response = await token(body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "invalid_grant");
    }
    const guessed = await fetch(served.url, { headers: { Authorization: "Bearer access-token" } });
    assert.equal(guessed.status, 401);
    await guessed.text();
    const grant = "grant_type=authorization_code&code=fixture-code";
    const accepted = await token(grant);
    assert.equal(accepted.status, 200);
    const credentials = await accepted.json();
    assert.equal(typeof credentials.access_token, "string");
    assert.notEqual(credentials.access_token, "access-token");
    const replay = await token(grant);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
});

const oauthDefinition = (served: { url: string }): McpServerDefinition => ({
    ...httpServer("oauth", served.url),
    authorization: {
        type: "oauth",
        redirectUrl: `${new URL(served.url).origin}/callback`,
        clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
        scope: "mcp:read",
    },
});

test("{§mcp-connection-shutdown} environment resolution cannot open a connection after producer stop", async (t) => {
    for (const operation of ["prepare"] as const) {
        await t.test(operation, async (t) => {
            let requests = 0;
            const served = await serveMcpHttp(t, httpHandler(), () => { requests++; return null; });
            const h = harness();
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const original = h.seam.readWorkspaceEnvironment;
            t.mock.method(h.seam, "readWorkspaceEnvironment", async () => {
                entered.resolve();
                await release.promise;
                return original();
            });
            await h.setup();
            t.after(async () => {
                release.resolve();
                if (h.snapshots.has(1)) await h.teardown(1);
                await h.module.stop();
            });
            const work = h.lane(1, new Map([["fixture", httpServer("fixture", served.url)]]));
            await entered.promise;
            const stopping = h.module.stop();
            assert.equal(h.module.stop(), stopping, "repeated producer stop joins the same settlement");
            await stopping;
            release.resolve();
            await assert.rejects(work, /MCP module is closed/);
            assert.equal(requests, 0, "no remote discovery, negotiation, or catalog request after stop");
        });
    }
});

test("{§mcp-definitions} configured servers are inspectable without installation or connection", async () => {
    const echo = stdio("echo");
    const remote = httpServer("remote", "https://mcp.example.test/mcp");
    const h = harness({ PLURNK_MCP_echo: JSON.stringify(echo), PLURNK_MCP_remote: JSON.stringify(remote), PLURNK_MCP_remote_ENABLED: "0" });
    await h.setup();
    try {
        assert.equal(h.adapter().family, "mcp");
        assert.deepEqual([...h.actions.keys()].toSorted(), ["workspace.mcp.complete", "workspace.mcp.oauth.begin", "workspace.mcp.oauth.complete"]);
        assert.deepEqual(await h.adapter().available(h.identity(1)), [
            { alias: "echo", definition: echo, enabled: true, provenance: { kind: "environment", source: "PLURNK_MCP_echo" } },
            { alias: "remote", definition: remote, enabled: false, provenance: { kind: "environment", source: "PLURNK_MCP_remote" } },
        ]);
        assert.equal(h.snapshots.size, 0, "inspection does not prepare a connection");
    } finally { await h.module.stop(); }
});

test("{§functionality-hotload} changed definitions use the coordinator's comparison inside the held turn", async () => {
    const h = harness();
    await h.setup();
    try {
        assert.deepEqual(await h.adapter().available(h.identity(1)), []);
        await h.adapter().refreshIfChanged(h.identity(1));
        assert.deepEqual(h.refreshOptions(), [{ gate: "none", ifChanged: true }]);
        h.environment.PLURNK_MCP_echo = JSON.stringify(stdio("echo"));
        assert.deepEqual((await h.adapter().available(h.identity(1))).map(({ alias }) => alias), ["echo"]);
    } finally { await h.module.stop(); }
});

test("{§mcp-server-settings} malformed controls remain inspectable after module setup and reject resolution", async () => {
    const h = harness({ PLURNK_MCP_future_TOOLS: "not json" });
    await h.setup();
    await assert.rejects(h.adapter().available(h.identity(1)), /PLURNK_MCP_future_TOOLS must be a JSON array of strings/u);
});

test("{§mcp-server-settings} a tool allowlist narrows the published tools", async () => {
    const h = harness({ PLURNK_MCP_echo_TOOLS: JSON.stringify(["echo"]) });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo", [fixture])]]));
        assert.deepEqual(prepared.runtimes[0]?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§configuration-repair-path} a noncanonical declaration does not prevent registration of the MCP manager", async () => {
    const h = harness({ PLURNK_MCP_GITEA: "npx" });
    await h.setup();
    await assert.rejects(h.adapter().available(h.identity(1)), /PLURNK_MCP_GITEA is not a declared control/u);
});

test("{§mcp-setup} preparation publishes one executor family and resource facet per enabled server, with catalog detail", async () => {
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo")]]));
        assert.deepEqual(h.runtimeTags(1), ["echo"]);
        const outcome = prepared.outcomes.get("echo");
        assert.equal(outcome?.state, "active");
        assert.ok((outcome as { detail?: { tools?: string[] } }).detail?.tools?.includes("echo"), "active outcomes carry the catalog tool names");
        assert.ok(prepared.runtimes[0]?.scheme, "the server's resource facet is published beside its executor");
        assert.equal(prepared.runtimes[0]?.decl.resourcesPath, "/tools");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-activation-isolation} a failed preparation rejects under reject and publishes unavailable under publish-unavailable, isolating healthy servers", async () => {
    const h = harness();
    await h.setup();
    try {
        await rejectsManagementProblem(
            () => h.lane(1, new Map([["broken", stdio("broken", ["/nonexistent/server.mjs"])]]), { failure: "reject" }),
            "server-unavailable", 502,
        );
        assert.equal(h.snapshots.has(1), false, "nothing was committed for the rejected preparation");
        const prepared = await h.lane(1, new Map([["echo", stdio("echo")], ["broken", stdio("broken", ["/nonexistent/server.mjs"])]]));
        assert.deepEqual(h.runtimeTags(1), ["echo"], "only the healthy server publishes a runtime");
        assert.equal(prepared.outcomes.get("echo")?.state, "active");
        const broken = prepared.outcomes.get("broken");
        assert.equal(broken?.state, "unavailable");
        assert.equal((broken as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        // A retry re-prepares only the forced alias and keeps the healthy attachment.
        const retried = await h.lane(1, new Map([["echo", stdio("echo")], ["broken", stdio("broken", ["/nonexistent/server.mjs"])]]), { force: "broken" });
        assert.equal(retried.outcomes.get("broken")?.state, "unavailable");
        assert.equal(retried.outcomes.get("echo")?.state, "active");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-catalog-deadline} activation publishes a stalled catalog as unavailable and explicit retry restores it", { timeout: 10000 }, async (t) => {
    let stalled = true;
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "stall", version: "1" });
        server.registerTool("echo", { inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "ready" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (stalled && body.method === "tools/list") await delay(1000, undefined, { signal: request.signal });
        return null;
    });
    const h = harness({ PLURNK_MCP_REQUEST_TIMEOUT: "3000" });
    await h.setup();
    try {
        const healthy = await h.lane(1, new Map([["echo", stdio("echo")]]));
        assert.equal(healthy.outcomes.get("echo")?.state, "active");
        // The catalog deadline must not also time the healthy stdio cold start.
        h.environment.PLURNK_MCP_CONNECT_TIMEOUT = "500";
        const diagnostic = t.mock.method(console, "error");
        const enabled = new Map<string, McpServerDefinition>([
            ["stall", httpServer("stall", served.url)],
            ["echo", stdio("echo")],
        ]);
        const prepared = await h.lane(1, enabled);
        const unavailable = prepared.outcomes.get("stall");
        assert.equal(unavailable?.state, "unavailable");
        if (unavailable?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(unavailable.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.ok(served.requests.some(({ body }) => (body as { method?: string })?.method === "tools/list"), "the failing connection reached catalog discovery");
        assert.equal(diagnostic.mock.callCount(), 1, "only the stalled catalog failed");
        const cause: unknown = diagnostic.mock.calls[0]!.arguments[1];
        assert.ok(cause instanceof DOMException && cause.name === "TimeoutError"
            || SdkError.isInstance(cause) && cause.code === SdkErrorCode.RequestTimeout, String(cause));
        assert.deepEqual(h.runtimeTags(1), ["echo"], "a silent catalog does not prevent publishing other tools");
        assert.equal(prepared.runtimes[0], healthy.runtimes[0], "the healthy connection remains in service");
        stalled = false;
        const retry = await h.lane(1, enabled, { force: "stall" });
        assert.equal(retry.outcomes.get("stall")?.state, "active");
        assert.deepEqual(h.runtimeTags(1).toSorted(), ["echo", "stall"]);
        assert.equal(retry.runtimes.find(({ decl }) => decl.name === "echo"), healthy.runtimes[0], "retry replaces only the failed attachment");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-setup} commit closes connections the next snapshot no longer uses; abort closes only what the attempt opened; teardown closes the rest", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-adapter-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const marker = (name: string) => join(temp, `${name}.closed`);
    const started = (name: string) => join(temp, `${name}.started`);
    const withMarker = (name: string) => stdio(name, [fixture], { env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker(name), PLURNK_MCP_TEST_START_MARKER: started(name) } });
    // #429 — on a failure, say which processes existed and which one wrote the marker.
    const processes = async (name: string) => `started=[${(await readFile(started(name), "utf8").catch(() => "")).trim().split("\n").join(",")}] closed=${JSON.stringify(await readFile(marker(name), "utf8").catch(() => null))}`;
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["a", withMarker("a")], ["b", withMarker("b")]]));
        assert.deepEqual(h.runtimeTags(1), ["a", "b"]);
        await h.lane(1, new Map([["a", withMarker("a")]]));
        await waitForFile(marker("b"));
        assert.deepEqual(h.runtimeTags(1), ["a"], "the removed server's connection closed after the replacement committed");

        // abort: a fresh connection is opened, then discarded; the committed one survives.
        const attempt = await h.adapter().prepare({ ...h.identity(1), enabled: new Map([["a", { definition: withMarker("a") }], ["c", { definition: withMarker("c") }]]), previous: h.snapshots.get(1)!.prepared!.snapshot, failure: "reject", retain: () => () => undefined, progress: () => undefined });
        assert.equal(attempt.outcomes.get("c")?.state, "active");
        await attempt.abort();
        await waitForFile(marker("c"));
        assert.deepEqual(h.runtimeTags(1), ["a"]);
        // {§mcp-catalog-refresh-in-place} — the SDK's connect probes a stdio server on a disposable
        // sibling process; its exit writes the marker too. The committed server is the last started.
        const committedA = (await readFile(started("a"), "utf8")).trim().split("\n").at(-1)!.split(" ")[0]!;
        const closedA = await readFile(marker("a"), "utf8").catch(() => null);
        assert.ok(closedA === null || !closedA.split("\n").some((line) => line.trim() === `closed ${committedA}`), `the committed attachment was not touched by the aborted attempt (${await processes("a")})`);

        await h.teardown(1);
        await waitForFile(marker("a"));
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} a URL-only server hands authorization to the client without changing its definition", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const definition = httpServer("oauth", served.url);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", definition]]));
        assert.deepEqual(prepared.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
        assert.equal(h.leases(), 0, "no pending browser attempt before the client begins");
        assert.deepEqual(h.runtimeTags(1), []);
        const started = await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }) as { status: number; authorization: { url: string } };
        assert.equal(started.status, 202);
        const url = new URL(started.authorization.url);
        assert.equal(h.snapshots.get(1)?.prepared, prepared, "starting sign-in does not publish or enable capabilities");
        assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:54321/callback");
        assert.equal(h.leases(), 1);
        const callback = new URL("http://127.0.0.1:54321/callback");
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("iss", origin);
        await h.lane(1, new Map([["oauth", definition]]));
        assert.equal(h.leases(), 1, "an unchanged publication cannot discard the client's independent sign-in attempt");
        const completed = await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: callback.href }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.deepEqual(h.snapshots.get(1)?.enabled.get("oauth"), definition, "the client callback is session state, not configuration");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} beginning sign-in can discover usable tools without publishing into a held workspace", async (t) => {
    let challenged = true;
    const served = await serveMcpHttp(t, httpHandler(), () => challenged ? new Response("unauthorized", { status: 401 }) : null);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = httpServer("oauth", served.url);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        assert.equal(initial.outcomes.get("oauth")?.state, "authorization-required");
        challenged = false;
        const begin = () => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        });
        assert.deepEqual(await begin(), { status: 202, alias: "oauth" });
        assert.deepEqual(await begin(), { status: 202, alias: "oauth" });
        assert.equal(h.refreshes(), 1);
        assert.equal(h.leases(), 1);
        assert.equal(h.snapshots.get(1)?.prepared, initial);
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.deepEqual(await begin(), { status: 200, alias: "oauth" });
    } finally { release.resolve(); await h.module.stop(); }
});

for (const [option, code] of [["metadata", "oauth-metadata-unavailable"], ["registration", "oauth-registration-unavailable"]] as const) {
    test(`{§oauth-continuation} missing OAuth ${option} is a setup diagnostic, not retryable downtime`, async (t) => {
        const { served } = await serveOAuthMcp(t, httpHandler(), { [option]: false });
        const h = harness();
        await h.setup();
        try {
            const definition = httpServer("oauth", served.url);
            await h.lane(1, new Map([["oauth", definition]]));
            await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
                alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
            }), code, 502);
            assert.equal(h.leases(), 0, "failed setup leaves no pending credential flow");
            assert.deepEqual(h.snapshots.get(1)?.prepared?.outcomes.get("oauth"), { state: "authorization-required", authorization: {} });
            assert.deepEqual(h.snapshots.get(1)?.enabled.get("oauth"), definition, "the inspectable definition survives failed sign-in setup");
        } finally { await h.module.stop(); }
    });
}

test("{§oauth-continuation} rejected explicit credentials are not reported as retryable downtime", async (t) => {
    const { served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", {
            ...httpServer("oauth", served.url), headers: { Authorization: "Bearer wrong-token" },
        }]]));
        const outcome = prepared.outcomes.get("oauth");
        assert.equal(outcome?.state, "unavailable");
        assert.equal((outcome as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-authentication-failed");
        assert.equal((outcome as { problem: ProblemDetails }).problem.retryable, false);
        assert.doesNotMatch(JSON.stringify(outcome), /wrong-token/);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback",
        }), "oauth-configuration-conflict", 409);
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} client callbacks cannot replace fixed redirects or target nonlocal HTTP", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const count = served.requests.length;
        for (const redirectUrl of ["http://example.test/callback", "file:///callback", "http://127.0.0.1:0/callback", "https://user:secret@example.test/callback"]) {
            await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }), "oauth-redirect-invalid", 400);
        }
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: `${origin}/different`,
        }), "oauth-configuration-conflict", 409);
        assert.equal(served.requests.length, count, "invalid callbacks cause no remote traffic");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} a later client attempt invalidates the old callback and publishes only the new one", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    const redirectUrl = "http://127.0.0.1:54321/callback";
    try {
        await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        const begin = async () => {
            const result = await h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }) as { authorization: { url: string } };
            const url = new URL(redirectUrl);
            url.searchParams.set("state", new URL(result.authorization.url).searchParams.get("state")!);
            url.searchParams.set("code", "fixture-code");
            url.searchParams.set("iss", origin);
            return url.href;
        };
        const stale = await begin();
        const current = await begin();
        assert.notEqual(stale, current);
        assert.equal(h.leases(), 1);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: stale }), "oauth-callback-invalid", 400);
        await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: current });
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: current }), "oauth-not-pending", 404);
        const ready = await h.action(1, "workspace.mcp.oauth.begin", { alias: "oauth", redirectUrl }) as { status: number };
        assert.equal(ready.status, 200, "an already active connection is not replaced");
    } finally { await h.module.stop(); }
});

test("{§oauth-continuation} removal during client preparation prevents a late authorization publication", async (t) => {
    const { served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const environment = h.seam.readWorkspaceEnvironment;
        h.seam.readWorkspaceEnvironment = async () => { entered.resolve(); await release.promise; return environment(); };
        const start = { alias: "oauth", redirectUrl: "http://127.0.0.1:54321/callback" };
        const result = rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", start), "oauth-target-conflict", 409);
        await entered.promise;
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.begin", start), "oauth-busy", 409);
        await h.lane(1, new Map());
        release.resolve();
        await result;
        assert.deepEqual(h.runtimeTags(1), []);
        assert.equal(h.leases(), 0);
    } finally { await h.module.stop(); }
});

test("{§oauth-lifetime} an accepted OAuth callback holds residency until ordinary catalog publication", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const outcome = prepared.outcomes.get("oauth");
        assert.equal(outcome?.state, "authorization-required");
        assert.deepEqual(h.runtimeTags(1), [], "a challenged server publishes no runtime");
        assert.equal(h.leases(), 1, "the pending authorization holds one residency lease");
        await assert.rejects(() => h.teardown(1), /cannot cool with pending OAuth residency/);
        const state = new URL((outcome as { authorization: { url: string } }).authorization.url).searchParams.get("state");
        assert.ok(state);
        const completed = await h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["oauth"], "the authorized server is published through catalog refresh");
        assert.equal(h.leases(), 0, "the pending lease was released on publication");
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=x&state=y` }), "oauth-not-pending", 404);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

for (const change of ["none", "withdraw", "replace"] as const) {
test(`{§oauth-continuation} accepted callbacks are coalesced and publication respects ${change}`, { timeout: 10000 }, async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = oauthDefinition(served);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        const outcome = initial.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        const params = { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` };
        const complete = () => h.action(1, "workspace.mcp.oauth.complete", params);
        const accepted = { status: 202, alias: "oauth" };
        assert.deepEqual(await Promise.all([complete(), complete()]), [accepted, accepted]);
        assert.equal(tokenRequests.length, 1, "one grant exchange for concurrent callbacks");
        assert.deepEqual(h.runtimeTags(1), [], "the callback does not bypass publication");
        assert.equal(h.refreshes(), 1, "duplicate callbacks do not schedule duplicate publication");
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.begin", {
            alias: "oauth", redirectUrl: `${origin}/callback`,
        }), accepted, "beginning again cannot replace a grant already awaiting publication");
        if (change === "withdraw") await h.lane(1, new Map());
        if (change === "replace") await h.lane(1, new Map([["oauth", { ...definition, headers: { "X-Replacement": "1" } }]]));
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), change === "none" ? ["oauth"] : []);
        assert.equal(h.leases(), change === "replace" ? 1 : 0);
        assert.equal(tokenRequests.length, 1, "publication never replays the grant");
        if (change !== "none") {
            assert.equal(h.snapshots.get(1)?.prepared?.outcomes.get("oauth")?.state,
                change === "replace" ? "authorization-required" : undefined, "old acceptance cannot restore or authorize the replacement");
        }
    } finally { release.resolve(); await h.module.stop(); }
});
}

test("{§oauth-continuation} failed preparation after an accepted grant publishes its diagnostic and closes the candidate", async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    const close = t.mock.method(ServerConnection.prototype, "close");
    const errors = t.mock.method(console, "error", () => {});
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const outcome = prepared.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }), { status: 202, alias: "oauth" });
        h.environment.PLURNK_MCP_oauth_TOOLS = "not json";
        release.resolve();
        await h.settleRefreshes();
        const unavailable = h.snapshots.get(1)?.prepared?.outcomes.get("oauth");
        assert.equal(unavailable?.state, "unavailable");
        assert.equal((unavailable as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-settings-invalid");
        assert.equal(errors.mock.callCount(), 1, "the preparation failure remains visible");
        assert.equal(h.leases(), 0);
        assert.deepEqual(h.runtimeTags(1), []);
        assert.equal(close.mock.callCount(), 1, "the unpublishable authorized candidate is closed, not orphaned");
        assert.equal(tokenRequests.length, 1);
    } finally { release.resolve(); await h.module.stop(); }
});

test("{§oauth-continuation} aborting publication retains the accepted grant for the next preparation", async (t) => {
    const { origin, served, tokenRequests } = await interactiveOAuthFixture(t);
    const release = Promise.withResolvers<void>();
    const h = harness({}, () => release.promise);
    await h.setup();
    try {
        const definition = oauthDefinition(served);
        const initial = await h.lane(1, new Map([["oauth", definition]]));
        const outcome = initial.outcomes.get("oauth") as { authorization: { url: string } };
        const state = new URL(outcome.authorization.url).searchParams.get("state")!;
        const params = { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` };
        const accepted = { status: 202, alias: "oauth" };
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", params), accepted);
        const attempt = await h.adapter().prepare({
            ...h.identity(1), enabled: new Map([["oauth", { definition }]]), previous: initial.snapshot,
            failure: "publish-unavailable", retain: () => () => {}, progress: () => {},
        });
        assert.equal(attempt.outcomes.get("oauth")?.state, "active");
        await attempt.abort();
        assert.equal(h.leases(), 1);
        assert.deepEqual(h.runtimeTags(1), []);
        assert.deepEqual(await h.action(1, "workspace.mcp.oauth.complete", params), accepted);
        release.resolve();
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["oauth"]);
        assert.equal(h.leases(), 0);
        assert.equal(tokenRequests.length, 1, "a discarded capability publication never replays the authorization code");
    } finally { release.resolve(); await h.module.stop(); }
});

test("{§oauth-lifetime} withdrawing a server with a pending authorization clears the attempt and releases its residency", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const url = (prepared.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        assert.equal(h.leases(), 1);
        await h.lane(1, new Map());
        assert.equal(h.leases(), 0, "the withdrawn alias's pending attempt released its lease");
        const state = new URL(url).searchParams.get("state")!;
        await rejectsManagementProblem(
            () => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}` }),
            "oauth-not-pending", 404,
        );
        await h.teardown(1);
    } finally { await h.module.stop(); }
});

test("{§oauth-lifetime} a superseded authorization attempt cannot complete a replacement, and a changed target conflicts", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        // The definition changes underneath the pending authorization: the new
        // challenge supersedes the old one and holds the single lease.
        const changed = { ...oauthDefinition(served), headers: { "X-Changed": "1" } };
        await h.lane(1, new Map([["oauth", changed]]));
        assert.equal(h.leases(), 1, "the superseded attempt released its lease; the replacement holds one");
        const staleState = new URL(firstUrl).searchParams.get("state")!;
        await rejectsManagementProblem(
            () => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(staleState)}&iss=${encodeURIComponent(origin)}` }),
            "oauth-callback-invalid", 400,
        );
        // A committed attachment that no longer matches the pending definition conflicts.
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", oauthDefinition(served)]]));
        assert.equal(h.leases(), 1);
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", oauthDefinition(served)]]), { force: "oauth" });
        const replacementState = new URL((h.snapshots.get(1)!.prepared!.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url).searchParams.get("state")!;
        const completed = await h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(replacementState)}&iss=${encodeURIComponent(origin)}` }) as { status: number };
        assert.equal(completed.status, 202);
        await h.settleRefreshes();
        assert.deepEqual(h.runtimeTags(1), ["echo", "oauth"]);
        assert.equal(h.leases(), 0);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

test("{§oauth-lifetime} a replacement without authorization discards the pending credential flow", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        const replacement = await h.lane(1, new Map([["oauth", httpServer("oauth", served.url)]]));
        assert.deepEqual(replacement.outcomes.get("oauth"), { state: "authorization-required", authorization: {} },
            "the replacement sees the challenge but does not inherit the pending authorization URL");
        assert.equal(h.leases(), 0, "a superseded flow cannot retain the workspace");
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", {
            alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(new URL(firstUrl).searchParams.get("state")!)}`,
        }), "oauth-not-pending", 404);
    } finally { await h.module.stop(); }
});

test("{§mcp-authority} a legacy peer negotiates below the pin and serves its standard catalog", async () => {
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["legacy", stdio("legacy", [legacyFixture])]]));
        const outcome = prepared.outcomes.get("legacy") as { state: string; detail?: { protocolVersion?: string } };
        assert.equal(outcome.state, "active");
        assert.equal(outcome.detail?.protocolVersion, "2025-06-18");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-module} completion routes to the connected server and refuses a disconnected one", async () => {
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.complete", { server: "missing", ref: {}, argument: {} }), "server-not-connected", 409);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.complete", { server: "echo", ref: "x", argument: {} }), "completion-parameters-invalid", 400);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-setup} shutdown closes every connection and aggregates failures", async () => {
    const closed: string[] = [];
    await closeConnections([
        { close: async () => { closed.push("a"); } },
        { close: async () => { throw new Error("b failed"); } },
        { close: async () => { closed.push("c"); } },
    ]).catch((error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
    });
    assert.deepEqual(closed, ["a", "c"]);
});


test("{§mcp-catalog-refresh-in-place} a catalog change rebuilds the executor on the connection the alias holds: one process, nothing closed (#429)", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-refresh-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const marker = join(temp, "a.closed");
    const started = join(temp, "a.started");
    const instructions = "Echo tools for transport testing.\n\n## Usage\nPass the message field unchanged.";
    const definition = stdio("a", [fixture], { env: {
        PLURNK_MCP_TEST_CLOSE_MARKER: marker,
        PLURNK_MCP_TEST_START_MARKER: started,
        PLURNK_MCP_TEST_LIST_CHANGED_AFTER_MS: "150",
        PLURNK_MCP_TEST_TITLE: "Transport fixture",
        PLURNK_MCP_TEST_INSTRUCTIONS: instructions,
    } });
    const h = harness();
    await h.setup();
    console.error("[429-probe] test pid", process.pid, "ppid", process.ppid);
    try {
        const first = await h.lane(1, new Map([["a", definition]]));
        assert.deepEqual(h.runtimeTags(1), ["a"]);
        assert.deepEqual(first.runtimes[0]?.decl.summary, { from: "tools", description: "Echo tools for transport testing." });
        assert.equal(first.runtimes[0]?.decl.details, instructions);
        const connectStarts = (await readFile(started, "utf8")).trim().split("\n").filter((line) => line.length > 0).length;
        assert.ok(connectStarts >= 1 && connectStarts <= 2, `connect starts the real server and at most the SDK's probe sibling; got ${connectStarts}`);
        // The notification arrives ~150ms after connect; the scheduled refresh re-prepares the worker.
        for (let attempt = 0; attempt < 300; attempt += 1) {
            if (h.snapshots.get(1)?.prepared !== first) break;
            await delay(10);
        }
        assert.notEqual(h.snapshots.get(1)?.prepared, first, "the catalog change drove a refresh");
        assert.deepEqual(h.runtimeTags(1), ["a"], "the alias stays in service");
        assert.equal(h.snapshots.get(1)?.prepared?.runtimes[0]?.decl.details, instructions, "catalog refresh retains the complete on-demand instructions");
        // Connect starts the SDK's disposable probe sibling and then the real server; a refresh
        // on the held connection starts nothing more, and never closes the committed server.
        const pids = (await readFile(started, "utf8")).trim().split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]!);
        assert.equal(pids.length, connectStarts, `no server was started by the refresh; started=${pids.join(",")}`);
        const committed = pids.at(-1)!;
        const closedBefore = await readFile(marker, "utf8").catch(() => "");
        assert.ok(!closedBefore.includes(`closed ${committed}`), "the held connection was never closed by the refresh");
        await h.teardown(1);
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if ((await readFile(marker, "utf8").catch(() => "")).includes(`closed ${committed}`)) break;
            await delay(10);
        }
        assert.ok((await readFile(marker, "utf8").catch(() => "")).includes(`closed ${committed}`), "teardown closes the committed server");
    } finally {
        if (h.snapshots.has(1)) await h.teardown(1).catch(() => undefined);
    }
});

test("{§mcp-catalog-refresh-in-place} withdrawing an attachment retires its pending catalog retry", async (t) => {
    let failListing = false;
    let lists = 0;
    const handler = httpHandler();
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (body.method !== "tools/list") return null;
        lists++;
        return failListing ? Response.json({ jsonrpc: "2.0", id: body.id,
            error: { code: -32603, message: "Transient fixture listing failure." },
        }) : null;
    });
    const h = harness();
    await h.setup();
    t.after(() => h.module.stop());
    const first = await h.lane(1, new Map([["fixture", httpServer("fixture", served.url)]]));
    failListing = true;
    handler.notify.toolsChanged();
    for (let attempt = 0; attempt < 300 && h.snapshots.get(1)?.prepared === first; attempt++) await delay(10);
    assert.notEqual(h.snapshots.get(1)?.prepared, first, "the failed refresh finished, retaining its pending retry");
    assert.equal(lists, 2);
    const withdrawn = await h.lane(1, new Map());
    await delay(750);
    assert.equal(h.snapshots.get(1)?.prepared, withdrawn, "no retired timer republishes the empty attachment set");
    assert.equal(lists, 2, "withdrawal causes no further remote catalog requests");
    assert.deepEqual(h.runtimeTags(1), []);
});

test("{§mcp-launch-directory} direct servers use workspace-owned state and retain their exact definitions", async () => {
    const h = harness();
    await h.setup();
    try {
        const definition = { name: "added", type: "stdio", command: process.execPath, args: [fixture] };
        const admitted = await h.adapter().admit({ definition }, h.identity(1));
        assert.deepEqual(admitted, { alias: "added", definition });
        for (const workspaceId of [1, 2]) {
            const prepared = await h.lane(workspaceId, new Map([["added", admitted.definition]]));
            assert.equal(prepared.outcomes.get("added")?.state, "active");
            assert.ok(existsSync(h.stateDirectory(workspaceId, "@plurnk/plurnk-mcp/added")));
            assert.deepEqual((prepared.snapshot as Map<string, { definition: unknown }>).get("added")?.definition, definition);
        }
        assert.notEqual(h.stateDirectory(1, "@plurnk/plurnk-mcp/added"), h.stateDirectory(2, "@plurnk/plurnk-mcp/added"));
        await h.teardown(1);
        assert.ok(existsSync(h.stateDirectory(1, "@plurnk/plurnk-mcp/added")), "withdrawal retains state, not a plugin installation");
    } finally { await h.module.stop(); }
});

test("{§mcp-server-definition} add admits a complete connection without installation scope or provenance", async () => {
    const h = harness();
    await h.setup();
    try {
        const admit = (definition: object, alias?: string) => h.adapter().admit({ definition, ...(alias === undefined ? {} : { alias }) }, h.identity(1));
        const refused = (definition: object, code: string, alias?: string) => rejectsManagementProblem(() => admit(definition, alias), code, 400);
        await refused({ name: "echo", type: "stdio", command: "node" }, "alias-mismatch", "other");
        await refused({ name: "echo", scope: "project", type: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", plugin: {}, type: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", transport: "stdio", command: "node" }, "definition-invalid");
        for (const command of ["node", "./bin/server", "/usr/bin/node"]) {
            const definition = { name: "echo", type: "stdio", command };
            assert.deepEqual(await admit(definition), { alias: "echo", definition });
        }
        const remote = httpServer("remote", "https://mcp.example.test/mcp");
        assert.deepEqual(await admit(remote), { alias: "remote", definition: remote });
    } finally { await h.module.stop(); }
});

// A registry answering the v0.1 server list exactly as the official MCP Registry does.
const serveRegistry = async (t: { after(fn: () => unknown): void }, listener: RequestListener): Promise<string> => {
    const registry = createServer(listener);
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
    return `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
};

test("{§mcp-registry-discovery} discover searches the registry by query and offers each server's entries as complete workspace definitions", async (t) => {
    const requests: string[] = [];
    const url = await serveRegistry(t, (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            servers: [{ server: { name: "io.github.example/example-server", version: "1.2.3", description: "Search the example index.", packages: [{ registryType: "npm", identifier: "@example/server", version: "1.2.3", transport: { type: "stdio" } }] }, _meta: {} }],
            metadata: { count: 1 },
        }));
    });
    const h = harness({ PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "5" });
    await h.setup();
    try {
        assert.deepEqual(await h.adapter().discover({ query: "example" }, h.identity(1)), [{
            alias: "example-server",
            summary: "Search the example index. — npx -y @example/server@1.2.3",
            definition: { name: "example-server", type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3"] },
            provenance: { kind: "registry", source: url, reference: "io.github.example/example-server@1.2.3" },
        }]);
        assert.deepEqual(requests, ["/v0.1/servers?search=example&version=latest&limit=5"]);
        assert.deepEqual(await h.adapter().discover({}, h.identity(1)), [], "discovery without a query offers nothing");
        await rejectsManagementProblem(() => h.adapter().discover({ source: "https://example.com/plugin.git" }, h.identity(1)), "source-unsupported", 400);
        await rejectsManagementProblem(() => h.adapter().discover({ configuration: {} }, h.identity(1)), "configuration-unsupported", 400);
    } finally { await h.module.stop(); }
});

test("{§mcp-registry-discovery} a registry that is off or failing is a Problem, never an empty result", async (t) => {
    const url = await serveRegistry(t, (_request, response) => { response.writeHead(500).end(); });
    for (const [registry, code, status] of [["", "registry-not-configured", 501], [url, "discover-failed", 502]] as const) {
        const h = harness({ PLURNK_MCP_REGISTRY_URL: registry, PLURNK_MCP_REGISTRY_LIMIT: "5" });
        await h.setup();
        try {
            await rejectsManagementProblem(() => h.adapter().discover({ query: "example" }, h.identity(1)), code, status);
        } finally { await h.module.stop(); }
    }
});
