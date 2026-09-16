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
    const post = async (workspace: string, action?: Record<string, unknown>, prompt?: string): Promise<Event[]> => {
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "operator", runId: crypto.randomUUID(), state: {}, tools: [], context: [],
                messages: prompt === undefined ? [] : [{ id: crypto.randomUUID(), role: "user", content: prompt }],
                forwardedProps: { plurnk: { workspace, projectRoot: null, ...(action === undefined ? {} : { action }) } },
            }),
            signal: AbortSignal.timeout(10000),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        return body.split("\n\n").filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as Event);
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
        makeMockResponse('````fixture (echo)\n{"message":"management proof"}\n````\n\n````TASK\n[{"content":"Observe the result.","status":"waiting"}]\n````'),
        makeMockResponse('````SEND\nObserved the authorized result.\n````\n\n````TASK\n[{"content":"Observed the result.","status":"completed"}]\n````'),
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
