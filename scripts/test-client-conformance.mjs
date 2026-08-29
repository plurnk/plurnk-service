// {§agui-first-party-client-conformance} — pack the platform and terminal
// client into an empty consumer, then exercise the installed one-shot CLI,
// interactive TUI, and Neovim plugin against one daemon release. The shared
// conformance corpus owns protocol semantics; this gate owns composed product
// paths and host-native behavior.
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startClientJourneyModel } from "./fixtures/client-journey-model.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const terminalRoot = resolve(root, "../plurnk");
const nvimRoot = resolve(root, "../plurnk.nvim");
const terminalRequire = createRequire(join(terminalRoot, "package.json"));
const { spawn: spawnPty } = terminalRequire("node-pty");
const temp = await mkdtemp(join(tmpdir(), "plurnk-cross-client-"));
const install = join(temp, "consumer");
const terminalStage = join(temp, "terminal");
const home = join(temp, "home");
const project = join(temp, "project");
const installedNvim = join(temp, "site", "pack", "plurnk", "start", "plurnk.nvim");
const world = "cross-client-conformance";

const freePort = () => new Promise((accept, reject) => {
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

const runClient = (file, args, options) => new Promise((accept, reject) => {
    const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) accept({ stdout, stderr });
        else reject(new Error(`client exited ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
});

const pack = async (cwd, args = []) => {
    const packed = JSON.parse((await run("npm", [
        "pack", ...args, "--ignore-scripts", "--json", "--pack-destination", temp,
    ], { cwd, maxBuffer: 128 * 1024 * 1024 })).stdout);
    if (!Array.isArray(packed) || packed.some(({ filename }) => typeof filename !== "string")) {
        throw new Error(`npm pack returned no artifact for ${cwd}`);
    }
    return packed.map(({ filename }) => join(temp, filename));
};

const assertIncludes = (actual, expected, context) => {
    if (!actual.includes(expected)) {
        throw new Error(`${context} omitted ${JSON.stringify(expected)}\n${actual}`);
    }
};

const spawnInstalledTui = (clientBin, args, env) => {
    const term = spawnPty(clientBin, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: install,
        env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    });
    let output = "";
    const waiters = [];
    term.onData((chunk) => {
        output += chunk;
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (!waiters[index].pattern.test(output)) continue;
            clearTimeout(waiters[index].timer);
            waiters[index].accept(output);
            waiters.splice(index, 1);
        }
    });
    const exited = new Promise((accept) => term.onExit(accept));
    return {
        write: (value) => term.write(value),
        output: () => output,
        waitFor: (pattern, timeout = 30_000) => new Promise((accept, reject) => {
            if (pattern.test(output)) {
                accept(output);
                return;
            }
            const timer = setTimeout(() => reject(new Error(
                `TUI wait for ${pattern} timed out\n${output.slice(-2_000)}`,
            )), timeout);
            waiters.push({ pattern, accept, timer });
        }),
        exit: async () => {
            term.write("/quit\r");
            const result = await Promise.race([
                exited,
                new Promise((_, reject) => setTimeout(() => reject(new Error(
                    `installed TUI did not exit\n${output.slice(-2_000)}`,
                )), 10_000)),
            ]);
            if (result.exitCode !== 0) {
                throw new Error(`installed TUI exited ${result.exitCode}\n${output}`);
            }
        },
        kill: () => {
            try { term.kill(); } catch { /* already exited */ }
        },
    };
};

const drift = (kind, manifestKeys, liveKeys) => {
    const missing = liveKeys.filter((key) => !manifestKeys.includes(key));
    const extra = manifestKeys.filter((key) => !liveKeys.includes(key));
    if (missing.length === 0 && extra.length === 0) return null;
    const unclassified = missing.length === 0 ? "" : `unclassified live ${kind} ${missing.join(", ")}`;
    const separator = missing.length > 0 && extra.length > 0 ? "; " : "";
    const stale = extra.length === 0 ? "" : `stale manifest ${kind} ${extra.join(", ")}`;
    return `${kind}: ${unclassified}${separator}${stale}`;
};

const port = await freePort();
const daemonBin = join(install, "node_modules", ".bin", "plurnk-service");
const clientBin = join(install, "node_modules", ".bin", "plurnk");
const db = join(temp, "plurnk.db");
let daemon;
let fixture;
let tui;
let passed = false;
let daemonOutput = { stdout: "", stderr: "" };

try {
    await run("npm", ["run", "build"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    await Promise.all([
        mkdir(install, { recursive: true }),
        mkdir(terminalStage, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(project, { recursive: true }),
        mkdir(installedNvim, { recursive: true }),
    ]);
    await run("npm", ["init", "-y"], { cwd: install });
    const serviceSpecs = await pack(root, ["--workspaces"]);
    const contractsSpec = serviceSpecs.find((spec) => spec.includes("plurnk-plurnk-contracts-"));
    if (contractsSpec === undefined) throw new Error("packed platform omitted @plurnk/plurnk-contracts");

    await cp(terminalRoot, terminalStage, {
        recursive: true,
        filter: (source) => {
            const [top] = relative(terminalRoot, source).split(sep);
            return !["node_modules", "dist"].includes(top);
        },
    });
    await run("npm", [
        "install", "--ignore-scripts", "--no-audit", "--no-fund",
        "--package-lock=false", "--no-save", contractsSpec,
    ], { cwd: terminalStage, maxBuffer: 64 * 1024 * 1024 });
    await run("npm", ["run", "build"], { cwd: terminalStage, maxBuffer: 64 * 1024 * 1024 });
    const [clientSpec] = await pack(terminalStage);
    await run("npm", ["install", "--ignore-scripts", clientSpec, ...serviceSpecs], {
        cwd: install,
        maxBuffer: 128 * 1024 * 1024,
    });
    for (const directory of ["lua", "doc", "conformance"]) {
        await cp(join(nvimRoot, directory), join(installedNvim, directory), { recursive: true });
    }
    await writeFile(join(project, "README.md"), "# Cross-client installed journey\n");
    await writeFile(join(project, "journey.txt"), "pending\n");
    await run("git", ["init", "--quiet"], { cwd: project });
    await run("git", ["add", "README.md", "journey.txt"], { cwd: project });
    await run("git", [
        "-c", "user.name=Plurnk Test",
        "-c", "user.email=test@plurnk.invalid",
        "commit", "--quiet", "-m", "test: seed cross-client journey",
    ], { cwd: project });

    fixture = await startClientJourneyModel();
    const daemonEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        PLURNK_PORT: String(port),
        PLURNK_WS_PORT: "0",
        PLURNK_SERVICE_DB_PATH: db,
        PLURNK_SERVICE_EMBED_DISABLE: "1",
        PLURNK_SERVICE_MAX_TURNS: "8",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
        PLURNK_MCP_ENABLED: "[]",
        PLURNK_MODEL: "journey",
        PLURNK_MODEL_journey: "journey-fixture/plurnk-installed-journey",
        PLURNK_PROVIDERS_PROVIDER_JOURNEY_FIXTURE_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_JOURNEY_FIXTURE_BASE_URL: fixture.baseUrl,
        PLURNK_PROVIDERS_CONTEXT_WINDOW_journey: "32768",
        PLURNK_PROVIDERS_OUTPUT_BUDGET_journey: "4096",
        PLURNK_PROVIDERS_REASONING_journey: "adaptive",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS_journey: "0",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_journey: "5000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT_journey: "15000",
        PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT_journey: "5000",
        PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT_journey: "5000",
        PLURNK_PROVIDERS_CACHE_AFFINITY_journey: "0",
        PLURNK_PROVIDERS_CACHE_WRITE_POLICY_journey: "off",
    };
    const boot = async () => {
        const child = spawn(daemonBin, ["start"], {
            cwd: install,
            env: daemonEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        daemonOutput = { stdout, stderr };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            daemonOutput.stdout = stdout;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            daemonOutput.stderr = stderr;
        });
        await new Promise((accept, reject) => {
            const timer = setTimeout(() => reject(new Error(
                `installed service boot timeout\n${stdout}\n${stderr}`,
            )), 30_000);
            child.stdout.on("data", () => {
                if (!stdout.includes(`agui=http://127.0.0.1:${port}`)) return;
                clearTimeout(timer);
                accept();
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`installed service exited ${code}\n${stdout}\n${stderr}`));
            });
        });
        return child;
    };
    daemon = await boot();

    const clientEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: String(port),
        PLURNK_AGUI_URL: "",
        NO_COLOR: "1",
    };

    const cli = await runClient(clientBin, [
        "--json",
        "--workspace", "installed-cli",
        "--worker", "cli-worker",
        "--project-root", "",
        "--model", "journey",
        "--max-turns", "2",
        "--timeout", "20",
        "Exercise the installed one-shot interface.",
    ], { cwd: install, env: clientEnv, timeout: 30_000 });
    if (cli.stderr.length > 0) throw new Error(`JSON CLI wrote stderr\n${cli.stderr}`);
    const cliRecord = JSON.parse(cli.stdout);
    const modelOps = cliRecord.turns
        ?.flatMap(({ ops }) => ops)
        .filter(({ origin }) => origin === "model")
        .map(({ op }) => op);
    if (cliRecord.response !== "The installed one-shot journey is complete."
        || cliRecord.finalStatus !== 200
        || cliRecord.workspace?.name !== "installed-cli"
        || cliRecord.turnCount !== 2
        || JSON.stringify(modelOps) !== JSON.stringify(["PLAN", "SEND"])) {
        throw new Error(`installed CLI returned the wrong semantic record\n${cli.stdout}`);
    }
    process.stdout.write("installed one-shot CLI journey GREEN: world + Turn 0 + model PLAN/SEND\n");

    tui = spawnInstalledTui(clientBin, [
        "--workspace", "installed-tui",
        "--worker", "tui-worker",
        "--project-root", "",
        "--model", "journey",
        "--max-turns", "2",
    ], clientEnv);
    await tui.waitFor(/workspace: installed-tui/);
    tui.write("/mcp\r");
    await tui.waitFor(/MCP servers: none/);
    tui.write("/skills\r");
    await tui.waitFor(/Agent Skills: none/);
    tui.write("/agents\r");
    await tui.waitFor(/A2A agents: none/);
    tui.write("Exercise the installed interactive terminal.\r");
    await tui.waitFor(/The installed interactive journey is complete\./);
    // The status row settles on the session's summary line: the concluded loop's turns and
    // accounting, the gauge's model, the workspace, and the conversation worker.
    await tui.waitFor(/⏹️ completed · 2 turns · \d+ms · ↓400 ↑80 · 🎲 journey · installed-tui · worker:\/\/tui-worker\//);
    const tuiOutput = tui.output();
    assertIncludes(tuiOutput, "I will complete the request through the interactive terminal.", "installed TUI reasoning");
    assertIncludes(tuiOutput, "Confirm the packed interactive terminal path.", "installed TUI PLAN");
    assertIncludes(tuiOutput, "The installed interactive journey is complete.", "installed TUI SEND");
    await tui.exit();
    tui = undefined;
    process.stdout.write("installed interactive TUI journey GREEN: Functionality + reasoning + PLAN + SEND + status\n");

    const nvim = await run("nvim", [
        "--headless", "-u", "NONE", "-l", join(nvimRoot, "tests/installed-journey.lua"),
    ], {
        cwd: project,
        env: {
            ...clientEnv,
            PLURNK_NVIM_ROOT: installedNvim,
            PATH: `${join(install, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
        },
        maxBuffer: 16 * 1024 * 1024,
    });
    const nvimOutput = `${nvim.stdout}\n${nvim.stderr}`;
    assertIncludes(nvimOutput, "PASS installed Neovim default journey:", "installed Neovim journey");
    if (nvimOutput.includes("vim.schedule callback:")) {
        throw new Error(`installed Neovim raised an asynchronous callback failure\n${nvimOutput}`);
    }
    process.stdout.write("installed Neovim journey GREEN: mapping + multiline + review/resume + reasoning + PLAN + SEND\n");

    const firstNvim = fixture.requests.find(({ journey }) => journey === "nvim")?.body;
    const firstNvimMessages = JSON.stringify(firstNvim?.messages ?? []);
    if (!firstNvimMessages.includes("Create a reviewed acceptance marker.")
        || !firstNvimMessages.includes("The final response must confirm this multiline prompt.")) {
        throw new Error("the installed provider did not receive Neovim's native multiline prompt");
    }
    fixture.assertComplete();

    const { BridgeTransport } = await import(pathToFileURL(join(
        install, "node_modules", "@plurnk", "plurnk", "dist", "transport.js",
    )).href);
    const terminal = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}` },
        world,
        { workspace: world },
    );
    const durableCapabilities = { deny: [{ traits: ["interaction"] }] };
    await terminal.rpc("worker.capabilities.set", { policy: durableCapabilities });

    const discovery = await terminal.rpc("discover");
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
    const projected = await terminal.rpc("worker.mcp.discover", { configuration: overlay });
    if (!projected.candidates.some((candidate) => candidate.alias === "client-only"
        && candidate.provenance.kind === "client-configuration")) {
        throw new Error("terminal client did not project its configuration as MCP candidates");
    }
    const durable = await terminal.rpc("worker.mcp.list");
    if (durable.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate entered the Worker's durable set");
    }
    for (const family of ["skills", "agents"]) {
        const listed = await terminal.rpc(`worker.${family}.list`);
        if (!Array.isArray(listed.definitions)) {
            throw new Error(`worker.${family}.list returned no Functionality definitions`);
        }
    }

    const lua = join(temp, "cross-client.lua");
    const encodedCapabilities = JSON.stringify(durableCapabilities);
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
local expected_capabilities = vim.json.decode(${JSON.stringify(encodedCapabilities)})
assert(vim.deep_equal(rpc("worker.capabilities.get").worker, expected_capabilities))
for _, definition in ipairs(rpc("worker.mcp.list").definitions) do
  assert(definition.alias ~= "client-only", "a terminal-discovered candidate leaked into the Worker's durable set")
end
rpc("worker.members.add", { alias = "cross", definition = { glob = "cross/**" } })
print("cross-client Neovim observation GREEN")
pcall(function() require("plurnk.client").stop() end)
vim.cmd("qa!")
`);
    const observation = await run("nvim", ["--headless", "-u", "NONE", "-l", lua], {
        env: {
            ...clientEnv,
            PLURNK_NVIM_ROOT: installedNvim,
            PATH: `${join(install, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
        },
        maxBuffer: 16 * 1024 * 1024,
    });
    assertIncludes(`${observation.stdout}\n${observation.stderr}`, "cross-client Neovim observation GREEN", "Neovim state observation");
    // Neovim's members definition is the Worker's durable state; the terminal reads the same Worker.
    const membersOf = (listed) => (listed.definitions ?? [])
        .filter((definition) => definition.alias === "cross")
        .map(({ alias, origin, state, definition }) => ({ alias, origin, state, glob: definition?.glob }));
    const expectedMembers = [{ alias: "cross", origin: "worker", state: "active", glob: "cross/**" }];
    const members = await terminal.rpc("worker.members.list");
    if (JSON.stringify(membersOf(members)) !== JSON.stringify(expectedMembers)) {
        throw new Error(`terminal did not observe Neovim's durable mutation: ${JSON.stringify(members)}`);
    }

    await stop(daemon);
    daemon = await boot();
    const afterRestart = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}` },
        world,
        { workspace: world },
    );
    const persistedCapabilities = await afterRestart.rpc("worker.capabilities.get");
    const persistedMembers = await afterRestart.rpc("worker.members.list");
    if (JSON.stringify(persistedCapabilities.worker) !== JSON.stringify(durableCapabilities)
        || JSON.stringify(membersOf(persistedMembers)) !== JSON.stringify(expectedMembers)) {
        throw new Error("cross-client durable state did not survive daemon reconstruction");
    }
    const afterRestartMcp = await afterRestart.rpc("worker.mcp.list");
    if (afterRestartMcp.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate survived daemon reconstruction as durable state");
    }
    process.stdout.write("cross-client composition GREEN: one packed platform, three installed journeys, shared durable state\n");
    passed = true;
} catch (cause) {
    throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}\nservice stdout:\n${daemonOutput.stdout}\nservice stderr:\n${daemonOutput.stderr}`,
        { cause },
    );
} finally {
    tui?.kill();
    await stop(daemon);
    if (fixture !== undefined) await fixture.close();
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`cross-client conformance evidence preserved at ${temp}\n`);
}
