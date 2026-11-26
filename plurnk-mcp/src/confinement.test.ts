// {§mcp-configuration} {§mcp-module} — workspace MCP transport allowlist and public-URL SSRF guard.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigurationError, GuardBlockedError } from "@plurnk/plurnk-meta";
import type { McpServerDefinition } from "@plurnk/plurnk-contracts";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";
import { httpServer, stdioServer as stdio } from "../test/definitions.ts";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { harness, httpHandler, rejectsManagementProblem } from "../test/module-harness.ts";
import ServerConnection from "./client.ts";
import { mcpPolicy, publicOnly, validateConfiguration, workspaceTransports } from "./config.ts";

const floor = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT_MS: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT_MS: "30000",
    PLURNK_MCP_RETRY_FLOOR_MS: "250",
    PLURNK_MCP_RETRY_CEILING_MS: "5000",
    PLURNK_MCP_REGISTRY_URL: "",
    PLURNK_MCP_REGISTRY_LIMIT: "20",
    PLURNK_MCP_ALLOW_ORIGIN: "*",
    PLURNK_MCP_WORKSPACE_TRANSPORTS: "stdio,streamable-http",
    PLURNK_MCP_PUBLIC_ONLY: "0",
};

test("{§mcp-configuration} workspaceTransports, publicOnly, and mcpPolicy parse and validate operator confinement controls", () => {
    const shipped = parseEnv(readFileSync(new URL("../.env.defaults", import.meta.url), "utf8"));
    assert.deepEqual(mcpPolicy(shipped), {
        workspaceTransports: ["stdio", "streamable-http"],
        publicOnly: false,
    });
    assert.deepEqual(workspaceTransports({ ...floor, PLURNK_MCP_WORKSPACE_TRANSPORTS: "" }), []);
    assert.deepEqual(workspaceTransports({ ...floor, PLURNK_MCP_WORKSPACE_TRANSPORTS: "streamable-http" }), ["streamable-http"]);
    assert.deepEqual(workspaceTransports({ ...floor, PLURNK_MCP_WORKSPACE_TRANSPORTS: "stdio, streamable-http, stdio" }), ["stdio", "streamable-http"]);
    assert.equal(publicOnly({ ...floor, PLURNK_MCP_PUBLIC_ONLY: "1" }), true);
    assert.equal(publicOnly({ ...floor, PLURNK_MCP_PUBLIC_ONLY: "0" }), false);

    assert.throws(
        () => workspaceTransports({ ...floor, PLURNK_MCP_WORKSPACE_TRANSPORTS: "sse" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_MCP_WORKSPACE_TRANSPORTS",
    );
    assert.throws(
        () => publicOnly({ ...floor, PLURNK_MCP_PUBLIC_ONLY: "yes" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_MCP_PUBLIC_ONLY",
    );
    assert.throws(
        () => validateConfiguration({ ...floor, PLURNK_MCP_WORKSPACE_TRANSPORTS: "bogus" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_MCP_WORKSPACE_TRANSPORTS",
    );
    assert.throws(
        () => validateConfiguration({ ...floor, PLURNK_MCP_PUBLIC_ONLY: "maybe" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_MCP_PUBLIC_ONLY",
    );
});

test("{§mcp-configuration} {§mcp-module} PLURNK_MCP_WORKSPACE_TRANSPORTS confines workspace adds, project mcp.json, and discover while exempting exact operator definitions", async (t) => {
    const projectDir = await mkdtemp(join(tmpdir(), "plurnk-mcp-project-"));
    t.after(() => rm(projectDir, { recursive: true, force: true }));
    const projectConfigDir = join(projectDir, ".agents");
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
        join(projectConfigDir, "mcp.json"),
        JSON.stringify({ mcpServers: { projstdio: stdio("projstdio") } }),
    );

    const operatorEcho = stdio("ops");
    const h = harness({
        PLURNK_MCP_WORKSPACE_TRANSPORTS: "streamable-http",
        PLURNK_MCP_ops: JSON.stringify(operatorEcho),
    });
    h.seam.workspacePaths = async (workspaceId) => ({
        home: h.stateRoot,
        workspaceName: `workspace-${workspaceId}`,
        projectRoot: projectDir as never,
        configurationRoots: [{ scope: "project", directory: projectConfigDir }] as never,
    });
    await h.setup();
    try {
        assert.deepEqual(h.adapter().policy?.(), {
            workspaceTransports: ["streamable-http"],
            publicOnly: false,
        });

        // Admission refuses workspace stdio and allows streamable-http.
        await rejectsManagementProblem(
            () => h.adapter().admit({ alias: "local", type: "stdio", command: "node" }, h.identity(1)),
            "mcp-transport-forbidden",
            403,
        );
        const admittedHttp = await h.adapter().admit(
            { alias: "remote", type: "streamable-http", url: "https://93.184.216.34/mcp" },
            h.identity(1),
        );
        assert.equal(admittedHttp.alias, "remote");

        // Populate operator definitions via available() just as Functionality coordinator does.
        const available = await h.adapter().available(h.identity(1));
        assert.deepEqual(available.map(({ alias }) => alias).toSorted(), ["ops", "projstdio"]);

        // Exact operator stdio definition still prepares and runs cleanly, while project mcp.json stdio is refused!
        const prepared = await h.lane(1, new Map<string, McpServerDefinition>([
            ["ops", operatorEcho],
            ["projstdio", stdio("projstdio")],
        ]));
        assert.equal(prepared.outcomes.get("ops")?.state, "active");
        const projOutcome = prepared.outcomes.get("projstdio");
        assert.equal(projOutcome?.state, "unavailable");
        if (projOutcome?.state === "unavailable") {
            assert.equal(projOutcome.problem.status, 403);
            assert.equal(projOutcome.problem.type, "https://problems.plurnk.xyz/mcp/management/mcp-transport-forbidden");
        }

        // Workspace override shadowing an operator alias with a DIFFERENT stdio definition cannot inherit operator exemption!
        const shadowDefinition: McpServerDefinition = {
            ...operatorEcho,
            type: "stdio",
            args: [...(operatorEcho.args ?? []), "--hijacked"],
        };
        await rejectsManagementProblem(
            () => h.lane(1, new Map<string, McpServerDefinition>([["ops", shadowDefinition]]), { failure: "reject" }),
            "mcp-transport-forbidden",
            403,
        );
    } finally {
        if (h.snapshots.has(1)) await h.teardown(1);
        await h.module.stop();
    }

    // Empty allowlist refuses ALL workspace transports (both stdio and streamable-http).
    const hNone = harness({ PLURNK_MCP_WORKSPACE_TRANSPORTS: "" });
    await hNone.setup();
    try {
        await rejectsManagementProblem(
            () => hNone.adapter().admit({ alias: "a", type: "stdio", command: "node" }, hNone.identity(1)),
            "mcp-transport-forbidden",
            403,
        );
        await rejectsManagementProblem(
            () => hNone.adapter().admit({ alias: "b", type: "streamable-http", url: "https://93.184.216.34/mcp" }, hNone.identity(1)),
            "mcp-transport-forbidden",
            403,
        );
    } finally {
        await hNone.module.stop();
    }
});

test("{§mcp-configuration} {§mcp-module} discover filters registry candidates by PLURNK_MCP_WORKSPACE_TRANSPORTS", async (t) => {
    const registry = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            servers: [{
                server: {
                    name: "io.github.example/hybrid",
                    version: "1.0.0",
                    description: "Hybrid server.",
                    packages: [{ registryType: "npm", identifier: "@example/hybrid", version: "1.0.0", transport: { type: "stdio" } }],
                    remotes: [{ type: "streamable-http", url: "https://93.184.216.34/mcp" }],
                },
                _meta: {},
            }],
            metadata: { count: 1 },
        }));
    });
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
    const url = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;

    const hHttpOnly = harness({
        PLURNK_MCP_REGISTRY_URL: url,
        PLURNK_MCP_REGISTRY_LIMIT: "5",
        PLURNK_MCP_WORKSPACE_TRANSPORTS: "streamable-http",
    });
    await hHttpOnly.setup();
    try {
        const page = await hHttpOnly.adapter().discover!({ query: "hybrid" }, hHttpOnly.identity(1));
        if (!("candidates" in page)) assert.fail("expected paged discovery result");
        assert.equal(page.candidates.length, 1);
        assert.equal((page.candidates[0]?.definition as { type?: string } | undefined)?.type, "streamable-http");
    } finally {
        await hHttpOnly.module.stop();
    }

    const hEmpty = harness({
        PLURNK_MCP_REGISTRY_URL: url,
        PLURNK_MCP_REGISTRY_LIMIT: "5",
        PLURNK_MCP_WORKSPACE_TRANSPORTS: "",
    });
    await hEmpty.setup();
    try {
        const page = await hEmpty.adapter().discover!({ query: "hybrid" }, hEmpty.identity(1));
        if (!("candidates" in page)) assert.fail("expected paged discovery result");
        assert.deepEqual(page.candidates, []);
    } finally {
        await hEmpty.module.stop();
    }
});

test("{§mcp-configuration} {§mcp-module} PLURNK_MCP_PUBLIC_ONLY=1 blocks non-public workspace URLs and OAuth hops while exempting exact operator HTTP definitions", async (t) => {
    const served = await serveMcpHttp(t, httpHandler());
    const operatorHttp = httpServer("internal", served.url);
    const h = harness({
        PLURNK_MCP_PUBLIC_ONLY: "1",
        PLURNK_MCP_internal: JSON.stringify(operatorHttp),
    });
    await h.setup();
    try {
        assert.deepEqual(h.adapter().policy?.(), {
            workspaceTransports: ["stdio", "streamable-http"],
            publicOnly: true,
        });

        // Admission rejects private/loopback/IMDS endpoint URLs, issuers, and clientMetadataUrls.
        for (const blocked of [
            { alias: "loop", type: "streamable-http", url: "http://127.0.0.1:9999/mcp" },
            { alias: "local", type: "streamable-http", url: "http://localhost/mcp" },
            { alias: "imds", type: "streamable-http", url: "http://169.254.169.254/latest/meta-data/" },
            { alias: "v6loop", type: "streamable-http", url: "http://[::1]/mcp" },
            {
                alias: "bad-issuer",
                type: "streamable-http",
                url: "https://93.184.216.34/mcp",
                authorization: { type: "oauth", issuer: "http://127.0.0.1:8080" },
            },
            {
                alias: "bad-cimd",
                type: "streamable-http",
                url: "https://93.184.216.34/mcp",
                authorization: { type: "oauth", clientMetadataUrl: "https://169.254.169.254/client.json" },
            },
        ]) {
            await rejectsManagementProblem(
                () => h.adapter().admit(blocked, h.identity(1)),
                "mcp-url-forbidden",
                403,
            );
        }

        // Public IP literal is admitted.
        const ok = await h.adapter().admit(
            { alias: "pub", type: "streamable-http", url: "https://93.184.216.34/mcp" },
            h.identity(1),
        );
        assert.equal(ok.alias, "pub");

        // Operator loopback HTTP server stays exempt and connects cleanly, while workspace loopback HTTP is refused.
        await h.adapter().available(h.identity(1));
        const prepared = await h.lane(1, new Map<string, McpServerDefinition>([
            ["internal", operatorHttp],
            ["ws-loop", httpServer("ws-loop", served.url)],
        ]));
        assert.equal(prepared.outcomes.get("internal")?.state, "active");
        const wsOutcome = prepared.outcomes.get("ws-loop");
        assert.equal(wsOutcome?.state, "unavailable");
        if (wsOutcome?.state === "unavailable") {
            assert.equal(wsOutcome.problem.status, 403);
            assert.equal(wsOutcome.problem.type, "https://problems.plurnk.xyz/mcp/management/mcp-url-forbidden");
        }
    } finally {
        if (h.snapshots.has(1)) await h.teardown(1);
        await h.module.stop();
    }
});

test("{§mcp-configuration} ServerConnection({ publicOnly: true }) blocks private endpoints, private redirects, and private OAuth metadata hops before fetch", async () => {
    // 1. Direct private endpoint never invokes fetch.
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        return new Response("leaked", { status: 200 });
    });
    try {
        const conn = new ServerConnection(httpServer("priv", "http://127.0.0.1:9999/mcp"), floor, { publicOnly: true });
        try {
            await assert.rejects(() => conn.connect(), (error: unknown) => error instanceof GuardBlockedError);
            assert.equal(calls, 0);
        } finally {
            await conn.close();
        }
    } finally {
        globalThis.fetch = origFetch;
    }

    // 2. Public MCP endpoint challenging with private OAuth resource_metadata is blocked during oauth.begin before loopback is fetched.
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
        const href = requestUrl(input);
        seen.push(href);
        if (href.startsWith("https://93.184.216.34/")) {
            return new Response("Unauthorized", {
                status: 401,
                headers: {
                    "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1:8080/.well-known/oauth-protected-resource"',
                },
            });
        }
        return new Response("private-metadata", { status: 200 });
    });
    try {
        const h = harness({ PLURNK_MCP_PUBLIC_ONLY: "1" });
        await h.setup();
        try {
            const prepared = await h.lane(1, new Map<string, McpServerDefinition>([
                ["ssrf-oauth", httpServer("ssrf-oauth", "https://93.184.216.34/mcp")],
            ]));
            assert.equal(prepared.outcomes.get("ssrf-oauth")?.state, "authorization-required");
            await rejectsManagementProblem(
                () => h.action(1, "workspace.mcp.oauth.begin", {
                    alias: "ssrf-oauth",
                    redirectUrl: "http://127.0.0.1:43210/callback",
                }),
                "mcp-url-forbidden",
                403,
            );
            assert.equal(seen.some((u) => u.includes("127.0.0.1")), false, "private OAuth metadata URL must never be fetched");
        } finally {
            if (h.snapshots.has(1)) await h.teardown(1);
            await h.module.stop();
        }
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("{§mcp-configuration} {§module-contract} invalid confinement knobs are contained on startup and fail closed", async () => {
    for (const [env, key] of [
        [{ PLURNK_MCP_WORKSPACE_TRANSPORTS: "sse" }, "PLURNK_MCP_WORKSPACE_TRANSPORTS"],
        [{ PLURNK_MCP_PUBLIC_ONLY: "maybe" }, "PLURNK_MCP_PUBLIC_ONLY"],
    ] as const) {
        const h = harness(env);
        await h.setup();
        try {
            assert.deepEqual(h.module.contained.map((item) => item.key), [key]);
            assert.deepEqual(h.adapter().policy?.(), {
                workspaceTransports: [],
                publicOnly: true,
            });
            await rejectsManagementProblem(
                () => h.adapter().admit({ alias: "x", type: "streamable-http", url: "https://93.184.216.34/mcp" }, h.identity(1)),
                "configuration-invalid",
                503,
            );
        } finally {
            await h.module.stop();
        }
    }
});

test("{§mcp-configuration} {§functionality-coordinator} client confinement applies to service-scope MCP admissions and service.mcp.oauth.begin (never exempted like host)", async () => {
    const h = harness({
        PLURNK_MCP_WORKSPACE_TRANSPORTS: "streamable-http",
        PLURNK_MCP_PUBLIC_ONLY: "1",
    });
    await h.setup();
    try {
        // Service-scope admission refuses forbidden transports and private URLs, just like workspace scope.
        await rejectsManagementProblem(
            () => h.adapter().admit({ alias: "svc-stdio", type: "stdio", command: "node" }, { scope: "service" }),
            "mcp-transport-forbidden",
            403,
        );
        await rejectsManagementProblem(
            () => h.adapter().admit({ alias: "svc-loop", type: "streamable-http", url: "http://127.0.0.1:9999/mcp" }, { scope: "service" }),
            "mcp-url-forbidden",
            403,
        );
        const admittedPublic = await h.adapter().admit(
            { alias: "svc-pub", type: "streamable-http", url: "https://93.184.216.34/mcp" },
            { scope: "service" },
        );
        assert.equal(admittedPublic.alias, "svc-pub");

        // Service-origin OAuth begin also enforces PLURNK_MCP_PUBLIC_ONLY (only host-origin is exempt).
        h.serviceDefinitions.set("svc-priv", {
            origin: "service",
            definition: httpServer("svc-priv", "http://127.0.0.1:9999/mcp"),
        });
        await rejectsManagementProblem(
            () => h.serviceAction("service.mcp.oauth.begin", {
                alias: "svc-priv",
                redirectUrl: "http://127.0.0.1:43210/callback",
            }),
            "mcp-url-forbidden",
            403,
        );
    } finally {
        await h.module.stop();
    }
});
