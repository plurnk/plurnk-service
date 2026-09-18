import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityDiscoverResult, FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { awaitExecOutcome, fixtureExecutors, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/storage-mcp.mjs", import.meta.url));
const nodeModulesPath = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const floor = { PLURNK_MCP_CONNECT_TIMEOUT: "2000", PLURNK_MCP_REQUEST_TIMEOUT: "5000" };
type Start = { cwd: string; home: string | null; pid: number };

test("{§mcp-working-storage} probes and attached tools write outside the project through discovery, execution, and restart", { timeout: 30000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-tool-storage-"));
    const project = join(scratch, "project");
    const marker = join(scratch, "starts.jsonl");
    const hostPaths = new HostPaths({ env: { XDG_STATE_HOME: join(scratch, "state") }, home: join(scratch, "home") });
    await mkdir(project);
    const db = await openMigrated();
    const previousCwd = process.cwd();
    process.chdir(project);
    const boot = () => {
        const daemon = new Daemon({ db, provider: null, nodeModulesPath, hostPaths });
        daemon.registerModule(McpModule.init({ env: floor }));
        return daemon;
    };
    let daemon = boot();
    const starts = async (): Promise<Start[]> => (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const invoke = (workspaceId: number, family: string, verb: string, params: object = {}) =>
        daemon.invokeModuleAction(`workspace.${family}.${verb}`, params as Record<string, unknown>, { scope: "workspace", workspaceId });
    try {
        await daemon.start();
        const workspaceId = await insertWorkspace(db, "storage");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        await invoke(workspaceId, "env", "add", { alias: "MCP_STORAGE_MARKER", definition: { value: marker } });
        const discover = () => invoke(workspaceId, "mcp", "discover", { source: `${process.execPath} ${fixture}` });
        const discovered = await discover() as FunctionalityDiscoverResult;
        const probe = (await starts())[0]!;
        assert.ok(probe.cwd.startsWith(`${hostPaths.stateDir}/`), probe.cwd);
        assert.deepEqual(await readdir(project), [], "discovery must not write into the daemon's project CWD");
        await assert.rejects(stat(probe.cwd), { code: "ENOENT" }, "a closed probe releases its disposable directory");
        const candidate = discovered.candidates[0];
        assert.ok(candidate);
        assert.equal((candidate.definition as { cwd?: string }).cwd, undefined, "candidate does not retain the probe directory");
        await Promise.all([discover(), discover()]);
        const probes = await starts();
        assert.equal(new Set(probes.map(({ cwd }) => cwd)).size, 3, "concurrent discovery never shares a scratch directory");
        for (const { cwd } of probes) await assert.rejects(stat(cwd), { code: "ENOENT" });

        const definition = { name: "fixture", transport: "stdio", command: process.execPath, args: [fixture], read: ["write"] };
        await invoke(workspaceId, "mcp", "add", { alias: "fixture", definition });
        const attached = (await starts()).at(-1)!;
        assert.ok(attached.cwd.startsWith(`${hostPaths.stateDir}/`), attached.cwd);
        assert.equal((await stat(attached.cwd)).mode & 0o777, 0o700);
        assert.equal(attached.home, process.env.HOME ?? null, "storage does not impersonate HOME");
        const source = PlurnkParser.frame("fixture (write)", JSON.stringify({ destination: join(project, "deliverable.txt") }));
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) }).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected the tool operation");
        assert.equal((await daemon.dispatchAsClient({ workspaceId, workerId, statement: parsed.statement })).status, 200);
        const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body", timeoutMs: 5000 });
        assert.equal(output.cwd, attached.cwd);
        const [stream] = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "fixture", prefix: "/%" });
        assert.ok(stream);
        assert.equal(await readFile(join(attached.cwd, ".tool-state/result.txt"), "utf8"), "retained result\n");
        assert.equal(await readFile(join(project, "deliverable.txt"), "utf8"), "intentional project work\n");
        assert.deepEqual(await readdir(project), ["deliverable.txt"], "only the explicitly named deliverable enters the project");

        await invoke(workspaceId, "mcp", "disable", { alias: "fixture" });
        await invoke(workspaceId, "mcp", "enable", { alias: "fixture" });
        assert.equal((await starts()).at(-1)!.cwd, attached.cwd);
        await daemon.stop();
        process.chdir(scratch);
        daemon = boot();
        await daemon.start();
        const listed = await invoke(workspaceId, "mcp", "list") as FunctionalityListResult;
        assert.equal(listed.definitions[0]?.state, "active");
        assert.equal((await starts()).at(-1)!.cwd, attached.cwd, "restart and a different launcher CWD preserve storage");
        assert.deepEqual(listed.definitions[0]?.definition, definition, "derived paths do not leak into durable definitions");
        assert.equal(await readFile(join(attached.cwd, ".tool-state/result.txt"), "utf8"), "retained result\n");

        const second = await insertWorkspace(db, "other");
        await invoke(second, "mcp", "add", { alias: "fixture", definition: { ...definition, env: { MCP_STORAGE_MARKER: marker } } });
        assert.notEqual((await starts()).at(-1)!.cwd, attached.cwd, "same alias in another workspace has separate state");
        await invoke(workspaceId, "mcp", "remove", { alias: "fixture" });
        assert.equal(await readFile(join(attached.cwd, ".tool-state/result.txt"), "utf8"), "retained result\n", "removing a definition does not erase unknown server state");
        const read = PlurnkParser.parseStatements(PlurnkParser.frame(`READ (fixture://${stream.pathname}) <1,-1>`, null)).items[0];
        assert.equal(read?.kind, "statement");
        if (read?.kind !== "statement") throw new Error("Expected the retained output READ");
        const retained = await daemon.look({ workspaceId, workerId, statement: read.statement });
        assert.equal(retained.status, 200, "removing the server leaves its recorded output readable");
        assert.equal(typeof retained.content, "string");
        assert.deepEqual(JSON.parse(retained.content as string), output);
        await invoke(workspaceId, "mcp", "add", { alias: "fixture", definition: { ...definition, env: { MCP_STORAGE_MARKER: marker } } });
        assert.equal((await starts()).at(-1)!.cwd, attached.cwd, "a replacement definition reuses its alias's retained state");

        const explicit = join(scratch, "explicit");
        await mkdir(explicit);
        await invoke(workspaceId, "mcp", "add", { alias: "explicit", definition: { ...definition, name: "explicit", cwd: relative(process.cwd(), explicit) } });
        assert.equal((await starts()).at(-1)!.cwd, explicit, "an explicit relative CWD keeps its launch-directory meaning");
        await invoke(workspaceId, "mcp", "remove", { alias: "explicit" });
        assert.equal((await stat(explicit)).isDirectory(), true);

        await invoke(workspaceId, "env", "add", { alias: "MCP_STORAGE_FAIL", definition: { value: "1" } });
        await assert.rejects(discover(), /could not be inspected/);
        const failed = (await starts()).at(-1)!;
        await assert.rejects(stat(failed.cwd), { code: "ENOENT" }, "failed discovery closes before cleaning its scratch files");
    } finally {
        await daemon.stop();
        await db.close();
        process.chdir(previousCwd);
        await rm(scratch, { recursive: true, force: true });
    }
});

test("{§mcp-working-storage} a storage creation failure never falls back to the project", { timeout: 15000 }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-tool-storage-failure-"));
    const state = join(scratch, "state");
    const marker = join(scratch, "starts.jsonl");
    await mkdir(join(state, "plurnk"), { recursive: true });
    await writeFile(join(state, "plurnk/workspaces"), "occupied");
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath, hostPaths: new HostPaths({ env: { XDG_STATE_HOME: state } }) });
    daemon.registerModule(McpModule.init({ env: floor }));
    try {
        await daemon.start();
        const workspaceId = await insertWorkspace(db, "blocked-storage");
        await assert.rejects(daemon.invokeModuleAction("workspace.mcp.add", { alias: "fixture", definition: {
            name: "fixture", transport: "stdio", command: process.execPath, args: [fixture], env: { MCP_STORAGE_MARKER: marker },
        } }, { scope: "workspace", workspaceId }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Configured MCP server 'fixture' is unavailable.");
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
            assert.equal((error.cause as NodeJS.ErrnoException).syscall, "mkdir");
            return true;
        });
        await assert.rejects(stat(marker), { code: "ENOENT" }, "the subprocess must never start without its directory");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(scratch, { recursive: true, force: true });
    }
});
