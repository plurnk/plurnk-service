// {§mcp-module} — the MCP family as a workspace Functionality adapter. These tests
// drive the adapter contract directly (plugin-provided definitions, two-phase
// preparation, OAuth continuation, isolation, refresh, hot reload, teardown). The lifecycle verbs, durable state, and both projections belong to
// the coordinator and are covered where it composes with this module.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import type McpExecutor from "./McpExecutor.ts";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import Module, { closeConnections } from "./Module.ts";
import { fixturePlugin, httpServer, stdioServer as stdio } from "../test/definitions.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const legacyFixture = fileURLToPath(new URL("./fixtures/legacy-server.mjs", import.meta.url));
const floor = {
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
    | { state: "authorization-required"; authorization: { url: string } };

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
    forget(source: { alias: string; definition: object }, identity: { workspaceId: number }): Promise<void>;
    refreshIfChanged(identity: { workspaceId: number }): Promise<void>;
    prepare(preparation: {
        workspaceId: number;
        enabled: ReadonlyMap<string, object>; previous: unknown | null;
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
// One installed plugin as the seam reports it: its identity and the mcp.json servers it declares.
type HarnessPlugin = { readonly scope: string; readonly root: string; readonly data: string; readonly manifest: { readonly name: string }; readonly mcpServers: ReadonlyMap<string, object> | null };
const plugin = (name: string, servers: Record<string, object>): HarnessPlugin => ({
    scope: "global", root: fixturePlugin.root, data: fixturePlugin.data, manifest: { name }, mcpServers: new Map(Object.entries(servers)),
});
type Scope = "project" | "plurnk" | "global";

// The plugin roots core owns, under one temporary directory; `project: null` is a workspace without one.
const pluginRoots = (options: { project?: boolean } = {}): Record<Scope, string | null> => {
    const base = mkdtempSync(join(tmpdir(), "plurnk-mcp-roots-"));
    const root = (scope: Scope): string => { const dir = join(base, scope); mkdirSync(dir, { recursive: true }); return dir; };
    return { project: options.project === false ? null : root("project"), plurnk: root("plurnk"), global: root("global") };
};

const harness = (env: Record<string, string> = {}, installed: readonly HarnessPlugin[] = [], roots: Record<Scope, string | null> = pluginRoots()) => {
    const module = Module.init({ env: { ...floor, ...env } });
    let plugins = installed;
    const written: Array<{ scope: Scope; name: string }> = [];
    let refreshes = 0;
    const refreshOptions: unknown[] = [];
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
            ...identity(workspaceId), enabled, previous: current?.prepared?.snapshot ?? null,
            failure: options.failure ?? "publish-unavailable", ...(options.force ? { force: options.force } : {}), retain,
            progress: () => undefined,
        });
        await prepared.commit();
        snapshots.set(workspaceId, { enabled, prepared });
        return prepared;
    };
    const seam = {
        readWorkspacePlugins: async () => ({
            plugins,
            signature: JSON.stringify(plugins.map((entry) => [entry.root, entry.manifest.name, entry.mcpServers === null ? null : [...entry.mcpServers]])),
            roots,
        }),
        // Core's write, as the seam promises it: the one-server plugin, or exactly that plugin already there.
        writeServerPlugin: async (_workspaceId: number, { scope, name, entry }: { scope: Scope; name: string; entry: object }) => {
            const root = roots[scope];
            if (root === null) return { kind: "unrooted" };
            const directory = join(root, name);
            const declaration = JSON.stringify({ mcpServers: { [name]: entry } });
            if (existsSync(directory)) {
                const present = existsSync(join(directory, "mcp.json")) ? JSON.stringify({ mcpServers: JSON.parse(readFileSync(join(directory, "mcp.json"), "utf8")).mcpServers }) : null;
                return present === declaration ? { kind: "written", root: directory, data: fixturePlugin.data, created: false } : { kind: "occupied", directory };
            }
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, "plugin.json"), JSON.stringify({ name }));
            writeFileSync(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { [name]: entry } }));
            written.push({ scope, name });
            return { kind: "written", root: directory, data: fixturePlugin.data, created: true };
        },
        deleteServerPlugin: async (_workspaceId: number, { scope, name }: { scope: Scope; name: string }) => {
            const root = roots[scope];
            if (root !== null) rmSync(join(root, name), { recursive: true, force: true });
        },
        readWorkspaceEnvironment: async () => (ambient = getDefaultEnvironment()) => ({ ...ambient }),
        pluginEnvironment: () => ({ ...getDefaultEnvironment() }),
        registerModuleAction: (registration: ActionRegistration): void => { actions.set(registration.name, registration); },
        registerFunctionalityAdapter: (candidate: Adapter) => {
            adapter = candidate;
            return {
                invoke: async (verb: string, params: unknown, id: { workspaceId: number }) => {
                    // The only re-entry the adapter uses: re-enable one alias (retry).
                    if (verb !== "enable") throw new Error(`harness does not emulate ${verb}`);
                    const alias = (params as { alias: string }).alias;
                    const current = snapshots.get(id.workspaceId);
                    if (current === undefined) throw new Error("worker not prepared");
                    const prepared = await lane(id.workspaceId, current.enabled, { force: alias });
                    const outcome = prepared.outcomes.get(alias);
                    return { status: outcome?.state === "authorization-required" ? 202 : 200, body: { status: 200, family: "mcp", alias, definition: { alias, origin: "worker", ...outcome } } };
                },
                refresh: async (id: { workspaceId: number }, options?: unknown) => {
                    refreshes++;
                    refreshOptions.push(options);
                    const current = snapshots.get(id.workspaceId);
                    if (current === undefined) return;
                    await lane(id.workspaceId, current.enabled);
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
        install: (next: readonly HarnessPlugin[]) => { plugins = next; },
        roots,
        written,
        refreshes: () => refreshes,
        refreshOptions: () => refreshOptions,
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
                headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
            });
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"] });
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
            return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    return { origin, served };
};

// {§mcp-server-settings} — the interactive OAuth an operator states for the `oauth` alias.
const oauthSettings = (origin: string): Record<string, string> => ({
    PLURNK_MCP_OAUTH_OAUTH: JSON.stringify({
        type: "oauth",
        redirectUrl: `${origin}/callback`,
        clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
        scope: "mcp:read",
    }),
});
const oauthDefinition = (served: { url: string }): McpServerDefinition => httpServer("oauth", served.url);

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

test("{§mcp-plugin-servers} the family has every lifecycle verb, and every installed plugin's server is available, enabled, at its root's scope", async () => {
    const h = harness({}, [
        plugin("tools", { echo: { type: "stdio", command: "node", args: [fixture] }, remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" } }),
    ]);
    await h.setup();
    try {
        assert.equal(h.adapter().family, "mcp");
        assert.equal(h.adapter().namespaceOwner, "@plurnk/plurnk-mcp");
        for (const verb of ["discover", "admit", "forget"] as const) assert.equal(typeof h.adapter()[verb], "function", `the adapter implements ${verb}`);
        assert.deepEqual([...h.actions.keys()].toSorted(), ["workspace.mcp.complete", "workspace.mcp.oauth.complete"]);
        const available = await h.adapter().available(h.identity(1));
        assert.deepEqual(available.map(({ alias, enabled }) => ({ alias, enabled })), [{ alias: "echo", enabled: true }, { alias: "remote", enabled: true }]);
        assert.deepEqual(available[0]!.definition, { name: "echo", scope: "global", plugin: { name: "tools", root: fixturePlugin.root, data: fixturePlugin.data }, type: "stdio", command: "node", args: [fixture] });
        assert.equal((available[1]!.definition as McpServerDefinition).type, "streamable-http");
    } finally { await h.module.stop(); }
});

test("{§mcp-plugin-servers} an sse entry, an unrepresentable name, and an alias an earlier plugin declares are skipped", async (t) => {
    const reports: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { reports.push(args.map(String).join(" ")); });
    const h = harness({}, [
        plugin("first", { echo: { type: "stdio", command: "node", args: [fixture] }, legacy: { type: "sse", url: "https://legacy.example.test/sse" }, Bad_Name: { type: "stdio", command: "node" } }),
        plugin("second", { echo: { type: "stdio", command: "node" } }),
    ]);
    await h.setup();
    try {
        assert.deepEqual((await h.adapter().available(h.identity(1))).map(({ alias }) => alias), ["echo"]);
        assert.ok(reports.some((line) => line.includes("'legacy'") && line.includes("HTTP+SSE")));
        assert.ok(reports.some((line) => line.includes("'Bad_Name'") && line.includes("[a-z][a-z0-9-]*")));
        assert.ok(reports.some((line) => line.includes("'echo' of plugin 'second'") && line.includes("plugin 'first' declares it first")));
        const before = reports.length;
        await h.adapter().available(h.identity(1));
        assert.equal(reports.length, before, "an unchanged plugin set is reported once");
    } finally { await h.module.stop(); }
});

test("{§functionality-hotload} out-of-band plugin changes go to the coordinator's comparison, inside the held turn", async () => {
    const h = harness({}, []);
    await h.setup();
    try {
        assert.deepEqual(await h.adapter().available(h.identity(1)), []);
        await h.adapter().refreshIfChanged(h.identity(1));
        assert.deepEqual(h.refreshOptions(), [{ gate: "none", ifChanged: true }],
            "the coordinator, which alone knows what it published, decides whether anything changed");
        h.install([plugin("tools", { echo: { type: "stdio", command: "node", args: [fixture] } })]);
        assert.deepEqual((await h.adapter().available(h.identity(1))).map(({ alias }) => alias), ["echo"], "what is available is read fresh");
    } finally { if (h.snapshots.has(1)) await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-server-settings} an invalid operator setting isolates its server as unavailable", async () => {
    const h = harness({ PLURNK_MCP_BROKEN_TOOLS: "not json" });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo", [fixture])], ["broken", stdio("broken", [fixture])]]));
        assert.equal(prepared.outcomes.get("echo")?.state, "active");
        const broken = prepared.outcomes.get("broken");
        assert.equal(broken?.state, "unavailable");
        assert.equal((broken as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-settings-invalid");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-server-settings} a tool allowlist narrows the published tools", async () => {
    const h = harness({ PLURNK_MCP_ECHO_TOOLS: JSON.stringify(["echo"]) });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo", [fixture])]]));
        assert.deepEqual(prepared.runtimes[0]?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-configuration} a retired variable fails the module at boot", () => {
    assert.throws(() => Module.init({ env: { ...floor, PLURNK_MCP_GITEA: "npx" } }), /PLURNK_MCP_GITEA is retired/u);
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
    const h = harness({ PLURNK_MCP_CONNECT_TIMEOUT: "500", PLURNK_MCP_REQUEST_TIMEOUT: "3000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000" });
    await h.setup();
    try {
        const enabled = new Map([
            ["stall", httpServer("stall", served.url)],
            ["echo", stdio("echo")],
        ]);
        const prepared = await h.lane(1, enabled);
        const unavailable = prepared.outcomes.get("stall");
        assert.equal(unavailable?.state, "unavailable");
        if (unavailable?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(unavailable.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.deepEqual(h.runtimeTags(1), ["echo"], "a silent catalog does not prevent publishing other tools");
        stalled = false;
        const retry = await h.lane(1, enabled, { force: "stall" });
        assert.equal(retry.outcomes.get("stall")?.state, "active");
        assert.deepEqual(h.runtimeTags(1).toSorted(), ["echo", "stall"]);
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
        const attempt = await h.adapter().prepare({ ...h.identity(1), enabled: new Map([["a", withMarker("a")], ["c", withMarker("c")]]), previous: h.snapshots.get(1)!.prepared!.snapshot, failure: "reject", retain: () => () => undefined, progress: () => undefined });
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

test("{§oauth-lifetime} an interactive OAuth server publishes authorization-required, holds Worker residency, and the callback re-enables it through the coordinator", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness(oauthSettings(origin));
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
        assert.equal(completed.status, 200);
        assert.deepEqual(h.runtimeTags(1), ["oauth"], "the authorized server is published through the re-enable");
        assert.equal(h.leases(), 0, "the pending lease was released on publication");
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=x&state=y` }), "oauth-not-pending", 404);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
});

test("{§oauth-lifetime} withdrawing a server with a pending authorization clears the attempt and releases its residency", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness(oauthSettings(origin));
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
    const h = harness(oauthSettings(origin));
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        // The definition changes underneath the pending authorization: the new
        // challenge supersedes the old one and holds the single lease.
        const changed = httpServer("oauth", served.url, { "X-Changed": "1" });
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
        assert.equal(completed.status, 200);
        assert.deepEqual(h.runtimeTags(1), ["echo", "oauth"]);
        assert.equal(h.leases(), 0);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.stop(); }
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

test("{§mcp-plugin-servers} an added server is written as a one-server plugin at its scope's root, launches from it, and remove deletes it", async () => {
    const h = harness();
    await h.setup();
    try {
        const definition = { name: "added", scope: "plurnk", type: "stdio", command: "node", args: [fixture] };
        const admitted = await h.adapter().admit({ definition }, h.identity(1));
        assert.deepEqual(admitted, { alias: "added", definition });
        assert.equal((await h.lane(1, new Map([["added", admitted.definition]]))).outcomes.get("added")?.state, "active");
        const directory = join(h.roots.plurnk!, "added");
        assert.equal(JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8")).name, "added");
        assert.deepEqual(JSON.parse(readFileSync(join(directory, "mcp.json"), "utf8")).mcpServers, { added: { type: "stdio", command: "node", args: [fixture] } },
            "the plugin declares exactly the standard entry, without plurnk's alias, scope, or provenance");
        assert.equal((await h.lane(1, new Map([["added", admitted.definition]]), { force: "added" })).outcomes.get("added")?.state, "active");
        assert.equal(h.written.length, 1, "the same plugin already in place is reused, never rewritten");
        await h.teardown(1);
        await h.adapter().forget(admitted, h.identity(1));
        assert.equal(existsSync(directory), false, "remove deletes the plugin add wrote");
    } finally { await h.module.stop(); }
});

test("{§mcp-plugin-servers} an add whose server cannot start deletes the plugin it wrote", async () => {
    const h = harness();
    await h.setup();
    try {
        const definition = { name: "broken", scope: "plurnk", type: "stdio", command: "plurnk-no-such-command" };
        await assert.rejects(() => h.lane(1, new Map([["broken", definition]]), { failure: "reject" }));
        assert.equal(existsSync(join(h.roots.plurnk!, "broken")), false);
    } finally { await h.module.stop(); }
});

test("{§mcp-plugin-servers} a different plugin at an added server's name is never overwritten", async () => {
    const h = harness();
    await h.setup();
    try {
        const directory = join(h.roots.plurnk!, "taken");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "plugin.json"), JSON.stringify({ name: "taken" }));
        writeFileSync(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { taken: { type: "stdio", command: "other" } } }));
        const outcome = (await h.lane(1, new Map([["taken", { name: "taken", scope: "plurnk", type: "stdio", command: "node", args: [fixture] }]]))).outcomes.get("taken");
        assert.equal(outcome?.state, "unavailable");
        assert.equal((outcome as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/plugin-occupied");
        assert.equal(JSON.parse(readFileSync(join(directory, "mcp.json"), "utf8")).mcpServers.taken.command, "other");
    } finally { await h.module.stop(); }
});

test("{§mcp-plugin-servers} add admits exactly a standard entry, named by its alias, at a root the workspace has", async () => {
    const h = harness({}, [], pluginRoots({ project: false }));
    await h.setup();
    try {
        const admit = (definition: object, alias?: string) => h.adapter().admit({ definition, ...(alias === undefined ? {} : { alias }) }, h.identity(1));
        const refused = (definition: object, code: string, alias?: string) => rejectsManagementProblem(() => admit(definition, alias), code, 400);
        await refused({ name: "echo", scope: "plurnk", type: "stdio", command: "node" }, "alias-mismatch", "other");
        await refused({ name: "echo", scope: "plurnk", plugin: { ...fixturePlugin }, type: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", scope: "plurnk", type: "stdio", command: "./bin/server" }, "definition-invalid");
        await refused({ name: "echo", scope: "plurnk", type: "stdio", command: "/usr/bin/node" }, "definition-invalid");
        await refused({ name: "echo", scope: "plurnk", transport: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", scope: "project", type: "stdio", command: "node" }, "scope-unavailable");
        const remote = { name: "remote", scope: "global", type: "streamable-http", url: "https://mcp.example.test/mcp" };
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

test("{§mcp-registry-discovery} discover searches the registry by query and offers each server's entries as exact definitions at the nearest root", async (t) => {
    const requests: string[] = [];
    const url = await serveRegistry(t, (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            servers: [{ server: { name: "io.github.example/example-server", version: "1.2.3", description: "Search the example index.", packages: [{ registryType: "npm", identifier: "@example/server", version: "1.2.3", transport: { type: "stdio" } }] }, _meta: {} }],
            metadata: { count: 1 },
        }));
    });
    const h = harness({ PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "5" }, [], pluginRoots({ project: false }));
    await h.setup();
    try {
        assert.deepEqual(await h.adapter().discover({ query: "example" }, h.identity(1)), [{
            alias: "example-server",
            summary: "Search the example index. — npx -y @example/server@1.2.3",
            definition: { name: "example-server", scope: "plurnk", type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3"] },
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
