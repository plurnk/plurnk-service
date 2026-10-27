import test from "node:test";
import assert from "node:assert/strict";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { WsConstructor, createAcpClient, createHarness } from "../harness.ts";

test("{§acp-first-party-client-conformance}: stock @agentclientprotocol/sdk v2 client exercises initialize, session/new, session/resume, session/prompt, and session/request_permission over WebSocket and Streamable HTTP", async () => {
    const h = await createHarness();
    try {
        const wsStream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const wsApp = createAcpClient();
        await wsApp.connectWith(wsStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            await ctx.buildSession("/workspace/alpha").withSession(async (session) => {
                await session.prompt("hello over ws");
                const text = await session.readTextUntilIdle();
                assert.match(text, /Echo: hello over ws/);
            });
        });

        const httpStream = createHttpStream(h.baseUrl);
        const httpApp = createAcpClient();
        await httpApp.connectWith(httpStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            const resumed = await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            assert.ok(resumed.configOptions);
        });
    } finally {
        await h.close();
    }
});
