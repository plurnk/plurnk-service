// {§module-contract} — the contract proven through daemon boot with a trivial module in both
// distributions: an installed package (`package.json#plurnk`) and an Agent Plugin bundle
// (`plugin.json#extensions.ai.plurnk`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before, mock, type TestContext } from "node:test";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { SkillTree } from "@plurnk/plurnk-agent-skills";
import { Mock } from "@plurnk/plurnk-providers";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";

// The witness reads its own knob and stays inert without it ({§module-self-activation}); configured,
// it claims its route, mounts it at start and traces every lifecycle member.
const witness = (owner: string, knob: string, trace: string): string => `
import { appendFile } from "node:fs/promises";
const note = (phase) => appendFile(${JSON.stringify(trace)}, ${JSON.stringify(owner)} + " " + phase + "\\n");
export default () => {
    const route = process.env.${knob};
    if (!route) return {};
    return {
        mounts: [route],
        async setup() { await note("setup"); },
        async start(port) {
            await note("start");
            port.registerHttpRoute(route, (_req, res) => { res.writeHead(200); res.end(${JSON.stringify(owner)}); });
        },
        async stop() { await note("stop"); },
        async close() { await note("close"); },
    };
};
`;

const PACKAGE = "@acme/witness-package";
// {§module-discovery} — registering a package's name holds that package out of discovery.
const CLIENT_INTERFACE = "@plurnk/plurnk-agui";
const BUNDLE = "witness-bundle";
let root = "";
let nodeModules = "";
let hostPaths: HostPaths;
let trace = "";

before(async () => {
    root = await mkdtemp(join(tmpdir(), "plurnk-module-contract-"));
    nodeModules = join(root, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    // The real node_modules, symlinked, keeps the first-party modules discoverable beside the witness.
    const real = resolve(import.meta.dirname, "../../..", "node_modules");
    for (const entry of await readdir(real)) await symlink(join(real, entry), join(nodeModules, entry), "dir");
    trace = join(root, "trace.txt");
    const pkg = join(nodeModules, "@acme", "witness-package");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: PACKAGE, type: "module", exports: { "./module": "./module.mjs" }, plurnk: { kind: "module", module: "./module" } }));
    await writeFile(join(pkg, "module.mjs"), witness(PACKAGE, "ACME_PACKAGE_ROUTE", trace));
    hostPaths = new HostPaths({ home: root, env: {} });
    const bundle = join(hostPaths.globalPluginsDir, BUNDLE);
    await mkdir(join(bundle, "ai.plurnk"), { recursive: true });
    await writeFile(join(bundle, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: BUNDLE,
        extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/module.mjs" } },
    }));
    await writeFile(join(bundle, "ai.plurnk/module.mjs"), witness(BUNDLE, "ACME_BUNDLE_ROUTE", trace));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

const environment = (t: TestContext, values: Readonly<Record<string, string | undefined>>): void => {
    const keys = ["PLURNK_SERVICE_ROOTS", "PLURNK_EXTENSIONS_TRUSTED_ONLY", "ACME_PACKAGE_ROUTE", "ACME_BUNDLE_ROUTE"];
    const prior = new Map(keys.map((key) => [key, process.env[key]]));
    t.after(() => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    for (const key of keys) {
        const value = { PLURNK_SERVICE_ROOTS: "global", PLURNK_EXTENSIONS_TRUSTED_ONLY: "0", ...values }[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
};

const boot = async (t: TestContext) => {
    await writeFile(trace, "");
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, hostPaths, nodeModulesPath: nodeModules, provider: new Mock({ contextWindow: 32_768, responses: [] }), http });
    let stopped = false;
    const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await daemon.stop();
        await http.close();
        await db.close();
    };
    t.after(stop);
    const { port } = http.httpAddress();
    const get = async (pathname: string): Promise<string> => (await fetch(`http://127.0.0.1:${port}${pathname}`)).text();
    const lines = async (): Promise<string[]> => (await readFile(trace, "utf8")).split("\n").filter(Boolean);
    return { daemon, get, lines, stop };
};

test("{§module-phases} discovered modules in both distributions run every setup before any start, then stop before close", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/package", ACME_BUNDLE_ROUTE: "/bundle" });
    const { daemon, get, lines, stop } = await boot(t);
    await daemon.start();
    assert.equal(await get("/package"), PACKAGE);
    assert.equal(await get("/bundle"), BUNDLE);
    await stop();
    const phases = (await lines()).map((line) => line.split(" ")[1]);
    assert.deepEqual(phases, ["setup", "setup", "start", "start", "stop", "stop", "close", "close"], (await lines()).join("\n"));
});

test("{§module-http-mounts} a discovered module's mount conflict fails boot naming both owners", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/same", ACME_BUNDLE_ROUTE: "/same" });
    const { daemon, lines } = await boot(t);
    await assert.rejects(daemon.start(), /HTTP mount '\/same' is claimed by both '(witness-bundle|@acme\/witness-package)' and '(@acme\/witness-package|witness-bundle)'/u);
    assert.deepEqual(await lines(), [], "boot fails before any module sets up");
});

test("{§module-http-mounts} a discovered module serves its own route without a root owner", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/package" });
    await writeFile(trace, "");
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, hostPaths, nodeModulesPath: nodeModules, provider: new Mock({ contextWindow: 32_768, responses: [] }), http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    daemon.registerModule({}, CLIENT_INTERFACE);
    await daemon.start();
    const origin = `http://127.0.0.1:${http.httpAddress().port}`;
    assert.equal(await (await fetch(`${origin}/package`)).text(), PACKAGE);
    assert.equal((await fetch(`${origin}/`)).status, 404);
});

test("{§module-http-mounts} a daemon without a listener leaves out every module that declares mounts, and says so", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/package" });
    await writeFile(trace, "");
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths, nodeModulesPath: nodeModules, provider: new Mock({ contextWindow: 32_768, responses: [] }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.equal(await readFile(trace, "utf8"), "", "a module left out never sets up");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ kind }) => kind === "module_left_out").map(({ owner, level }) => [owner, level]).toSorted(),
        [["module:@acme/witness-package", "info"], [`module:${CLIENT_INTERFACE}`, "info"]],
    );
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.mcp.list"), "a module without mounts still composes");
});

test("{§module-self-activation} an unconfigured module is inert: it claims nothing and runs nothing", async (t) => {
    environment(t, {});
    const { daemon, get, lines } = await boot(t);
    await daemon.start();
    assert.deepEqual(await lines(), []);
    assert.match(await get("/package"), /route-not-found/u, "the HTTP host answers what no module claimed");
});

test("{§module-workspace-paths} a module receives the bound project and ordered input roots, independent of private state placement", async (t) => {
    environment(t, { PLURNK_SERVICE_ROOTS: "global,project,plurnk" });
    const paths = new HostPaths({ home: root, env: {
        XDG_CONFIG_HOME: join(root, "config"),
        PLURNK_SERVICE_STATE_ROOT: join(root, "isolated"),
    } });
    const project = join(root, "project");
    await mkdir(project);
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths: paths, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    let readPaths: ((workspaceId: number) => Promise<unknown>) | undefined;
    daemon.registerModule({ setup(seam) {
        readPaths = (workspaceId) => seam.workspacePaths(workspaceId);
    } }, "@acme/paths");
    await daemon.start();
    assert.ok(readPaths, "the module received its setup seam");
    const bound = await daemon.createWorkspace({ name: "bound-paths", projectRoot: project });
    const folderless = await daemon.createWorkspace({ name: "folderless-paths" });
    const inherited = [
        { scope: "plurnk", directory: join(root, "config/plurnk") },
        { scope: "global", directory: join(root, ".agents") },
    ];
    assert.deepEqual(await readPaths(bound.workspaceId), {
        home: root, projectRoot: project,
        configurationRoots: [{ scope: "project", directory: join(project, ".agents") }, ...inherited],
    });
    assert.deepEqual(await readPaths(folderless.workspaceId), {
        home: root, projectRoot: null, configurationRoots: inherited,
    });
});

test("{§module-contained-configuration} a contained setting is the module's own notice, and the rest of the module works", async (t) => {
    environment(t, {});
    const { daemon } = await boot(t);
    let setUp = false;
    daemon.registerModule({
        contained: [{ key: "ACME_EXPOSURE", message: "ACME_EXPOSURE must be 0 or 1." }],
        setup() { setUp = true; },
    }, "@acme/contained");
    await daemon.start();
    assert.equal(setUp, true, "the part that works still sets up");
    assert.deepEqual(daemon.configurationNotices().filter(({ owner }) => owner === "module:@acme/contained"), [{
        source: "engine:configuration", kind: "configuration_unavailable", level: "warn",
        owner: "module:@acme/contained", key: "ACME_EXPOSURE", message: "ACME_EXPOSURE must be 0 or 1.",
    }]);
});

test("{§provided-skills-module-slice} host-composed references are supplied as ordinary skill trees", async (t) => {
    environment(t, {});
    const { daemon } = await boot(t);
    let readSkills: (() => Promise<ReadonlyMap<string, SkillTree>>) | undefined;
    daemon.registerModule({ setup(seam) {
        readSkills = () => seam.readProvidedSkills();
    } }, "@acme/skill-consumer");
    await daemon.start();
    assert.ok(readSkills);
    const trees = await readSkills();
    assert.deepEqual([...trees.keys()], ["plurnk"]);
    const tree = trees.get("plurnk")!;
    assert.equal(tree.document.name, "plurnk");
    assert.ok((await tree.list()).includes(".env.defaults"));
    const document = tree.resource("SKILL.md");
    assert.equal(new TextDecoder().decode(await document.read(1, (await document.size())!)), tree.document.source);
});

test("{§module-discovery} an untrusted module is skipped and reported, never imported", async (t) => {
    environment(t, { PLURNK_EXTENSIONS_TRUSTED_ONLY: "1", ACME_PACKAGE_ROUTE: "/package", ACME_BUNDLE_ROUTE: "/bundle" });
    const warn = mock.method(console, "warn", () => undefined);
    t.after(() => warn.mock.restore());
    const { daemon, lines } = await boot(t);
    await daemon.start();
    assert.deepEqual(await lines(), [], "neither distribution's code ran");
    const warned = warn.mock.calls.map(({ arguments: [message] }) => String(message));
    for (const owner of [PACKAGE, BUNDLE]) {
        assert.ok(warned.some((line) => line.includes(`'${owner}' is discovered but untrusted`)), `${owner} is reported: ${warned.join(" | ")}`);
    }
});

// {§module-failure} — registered modules make the failure order observable.
const traced = (log: string[], name: string, fail?: "setup" | "start") => ({
    setup: () => { log.push(`${name} setup`); if (fail === "setup") throw new Error(`${name} setup failed`); },
    start: (_port: ApplicationPort) => { log.push(`${name} start`); if (fail === "start") throw new Error(`${name} start failed`); },
    stop: () => { log.push(`${name} stop`); },
    close: () => { log.push(`${name} close`); },
});

for (const phase of ["setup", "start"] as const) {
    test(`{§module-failure} a ${phase} failure fails boot; stopping releases what was tracked, the failing module included, in reverse`, async (t) => {
        environment(t, {});
        const db = await openMigrated();
        const daemon = new Daemon({ db, hostPaths, nodeModulesPath: nodeModules, provider: new Mock({ contextWindow: 32_768, responses: [] }) });
        t.after(async () => { await db.close(); });
        const log: string[] = [];
        daemon.registerModule(traced(log, "first"), "@acme/first");
        daemon.registerModule(traced(log, "failing", phase), "@acme/failing");
        daemon.registerModule(traced(log, "later"), "@acme/later");
        await assert.rejects(daemon.start(), new RegExp(`failing ${phase} failed`, "u"));
        await daemon.stop();
        const expected = phase === "setup"
            ? ["first setup", "failing setup", "failing stop", "first stop", "failing close", "first close"]
            : ["first setup", "failing setup", "later setup", "first start", "failing start", "later stop", "failing stop", "first stop", "later close", "failing close", "first close"];
        assert.deepEqual(log, expected);
    });
}
