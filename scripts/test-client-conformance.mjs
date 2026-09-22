// {§agui-first-party-client-conformance} — pack the platform and terminal
// client into an empty consumer, then exercise the installed one-shot CLI,
// and interactive TUI against one daemon release. The shared
// conformance corpus owns protocol semantics; this gate owns composed product
// paths and host-native behavior.
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { projectTarball } from "./package-projection.mjs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startClientJourneyModel } from "./fixtures/client-journey-model.mjs";
import { resolveClientCheckout } from "./project-topology.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const terminalRoot = resolveClientCheckout(process.env, process.cwd(), resolve(root, "../plurnk"));
const terminalRequire = createRequire(join(terminalRoot, "package.json"));
let spawnPty;
try {
    ({ spawn: spawnPty } = terminalRequire("node-pty"));
} catch (cause) {
    throw new Error(
        `client conformance needs an installed terminal client checkout: ${terminalRoot}. Run npm ci there, or set PLURNK_CLIENT_CHECKOUT to another installed checkout.`,
        { cause },
    );
}
process.stdout.write(`client conformance: ${terminalRoot}\n`);
// A failed run preserves its tree for the diagnosis that follows (see the finally block); the
// next run reaps every preserved tree older than an hour, long past any live run's start, so
// evidence never outlives its usefulness: fifteen preserved failures (~0.5 GB each) filled a
// 16 GB tmpfs on 2026-09-08 and broke the drill with ENOSPC.
const STALE_EVIDENCE_MS = 60 * 60 * 1000;
for (const entry of await readdir(tmpdir())) {
    if (!entry.startsWith("plurnk-cross-client-")) continue;
    const preserved = join(tmpdir(), entry);
    if (Date.now() - (await stat(preserved)).mtimeMs < STALE_EVIDENCE_MS) continue;
    await rm(preserved, { recursive: true, force: true });
    process.stderr.write(`cross-client conformance reaped stale evidence at ${preserved}\n`);
}
const temp = await mkdtemp(join(tmpdir(), "plurnk-cross-client-"));
const install = join(temp, "consumer");
const terminalStage = join(temp, "terminal");
const home = join(temp, "home");

// {§agui-http-authorization} — a fresh install mints its own bearer into the operator file, so
// every client presents it. The real client reads it through its own env cascade; this harness
// drives BridgeTransport directly, so it reads the same file the daemon just seeded.
const seededToken = async () => {
    const file = join(home, ".config", "plurnk", ".env");
    const text = await readFile(file, "utf8").catch(() => "");
    return /^PLURNK_AGUI_TOKEN=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
};
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
    ]);
    await run("npm", ["init", "-y"], { cwd: install });
    const serviceSpecs = await pack(root, ["--workspaces"]);
    // The consumer installs the projected tarballs (#797), the same bytes a release publishes.
    for (const archive of serviceSpecs) await projectTarball(archive);
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
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", clientSpec, ...serviceSpecs], {
        cwd: install,
        maxBuffer: 128 * 1024 * 1024,
    });
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
        PLURNK_SERVICE_MAX_TURNS: "8",
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
        PLURNK_MCP_ENABLED: "[]",
        ...fixture.env,
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
        "--worker", "Cli_Worker",
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
        || JSON.stringify(modelOps) !== JSON.stringify(["KILL"])) {
        throw new Error(`installed CLI returned the wrong semantic record\n${cli.stdout}`);
    }
    process.stdout.write("installed one-shot CLI journey GREEN: world + Turn 0 + delivered response + observed completion\n");

    tui = spawnInstalledTui(clientBin, [
        "--workspace", "installed-tui",
        "--worker", "Tui_Worker",
        "--project-root", "",
        "--model", "journey",
        "--max-turns", "2",
    ], clientEnv);
    await tui.waitFor(/workspace: installed-tui/);
    tui.write("/mcp\r");
    await tui.waitFor(/MCP servers: none/);
    tui.write("/skills\r");
    await tui.waitFor(/plurnk\s+active\s+service/);
    tui.write("/a2a\r");
    await tui.waitFor(/A2A agents: none/);
    tui.write("Exercise the installed interactive terminal.\r");
    await tui.waitFor(/The installed interactive journey is complete\./);
    // The status row settles on the session's summary line: elapsed time, the concluded
    // accounting and the gauge's model. With no live children ({§agui-status-children}),
    // the client omits the ant. Since plurnk#58 the lifecycle glyph stands alone — the word
    // repeated it — and the place (workspace, loop, turn, worker) is the prompt prefix's,
    // asserted separately below.
    // The client renders a chosen effort as `alias[low]` and a seeded default as `alias(low)` (plurnk SPEC, identity effort).
    await tui.waitFor(/⏹️  · \d+ms · ↓800 ↑160 · 🎲 journey(?:[[(]adaptive[\])])?/);   // two spaces after the glyph (plurnk#67)
    // {plurnk#58} — the prompt prefix names the place: [workspace/~worker(loop/turn)].
    await tui.waitFor(/\[installed-tui\/[\s\S]{0,80}?~Tui_Worker(?:\(\d+\/\d+\))?\]/);
    const tuiOutput = tui.output();
    if (tuiOutput.includes("🐜")) throw new Error(`installed TUI displayed a child indicator with no live children\n${tuiOutput}`);
    if (tuiOutput.includes("problem:")) throw new Error(`installed TUI displayed an unexpected Problem\n${tuiOutput}`);
    assertIncludes(tuiOutput, "I will complete the request through the interactive terminal.", "installed TUI reasoning");
    assertIncludes(tuiOutput, "Confirm the packed interactive terminal path.", "installed TUI NOTE aside");
    assertIncludes(tuiOutput, "The installed interactive journey is complete.", "installed TUI KILL answer");
    await tui.exit();
    tui = undefined;
    process.stdout.write("installed interactive TUI journey GREEN: Functionality + message READ + reasoning + NOTE + KILL + status\n");

    tui = spawnInstalledTui(clientBin, [
        "--workspace", "installed-rejected",
        "--worker", "rejected-worker",
        "--project-root", "",
        "--model", "journey",
    ], clientEnv);
    await tui.waitFor(/workspace: installed-rejected/);
    tui.write("Exercise the rejected provider request.\r");
    await tui.waitFor(/The requested model is unavailable; select an available model\./);
    // {plurnk#58} — the glyph is the lifecycle and the turn count left the status line.
    await tui.waitFor(/❌  · \d/);
    tui.write("/workers\r");
    await tui.waitFor(/rejected-worker[^\n]*← bound[\s\S]*❌  · \d/);
    if (tui.output().includes("Strike threshold") || tui.output().includes("⏹️")) {
        throw new Error(`installed TUI lost the provider failure\n${tui.output()}`);
    }
    await tui.exit();
    tui = undefined;
    if (fixture.requests.filter(({ journey }) => journey === "rejected").length !== 1) {
        throw new Error("a rejected provider request consumed more than one inference attempt");
    }
    process.stdout.write("installed rejected-request journey GREEN: one attempt + exact cause + failed status after inspection\n");

    fixture.assertComplete();

    const { BridgeTransport } = await import(pathToFileURL(join(
        install, "node_modules", "@plurnk", "plurnk", "dist", "transport.js",
    )).href);
    const bridgeToken = await seededToken();
    const terminal = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}`, token: bridgeToken },
        world,
        { workspace: world },
    );
    const durableCapabilities = { deny: [{ traits: ["interaction"] }] };
    await terminal.rpc("workspace.capabilities.set", { policy: durableCapabilities });

    const discovery = await terminal.rpc("discover");
    const manifest = JSON.parse(await readFile(join(terminalRoot, "conformance/agui-client.json"), "utf8"));
    const problems = [
        drift("actions", Object.keys(manifest.actions).toSorted(), Object.keys(discovery.actions).toSorted()),
        drift("notifications", Object.keys(manifest.notifications).toSorted(), Object.keys(discovery.notifications).toSorted()),
    ].filter((problem) => problem !== null);
    if (problems.length > 0) {
        throw new Error(`plurnk conformance manifest drifted from live discovery — ${problems.join(" · ")}`);
    }
    process.stdout.write(`plurnk conformance manifest matches live discovery (${Object.keys(discovery.actions).length} actions, ${Object.keys(discovery.notifications).length} notifications)\n`);

    const overlay = {
        "PLURNK_MCP_CLIENT-ONLY": process.execPath,
        "PLURNK_MCP_CLIENT-ONLY_ARGS": JSON.stringify([
            join(root, "plurnk-mcp/src/fixtures/echo-server.mjs"),
        ]),
    };
    const projected = await terminal.rpc("workspace.mcp.discover", { configuration: overlay });
    if (!projected.candidates.some((candidate) => candidate.alias === "client-only"
        && candidate.provenance.kind === "client-configuration")) {
        throw new Error("terminal client did not project its configuration as MCP candidates");
    }
    const durable = await terminal.rpc("workspace.mcp.list");
    if (durable.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate entered the workspace's durable set");
    }
    for (const family of ["skills", "a2a"]) {
        const listed = await terminal.rpc(`workspace.${family}.list`);
        if (!Array.isArray(listed.definitions)) {
            throw new Error(`workspace.${family}.list returned no Functionality definitions`);
        }
    }

    const observer = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}`, token: bridgeToken },
        "independent-observer",
        { workspace: world },
    );
    const observedCapabilities = await observer.rpc("workspace.capabilities.get");
    if (JSON.stringify(observedCapabilities.workspace) !== JSON.stringify(durableCapabilities)) {
        throw new Error("a second client connection did not observe the workspace's durable capabilities");
    }
    const observedMcp = await observer.rpc("workspace.mcp.list");
    if (observedMcp.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a terminal-discovered candidate leaked into another connection's durable set");
    }
    await observer.rpc("workspace.members.add", { alias: "cross", definition: { glob: "cross/**" } });
    // Both connections observe the same workspace definition independently of their Worker.
    const membersOf = (listed) => (listed.definitions ?? [])
        .filter((definition) => definition.alias === "cross")
        .map(({ alias, origin, state, definition }) => ({ alias, origin, state, glob: definition?.glob }));
    const expectedMembers = [{ alias: "cross", origin: "workspace", state: "active", glob: "cross/**" }];
    const members = await terminal.rpc("workspace.members.list");
    if (JSON.stringify(membersOf(members)) !== JSON.stringify(expectedMembers)) {
        throw new Error(`terminal did not observe the other connection's durable mutation: ${JSON.stringify(members)}`);
    }

    await stop(daemon);
    daemon = await boot();
    const afterRestart = new BridgeTransport(
        { bridgeUrl: `http://127.0.0.1:${port}`, token: bridgeToken },
        world,
        { workspace: world },
    );
    const persistedCapabilities = await afterRestart.rpc("workspace.capabilities.get");
    const persistedMembers = await afterRestart.rpc("workspace.members.list");
    if (JSON.stringify(persistedCapabilities.workspace) !== JSON.stringify(durableCapabilities)
        || JSON.stringify(membersOf(persistedMembers)) !== JSON.stringify(expectedMembers)) {
        throw new Error("cross-client durable state did not survive daemon reconstruction");
    }
    const afterRestartMcp = await afterRestart.rpc("workspace.mcp.list");
    if (afterRestartMcp.definitions.some((definition) => definition.alias === "client-only")) {
        throw new Error("a discovered client candidate survived daemon reconstruction as durable state");
    }
    process.stdout.write("client composition GREEN: one packed platform, CLI and TUI, success and failure journeys, shared durable state\n");
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
