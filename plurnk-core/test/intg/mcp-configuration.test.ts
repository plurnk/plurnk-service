// {§mcp-configuration} {§functionality-hotload}
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Problems } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_db.ts";
import { fixtureExecutors, makeMockResponse, userText } from "./_mock.ts";
import { waitFor } from "./_rpc.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { mcpFixture, stdioEntry } from "./_mcp-config.ts";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("{§mcp-file-configuration} a global mcp.json supplies callable servers without a plugin or environment definition", { timeout: 30_000 }, async (t) => {
    const roots = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = "global";
    t.after(() => { if (roots === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = roots; });
    const { hostPaths, env } = await mcpFixture(t, {});
    const directory = join(hostPaths.home, ".agents");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "mcp.json");
    const contents = JSON.stringify({ mcpServers: { fixture: stdioEntry("echo-server.mjs") } });
    await writeFile(file, contents);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-file-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client", "client");
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const list = await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
    assert.deepEqual(list.definitions.map(({ alias, origin, state, provenance }) => ({ alias, origin, state, provenance })), [{
        alias: "fixture", origin: "service", state: "dormant",
        provenance: { kind: "file", source: file, reference: "/mcpServers/fixture" },
    }]);
    const result = await daemon.dispatchAsClient({ workspaceId, workerId: client, statement: parseOne("````fixture (echo)\n{\"message\":\"file-backed\"}\n````") });
    assert.equal(result.status, 200);
    const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "json", after: 0 });
    assert.deepEqual(output.content, [{ type: "text", text: "file-backed" }]);
    assert.equal(await readFile(file, "utf8"), contents, "loading and invoking never rewrite operator configuration");
});

test("{§mcp-file-configuration} workspace and environment overrides restore the current file definition and enabledness", async (t) => {
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const directories = [join(project, ".agents"), hostPaths.configDir, join(hostPaths.home, ".agents")];
    for (const directory of directories) await mkdir(directory, { recursive: true });
    for (const [index, directory] of directories.entries()) {
        await writeFile(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { fixture: stdioEntry("echo-server.mjs", { SOURCE: String(index) }) } }));
    }
    env.PLURNK_MCP_ENABLED = "0";
    const db = await openMigrated();
    let daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "file-cascade", projectRoot: project });
    const headless = await daemon.createWorkspace({ name: "file-headless", projectRoot: null });
    const invoke = (verb: string, params = {}, workspaceId = workspace.workspaceId) =>
        daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
    const list = async (workspaceId?: number) => (await invoke("list", {}, workspaceId) as FunctionalityListResult).definitions;
    assert.equal((await list())[0].provenance?.source, join(directories[0], "mcp.json"));
    assert.equal((await list(headless.workspaceId))[0].provenance?.source, join(directories[1], "mcp.json"));
    assert.equal((await list())[0].state, "disabled");
    env.PLURNK_MCP_fixture = JSON.stringify({ name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "environment" }) });
    assert.deepEqual((await list())[0].provenance, { kind: "environment", source: "PLURNK_MCP_fixture" });
    const local = { name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "local" }) };
    await invoke("add", { alias: "fixture", definition: local });
    assert.equal((await list())[0].origin, "workspace");
    assert.equal((await list())[0].provenance, undefined);
    delete env.PLURNK_MCP_fixture;
    await rm(join(directories[0], "mcp.json"));
    await invoke("remove", { alias: "fixture" });
    const restored = (await list())[0];
    assert.equal(restored.state, "disabled");
    assert.equal(restored.provenance?.source, join(directories[1], "mcp.json"));
    assert.deepEqual(restored.definition, { name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "1" }) });
    await daemon.stop();
    daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    await daemon.start();
    assert.equal((await list())[0].state, "disabled", "restart preserves inherited enabledness without a local mask");
    await rm(join(directories[1], "mcp.json"));
    assert.equal((await list())[0].provenance?.source, join(directories[2], "mcp.json"));
    assert.deepEqual(await readdir(directories[2]), ["mcp.json"], "workspace mutations never manufacture plugin files");
});

test("{§mcp-file-configuration} malformed files leave chat usable and normal turns publish repairs, changes, and removal", { timeout: 30_000 }, async (t) => {
    const { hostPaths, env } = await mcpFixture(t, {});
    const directory = join(hostPaths.home, ".agents");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "mcp.json");
    await writeFile(file, "not json");
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-file-repair-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 5 }, () => makeMockResponse("````KILL\nConfiguration checked.\n````")) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    const ended: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") ended.push((params as { loopId: number }).loopId); });
    t.after(unsubscribe);
    await daemon.start();
    const turn = async () => {
        const started = await daemon.runLoop({ workspaceId, workerId: model, prompt: "Inspect configuration.", policy: { proposals: "accept" } });
        await waitFor(() => ended, (ids) => ids.includes(started.loopId), { timeoutMs: 10_000 });
    };
    const list = async () => (await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
    const rejectsConfiguration = () => assert.rejects(list(), (cause: unknown) => {
        const problem = Problems.fromError(cause);
        assert.equal(problem?.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
        assert.ok(problem.detail?.includes(file));
        return true;
    });
    await rejectsConfiguration();
    await turn();
    assert.ok(userText(provider.received[0]).includes(file), "the model can locate and repair the malformed file");
    const save = (name: string) => writeFile(file, JSON.stringify({ mcpServers: { [name]: stdioEntry("echo-server.mjs") } }));
    await save("first");
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["first", "dormant"]],
        "a repaired source is inspectable before another turn; its obsolete parse error cannot override fresh resolution");
    assert.equal(daemon.schemes.has("first", workspaceId), false, "inspection does not publish the repaired server");
    await turn();
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["first", "active"]]);
    await save("second");
    assert.equal((await list())[0].state, "dormant", "inspection does not pretend a changed definition is already active");
    await turn();
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["second", "active"]]);
    await writeFile(file, "not json again");
    await turn();
    await rejectsConfiguration();
    await rm(file);
    assert.deepEqual(await list(), [], "removing a malformed source also clears its inspection failure before publication");
    await turn();
    assert.deepEqual(await list(), []);
    assert.equal(provider.received.length, 5, "every configuration state left inference usable");
});

test("{§configuration-repair-path} a model's EDIT and same-turn list observe the repair before the next turn activates its tool", { timeout: 30_000 }, async (t) => {
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const file = join(project, ".agents", "mcp.json");
    await mkdir(join(project, ".agents"), { recursive: true });
    await writeFile(file, "not json");
    const content = JSON.stringify({ mcpServers: { repaired: stdioEntry("echo-server.mjs") } });
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`\`\`\`\`EDIT (.agents/mcp.json) <1,-1>\n${content}\n\`\`\`\`\n\n\`\`\`\`mcp (list)\n\`\`\`\``),
        makeMockResponse("````repaired (echo)\n{\"message\":\"same-turn-repair\"}\n````"),
        makeMockResponse("````KILL\nConfiguration repaired.\n````"),
    ] });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "same-turn-repair", projectRoot: project });
    await daemon.invokeModuleAction("workspace.members.add", {
        alias: "configuration", definition: { glob: ".agents/mcp.json" },
    }, { scope: "workspace", workspaceId });
    const workerId = await insertWorker(db, workspaceId, null, "repairer", "model");
    const finalStatuses: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
        if (method === "loop/terminated") finalStatuses.push((params as { result: { status: number } }).result.status);
    });
    t.after(unsubscribe);
    await daemon.runLoop({ workspaceId, workerId, prompt: "Repair the MCP file and verify its tool.", policy: { proposals: "accept" } });
    await waitFor(() => finalStatuses, (statuses) => statuses.length > 0, { timeoutMs: 15_000 });
    assert.deepEqual(finalStatuses, [200]);
    const log = await daemon.readLog({ workspaceId, workerId, limit: 100 });
    assert.equal(await readFile(file, "utf8"), content, JSON.stringify(log.filter(({ op }) => op === "EDIT")));
    const inspected = await awaitExecOutcome(db, { workspaceId, scheme: "mcp" });
    assert.deepEqual((inspected.definitions as FunctionalityListResult["definitions"]).map(({ alias, state }) => [alias, state]),
        [["repaired", "dormant"]], "the manager's own same-turn result observes fresh configuration without premature publication");
    const echoed = await awaitExecOutcome(db, { workspaceId, scheme: "repaired", channel: "json" });
    assert.deepEqual(echoed.content, [{ type: "text", text: "same-turn-repair" }]);
    assert.equal(provider.received.length, 3, "no stale-source recovery turn is necessary");
});

test("{§mcp-configuration} configured servers and workspace additions are callable without altering plugin installations", { timeout: 60_000 }, async (t) => {
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-configuration-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client", "client");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````KILL\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: mcpEnv }), "@plurnk/plurnk-mcp");
    const directory = join(hostPaths.plurnkPluginsDir, "added");
    await mkdir(directory, { recursive: true });
    const manifest = JSON.stringify({ name: "added", description: "Independent plugin installation." });
    await writeFile(join(directory, "plugin.json"), manifest);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId }) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const call = async (server: string, tool: string) => {
        const before = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: server, prefix: "/%" })).length;
        const result = await daemon.dispatchAsClient({ workspaceId, workerId: client, statement: parseOne(`\`\`\`\`${server} (${tool})\n{"message":"configuration"}\n\`\`\`\``) });
        if (result.status === 200) {
            const output = await awaitExecOutcome(db, { workspaceId, scheme: server, channel: "json", after: before });
            assert.deepEqual(output.content, [{ type: "text", text: "configuration" }]);
        }
        return result;
    };

    assert.deepEqual(
        daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.mcp.")).toSorted(),
        ["add", "complete", "disable", "discover", "enable", "list", "oauth.begin", "oauth.complete", "remove"].map((verb) => `workspace.mcp.${verb}`),
        "the mcp family has every lifecycle verb beside its protocol continuations",
    );
    assert.deepEqual((await listed()).map(({ alias, origin, state }) => ({ alias, origin, state })), [{ alias: "fixture", origin: "service", state: "dormant" }]);
    assert.equal((await call("fixture", "echo")).status, 200, "the configured server runs its read-only tool on first use");
    assert.equal((await listed())[0]?.state, "active");
    assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "fixture" })).definition.state, "disabled");
    assert.ok((await call("fixture", "echo")).status >= 400, "a disabled server's tool is absent");
    assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "fixture" })).definition.state, "active");

    const entry = stdioEntry("echo-server.mjs");
    const added = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "added", definition: { name: "added", ...entry } });
    assert.equal(added.status, 201);
    assert.equal(added.definition.state, "active");
    assert.equal((await listed()).find(({ alias }) => alias === "added")?.origin, "workspace");
    assert.equal(await readFile(join(directory, "plugin.json"), "utf8"), manifest);
    assert.deepEqual(await readdir(directory), ["plugin.json"], "MCP add writes no plugin files");
    assert.equal((await call("added", "echo")).status, 200, "the workspace addition launches directly");
    assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "added" })).removed, true);
    assert.equal(await readFile(join(directory, "plugin.json"), "utf8"), manifest, "MCP remove preserves the independent plugin");
    assert.deepEqual((await listed()).map(({ alias }) => alias), ["fixture"]);
});

test("{§functionality-hotload} {§functionality-inspection} changed baseline definitions publish at the next turn, even after list saw them first", { timeout: 60_000 }, async (t) => {
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-hotload-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````KILL\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: mcpEnv }), "@plurnk/plurnk-mcp");
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
    mcpEnv.PLURNK_MCP_second = JSON.stringify({ name: "second", ...stdioEntry("echo-server.mjs") });
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "dormant" }],
        "inspection shows an out-of-band arrival as dormant until a turn publishes it");
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "active" }],
        "the next turn publishes the definition that list had already seen");
    delete mcpEnv.PLURNK_MCP_second;
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }], "a baseline removed between turns leaves at the next one");
});
