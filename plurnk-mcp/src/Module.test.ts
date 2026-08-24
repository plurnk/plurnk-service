// {§mcp-module} — the MCP family as a Worker Functionality adapter. These tests
// drive the adapter contract directly (service definitions, inert discovery,
// admission, two-phase preparation, OAuth continuation, isolation, refresh,
// teardown). The lifecycle verbs, durable state, and both projections belong to
// the coordinator and are covered where it composes with this module.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { FunctionalityCandidate, FunctionalityDiscoverQuery, McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import type McpExecutor from "./McpExecutor.ts";
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
    available(identity: { workspaceId: number; workerId: number }): Promise<readonly { alias: string; definition: object; enabled: boolean }[]>;
    discover(query: FunctionalityDiscoverQuery, identity: { workspaceId: number; workerId: number }): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: { workspaceId: number; workerId: number }): Promise<{ alias: string; definition: object }>;
    prepare(preparation: {
        workspaceId: number; workerId: number;
        enabled: ReadonlyMap<string, object>; previous: unknown | null;
        failure: "publish-unavailable" | "reject"; force?: string; retain(): () => void;
    }): Promise<Prepared>;
    teardown(snapshot: unknown, identity: { workspaceId: number; workerId: number }): Promise<void>;
}

interface ActionRegistration {
    readonly name: string;
    readonly handler: (params: Readonly<Record<string, unknown>>, context: { scope: "worker"; workspaceId: number; workerId: number }) => unknown | Promise<unknown>;
}

// A harness that stands where the coordinator stands: it holds each Worker's
// enabled set and committed snapshot and calls the adapter's two phases. It
// decides nothing about lifecycle semantics — tests choose the enabled set.
const harness = (env: Record<string, string> = {}) => {
    const module = Module.init({ env: { ...floor, ...env } });
    const actions = new Map<string, ActionRegistration>();
    const snapshots = new Map<number, { enabled: Map<string, object>; prepared: Prepared | null }>();
    let adapter: Adapter | undefined;
    let leases = 0;
    const retain = () => { leases++; let released = false; return () => { if (released) return; released = true; leases--; }; };
    const identity = (workerId: number) => ({ workspaceId: 41, workerId });
    const lane = async (workerId: number, enabled: Map<string, object>, options: { failure?: "publish-unavailable" | "reject"; force?: string } = {}): Promise<Prepared> => {
        if (adapter === undefined) throw new Error("adapter not registered");
        const current = snapshots.get(workerId);
        const prepared = await adapter.prepare({
            ...identity(workerId), enabled, previous: current?.prepared?.snapshot ?? null,
            failure: options.failure ?? "publish-unavailable", ...(options.force ? { force: options.force } : {}), retain,
        });
        await prepared.commit();
        snapshots.set(workerId, { enabled, prepared });
        return prepared;
    };
    const seam = {
        registerModuleAction: (registration: ActionRegistration): void => { actions.set(registration.name, registration); },
        registerFunctionalityAdapter: (candidate: Adapter) => {
            adapter = candidate;
            return {
                invoke: async (verb: string, params: unknown, id: { workspaceId: number; workerId: number }) => {
                    // The only re-entry the adapter uses: re-enable one alias (retry).
                    if (verb !== "enable") throw new Error(`harness does not emulate ${verb}`);
                    const alias = (params as { alias: string }).alias;
                    const current = snapshots.get(id.workerId);
                    if (current === undefined) throw new Error("worker not prepared");
                    const prepared = await lane(id.workerId, current.enabled, { force: alias });
                    const outcome = prepared.outcomes.get(alias);
                    return { status: outcome?.state === "authorization-required" ? 202 : 200, body: { status: 200, family: "mcp", alias, definition: { alias, origin: "worker", ...outcome } } };
                },
                refresh: async (id: { workspaceId: number; workerId: number }) => {
                    const current = snapshots.get(id.workerId);
                    if (current === undefined) return;
                    await lane(id.workerId, current.enabled);
                },
            };
        },
    };
    return {
        module,
        actions,
        snapshots,
        leases: () => leases,
        setup: () => module.setup(seam as never),
        adapter: () => { if (adapter === undefined) throw new Error("adapter not registered"); return adapter; },
        identity,
        lane,
        teardown: async (workerId: number) => {
            const current = snapshots.get(workerId);
            await adapter!.teardown(current?.prepared?.snapshot ?? null, identity(workerId));
            snapshots.delete(workerId);
        },
        action: async (workerId: number, name: string, params: Readonly<Record<string, unknown>>) => {
            const registration = actions.get(name);
            if (registration === undefined) throw new Error(`missing action ${name}`);
            return registration.handler(params, { scope: "worker", ...identity(workerId) });
        },
        runtimeTags: (workerId: number) => (snapshots.get(workerId)?.prepared?.runtimes ?? []).map(({ decl }) => decl.name),
    };
};

const stdio = (name: string, args: string[] = [fixture], extra: Partial<McpServerDefinition> = {}): McpServerDefinition =>
    ({ name, transport: "stdio", command: process.execPath, args, ...extra }) as McpServerDefinition;

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

const oauthDefinition = (served: { url: string }, origin: string): McpServerDefinition => ({
    name: "oauth",
    transport: "http",
    url: served.url,
    authorization: {
        type: "oauth",
        redirectUrl: `${origin}/callback`,
        clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
        scope: "mcp:read",
    },
} as McpServerDefinition);

test("{§mcp-module} the adapter registers the mcp family, its continuations, and service definitions with their default enabledness", async () => {
    const h = harness({ PLURNK_MCP_FIXTURE: process.execPath, PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixture]), PLURNK_MCP_ENABLED: JSON.stringify(["fixture"]) });
    await h.setup();
    try {
        assert.equal(h.adapter().family, "mcp");
        assert.equal(h.adapter().namespaceOwner, "@plurnk/plurnk-mcp");
        assert.deepEqual([...h.actions.keys()].toSorted(), ["worker.mcp.complete", "worker.mcp.oauth.complete"]);
        const available = await h.adapter().available(h.identity(1));
        assert.deepEqual(available.map(({ alias, enabled }) => ({ alias, enabled })), [{ alias: "fixture", enabled: true }]);
        assert.equal((available[0]!.definition as McpServerDefinition).transport, "stdio");
    } finally { await h.module.close(); }
});

test("{§mcp-module} admission validates the exact definition and binds the alias to its name", async () => {
    const h = harness();
    await h.setup();
    try {
        const admitted = await h.adapter().admit({ alias: "echo", definition: stdio("echo") }, h.identity(1));
        assert.equal(admitted.alias, "echo");
        const derived = await h.adapter().admit({ definition: stdio("echo") }, h.identity(1));
        assert.equal(derived.alias, "echo", "an omitted alias is the definition's name");
        await rejectsManagementProblem(() => h.adapter().admit({ alias: "other", definition: stdio("echo") }, h.identity(1)), "alias-mismatch", 400);
        await rejectsManagementProblem(() => h.adapter().admit({ alias: "bad", definition: { name: "bad" } }, h.identity(1)), "definition-invalid", 400);
    } finally { await h.module.close(); }
});

test("{§mcp-discovery} discovery is inert: client configuration becomes candidates without connecting, a direct target is probed and released, registry search is a stated absence", async () => {
    const h = harness({ PLURNK_MCP_BASE: process.execPath, PLURNK_MCP_BASE_ARGS: JSON.stringify([fixture]) });
    await h.setup();
    try {
        const configured = await h.adapter().discover({
            configuration: {
                "PLURNK_MCP_CLIENT-ONLY": process.execPath,
                "PLURNK_MCP_CLIENT-ONLY_ARGS": JSON.stringify([fixture]),
                PLURNK_MCP_BASE_TOOLS: JSON.stringify(["echo"]),
            },
        }, h.identity(1));
        assert.deepEqual(configured.map(({ alias, provenance }) => ({ alias, kind: provenance.kind })), [
            { alias: "base", kind: "client-configuration" },
            { alias: "client-only", kind: "client-configuration" },
        ]);
        assert.deepEqual((configured[0]!.definition as McpServerDefinition).tools, ["echo"], "a companion variable overlays the service baseline into the candidate");
        const probed = await h.adapter().discover({ source: `${process.execPath} ${fixture}` }, h.identity(1));
        assert.equal(probed.length, 1);
        assert.equal(probed[0]!.provenance.kind, "direct-target");
        await rejectsManagementProblem(() => h.adapter().discover({ query: "gitea" }, h.identity(1)), "registry-not-configured", 501);
    } finally { await h.module.close(); }
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
    } finally { await h.teardown(1); await h.module.close(); }
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
    } finally { await h.teardown(1); await h.module.close(); }
});

test("{§mcp-setup} commit closes connections the next snapshot no longer uses; abort closes only what the attempt opened; teardown closes the rest", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-adapter-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const marker = (name: string) => join(temp, `${name}.closed`);
    const withMarker = (name: string) => stdio(name, [fixture], { env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker(name) } });
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["a", withMarker("a")], ["b", withMarker("b")]]));
        assert.deepEqual(h.runtimeTags(1), ["a", "b"]);
        await h.lane(1, new Map([["a", withMarker("a")]]));
        await waitForFile(marker("b"));
        assert.deepEqual(h.runtimeTags(1), ["a"], "the removed server's connection closed after the replacement committed");

        // abort: a fresh connection is opened, then discarded; the committed one survives.
        const attempt = await h.adapter().prepare({ ...h.identity(1), enabled: new Map([["a", withMarker("a")], ["c", withMarker("c")]]), previous: h.snapshots.get(1)!.prepared!.snapshot, failure: "reject", retain: () => () => undefined });
        assert.equal(attempt.outcomes.get("c")?.state, "active");
        await attempt.abort();
        await waitForFile(marker("c"));
        assert.deepEqual(h.runtimeTags(1), ["a"]);
        assert.equal(await readFile(marker("a"), "utf8").catch(() => null), null, "the committed attachment was not touched by the aborted attempt");

        await h.teardown(1);
        await waitForFile(marker("a"));
    } finally { await h.module.close(); }
});

test("{§oauth-lifetime} an interactive OAuth server publishes authorization-required, holds Worker residency, and the callback re-enables it through the coordinator", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["oauth", oauthDefinition(served, origin)]]));
        const outcome = prepared.outcomes.get("oauth");
        assert.equal(outcome?.state, "authorization-required");
        assert.deepEqual(h.runtimeTags(1), [], "a challenged server publishes no runtime");
        assert.equal(h.leases(), 1, "the pending authorization holds one residency lease");
        await assert.rejects(() => h.teardown(1), /cannot cool with pending OAuth residency/);
        const state = new URL((outcome as { authorization: { url: string } }).authorization.url).searchParams.get("state");
        assert.ok(state);
        const completed = await h.action(1, "worker.mcp.oauth.complete", {
            alias: "oauth",
            callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
        }) as { status: number };
        assert.equal(completed.status, 200);
        assert.deepEqual(h.runtimeTags(1), ["oauth"], "the authorized server is published through the re-enable");
        assert.equal(h.leases(), 0, "the pending lease was released on publication");
        await rejectsManagementProblem(() => h.action(1, "worker.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=x&state=y` }), "oauth-not-pending", 404);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.close(); }
});

test("{§oauth-lifetime} a superseded authorization attempt cannot complete a replacement, and a changed target conflicts", async (t) => {
    const { origin, served } = await interactiveOAuthFixture(t);
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["oauth", oauthDefinition(served, origin)]]));
        const firstUrl = (first.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url;
        // The definition changes underneath the pending authorization: the new
        // challenge supersedes the old one and holds the single lease.
        const changed = { ...oauthDefinition(served, origin), tools: ["echo"] } as McpServerDefinition;
        await h.lane(1, new Map([["oauth", changed]]));
        assert.equal(h.leases(), 1, "the superseded attempt released its lease; the replacement holds one");
        const staleState = new URL(firstUrl).searchParams.get("state")!;
        await rejectsManagementProblem(
            () => h.action(1, "worker.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(staleState)}&iss=${encodeURIComponent(origin)}` }),
            "oauth-callback-invalid", 400,
        );
        // A committed attachment that no longer matches the pending definition conflicts.
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", oauthDefinition(served, origin)]]));
        assert.equal(h.leases(), 1);
        await h.lane(1, new Map([["echo", stdio("echo")], ["oauth", { ...oauthDefinition(served, origin), name: "oauth" } as McpServerDefinition]]), { force: "oauth" });
        const replacementState = new URL((h.snapshots.get(1)!.prepared!.outcomes.get("oauth") as { authorization: { url: string } }).authorization.url).searchParams.get("state")!;
        const completed = await h.action(1, "worker.mcp.oauth.complete", { alias: "oauth", callbackUrl: `${origin}/callback?code=fixture-code&state=${encodeURIComponent(replacementState)}&iss=${encodeURIComponent(origin)}` }) as { status: number };
        assert.equal(completed.status, 200);
        assert.deepEqual(h.runtimeTags(1), ["echo", "oauth"]);
        assert.equal(h.leases(), 0);
    } finally { await h.teardown(1).catch(() => undefined); await h.module.close(); }
});

test("{§mcp-authority} a legacy peer negotiates below the pin and serves its standard catalog", async () => {
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["legacy", stdio("legacy", [legacyFixture])]]));
        const outcome = prepared.outcomes.get("legacy") as { state: string; detail?: { protocolVersion?: string } };
        assert.equal(outcome.state, "active");
        assert.equal(outcome.detail?.protocolVersion, "2025-06-18");
    } finally { await h.teardown(1); await h.module.close(); }
});

test("{§mcp-module} completion routes to the connected server and refuses a disconnected one", async () => {
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await rejectsManagementProblem(() => h.action(1, "worker.mcp.complete", { server: "missing", ref: {}, argument: {} }), "server-not-connected", 409);
        await rejectsManagementProblem(() => h.action(1, "worker.mcp.complete", { server: "echo", ref: "x", argument: {} }), "completion-parameters-invalid", 400);
    } finally { await h.teardown(1); await h.module.close(); }
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
