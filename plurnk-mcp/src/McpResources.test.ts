import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
    EntryData,
    ReadStatement,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import type McpResources from "./McpResources.ts";
import Module from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

const readStatement = (pathname: string): ReadStatement => ({
    op: "READ",
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
} as ReadStatement);

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
            operations: {
                read: async (statement: ReadStatement) => {
                    const pathname = statement.target?.kind === "url"
                        ? statement.target.pathname ?? "/"
                        : "/";
                    const entry = entries.get(pathname);
                    const body = entry?.channels.body;
                    return {
                        status: body === undefined ? 404 : 200,
                        content: body?.content ?? null,
                        mimetype: body?.mimetype ?? null,
                        channel: body === undefined ? null : "body",
                    };
                },
            },
        },
    } as unknown as SchemeCtx;
    return { ctx, entries };
};

test("resource facet reads current MCP resources through ordinary entry operations", async () => {
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
            registerRuntime: async (registration) => {
                resources = registration.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const { ctx, entries } = context();
        const pathname = "/resources/fixture%3A%2F%2Fdocument";
        const result = await resources.read(readStatement(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "alpha\nbeta\ngamma\n");
        assert.equal(result.mimetype, "text/plain");
        assert.deepEqual(entries.get(pathname)?.tags, ["mcp-resource"]);
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
            registerRuntime: async (registration) => {
                resources = registration.scheme as McpResources;
            },
        });
        if (resources === undefined) throw new Error("MCP resource facet was not registered.");
        const result = await resources.read(
            readStatement("/resources/%E0%A4%A"),
            context().ctx,
        );
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/mcp/resource-address-invalid");
        assert.equal(result.problem?.retryable, false);
    } finally {
        await module.close();
    }
});
