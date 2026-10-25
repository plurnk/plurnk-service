import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { client as createAcpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { liveTest as test } from "../../../plurnk-core/test/live-test.ts";
import Module from "../../src/Module.ts";

const HARNESS = new URL("../../../plurnk-core/test/_live-harness.ts", import.meta.url).href;

test("live: the ACP client accepts the complete model response stream", async () => {
    const mod: unknown = await import(HARNESS);
    const liveWorkspace: (opts: { name: string }) => Promise<{
        daemon: ApplicationPort & { applicationPort?: () => ApplicationPort };
        cleanup: () => Promise<void>;
    }> = Reflect.get(Object(mod), "liveWorkspace");
    const ws = await liveWorkspace({ name: "live-acp-conformance" });
    const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>>();
    const upgrades = new Map<string, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        for (const [prefix, handler] of [...routes.entries()].toSorted((a, b) => b[0].length - a[0].length)) {
            if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
                await handler(req, res);
                return;
            }
        }
        res.writeHead(404).end();
    });
    server.on("upgrade", async (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        for (const [prefix, handler] of [...upgrades.entries()].toSorted((a, b) => b[0].length - a[0].length)) {
            if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
                await handler(req, socket, head);
                return;
            }
        }
        socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const rawAddr = server.address();
    const port = typeof rawAddr === "object" && rawAddr !== null ? rawAddr.port : 0;
    const acp = Module.create();
    const basePort = ws.daemon.applicationPort?.() ?? ws.daemon;
    await acp.start({
        ...basePort,
        registerHttpRoute: (prefix: string, h: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) => {
            routes.set(prefix, h);
        },
        registerHttpUpgrade: (prefix: string, h: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>) => {
            upgrades.set(prefix, h);
        },
        httpAddress: () => ({ host: "127.0.0.1", port }),
    });
    try {
        const wsCtor: WebSocketConstructor = Reflect.get({ v: WebSocket }, "v");
        const stream = createWebSocketStream(`ws://127.0.0.1:${port}/acp`, { WebSocket: wsCtor });
        const app = createAcpClient().onConnect((conn) => {
            void conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "test-client", version: "1.0.0" },
            });
        });
        await app.connectWith(stream, async (ctx) => {
            await ctx.buildSession("/tmp").withSession(async (session) => {
                await session.prompt("Reply with the single word PONG.");
                const reply = await session.readTextUntilIdle();
                assert.match(reply, /PONG/i);
            });
        });
    } finally {
        acp.stop();
        await acp.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await ws.cleanup();
    }
});
