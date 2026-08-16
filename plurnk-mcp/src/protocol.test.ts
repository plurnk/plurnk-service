import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import packageJson from "../package.json" with { type: "json" };
import {
    MCP_CLIENT_VERSION,
    MCP_CONFORMANCE_VERSION,
    MCP_PROTOCOL_VERSION,
    MCP_SPECIFICATION_COMMIT,
    MCP_TASKS_EXTENSION_ID,
    MCP_TASKS_SPECIFICATION_COMMIT,
} from "./protocol.ts";

test("protocol authority exact-pins the final SDK and frozen conformance referee", () => {
    assert.equal(MCP_PROTOCOL_VERSION, "2026-07-28");
    assert.match(MCP_SPECIFICATION_COMMIT, /^[0-9a-f]{40}$/);
    assert.equal(packageJson.dependencies["@modelcontextprotocol/client"], MCP_CLIENT_VERSION);
    assert.equal(
        packageJson.devDependencies["@modelcontextprotocol/conformance"],
        MCP_CONFORMANCE_VERSION,
    );
});

test("the optional Tasks authority is exact-pinned without reviving legacy Tasks", () => {
    assert.equal(MCP_TASKS_EXTENSION_ID, "io.modelcontextprotocol/tasks");
    assert.equal(
        MCP_TASKS_SPECIFICATION_COMMIT,
        "2c1425d9a288b9b1f489430fe1e00bb392b47e48",
    );
});

test("the pinned client exposes the modern core seams consumed by the host", () => {
    const client = new Client(
        { name: "plurnk-mcp-contract-test", version: "0" },
        {
            versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
            inputRequired: { autoFulfill: false },
        },
    );
    for (const method of [
        "discover",
        "listTools",
        "callTool",
        "listResources",
        "listResourceTemplates",
        "readResource",
        "listPrompts",
        "getPrompt",
        "complete",
        "listen",
        "request",
    ] as const) {
        assert.equal(typeof client[method], "function", `missing MCP client seam ${method}`);
    }
});
