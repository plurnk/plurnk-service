import test, { before, after } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import McpScheme from "./McpScheme.ts";
import { closeAll } from "./client.ts";
import type {
    SchemeCtx,
    SubscriptionHandle,
    ReadStatement,
    UrlPath,
    EntryData,
    CrossSchemeCaps,
} from "@plurnk/plurnk-schemes";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

// Fake SchemeCtx capturing the streaming lifecycle (the schemes-http test idiom):
// seed write → open → chunks → close, all recorded for positive assertion.
const makeCtx = () => {
    const chunks: { channel: string; chunk: string; mimetype?: string }[] = [];
    const state: {
        wrote: { pathname: string; entry: EntryData } | null;
        opened: string | null;
        closed: { reason: string; outcome?: string } | null;
    } = { wrote: null, opened: null, closed: null };
    const localAbort = new AbortController();
    const ctx: SchemeCtx = {
        workspaceId: 1, workerId: 1, loopId: 1, turnId: 1, writer: "model", signal: undefined,
        entries: {
            async read() { return { status: 404, entry: null }; },
            async write(pathname, entry) { state.wrote = { pathname, entry }; return { status: 201, created: true, entryId: 1 }; },
            async delete() { return { status: 200 }; },
        },
        channels: {
            async append() { return { status: 200 }; },
            async replace() { return { status: 200 }; },
            async setState() { return { status: 200 }; },
        },
        tags: {
            async add() { return { status: 200 }; },
            async remove() { return { status: 200 }; },
            async list() { return { status: 200, tags: [] }; },
        },
        notify: { streamEvent() {} },
        subscriptions: {
            async open(pathname: string, _handle: SubscriptionHandle) { state.opened = pathname; return localAbort.signal; },
            async notifyChunk(channel, chunk, mimetype) { chunks.push({ channel, chunk, mimetype }); },
            async close(reason, outcome) { state.closed = { reason, outcome }; },
        },
        crossScheme: {} as CrossSchemeCaps,
    };
    return { ctx, chunks, state };
};

const urlTarget = (raw: string, hostname: string, pathname: string, params: Record<string, string | string[]> = {}): UrlPath => ({
    kind: "url", raw, scheme: "mcp",
    username: null, password: null, hostname, port: null,
    pathname, params, fragment: null,
});

const readStmt = (target: UrlPath | null): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, target, lineMarker: null, body: null,
    position: { line: 0, column: 0 },
});

const read = async (hostname: string, pathname: string, params: Record<string, string | string[]> = {}) => {
    const { ctx, chunks, state } = makeCtx();
    const result = await new McpScheme().read(readStmt(urlTarget(`mcp://${hostname}${pathname}`, hostname, pathname, params)), ctx);
    return { result, chunks, state };
};

before(() => {
    process.env.PLURNK_EXECS_MCP_FULL = `node ${FIXTURE}`;
    process.env.PLURNK_EXECS_MCP_BARE = `node ${FIXTURE}`;
    process.env.PLURNK_EXECS_MCP_BARE_ENV = '{"MCP_FIXTURE_MODE":"bare"}';
    process.env.PLURNK_EXECS_MCP_NOTMPL = `node ${FIXTURE}`;
    process.env.PLURNK_EXECS_MCP_NOTMPL_ENV = '{"MCP_FIXTURE_MODE":"notemplates"}';
});
after(async () => { await closeAll(); });

// --- manifest ---

test("manifest: mcp scheme identity — volatile data scheme, body channel, deep doc", () => {
    const m = McpScheme.manifest;
    assert.equal(m.name, "mcp");
    assert.equal(m.defaultChannel, "body");
    assert.equal(m.channels.body, "application/json");
    assert.equal(m.category, "data");
    assert.equal(m.volatile, true);
    assert.equal(m.modelVisible, true);
    assert.match(String(m.documentation), /encodeURIComponent/, "the deep doc carries the #484 encoding rule");
});

// --- index (capability-aware catalog) ---

test("index: mcp://full/ streams the capability-aware catalog and settles done", async () => {
    const { result, chunks, state } = await read("full", "/");
    assert.equal(result.status, 102);
    assert.equal(state.opened, "full/", "entry key is server-qualified");
    assert.equal(state.closed?.reason, "done");
    assert.match(String(state.closed?.outcome), /catalog: 2 tools, 2 resources, 1 templates, 1 prompts/);
    const cat = JSON.parse(chunks[0].chunk);
    assert.deepEqual(cat.capabilities, { tools: true, resources: true, prompts: true });
    assert.deepEqual(cat.tools.map((t: { name: string }) => t.name).sort(), ["boom", "echo"]);
    assert.deepEqual(cat.resources.map((r: { uri: string }) => r.uri).sort(), ["mem://greeting.txt", "mem://parts"]);
    assert.deepEqual(cat.resourceTemplates.map((t: { uriTemplate: string }) => t.uriTemplate), ["mem://notes/{id}"]);
    assert.deepEqual(cat.prompts.map((p: { name: string }) => p.name), ["greet"]);
    assert.equal(chunks[0].mimetype, "application/json");
});

test("index: a bare (tools-only) server's catalog reflects exactly what it advertises", async () => {
    const { result, chunks } = await read("bare", "/");
    assert.equal(result.status, 102);
    const cat = JSON.parse(chunks[0].chunk);
    assert.deepEqual(cat.capabilities, { tools: true, resources: false, prompts: false });
    assert.equal(cat.resources, undefined, "no resources section for a server that advertises none");
    assert.equal(cat.prompts, undefined);
});

test("index: a server advertising resources without a templates handler still catalogs (-32601 tolerance)", async () => {
    const { result, chunks } = await read("notmpl", "/");
    assert.equal(result.status, 102);
    const cat = JSON.parse(chunks[0].chunk);
    assert.equal(cat.capabilities.resources, true);
    assert.equal(cat.resources.length, 2);
    assert.equal(cat.resourceTemplates, undefined, "missing templates handler is 'none', not a failure");
});

// --- tools ---

test("tool: mcp://full/tools/echo serves that tool's schema + annotations", async () => {
    const { result, chunks, state } = await read("full", "/tools/echo");
    assert.equal(result.status, 102);
    const tool = JSON.parse(chunks[0].chunk);
    assert.equal(tool.name, "echo");
    assert.equal(tool.inputSchema.properties.msg.type, "string");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(state.closed?.outcome, "tool echo");
});

test("tool: an unknown tool fails exactly — 404 mcp_unknown_tool, subscription errored", async () => {
    const { result, state } = await read("full", "/tools/nope");
    assert.equal(result.status, 404);
    assert.equal(result.error?.kind, "mcp_unknown_tool");
    assert.match(String(result.error?.message), /no tool 'nope' on 'full'/);
    assert.equal(state.closed?.reason, "error");
});

// --- resources ---

test("resource: the encoded-segment rule round-trips and content lands with the resource's OWN mimetype", async () => {
    const { result, chunks, state } = await read("full", `/resources/${encodeURIComponent("mem://greeting.txt")}`);
    assert.equal(result.status, 102);
    assert.deepEqual(chunks[0], { channel: "body", chunk: "hello from the fixture", mimetype: "text/plain" });
    assert.equal(state.closed?.reason, "done");
    assert.match(String(state.closed?.outcome), /resource mem:\/\/greeting\.txt; 22 chars/);
});

test("resource: a multi-part resource lands as the honest JSON envelope", async () => {
    const { result, chunks } = await read("full", `/resources/${encodeURIComponent("mem://parts")}`);
    assert.equal(result.status, 102);
    assert.equal(chunks[0].mimetype, "application/json");
    const parts = JSON.parse(chunks[0].chunk);
    assert.deepEqual(parts.map((p: { text: string }) => p.text), ["part one", "part two"]);
});

test("resource: a template-expanded URI reads through the same rule", async () => {
    const { result, chunks } = await read("full", `/resources/${encodeURIComponent("mem://notes/42")}`);
    assert.equal(result.status, 102);
    assert.equal(chunks[0].chunk, "note 42");
});

test("resource: an unadvertised primitive fails exactly — 501 mcp_unadvertised, never a transport error", async () => {
    const { result, state } = await read("bare", `/resources/${encodeURIComponent("mem://greeting.txt")}`);
    assert.equal(result.status, 501);
    assert.equal(result.error?.kind, "mcp_unadvertised");
    assert.match(String(result.error?.message), /'bare' does not advertise resources/);
    assert.equal(state.closed?.reason, "error");
});

// --- prompts ---

test("prompt: mcp://full/prompts/greet?who=world fetches the prompt with string args", async () => {
    const { result, chunks } = await read("full", "/prompts/greet", { who: "world" });
    assert.equal(result.status, 102);
    const prompt = JSON.parse(chunks[0].chunk);
    assert.equal(prompt.messages[0].content.text, "Say hello to world");
});

test("prompt: a repeated query arg fails exactly — 400 mcp_bad_arguments", async () => {
    const { result } = await read("full", "/prompts/greet", { who: ["a", "b"] });
    assert.equal(result.status, 400);
    assert.equal(result.error?.kind, "mcp_bad_arguments");
    assert.match(String(result.error?.message), /'who' given more than once/);
});

test("prompt: unadvertised on a bare server — 501 mcp_unadvertised naming prompts", async () => {
    const { result } = await read("bare", "/prompts/greet");
    assert.equal(result.status, 501);
    assert.equal(result.error?.kind, "mcp_unadvertised");
    assert.match(String(result.error?.message), /does not advertise prompts/);
});

// --- addressing failures (no connection made) ---

test("addressing: an unconfigured server is 404 mcp_not_configured", async () => {
    const { result, state } = await read("ghost", "/");
    assert.equal(result.status, 404);
    assert.equal(result.error?.kind, "mcp_not_configured");
    assert.equal(state.opened, null, "no subscription is opened for an unconfigured server");
});

test("addressing: an unknown path shape is 400 bad_path naming the valid shapes", async () => {
    const { result } = await read("full", "/bogus");
    assert.equal(result.status, 400);
    assert.equal(result.error?.kind, "bad_path");
    assert.match(String(result.error?.message), /\/tools\/<name>, \/resources\/<encoded-uri>, or \/prompts\/<name>/);
});

test("addressing: a null target is 400 bad_target", async () => {
    const { ctx } = makeCtx();
    const result = await new McpScheme().read(readStmt(null), ctx);
    assert.equal(result.status, 400);
    assert.equal(result.error?.kind, "bad_target");
});
