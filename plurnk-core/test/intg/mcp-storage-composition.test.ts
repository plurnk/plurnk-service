// {§mcp-launch-directory}
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors } from "./_mock.ts";
import { openMigrated } from "./_db.ts";
import { waitFor } from "./_rpc.ts";
import { MCP_CONTROLS, mcpFixture, stdioEntry } from "./_mcp-config.ts";

type Placement = { cwd: string };

// An empty project directory for the workspace, removed with the test.
const projectDirectory = async (t: TestContext): Promise<string> => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-placement-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const project = join(scratch, "project");
    await mkdir(project);
    return project;
};

test("{§mcp-launch-directory} a stdio tool runs in retained workspace state and writes nothing into the project", { timeout: 30000 }, async (t) => {
    const project = await projectDirectory(t);
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs", { PLURNK_MCP_TEST_WHERE: "1" }) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }));
    const proposals: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
        if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
    });
    try {
        await daemon.start();
        const { workspaceId, workerId } = await daemon.createWorkspace({ name: "placement", projectRoot: project });
        const source = PlurnkParser.frame("fixture (where)", "{}");
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) }).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected the tool operation");
        const pending = daemon.dispatchAsClient({ workspaceId, workerId, statement: parsed.statement });
        await waitFor(() => proposals, (list) => list.length > 0, { timeoutMs: 10000 });
        daemon.resolveProposal(proposals[0]!, { decision: "accept" });
        assert.equal((await pending).status, 200);
        const placed = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body", timeoutMs: 10000 }) as Placement;
        const directory = await daemon.workspaceStateDirectory(workspaceId, "@plurnk/plurnk-mcp/fixture");
        assert.deepEqual(placed, { cwd: await realpath(directory) });
        assert.equal((await stat(directory)).mode & 0o777, 0o700, "workspace state is private and created before launch");
        await daemon.invokeModuleAction("workspace.mcp.disable", { alias: "fixture" }, { scope: "workspace", workspaceId });
        assert.ok((await stat(directory)).isDirectory(), "disabling the connection retains its state directory");
        assert.deepEqual(await readdir(project), [], "the launch and the tool write nothing into the project");
    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
});

test("{§mcp-launch-directory} an inaccessible state directory leaves the server unavailable and never falls back to the project", { timeout: 15000 }, async (t) => {
    const project = await projectDirectory(t);
    const marker = join(dirname(project), "starts.txt");
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs", { PLURNK_MCP_TEST_START_MARKER: marker }) });
    await mkdir(hostPaths.stateDir, { recursive: true });
    await writeFile(join(hostPaths.stateDir, "workspaces"), "occupied");
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }));
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "blocked-mcp-state", projectRoot: project });
        const invoke = (verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
        await assert.rejects(invoke("enable", { alias: "fixture" }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Configured MCP server 'fixture' is unavailable.");
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
            assert.equal((error.cause as NodeJS.ErrnoException).syscall, "mkdir");
            return true;
        });
        assert.equal((await invoke("list") as FunctionalityListResult).definitions[0]?.state, "unavailable");
        await assert.rejects(stat(marker), { code: "ENOENT" }, "the subprocess never starts without its state directory");
        assert.deepEqual(await readdir(project), [], "nothing falls back to the project");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
