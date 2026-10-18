// {§agui-first-party-client-conformance} — pack the platform and terminal
// client into an empty consumer, then exercise the installed one-shot CLI,
// and interactive TUI against one daemon release. The shared
// conformance corpus owns protocol semantics; this gate owns composed product
// paths and host-native behavior.
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { projectTarball } from "./lib/package-projection.mjs";
import { packRecords } from "./lib/npm-json.mjs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import SqlRite from "@possumtech/sqlrite";
import { startClientJourneyModel } from "./fixtures/client-journey-model.mjs";
import Launch from "@plurnk/plurnk-service/launch";
import { resolveClientCheckout } from "./lib/project-topology.mjs";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run test:client-conformance
Packs the platform and the terminal client into an empty consumer and exercises the installed one-shot CLI and interactive TUI against one daemon ({§agui-first-party-client-conformance}).
Reads: PLURNK_CLIENT_CHECKOUT (default ../plurnk) and this checkout's packed packages.
Writes: a sandbox under the test artifact home; exit 1 on a failed journey.
`);

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
const project = join(temp, "project");

// {§credential-authority} {§agui-oauth-clients} — the daemon under test authenticates (the shipped
// PLURNK_AUTH=1) with a configured operator secret, the posture of a tool on another host or under
// another user: every client exchanges it for access tokens through its own env cascade, and this
// harness drives AguiTransport directly with the same value.
const operatorSecret = randomBytes(32).toString("base64url");
const seededToken = async () => operatorSecret;
const workspace = "cross-client-conformance";

const freePort = () => new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => accept(address.port));
    });
});

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
    const packed = packRecords((await run("npm", [
        "pack", ...args, "--ignore-scripts", "--json", "--pack-destination", temp,
    ], { cwd, maxBuffer: 128 * 1024 * 1024 })).stdout);
    return packed.map(({ filename }) => join(temp, filename));
};

// A sentence the terminal may have wrapped anywhere between its words.
const wrapped = (sentence) => new RegExp(sentence.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s\\S]*?"), "u");

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
const closeFailure = Promise.withResolvers();
const closeFailureMessage = "installed-journey durable close unavailable";

try {
    await run("npm", ["run", "build"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    await Promise.all([
        mkdir(install, { recursive: true }),
        mkdir(terminalStage, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(project, { recursive: true }),
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
        PLURNK_SECRET: operatorSecret,
        PLURNK_SERVICE_DB_PATH: db,
        PLURNK_SERVICE_MAX_TURNS: "8",
        PLURNK_MCP_sourcecheck: JSON.stringify({ name: "sourcecheck", type: "stdio", command: "node" }),
        PLURNK_MCP_sourcecheck_ENABLED: "0",
        ...fixture.env,
    };
    // {§daemon-launch} — the installed executable through the service's own launcher; the port is
    // the one the fixture chose, so the readiness line must name it.
    const boot = async (overrides = {}) => {
        daemonOutput = { stdout: "", stderr: "" };
        const launched = await Launch.start({
            command: [daemonBin, "start"], cwd: install, env: { ...daemonEnv, ...overrides },
            readyTimeoutMs: 30_000, stopGraceMs: 5_000,
            onOutput: (stream, chunk) => {
                daemonOutput[stream] += chunk;
                if (daemonOutput.stderr.includes(closeFailureMessage)) closeFailure.resolve();
            },
        }).catch((error) => {
            daemonOutput = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
            throw new Error(`installed service ${error.kind}: ${error.message}`, { cause: error });
        });
        if (launched.port !== port) throw new Error(`installed service published port ${launched.port}, expected ${port}`);
        return launched;
    };
    daemon = await boot();

    const clientEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: String(port),
        PLURNK_AGUI_URL: "",
        PLURNK_SECRET: operatorSecret,
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
        || JSON.stringify(modelOps) !== JSON.stringify(["SEND"])) {
        throw new Error(`installed CLI returned the wrong semantic record\n${cli.stdout}`);
    }
    process.stdout.write("installed one-shot CLI journey GREEN: workspace + Turn 0 + delivered response + observed completion\n");
    // {§file-publication} {§file-snapshot-revision}: real packed code, SQLite and disk, with client acceptance.
    const files = await runClient(clientBin, [
        "--json", "--yolo", "--workspace", "installed-files", "--worker", "File_Worker",
        "--project-root", project, "--model", "journey", "--max-turns", "4", "--timeout", "20",
        "Exercise installed file publication and persistence.",
    ], { cwd: project, env: clientEnv, timeout: 30_000 });
    const fileRecord = JSON.parse(files.stdout);
    const fileOps = fileRecord.turns?.flatMap(({ ops }) => ops).filter(({ origin }) => origin === "model").map(({ op }) => op);
    if (fileRecord.finalStatus !== 200 || fileRecord.response !== "The installed file journey is complete."
        || JSON.stringify(fileOps) !== JSON.stringify(["EDIT", "EDIT", "SEND"])
        || await readFile(join(project, "integrity.txt"), "utf8") !== "after") {
        throw new Error(`installed file publication failed\n${files.stdout}\n${files.stderr}`);
    }
    const inspected = await runClient(process.execPath, [clientBin, "--workspace", "installed-cli", "mcp"], {
        cwd: install, env: clientEnv, timeout: 30_000,
    });
    if (!/sourcecheck\s+disabled\s+stdio\s+node\s+source=PLURNK_MCP_sourcecheck/u.test(inspected.stdout)) {
        throw new Error(`installed CLI did not render the winning configuration input: ${inspected.stdout}`);
    }

    tui = spawnInstalledTui(clientBin, [
        "--workspace", "installed-tui",
        "--worker", "Tui_Worker",
        "--project-root", "",
        "--model", "journey",
        "--max-turns", "2",
    ], clientEnv);
    await tui.waitFor(/workspace: installed-tui/);
    tui.write("/mcp\r");
    await tui.waitFor(/sourcecheck\s+disabled\s+stdio\s+node/);
    await tui.waitFor(/source=PLURNK_MCP_sourcecheck/);
    tui.write("/skills\r");
    await tui.waitFor(/plurnk\s+dormant/);
    tui.write("/a2a\r");
    await tui.waitFor(/A2A agents: none/);
    tui.write("Exercise the installed interactive terminal.\r");
    await tui.waitFor(/The installed interactive journey is complete\./);
    // The status row settles on the session's summary line: elapsed time, the concluded
    // accounting and the gauge's model. With no live children ({§agui-status-children}),
    // the client omits the ant. The lifecycle glyph stands alone, and the place (workspace,
    // loop, turn, worker) is the prompt prefix's, asserted separately below.
    // The client renders a chosen effort as `alias[low]` and a seeded default as `alias(low)` (plurnk SPEC, identity effort).
    await tui.waitFor(/⏹️  · 🎲 journey(?:[[(]adaptive[\])])? · \d+ms · ↓800 ↑160/);   // two spaces after the glyph; the model leads
    // The prompt prefix names the place: [workspace/~worker(loop/turn)].
    await tui.waitFor(/\[installed-tui\/[\s\S]{0,80}?~Tui_Worker(?:\(\d+\/\d+\))?\]/);
    const tuiOutput = tui.output();
    if (tuiOutput.includes("🐜")) throw new Error(`installed TUI displayed a child indicator with no live children\n${tuiOutput}`);
    if (tuiOutput.includes("problem:")) throw new Error(`installed TUI displayed an unexpected Problem\n${tuiOutput}`);
    assertIncludes(tuiOutput, "I will complete the request through the interactive terminal.", "installed TUI reasoning");
    assertIncludes(tuiOutput, "Confirm the packed interactive terminal path.", "installed TUI NOTE aside");
    assertIncludes(tuiOutput, "The installed interactive journey is complete.", "installed TUI completion reply");
    tui.write("/skills\r");
    await tui.waitFor(/plurnk\s+active/);
    await tui.exit();
    tui = undefined;
    process.stdout.write("installed interactive TUI journey GREEN: Functionality + message/indexed READ + references + reasoning + NOTE + SEND + status\n");

    tui = spawnInstalledTui(clientBin, [
        "--workspace", "installed-rejected",
        "--worker", "rejected-worker",
        "--project-root", "",
        "--model", "journey",
    ], clientEnv);
    await tui.waitFor(/workspace: installed-rejected/);
    tui.write("Exercise the rejected provider request.\r");
    // The Problem rides the alert's title line; at this width the terminal wraps it at a
    // word boundary that moves with the title, and the renderer may repaint between the rows.
    await tui.waitFor(wrapped("The requested model is unavailable; select an available model."));
    // The glyph is the lifecycle; the status line carries no turn count.
    await tui.waitFor(/❌  · 🎲 journey(?:[[(]adaptive[\])])? · \d/);
    tui.write("/workers\r");
    await tui.waitFor(/rejected-worker[^\n]*← bound[\s\S]*❌  · 🎲 journey(?:[[(]adaptive[\])])? · \d/);
    if (tui.output().includes("Strike threshold") || tui.output().includes("⏹️")) {
        throw new Error(`installed TUI lost the provider failure\n${tui.output()}`);
    }
    await tui.exit();
    tui = undefined;
    if (fixture.requests.filter(({ journey }) => journey === "rejected").length !== 1) {
        throw new Error("a rejected provider request consumed more than one inference attempt");
    }
    process.stdout.write("installed rejected-request journey GREEN: one attempt + exact cause + failed status after inspection\n");

    const { AguiTransport } = await import(pathToFileURL(join(
        install, "node_modules", "@plurnk", "plurnk", "dist", "transport.js",
    )).href);
    const { actionViaAgui } = await import(pathToFileURL(join(
        install, "node_modules", "@plurnk", "plurnk", "dist", "agui.js",
    )).href);
    // {§agui-oauth-clients} — the installed client exchanges the operator's secret for its access tokens.
    const { default: Credential } = await import(pathToFileURL(join(
        install, "node_modules", "@plurnk", "plurnk", "dist", "credential.js",
    )).href);
    const aguiToken = await seededToken();
    const credential = () => ({ aguiUrl: `http://127.0.0.1:${port}/agui`, credential: new Credential(aguiToken) });
    // One access token for a raw request, minted the way the client mints its own.
    const bearer = async () => (await new Credential(aguiToken).headers(`http://127.0.0.1:${port}/agui`)).authorization;

    // {§subscription-finalization}: a real failed SQLite commit, with no production fault-injection seam.
    const faultDb = await SqlRite.open({ path: db, dir: join(root, "plurnk-core/test/conformance") });
    try {
        await faultDb.test_fail_stream_close();
        tui = spawnInstalledTui(clientBin, [
            "--workspace", "installed-recovery", "--worker", "Recovery_Worker",
            "--project-root", "", "--model", "journey", "--max-turns", "4", "--yolo",
        ], clientEnv);
        await tui.waitFor(/workspace: installed-recovery/);
        tui.write("Exercise the failed stream finalization.\r");
        const failureDeadline = setTimeout(() => closeFailure.reject(new Error("stream close did not reach the injected SQLite failure")), 10_000);
        try { await closeFailure.promise; } finally { clearTimeout(failureDeadline); }
        await tui.waitFor(/updates in /);
        const state = await faultDb.test_stream_recovery_state.get({});
        if (state?.closed_at !== null || state.close_status !== null || state.loop_status !== 202) {
            throw new Error(`failed close lost its live obligation or parked loop: ${JSON.stringify(state)}`);
        }
        const recoveryWorkspace = await actionViaAgui(credential(), {
            threadId: "bootstrap", kind: "workspace.attach", params: { name: "installed-recovery" },
        });
        const retained = await new AguiTransport(credential(), { workspaceId: recoveryWorkspace.id, worker: "Recovery_Worker" })
            .rpc("entry.read", { target: `sh://${state.pathname}` });
        if (retained.status !== 200
            || !Object.values(retained.entry?.channels ?? {}).some(({ content }) => String(content).includes("retained-stream-output"))) {
            throw new Error(`the failed close lost the stream's retained output: ${JSON.stringify(retained)}`);
        }
        if (fixture.requests.filter(({ journey }) => journey === "recovery").length !== 1) {
            throw new Error("reading the retained output ran inference");
        }
        tui.write("Please keep observing the unresolved stream.\r");
        await tui.waitFor(/Follow-up accepted while parked\./);
        tui.write("/workers\r");
        await tui.waitFor(/Recovery_Worker[^\n]*← bound/);
        await faultDb.test_restore_stream_close();
        tui.write("/stop\r");
        await tui.waitFor(/cancelled|final 499/);
        // {§subscription-finalization} Cancellation retries the failed close; the loop's terminal does not wait for it.
        let settled = await faultDb.test_stream_recovery_state.get({});
        for (const deadline = Date.now() + 10_000; settled?.closed_at === null && Date.now() < deadline;) {
            await delay(50);
            settled = await faultDb.test_stream_recovery_state.get({});
        }
        if (settled?.close_status !== 200 || JSON.parse(settled.close_result).status !== 200) {
            throw new Error(`cancellation did not retain the finished producer's real outcome: ${JSON.stringify(settled)}`);
        }
        if (settled.loop_status !== 499) throw new Error(`client cancellation did not terminate the parked loop: ${JSON.stringify(settled)}`);
        await tui.exit();
        tui = undefined;
    } finally {
        await faultDb.test_restore_stream_close();
        await faultDb.close();
    }
    process.stdout.write("installed failed-finalization journey GREEN: honest park + retained output + new input + cancellation + retained outcome\n");

    fixture.assertComplete();

    const sharedWorkspace = await actionViaAgui(credential(), {
        threadId: "bootstrap", kind: "workspace.create", params: { name: workspace },
    });
    const binding = { workspaceId: sharedWorkspace.id, worker: "user" };
    const terminal = new AguiTransport(credential(), binding);
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

    for (const family of ["mcp", "skills", "a2a"]) {
        const listed = await terminal.rpc(`workspace.${family}.list`);
        if (!Array.isArray(listed.definitions)) {
            throw new Error(`workspace.${family}.list returned no Functionality definitions`);
        }
        if (family === "mcp") {
            const server = listed.definitions.find(({ alias }) => alias === "sourcecheck");
            if (server?.origin !== "service" || server.state !== "disabled"
                || server.provenance?.kind !== "environment" || server.provenance.source !== "PLURNK_MCP_sourcecheck") {
                throw new Error(`the configured server lost its source, ownership, or disabled state: ${JSON.stringify(server)}`);
            }
        }
        if (family === "skills") {
            const skill = listed.definitions.find(({ alias }) => alias === "plurnk");
            if (skill?.origin !== "service" || skill.definition?.name !== "plurnk" || "scope" in skill.definition) {
                throw new Error(`the provided skill lost its service origin or acquired an installation scope: ${JSON.stringify(skill)}`);
            }
        }
    }

    const observer = new AguiTransport(
        credential(),
        { workspaceId: sharedWorkspace.id, worker: "independent-observer" },
    );
    const observedCapabilities = await observer.rpc("workspace.capabilities.get");
    if (JSON.stringify(observedCapabilities.workspace) !== JSON.stringify(durableCapabilities)) {
        throw new Error("a second client connection did not observe the workspace's durable capabilities");
    }
    await observer.rpc("workspace.members.add", { files: ["cross/**"] });
    // Both connections observe the same workspace definition independently of their Worker.
    const membersOf = (listed) => (listed.definitions ?? [])
        .filter((definition) => definition.alias === "cross/**")
        .map(({ alias, origin, state, definition }) => ({ alias, origin, state, glob: definition?.glob }));
    const expectedMembers = [{ alias: "cross/**", origin: "workspace", state: "active", glob: "cross/**" }];
    const members = await terminal.rpc("workspace.members.list");
    if (JSON.stringify(membersOf(members)) !== JSON.stringify(expectedMembers)) {
        throw new Error(`terminal did not observe the other connection's durable mutation: ${JSON.stringify(members)}`);
    }

    await daemon.stop();
    daemon = await boot();
    // The read takes the perspective of the worker the CLI journey created ({§agui-action-binding}).
    const persistedFiles = new AguiTransport(
        credential(),
        { workspaceId: fileRecord.workspace.id, worker: "File_Worker" },
    );
    const persistedFile = await persistedFiles.rpc("entry.read", { target: pathToFileURL(join(project, "integrity.txt")).href });
    if (persistedFile.status !== 200 || persistedFile.entry?.channels.body?.content !== "after"
        || await readFile(join(project, "integrity.txt"), "utf8") !== "after") {
        throw new Error(`installed file projection did not survive reconstruction: ${JSON.stringify(persistedFile)}`);
    }
    process.stdout.write("installed file journey GREEN: create, replace, accept, reopen and READ agree with disk\n");
    const afterRestart = new AguiTransport(
        credential(),
        binding,
    );
    const persistedCapabilities = await afterRestart.rpc("workspace.capabilities.get");
    const persistedMembers = await afterRestart.rpc("workspace.members.list");
    if (JSON.stringify(persistedCapabilities.workspace) !== JSON.stringify(durableCapabilities)
        || JSON.stringify(membersOf(persistedMembers)) !== JSON.stringify(expectedMembers.map((definition) => ({ ...definition, state: "dormant" })))) {
        throw new Error("cross-client durable state did not survive daemon reconstruction");
    }
    await afterRestart.rpc("workspace.members.enable", { file: "cross/**" });
    const activatedMembers = await afterRestart.rpc("workspace.members.list");
    if (JSON.stringify(membersOf(activatedMembers)) !== JSON.stringify(expectedMembers)) {
        throw new Error(`persisted membership did not activate on explicit demand: ${JSON.stringify(activatedMembers)}`);
    }
    process.stdout.write("client composition GREEN: one packed platform, CLI and TUI, success and failure journeys, shared durable state\n");
    // {§crash-only-stop}: an admitted but incomplete body remains outside the module's run set.
    await daemon.stop();
    daemon = await boot({ PLURNK_SERVICE_STOP_TIMEOUT_MS: "250" });
    const unfinished = request({
        host: "127.0.0.1", port, method: "POST", path: "/agui",
        headers: { "Content-Type": "application/json", "Content-Length": "100", Expect: "100-continue", Authorization: await bearer() },
    });
    const disconnected = new Promise((accept) => unfinished.on("error", accept));
    try {
        unfinished.flushHeaders();
        await once(unfinished, "continue");
        unfinished.write("{");
        const ended = await daemon.stop();
        if (ended.code !== 1 || ended.signal !== null) throw new Error(`installed service required a supervisor kill: ${JSON.stringify(ended)}`);
        if (!daemonOutput.stderr.includes("stop deadline exceeded waiting for HTTP listener close")) {
            throw new Error("installed service did not name the unfinished cleanup phase");
        }
        if ((await disconnected).code !== "ECONNRESET") throw new Error("the unfinished request did not observe the service exit");
    } finally { unfinished.destroy(); }
    process.stdout.write("installed shutdown journey GREEN: incomplete HTTP request reports its phase and exits within the shared budget\n");
    passed = true;
} catch (cause) {
    throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}\nfixture errors:\n${(fixture?.errors ?? []).join("\n")}\nservice stdout:\n${daemonOutput.stdout}\nservice stderr:\n${daemonOutput.stderr}`,
        { cause },
    );
} finally {
    tui?.kill();
    await daemon?.stop();
    if (fixture !== undefined) await fixture.close();
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`cross-client conformance evidence preserved at ${temp}\n`);
}
