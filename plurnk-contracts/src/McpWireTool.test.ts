import test from "node:test";
import assert from "node:assert/strict";
import { MCP_WIRE_TOOL, type McpWireToolDefinition } from "./index.ts";

test("{§mcp-expressions} MCP_WIRE_TOOL defines the frozen universal mcp wire tool schema", () => {
    const tool: McpWireToolDefinition = MCP_WIRE_TOOL;
    assert.equal(tool.name, "mcp");
    assert.equal(tool.description, "Call an MCP tool.");
    assert.deepEqual(tool.parameters.required, ["server", "tool", "arguments"]);
    assert.equal(tool.parameters.properties.arguments.additionalProperties, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(Object.isFrozen(tool), true);
    assert.equal(Object.isFrozen(tool.parameters), true);
    assert.equal(Object.isFrozen(tool.parameters.required), true);
    assert.equal(Object.isFrozen(tool.parameters.properties.arguments), true);
});
