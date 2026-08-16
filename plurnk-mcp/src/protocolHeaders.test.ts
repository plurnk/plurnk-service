import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/client";
import {
    mcpParamHeaders,
    mcpRoutingHeaderValue,
} from "./protocolHeaders.ts";

test("MCP routing header values preserve safe ASCII and encode ambiguous values", () => {
    assert.equal(mcpRoutingHeaderValue("task-42"), "task-42");
    assert.equal(
        mcpRoutingHeaderValue(" task-α"),
        `=?base64?${Buffer.from(" task-α", "utf8").toString("base64")}?=`,
    );
    assert.equal(
        mcpRoutingHeaderValue("=?base64?already?="),
        `=?base64?${Buffer.from("=?base64?already?=", "utf8").toString("base64")}?=`,
    );
});

test("task-aware raw tool calls mirror declared primitive routing parameters", () => {
    const tool = {
        name: "defer",
        inputSchema: {
            type: "object",
            properties: {
                tenant: { type: "string", "x-mcp-header": "Tenant" },
                nested: {
                    type: "object",
                    properties: {
                        priority: { type: "integer", "x-mcp-header": "Priority" },
                    },
                },
                ignored: { type: "array", items: { type: "string" } },
            },
        },
    } satisfies Tool;
    assert.deepEqual(mcpParamHeaders(tool, {
        tenant: "α",
        nested: { priority: 3 },
        ignored: ["not-a-header"],
    }), {
        "Mcp-Param-Tenant": `=?base64?${Buffer.from("α", "utf8").toString("base64")}?=`,
        "Mcp-Param-Priority": "3",
    });
});
