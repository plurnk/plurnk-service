import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocketConnection from "./WebSocketConnection.ts";

test("{§acp-transport} WebSocketConnection upgrades RFC 6455 handshakes and exchanges small and extended text frames", async () => {
    const received: string[] = [];
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
        const ws = WebSocketConnection.upgrade(req, socket, head, {
            onMessage: (text) => {
                received.push(text);
                ws?.send(`echo:${text}`);
            },
        });
        if (ws === null) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const { port } = server.address() as AddressInfo;
        const client = new WebSocket(`ws://127.0.0.1:${port}/acp`);
        const replies: string[] = [];
        const opened = Promise.withResolvers<void>();
        const twoReplies = Promise.withResolvers<void>();
        client.addEventListener("open", () => opened.resolve());
        client.addEventListener("message", (event) => {
            replies.push(String(event.data));
            if (replies.length === 2) twoReplies.resolve();
        });
        await opened.promise;
        const small = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
        const medium = "x".repeat(1024);
        client.send(small);
        client.send(medium);
        await twoReplies.promise;
        assert.deepEqual(received, [small, medium]);
        assert.deepEqual(replies, [`echo:${small}`, `echo:${medium}`]);
        client.close();
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
