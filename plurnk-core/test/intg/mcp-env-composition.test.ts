import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityDiscoverResult, FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { awaitExecOutcome, fixtureExecutors, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { waitFor } from "./_rpc.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/environment-mcp.mjs", import.meta.url));

test("{§mcp-launch-environment} a real MCP probe and server use workspace env, not worker env, and pick up changes only on restart", { timeout: 30000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-env-"));
    const marker = join(scratch, "starts.jsonl");
    const db = await openMigrated();
    const boot = () => {
        const instance = new Daemon({ db, provider: null, schemes: new SchemeRegistry() });
        instance.registerModule(McpModule.init({ env: { PLURNK_MCP_CONNECT_TIMEOUT: "10000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", REF_VALUE: "operator" } }));
        return instance;
    };
    let daemon = boot();
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `mcp-env-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice", "client");
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        const set = (alias: string, value: string) => invoke("env", "add", { alias, definition: { value } });
        await set("ENV_WITNESS", "workspace");
        await set("MCP_ENV_MARKER", marker);
        await daemon.invokeModuleAction("worker.env.add", { alias: "ENV_WITNESS", definition: { value: "private" } }, { scope: "worker", workspaceId, workerId });
        await daemon.invokeModuleAction("worker.env.add", { alias: "WORKER_ONLY", definition: { value: "private" } }, { scope: "worker", workspaceId, workerId });
        const discovered = await invoke("mcp", "discover", { source: `${process.execPath} ${fixture}` }) as FunctionalityDiscoverResult;
        assert.equal(discovered.candidates[0]?.alias, "env-workspace", "the probe itself receives workspace configuration");
        const definition = { name: "fixture", transport: "stdio", command: process.execPath, args: [fixture], env: { BOUND_VALUE: "${REF_VALUE}" }, read: ["environment"] };
        await invoke("mcp", "add", { alias: "fixture", definition });
        const starts = async () => (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { witness: string; private: string | null; bound: string | null; reference: string | null; home: string | null; pid: number });
        assert.equal((await starts()).at(-1)?.witness, "workspace");
        assert.equal((await starts()).at(-1)?.private, null);
        assert.equal((await starts()).at(-1)?.bound, "operator", "operator references resolve without bulk inheritance");
        assert.equal((await starts()).at(-1)?.reference, null, "the resolution context is not the subprocess environment");
        const before = await starts();
        await invoke("env", "remove", { alias: "ENV_WITNESS" });
        await set("ENV_WITNESS", "updated");
        await invoke("mcp", "list");
        assert.deepEqual(await starts(), before, "env edits and listing do not restart a live MCP");
        await invoke("mcp", "disable", { alias: "fixture" });
        await invoke("mcp", "enable", { alias: "fixture" });
        assert.equal((await starts()).at(-1)?.witness, "updated");
        assert.notEqual((await starts()).at(-1)?.pid, before.at(-1)?.pid);

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
            const header = JSON.stringify([{ env: { ENV_WITNESS: "explicit", BOUND_VALUE: "${REF_VALUE}" } }]);
            const explicit = await run("mcp", `mcp (add) ${header}`, { alias: "explicit", definition: { ...definition, name: "explicit", env: undefined } }, true);
            assert.equal((explicit.definition as { state: string }).state, "active");
            const received = await run("explicit", "explicit (environment)", {}, false, "body");
            assert.equal(received.witness, "explicit", "header launch options override workspace defaults");
            assert.equal(received.bound, "workspace-reference", "MCP launch options retain normal symbolic-reference semantics");
            assert.equal(received.private, null, "the invoking worker never becomes the shared MCP's environment");

            const listed = await invoke("mcp", "list") as FunctionalityListResult;
            const retained = listed.definitions.find(({ alias }) => alias === "explicit");
            assert.ok(retained);
            assert.deepEqual((retained.definition as { env: object }).env,
                { ENV_WITNESS: "explicit", BOUND_VALUE: "${REF_VALUE}" }, "only explicit overrides persist, not resolved or ambient values");
        } finally { unsubscribe(); }

        await invoke("env", "disable", { alias: "HOME" });
        const beforeCold = (await starts()).length;
        await daemon.stop();
        daemon = boot();
        await daemon.start();
        const coldList = await invoke("mcp", "list") as FunctionalityListResult;
        const rehydrated = (await starts()).slice(beforeCold);
        assert.deepEqual(coldList.definitions.map(({ alias, state }) => [alias, state]), [["explicit", "active"], ["fixture", "active"]]);
        assert.deepEqual(new Set(rehydrated.map(({ witness }) => witness)), new Set(["updated", "explicit"]), "cold activation reconstructs workspace defaults and retained launch options");
        for (const received of rehydrated) {
            assert.equal(received.bound, "workspace-reference");
            assert.equal(received.private, null);
            assert.equal(received.home, null, "the SDK's default environment cannot reintroduce a workspace-masked name");
        }
    } finally {
        await daemon.stop();
        await db.close();
        await rm(scratch, { recursive: true, force: true });
    }
});

test("{§mcp-launch-environment} HTTP authorization references use workspace defaults while retaining symbolic definitions", async (t) => {
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
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(McpModule.init({ env: { PLURNK_MCP_CONNECT_TIMEOUT: "10000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", ENV_AUTH: "operator-token" } }));
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `http-env-${crypto.randomUUID()}`);
        const invoke = (family: string, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        await invoke("env", "add", { alias: "ENV_AUTH", definition: { value: "workspace-token" } });
        const definition = { name: "authorized", transport: "http", url: served.url, headers: { Authorization: "Bearer ${ENV_AUTH}" } };
        const added = await invoke("mcp", "add", { alias: "authorized", definition }) as { definition: { state: string } };
        assert.equal(added.definition.state, "active");
        assert.ok(received.length > 0);
        assert.ok(received.every((value) => value === "Bearer workspace-token"));
        const list = await invoke("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(list.definitions[0]?.definition, definition, "the stored definition contains references, not captured credentials");
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
