import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type McpExecutor from "./McpExecutor.ts";
import type McpResources from "./McpResources.ts";
import Module from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

test("module registers every configured current MCP server as one executor and resource facet", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    const registrations: Array<{
        decl: RuntimeDecl;
        executor: McpExecutor;
        availability: RuntimeAvailability;
        scheme?: McpResources;
    }> = [];
    try {
        await module.setup({
            registerRuntime: async (registration) => {
                registrations.push(registration as typeof registrations[number]);
            },
        });
        assert.equal(registrations.length, 1);
        assert.equal(registrations[0]?.decl.name, "echo");
        assert.equal(registrations[0]?.availability.available, true);
        assert.match(registrations[0]?.availability.detail ?? "", /MCP 2026-07-28/);
        assert.equal(registrations[0]?.scheme?.claims("/resources/item"), true);
        assert.equal(registrations[0]?.scheme?.claims("/1/1/1"), false);
    } finally {
        await module.close();
    }
});
