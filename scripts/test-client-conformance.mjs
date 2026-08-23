import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const terminalRoot = resolve(root, "../plurnk");
const nvimRoot = resolve(root, "../plurnk.nvim");
const temp = await mkdtemp(join(tmpdir(), "plurnk-cross-client-"));
const home = join(temp, "home");
const installedNvim = join(temp, "site", "pack", "plurnk", "start", "plurnk.nvim");
const world = "cross-client-conformance";
const port = await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => accept(address.port));
    });
});
const stop = async (child) => {
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise((accept) => child.once("exit", accept));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
};
const boot = async () => {
    const child = spawn(process.execPath, [join(root, "plurnk-core/dist/service.js"), "start"], {
        cwd: root,
        env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            XDG_STATE_HOME: join(home, ".local", "state"),
            XDG_CACHE_HOME: join(home, ".cache"),
            PLURNK_PORT: String(port),
            PLURNK_WS_PORT: "0",
            PLURNK_SERVICE_DB_PATH: join(temp, "plurnk.db"),
            PLURNK_SERVICE_EMBED_DISABLE: "1",
            PLURNK_MCP_ENABLED: "[]",
            PLURNK_MODEL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error(`service boot timeout\n${stdout}\n${stderr}`)), 30_000);
        child.stdout.on("data", () => {
            if (!stdout.includes(`agui=http://127.0.0.1:${port}`)) return;
            clearTimeout(timeout);
            accept();
        });
        child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`service exited ${code}\n${stdout}\n${stderr}`));
        });
    });
    return child;
};

let daemon;
let passed = false;
try {
    await Promise.all([
        run("npm", ["run", "build"], { cwd: root, maxBuffer: 128 * 1024 * 1024 }),
        run("npm", ["run", "build"], { cwd: terminalRoot, maxBuffer: 64 * 1024 * 1024 }),
    ]);
    await mkdir(installedNvim, { recursive: true });
    for (const directory of ["lua", "doc", "conformance"]) {
        await cp(join(nvimRoot, directory), join(installedNvim, directory), { recursive: true });
    }

    daemon = await boot();

    const { BridgeTransport } = await import(pathToFileURL(join(terminalRoot, "dist/transport.js")).href);
    const terminal = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}` },
        world,
        { workspace: world },
    );
    await terminal.rpc("worker.settings.set", { settings: { requestUserInput: true } });

    // Sibling-manifest gate (#331; the classification contract lives in the clients) —
    // every present sibling client's conformance manifest must classify exactly
    // the live discovery surface, so a service rename, scope, or module-action
    // change fails THIS repository's gate, not the sibling's next dogfood.
    const discovery = await terminal.rpc("discover");
    const drift = (kind, manifestKeys, liveKeys) => {
        const missing = liveKeys.filter((key) => !manifestKeys.includes(key));
        const extra = manifestKeys.filter((key) => !liveKeys.includes(key));
        if (missing.length === 0 && extra.length === 0) return null;
        return `${kind}: ${missing.length === 0 ? "" : `unclassified live ${kind} ${missing.join(", ")}`}${missing.length > 0 && extra.length > 0 ? "; " : ""}${extra.length === 0 ? "" : `stale manifest ${kind} ${extra.join(", ")}`}`;
    };
    for (const [name, clientRoot] of [["plurnk", terminalRoot], ["plurnk.nvim", nvimRoot]]) {
        let raw;
        try {
            raw = await readFile(join(clientRoot, "conformance/agui-client.json"), "utf8");
        } catch {
            process.stdout.write(`sibling client SKIPPED (checkout absent): ${name} at ${clientRoot}\n`);
            continue;
        }
        const manifest = JSON.parse(raw);
        const problems = [
            drift("actions", Object.keys(manifest.actions).toSorted(), Object.keys(discovery.actions).toSorted()),
            drift("notifications", Object.keys(manifest.notifications).toSorted(), Object.keys(discovery.notifications).toSorted()),
        ].filter((problem) => problem !== null);
        if (problems.length > 0) {
            throw new Error(`${name} conformance manifest drifted from live discovery — ${problems.join(" · ")}`);
        }
        process.stdout.write(`${name} conformance manifest matches live discovery (${Object.keys(discovery.actions).length} actions, ${Object.keys(discovery.notifications).length} notifications)\n`);
    }
    const overlay = {
        "PLURNK_MCP_CLIENT-ONLY": process.execPath,
        "PLURNK_MCP_CLIENT-ONLY_ARGS": JSON.stringify([
            join(root, "plurnk-mcp/src/fixtures/echo-server.mjs"),
        ]),
    };
    // {§functionality-coordinator} — a client's own configuration contributes
    // inert candidates through discover; the Worker's durable set is separate.
    const projected = await terminal.rpc("worker.mcp.discover", { configuration: overlay });
    if (!projected.candidates.some((candidate) => candidate.alias === "client-only" && candidate.provenance.kind === "client-configuration")) {
        throw new Error("terminal client did not project its configuration as MCP candidates");
    }
    const durable = await terminal.rpc("worker.mcp.list");
    if (durable.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate entered the Worker's durable set");
    }

    const lua = join(temp, "cross-client.lua");
    await writeFile(lua, `
vim.opt.rtp:prepend(${JSON.stringify(installedNvim)})
require("plurnk").setup({ host = "127.0.0.1", port = ${port} })
local agui = require("plurnk.agui")
local target = require("plurnk.bridge").target()
local world = ${JSON.stringify(world)}
local function rpc(method, params)
  local segment
  agui.rpc(target, world, method, params or {}, function(value) segment = value end)
  if not vim.wait(10000, function() return segment ~= nil end, 25) then error(method .. " timed out") end
  if segment.state ~= "complete" then error(method .. " failed: " .. vim.inspect(segment.problem)) end
  return segment.result
end
assert(rpc("worker.settings.get").requestUserInput == true)
for _, definition in ipairs(rpc("worker.mcp.list").definitions) do
  assert(definition.alias ~= "client-only", "a terminal-discovered candidate leaked into the Worker's durable set")
end
rpc("workspace.constrain", { effect = "pick", glob = "cross/**" })
print("cross-client Neovim observation GREEN")
vim.cmd("qa!")
`);
    const nvim = await run("nvim", ["--headless", "-u", "NONE", "-l", lua], {
        env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: String(port),
            PLURNK_NVIM_ROOT: installedNvim,
        },
        maxBuffer: 16 * 1024 * 1024,
    });
    if (!`${nvim.stdout}\n${nvim.stderr}`.includes("cross-client Neovim observation GREEN")) {
        throw new Error(`Neovim emitted no cross-client evidence\n${nvim.stdout}\n${nvim.stderr}`);
    }
    const constraints = await terminal.rpc("workspace.constraints");
    if (JSON.stringify(constraints.constraints) !== JSON.stringify([{ effect: "pick", glob: "cross/**", source: "explicit" }])) {
        throw new Error(`terminal did not observe Neovim's durable mutation: ${JSON.stringify(constraints)}`);
    }
    await stop(daemon);
    daemon = await boot();
    const afterRestart = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}` },
        world,
        { workspace: world },
    );
    const persistedSettings = await afterRestart.rpc("worker.settings.get");
    const persistedConstraints = await afterRestart.rpc("workspace.constraints");
    if (persistedSettings.requestUserInput !== true
        || JSON.stringify(persistedConstraints.constraints) !== JSON.stringify([{ effect: "pick", glob: "cross/**", source: "explicit" }])) {
        throw new Error("cross-client durable state did not survive daemon reconstruction");
    }
    const afterRestartMcp = await afterRestart.rpc("worker.mcp.list");
    if (afterRestartMcp.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate survived daemon reconstruction as durable state");
    }
    process.stdout.write("cross-client composition GREEN: durable state shared and reconstructed; client MCP candidates remained inert\n");
    passed = true;
} finally {
    await stop(daemon);
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`cross-client conformance evidence preserved at ${temp}\n`);
}
