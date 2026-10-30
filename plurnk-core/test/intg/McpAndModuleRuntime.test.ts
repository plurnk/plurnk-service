import test, { describe, before as beforeAll, after as afterAll, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ExecutorRegistry, { type RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EnvFunctionality from "../../src/server/EnvFunctionality.ts";
import { ownSession, serverProposals, TEST_OWNER } from "./_approval.ts";
import { type ReadStatement, Validator, type FunctionalityListResult, type CapabilityPolicy } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { executionAddress, awaitExecOutcome } from "./_execs.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { type RuntimeSchemeFacet } from "@plurnk/plurnk-schemes";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { waitForDb, waitFor } from "./_rpc.ts";
import { clientRead } from "./_client-read.ts";
import { makeRawMockResponse, makeMockResponse, fixtureExecutors } from "./_mock.ts";
import { modelOperation } from "./_sessions.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { MCP_CONTROLS, mcpFixture, httpEntry, mcpEnvironment } from "./_mcp-config.ts";
import { fileURLToPath } from "node:url";
import { McpServer, createMcpHandler, fromJsonSchema, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";


describe("mcp-env-composition", () => {
const fixture = fileURLToPath(new URL("./fixtures/environment-mcp.mjs", import.meta.url));
// A stdio definition for the environment fixture, which records each launch's environment in its marker.
const environmentEntry = (env: Readonly<Record<string, string>>): object => ({ type: "stdio", command: "node", args: [fixture], env: { ...env } });
type Start = { witness: string | null; private: string | null; bound: string | null; catalog: string | null; plurnk: string | null; reference: string | null; home: string | null; pid: number };

// {§mcp-module} — the operator's environment is the daemon process's own, so the test sets it there.
const withOperatorEnvironment = (t: TestContext, values: Readonly<Record<string, string>>): void => {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    Object.assign(process.env, values);
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
};

test("{§functionality-model-projection} MCP replacement precedes a tool invocation in the same raw model program", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, { fixture: environmentEntry({ ENV_WITNESS: "original" }) });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeRawMockResponse([
            PlurnkParser.frame("plurnk_mcp (replace)", JSON.stringify({ alias: "fixture", ...environmentEntry({ ENV_WITNESS: "replacement" }) })),
            PlurnkParser.frame("fixture (environment)", "{}"),
            PlurnkParser.frame("NOTE", "Observe the new server's reply."),
        ].join("\n\n")),
        makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-ordered" });
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Replace the server and query its environment.", maxTurns: 2 });
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
    const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "plurnk_mcp")?.status_rx, 201, "replacement creates the workspace override before invoking its tool");
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "fixture")?.status_rx, 200);
    const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body" });
    assert.equal(output.witness, "replacement", "the tool runs on the new attachment, not the old server");
    assert.equal(await lifecycle.status(loop.loopId), 200);
});

test("{§mcp-module} a configured stdio server starts with the operator's environment beneath the workspace layer, never a session's, and picks up changes only on restart", { timeout: 30000 }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-env-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    withOperatorEnvironment(t, {
        // Outside the model's command ceiling ({§execution-output-identity}), which is not an MCP server's base.
        REF_VALUE: "operator",
        // {§execution-output-identity} A declared provider credential is excluded from ambient inheritance.
        BOUND_VALUE: "operator-credential",
        PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
    });
    const marker = (server: string) => join(scratch, `${server}.jsonl`);
    const explicitEnv = { MCP_ENV_MARKER: marker("explicit"), ENV_WITNESS: "explicit" };
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        fixture: environmentEntry({ MCP_ENV_MARKER: marker("fixture") }),
        explicit: environmentEntry(explicitEnv),
    });
    const db = await openMigrated();
    const boot = () => {
        const instance = new Daemon({ db, provider: null, schemes: new SchemeRegistry(), hostPaths });
        instance.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
        return instance;
    };
    let daemon = boot();
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-env-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, sessionId);
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        const set = (alias: string, value: string) => invoke("env", "add", { alias, value });
        const starts = async (server: string): Promise<Start[]> => (await readFile(marker(server), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
        // The first action that needs the workspace activates it, launching its enabled servers.
        await set("ENV_WITNESS", "workspace");
        const launched = (await starts("fixture")).at(-1);
        assert.equal(launched?.reference, "operator", "an operator variable outside the model's command ceiling reaches the server");
        assert.equal(launched?.bound, null, "a provider credential is not inherited implicitly");
        assert.equal(launched?.plurnk, null, "nor does any of plurnk's own settings");
        assert.equal(launched?.home, hostPaths.home);
        assert.equal(launched?.witness, null, "the server launched before the workspace defined its value");
        await daemon.invokeModuleAction("session.env.add", { alias: "ENV_WITNESS", value: "private" }, { scope: "session", workspaceId, sessionId });
        await daemon.invokeModuleAction("session.env.add", { alias: "SESSION_ONLY", value: "private" }, { scope: "session", workspaceId, sessionId });
        const before = await starts("fixture");
        await invoke("mcp", "list");
        assert.deepEqual(await starts("fixture"), before, "env edits and listing do not restart a live MCP");
        await invoke("mcp", "disable", { alias: "fixture" });
        await invoke("mcp", "enable", { alias: "fixture" });
        assert.equal((await starts("fixture")).at(-1)?.witness, "workspace", "the workspace layer applies on top of the operator's environment");
        assert.equal((await starts("fixture")).at(-1)?.private, null);
        assert.notEqual((await starts("fixture")).at(-1)?.pid, before.at(-1)?.pid);

        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        const run = async (runtime: string, heading: string, body: object, approve: boolean, status: number, channel = "results") => {
            const source = PlurnkParser.frame(heading, JSON.stringify(body));
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            const op = parsed.items[0];
            assert.equal(op?.kind, "statement");
            if (op?.kind !== "statement") throw new Error("Expected one operation");
            const after = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: runtime, prefix: "/%" })).length;
            const seen = proposals.length;
            // The session's own verb, reviewed by its owner.
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: op.statement });
            if (approve) {
                await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10000 });
                await daemon.resolveProposal(proposals[seen], { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            }
            assert.equal((await pending).status, status);
            return awaitExecOutcome(db, { workspaceId, scheme: runtime, after, channel, timeoutMs: 10000 });
        };
        try {
            const changed = await run("plurnk_env", "plurnk_env (add)", { scope: "workspace", alias: "REF_VALUE", value: "workspace-reference" }, true, 201);
            assert.equal((changed.definition as { origin: string }).origin, "workspace", "the accepted model verb uses the same workspace layer as client actions");
            await invoke("mcp", "disable", { alias: "explicit" });
            await invoke("mcp", "enable", { alias: "explicit" });
            const received = await run("explicit", "explicit (environment)", {}, true, 200, "body");
            assert.equal(received.witness, "explicit", "the entry's env applies over the workspace layer");
            assert.equal(received.reference, "workspace-reference", "a workspace value replaces the operator's");
            assert.equal(received.private, null, "the invoking session never becomes the shared MCP's environment");

            const listed = await invoke("mcp", "list") as FunctionalityListResult;
            const retained = listed.definitions.find(({ alias }) => alias === "explicit");
            assert.ok(retained);
            assert.deepEqual((retained.definition as { env: object }).env, explicitEnv, "the definition stays symbolic; no resolved or ambient value is copied into it");
        } finally { unsubscribe(); }

        await invoke("env", "disable", { alias: "HOME" });
        const beforeCold = { fixture: (await starts("fixture")).length, explicit: (await starts("explicit")).length };
        await daemon.stop();
        daemon = boot();
        await daemon.start();
        const coldList = await invoke("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(coldList.definitions.map(({ alias, state }) => [alias, state]), [["explicit", "dormant"], ["fixture", "dormant"]]);
        assert.deepEqual({ fixture: (await starts("fixture")).length, explicit: (await starts("explicit")).length }, beforeCold, "cold inspection starts no servers");
        await invoke("mcp", "enable", { alias: "fixture" });
        const rehydrated = [...(await starts("fixture")).slice(beforeCold.fixture), ...(await starts("explicit")).slice(beforeCold.explicit)];
        const activeList = await invoke("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(activeList.definitions.map(({ alias, state }) => [alias, state]), [["explicit", "active"], ["fixture", "active"]]);
        assert.deepEqual(new Set(rehydrated.map(({ witness }) => witness)), new Set(["workspace", "explicit"]), "cold activation reconstructs the workspace layer beneath each entry's env");
        for (const received of rehydrated) {
            assert.equal(received.reference, "workspace-reference");
            assert.equal(received.private, null);
            assert.equal(received.bound, null);
            assert.equal(received.home, null, "a workspace withholding removes an operator name, and the SDK's default environment cannot reintroduce it");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mcp-module} native definitions bind credentials explicitly, retain references, and refuse missing references before launch", { timeout: 30000 }, async (t) => {
    const credentials = {
        BOUND_VALUE: "synthetic-custom-provider-credential",
        OPENAI_API_KEY: "synthetic-catalog-provider-credential",
        PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
    };
    withOperatorEnvironment(t, credentials);
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-bindings-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const cases: { alias: string; env: Record<string, string>; bound: string | null; catalog: string | null }[] = [
        { alias: "ambient", env: {}, bound: null, catalog: null },
        { alias: "referenced", env: { BOUND_VALUE: "${BOUND_VALUE}", OPENAI_API_KEY: "${OPENAI_API_KEY}" }, bound: credentials.BOUND_VALUE, catalog: credentials.OPENAI_API_KEY },
        { alias: "literal", env: { BOUND_VALUE: "explicit-custom", OPENAI_API_KEY: "explicit-catalog" }, bound: "explicit-custom", catalog: "explicit-catalog" },
    ];
    const marker = (alias: string) => join(scratch, `${alias}.jsonl`);
    const definitions = Object.fromEntries(cases.map(({ alias, env }) => [alias, environmentEntry({ ...env, MCP_ENV_MARKER: marker(alias) })]));
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, definitions);
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...credentials } }), "@plurnk/plurnk-mcp");
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-bindings-${crypto.randomUUID()}`);
        const invoke = (verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
        await invoke("enable", { alias: "ambient" });
        const list = await invoke("list") as FunctionalityListResult;
        for (const { alias, env, bound, catalog } of cases) {
            const starts = (await readFile(marker(alias), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
            assert.ok(starts.length > 0, `${alias} launched a server`);
            for (const started of starts) {
                assert.deepEqual({ bound: started.bound, catalog: started.catalog, plurnk: started.plurnk }, { bound, catalog, plurnk: null }, alias);
            }
            const retained = list.definitions.find((item) => item.alias === alias);
            assert.ok(retained);
            assert.equal(retained.state, "active");
            assert.deepEqual((retained.definition as { env: object }).env, { ...env, MCP_ENV_MARKER: marker(alias) });
        }
        for (const credential of [credentials.BOUND_VALUE, credentials.OPENAI_API_KEY]) {
            assert.equal(JSON.stringify(list).includes(credential), false, "resolution never copies a host credential into its definition");
        }

        await assert.rejects(invoke("add", { alias: "missing", ...environmentEntry({
            MCP_ENV_MARKER: marker("missing"), BOUND_VALUE: "${ABSENT_CREDENTIAL}",
        }) }), (cause: unknown) => {
            assert.ok(cause instanceof Error && "problem" in cause);
            const problem = Validator.assertProblemDetails(cause.problem);
            assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
            assert.equal(problem.status, 502);
            assert.ok(cause.cause instanceof Error);
            assert.match(cause.cause.message, /missing environment variable ABSENT_CREDENTIAL/u);
            return true;
        });
        await assert.rejects(readFile(marker("missing")), { code: "ENOENT" });
        assert.deepEqual((await invoke("list") as FunctionalityListResult).definitions, list.definitions, "failed preparation preserves the published definitions");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const { policy, decision } of [
    { policy: "review", decision: "accept" },
    { policy: "review", decision: "reject" },
    { policy: "accept", decision: "accept" },
    { policy: "reject", decision: "reject" },
] as const) {
    test(`{§mcp-module} a model-added credential binding follows ordinary ${policy}/${decision} approval`, { timeout: 30000 }, async (t) => {
        serverProposals(t, policy);
        const credential = "synthetic-approved-provider-credential";
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, {});
        const marker = join(hostPaths.home, "launched.jsonl");
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider: null, hostPaths });
        daemon.registerModule(McpModule.init({ env: {
            ...mcpEnv, BOUND_VALUE: credential,
            PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
        } }), "@plurnk/plurnk-mcp");
        await daemon.start();
        try {
            const workspaceId = await insertWorkspace(db, `mcp-approval-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, "alice", "model");
            await ownSession(db, workspaceId, sessionId);
            const list = () => daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as Promise<FunctionalityListResult>;
            const definition = environmentEntry({ MCP_ENV_MARKER: marker, BOUND_VALUE: "${BOUND_VALUE}" });
            const source = PlurnkParser.frame("plurnk_mcp (add)", JSON.stringify({ alias: "credential", ...definition }));
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            const op = parsed.items[0];
            assert.ok(op?.kind === "statement");
            const proposals: number[] = [];
            const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
                if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
            });
            t.after(unsubscribe);
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: op.statement });
            if (policy === "review") {
                await waitFor(() => proposals, (items) => items.length === 1, { timeoutMs: 10000 });
                assert.deepEqual((await list()).definitions, [], "awaiting approval publishes no definition");
                await assert.rejects(readFile(marker), { code: "ENOENT" }, "awaiting approval launches no process");
                await daemon.resolveProposal(proposals[0], { decision }, { workspaceId, address: TEST_OWNER });
            }
            const result = await pending;
            if (decision === "reject") {
                assert.equal(result.status, 400);
                const problem = Validator.assertProblemDetails(result.problem);
                assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/rejected");
                assert.deepEqual((await list()).definitions, []);
                await assert.rejects(readFile(marker), { code: "ENOENT" }, "a rejected launch never starts the server");
                return;
            }
            assert.equal(result.status, 201);
            const added = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk_mcp", timeoutMs: 10000 });
            assert.equal((added.definition as { state: string }).state, "active");
            const starts = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
            assert.ok(starts.length > 0);
            assert.ok(starts.every(({ bound }) => bound === credential), "the approved server receives the named credential");
            const retained = await list();
            assert.deepEqual(retained.definitions[0]?.definition, definition);
            assert.equal(JSON.stringify(retained).includes(credential), false, "only the symbolic binding is saved");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
}

test("{§mcp-module} {§mcp-configuration} a bearer setting resolves against the operator environment beneath the workspace layer and never enters the definition", async (t) => {
    const received: Array<string | null> = [];
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "authorized", version: "1.0.0" });
        server.registerTool("ready", { inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }) }, async () => ({ content: [{ type: "text", text: "ready" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), (request) => {
        const authorization = request.headers.get("authorization");
        received.push(authorization);
        return authorization === "Bearer workspace-token" ? null : new Response("incorrect fixture authorization", { status: 401 });
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { authorized: {
        ...httpEntry(served.url), authorization: { type: "bearer", token: "${ENV_AUTH}" },
    } });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS, ENV_AUTH: "operator-token" } }), "@plurnk/plurnk-mcp");
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `http-env-${crypto.randomUUID()}`);
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        // Activation connects before the workspace defines ENV_AUTH, so the fixture refuses that attempt.
        await invoke("env", "add", { alias: "ENV_AUTH", value: "workspace-token" });
        assert.deepEqual([...new Set(received)], ["Bearer operator-token"], "the reference resolves against the operator environment");
        const activated = received.length;
        const enabled = await invoke("mcp", "enable", { alias: "authorized" }) as { definition: { state: string } };
        assert.equal(enabled.definition.state, "active", "enabling the unavailable alias reconnects it");
        assert.deepEqual([...new Set(received.slice(activated))], ["Bearer workspace-token"], "the workspace layer applies on top of the operator environment");
        const list = await invoke("mcp", "list") as FunctionalityListResult;
        assert.doesNotMatch(JSON.stringify(list.definitions), /-token/u, "the definition holds no captured credential");
        await invoke("mcp", "disable", { alias: "authorized" });
        await invoke("env", "disable", { alias: "ENV_AUTH" });
        const before = received.length;
        await assert.rejects(invoke("mcp", "enable", { alias: "authorized" }), (error: unknown) => {
            assert.ok(error instanceof Error && "problem" in error);
            const problem = Validator.assertProblemDetails(error.problem);
            assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
            assert.equal(problem.status, 502);
            assert.ok(error.cause instanceof Error);
            assert.match(error.cause.message, /missing environment variable ENV_AUTH/u);
            return true;
        });
        assert.equal(received.length, before, "a workspace mask cannot fall back to the operator's reference value");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("mcp-resource-owners", () => {
let prevWarmMs: string | undefined;
let prevFilesItems: string | undefined;
beforeAll(() => {
    prevWarmMs = process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    prevFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "0";
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
});
afterAll(() => {
    if (prevWarmMs === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS;
    else process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = prevWarmMs;
    if (prevFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
    else process.env.PLURNK_SERVICE_FILES_ITEMS = prevFilesItems;
});
const uri = "fixture://resource/item";
const guardedUri = "fixture://resource/guarded";
const multipartUri = "fixture://resource/multipart";
const path = resourcePath(uri);
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");

const statement = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    assert.equal(parsed.unparsedTail, undefined);
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    if (item?.kind !== "statement") throw new Error("Expected one operation");
    return item.statement;
};

const fixture = async (t: TestContext, responses: string[] = []) => {
    const reads: string[] = [];
    const paused = new Map<string, { entered: () => void; released: Promise<void> }>();
    const servers = await Promise.all(["alice", "bob"].map(async (name) => {
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name, version: "1.0.0" });
            server.registerTool("snapshot", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => ({ content: [{ type: "resource", resource: {
                uri: "fixture://data/snapshot.txt", mimeType: "text/plain", text: `${name}'s saved result`,
            } }] }));
            server.registerResource("item", uri, { mimeType: "text/plain" }, async () => {
                reads.push(name);
                const pause = paused.get(name);
                pause?.entered();
                await pause?.released;
                return { contents: [{ uri, mimeType: "text/plain", text: `${name}'s resource` }] };
            });
            server.registerResource("multipart", multipartUri, { mimeType: "text/plain" }, async () => ({ contents: [
                { uri: "fixture://part/first.txt", mimeType: "text/plain", text: `${name}:first` },
                { uri: "fixture://part/last.txt", mimeType: "text/plain", text: `${name}:last` },
            ] }));
            server.registerResource("guarded", guardedUri, { mimeType: "text/plain" }, async (_uri, ctx) => {
                const answer = inputResponse(ctx.mcpReq.inputResponses, "read");
                if (answer.kind === "missing") return inputRequired({ inputRequests: {
                    read: inputRequired.elicit({
                        message: `Read ${name}'s resource?`,
                        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false },
                    }),
                } });
                return { contents: [{ uri: guardedUri, mimeType: "text/plain", text: `${name}:${answer.kind === "elicit" ? answer.action : answer.kind}` }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        return { name, ...served };
    }));
    // {§mcp-configuration}
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, Object.fromEntries(servers.map(({ name, url }) => [name === "alice" ? "shared" : "other", httpEntry(url)])));
    const environment: Record<string, string> = { ...mcpEnv, PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000" };
    const db = await openMigrated();
    let schemes = new SchemeRegistry();
    const provider = new Mock({ contextWindow: 1_000_000, responses: responses.map(makeMockResponse) });
    const createDaemon = () => {
        const instance = new Daemon({ db, schemes, provider, nodeModulesPath: resolvePath("node_modules"), hostPaths });
        instance.registerModule(McpModule.init({ env: environment }), "@plurnk/plurnk-mcp");
        return instance;
    };
    let daemon = createDaemon();
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-owners" });
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    await ownSession(db, workspaceId, alice);
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    const action = (operation: string, params: Record<string, unknown>) => daemon.invokeModuleAction(
        `workspace.mcp.${operation}`, params, { scope: "workspace", workspaceId },
    );
    const cool = () => waitForDb(async () => !schemes.has("shared", workspaceId) && !schemes.has("other", workspaceId), Boolean);
    await cool();
    // {§functionality-inspection}
    const reinstall = async (entries: Readonly<Record<string, object>>) => {
        for (const key of Object.keys(environment)) {
            if (/^PLURNK_MCP_[a-z]/u.test(key)) delete environment[key];
        }
        Object.assign(environment, mcpEnvironment(entries));
        await cool();
    };
    // A person's READ ({§connection-lifecycle}): no reader attaches the addressed runtime itself.
    const read = async (target: string) => (await daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, statements: [statement(PlurnkParser.frame(`READ (${target}) <1,-1>`, null))],
    }))[0];
    const setPolicy = (policy: CapabilityPolicy) => waitForDb(async () => {
        try {
            await daemon.setWorkspaceCapabilities({ workspaceId, policy });
            return true;
        } catch (error) {
            // Zero-grace cooling shares the mutation gate; only its documented busy refusal is retryable.
            if (!(error instanceof OperationFailureError)
                || error.result.problem.type !== "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy") throw error;
            assert.equal(error.result.status, 409);
            assert.equal(error.result.problem.retryable, true);
            return false;
        }
    }, Boolean);
    const restart = async () => {
        await daemon.stop();
        schemes = new SchemeRegistry();
        daemon = createDaemon();
        await daemon.start();
    };
    return { db, get daemon() { return daemon; }, provider, get schemes() { return schemes; }, servers, restart, workspaceId, alice, bob, read, reads, paused, action, cool, reinstall, setPolicy };
};

test("{§execution-output-identity}: shared cold MCP resources, catalog links, caller policy, and concurrent connection leases", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    assert.equal(f.provider.received.length, 0, "attaching and cooling never invokes a model");
    const foreign = await f.read(`shared://${path}`);
    assert.equal(foreign.content, "alice's resource", JSON.stringify(foreign));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const ownCatalog = await f.read("shared:///resources");
    assert.equal(ownCatalog.status, 200, JSON.stringify(ownCatalog));
    const ownResource = (JSON.parse(String(ownCatalog.content)) as { resources: Array<{ uri: string; address: string }> }).resources.find((resource) => resource.uri === uri)!;
    const followed = await f.read(ownResource.address);
    assert.equal(followed.content, "alice's resource", JSON.stringify({ address: ownResource.address, ...followed }));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource", "a reader need not attach the addressed runtime itself");
    assert.equal((await f.read(`shared://missing${path}`)).status, 404);
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const catalog = await f.read("shared:///resources");
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    const listed = JSON.parse(String(catalog.content)) as { resources: Array<{ uri: string; address: string }> };
    const linked = listed.resources.find((resource) => resource.uri === uri);
    assert.equal(linked?.address, `shared://${path}`);
    assert.equal((await f.read(linked.address)).content, "alice's resource");
    const multi = await f.read(`shared://${resourcePath(multipartUri)}`);
    const parts = [...String(multi.content).matchAll(/<(shared:\/\/\/[^>]+)>/gu)].map((match) => match[1]);
    assert.equal(parts.length, 2, JSON.stringify(multi));
    assert.equal((await f.read(parts[0])).content, "alice:first");

    await f.setPolicy({ deny: [{ access: "observe", scheme: "shared" }] });
    const before = f.reads.length;
    const denied = await f.read(`shared://${path}`);
    assert.equal(denied.status, 403, JSON.stringify(denied));
    assert.match(JSON.stringify(denied.problem), /capability-denied/);
    assert.equal(f.reads.length, before, "denied observation never calls resources/read");
    await f.setPolicy({});
    await f.cool();

    const aliceEntered = Promise.withResolvers<void>();
    const bobEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.paused.set("alice", { entered: aliceEntered.resolve, released: release.promise });
    f.paused.set("bob", { entered: bobEntered.resolve, released: release.promise });
    const pending = Promise.all([
        f.read(`shared://${path}`),
        f.read(`other://${path}`),
    ]);
    try {
        await Promise.all([aliceEntered.promise, bobEntered.promise]);
        assert.equal(f.schemes.has("shared", f.workspaceId), true);
        assert.equal(f.schemes.has("other", f.workspaceId), true);
        await assert.rejects(() => f.action("disable", { alias: "other" }), (error) => {
            assert.ok(error instanceof OperationFailureError);
            const { problem } = error.result;
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
            assert.equal(problem.workspaceId, f.workspaceId);
            return true;
        });
    } finally { release.resolve(); }
    const [aliceResult, bobResult] = await pending;
    assert.equal(aliceResult.content, "alice's resource");
    assert.equal(bobResult.content, "bob's resource");
    await f.cool();
    assert.equal(f.provider.received.length, 0, "cold and concurrent resource access never runs any model");
});

for (const transition of ["enabled", "disabled", "removed", "producer-removed", "replaced", "restarted"] as const) {
    test(`{§mcp-result-content}: a client can follow its saved result link with the attachment ${transition}`, { timeout: 20_000 }, async (t) => {
        const f = await fixture(t);
        const [invoked] = await f.daemon.dispatchClientAction({
            workspaceId: f.workspaceId, actor: TEST_OWNER, statements: [statement(PlurnkParser.frame("shared (snapshot)", "{}"))],
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        // The person's operation produced the result in the workspace's runtime session ({§connection-lifecycle}).
        const producer = await f.daemon.ensureRuntimeSession(f.workspaceId);
        const published = await waitForDb(async () => {
            const entries = await f.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({
                workspace_id: f.workspaceId, scheme: "shared", prefix: "%",
            });
            const output = entries.find(({ pathname }) => /^\/[a-f0-9]{8}$/u.test(pathname));
            return output === undefined ? undefined : f.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                pathname: output.pathname, scheme: "shared", name: "body",
            });
        }, (channel) => channel?.content.includes("/resources/snapshot.txt") === true);
        const address = /<(shared:\/\/[^>]+)>/u.exec(published!.content)?.[1];
        assert.ok(address, published!.content);
        const settled = await waitForDb(() => f.db.test_latest_subscription_for_session.get<{ close_status: number | null }>({
            session_id: producer,
        }), (subscription) => subscription?.close_status !== null && subscription?.close_status !== undefined);
        assert.equal(settled?.close_status, 200, "the saved result's producer settles successfully before lifecycle changes");
        if (transition === "disabled") {
            const changed = await f.action("disable", { alias: "shared" }) as { status: number };
            assert.equal(changed.status, 200, JSON.stringify(changed));
        }
        if (transition === "removed") {
            await f.reinstall({ other: httpEntry(f.servers[1].url) });
            const listed = await f.action("list", {}) as FunctionalityListResult;
            assert.deepEqual(listed.definitions.map(({ alias }) => alias), ["other"], "the baseline no longer declares shared");
        }
        if (transition === "replaced") {
            await f.reinstall({ shared: httpEntry(f.servers[1].url), other: httpEntry(f.servers[1].url) });
            assert.equal((await f.read(`shared://${path}`)).content, "bob's resource");
        }
        if (transition === "restarted") {
            assert.equal((await f.action("disable", { alias: "shared" }) as { status: number }).status, 200);
            await f.restart();
        }
        assert.match(address, /^shared:\/\/\/[a-f0-9]{8}\/resources\//u);
        if (transition === "producer-removed") await f.db.test_delete_session.run({ id: producer });
        const result = await f.read(address);
        assert.equal(result.status, 200, JSON.stringify({ address, transition, result }));
        assert.equal(result.content, "alice's saved result");
        const directory = address.slice(0, address.lastIndexOf("/") + 1);
        const [catalog] = await f.daemon.dispatchClientAction({
            workspaceId: f.workspaceId, actor: TEST_OWNER,
            statements: [statement(PlurnkParser.frame(`FIND (${directory})`, null))],
        });
        assert.equal(catalog.status, 200, JSON.stringify(catalog));
        assert.match(JSON.stringify(catalog), /snapshot\.txt/);
        assert.equal(f.provider.received.length, 0, "reading an artifact requires no model inference");
    });
}

test("{§execution-output-identity}: MCP resource elicitation and its receipt belong to the requesting model operation", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${step("NOTE")}`,
        PlurnkParser.frame("SEND [200]", "The resource was read."),
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, sessionId: f.alice, prompt: "Read Bob's guarded resource." });
    const waiting = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    const interaction = waiting[0];
    assert.equal(interaction.sessionId, f.alice);
    assert.equal(interaction.loopId, run.loopId);
    assert.match(JSON.stringify(interaction), /Read bob's resource/);
    await f.daemon.resolveClientInteraction(interaction.interactionId, {
        action: "accept", content: { confirm: true },
    }, { workspaceId: f.workspaceId, address: TEST_OWNER });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200);
    assert.equal(f.provider.received.length, 2, "the owner model never starts");
    assert.match(f.provider.received[1].map(chatMessageText).join("\n"), /bob:accept/);
    const receipts = await f.db.test_log_entries_by_loop.all<{ op: string; status_rx: number; target: string }>({ loop_id: run.loopId });
    assert.ok(receipts.some((row) => row.op === "READ" && row.status_rx === 200), "the READ receipt stays in Alice's loop");
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
});

test("{§execution-output-identity}: cancelling the requester settles its MCP interaction and releases the shared connection", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${step("NOTE")}`,
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, sessionId: f.alice, prompt: "Read Bob's guarded resource." });
    const pending = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    assert.equal(pending[0].sessionId, f.alice);
    await f.daemon.cancelSession({ workspaceId: f.workspaceId, sessionId: f.alice, reason: "resource reader cancelled" });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 499);
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
    await f.cool();
    assert.equal(f.provider.received.length, 1, "neither the cancelled reader nor the resource owner's model continues");
    assert.equal((await f.read(`other://${path}`)).content, "bob's resource", "cancellation leaves the workspace attachment usable");
    await f.cool();
    assert.equal(f.provider.received.length, 1);
});
});

describe("module-runtime", () => {
// Module-owned runtimes register through one protocol-neutral seam. The engine
// adds the executor tag and its output scheme atomically while a resource facet
// may claim a distinct subtree under that same scheme.



















// Registration supplies output declarations without starting the runtime.
const fakeEntry = (tag: string, namespaceOwner = `test module '${tag}'`, channel = "results"): RegistryEntry => ({
    executor: {
        runtime: tag, glyph: "🔌",
        get manifest() {
            return {
                name: tag,
                channels: { [channel]: "application/json" },
                defaultChannel: channel,
                category: "data",
                writableBy: [],
                volatile: true,
                modelVisible: true,
            } as never;
        },
        get defaultChannel() { return channel; },
        get channels() { return { [channel]: { mimetype: "application/json" } }; },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true, detail: "fake" }),
        effect: () => "read",
    } as unknown as Executor,
    namespaceOwner: { kind: "module", name: namespaceOwner },
    glyph: "🔌",
    summary: `${tag} fixture.`,
    invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
    details: "",
    available: true,
    detail: "fake",
});

const wire = (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const schemes = new SchemeRegistry();
    const executors = new ExecutorRegistry(new Map());
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    return { schemes, executors, engine };
};

const readStatement = (pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
    target: {
        kind: "url",
        raw: `myserver://${pathname}`,
        scheme: "myserver",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    lineMarker: null,
    matcher: null, body: null,
    position: {
        line: 1,
        column: 1,
    },
});

test("{§core-extension-composition} module runtime registration adds one dispatchable and model-visible tag", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));
        assert.ok(executors.entry("myserver"), "the server is registered for executor dispatch");
        assert.ok(executors.availableRuntimes().includes("myserver"), "available for the workspace's tool-resource projection");
        assert.ok(schemes.has("myserver"), "scheme face registered - READ/FIND/KILL for the tag");
    } finally { await db.close(); }
});

test("{§core-extension-composition} module runtime registration preserves one-name-one-owner atomicity", async () => {
    const db = await openMigrated();
    try {
        const { schemes, executors, engine } = wire(db);
        engine.registerRuntime("myserver", fakeEntry("myserver"));

        // Re-registering a live tag is a caller error, not a silent overwrite.
        assert.throws(() => engine.registerRuntime("myserver", fakeEntry("myserver")), /already/i, "dup tag rejected");

        // A reserved built-in scheme name (file/exec/session/…) is rejected by the scheme-first arbitration
        // gate - and because the face is registered BEFORE the executor, the executor registry is never
        // touched on a rejected tag (no half-write).
        assert.throws(() => engine.registerRuntime("session", fakeEntry("session")), /reserved/i, "reserved name rejected");
        assert.equal(executors.entry("session"), undefined, "reserved collision left the executor registry untouched");
        assert.equal(schemes.get("session")?.constructor.name, "Session", "the reserved 'session' scheme is unchanged, not shadowed");

        assert.throws(
            () => engine.registerRuntime("Alias_Tool", fakeEntry("Alias_Tool")),
            /runtime declaration invalid: module runtime name 'Alias_Tool' must match \[a-z\]\[a-z0-9\+._-\]\*/,
            "module-owned declarations use the same canonical tag admission as installed declarations",
        );
        assert.equal(executors.entry("Alias_Tool"), undefined, "invalid admission leaves the executor registry untouched");
        assert.equal(schemes.has("Alias_Tool"), false, "invalid admission leaves the scheme registry untouched");

        assert.throws(
            () => engine.registerRuntime("only", fakeEntry("only")),
            /runtime declaration invalid: module runtime name 'only' is reserved by PLURNK_EXECS_ONLY/,
            "dynamic registration cannot collide with the policy allowlist key",
        );
        assert.equal(executors.entry("only"), undefined);
        assert.equal(schemes.has("only"), false);
    } finally { await db.close(); }
});

test("{§core-extension-composition} module runtime registration preflights both registries before mutating either", async () => {
    const db = await openMigrated();
    try {
        const existing = fakeEntry("occupied", "existing module");
        const schemes = new SchemeRegistry();
        const executors = new ExecutorRegistry(new Map([["occupied", existing]]));
        const engine = new Engine({ db, schemes });
        engine.setExecutors(executors);

        assert.throws(
            () => engine.registerRuntime("occupied", fakeEntry("occupied", "incoming module")),
            /daemon module runtime 'existing module'.*daemon module runtime 'incoming module'/,
        );
        assert.equal(schemes.has("occupied"), false, "an executor collision cannot leave a scheme half-written");
        assert.equal(executors.entry("occupied"), existing, "the existing executor remains unchanged");
    } finally { await db.close(); }
});

test("{§execution-output-identity} a runtime resource facet claims only its subtree and preserves output-stream reads", async () => {
    const db = await openMigrated();
    try {
        const { schemes, engine } = wire(db);
        let calls = 0;
        engine.registerRuntime("myserver", fakeEntry("myserver"), {
            claims: (pathname) => pathname.startsWith("/resources/"),
            prepareRepresentation: async (request, ctx) => {
                calls++;
                assert.equal(request.pathname, "/resources/item");
                const written = await ctx.entries.write(request.pathname, {
                    channels: {
                        results: {
                            content: "remote resource",
                            mimetype: "text/plain",
                        },
                    },
                });
                assert.ok(written.status === 200 || written.status === 201);
                return { status: 200 };
            },
        });
        assert.ok(schemes.get("myserver"));
        const workspaceId = await insertWorkspace(db, `module-runtime-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const read = (statement: ReadStatement) => clientRead(engine, db, {
            statement,
            workspaceId,
            sessionId,
        }).then(Results.assertReadResult);

        const remote = await read(readStatement("/resources/item"));
        assert.equal(remote.content, "remote resource");
        assert.equal(calls, 1);

        const output = await read(readStatement("/1/1/1"));
        assert.equal(output.status, 404, "an unclaimed output coordinate uses the standard stream reader");
        assert.equal(calls, 1, "the resource facet never intercepts output coordinates");
    } finally {
        await db.close();
    }
});

test("{§execution-output-identity}: a facet that states its representation owns address, default channel, SEND and the log record on its subtree", async () => {
    const db = await openMigrated();
    try {
        const { engine } = wire(db);
        const sent: string[] = [];
        engine.registerRuntime("peers", fakeEntry("peers"), {
            claims: (pathname) => /^\/[a-z]/u.test(pathname),
            manifest: { authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body" },
            prepareRepresentation: async (request, ctx) => {
                assert.deepEqual([request.authority, request.pathname], ["ada", "/card"], "the facet's authority names the resource");
                const written = await ctx.entries.write(request.pathname, { channels: { body: { content: "ada's card", mimetype: "text/plain" } } });
                assert.ok(written.status === 200 || written.status === 201);
                return { status: 200 };
            },
            send: async (statement) => {
                sent.push(statement.body?.raw ?? "");
                return { status: 200 };
            },
        });
        const workspaceId = await insertWorkspace(db, `facet-representation-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const parse = (body: string) => {
            const parsed = PlurnkParser.parseStatements(body, { executors: fixtureExecutors(body) });
            const item = parsed.items[0];
            if (parsed.items.length !== 1 || item?.kind !== "statement") throw new Error("Expected one operation");
            return item.statement;
        };

        const card = await clientRead(engine, db, { workspaceId, sessionId, statement: parse("````READ (peers://ada/card) <1,-1>````") });
        assert.equal(card.content, "ada's card", "a fragmentless READ selects the facet's default channel, not the executor's");

        let sequence = 0;
        const dispatch = (body: string) => engine.dispatch({ workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model", statement: parse(body) });
        assert.equal((await dispatch("````SEND (peers://ada)\nhello\n````")).status, 200);
        assert.deepEqual(sent, ["hello"], "a claimed SEND is the facet's");
        const stored = await dispatch("````SEND (peers:///1/1/1)\nstdin\n````");
        assert.notEqual(stored.status, 200, "an unclaimed SEND is refused on stored execution output");
        assert.deepEqual(sent, ["hello"], "the facet never sees an execution coordinate");

        const rows = (await db.test_log_entries_by_turn.all<{ scheme: string | null; hostname: string | null; pathname: string | null }>({ turn_id: turnId }))
            .map(({ scheme, hostname, pathname }) => ({ scheme, hostname, pathname }));
        assert.deepEqual(rows[0], { scheme: "peers", hostname: "ada", pathname: "" }, "the log keeps the authored address of a claimed resource");
        assert.deepEqual(rows[1], { scheme: "peers", hostname: null, pathname: "/1/1/1" }, "a stored execution keeps namespace authority");
    } finally {
        await db.close();
    }
});

test("{§capability-ctx} {§execution-output-identity}: READ, FIND, COPY, execution, and BARE use the workspace attachment and channel", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "resource-owners");
        const alice = await insertSession(db, workspaceId, null, "alice");
        await insertSession(db, workspaceId, null, "bob");
        await insertSession(db, workspaceId, null, "detached");
        const otherWorkspace = await insertWorkspace(db, "unrelated-resources");
        await insertSession(db, otherWorkspace, null, "outsider");
        const loopId = await insertLoop(db, alice, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const calls: string[] = [];
        for (const [workspace, name] of [[workspaceId, "shared"], [otherWorkspace, "other"]] as const) {
            const channel = name === "shared" ? "results" : "body";
            const facet: RuntimeSchemeFacet = {
                claims: (pathname) => pathname.startsWith("/resources"),
                prepareRepresentation: async (request, ctx) => {
                    calls.push(name);
                    assert.equal(ctx.sessionId, alice, "the caller still owns the operation");
                    const result = await ctx.entries.write(request.pathname, {
                        channels: { [channel]: { content: `${name}'s resource`, mimetype: "text/plain" } },
                    });
                    assert.ok(result.status === 200 || result.status === 201);
                    return { status: 200 };
                },
                find: async (statement, ctx) => ctx.entries.operations.find(statement),
            };
            (await engine.prepareWorkspaceRuntimes(workspace, "fixture", [{ tag: "myserver", entry: fakeEntry("myserver", "fixture", channel), scheme: facet }]))();
        }
        const parse = (body: string) => {
            const parsed = PlurnkParser.parseStatements(body, { executors: fixtureExecutors(body) });
            assert.equal(parsed.unparsedTail, undefined);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return item.statement;
        };
        const read = (uri: string) => clientRead(engine, db, {
            workspaceId, sessionId: alice,
            statement: parse(`\`\`\`\`READ (${uri}) <1,-1>\`\`\`\``),
        });
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource", "repeated reads select the same attachment");
        assert.equal((await read("myserver://absent/resources/item")).status, 404);
        assert.equal((await read("myserver://outsider/resources/item")).status, 404, "resource resolution never crosses workspace identity");
        assert.equal((await read("myserver:///resources/item")).content, "shared's resource", "the caller does not need a personal attachment");
        assert.deepEqual(calls, ["shared", "shared", "shared", "shared"]);
        let sequence = 1;
        const dispatch = (body: string) => engine.dispatch({
            workspaceId, sessionId: alice, loopId, turnId, sequence: sequence++, origin: "model",
            statement: parse(body),
        });
        const found = await dispatch("````FIND (myserver:///resources/*) <1,-1>````");
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.match(JSON.stringify(found.results), /myserver:\/\/\/resources\/item/);
        const copied = await dispatch("````COPY (myserver:///resources/item) (workspace:///copy.txt)````");
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const copy = await read("workspace:///copy.txt");
        assert.equal(copy.content, "shared's resource");

        const received: string[] = [];
        const consumer = fakeEntry("consumer");
        engine.registerRuntime("consumer", {
            ...consumer,
            invocation: { body: { role: "arguments", required: false }, target: { role: "resource", required: true, kind: "resource" }, example: { target: "workspace:///program", body: "input" } },
            executor: {
                ...consumer.executor,
                async run(args) {
                    assert.notEqual(args.target, null);
                    received.push(await readFile(args.target!, "utf8"));
                    assert.equal(args.body, "caller input");
                    return { status: 200 };
                },
            },
        });
        const executed = await dispatch(PlurnkParser.frame("consumer (myserver:///resources/item)", "caller input"));
        assert.equal(executed.status, 200, JSON.stringify(executed));
        await (schemes.get("exec") as Exec).idle();
        assert.deepEqual(received, ["shared's resource"]);

        const child = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "Isolated answer.", reasoning: null } }] });
        const result = await engine.runTurn({
            workspaceId, sessionId: alice, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: [
                PlurnkParser.frame("BARE (myserver:///resources/item)", "Analyze this."),
                PlurnkParser.frame("NOTE", "Inspect the answer."),
            ].join("\n\n"), reasoning: null } }] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(child.received.map((messages) => messages.map(chatMessageText)), [["shared's resource\n\nAnalyze this."]]);
    } finally { await db.close(); }
});

test("{§execution-output-identity}: retained output keeps its actual channel after runtime replacement and removal", async () => {
    const db = await openMigrated();
    try {
        const { engine, schemes } = wire(db);
        const workspaceId = await insertWorkspace(db, "retained-output");
        const sessionId = await insertSession(db, workspaceId);
        const peer = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const declared = fakeEntry("myserver", "fixture", "results");
        const install = async (entries: Parameters<Engine["prepareWorkspaceRuntimes"]>[2]) =>
            (await engine.prepareWorkspaceRuntimes(workspaceId, "fixture", entries))();
        await install([{ tag: "myserver", entry: {
            ...declared,
            executor: {
                ...declared.executor,
                async run({ write }) {
                    write("results", '{"saved":true}', "application/json");
                    return { status: 200 };
                },
            },
        } }]);
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("myserver", "fixture"), { executors: fixtureExecutors(PlurnkParser.frame("myserver", "fixture")) }).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected an operation");
        const invoked = await engine.dispatch({
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model", statement: parsed.statement,
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        await (schemes.get("exec") as Exec).idle();
        const address = await executionAddress(db, turnId);
        const target = readStatement(new URL(address).pathname);
        const read = (reader = engine) => clientRead(reader, db, { workspaceId, sessionId: peer, statement: target });
        await install([{ tag: "myserver", entry: fakeEntry("myserver", "fixture", "body") }]);
        const replaced = await read();
        assert.equal(replaced.status, 200, JSON.stringify(replaced));
        assert.equal(replaced.content, '{"saved":true}');
        assert.equal(replaced.mimetype, "application/json");
        await install([]);
        assert.equal((await read()).content, '{"saved":true}', "removal retains the exact default representation");
        const fresh = wire(db);
        assert.equal(fresh.schemes.has("myserver"), false);
        assert.equal((await read(fresh.engine)).content, '{"saved":true}', "a fresh registry serves saved output without an executable");
    } finally { await db.close(); }
});
});

describe("workspace-env", () => {
test("{§execution-output-identity} workspace defaults, session overrides and masks share the env verbs without copying workspace state", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `env-${crypto.randomUUID()}`);
        const other = await insertWorkspace(db, `other-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        const shared = (verb: string, params: Record<string, unknown> = {}, workspace = workspaceId) =>
            daemon.invokeModuleAction(`workspace.env.${verb}`, params, { scope: "workspace", workspaceId: workspace });
        const local = (sessionId: number, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`session.env.${verb}`, params, { scope: "session", workspaceId, sessionId });
        const get = async (sessionId: number) => ((await local(sessionId, "list")) as FunctionalityListResult).definitions.find(({ alias }) => alias === "ENV_WITNESS");
        await shared("add", { alias: "ENV_WITNESS", value: "workspace" });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        assert.equal((await get(alice))?.origin, "workspace");
        assert.equal(((await shared("list", {}, other)) as FunctionalityListResult).definitions.some(({ alias }) => alias === "ENV_WITNESS"), false);
        await local(alice, "add", { alias: "ENV_WITNESS", value: "alice" });
        assert.deepEqual((await get(alice))?.definition, { value: "alice" });
        assert.deepEqual((await get(bob))?.definition, { value: "workspace" });
        await local(alice, "remove", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "active");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, "workspace", "removal restores inheritance at the command environment boundary");
        assert.equal((await get(bob))?.state, "active");
        await local(alice, "disable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled");
        await local(alice, "enable", { alias: "ENV_WITNESS" });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        await shared("disable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled", "removing a session mask cannot lift a workspace mask");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, undefined);
        await shared("enable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "active");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, "workspace");
        const child = await insertSession(db, workspaceId, bob, "child", "model");
        await shared("remove", { alias: "ENV_WITNESS" });
        await shared("add", { alias: "ENV_WITNESS", value: "updated" });
        assert.deepEqual((await get(child))?.definition, { value: "updated" }, "workspace values stay live through parentage");
        await assert.rejects(shared("add", { alias: "PLURNK_BAD", value: "x" }), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/name-reserved");
            assert.equal(cause.result.problem.detail, "'PLURNK_BAD' is reserved in env entries.");
            assert.equal(cause.result.problem.recovery, "READ mcp:///plurnk_env.md for supported configuration paths.");
            return true;
        });
        await assert.rejects(shared("list", { scope: "session" }), /scope does not match/u);
        await assert.rejects(local(alice, "list", { scope: "workspace" }), /scope does not match/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("workspaces", () => {
test("{§execution-output-identity} workspaces: name UNIQUE — duplicate insert is rejected", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "workspace-a" });
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "workspace-a" }),
            /UNIQUE constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity} workspaces: empty name rejected by CHECK (length > 0)", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} workspaces: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_with_version.run({ name: "workspace-c", version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity} workspaces: NOT NULL enforced on name", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_no_name(),
            /NOT NULL constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});
});

describe("mcp-open-work", () => {
test("{§mcp-open-work} MCP server auto-creates bound workspace and session, routes sampling/createMessage resolved by SEND, and wakes parked loops on notifications/resources/updated", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    let feedText = "feed-v1";
    const outboundMetas: Array<{ method?: string; meta?: Record<string, unknown> }> = [];
    const handler = createMcpHandler(() => {
        const server = new McpServer(
            { name: "telegram-bot", version: "1.0.0" },
            { capabilities: { resources: { subscribe: true } } },
        );
        server.registerResource(
            "feed",
            "fixture://feed",
            {
                mimeType: "text/plain",
                cacheHint: { ttlMs: 60_000, cacheScope: "public" },
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    mimeType: "text/plain",
                    text: feedText,
                }],
            }),
        );
        server.registerTool(
            "ask-inbox",
            {
                description: "Route a question to the operator inbox session via sampling/createMessage.",
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
            },
            async (_args, ctx) => {
                const reply = inputResponse(ctx.mcpReq.inputResponses, "reply");
                if (reply.kind === "missing") {
                    return inputRequired({
                        inputRequests: {
                            reply: inputRequired.createMessage({
                                messages: [{
                                    role: "user",
                                    content: { type: "text", text: "Approve production deploy?" },
                                }],
                                maxTokens: 64,
                                _meta: {
                                    plurnkSession: "inbox",
                                    plurnkMessageId: "tg-42",
                                },
                            }),
                        },
                    });
                }
                return {
                    content: [{
                        type: "text",
                        text: reply.kind === "sampling"
                            && !Array.isArray(reply.result.content)
                            && reply.result.content.type === "text"
                            ? reply.result.content.text
                            : reply.kind,
                    }],
                };
            },
        );
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json() as {
            method?: string;
            params?: { _meta?: Record<string, unknown> };
        };
        if (body.method === "tools/call" || body.method === "resources/read") {
            outboundMetas.push({ method: body.method, meta: body.params?._meta });
        }
        return null;
    });

    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        telegram: {
            ...httpEntry(served.url),
            plurnkWorkspace: "ops",
            plurnkSession: "inbox",
        },
    });

    // Step 2 responses:
    // - responses[0]: caller Turn 1 invokes `telegram (ask-inbox)` and parks in 202
    // - responses[1]: inbox Turn 1 (woken by `telegram:///messages/tg-42`) replies `SEND (telegram:///messages/tg-42) [200]`
    // - responses[2]: caller Turn 2 observes `Approved by inbox!` and completes `SEND [200]`
    // Step 3 responses:
    // - responses[3]: inbox Turn 1 reads subscribable `telegram:///resources/fixture%3A%2F%2Ffeed`
    // - responses[4]: inbox Turn 2 observes `feed-v1` and parks in 202 on the open resource stream
    // - responses[5]: inbox Turn 3 (woken by `notifications/resources/updated`) observes `feed-v2` and completes `SEND [200]`
    const provider = new Mock({
        contextWindow: 1_000_000,
        responses: [
            makeRawMockResponse([
                PlurnkParser.frame("telegram (ask-inbox)", "{}"),
                PlurnkParser.frame("SEND [200]", "Waiting for inbox approval."),
            ].join("\n\n")),
            makeRawMockResponse(
                PlurnkParser.frame("SEND (telegram:///messages/tg-42) [200]", "Approved by inbox!"),
            ),
            makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Caller observed approval.")),
            makeRawMockResponse([
                PlurnkParser.frame("READ (telegram:///resources/fixture%3A%2F%2Ffeed)", null),
                PlurnkParser.frame("SEND [200]", "Subscribed to feed."),
            ].join("\n\n")),
            makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Waiting for feed update.")),
            makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Inbox observed feed-v2.")),
        ],
    });

    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();

    // 1. Resident server startup auto-created workspace "ops" and session "inbox"
    const workspaces = await daemon.listWorkspaces();
    const ops = workspaces.find((ws) => ws.name === "ops");
    assert.ok(ops, "resident server startup auto-created workspace 'ops'");
    const inboxSession = await daemon.readSession({ workspaceId: ops.id, identity: { name: "inbox" } });
    assert.ok(inboxSession, "resident server startup auto-created session 'inbox'");

    // 2. Start a caller loop in session "caller" that invokes `telegram (ask-inbox)`
    const { sessionId: callerId } = await daemon.createSession({ workspaceId: ops.id, name: "caller" });
    const callerLoop = await daemon.runLoop({
        workspaceId: ops.id,
        sessionId: callerId,
        prompt: "Ask inbox for approval.",
        maxTurns: 3,
    });
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(callerLoop.loopId), (status) => status === 200, { timeoutMs: 10_000 });

    const callerLog = await daemon.readLog({ workspaceId: ops.id, sessionId: callerId, loopId: callerLoop.loopId, limit: 100 });
    const callerFoistedRead = callerLog.find((entry) =>
        entry.origin === "_plurnk"
        && entry.op === "READ"
        && entry.scheme === "telegram");
    assert.ok(callerFoistedRead, "caller loop received foisted READ of telegram (ask-inbox) output");
    assert.match(JSON.stringify(callerFoistedRead.rx), /Approved by inbox!/u);

    // 3. Start a loop in session "inbox" that reads subscribable `fixture://feed` and parks in 202
    const inboxStreamLoop = await daemon.runLoop({
        workspaceId: ops.id,
        sessionId: inboxSession.id,
        prompt: "Monitor fixture://feed for updates.",
        maxTurns: 4,
    });
    await waitForDb(() => lifecycle.status(inboxStreamLoop.loopId), (status) => status === 202, { timeoutMs: 10_000 });

    // Outbound calls stamped unforgeable plurnkWorkspace and plurnkSession metadata
    assert.ok(
        outboundMetas.some((item) =>
            item.method === "tools/call"
            && item.meta?.plurnkWorkspace === "ops"
            && item.meta?.plurnkSession === "caller"),
        `expected outbound tools/call meta with ops/caller; got ${JSON.stringify(outboundMetas)}`,
    );
    assert.ok(
        outboundMetas.some((item) =>
            item.method === "resources/read"
            && item.meta?.plurnkWorkspace === "ops"
            && item.meta?.plurnkSession === "inbox"),
        `expected outbound resources/read meta with ops/inbox; got ${JSON.stringify(outboundMetas)}`,
    );

    const streams = await daemon.readStreams({ workspaceId: ops.id, sessionId: inboxSession.id });
    assert.ok(
        streams.some((stream) => stream.target === "telegram:///resources/fixture%3A%2F%2Ffeed"),
        `expected open stream on telegram:///resources/fixture%3A%2F%2Ffeed; got ${JSON.stringify(streams)}`,
    );

    // 4. Push `notifications/resources/updated` for `fixture://feed` -> closes stream (200) and wakes parked loop with foisted `_plurnk` READ
    feedText = "feed-v2";
    handler.notify.resourceUpdated("fixture://feed");
    await waitForDb(() => lifecycle.status(inboxStreamLoop.loopId), (status) => status === 200, { timeoutMs: 10_000 });

    const inboxLog = await daemon.readLog({ workspaceId: ops.id, sessionId: inboxSession.id, loopId: inboxStreamLoop.loopId, limit: 100 });
    const foistedRead = inboxLog.find((entry) =>
        entry.origin === "_plurnk"
        && entry.op === "READ"
        && JSON.stringify(entry.rx).includes("feed-v2"));
    assert.ok(foistedRead, "resource update materialized a foisted _plurnk READ with feed-v2 in the woken turn");
});
});

