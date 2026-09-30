// {§mcp-plugin-servers} {§functionality-hotload} — MCP servers reach a real daemon in installed Agent Plugins,
// the family adds one as a one-server plugin and removes it, and it follows plugins installed or removed
// out of band at the next turn.
import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@plurnk/plurnk-agent-plugins";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_db.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { waitFor } from "./_rpc.ts";
import { MCP_CONTROLS, mcpPluginHome, stdioEntry, writePlugin } from "./_mcp-plugin.ts";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("{§mcp-plugin-servers} an installed plugin's server is enabled and callable; add installs a one-server plugin and remove uninstalls it", { timeout: 60_000 }, async (t) => {
    const hostPaths = await mcpPluginHome(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-plugins-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client", "client");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````KILL\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...MCP_CONTROLS } }));
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId }) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const call = (server: string, tool: string) => daemon.dispatchAsClient({ workspaceId, workerId: client, statement: parseOne(`\`\`\`\`${server} (${tool})\n{"message":"plugin"}\n\`\`\`\``) });

    assert.deepEqual(
        daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.mcp.")).toSorted(),
        ["add", "complete", "disable", "discover", "enable", "list", "oauth.complete", "remove"].map((verb) => `workspace.mcp.${verb}`),
        "the mcp family has every lifecycle verb beside its two protocol continuations",
    );
    assert.deepEqual((await listed()).map(({ alias, origin, state }) => ({ alias, origin, state })), [{ alias: "fixture", origin: "service", state: "dormant" }]);
    assert.equal((await call("fixture", "echo")).status, 200, "the plugin's server runs its read-only tool on first use");
    assert.equal((await listed())[0]?.state, "active");
    assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "fixture" })).definition.state, "disabled");
    assert.ok((await call("fixture", "echo")).status >= 400, "a disabled server's tool is absent");
    assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "fixture" })).definition.state, "active");

    const entry = stdioEntry("echo-server.mjs");
    const added = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "added", definition: { name: "added", scope: "plurnk", ...entry } });
    assert.equal(added.status, 201);
    assert.equal(added.definition.state, "active");
    const directory = join(hostPaths.plurnkPluginsDir, "added");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")), { $schema: PLUGIN_SCHEMA, name: "added" });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "mcp.json"), "utf8")), { $schema: MCP_SCHEMA, mcpServers: { added: entry } },
        "the added server is a standard Agent Plugin any host reads");
    assert.equal((await call("added", "echo")).status, 200, "the added server launches from its plugin");
    assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "added" })).removed, true);
    await assert.rejects(access(directory), "remove uninstalls the plugin add wrote");
    assert.deepEqual((await listed()).map(({ alias }) => alias), ["fixture"]);
});

test("{§functionality-hotload} {§functionality-inspection} a plugin installed out of band is published at the next turn, even after list saw it first", { timeout: 60_000 }, async (t) => {
    const hostPaths = await mcpPluginHome(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-hotload-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````KILL\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...MCP_CONTROLS } }));
    const events: Array<{ method: string; params: unknown }> = [];
    const unsubscribe = daemon.subscribeToEvents((_w, method, params) => { events.push({ method, params }); });
    t.after(async () => { unsubscribe(); await daemon.stop(); await db.close(); });
    await daemon.start();
    type Listed = { alias: string; state: string };
    const states = async (): Promise<Listed[]> => ((await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId })) as { definitions: Listed[] }).definitions.map(({ alias, state }) => ({ alias, state }));
    const turn = async (): Promise<void> => {
        const started = await daemon.runLoop({ workspaceId, workerId: model, prompt: "hotload", policy: { proposals: "accept" } });
        await waitFor(() => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === started.loopId), (list) => list.length > 0, { timeoutMs: 20_000 });
    };

    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }]);
    await writePlugin(join(hostPaths.plurnkPluginsDir, "second"), "second", { second: stdioEntry("echo-server.mjs") });
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "dormant" }],
        "inspection shows an out-of-band arrival as dormant until a turn publishes it");
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "active" }],
        "the next turn publishes the plugin that list had already seen");
    await rm(join(hostPaths.plurnkPluginsDir, "second"), { recursive: true, force: true });
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }], "a plugin removed between turns leaves at the next one");
});
