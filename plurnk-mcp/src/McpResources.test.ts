import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
    EntryData,
    EntryStorageWriteResult,
    RepresentationPreparationRequest,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import type McpResources from "./McpResources.ts";
import Module from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

const preparationRequest = (pathname: string): RepresentationPreparationRequest => ({
    target: {
        kind: "url",
        raw: `echo://${pathname}`,
        scheme: "echo",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    pathname,
});

const context = (): {
    ctx: SchemeCtx;
    entries: Map<string, EntryData>;
} => {
    const entries = new Map<string, EntryData>();
    const ctx = {
        signal: undefined,
        entries: {
            read: async (pathname: string) => ({
                status: 200,
                entry: entries.get(pathname) ?? null,
            }),
            write: async (pathname: string, entry: EntryData) => {
                entries.set(pathname, entry);
                return {
                    status: 200,
                    created: true,
                    entryId: entries.size,
                };
            },
            operations: {},
        },
    } as unknown as SchemeCtx;
    return { ctx, entries };
};

test("resource facet materializes current MCP resources as ordinary entries", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    let resources: McpResources | undefined;
    try {
        await module.setup({
            registerRuntimes: async ([registration]) => {
                resources = registration?.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const { ctx, entries } = context();
        const pathname = "/resources/fixture%3A%2F%2Fdocument";
        const result = await resources.prepareRepresentation(preparationRequest(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(entries.get(pathname)?.channels.body?.content, "alpha\nbeta\ngamma\n");
        assert.equal(entries.get(pathname)?.channels.body?.mimetype, "text/plain");
        assert.deepEqual(entries.get(pathname)?.attributes, { kind: "mcp-resource" });
    } finally {
        await module.close();
    }
});

test("resource catalogs never become a parallel tool discovery surface", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    let resources: McpResources | undefined;
    try {
        await module.setup({
            registerRuntimes: async ([registration]) => {
                resources = registration?.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const { ctx, entries } = context();
        const result = await resources.prepareRepresentation(preparationRequest("/"), ctx);
        assert.equal(result.status, 200);
        const catalog = JSON.parse(entries.get("/")?.channels.body?.content ?? "{}") as Record<string, unknown>;
        assert.deepEqual(Object.keys(catalog).toSorted(), ["resourceTemplates", "resources"]);
        assert.equal(JSON.stringify(catalog).includes("fail"), false);
        assert.equal(resources.claims("/echo"), false);
        assert.equal(resources.claims("/fail"), false);
    } finally {
        await module.close();
    }
});

test("resource facet rejects malformed encoded addresses as non-retryable client errors", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    let resources: McpResources | undefined;
    try {
        await module.setup({
            registerRuntimes: async ([registration]) => {
                resources = registration?.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/%E0%A4%A"),
            context().ctx,
        );
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/mcp/resource-address-invalid");
        assert.equal(result.problem?.retryable, false);
    } finally {
        await module.close();
    }
});

test("resource materialization preserves a failed entry write's original Problem", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    let resources: McpResources | undefined;
    try {
        await module.setup({
            registerRuntimes: async ([registration]) => {
                resources = registration?.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const failedWrite = Results.failure(
            "scheme:test-storage",
            "write-denied",
            409,
            "The canonical entry write was rejected.",
            { created: false, entryId: null },
        ) as EntryStorageWriteResult;
        const { ctx } = context();
        ctx.entries.write = async () => failedWrite;

        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/fixture%3A%2F%2Fdocument"),
            ctx,
        );

        assert.equal(result.status, 409);
        assert.equal(result.problem, failedWrite.problem);
    } finally {
        await module.close();
    }
});
