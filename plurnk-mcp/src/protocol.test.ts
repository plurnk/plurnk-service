import assert from "node:assert/strict";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import {
    MCP_CLIENT_VERSION,
    MCP_CONFORMANCE_VERSION,
    MCP_PROTOCOL_VERSION,
    MCP_SPECIFICATION_COMMIT,
    MCP_TASKS_EXTENSION_ID,
    MCP_TASKS_SPECIFICATION_COMMIT,
} from "./protocol.ts";

test("{§mcp-authority} protocol authority exact-pins the final SDK and frozen conformance referee", () => {
    assert.equal(MCP_PROTOCOL_VERSION, "2026-07-28");
    assert.match(MCP_SPECIFICATION_COMMIT, /^[0-9a-f]{40}$/);
    assert.equal(packageJson.dependencies["@modelcontextprotocol/client"], MCP_CLIENT_VERSION);
    assert.equal(
        packageJson.devDependencies["@modelcontextprotocol/conformance"],
        MCP_CONFORMANCE_VERSION,
    );
});

test("{§mcp-authority} the optional Tasks authority is exact-pinned without reviving legacy Tasks", () => {
    assert.equal(MCP_TASKS_EXTENSION_ID, "io.modelcontextprotocol/tasks");
    assert.equal(
        MCP_TASKS_SPECIFICATION_COMMIT,
        "2c1425d9a288b9b1f489430fe1e00bb392b47e48",
    );
});
