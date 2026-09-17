import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { McpServer, ResourceTemplate, completable, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { taskHandler } from "../../../plurnk-mcp/test/task-fixture.ts";

type Event = Record<string, unknown>;
type ActionResult = { ok: boolean; result?: Record<string, unknown>; problem?: { type: string; status: number } };

const setup = async (t: TestContext, responses: ReturnType<typeof makeMockResponse>[] = []) => {
    const provider = new Mock({ contextWindow: 1_000_000, responses });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000",
    } }));
    const registration = AguiModule.init({ host: "127.0.0.1", port: 0 });
    let agui: AguiModule | undefined;
    daemon.registerModule({ start: async (seam) => {
        agui = await registration.start(seam);
        return agui;
    } });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(agui);
    const url = `http://127.0.0.1:${agui.address().port}/`;
    const post = async (
        workspace: string, action?: Record<string, unknown>, prompt?: string, onEvent?: (event: Event) => void,
    ): Promise<Event[]> => {
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "operator", runId: crypto.randomUUID(), state: {}, tools: [], context: [],
                messages: prompt === undefined ? [] : [{ id: crypto.randomUUID(), role: "user", content: prompt }],
                forwardedProps: { plurnk: { workspace, projectRoot: null, ...(action === undefined ? {} : { action }) } },
            }),
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const events: Event[] = [];
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of response.body) {
            pending += decoder.decode(chunk, { stream: true });
            const frames = pending.split("\n\n");
            pending = frames.pop()!;
            for (const frame of frames) {
                if (!frame.startsWith("data: ")) continue;
                const event = JSON.parse(frame.slice(6)) as Event;
                events.push(event);
                onEvent?.(event);
            }
        }
        assert.equal(pending.trim(), "", "the AG-UI response ends on a complete frame");
        return events;
    };
    const action = async (workspace: string, kind: string, params: Record<string, unknown> = {}): Promise<ActionResult> => {
        const events = await post(workspace, { kind, ...params });
        const result = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result");
        assert.ok(result, `no action result for ${kind}: ${JSON.stringify(events)}`);
        return result.value as ActionResult;
    };
    return { provider, post, action };
};

test("{§mcp-management-actions}: AG-UI completion preserves prompt and resource arguments and workspace binding", { timeout: 20000 }, async (t) => {
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
    const { action, provider } = await setup(t);
    const attached = await action("completions", "workspace.mcp.add", {
        alias: "fixture", definition: { name: "fixture", transport: "http", url: served.url },
    });
    assert.equal(attached.ok, true, JSON.stringify(attached));
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
    const unavailable = await action("other-workspace", "workspace.mcp.complete", {
        server: "fixture", ref: { type: "ref/prompt", name: "summarize" }, argument: { name: "topic", value: "P" },
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.problem?.type, "https://problems.plurnk.xyz/mcp/management/server-not-connected");
    assert.equal(provider.received.length, 0, "argument completion does not invoke a model");
});

test("{§oauth-continuation}: AG-UI authorization activates the same workspace attachment and its tool reaches the model", { timeout: 20000 }, async (t) => {
    let origin = "";
    let authorization: URL | undefined;
    let exchanges = 0;
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "authorized", version: "1.0.0" });
        server.registerTool("echo", { inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({
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
    const { action, post, provider } = await setup(t, [
        makeMockResponse("````fixture (echo)\n{\"message\":\"management proof\"}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND\nObserved the authorized result.\n````\n\n````SEND\n````"),
    ]);
    const added = await action("authorization", "workspace.mcp.add", {
        alias: "fixture", definition: { name: "fixture", transport: "http", url: served.url, read: ["echo"],
            authorization: { type: "oauth", redirectUrl: `${origin}/callback`, clientMetadataUrl: "https://client.example.test/oauth.json" } },
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    const definition = added.result?.definition as { state: string; authorization: { url: string } } | undefined;
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
    const wrongWorkspace = await complete("other-authorization");
    assert.equal(wrongWorkspace.ok, false);
    assert.equal(wrongWorkspace.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-not-pending");
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "unrelated-attempt");
    const rejected = await complete("authorization", wrongState.href);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-callback-invalid");
    assert.equal(exchanges, 0, "rejected callbacks never exchange the code");
    const accepted = await complete("authorization");
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal((accepted.result?.definition as { state: string } | undefined)?.state, "active");
    assert.equal(exchanges, 1);
    const replay = await complete("authorization");
    assert.equal(replay.ok, false);
    assert.equal(replay.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-not-pending");
    assert.equal(exchanges, 1);
    const events = await post("authorization", undefined, "Call the authorized echo and report its result.");
    assert.equal((events.at(-1)?.outcome as { type: string } | undefined)?.type, "success", JSON.stringify(events));
    assert.equal(provider.received.length, 2);
    const packet = provider.received[1]!.map(chatMessageText).join("\n");
    assert.match(packet, /Authorized response: management proof/);
    assert.doesNotMatch(packet, /fixture-access|fixture-code|code_verifier/);
});

const applicationServer = async (t: TestContext, rejectGrant = false) => {
    let origin = "";
    let grants = 0;
    let calls = 0;
    let expired = false;
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "application", version: "1.0.0" });
        server.registerTool("echo", { inputSchema: z.object({ message: z.string() }) }, async ({ message }) => {
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

test("{§oauth-client-credentials}: AG-UI application credentials and SDK refresh deliver an authorized result to the model", { timeout: 20000 }, async (t) => {
    const served = await applicationServer(t);
    const { action, post, provider } = await setup(t, [
        makeMockResponse("````fixture (echo)\n{\"message\":\"application proof\"}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND\nObserved the application result.\n````\n\n````SEND\n````"),
    ]);
    const workspace = "application-authorization";
    const configured = await action(workspace, "workspace.env.add", { alias: "MCP_APP_SECRET", definition: { value: "fixture-app-secret" } });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const definition = { name: "fixture", transport: "http", url: served.url, read: ["echo"],
        authorization: { type: "client-credentials", clientId: "fixture-app", clientSecret: "${MCP_APP_SECRET}", issuer: served.issuer, scope: "mcp:read" } };
    const added = await action(workspace, "workspace.mcp.add", { alias: "fixture", definition });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal((added.result?.definition as { state: string } | undefined)?.state, "active");
    assert.equal(served.grants(), 1);
    served.expire();
    const events = await post(workspace, undefined, "Call the application echo and report its result.");
    assert.equal((events.at(-1)?.outcome as { type: string } | undefined)?.type, "success", JSON.stringify(events));
    assert.equal(served.grants(), 2, "the same attachment re-acquires after its access token is rejected");
    assert.equal(served.calls(), 1, "the server executes the tool once, after authorization succeeds");
    assert.equal(provider.received.length, 2);
    const packet = provider.received[1]!.map(chatMessageText).join("\n");
    assert.match(packet, /Application response: application proof/);
    assert.doesNotMatch(packet, /fixture-app-secret|fixture-app-access-/);
    const listed = await action(workspace, "workspace.mcp.list");
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const definitions = listed.result?.definitions as { definition: unknown }[] | undefined;
    assert.ok(definitions);
    assert.deepEqual(definitions[0]?.definition, definition,
        "management retains the symbolic reference rather than the resolved credential");
    assert.doesNotMatch(JSON.stringify([added, events, listed]), /fixture-app-secret|fixture-app-access-/);
    const request = served.requests.findLast(({ body }) => (body as { method?: string })?.method === "tools/call");
    assert.ok(request);
    const { params } = request.body as { params: { _meta: Record<string, { extensions: Record<string, unknown> }> } };
    assert.deepEqual(params._meta["io.modelcontextprotocol/clientCapabilities"]?.extensions["io.modelcontextprotocol/oauth-client-credentials"], {});
});

for (const mode of ["rejected grant", "wrong issuer"] as const) {
    test(`{§oauth-client-credentials}: AG-UI ${mode} fails atomically without publishing or echoing credentials`, { timeout: 20000 }, async (t) => {
        const served = await applicationServer(t, mode === "rejected grant");
        const { action, provider } = await setup(t);
        const workspace = "rejected-application";
        const configured = await action(workspace, "workspace.env.add", { alias: "MCP_APP_SECRET", definition: { value: "fixture-app-secret" } });
        assert.equal(configured.ok, true, JSON.stringify(configured));
        const added = await action(workspace, "workspace.mcp.add", { alias: "fixture", definition: {
            name: "fixture", transport: "http", url: served.url,
            authorization: { type: "client-credentials", clientId: "fixture-app", clientSecret: "${MCP_APP_SECRET}",
                issuer: mode === "wrong issuer" ? "https://other-issuer.invalid" : served.issuer, scope: "mcp:read" },
        } });
        assert.equal(added.ok, false);
        assert.equal(added.problem?.status, 502);
        assert.equal(added.problem?.type, "https://problems.plurnk.xyz/mcp/management/oauth-client-credentials-failed");
        assert.doesNotMatch(JSON.stringify(added), /fixture-app-secret|fixture-provider-detail|fixture-app-access-/);
        if (mode === "wrong issuer") assert.equal(served.grants(), 0, "issuer mismatch withholds the credential from the token endpoint");
        else assert.equal(served.grants(), 2, "the SDK's one invalid-client retry is bounded; the host adds no retry loop");
        const listed = await action(workspace, "workspace.mcp.list");
        assert.equal(listed.ok, true, JSON.stringify(listed));
        assert.deepEqual(listed.result?.definitions, [], "failed preparation publishes no attachment");
        assert.equal(served.calls(), 0);
        assert.equal(provider.received.length, 0);
    });
}

test("{§mcp-host-composition} {§notice-event-notify}: MCP progress reaches AG-UI while the owning tool remains pending", { timeout: 20000 }, async (t) => {
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "progress", version: "1.0.0" });
        server.registerTool("observe", { inputSchema: z.object({}) }, async (_args, ctx) => {
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
    const { action, post, provider } = await setup(t, [
        makeMockResponse("````fixture (observe)\n{}\n````\n\n````WAIT\nObserve the result.\n````"),
        makeMockResponse("````SEND\nThe observation completed.\n````\n\n````SEND\n````"),
    ]);
    const added = await action("live-progress", "workspace.mcp.add", { alias: "fixture", definition: {
        name: "fixture", transport: "http", url: served.url, read: ["observe"],
    } });
    assert.equal(added.ok, true, JSON.stringify(added));
    const received = Promise.withResolvers<Event>();
    const running = post("live-progress", undefined, "Observe the tool result.", (event) => {
        if (event.type === "CUSTOM" && event.name === "plurnk.notice"
            && (event.value as { kind?: string })?.kind === "mcp_progress") received.resolve(event);
    });
    try {
        const first = await Promise.race([received.promise, running.then(() => {
            throw new Error("The run ended without delivering live MCP progress.");
        })]);
        assert.deepEqual(first.value, { source: "exec:fixture", kind: "mcp_progress", level: "info",
            message: "Observed first half.", tool: "observe", progress: 1, total: 2 });
        assert.equal(provider.received.length, 1, "progress is observation, not a signal to resume inference");
        finish.resolve();
        const events = await running;
        assert.equal((events.at(-1)?.outcome as { type: string } | undefined)?.type, "success", JSON.stringify(events));
        assert.equal(provider.received.length, 2);
        assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /Complete observation result/);
        assert.equal(events.filter((event) => event.type === "CUSTOM" && event.name === "plurnk.notice"
            && (event.value as { kind?: string })?.kind === "mcp_progress").length, 1);
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
            const { action, post, provider } = await setup(t, [
                makeMockResponse(`\`\`\`\`fixture (${fixture.toolName})
{"topic":"MCP"}
\`\`\`\`

\`\`\`\`WAIT
Observe the result.
\`\`\`\``),
                makeMockResponse("````SEND\nInspected the result.\n````\n\n````SEND\n````"),
            ]);
            const added = await action("structured", "workspace.mcp.add", { alias: "fixture", definition: {
                name: "fixture", transport: "http", url: served.url, read: [fixture.toolName],
            } });
            assert.equal(added.ok, true, JSON.stringify(added));
            const events = await post("structured", undefined, "Inspect the tool's result, including any failure.");
            assert.equal((events.at(-1)?.outcome as { type: string } | undefined)?.type, "success", JSON.stringify(events));
            assert.equal(calls, 1, "validation never replays the remote operation");
            assert.equal(provider.received.length, 2);
            const packet = provider.received[1]!.map(chatMessageText).join("\n");
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
