import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePath } from "@plurnk/plurnk-contracts";
import type {
    EntryData,
    EntryFindResult,
    EntryStorageWriteResult,
    FindStatement,
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

const context = (
    find: ((statement: FindStatement) => Promise<EntryFindResult>) | undefined = undefined,
): {
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
            delete: async (pathname: string) => {
                const deleted = entries.delete(pathname);
                return deleted
                    ? { status: 200 }
                    : Results.failure("scheme:test-storage", "not-found", 404, "Entry not found.");
            },
            operations: {
                find: find ?? (async () => ({
                    status: 200,
                    content: "[]",
                    mimetype: "application/json",
                    results: [],
                    itemsWeightTotal: 0,
                    returnedItemsWeightTotal: 0,
                    matchingPathCount: 0,
                    matchLocationCount: 0,
                })),
            },
        },
    } as unknown as SchemeCtx;
    return { ctx, entries };
};

const findStatement = (address: string): FindStatement => ({
    op: "FIND",
    suffix: "",
    signal: null,
    target: parsePath(address),
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

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

test("tool authorities resolve and materialize the exact current tool contract", async () => {
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
        const target = parsePath("echo://echo/");
        if (target === null) throw new Error("Tool address did not parse.");
        const { ctx, entries } = context();
        const address = await resources.resolveEntryAddress(target, ctx);
        assert.deepEqual(address, { pathname: "/tools/echo", owner: "commons" });
        const result = await resources.prepareRepresentation({
            target,
            pathname: "/tools/echo",
        }, ctx);
        assert.equal(result.status, 200);
        assert.deepEqual(entries.get("/tools/echo")?.attributes, { kind: "mcp-tool-contract" });
        const contract = JSON.parse(entries.get("/tools/echo")?.channels.body?.content ?? "{}") as {
            address?: string;
            name?: string;
            inputSchema?: { required?: string[] };
        };
        assert.equal(contract.address, "echo://echo/");
        assert.equal(contract.name, "echo");
        assert.deepEqual(contract.inputSchema?.required, ["message"]);
    } finally {
        await module.close();
    }
});

test("tool FIND maps storage coordinates back to exact public authority addresses", async () => {
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
        let received: FindStatement | undefined;
        const { ctx } = context(async (statement) => {
            received = statement;
            return {
                status: 200,
                content: '[[{"path":"echo:///tools/echo","mimetype":"application/json","tokens":12,"lines":1}]]',
                mimetype: "application/json",
                results: [[{
                    path: "echo:///tools/echo",
                    mimetype: "application/json",
                    weight: 12,
                    lines: 1,
                }]],
                itemsWeightTotal: 12,
                returnedItemsWeightTotal: 12,
                matchingPathCount: 1,
                matchLocationCount: 0,
            };
        });
        const result = await resources.find(findStatement("echo://*/"), ctx);
        assert.equal(received?.target?.kind, "url");
        assert.equal(received?.target?.kind === "url" ? received.target.hostname : undefined, null);
        assert.equal(received?.target?.kind === "url" ? received.target.pathname : undefined, "/tools/*");
        const item = result.results[0];
        assert.ok(Array.isArray(item));
        assert.equal(item[0]?.path, "echo://echo/");
        assert.equal(JSON.parse(result.content ?? "[]")[0]?.[0]?.path, "echo://echo/");
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
