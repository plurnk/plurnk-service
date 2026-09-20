import { workingDirectory } from "../test/working-directory.ts";
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
import { ERROR_DETAIL_LIMIT } from "@plurnk/plurnk-execs";
import type { GetPromptResult, ResourceLink } from "@modelcontextprotocol/client";
import McpExecutor from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import ServerConnection, { type ServerCatalog } from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const interactionFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};
const retainWorkspace = (): (() => void) => () => undefined;

const configured = async (): Promise<{
    connection: ServerConnection;
    resources: McpResources;
}> => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        cwd: workingDirectory,
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
    metadata: null,
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
            address: async (pathname: string) => `echo://owner${pathname}`,
            read: async (pathname: string) => entries.has(pathname)
                ? { status: 200, entry: entries.get(pathname)! }
                : Results.failure("scheme:echo", "entry-not-found", 404, "No entry exists at this path.", { entry: null }),
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
        cwd: workingDirectory,
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

test("prompt content keeps roles and order while exposing typed snapshots and lazy resource links", async () => {
    const result: GetPromptResult = {
        description: "Inspect these resources.",
        messages: [
            { role: "user", content: { type: "text", text: "Keep this text unchanged.\n" } },
            { role: "assistant", content: { type: "image", data: "AQID", mimeType: "image/png", annotations: { audience: ["assistant"] } } },
            { role: "user", content: { type: "audio", data: "BAUG", mimeType: "audio/wav" } },
            { role: "user", content: { type: "resource", resource: { uri: "test:///notes.txt", text: "notes\r\n", mimeType: "text/plain" } } },
            { role: "user", content: { type: "resource", resource: { uri: "test:///notes.txt", blob: "BwgJ", mimeType: "application/octet-stream" } } },
            { role: "user", content: { type: "resource_link", name: "remote", uri: "test:///remote", mimeType: "image/png" } },
        ],
    };
    const calls: unknown[] = [];
    const connection = {
        async getPrompt(...args: unknown[]) { calls.push(args.slice(0, 2)); return result; },
    } as unknown as ServerConnection;
    const resources = new McpResources("echo", connection, {} as ServerCatalog);
    const { ctx, entries } = context();
    const pathname = "/prompts/inspect";
    const base = preparationRequest(pathname);
    assert.equal(base.target.kind, "url");
    if (base.target.kind !== "url") throw new Error("Expected URL fixture");
    const request = { ...base, target: { ...base.target, query: "topic=images" } };
    assert.equal((await resources.prepareRepresentation(request, ctx)).status, 200);
    assert.deepEqual(calls, [["inspect", { topic: "images" }]]);
    const root = entries.get(pathname)!;
    const projected = JSON.parse(root.channels.body!.content) as GetPromptResult;
    assert.deepEqual(projected.messages.map(({ role }) => role), result.messages.map(({ role }) => role));
    assert.deepEqual(projected.messages[0], result.messages[0]);
    assert.deepEqual(JSON.parse(root.channels.json!.content), result, "raw protocol evidence is unchanged");
    assert.doesNotMatch(root.channels.body!.content, /AQID|BAUG|BwgJ/u);
    const parts = projected.messages.slice(1).map(({ content }) => {
        assert.equal(content.type, "resource_link");
        return content as ResourceLink;
    });
    assert.match(parts[0]!.uri, /echo:\/\/owner\/prompts\/inspect\/resources\/[a-f0-9]{8}$/u);
    assert.deepEqual(parts[0]!.annotations, { audience: ["assistant"] });
    assert.match(parts[2]!.uri, /\/notes\.txt$/u);
    assert.match(parts[3]!.uri, /\/notes\.txt\.[a-f0-9]{8}$/u);
    assert.equal(parts[4]!.uri, "echo://owner/resources/test%3A%2F%2F%2Fremote");
    const children = parts.slice(0, 4).map(({ uri }) => new URL(uri).pathname);
    assert.deepEqual(entries.get(children[0]!)!.channels.body!.bytes, Buffer.from([1, 2, 3]));
    assert.equal(entries.get(children[1]!)!.channels.body!.mimetype, "audio/wav");
    assert.equal(entries.get(children[2]!)!.channels.body!.content, "notes\r\n");
    assert.deepEqual(entries.get(children[3]!)!.channels.body!.bytes, Buffer.from([7, 8, 9]));
    for (const path of children) assert.equal((await resources.prepareRepresentation(preparationRequest(path), ctx)).status, 200);
    assert.equal(calls.length, 1, "reading a snapshot never re-executes the argument-bearing prompt");
    assert.equal((await resources.prepareRepresentation(preparationRequest(`${pathname}/resources/missing`), ctx)).status, 404);
    assert.equal(calls.length, 1, "a missing snapshot does not silently re-execute the prompt");
    assert.equal((await resources.prepareRepresentation(request, ctx)).status, 200);
    assert.equal(entries.get(pathname)!.channels.body!.content, root.channels.body!.content, "reconstructed resources keep their names");
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

test("MCP resource failures bound third-party diagnostics", async () => {
    const prior = process.env[ERROR_DETAIL_LIMIT];
    process.env[ERROR_DETAIL_LIMIT] = "4";
    try {
        const connection = {
            async readResource() { throw new Error("sensitive remote diagnostic"); },
        } as unknown as ServerConnection;
        const catalog = {
            protocolVersion: "2026-07-28",
            server: { name: "fixture", version: "1" },
            capabilities: {},
            tools: [],
            resources: [{ uri: "fixture://document", name: "document" }],
            resourceTemplates: [],
            prompts: [],
            unsupportedLists: [],
        } as unknown as ServerCatalog;
        const resources = new McpResources("fixture", connection, catalog);
        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/fixture%3A%2F%2Fdocument"),
            context().ctx,
        );

        assert.equal(result.status, 502);
        assert.equal(result.problem?.diagnostic, "sens...");
        assert.doesNotMatch(JSON.stringify(result), /sensitive remote diagnostic/u);
    } finally {
        if (prior === undefined) delete process.env[ERROR_DETAIL_LIMIT];
        else process.env[ERROR_DETAIL_LIMIT] = prior;
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
