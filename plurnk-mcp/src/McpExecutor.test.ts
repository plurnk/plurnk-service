import assert from "node:assert/strict";
import test from "node:test";
import { stdioServer } from "../test/definitions.ts";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ERROR_DETAIL_LIMIT, type ExecArgs } from "@plurnk/plurnk-execs";

import type { Notice } from "@plurnk/plurnk-contracts";
import McpExecutor, { runtimeDecl, runtimeServerSummary, serverSummary, toolResultBody, type ToolResultShape } from "./McpExecutor.ts";
import ServerConnection, { type ServerCatalog } from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const interactionFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const retainWorkspace = (): (() => void) => () => undefined;

const configured = (): {
    connection: ServerConnection;
    executor: McpExecutor;
} => {
    const env = {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    };
    const connection = new ServerConnection(stdioServer("echo", [fixture]), env);
    return {
        connection,
        executor: new McpExecutor(
            { runtime: "echo", glyph: "🔌" },
            connection,
            retainWorkspace,
            { tools: ["echo"] },
        ),
    };
};

const harness = (
    overrides: Partial<ExecArgs> = {},
): {
    args: ExecArgs;
    writes: string[];
    states: string[];
    notices: Notice[];
    channels: Map<string, string>;
} => {
    const writes: string[] = [];
    const states: string[] = [];
    const notices: Notice[] = [];
    const channels = new Map<string, string>();
    return {
        writes,
        states,
        notices,
        channels,
        args: {
            metadata: null,
            runtime: "echo",
            body: "",
            cwd: null,
            target: null,
            signal: new AbortController().signal,
            write: (channel, chunk) => {
                channels.set(channel, (channels.get(channel) ?? "") + chunk);
                if (channel === "body") writes.push(chunk);
            },
            setState: (channel, state) => { if (channel === "body") states.push(state); },
            emit: (notice) => notices.push(notice),
            interact: async () => ({ status: "cancelled" }),
            ...overrides,
        },
    };
};

const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(pathname);
            return;
        } catch {
            await delay(10);
        }
    }
    await access(pathname);
};

test("runtime declaration derives the server summary from the chain", async () => {
    const declaration = runtimeDecl("echo", serverSummary("echo", undefined), false);
    assert.equal(declaration.summary, "MCP server echo.");
    assert.deepEqual(declaration.invocation, {
        body: { role: "JSON arguments", required: false, mimetype: "application/json" },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    });
    assert.equal(declaration.details, undefined);
});

test("MCP executor requires a tool target instead of duplicating catalog discovery", async () => {
    const { connection, executor } = configured();
    try {
        const h = harness();
        const result = await executor.run(h.args);
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/mcp/tool-required");
        assert.deepEqual(h.states, ["errored"]);
        assert.deepEqual(h.writes, []);
    } finally {
        await connection.close();
    }
});

test("MCP executor publishes exact enabled targets as one immutable registry", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        const registry = executor.toolRegistry();
        assert.equal(executor.toolRegistry(), registry, "every consumer receives the same immutable snapshot");
        assert.deepEqual(registry.tools.map((tool) => tool.target), ["echo"]);
        assert.deepEqual(registry.tools[0]?.invocation, {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            inputSchema: {
                type: "object", properties: { message: { type: "string" } },
                required: ["message"], additionalProperties: false,
            },
        });
        assert.equal(registry.tools[0]?.summary, "Echo one message.");
    } finally {
        await connection.close();
    }
});

test("{§mcp-model-projection} a tool's annotations.readOnlyHint alone makes its effect read", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: null },
    );
    try {
        await executor.requireAvailable();
        assert.equal(executor.effect("echo"), "read", "echo declares readOnlyHint: true");
        assert.equal(executor.effect("fail"), "host", "fail declares no hint and keeps the conservative host effect");
        assert.throws(() => executor.effect(null), /unregistered target/);
    } finally {
        await connection.close();
    }
});

test("configured tool policy fails setup when the server lacks an exact name", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["missing"] },
    );
    try {
        await assert.rejects(
            () => executor.requireAvailable(),
            /Configured MCP tool 'missing' is absent from server 'echo'/,
        );
    } finally {
        await connection.close();
    }
});

test("MCP executor calls a current tool and writes its result", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        const h = harness({
            target: "echo",
            body: JSON.stringify({ message: "hello" }),
        });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.deepEqual(h.states, ["closed"]);
        // The channel carries the result text itself, not the envelope ({§mcp-result-content}).
        assert.equal(h.writes[0], "hello");
    } finally {
        await connection.close();
    }
});

test("{§executor-page-receipt} a tool result exactly as long as the page it asked for, or the schema's default page, carries the page fact", async () => {
    const connection = {
        async catalog() {
            return {
                protocolVersion: "2026-07-28",
                server: { name: "pager", version: "1" },
                capabilities: {},
                tools: [{ name: "list", inputSchema: { type: "object", properties: { per_page: { type: "integer", default: 3 } } } }],
                resources: [],
                resourceTemplates: [],
                prompts: [],
                unsupportedLists: [],
            };
        },
        async callTool(_name: string, args: { per_page?: number; shape?: string }) {
            if (args.shape === "object") return { content: [], structuredContent: { total: 3 } };
            const items = Array.from({ length: Math.min(args.per_page ?? 3, 3) }, (_, index) => ({ id: index + 1 }));
            return args.shape === "text"
                ? { content: [{ type: "text", text: JSON.stringify(items) }] }
                : { content: [], structuredContent: items };
        },
    } as unknown as ServerConnection;
    const executor = new McpExecutor(
        { runtime: "pager", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["list"] },
    );
    await executor.requireAvailable();
    const run = async (body: string) => executor.run(harness({ runtime: "pager", target: "list", body }).args);
    assert.deepEqual(await run("{}"), { status: 200, page: { size: 3, returned: 3 } }, "the schema's default page, filled");
    assert.deepEqual(await run('{"per_page": 2}'), { status: 200, page: { size: 2, returned: 2 } }, "the page the call asked for, filled");
    assert.deepEqual(await run('{"per_page": 2, "shape": "text"}'), { status: 200, page: { size: 2, returned: 2 } }, "a JSON array in a text part counts the same");
    assert.deepEqual(await run('{"per_page": 5}'), { status: 200 }, "a shorter result is not a full page");
    assert.deepEqual(await run('{"shape": "object"}'), { status: 200 }, "a non-array result has no page");
});

test("{§mcp-tool-problem-detail} a tool Problem names its runtime and tool and bounds the remote diagnostic", async () => {
    const connection = {
        async catalog() {
            return {
                protocolVersion: "2026-07-28",
                server: { name: "effects", version: "1" },
                capabilities: {},
                tools: [{ name: "mutate", inputSchema: { type: "object" } }],
                resources: [],
                resourceTemplates: [],
                prompts: [],
                unsupportedLists: [],
            };
        },
        async callTool() {
            throw new Error("connection reset while the operator's token sk-not-in-the-packet was in flight");
        },
    } as unknown as ServerConnection;
    const executor = new McpExecutor(
        { runtime: "effects", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["mutate"] },
    );
    await executor.requireAvailable();
    const previous = process.env[ERROR_DETAIL_LIMIT];
    process.env[ERROR_DETAIL_LIMIT] = "4";
    let result;
    try {
        result = await executor.run(harness({ runtime: "effects", target: "mutate", body: "{}" }).args);
    } finally {
        if (previous === undefined) delete process.env[ERROR_DETAIL_LIMIT];
        else process.env[ERROR_DETAIL_LIMIT] = previous;
    }

    assert.equal(result.problem?.detail, "The MCP tool call failed.", "the prose states the boundary fact and nothing else"); // {§problems-mcp}
    assert.equal(result.problem?.runtime, "effects", "the failed runtime is a field, not prose");
    assert.equal(result.problem?.tool, "mutate", "so is the tool");
    assert.equal(result.problem?.diagnostic, "conn...", "the remote cause is admitted only within the operator's bound");
    assert.doesNotMatch(JSON.stringify(result), /sk-not-in-the-packet/u, "nothing past the bound reaches the model");
});

test("{§mcp-tool-problem-detail} tool-reported errors retain bounded text explanations without changing their evidence", async () => {
    const cases: Array<{ name: string; result: ToolResultShape; diagnostic?: string }> = [
        { name: "one text block", result: { isError: true, content: [{ type: "text", text: "No web results found" }] }, diagnostic: "No web results found" },
        { name: "multiple text blocks", result: { isError: true, content: [{ type: "text", text: "First cause" }, { type: "text", text: " \n " }, { type: "text", text: "Second cause" }] }, diagnostic: "First cause\nSecond cause" },
        { name: "mixed content", result: { isError: true, content: [{ type: "text", text: "First cause" }, { type: "resource_link", uri: "fixture://report", name: "Report" }, { type: "text", text: "Second cause" }] }, diagnostic: "First cause\nSecond cause" },
        { name: "bounded text", result: { isError: true, content: [{ type: "text", text: "x".repeat(40) }] }, diagnostic: `${"x".repeat(32)}...` },
        { name: "blank text", result: { isError: true, content: [{ type: "text", text: " \n " }] } },
        { name: "no content", result: { isError: true, content: [] } },
        { name: "absent content", result: { isError: true } },
        { name: "structured data", result: { isError: true, content: [], structuredContent: { message: "Not a text explanation" } } },
        { name: "resource link", result: { isError: true, content: [{ type: "resource_link", uri: "fixture://report", name: "Report" }] } },
        { name: "successful text", result: { content: [{ type: "text", text: "No web results found" }] } },
    ];
    const previous = process.env[ERROR_DETAIL_LIMIT];
    process.env[ERROR_DETAIL_LIMIT] = "32";
    try {
        for (const specimen of cases) {
            const connection = {
                async catalog() {
                    return {
                        protocolVersion: "2026-07-28", server: { name: "fixture", version: "1" }, capabilities: {},
                        tools: [{ name: "inspect", inputSchema: { type: "object" } }],
                        resources: [], resourceTemplates: [], prompts: [], unsupportedLists: [],
                    };
                },
                async callTool() { return specimen.result; },
            } as unknown as ServerConnection;
            const executor = new McpExecutor({ runtime: "fixture", glyph: "🔌" }, connection, retainWorkspace);
            await executor.requireAvailable();
            const h = harness({ runtime: "fixture", target: "inspect", body: "{}" });
            const result = await executor.run(h.args);
            assert.equal(result.status, specimen.result.isError ? 502 : 200, specimen.name);
            assert.equal(result.problem?.diagnostic, specimen.diagnostic, specimen.name);
            assert.deepEqual(JSON.parse(h.channels.get("json")!), specimen.result, `${specimen.name}: complete result preserved`);
            assert.equal(h.channels.get("body"), (await toolResultBody(specimen.result, "fixture")).content, `${specimen.name}: passive output preserved`);
            if (specimen.result.isError) {
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/mcp/tool-reported-error", specimen.name);
                assert.equal(result.problem?.retryable, false, specimen.name);
            }
        }
    } finally {
        if (previous === undefined) delete process.env[ERROR_DETAIL_LIMIT];
        else process.env[ERROR_DETAIL_LIMIT] = previous;
    }
});

test("{§mcp-tool-replay} an uncertain MCP tool-call failure never recommends automatic replay", async () => {
    const connection = {
        async catalog() {
            return {
                protocolVersion: "2026-07-28",
                server: { name: "effects", version: "1" },
                capabilities: {},
                tools: [{ name: "mutate", inputSchema: { type: "object" } }],
                resources: [],
                resourceTemplates: [],
                prompts: [],
                unsupportedLists: [],
            };
        },
        async callTool() {
            throw new Error("connection reset after dispatch");
        },
    } as unknown as ServerConnection;
    const executor = new McpExecutor(
        { runtime: "effects", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["mutate"] },
    );
    await executor.requireAvailable();
    const result = await executor.run(harness({ runtime: "effects", target: "mutate", body: "{}" }).args);

    assert.equal(result.status, 502);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/mcp/tool-call-failed");
    assert.equal(result.problem?.retryable, false, "the remote tool may already have applied its effect");
});

test("MCP executor keeps elicitation on its generic client interaction sink", async () => {
    const connection = new ServerConnection(stdioServer("interaction", [interactionFixture]), {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    });
    const executor = new McpExecutor(
        { runtime: "interaction", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["batch"] },
    );
    try {
        await executor.requireAvailable();
        const h = harness({
            runtime: "interaction",
            target: "batch",
            interact: async () => ({
                status: "resolved",
                payload: {
                    profile: { action: "accept", content: { name: "Ada" } },
                    approval: { action: "accept", content: { confirm: true } },
                },
            }),
        });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.match(h.writes[0] ?? "", /Ada/);
        assert.deepEqual(h.states, ["closed"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-result-content} every passive content variant is preserved losslessly as channel evidence", async () => {
    const connection = new ServerConnection(stdioServer("rich", [fixture], { env: { PLURNK_MCP_TEST_EXTENDED: "1" } }), {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    });
    const executor = new McpExecutor(
        { runtime: "rich", glyph: "🔌" },
        connection,
        retainWorkspace,
        { tools: ["rich"] },
    );
    try {
        await executor.requireAvailable();
        const publications: Array<{ name?: string; content: string | Uint8Array | null; mimetype?: string }> = [];
        const h = harness({ runtime: "rich", target: "rich", entry: async (path, content, options) => {
            assert.equal(path, null, "resources belong to the invocation, not an invented global address");
            publications.push({ content, ...options });
            return `rich:///1/1/1/rich/resources/${options.name ?? "ab12cd34"}`;
        } });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.deepEqual(
            (JSON.parse(h.channels.get("json") ?? "{}") as { content: unknown }).content,
            [
                    { type: "text", text: "prose" },
                    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
                    {
                        type: "resource_link",
                        uri: "fixture://document",
                        name: "Linked document",
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://embedded",
                            mimeType: "text/plain",
                            text: "embedded text",
                        },
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://binary",
                            mimeType: "application/octet-stream",
                            blob: "YmxvYg==",
                        },
                    },
                ],
        );
        assert.equal(publications.length, 4);
        assert.deepEqual(publications.map(({ content }) => typeof content === "string" ? content : Buffer.from(content!).toString()), ["image", "audio", "embedded text", "blob"]);
        assert.ok(h.writes[0]?.startsWith("prose\n<rich:///"), "the body preserves text and resource ordering");
        assert.match(h.writes[0]!, /rich:\/\/\/resources\/fixture%3A%2F%2Fdocument/u, "resource links use the ordinary MCP resource tree");
        assert.doesNotMatch(h.writes[0]!, /aW1hZ2U=|YXVkaW8=|YmxvYg==/u);
    } finally {
        await connection.close();
    }
});

test("MCP progress and cancellation remain on the owning execution lifecycle over stdio", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-exec-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "cancelled");
    const connection = new ServerConnection(stdioServer("lifecycle", [fixture], { env: {
            PLURNK_MCP_TEST_EXTENDED: "1",
            PLURNK_MCP_TEST_CANCEL_MARKER: marker,
        } }), {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    });
    let residencyLeases = 0;
    const executor = new McpExecutor(
        { runtime: "lifecycle", glyph: "🔌" },
        connection,
        () => {
            residencyLeases++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                residencyLeases--;
            };
        },
        { tools: ["progress", "wait"] },
    );
    try {
        await executor.requireAvailable();
        const progressed = harness({ runtime: "lifecycle", target: "progress" });
        assert.equal((await executor.run(progressed.args)).status, 200);
        assert.deepEqual(progressed.notices, [{
            source: "exec:lifecycle",
            kind: "mcp_progress",
            level: "info",
            message: "fixture halfway",
            tool: "progress",
            progress: 1,
            total: 2,
        }]);

        const controller = new AbortController();
        const cancelled = harness({
            runtime: "lifecycle",
            target: "wait",
            signal: controller.signal,
        });
        const running = executor.run(cancelled.args);
        await delay(50);
        assert.equal(residencyLeases, 1, "an in-flight MCP call retains worker Functionality");
        controller.abort(new Error("test cancellation"));
        const result = await running;
        assert.equal(result.status, 499);
        assert.equal(residencyLeases, 0, "terminal cancellation releases worker Functionality");
        assert.deepEqual(cancelled.states, ["errored"]);
        await waitForFile(marker);
    } finally {
        await connection.close();
    }
});

test("MCP executor backstops core admission against disabled targets", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        const h = harness({ target: "fail" });
        const result = await executor.run(h.args);
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/mcp/tool-not-enabled");
        assert.deepEqual(h.states, ["errored"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-summary-derivation} every server-summary tier has one deterministic precedence", () => {
    const catalog = (
        server: Readonly<Record<string, string>>,
        instructions?: string,
        tools = [{ name: "click", inputSchema: { type: "object" } }],
    ): ServerCatalog => ({
        protocolVersion: "2026-07-28",
        server: { name: "chrome_devtools", version: "0.1.0", ...server },
        capabilities: {},
        tools,
        resources: [],
        resourceTemplates: [],
        prompts: [],
        unsupportedLists: [],
        ...(instructions === undefined ? {} : { instructions }),
    }) as unknown as ServerCatalog;

    assert.equal(serverSummary("cdp", catalog({ description: " Server   description. ", title: "Display title" })), "Server description.");
    assert.equal(serverSummary("search", catalog({ title: "Search MCP" }, "Search the Web. Consult the available tools.")), "Search the Web.");
    assert.equal(serverSummary("search", catalog({ description: " \n ", title: "Search MCP" }, "Search the Web. More guidance.")), "Search the Web.");
    assert.equal(serverSummary("cdp", catalog({ title: "Chrome DevTools MCP server" }, " \n ")), "Chrome DevTools MCP server");
    assert.equal(serverSummary("cdp", catalog({ description: "", title: "" }, "")), "Tools: click.");
    assert.equal(serverSummary("cdp", catalog({ title: "Chrome DevTools MCP server" })), "Chrome DevTools MCP server");
    assert.equal(serverSummary("cdp", catalog({}, "First instruction. Second instruction.")), "First instruction.");
    assert.equal(serverSummary("cdp", catalog({}, undefined)), "Tools: click.");
    assert.equal(serverSummary("cdp", catalog({}, undefined, [])), "MCP server cdp.");
    assert.deepEqual(runtimeServerSummary("cdp", catalog({}, undefined)), { from: "tools" });
    assert.equal(runtimeServerSummary("cdp", catalog({}, undefined, [])), "MCP server cdp.");
    const instructions = "Search **the Web** for current information.\n\n## Results\nPreserve links and attribution.";
    const described = catalog({ title: "Search MCP" }, instructions);
    assert.deepEqual(runtimeServerSummary("search", described), { from: "tools", description: "Search **the Web** for current information." });
    assert.equal(runtimeDecl("search", runtimeServerSummary("search", described), false, instructions).details, instructions);
    assert.equal(runtimeDecl("search", "Search the Web.", false, " \n ").details, undefined);
    const verbose = catalog({ description: "Search ".repeat(100), title: "Search MCP" });
    assert.ok(serverSummary("search", verbose).length <= 81, "derived descriptions are bounded like tool summaries");
    assert.match(serverSummary("search", verbose), /…$/u);
});

// The invalid-arguments failure names the form that works, whatever the body was
// (https://repo.possumtech.com/plurnk/plurnk-bench/issues/6).
test("invalid tool arguments carry the one-object recovery", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        for (const body of ["{\"message\":\"a\"}\n```sh (echo/echo)\n{\"message\":\"b\"}\n```", "hello from MCP", "[1,2]"]) {
            const result = await executor.run(harness({ target: "echo", body }).args);
            assert.equal(result.status, 400, body);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/mcp/invalid-tool-arguments");
            assert.equal(result.problem?.recovery, "One JSON object per MCP tool call; a second call is a second fence."); // {§problems-mcp}
        }
    } finally {
        await connection.close();
    }
});

test("{§mcp-trailing-aside} an HTML comment after the one JSON object is an aside, not arguments", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        for (const body of ["{\"message\":\"a\"} <!-- echo it -->", "{\"message\":\"a\"}\n<!-- echo it --> <!-- twice -->"]) {
            const result = await executor.run(harness({ target: "echo", body }).args);
            assert.equal(result.status, 200, body);
        }
        const trailingProse = await executor.run(harness({ target: "echo", body: "{\"message\":\"a\"} and more" }).args);
        assert.equal(trailingProse.problem?.type, "https://problems.plurnk.xyz/executor/mcp/invalid-tool-arguments");
    } finally {
        await connection.close();
    }
});

test("{§mcp-result-content} the channel carries the result, never the envelope", async () => {
    const pretty = '[\n  {\n    "id": "PART-001"\n  }\n]';
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: pretty }] }, "fixture"), { content: pretty, mimetype: "application/json" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: '[{"id":"PART-001"}]' }] }, "fixture"), { content: pretty, mimetype: "application/json" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: '{"id":9007199254740993}' }] }, "fixture"), { content: '{\n  "id": 9007199254740993\n}', mimetype: "application/json" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: '{"partial":' }] }, "fixture"), { content: '{"partial":', mimetype: "text/plain" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: '{"a":1}\n{"b":2}' }] }, "fixture"), { content: '{"a":1}\n{"b":2}', mimetype: "text/plain" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: "plain words" }] }, "fixture"), { content: "plain words", mimetype: "text/plain" });
    assert.deepEqual(await toolResultBody({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, "fixture"), { content: "one\ntwo", mimetype: "text/plain" });
    assert.deepEqual(await toolResultBody({ content: [], structuredContent: { a: 1 } }, "fixture"), { content: '{\n  "a": 1\n}', mimetype: "application/json" });
    await assert.rejects(toolResultBody({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, "fixture"), /resource publisher/u);
});
