import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/client";
import {
    HeaderDeclarationError,
    assertHeaderDeclarations,
    mcpParamHeaders,
    mcpRoutingHeaderValue,
} from "./protocolHeaders.ts";

test("{§mcp-transports} MCP routing header values preserve safe ASCII and encode ambiguous values", () => {
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

test("{§mcp-transports} task-aware raw tool calls mirror declared primitive routing parameters", () => {
    const tool = {
        name: "defer",
        inputSchema: {
            type: "object",
            properties: {
                tenant: { type: "string", "x-mcp-header": "Tenant" },
                verbose: { type: "boolean", "x-mcp-header": "Verbose" },
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
        verbose: false,
        nested: { priority: 3 },
        ignored: ["not-a-header"],
    }), {
        "Mcp-Param-Tenant": `=?base64?${Buffer.from("α", "utf8").toString("base64")}?=`,
        "Mcp-Param-Verbose": "false",
        "Mcp-Param-Priority": "3",
    });
    assert.deepEqual(mcpParamHeaders(tool, { nested: { priority: 2.5 }, tenant: null }), {}, "a non-integer never mirrors an integer declaration");
});

test("{§mcp-header-declarations} every declaration form SEP-2243 forbids is refused naming the tool and the declaration", () => {
    type PropertySchema = NonNullable<Tool["inputSchema"]["properties"]>[string];
    const property = (schema: PropertySchema): Tool["inputSchema"] => ({ type: "object", properties: { field: schema } });
    const cases: Array<{ name: string; inputSchema: Tool["inputSchema"]; declaration: RegExp }> = [
        { name: "root", inputSchema: { type: "object", "x-mcp-header": "Root" }, declaration: /^\(root\): x-mcp-header outside a chain of properties$/u },
        { name: "under-items", inputSchema: { type: "object", properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } }, declaration: /^list\.<items>: x-mcp-header outside a chain of properties$/u },
        { name: "under-additional", inputSchema: { type: "object", additionalProperties: { type: "string", "x-mcp-header": "Extra" } }, declaration: /^<additionalProperties>: /u },
        { name: "under-one-of", inputSchema: { type: "object", oneOf: [{ type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } }] }, declaration: /^<oneOf>\.a: x-mcp-header outside/u },
        { name: "under-if", inputSchema: { type: "object", if: { properties: { a: { type: "string", "x-mcp-header": "A" } } } }, declaration: /^<if>\.a: /u },
        { name: "under-defs", inputSchema: { type: "object", $defs: { shared: { type: "string", "x-mcp-header": "Shared" } } }, declaration: /^<\$defs>: /u },
        { name: "empty", inputSchema: property({ type: "string", "x-mcp-header": "" }), declaration: /^field: x-mcp-header is not a non-empty string$/u },
        { name: "not-a-string", inputSchema: property({ type: "string", "x-mcp-header": 7 }), declaration: /is not a non-empty string$/u },
        { name: "space", inputSchema: property({ type: "string", "x-mcp-header": "Bad Name" }), declaration: /'Bad Name' is not an RFC 9110 token$/u },
        { name: "colon", inputSchema: property({ type: "string", "x-mcp-header": "Bad:Name" }), declaration: /is not an RFC 9110 token$/u },
        { name: "non-ascii", inputSchema: property({ type: "string", "x-mcp-header": "Région" }), declaration: /is not an RFC 9110 token$/u },
        { name: "control", inputSchema: property({ type: "string", "x-mcp-header": "Bad\nName" }), declaration: /is not an RFC 9110 token$/u },
        { name: "number", inputSchema: property({ type: "number", "x-mcp-header": "Score" }), declaration: /^field: x-mcp-header 'Score' on type number; permitted on string, integer and boolean$/u },
        { name: "object", inputSchema: property({ type: "object", "x-mcp-header": "Obj" }), declaration: /on type object;/u },
        { name: "array", inputSchema: property({ type: "array", "x-mcp-header": "Arr" }), declaration: /on type array;/u },
        { name: "null", inputSchema: property({ type: "null", "x-mcp-header": "Nil" }), declaration: /on type null;/u },
        { name: "untyped", inputSchema: property({ "x-mcp-header": "Untyped" }), declaration: /on type \(none\);/u },
        { name: "duplicate", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Region" }, b: { type: "string", "x-mcp-header": "Region" } } }, declaration: /^b: x-mcp-header 'Region' repeats 'Region'$/u },
        { name: "duplicate-case", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Region" }, b: { type: "integer", "x-mcp-header": "REGION" } } }, declaration: /^b: x-mcp-header 'REGION' repeats 'Region'$/u },
    ];
    for (const specimen of cases) {
        const tool = { name: `invalid_${specimen.name}`, inputSchema: specimen.inputSchema } satisfies Tool;
        assert.throws(() => assertHeaderDeclarations(tool), (error: unknown) => {
            assert.ok(error instanceof HeaderDeclarationError, specimen.name);
            assert.equal(error.tool, tool.name, specimen.name);
            assert.match(error.declaration, specimen.declaration, specimen.name);
            return true;
        }, specimen.name);
    }
    assert.doesNotThrow(() => assertHeaderDeclarations({
        name: "valid_tool",
        inputSchema: {
            type: "object",
            properties: {
                region: { type: "string", "x-mcp-header": "Region" },
                plain: { type: "number" },
                nested: { type: "object", properties: { priority: { type: "integer", "x-mcp-header": "Priority" } } },
                list: { type: "array", items: { type: "string" } },
            },
        },
    } satisfies Tool), "a plain number and an undeclared array are not declarations");
});
