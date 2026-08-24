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
import McpExecutor from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import ServerConnection from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const interactionFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};
const retainWorkspace = (): (() => void) => () => undefined;

const configured = async (): Promise<{
    connection: ServerConnection;
    resources: McpResources;
}> => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
    }, env);
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        retainWorkspace,
    );
    await executor.requireAvailable();
    return {
        connection,
        resources: new McpResources("echo", connection, executor.catalog),
    };
};

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
    authority: "",
    pathname,
});

const context = (): {
    ctx: SchemeCtx;
    entries: Map<string, EntryData>;
} => {
    const entries = new Map<string, EntryData>();
    const ctx = {
        signal: undefined,
        interactions: {
            request: async () => ({ status: "cancelled" as const }),
        },
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

const interactionResources = async (): Promise<{
    connection: ServerConnection;
    resources: McpResources;
}> => {
    const connection = new ServerConnection({
        name: "interaction",
        transport: "stdio",
        command: process.execPath,
        args: [interactionFixture],
    }, env);
    const executor = new McpExecutor(
        { runtime: "interaction", glyph: "🔌" },
        connection,
        retainWorkspace,
    );
    await executor.requireAvailable();
    return {
        connection,
        resources: new McpResources("interaction", connection, executor.catalog),
    };
};

test("resource facet materializes current MCP resources as ordinary entries", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const pathname = "/resources/fixture%3A%2F%2Fdocument";
        const result = await resources.prepareRepresentation(preparationRequest(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(entries.get(pathname)?.channels.body?.content, "alpha\nbeta\ngamma\n");
        assert.equal(entries.get(pathname)?.channels.body?.mimetype, "text/plain");
        assert.deepEqual(entries.get(pathname)?.attributes, { kind: "mcp-resource" });
    } finally {
        await connection.close();
    }
});

test("resource catalogs never become a parallel tool discovery surface", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const result = await resources.prepareRepresentation(preparationRequest("/"), ctx);
        assert.equal(result.status, 200);
        const catalog = JSON.parse(entries.get("/")?.channels.body?.content ?? "{}") as Record<string, unknown>;
        assert.deepEqual(Object.keys(catalog).toSorted(), ["prompts", "resourceTemplates", "resources"]);
        assert.equal(JSON.stringify(catalog).includes("fail"), false);
        assert.equal(resources.claims("/echo"), false);
        assert.equal(resources.claims("/fail"), false);
    } finally {
        await connection.close();
    }
});

test("prompt definitions and retrieval use the server resource authority", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const pathname = "/prompts/summarize";
        const base = preparationRequest(pathname);
        if (base.target.kind !== "url") throw new Error("fixture prompt target must be a URL");
        const request: RepresentationPreparationRequest = {
            ...base,
            target: {
                ...base.target,
                raw: "echo:///prompts/summarize?topic=MCP",
                query: "topic=MCP",
            },
        };
        const result = await resources.prepareRepresentation(request, ctx);
        assert.equal(result.status, 200);
        const prompt = JSON.parse(entries.get(pathname)?.channels.body?.content ?? "{}") as {
            messages?: unknown;
        };
        assert.deepEqual(prompt.messages, [{
            role: "user",
            content: { type: "text", text: "Summarize MCP." },
        }]);
        assert.deepEqual(entries.get(pathname)?.attributes, { kind: "mcp-prompt" });
    } finally {
        await connection.close();
    }
});

test("resource materialization routes MCP elicitation through SchemeCtx", async () => {
    const { connection, resources } = await interactionResources();
    try {
        const { ctx, entries } = context();
        ctx.interactions.request = async (request) => {
            assert.equal(request.toolName, "mcp_input_required");
            assert.equal(request.arguments.operation, "resources/read");
            return {
                status: "resolved",
                payload: {
                    read: { action: "accept", content: { confirm: true } },
                },
            };
        };
        const pathname = "/resources/fixture%3A%2F%2Fguarded";
        const result = await resources.prepareRepresentation(preparationRequest(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(entries.get(pathname)?.channels.body?.content, "read:accept");
    } finally {
        await connection.close();
    }
});

test("resource facet rejects malformed encoded addresses as non-retryable client errors", async () => {
    const { connection, resources } = await configured();
    try {
        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/%E0%A4%A"),
            context().ctx,
        );
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/mcp/resource-address-invalid");
        assert.equal(result.problem?.retryable, false);
    } finally {
        await connection.close();
    }
});

test("resource materialization preserves a failed entry write's original Problem", async () => {
    const { connection, resources } = await configured();
    try {
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
        await connection.close();
    }
});
