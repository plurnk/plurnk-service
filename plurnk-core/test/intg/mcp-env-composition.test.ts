import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors } from "./_mock.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { waitFor } from "./_rpc.ts";
import { MCP_CONTROLS, httpEntry, mcpPluginHome } from "./_mcp-plugin.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/environment-mcp.mjs", import.meta.url));
// A plugin's stdio entry for the environment fixture, which records each launch's environment in its marker.
const environmentEntry = (env: Readonly<Record<string, string>>): object => ({ type: "stdio", command: "node", args: [fixture], env: { ...env } });
type Start = { witness: string | null; private: string | null; bound: string | null; plurnk: string | null; reference: string | null; home: string | null; pid: number };

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

test("{§mcp-launch-environment} a plugin's stdio server starts with the operator's environment beneath the workspace layer, never a worker's, and picks up changes only on restart", { timeout: 30000 }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-env-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    withOperatorEnvironment(t, {
        // Outside the model's command ceiling ({§exec-env-scoped}), which is not a plugin server's base.
        REF_VALUE: "operator",
        // A credential the operator's provider declaration names: plurnk's own, never a subprocess's.
        BOUND_VALUE: "operator-credential",
        PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV: "BOUND_VALUE",
    });
    const marker = (server: string) => join(scratch, `${server}.jsonl`);
    const explicitEnv = { MCP_ENV_MARKER: marker("explicit"), ENV_WITNESS: "explicit" };
    const hostPaths = await mcpPluginHome(t, {
        fixture: environmentEntry({ MCP_ENV_MARKER: marker("fixture") }),
        explicit: environmentEntry(explicitEnv),
    });
    const db = await openMigrated();
    const boot = () => {
        const instance = new Daemon({ db, provider: null, schemes: new SchemeRegistry(), hostPaths });
        instance.registerModule(McpModule.init({ env: { ...MCP_CONTROLS } }));
        return instance;
    };
    let daemon = boot();
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-env-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice", "client");
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        const set = (alias: string, value: string) => invoke("env", "add", { alias, definition: { value } });
        const starts = async (server: string): Promise<Start[]> => (await readFile(marker(server), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Start);
        // The first action that needs the workspace activates it, launching its enabled servers.
        await set("ENV_WITNESS", "workspace");
        const launched = (await starts("fixture")).at(-1);
        assert.equal(launched?.reference, "operator", "an operator variable outside the model's command ceiling reaches the server");
        assert.equal(launched?.bound, null, "a provider credential never does");
        assert.equal(launched?.plurnk, null, "nor does any of plurnk's own settings");
        assert.equal(launched?.home, process.env.HOME ?? null);
        assert.equal(launched?.witness, null, "the server launched before the workspace defined its value");
        await daemon.invokeModuleAction("worker.env.add", { alias: "ENV_WITNESS", definition: { value: "private" } }, { scope: "worker", workspaceId, workerId });
        await daemon.invokeModuleAction("worker.env.add", { alias: "WORKER_ONLY", definition: { value: "private" } }, { scope: "worker", workspaceId, workerId });
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
        const run = async (runtime: string, heading: string, body: object, approve: boolean, channel = "results") => {
            const source = PlurnkParser.frame(heading, JSON.stringify(body));
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            const op = parsed.items[0];
            assert.equal(op?.kind, "statement");
            if (op?.kind !== "statement") throw new Error("Expected one operation");
            const after = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: runtime, prefix: "/%" })).length;
            const seen = proposals.length;
            const pending = daemon.dispatchAsClient({ workspaceId, workerId, statement: op.statement });
            if (approve) {
                await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10000 });
                daemon.resolveProposal(proposals[seen]!, { decision: "accept" });
            }
            assert.equal((await pending).status, 200);
            return awaitExecOutcome(db, { workspaceId, scheme: runtime, after, channel, timeoutMs: 10000 });
        };
        try {
            const changed = await run("env", "env (add)", { scope: "workspace", alias: "REF_VALUE", definition: { value: "workspace-reference" } }, true);
            assert.equal((changed.definition as { origin: string }).origin, "workspace", "the accepted model verb uses the same workspace layer as client actions");
            await invoke("mcp", "disable", { alias: "explicit" });
            await invoke("mcp", "enable", { alias: "explicit" });
            const received = await run("explicit", "explicit (environment)", {}, true, "body");
            assert.equal(received.witness, "explicit", "the entry's env applies over the workspace layer");
            assert.equal(received.reference, "workspace-reference", "a workspace value replaces the operator's");
            assert.equal(received.private, null, "the invoking worker never becomes the shared MCP's environment");

            const listed = await invoke("mcp", "list") as FunctionalityListResult;
            const retained = listed.definitions.find(({ alias }) => alias === "explicit");
            assert.ok(retained);
            assert.deepEqual((retained.definition as { env: object }).env, explicitEnv, "the definition is the plugin's entry; no resolved or ambient value is copied into it");
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
    const hostPaths = await mcpPluginHome(t, { authorized: httpEntry(served.url) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...MCP_CONTROLS, PLURNK_MCP_AUTHORIZED_BEARER: "${ENV_AUTH}", ENV_AUTH: "operator-token" } }));
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
        await assert.rejects(invoke("mcp", "enable", { alias: "authorized" }), /missing environment variable ENV_AUTH/u);
        assert.equal(received.length, before, "a workspace mask cannot fall back to the operator's reference value");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
