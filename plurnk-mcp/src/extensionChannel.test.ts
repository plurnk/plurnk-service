import assert from "node:assert/strict";
import test from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

import ExtensionChannel from "./extensionChannel.ts";

test("coalesced core progress is delivered before its response settles", async () => {
    const observed: string[] = [];
    let pending = true;
    const transport: Transport = {
        start: async () => undefined,
        send: async () => undefined,
        close: async () => undefined,
        onmessage: (message) => {
            if ("method" in message && message.method === "notifications/progress") {
                queueMicrotask(() => {
                    if (pending) observed.push("progress");
                });
                return;
            }
            pending = false;
            observed.push("response");
        },
    };
    const channel = new ExtensionChannel(transport, {
        protocolVersion: "2026-07-28",
        clientInfo: { name: "test", version: "1.0.0" },
        clientCapabilities: {},
        cancelRequest: async () => undefined,
    });
    const progress: JSONRPCMessage = {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 1, progress: 1 },
    };
    const response: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: {},
    };

    transport.onmessage?.(progress);
    transport.onmessage?.(response);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(observed, ["progress", "response"]);
    channel.close();
});
