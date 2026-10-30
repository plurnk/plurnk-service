import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Daemon from "../../src/server/Daemon.ts";
import EnvDefaults from "../../src/core/env-defaults.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import SessionName from "../../src/core/SessionName.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { type FunctionalityListResult, type ProblemDetails, writtenOp, type PlurnkStatement, isExecution, type CapabilityPolicy, type ExecStatement, type RuntimeTag } from "@plurnk/plurnk-contracts";
import { type SchemeManifest } from "@plurnk/plurnk-schemes";
import { copyStmt, urlPath, editStmt, findStmt, readStmt, regex, completeStmt, killStmt, moveStmt, noteStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertTurn, insertSession, insertWorkspace, openMigrated, insertOperationTurn } from "./_db.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { McpServer, ResourceTemplate, completable, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { bindListener } from "./_http.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { taskHandler } from "../../../plurnk-mcp/test/task-fixture.ts";
import { httpEntry, mcpFixture, stdioEntry } from "./_mcp-config.ts";
import { waitForDb, connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { logEntries } from "./_packet.ts";
import { testExecutors } from "./_execs.ts";


describe("mcp-management-composition", () => {
type Event = Record<string, unknown>;
type ActionResult = { ok: boolean; result?: Record<string, unknown>; problem?: ProblemDetails };

// {§mcp-configuration} {§mcp-configuration}
const setup = async (
    t: TestContext,
    servers: Readonly<Record<string, object>>,
    responses: ReturnType<typeof makeMockResponse>[] = [],
    settings: Readonly<Record<string, string>> = {},
) => {
    const provider = new Mock({ contextWindow: 1_000_000, responses });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, servers);
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, hostPaths, http });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        ...settings,
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;
    const post = async (
        workspace: string, action?: Record<string, unknown>, prompt?: string, onEvent?: (event: Event) => void,
    ): Promise<Event[]> => {
        const reqId = crypto.randomUUID();
        const rpcBody = action !== undefined
            ? (() => {
                const { kind, ...params } = action;
                return {
                    jsonrpc: "2.0",
                    id: reqId,
                    method: "_plurnk/action",
                    params: { sessionId: "operator", workspace, projectRoot: null, kind, params },
                };
            })()
            : {
                jsonrpc: "2.0",
                id: reqId,
                method: "session/prompt",
                params: {
                    sessionId: "operator",
                    prompt: [{ type: "text", text: prompt ?? "" }],
                    _meta: { plurnk: { workspace, projectRoot: null } },
                },
            };
        const ws = new WebSocket(wsUrl);
        const events: Event[] = [];
        return await new Promise<Event[]>((resolveEvents, reject) => {
            let settled = false;
            const finish = (terminal?: Event) => {
                if (settled) return;
                settled = true;
                if (terminal !== undefined) {
                    events.push(terminal);
                    onEvent?.(terminal);
                }
                ws.close();
                resolveEvents(events);
            };
            ws.addEventListener("open", () => {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: "init",
                    method: "initialize",
                    params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
                }));
            });
            ws.addEventListener("message", (msg) => {
                const event = JSON.parse(String(msg.data)) as Event & {
                    id?: string;
                    method?: string;
                    params?: { update?: { sessionUpdate?: string; state?: string; stopReason?: string } };
                    error?: unknown;
                };
                if (event.id === "init") {
                    ws.send(JSON.stringify(rpcBody));
                    return;
                }
                if (event.method === "session/update") {
                    events.push(event);
                    onEvent?.(event);
                    if (rpcBody.method === "session/prompt" && event.params?.update?.sessionUpdate === "state_update" && event.params.update.state === "idle") {
                        finish({
                            jsonrpc: "2.0",
                            id: reqId,
                            result: {
                                stopReason: event.params.update.stopReason ?? "end_turn",
                                _meta: { plurnk: { stopReason: event.params.update.stopReason ?? "end_turn" } },
                            },
                        });
                    }
                    return;
                }
                if (event.id === reqId && (rpcBody.method === "_plurnk/action" || event.error !== undefined)) {
                    finish(event);
                }
            });
            ws.addEventListener("error", (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            });
        });
    };
    const action = async (workspace: string, kind: string, params: Record<string, unknown> = {}): Promise<ActionResult> => {
        const events = await post(workspace, { kind, ...params });
        // {§acp-plurnk-metadata} A JSON-RPC _plurnk/action response carries result or error.data.problem.
        const terminal = events.find((event) => "result" in event || "error" in event) as {
            result?: Record<string, unknown>;
            error?: { data?: { problem?: ProblemDetails } };
        } | undefined;
        assert.ok(terminal, `no action result for ${kind}: ${JSON.stringify(events)}`);
        if (terminal.error !== undefined) {
            return { ok: false, problem: terminal.error.data?.problem };
        }
        return { ok: true, result: terminal.result };
    };
    return { provider, post, action, hostPaths };
};

test("{§mcp-module}: ACP exposes the same unavailable preparation evidence through Functionality list", { timeout: 20000 }, async (t) => {
    const { action, provider } = await setup(t, { broken: stdioEntry("preparation-failure.mjs", {
        FIXTURE_SECRET: "${FIXTURE_SECRET}",
    }) }, [], { FIXTURE_SECRET: "fixture-private-value" });
    const activated = await action("preparation-diagnostics", "workspace.mcp.enable", { alias: "broken" });
    assert.equal(activated.ok, false, "activation actually attempted preparation; list alone stays dormant");
    const list = await action("preparation-diagnostics", "workspace.mcp.list");
    assert.equal(list.ok, true);
    const rows = list.result?.definitions as FunctionalityListResult["definitions"];
    const broken = rows.find(({ alias }) => alias === "broken");
    assert.equal(broken?.state, "unavailable");
    const problem = broken?.problem;
    assert.ok(problem);
    assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
    assert.equal(problem.timeoutMs, 5000);
    assert.ok(typeof problem.elapsedMs === "number" && problem.elapsedMs >= 0);
    assert.match(String(problem.stderr), /session rejected __redacted__/u);
    assert.match(String(problem.diagnostic), /closed|exit/iu);
    assert.equal(problem.exitCode, undefined);
    const repeated = await action("preparation-diagnostics", "workspace.mcp.list");
    assert.deepEqual(repeated.result, list.result, "inspection preserves the captured failure rather than probing again");
    const enabled = await action("preparation-diagnostics", "workspace.mcp.enable", { alias: "broken" });
    assert.equal(enabled.ok, false);
    assert.match(String(enabled.problem?.stderr), /session rejected __redacted__/u);
    assert.equal(enabled.problem?.timeoutMs, 5000);
    assert.doesNotMatch(JSON.stringify([list, repeated, enabled]), /fixture-private-value|probe-only diagnostic/u);
    assert.equal(provider.received.length, 0);
});

test("{§mcp-module}: ACP completion preserves prompt and resource arguments and workspace binding", { timeout: 20000 }, async (t) => {
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "completion", version: "1.0.0" });
        server.registerPrompt("summarize", { argsSchema: z.object({
            topic: completable(z.string(), (value) => ["Plurnk", "protocol"].filter((item) => item.startsWith(value))),
        }) }, async ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: topic } }] }));
        server.registerResource("document", new ResourceTemplate("fixture://{project}/{document}", {
            list: undefined,
            complete: { document: (value, context) => [`${context?.arguments?.project}-${value}-result`] },
        }), {}, async (uri) => ({ contents: [{ uri: uri.href, text: "document" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
    const { action, provider } = await setup(t, { fixture: httpEntry(served.url) });
    for (const params of [
        { ref: { type: "ref/prompt", name: "summarize" }, argument: { name: "topic", value: "P" } },
        { ref: { type: "ref/resource", uri: "fixture://{project}/{document}" }, argument: { name: "document", value: "spec" }, context: { arguments: { project: "plurnk" } } },
    ]) {
        const completed = await action("completions", "workspace.mcp.complete", { server: "fixture", ...params });
        assert.equal(completed.ok, true, JSON.stringify(completed));
        assert.deepEqual((completed.result?.completion as { values: string[] } | undefined)?.values,
            params.ref.type === "ref/prompt" ? ["Plurnk"] : ["plurnk-spec-result"]);
        const request = served.requests.findLast(({ body }) => (body as { method?: string })?.method === "completion/complete");
        assert.ok(request);
        const { _meta, ...received } = (request.body as { params: Record<string, unknown> }).params;
        assert.deepEqual(received, params, "the standard argument context reaches the actual server unchanged");
    }
    // Every workspace has the configured server; one that disabled it has no attachment to complete through.
    const withdrawn = await action("other-workspace", "workspace.mcp.disable", { alias: "fixture" });
    assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    const unavailable = await action("other-workspace", "workspace.mcp.complete", {
        server: "fixture", ref: { type: "ref/prompt", name: "summarize" }, argument: { name: "topic", value: "P" },
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.problem?.type, "https://problems.plurnk.xyz/mcp/management/server-not-connected");
    assert.equal(provider.received.length, 0, "argument completion does not invoke a model");
});

for (const busy of [false, true]) {
test(`{§oauth-continuation}: ACP accepts authorization in an ${busy ? "active" : "idle"} workspace and publishes its tools safely`, { timeout: 20000 }, async (t) => {
    let origin = "";
    let authorization: URL | undefined;
    let exchanges = 0;
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "authorized", version: "1.0.0" });
        server.registerTool("echo", { inputSchema: z.object({ message: z.string() }), annotations: { readOnlyHint: true } }, async ({ message }) => ({
            content: [{ type: "text", text: `Authorized response: ${message}` }],
        }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/mcp") return request.headers.get("authorization") === "Bearer fixture-access" ? null : new Response(null, {
            status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
        });
        if (path === "/.well-known/oauth-protected-resource/mcp") return Response.json({
            resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"],
        });
        if (path === "/.well-known/oauth-authorization-server") return Response.json({
            issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
            response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
            client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
        });
        if (path === "/token") {
            const params = new URLSearchParams(await request.text());
            assert.ok(authorization);
            assert.equal(params.get("grant_type"), "authorization_code");
            assert.equal(params.get("code"), "fixture-code");
            assert.equal(params.get("resource"), served.url);
            assert.equal(params.get("redirect_uri"), `${origin}/callback`);
            assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
            exchanges++;
            return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
        }
        return new Response(null, { status: 404 });
    });
    origin = new URL(served.url).origin;
    const { action, post, provider } = await setup(t, { fixture: {
        ...httpEntry(served.url),
        authorization: { type: "oauth", redirectUrl: `${origin}/callback`, clientMetadataUrl: "https://client.example.test/oauth.json" },
    } }, [
        ...(busy ? [makeMockResponse("```SEND [200]\nThe held turn finished.\n```")] : []),
        makeMockResponse("````fixture (echo)\n{\"message\":\"management proof\"}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND [200]\nObserved the authorized result.\n````"),
    ]);
    const enabled = await action("authorization", "workspace.mcp.enable", { alias: "fixture" });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const definition = enabled.result?.definition as { state: string; authorization: { url: string } } | undefined;
    assert.ok(definition, "the authorization challenge publishes its definition");
    assert.equal(definition.state, "authorization-required");
    authorization = new URL(definition.authorization.url);
    assert.equal(authorization.searchParams.get("resource"), served.url);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(`${origin}/callback`);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", origin);
    const complete = (workspace: string, callbackUrl = callback.href) => action(workspace, "workspace.mcp.oauth.complete", { alias: "fixture", callbackUrl });
    // Every workspace prepares the configured server itself: another workspace's own attempt rejects this callback's state.
    const wrongWorkspace = await complete("other-authorization");
    assert.equal(wrongWorkspace.ok, false);
    assert.equal(wrongWorkspace.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-callback-invalid");
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "unrelated-attempt");
    const rejected = await complete("authorization", wrongState.href);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-callback-invalid");
    assert.equal(exchanges, 0, "rejected callbacks never exchange the code");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const generate = provider.generate.bind(provider);
    if (busy) t.mock.method(provider, "generate", async (...args: Parameters<typeof generate>) => {
        entered.resolve();
        await resume.promise;
        return generate(...args);
    }, { times: 1 });
    const running = busy ? post("authorization", undefined, "Hold this turn while sign-in completes.") : Promise.resolve([]);
    if (busy) await entered.promise;
    try {
        const begun = await action("authorization", "workspace.mcp.oauth.begin", { alias: "fixture", redirectUrl: `${origin}/callback` });
        assert.equal(begun.ok, true, JSON.stringify(begun));
        const challenge = begun.result as { authorization: { url: string } };
        authorization = new URL(challenge.authorization.url);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        const accepted = await complete("authorization");
        assert.equal(accepted.ok, true, JSON.stringify(accepted));
        assert.deepEqual(accepted.result, { status: 202, alias: "fixture" }, "callback acceptance is not a claim of published tools");
        assert.equal(exchanges, 1);
        if (busy) {
            const listed = await action("authorization", "workspace.mcp.list");
            assert.equal((listed.result?.definitions as { state: string }[] | undefined)?.[0]?.state, "authorization-required",
                "the in-flight turn retains its previous published snapshot");
            assert.deepEqual(await complete("authorization"), accepted, "a duplicate accepted callback does not exchange the grant again");
            assert.equal(exchanges, 1);
            const wrongRetry = await complete("authorization", wrongState.href);
            assert.equal(wrongRetry.ok, false, "an unrelated callback cannot borrow acceptance of the valid grant");
            assert.equal(wrongRetry.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-callback-invalid");
        }
    } finally { resume.resolve(); await running; }
    await waitForDb(() => action("authorization", "workspace.mcp.list"), (value) =>
        (value.result?.definitions as { state: string }[] | undefined)?.[0]?.state === "active");
    const replay = await complete("authorization");
    assert.equal(replay.ok, false);
    assert.equal(replay.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-not-pending");
    assert.equal(exchanges, 1);
    const events = await post("authorization", undefined, "Call the authorized echo and report its result.");
    assert.equal(((events.at(-1)?.result as { _meta?: { plurnk?: { stopReason?: string } } } | undefined)?._meta?.plurnk?.stopReason), "end_turn", JSON.stringify(events));
    assert.equal(provider.received.length, busy ? 3 : 2);
    const packet = provider.received.at(-1)!.map(chatMessageText).join("\n");
    assert.match(packet, /Authorized response: management proof/);
    assert.doesNotMatch(packet, /fixture-access|fixture-code|code_verifier/);
});
}

const applicationServer = async (t: TestContext, rejectGrant = false) => {
    let origin = "";
    let grants = 0;
    let calls = 0;
    let expired = false;
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "application", version: "1.0.0" });
        server.registerTool("echo", { inputSchema: z.object({ message: z.string() }), annotations: { readOnlyHint: true } }, async ({ message }) => {
            calls++;
            return { content: [{ type: "text", text: `Application response: ${message}` }] };
        });
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/mcp") {
            const authorization = request.headers.get("authorization");
            if (authorization === `Bearer fixture-app-access-${grants}` && !(expired && grants === 1)) return null;
            return new Response(null, { status: 401, headers: {
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            } });
        }
        if (path === "/.well-known/oauth-protected-resource/mcp") return Response.json({
            resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"],
        });
        if (path === "/.well-known/oauth-authorization-server") return Response.json({
            issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
            grant_types_supported: ["client_credentials"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
            response_types_supported: [], scopes_supported: ["mcp:read"],
        });
        if (path === "/token") {
            grants++;
            assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("fixture-app:fixture-app-secret").toString("base64")}`);
            const params = new URLSearchParams(await request.text());
            assert.equal(params.get("grant_type"), "client_credentials");
            assert.equal(params.get("resource"), served.url);
            assert.equal(params.get("scope"), "mcp:read");
            assert.equal(params.has("client_secret"), false, "the SDK uses the adopted client_secret_basic arm");
            if (rejectGrant) return Response.json({
                error: "invalid_client", error_description: "rejected fixture-app-secret; fixture-provider-detail",
            }, { status: 401 });
            return Response.json({ access_token: `fixture-app-access-${grants}`, token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
        }
        return new Response(null, { status: 404 });
    });
    origin = new URL(served.url).origin;
    return {
        ...served, issuer: origin,
        expire: () => { expired = true; },
        grants: () => grants, calls: () => calls,
    };
};

test("{§oauth-client-credentials}: ACP application credentials and SDK refresh deliver an authorized result to the model", { timeout: 20000 }, async (t) => {
    const served = await applicationServer(t);
    const authorization = { type: "client-credentials", clientId: "fixture-app", clientSecret: "${MCP_APP_SECRET}", issuer: served.issuer, scope: "mcp:read" };
    const { action, post, provider } = await setup(t, { fixture: { ...httpEntry(served.url), authorization } }, [
        makeMockResponse("````fixture (echo)\n{\"message\":\"application proof\"}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND [200]\nObserved the application result.\n````"),
    ], {
        MCP_APP_SECRET: "fixture-app-secret",
    });
    const workspace = "application-authorization";
    const enabled = await action(workspace, "workspace.mcp.enable", { alias: "fixture" });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.equal((enabled.result?.definition as { state: string } | undefined)?.state, "active");
    assert.equal(served.grants(), 1);
    served.expire();
    const events = await post(workspace, undefined, "Call the application echo and report its result.");
    assert.equal(((events.at(-1)?.result as { _meta?: { plurnk?: { stopReason?: string } } } | undefined)?._meta?.plurnk?.stopReason), "end_turn", JSON.stringify(events));
    assert.equal(served.grants(), 2, "the same attachment re-acquires after its access token is rejected");
    assert.equal(served.calls(), 1, "the server executes the tool once, after authorization succeeds");
    assert.equal(provider.received.length, 2);
    const packet = provider.received[1].map(chatMessageText).join("\n");
    assert.match(packet, /Application response: application proof/);
    assert.doesNotMatch(packet, /fixture-app-secret|fixture-app-access-/);
    const listed = await action(workspace, "workspace.mcp.list");
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const definitions = listed.result?.definitions as { definition: unknown }[] | undefined;
    assert.ok(definitions);
    assert.deepEqual(definitions[0]?.definition, {
        type: "streamable-http", url: served.url, authorization,
    }, "the complete definition retains symbolic authorization, never the resolved credential");
    assert.doesNotMatch(JSON.stringify([enabled, events, listed]), /fixture-app-secret|fixture-app-access-/);
    const request = served.requests.findLast(({ body }) => (body as { method?: string })?.method === "tools/call");
    assert.ok(request);
    const { params } = request.body as { params: { _meta: Record<string, { extensions: Record<string, unknown> }> } };
    assert.deepEqual(params._meta["io.modelcontextprotocol/clientCapabilities"]?.extensions["io.modelcontextprotocol/oauth-client-credentials"], {});
});

for (const mode of ["rejected grant", "wrong issuer"] as const) {
    test(`{§oauth-client-credentials}: ACP ${mode} fails atomically without publishing or echoing credentials`, { timeout: 20000 }, async (t) => {
        const served = await applicationServer(t, mode === "rejected grant");
        const { action, provider } = await setup(t, { fixture: {
            ...httpEntry(served.url),
            authorization: { type: "client-credentials", clientId: "fixture-app", clientSecret: "${MCP_APP_SECRET}",
                issuer: mode === "wrong issuer" ? "https://other-issuer.invalid" : served.issuer, scope: "mcp:read" },
        } }, [], { MCP_APP_SECRET: "fixture-app-secret" });
        const workspace = "rejected-application";
        const enabled = await action(workspace, "workspace.mcp.enable", { alias: "fixture" });
        assert.equal(enabled.ok, false);
        assert.equal(enabled.problem?.status, 502);
        assert.equal(enabled.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-client-credentials-failed");
        assert.doesNotMatch(JSON.stringify(enabled), /fixture-app-secret|fixture-provider-detail|fixture-app-access-/);
        if (mode === "wrong issuer") assert.equal(served.grants(), 0, "issuer mismatch withholds the credential from the token endpoint");
        else assert.equal(served.grants(), 4, "activation and the explicit enable each prepare once, each within the SDK's one bounded invalid-client retry; the host adds no retry loop");
        const listed = await action(workspace, "workspace.mcp.list");
        assert.equal(listed.ok, true, JSON.stringify(listed));
        const definitions = listed.result?.definitions as { alias: string; state: string; problem?: { type: string } }[] | undefined;
        assert.deepEqual(definitions?.map(({ alias, state, problem }) => ({ alias, state, type: problem?.type })),
            [{ alias: "fixture", state: "unavailable", type: "https://problems.plurnk.xyz/mcp/management/oauth-client-credentials-failed" }],
            "failed preparation publishes no attachment; the configured server stays listed as unavailable ({§mcp-configuration})");
        assert.doesNotMatch(JSON.stringify(listed), /fixture-app-secret|fixture-provider-detail|fixture-app-access-/);
        assert.equal(served.calls(), 0);
        assert.equal(provider.received.length, 0);
    });
}

test("{§mcp-host-composition} {§operation-results}: MCP progress reaches ACP while the owning tool remains pending", { timeout: 20000 }, async (t) => {
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "progress", version: "1.0.0" });
        server.registerTool("observe", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async (_args, ctx) => {
            const progressToken = ctx.mcpReq._meta?.progressToken;
            assert.notEqual(progressToken, undefined);
            await ctx.mcpReq.notify({ method: "notifications/progress", params: {
                progressToken: progressToken!, progress: 1, total: 2, message: "Observed first half.",
            } });
            await finish.promise;
            return { content: [{ type: "text", text: "Complete observation result." }] };
        });
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
    const { post, provider } = await setup(t, { fixture: httpEntry(served.url) }, [
        makeMockResponse("````fixture (observe)\n{}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND [200]\nThe observation completed.\n````"),
    ]);
    const received = Promise.withResolvers<Record<string, unknown>>();
    const running = post("live-progress", undefined, "Observe the tool result.", (event) => {
        const update = (event.params as { update?: { sessionUpdate?: string; _meta?: { plurnk?: { notice?: Record<string, unknown> } } } } | undefined)?.update;
        const notice = update?._meta?.plurnk?.notice;
        if (event.method === "session/update" && update?.sessionUpdate === "notice" && notice?.kind === "mcp_progress") {
            received.resolve(notice);
        }
    });
    try {
        const first = await Promise.race([received.promise, running.then(() => {
            throw new Error("The run ended without delivering live MCP progress.");
        })]);
        assert.deepEqual(first, { source: "exec:fixture", kind: "mcp_progress", level: "info",
            message: "Observed first half.", tool: "observe", progress: 1, total: 2 });
        assert.equal(provider.received.length, 1, "progress is observation, not a signal to resume inference");
        finish.resolve();
        const events = await running;
        assert.equal(((events.at(-1)?.result as { _meta?: { plurnk?: { stopReason?: string } } } | undefined)?._meta?.plurnk?.stopReason), "end_turn", JSON.stringify(events));
        assert.equal(provider.received.length, 2);
        assert.match(provider.received[1].map(chatMessageText).join("\n"), /Complete observation result/);
        assert.equal(events.filter((event) => {
            const update = (event.params as { update?: { sessionUpdate?: string; _meta?: { plurnk?: { notice?: Record<string, unknown> } } } } | undefined)?.update;
            return event.method === "session/update" && update?.sessionUpdate === "notice" && update._meta?.plurnk?.notice?.kind === "mcp_progress";
        }).length, 1);
    } finally {
        finish.resolve();
        await running;
    }
});

for (const deferred of [false, true]) {
    for (const outcome of ["valid", "invalid", "missing", "tool-error"] as const) {
        test(`{§mcp-host-composition}: ${deferred ? "Task" : "immediate"} ${outcome} output preserves schema and failure semantics`, { timeout: 20000 }, async (t) => {
            const fixture = taskHandler("tool-error");
            const handler = deferred ? fixture.handler : createMcpHandler(() => {
                const server = new McpServer({ name: "structured", version: "1.0.0" });
                server.registerTool(fixture.toolName, { inputSchema: z.object({ topic: z.string() }) }, async () => ({ content: [] }));
                return server;
            }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
            const result = {
                resultType: "complete", content: [{ type: "text", text: "structured-result evidence" }],
                ...(outcome === "missing" ? {} : { structuredContent: { count: outcome === "valid" ? 42 : "wrong-type" } }),
                ...(outcome === "tool-error" ? { isError: true } : {}),
            };
            let calls = 0;
            const served = await serveMcpHttp(t, handler, async (request) => {
                const wire = await request.clone().json() as { id: number | string; method: string };
                const reply = (value: unknown) => Response.json({ jsonrpc: "2.0", id: wire.id, result: value });
                if (wire.method === "tools/list") return reply({ resultType: "complete", ttlMs: 0, cacheScope: "public", tools: [{
                    name: fixture.toolName, inputSchema: { type: "object", properties: { topic: { type: "string", "x-mcp-header": "Topic" } }, required: ["topic"] },
                    outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
                    annotations: { readOnlyHint: true },
                }] });
                if (wire.method === "tools/call") {
                    calls++;
                    if (!deferred) return reply(result);
                }
                if (deferred && wire.method === "tasks/get") {
                    const response = await fixture.route(request);
                    assert.ok(response);
                    const body = await response.json() as { result: Record<string, unknown> };
                    return reply({ ...body.result, result });
                }
                return deferred ? fixture.route(request) : null;
            });
            const { post, provider } = await setup(t, { fixture: httpEntry(served.url) }, [
                makeMockResponse(`\`\`\`\`fixture (${fixture.toolName})
{"topic":"MCP"}
\`\`\`\`

\`\`\`\`WAIT
Observe the result.
\`\`\`\``),
                makeMockResponse("````SEND [200]\nInspected the result.\n````"),
            ]);
            const events = await post("structured", undefined, "Inspect the tool's result, including any failure.");
            assert.equal(((events.at(-1)?.result as { _meta?: { plurnk?: { stopReason?: string } } } | undefined)?._meta?.plurnk?.stopReason), "end_turn", JSON.stringify(events));
            assert.equal(calls, 1, "validation never replays the remote operation");
            assert.equal(provider.received.length, 2);
            const packet = provider.received[1].map(chatMessageText).join("\n");
            if (outcome === "valid") {
                assert.match(packet, /structured-result evidence/);
                assert.doesNotMatch(packet, /tool-call-failed|tool-reported-error/);
            } else if (outcome === "tool-error") {
                assert.match(packet, /structured-result evidence/);
                assert.match(packet, /executor\/mcp\/tool-reported-error/);
                assert.doesNotMatch(packet, /tool-call-failed/);
            } else {
                assert.match(packet, /executor\/mcp\/tool-call-failed/);
                const diagnostic = outcome === "missing" ? /did not return structured content/
                    : deferred ? /returned invalid structured content: data\/count must be integer/
                        : /Structured content does not match the tool's output schema: data\/count must be integer/;
                assert.match(packet, diagnostic);
                assert.doesNotMatch(packet, /structured-result evidence/, "an invalid success result is never presented as accepted content");
            }
        });
    }
}
});

describe("plurnk-skill", () => {
test("{§tools-resource-materialization} the discoverable COPY/MOVE chapter provides executable operand examples", async (t) => {
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { name: "transfer-reference" });
        const workspaceId = (created.result as { id: number }).id;
        const dispatch = async (statement: PlurnkStatement) =>
            (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
        const read = (uri: string) => dispatch(readStmt(parsePath(uri), { marks: [1, -1] }));
        const uri = "skill://plurnk/references/copy-move.md";
        const found = await dispatch(findStmt(parsePath("skill://plurnk/references/*"), regex("COPY")));
        assert.equal(found.status, 200);
        assert.ok(Array.isArray(found.results));
        assert.ok((found.results.flat() as Array<{ path: string }>).some(({ path }) => path === uri),
            "ordinary skill search discovers the chapter by the operation the model needs");
        assert.match(String((await read("skill://plurnk/SKILL.md")).content), /references\/copy-move\.md/u);
        const chapter = await read(uri);
        assert.equal(chapter.status, 200);
        assert.equal(chapter.content, (await readFile("docs/copy-move.md", "utf8")).trimEnd(), "the skill exposes its owning source verbatim");
        const parsed = PlurnkParser.parseStatements(chapter.content);
        assert.equal(parsed.unparsedTail, undefined);
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
        const examples = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(examples.map(writtenOp), ["COPY", "COPY", "MOVE"]);
        assert.equal((await dispatch(editStmt(parsePath("workspace:///src.md"), "one\ntwo\nthree\nfour\n"))).status, 201);
        for (const [index, statement] of examples.entries()) {
            const result = await dispatch(statement);
            assert.equal(result.status, index === 1 ? 200 : 201, JSON.stringify(result));
        }
        assert.equal((await read("workspace:///archive.md")).content, "two\nthree\none");
        assert.equal((await read("workspace:///src.md")).content, "one\ntwo\nthree\nfour");
        const content = async (pathname: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
        assert.equal(await content("/archive.md"), "two\nthree\none\n", "transfers retain source line separators, not the READ projection");
        assert.equal(await content("/src.md"), "one\ntwo\nthree\nfour\n", "COPY leaves source bytes unchanged");
        const moved = await read("workspace:///slice.md");
        assert.equal(moved.status, 404, "MOVE removes the transferred source channel");
        assert.equal((moved.problem as { type: string }).type, "https://problems.plurnk.xyz/scheme/workspace/entry-not-found");
    });
});

test("{§teaching-corpus} {§tools-resource-materialization} defaults are the operator catalog through ordinary READ and Session enablement", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-own-skill-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { projectRoot: root });
        const workspaceId = (created.result as { id: number }).id;
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const dispatch = async (statement: PlurnkStatement) =>
            (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
        const read = (uri: string) => dispatch(readStmt(parsePath(uri), { marks: [1, -1] }));
        const catalog = await dispatch({ ...findStmt(parsePath("skill://*/SKILL.md")), lineMarker: { marks: [1, -1] } });
        assert.equal(catalog.status, 200);
        assert.match(JSON.stringify(catalog.results), /skill:\/\/plurnk\/SKILL\.md/);
        assert.doesNotMatch(JSON.stringify(catalog.results), /PLURNK_SERVICE_MAX_TURNS/,
            "catalog discovery does not inject configuration bodies");
        const entry = await read("skill://plurnk/SKILL.md");
        assert.equal(entry.status, 200);
        assert.match(String(entry.content), /name: plurnk/);
        assert.match(String(entry.content), /\.env\.defaults/);
        const defaults = await read("skill://plurnk/.env.defaults");
        assert.equal(defaults.status, 200);
        const expected = EnvDefaults.renderCatalog((await EnvDefaults.collect(resolve("."), resolve("../node_modules"))).files);
        assert.equal(defaults.content, expected.trimEnd(), "the source matches the operator's complete installed catalog");
        const matches = await dispatch({ ...findStmt(parsePath("skill://plurnk/.env.defaults"), regex("PLURNK_PROVIDERS_OUTPUT_BUDGET")), lineMarker: { marks: [1, -1] } });
        assert.equal(matches.status, 200);
        assert.match(JSON.stringify(matches.results), /PLURNK_PROVIDERS_OUTPUT_BUDGET/);
        assert.equal((await dispatch(copyStmt(parsePath("skill://plurnk/.env.defaults")!, parsePath("workspace:///defaults.md")!))).status, 201);
        assert.equal((await read("workspace:///defaults.md")).content, expected.trimEnd(), "COPY consumes the generated resource through ordinary source access");
        const config = await read("skill://plurnk/references/configuration.md");
        assert.equal(config.status, 200);
        assert.equal(config.content, (await readFile("INSTALL.md", "utf8")).trimEnd(), "configuration has one package owner");
        const context = { scope: "workspace" as const, workspaceId };
        const child = await daemon.forkSession({ workspaceId, sessionId });
        // The child's own READ.
        const childRead = () => modelOperation(daemon, db, { workspaceId, sessionId: child.sessionId, statement: readStmt(parsePath("skill://plurnk/.env.defaults"), { marks: [1, 3] }) });
        assert.equal((await childRead()).status, 200, "children use the same workspace skill");
        await daemon.invokeModuleAction("workspace.skills.disable", { alias: "plurnk" }, context);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 404);
        assert.equal((await childRead()).status, 404, "disablement affects existing children too");
        await daemon.invokeModuleAction("workspace.skills.disable", { alias: "plurnk" }, context);
        assert.equal((await childRead()).status, 404);
        await daemon.invokeModuleAction("workspace.skills.enable", { alias: "plurnk" }, context);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 200);
        assert.equal((await childRead()).status, 200, "enablement restores the shared skill to the child");

        const custom = join(root, ".agents", "skills", "plurnk");
        await mkdir(custom, { recursive: true });
        await writeFile(join(custom, "SKILL.md"), "---\nname: plurnk\ndescription: Project-owned Plurnk guidance\n---\nProject guidance.\n");
        await daemon.invokeModuleAction("workspace.skills.enable", { alias: "plurnk" }, context);
        assert.match(String((await read("skill://plurnk/SKILL.md")).content), /Project guidance/);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 404, "shadowing replaces the tree, not an overlay leaking service resources");
    });
});

test("{§tools-resource-materialization} Turn0 catalogs the skill; only a requested READ adds defaults to the next packet", async (t) => {
    serverProposals(t, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-packet-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    class CapturingMock extends Mock {
        readonly requests: string[] = [];
        override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
            this.requests.push(args[0].messages.map((message) => chatMessageText(message)).join("\n\n"));
            return super.generate(...args);
        }
    }
    const provider = new CapturingMock({ contextWindow: 32768, responses: [
        { assistant: { content: "````READ (skill://plurnk/.env.defaults) <1,3>````\n````NOTE\nInspect the reference.\n````", reasoning: null } },
        { assistant: { content: "````SEND [200]\nReference received.\n````", reasoning: null } },
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { projectRoot: root, settings: { filesItems: -1 } });
        assert.equal((await runLoopToTerminal(ws, 2, { prompt: "Inspect configuration." })).finalStatus, 200);
        assert.equal(provider.requests.length, 2);
        assert.match(provider.requests[0], /skill:\/\/plurnk\/SKILL\.md/);
        assert.doesNotMatch(provider.requests[0], /# Plurnk installed configuration defaults/);
        const chapterHeading = (await readFile("INSTALL.md", "utf8")).split("\n")[0];
        assert.ok(!provider.requests[0].includes(chapterHeading), "the configuration chapter is not startup teaching");
        assert.doesNotMatch(provider.requests[0], /# COPY and MOVE/u, "the transfer chapter is also pull-only");
        assert.match(provider.requests[1], /# Plurnk installed configuration defaults/);
    });
});
});


describe("tools-expanded-survey", () => {
test("{§tools-resource-materialization} turn 0 exposes executable inline-program bodies in interpreter summaries", { timeout: 30_000 }, async () => {
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse(
        PlurnkParser.frame("SEND [200]", "Surveyed."),
    )] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(import.meta.dirname, "../../node_modules") });
    await daemon.start();
    const ws = await connect({ daemon });
    try {
        await rpcCall(ws, 1, "workspace.create", { name: "interpreter-summary-bodies", settings: { filesItems: -1 } });
        const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the available tools." });
        assert.equal(finalStatus, 200);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![1] });
        const survey = logEntries(JSON.parse(row!.packet)).find((entry) => entry.path === "plurnk:///*.md");
        assert.ok(survey && typeof survey.body === "string", "turn 0 carries the generated tool catalog");
        const body = survey.body.replace(/^ *\d+:/gm, "");
        const groups = JSON.parse(body) as Array<Array<{ path: string; aside?: string }>>;
        const jsEntry = groups.flat().find(({ path }) => path.endsWith("/js.md"));
        const aside = jsEntry?.aside;
        assert.ok(typeof aside === "string" && aside.includes("\n"), "js aside includes its inline body, not just an empty invocation");
        const parsed = PlurnkParser.parseStatements(aside, { executors: fixtureExecutors(aside) });
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0];
        assert.ok(item?.kind === "statement" && isExecution(item.statement));
        assert.equal(item.statement.runtime, "js");
        assert.equal(item.statement.target, null, "the program is not a script path or metadata modifier");
        assert.ok(typeof item.statement.body === "string" && item.statement.body.length > 0);
        assert.ok(item.statement.aside?.includes("JavaScript"), "the description stays on the invocation line");
    } finally {
        ws.close();
        await daemon.stop();
        await db.close();
    }
});
});

describe("workspace-capability-policy", () => {
const execStmt = (runtime: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null,
    body: "echo hi",
    position: { line: 1, column: 1 },
});

const runWithPolicy = async (capabilities: CapabilityPolicy, runtime: string) => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-${crypto.randomUUID()}`);
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities }),
        });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "policy");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await engine.dispatch({
            statement: execStmt(runtime),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
    } finally { await db.close(); }
};

test("{§operator-config-workspace-settings} {§capability-policy-cascade}: a workspace runtime denial refuses execution before executor resolution", async () => {
    const result = await runWithPolicy({ deny: [{ runtime: "sh" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
    assert.equal(result.problem?.retryable, false);
    assert.equal(result.problem?.recovery, undefined);
});

test("{§capability-policy-cascade}: workspace only makes every omitted runtime unavailable", async () => {
    const result = await runWithPolicy({ only: [{ runtime: "js" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
});

test("{§capability-policy-cascade}: one effective workspace policy filters executable references", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-render-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const before = await engine.referenceEntries(workspaceId);
        assert.ok(before.some((doc) => doc.scheme === "plurnk" && doc.pathname === "/js.md"));

        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities: { deny: [{ runtime: "js" }] } }),
        });
        const after = await engine.referenceEntries(workspaceId);
        assert.ok(!after.some((doc) => doc.scheme === "plurnk" && doc.pathname === "/js.md"));
        assert.ok(after.some((doc) => doc.scheme === "plurnk" && doc.pathname === "/sh.md"));

        const loopId = await insertLoop(db, sessionId, 1, "policy teaching");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("No external capabilities used.")] } }],
        });
        const { turnId } = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "inspect the tools" },
            ],
        });
        const stored = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
        assert.ok(stored !== undefined);
        const packet = JSON.parse(stored.packet) as { sections: Array<{ name: string }> };
        assert.equal(packet.sections.some(({ name }) => name === "tools"), false);
    } finally { await db.close(); }
});

test("{§capability-admission}: harness-authored initialization obeys the same workspace capability policy", async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `capability-init-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "finish without external capabilities");
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({
                capabilities: {
                    deny: [
                        { operation: "COPY" },
                        { operation: "FIND" },
                        { operation: "READ" },
                    ],
                },
            }),
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("No external capabilities used.")] } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "finish" },
            ],
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string | null; attrs: string }>({ loop_id: loopId });
        const harnessOps = rows.filter((row) => row.origin === "_plurnk" && !LogEntryProjection.isEmission(row)).map(({ op }) => op);
        assert.deepEqual(
            harnessOps.filter((op) => op === "COPY" || op === "FIND" || op === "READ"),
            [],
            "the harness neither advertises nor exercises capabilities denied to this workspace",
        );
    } finally {
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});


for (const layer of ["service", "workspace"] as const) test(`{§tools-resource-materialization}: ${layer} read-only policy preserves discoverable, readable session reference`, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    const previousCapabilities = process.env.PLURNK_SERVICE_CAPABILITIES;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    t.after(() => {
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
        if (previousCapabilities === undefined) delete process.env.PLURNK_SERVICE_CAPABILITIES;
        else process.env.PLURNK_SERVICE_CAPABILITIES = previousCapabilities;
    });
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `reference-read-only-${layer}`);
        const capabilities: CapabilityPolicy = { only: [{ access: "observe" }] };
        const { id: sessionId } = await SessionName.claimAuto(db, { workspaceId });
        if (layer === "service") process.env.PLURNK_SERVICE_CAPABILITIES = JSON.stringify(capabilities);
        if (layer === "workspace") await db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities }),
        });
        await LoopDocs.materialize(engine, db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 2, "Read the session reference.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "", reasoning: null, ops: [
                readStmt({ ...urlPath("plurnk", "/session.md"), hostname: null, raw: "plurnk:///session.md" }, { marks: [1, -1] }),
                readStmt({ ...urlPath("plurnk", "/delegation.md"), hostname: null, raw: "plurnk:///delegation.md" }, { marks: [1, -1] }),
                noteStmt("Continue."),
            ] } },
        ] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const rows = await db.test_log_entries_by_loop.all<{
            op: string; scheme: string; pathname: string; rx: string; status_rx: number;
        }>({ loop_id: loopId });
        const survey = rows.find(({ op, scheme, pathname }) => op === "FIND" && scheme === "plurnk" && pathname === "/*.md");
        assert.ok(survey, "read-only policy retains the native reference survey");
        const result = JSON.parse(survey.rx) as { content: string };
        const items = JSON.parse(result.content) as Array<Array<{ path: string; aside?: string }>>;
        const reference = items.flat().find(({ path }) => path.endsWith("/session.md"));
        assert.ok(reference?.aside, `session orientation is not hidden by its mutation examples: ${JSON.stringify(items)}`);
        const read = rows.find(({ op, scheme, pathname }) => op === "READ" && scheme === "plurnk" && pathname === "/session.md");
        assert.equal(read?.status_rx, 200, "the model can read the advertised reference through normal dispatch");
        assert.ok(JSON.parse(read.rx).content.includes("plurnk:///delegation.md"));
        const delegation = rows.find(({ op, scheme, pathname }) => op === "READ" && scheme === "plurnk" && pathname === "/delegation.md");
        assert.equal(delegation?.status_rx, 200, "the cross-reference follows the same admission as its session owner");
        assert.ok(JSON.parse(delegation.rx).content.includes("## Lifecycle"));
    } finally { await db.close(); }
});

test("{§session-scheme}: runtime maintenance preserves external policy and writer boundaries", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "generated-state-policy");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect references");
        const target = (scheme: "plurnk" | "workspace", path: string) => ({ ...urlPath(scheme, path), hostname: null, raw: `${scheme}://${path}` });
        const generated = target("plurnk", "/test.md");
        const external = target("workspace", "/notes.md");
        let sequence = 0;
        const dispatch = async (statement: Parameters<Engine["dispatch"]>[0]["statement"], origin: Parameters<Engine["dispatch"]>[0]["origin"] = "_plurnk") => {
            const turnSequence = ++sequence;
            const turnId = origin === "model"
                ? await insertTurn(db, loopId, turnSequence, 102)
                : await insertOperationTurn(db, loopId, turnSequence, origin, 102);
            return engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: 1, origin });
        };
        const policy = (capabilities: CapabilityPolicy) => db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities }),
        });
        await policy({ only: [{ access: "observe" }] });
        assert.equal((await dispatch(editStmt(generated, "reference"))).status, 201);
        assert.equal((await dispatch(editStmt(generated, "updated reference", { marks: [1, -1] }))).status, 200);
        assert.equal((await dispatch(readStmt(generated))).status, 200);
        for (const origin of ["model", "client"] as const) {
            assert.equal((await dispatch(editStmt(generated, "overwrite", { marks: [1, -1] }), origin)).status, 403, origin);
        }
        for (const operation of [editStmt(external, "outside"), copyStmt(generated, external), moveStmt(generated, external)]) {
            const result = await dispatch(operation);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        }
        const copy = target("plurnk", "/copied.md");
        assert.equal((await dispatch(copyStmt(generated, copy))).status, 201, "only the admitted source observation remains an external demand");
        assert.equal((await dispatch(killStmt(copy))).status, 200);
        assert.equal((await dispatch(killStmt(generated))).status, 200);
        await policy({});
        assert.equal((await dispatch(editStmt(external, "source"))).status, 201);
        for (const origin of ["model", "client"] as const) {
            const result = await dispatch(editStmt(generated, `${origin} content`, { marks: [1, -1] }), origin);
            assert.equal(result.status, 403, JSON.stringify(result));
        }
        await policy({ only: [{ access: "mutate" }] });
        const deniedCopy = await dispatch(copyStmt(external, generated));
        assert.equal(deniedCopy.status, 403, "an intrinsic destination does not authorize its source read");
        assert.equal(deniedCopy.problem?.access, "observe");
        await policy({ only: [] });
        assert.equal((await dispatch(editStmt(generated, "reference state", { marks: [1, -1] }))).status, 201);
        assert.equal((await dispatch(readStmt(generated))).status, 403, "runtime reads still use the workspace policy");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization}: read-only reconciliation records creation, replacement, and removal", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        let documentation = "# Reference\n\n## Summary\n\nFirst revision.";
        schemes.register("readable", {
            get manifest(): SchemeManifest {
                return {
                    name: "readable", category: "data",
                    channels: { body: "text/plain" }, defaultChannel: "body",
                    writableBy: [], modelVisible: true, volatile: false, documentation,
                };
            },
        });
        const engine = new Engine({ db, schemes });
        const workspaceId = await insertWorkspace(db, "read-only-reconciliation");
        await insertSession(db, workspaceId);
        const policy = (deny: CapabilityPolicy["deny"] = []) => db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities: { only: [{ access: "observe" }], deny } }),
        });
        await policy();
        const current = async () => (await db.loop_docs_materialized.all<{ scheme: string; pathname: string; content: string }>({
            workspace_id: workspaceId,
        })).find(({ scheme, pathname }) => scheme === "plurnk" && pathname === "/readable.md");
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal((await current())?.content, documentation);
        documentation = "# Reference\n\n## Summary\n\nSecond revision.";
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal((await current())?.content, documentation);
        await policy([{ scheme: "readable" }]);
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await current(), undefined);
        const rows = await db.test_log_entries_by_session.all<{
            op: string; pathname: string; origin: string; status_rx: number; turn_id: number;
        }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
        const changes = rows.filter(({ pathname, op }) => pathname === "/readable.md" && ["EDIT", "KILL"].includes(op));
        assert.deepEqual(changes.map(({ op, origin, status_rx }) => [op, origin, status_rx]), [
            ["EDIT", "_plurnk", 201], ["EDIT", "_plurnk", 200], ["KILL", "_plurnk", 200],
        ]);
        for (const { turn_id } of changes) {
            const turn = await db.test_get_turn.get<{ producer: string; kind: string; status: number }>({ id: turn_id });
            assert.equal(turn?.producer, "_plurnk");
            assert.equal(turn?.kind, "maintenance");
            assert.equal(turn?.status, 200);
        }
    } finally { await db.close(); }
});
});

