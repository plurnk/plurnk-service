import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { benchmarksRoot } from "../../../scripts/test-artifacts.ts";

test("{§operator-config-real-model-profile} deterministic AG-UI conversations never start operator MCP servers", { timeout: 60_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-agui-isolation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const home = join(directory, "operator");
    const marker = join(directory, "operator-mcp-started");
    const agents = join(home, ".agents");
    await mkdir(agents, { recursive: true });
    const definition = {
        command: process.execPath,
        args: [resolve(import.meta.dirname, "../../../plurnk-mcp/src/fixtures/echo-server.mjs")],
        env: { PLURNK_MCP_TEST_START_MARKER: marker },
    };
    const configuration = JSON.stringify({ mcpServers: { sentinel: definition } });
    await writeFile(join(agents, "mcp.json"), configuration);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^PLURNK_(?:MCP|A2A|SCHEDULE|MEMBERS|SKILLS)_/u.test(key)));
    delete env.NODE_TEST_CONTEXT;
    Object.assign(env, {
        HOME: home,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CACHE_HOME: join(directory, "cache"),
        PLURNK_SERVICE_STATE_ROOT: "",
        PLURNK_SERVICE_ROOTS: "global",
        PLURNK_BENCHMARKS: benchmarksRoot(),
        PLURNK_MCP_inherited: JSON.stringify({ name: "inherited", type: "stdio", ...definition }),
    });
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
        "--conditions=plurnk-dev",
        "--env-file-if-exists=.env.defaults",
        "--test",
        "--test-reporter=spec",
        "test/intg/conversations.test.ts",
    ], { cwd: resolve(import.meta.dirname, "../.."), env, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /pass 1/u, `the actual conversation fixture passes: ${stderr}`);
    await assert.rejects(stat(marker), { code: "ENOENT" }, "neither file-backed nor inherited MCP definitions may start");
});
