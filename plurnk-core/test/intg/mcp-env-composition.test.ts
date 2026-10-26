import { ownSession, serverProposals, TEST_OWNER } from "./_approval.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import { Validator, type FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors, makeRawMockResponse } from "./_mock.ts";
import { insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { waitFor, waitForDb } from "./_rpc.ts";
import { modelOperation } from "./_sessions.ts";
import { MCP_CONTROLS, httpEntry, mcpFixture } from "./_mcp-config.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/environment-mcp.mjs", import.meta.url));
// A stdio definition for the environment fixture, which records each launch's environment in its marker.
const environmentEntry = (env: Readonly<Record<string, string>>): object => ({ type: "stdio", command: "node", args: [fixture], env: { ...env } });
type Start = { witness: string | null; private: string | null; bound: string | null; catalog: string | null; plurnk: string | null; reference: string | null; home: string | null; pid: number };

// {§mcp-launch-environment} — the operator's environment is the daemon process's own, so the test sets it there.
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

test("{§functionality-model-mutation} MCP replacement precedes a tool invocation in the same raw model program", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, { fixture: environmentEntry({ ENV_WITNESS: "original" }) });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeRawMockResponse([
            PlurnkParser.frame("plurnk (mcp)", JSON.stringify({ verb: "replace", alias: "fixture", definition: { name: "fixture", ...environmentEntry({ ENV_WITNESS: "replacement" }) } })),
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
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "plurnk")?.status_rx, 201, "replacement creates the workspace override before invoking its tool");
    assert.equal(rows.find((row) => row.origin === "model" && row.op === "fixture")?.status_rx, 200);
    const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body" });
    assert.equal(output.witness, "replacement", "the tool runs on the new attachment, not the old server");
    assert.equal(await lifecycle.status(loop.loopId), 200);
});

test("{§mcp-launch-environment} a configured stdio server starts with the operator's environment beneath the workspace layer, never a session's, and picks up changes only on restart", { timeout: 30000 }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-env-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    withOperatorEnvironment(t, {
        // Outside the model's command ceiling ({§exec-env-scoped}), which is not an MCP server's base.
        REF_VALUE: "operator",
        // {§exec-env-scoped} A declared provider credential is excluded from ambient inheritance.
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
        const set = (alias: string, value: string) => invoke("env", "add", { alias, definition: { value } });
        const starts = async (server: string): Promise<Start[]> => (await readFile(marker(server), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
        // The first action that needs the workspace activates it, launching its enabled servers.
        await set("ENV_WITNESS", "workspace");
        const launched = (await starts("fixture")).at(-1);
        assert.equal(launched?.reference, "operator", "an operator variable outside the model's command ceiling reaches the server");
        assert.equal(launched?.bound, null, "a provider credential is not inherited implicitly");
        assert.equal(launched?.plurnk, null, "nor does any of plurnk's own settings");
        assert.equal(launched?.home, hostPaths.home);
        assert.equal(launched?.witness, null, "the server launched before the workspace defined its value");
        await daemon.invokeModuleAction("session.env.add", { alias: "ENV_WITNESS", definition: { value: "private" } }, { scope: "session", workspaceId, sessionId });
        await daemon.invokeModuleAction("session.env.add", { alias: "SESSION_ONLY", definition: { value: "private" } }, { scope: "session", workspaceId, sessionId });
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
            const changed = await run("plurnk", "plurnk (env)", { verb: "add", scope: "workspace", alias: "REF_VALUE", definition: { value: "workspace-reference" } }, true, 201);
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

test("{§mcp-launch-environment} native definitions bind credentials explicitly, retain references, and refuse missing references before launch", { timeout: 30000 }, async (t) => {
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

        await assert.rejects(invoke("add", { alias: "missing", definition: { name: "missing", ...environmentEntry({
            MCP_ENV_MARKER: marker("missing"), BOUND_VALUE: "${ABSENT_CREDENTIAL}",
        }) } }), (cause: unknown) => {
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
    test(`{§mcp-launch-environment} a model-added credential binding follows ordinary ${policy}/${decision} approval`, { timeout: 30000 }, async (t) => {
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
            const definition = { name: "credential", ...environmentEntry({ MCP_ENV_MARKER: marker, BOUND_VALUE: "${BOUND_VALUE}" }) };
            const source = PlurnkParser.frame("plurnk (mcp)", JSON.stringify({ verb: "add", alias: "credential", definition }));
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
            const added = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", timeoutMs: 10000 });
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

test("{§mcp-launch-environment} {§mcp-server-settings} a bearer setting resolves against the operator environment beneath the workspace layer and never enters the definition", async (t) => {
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
        await invoke("env", "add", { alias: "ENV_AUTH", definition: { value: "workspace-token" } });
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
