import assert from "node:assert/strict";
import test, { after, before, mock, type TestContext, describe } from "node:test";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import EnvDefaults from "../../src/core/env-defaults.ts";
import Paths from "../../src/Paths.ts";
import Dsl from "./dsl.ts";
import SeamSocket from "./_seam.ts";
import type Engine from "../../src/core/Engine.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import WorkspaceResidency from "../../src/server/WorkspaceResidency.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ApplicationPort, type HttpRouteHandler } from "@plurnk/plurnk-contracts/port";
import { type SkillTree } from "@plurnk/plurnk-agent-skills";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import { bindListener } from "./_http.ts";
import { openMigrated, insertWorkspace } from "./_db.ts";
import { type Db } from "../../src/core/Db.ts";
import { rpcProblem, HARNESS_WAIT_MS } from "./_rpc.ts";
import { Validator, type EntryReadResult, type ProblemDetails, type JsonSchema, type ApplicationOperationEvent, type ProposalProjection } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { ownSession, TEST_OWNER, serverProposals } from "./_approval.ts";
import { configuredModule } from "../../../plurnk-hooks/test/environment.ts";
import { viableWindow } from "./_provider.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { type HookEvent } from "../../../plurnk-hooks/src/EventProjection.ts";
import { namedModelSession } from "./_sessions.ts";
import { Module as AuthModule } from "@plurnk/plurnk-auth";
import { Module as AcpModule } from "@plurnk/plurnk-acp";

describe("module-contract", () => {
// {§module-contract} — the contract proven through daemon boot with a trivial module in both
// distributions: an installed package (`package.json#plurnk`) and an Agent Plugin bundle
// (`plugin.json#extensions.ai.plurnk`).












// The witness reads its own knob and stays inert without it ({§module-contract}); configured,
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
// {§module-lifecycle} — registering a package's name holds that package out of discovery.
const CLIENT_INTERFACE = "@plurnk/plurnk-acp";
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

test("{§module-contract} discovered modules in both distributions run every setup before any start, then stop before close", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/package", ACME_BUNDLE_ROUTE: "/bundle" });
    const { daemon, get, lines, stop } = await boot(t);
    await daemon.start();
    assert.equal(await get("/package"), PACKAGE);
    assert.equal(await get("/bundle"), BUNDLE);
    await stop();
    const phases = (await lines()).map((line) => line.split(" ")[1]);
    assert.deepEqual(phases, ["setup", "setup", "start", "start", "stop", "stop", "close", "close"], (await lines()).join("\n"));
});

test("{§module-contract} a discovered module's mount conflict fails boot naming both owners", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/same", ACME_BUNDLE_ROUTE: "/same" });
    const { daemon, lines } = await boot(t);
    await assert.rejects(daemon.start(), /HTTP mount '\/same' is claimed by both '(witness-bundle|@acme\/witness-package)' and '(@acme\/witness-package|witness-bundle)'/u);
    assert.deepEqual(await lines(), [], "boot fails before any module sets up");
});

test("{§module-contract} a discovered module serves its own route without a root owner", async (t) => {
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

test("{§module-contract} a daemon without a listener leaves out every module that declares mounts, and says so", async (t) => {
    environment(t, { ACME_PACKAGE_ROUTE: "/package" });
    await writeFile(trace, "");
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths, nodeModulesPath: nodeModules, provider: new Mock({ contextWindow: 32_768, responses: [] }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.equal(await readFile(trace, "utf8"), "", "a module left out never sets up");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ kind }) => kind === "module_left_out").map(({ owner, level }) => [owner, level]).toSorted(([a], [b]) => String(a).localeCompare(String(b))),
        [["module:@acme/witness-package", "info"], [`module:${CLIENT_INTERFACE}`, "info"]],
    );
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.mcp.list"), "a module without mounts still composes");
});

test("{§module-contract} an unconfigured module is inert: it claims nothing and runs nothing", async (t) => {
    environment(t, {});
    const { daemon, get, lines } = await boot(t);
    await daemon.start();
    assert.deepEqual(await lines(), []);
    assert.match(await get("/package"), /route-not-found/u, "the HTTP host answers what no module claimed");
});

test("{§module-seam-slices} a module receives the bound project and ordered input roots, independent of private state placement", async (t) => {
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

test("{§module-contract} a contained setting is the module's own notice, and the rest of the module works", async (t) => {
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

test("{§module-lifecycle} an untrusted module is skipped and reported, never imported", async (t) => {
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

// {§module-contract} — registered modules make the failure order observable.
const traced = (log: string[], name: string, fail?: "setup" | "start") => ({
    setup: () => { log.push(`${name} setup`); if (fail === "setup") throw new Error(`${name} setup failed`); },
    start: (_port: ApplicationPort) => { log.push(`${name} start`); if (fail === "start") throw new Error(`${name} start failed`); },
    stop: () => { log.push(`${name} stop`); },
    close: () => { log.push(`${name} close`); },
});

for (const phase of ["setup", "start"] as const) {
    test(`{§module-contract} a ${phase} failure fails boot; stopping releases what was tracked, the failing module included, in reverse`, async (t) => {
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
});

describe("Daemon.module-discovery", () => {
// {§module-lifecycle} — the assembled boot proof: a third-party package
// declaring `plurnk.kind: "module"` composes through the real Daemon start
// (setup → capability publication → start) and its action reaches the seam.











// A third-party module is exactly what this file composes, so it states the operator who admitted it
// ({§extension-discovery}); the shipped panel admits only `@plurnk/*`.
process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";

test("{§module-lifecycle}: a discovered third-party module composes through daemon boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-boot-"));
    const nodeModules = join(root, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    const db = await openMigrated();
    let daemon: Daemon | null = null;
    try {
        // The fixture node_modules mirrors the real one (symlinked entries keep
        // the executor/scheme siblings discoverable) plus the third-party module.
        const realModules = resolve(import.meta.dirname, "../../..", "node_modules");
        for (const entry of await readdir(realModules)) {
            await symlink(join(realModules, entry), join(nodeModules, entry), "dir");
        }
        const dir = join(nodeModules, "@acme", "boot-fixture-module");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "package.json"), JSON.stringify({
            name: "@acme/boot-fixture-module",
            type: "module",
            exports: { "./module": "./module.mjs" },
            plurnk: { kind: "module", module: "./module" },
        }));
        await writeFile(join(dir, "module.mjs"), `
export default () => ({
    setup(seam) {
        seam.registerModuleAction({
            name: "fixture.ping",
            scope: "daemon",
            residency: "none",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: {
                type: "object",
                required: ["pong"],
                additionalProperties: false,
                properties: { pong: { const: true } },
            },
            handler: async () => ({ pong: true }),
        });
    },
});
`);

        daemon = new Daemon({ db, nodeModulesPath: nodeModules });
        await daemon.start();
        const actions = daemon.listModuleActions();
        assert.ok(
            actions.some(({ name }) => name === "fixture.ping"),
            `the discovered module's action is registered: ${actions.map(({ name }) => name).join(", ")}`,
        );
        const result = await daemon.invokeModuleAction("fixture.ping", {}, { scope: "daemon" });
        assert.deepEqual(result, { pong: true });
    } finally {
        if (daemon !== null) await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-lifecycle} the documented directory plugin loads its floor, publishes its action and drains before releasing resources", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-native-boot-"));
    const paths = new HostPaths({ home: root, env: {} });
    const plugin = join(paths.globalPluginsDir, "fixture");
    const trace = join(root, "lifecycle.txt");
    const priorRoots = process.env.PLURNK_SERVICE_ROOTS;
    const priorKnob = process.env.PLURNK_NATIVE_FIXTURE;
    process.env.PLURNK_SERVICE_ROOTS = "global";
    delete process.env.PLURNK_NATIVE_FIXTURE;
    t.after(async () => {
        if (priorRoots === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = priorRoots;
        if (priorKnob === undefined) delete process.env.PLURNK_NATIVE_FIXTURE; else process.env.PLURNK_NATIVE_FIXTURE = priorKnob;
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    const guide = await readFile(join(Paths.packageRoot, "INSTALL.md"), "utf8");
    const manifest = [...guide.matchAll(/^```json\n([\s\S]*?)^```/gmu)]
        .map(([, body]) => JSON.parse(body))
        .find((value) => value.extensions?.["ai.plurnk"]?.module);
    assert.ok(manifest, "the installation guide supplies an executable native-module manifest");
    await writeFile(join(plugin, "plugin.json"), JSON.stringify(manifest));
    await writeFile(join(plugin, "ai.plurnk/.env.defaults"), "PLURNK_NATIVE_FIXTURE=from-plugin\n");
    await writeFile(join(plugin, manifest.extensions["ai.plurnk"].module), `
import { appendFile } from "node:fs/promises";
const trace = ${JSON.stringify(trace)};
export default () => ({
    setup(seam) {
        seam.registerModuleAction({
            name: "fixture.native", scope: "daemon", residency: "none",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object", required: ["value"], additionalProperties: false,
                properties: { value: { type: "string" } } },
            handler: async () => ({ value: process.env.PLURNK_NATIVE_FIXTURE }),
        });
    },
    async stop() { await appendFile(trace, "stopped\\n"); },
    async close() { await appendFile(trace, "closed\\n"); },
});
`);
    const broken = join(paths.globalPluginsDir, "broken");
    await mkdir(broken);
    await writeFile(join(broken, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "broken",
        extensions: { "ai.plurnk": { kind: "module", module: "../escape.mjs" } },
    }));
    const nodeModules = resolve(import.meta.dirname, "../../..", "node_modules");
    const collected = await EnvDefaults.collect(Paths.packageRoot, nodeModules, { hostPaths: paths });
    assert.deepEqual(collected.configurationErrors, [], "the floor collector validates panels; the module host validates its entry point");
    EnvDefaults.apply(EnvDefaults.merge(collected.files));
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths: paths, nodeModulesPath: nodeModules });
    try {
        await daemon.start();
        assert.deepEqual(await daemon.invokeModuleAction("fixture.native", {}, { scope: "daemon" }), { value: "from-plugin" });
        const notice = daemon.configurationNotices().find(({ key }) => key === join(broken, "plugin.json"));
        assert.ok(notice, "invalid native code is reported without preventing unrelated modules from loading");
    } finally {
        await daemon.stop();
        await db.close();
    }
    assert.equal(await readFile(trace, "utf8"), "stopped\nclosed\n");
});

test("{§env-knob} {§module-lifecycle} a plugin root's own copy of plurnk-meta reports its configuration error, and the daemon boots", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-copy-boot-"));
    const paths = new HostPaths({ home: root, env: {} });
    const plugin = join(paths.globalPluginsDir, "copied");
    const priorRoots = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = "global";
    t.after(async () => {
        if (priorRoots === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = priorRoots;
        await rm(root, { recursive: true, force: true });
    });
    // A published copy of the package, as the plugin root carries it: the same error, another class.
    const meta = join(plugin, "node_modules/@plurnk/plurnk-meta");
    await mkdir(meta, { recursive: true });
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    await writeFile(join(meta, "package.json"), JSON.stringify({ name: "@plurnk/plurnk-meta", version: "2.1.1", type: "module", exports: { ".": "./index.js" } }));
    await writeFile(join(meta, "index.js"), `export class ConfigurationError extends Error {
    constructor(key, message, options) { super(message, options); this.name = "ConfigurationError"; this.key = key; }
}
`);
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "copied",
        extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/plugin.js" } },
    }));
    await writeFile(join(plugin, "ai.plurnk/plugin.js"), `import { ConfigurationError } from "@plurnk/plurnk-meta";
export default () => { throw new ConfigurationError("PLURNK_COPIED_FIXTURE", "PLURNK_COPIED_FIXTURE is not a positive integer."); };
`);
    const nodeModules = resolve(import.meta.dirname, "../../..", "node_modules");
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths: paths, nodeModulesPath: nodeModules });
    try {
        await daemon.start();
        assert.ok(daemon.configurationNotices().some(({ key }) => key === "PLURNK_COPIED_FIXTURE"),
            "the module's own configuration error is its diagnostic, and the daemon boots");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("Daemon.preparation-stop", () => {
test("{§module-shutdown-order} daemon cancels admitted preparation, joins cleanup, then closes observers", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    let stopping: Promise<void> | undefined;
    daemon.registerModule({
        setup(seam) {
            for (const family of ["held", "later"]) {
                seam.registerFunctionalityAdapter({
                    family, namespaceOwner: family, summary: "Fixture capability",
                    definitionSchema: { type: "object" },
                    available: async () => [],
                    admit: async () => ({ alias: "fixture", definition: {} }),
                    prepare: async ({ signal }) => {
                        events.push(`prepare:${family}`);
                        if (family === "held") {
                            entered.resolve();
                            await new Promise<void>((res) => signal.addEventListener("abort", () => {
                                events.push("cancel"); cancelled.resolve(); res();
                            }, { once: true }));
                            await release.promise;
                            events.push("candidate-cleanup");
                            signal.throwIfAborted();
                        }
                        return { documents: [], outcomes: new Map(), snapshot: null, publish: () => undefined, commit: async () => {}, abort: async () => {} };
                    },
                    teardown: async () => { events.push(`teardown:${family}`); },
                });
            }
        },
        stop() { events.push("module-stop"); },
        close() { events.push("module-close"); },
    }, "test-preparation");
    t.after(async () => { release.resolve(); await (stopping ?? daemon.stop()); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "stop-preparation" });
    const demand = assert.rejects(daemon.activateWorkspace({ workspaceId }), { name: "AbortError" });
    await entered.promise;
    stopping = daemon.stop();
    await cancelled.promise;
    await assert.rejects(daemon.activateWorkspace({ workspaceId }), { name: "AbortError" });
    assert.equal(events.includes("module-close"), false, "observers remain open while cancelled preparation cleans up");
    release.resolve();
    await Promise.all([demand, stopping]);
    assert.equal(events.includes("prepare:later"), false, "shutdown never advances activation into another family");
    assert.ok(events.indexOf("candidate-cleanup") < events.indexOf("module-close"), JSON.stringify(events));
    assert.equal(events.filter((event) => event === "module-close").length, 1);
    assert.ok(await db.envelope_get_workspace.get({ id: workspaceId }), "durable state remains usable after shutdown settlement");
});
});

describe("Daemon.reads", () => {
// entry.read and log.read.










interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const rpcCall = (ws: SeamSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((res, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); res(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

const entryRead = (response: RpcResponse): EntryReadResult =>
    Validator.assertEntryReadResult(response.result);

// The integration harness calls the in-process seam. {§rpc}
const withDaemon = async <T>(fn: (db: Db, addr: { daemon: Daemon }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start();
    try { return await fn(db, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

const connect = (addr: { daemon: Daemon }): Promise<SeamSocket> => Promise.resolve(new SeamSocket(addr.daemon));

test("{§rpc} entry.read returns the contracts-owned client projection", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "entry-read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///france/capital", content: "Paris" });

            const r = await rpcCall(ws, 3, "entry.read", { target: "workspace:///france/capital" });
            const result = entryRead(r);
            assert.equal(result.status, 200);
            assert.ok(result.entry !== null);
            assert.equal(result.entry.target, "workspace:///france/capital");
            assert.equal(result.entry.channels.body.content, "Paris");
            assert.equal(result.entry.channels.body.contentOffset, 0);
            assert.equal(result.entry.channels.body.mimetype, "text/markdown");
            assert.equal("tags" in result.entry, false, "resource reads do not expose log classifications");
        } finally { ws.close(); }
    });
});

test("{§text-region}: entry.read channel+offset returns a suffix and full contentLength", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "entry-read-offset" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///doc", content: "Hello, World" });

            // A full read reports contentLength on every channel (the unit offset uses).
            const full = await rpcCall(ws, 3, "entry.read", { target: "workspace:///doc" });
            const fullResult = entryRead(full);
            assert.ok(fullResult.entry !== null);
            const fullCh = fullResult.entry.channels.body;
            assert.equal(fullCh.content, "Hello, World");
            assert.equal(fullCh.contentOffset, 0);
            assert.equal(fullCh.contentLength, 12);

            // Delta read: only the channel, content from the offset, full length back.
            const delta = await rpcCall(ws, 4, "entry.read", { target: "workspace:///doc", channel: "body", offset: 7 });
            const deltaResult = entryRead(delta);
            assert.equal(deltaResult.status, 200);
            assert.ok(deltaResult.entry !== null);
            assert.equal(deltaResult.entry.channels.body.content, "World", "content is the slice from the offset");
            assert.equal(deltaResult.entry.channels.body.contentOffset, 7);
            assert.equal(deltaResult.entry.channels.body.contentLength, 12, "contentLength is the full length — the next poll reads from here");
            assert.deepEqual(Object.keys(deltaResult.entry.channels), ["body"], "channel scopes the read to just that channel");

            // offset 0 → whole channel; offset past the end → caught up (empty).
            const whole = await rpcCall(ws, 5, "entry.read", { target: "workspace:///doc", channel: "body", offset: 0 });
            const wholeResult = entryRead(whole);
            assert.ok(wholeResult.entry !== null);
            assert.equal(wholeResult.entry.channels.body.content, "Hello, World");
            const past = await rpcCall(ws, 6, "entry.read", { target: "workspace:///doc", channel: "body", offset: 100 });
            const pastResult = entryRead(past);
            assert.ok(pastResult.entry !== null);
            assert.equal(pastResult.entry.channels.body.content, "");
            assert.equal(pastResult.entry.channels.body.contentOffset, 12);

            // offset without channel is a contract violation (which channel to slice?).
            const bad = await rpcCall(ws, 7, "entry.read", { target: "workspace:///doc", offset: 3 });
            const problem = rpcProblem(bad);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/entry/offset-channel-required");
            assert.equal(problem.offset, 3);
            assert.equal(problem.recovery, "Select the channel to read from the offset."); // {§operation-results}
        } finally { ws.close(); }
    });
});

test("{§rpc} entry.read returns 404 for missing entry", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "404-test" });
            const r = await rpcCall(ws, 2, "entry.read", { target: "workspace:///does-not-exist" });
            const result = entryRead(r);
            assert.equal(result.status, 404);
            assert.equal(result.entry, null);
        } finally { ws.close(); }
    });
});

test("{§operation-results} entry.read requires URL-shaped path", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "shape-test" });
            const r = await rpcCall(ws, 2, "entry.read", { target: "not-a-url" });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/entry/target-invalid");
            assert.equal(problem.target, "not-a-url");
            assert.equal(problem.recovery, "Use a scheme://path target."); // {§operation-results}
        } finally { ws.close(); }
    });
});

test("{§rpc} entry.read with fragment strips fragment (channel selection is per-op concern)", async () => {
    // entry.read returns the WHOLE entry. Channel selection via fragment is for
    // op.read where the model wants a specific channel. entry.read is the
    // omnibus surface — fragment is ignored.
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fragment-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "body content" });
            const r = await rpcCall(ws, 3, "entry.read", { target: "workspace:///x#anything" });
            if (r.result === undefined) {
                throw new Error(`entry.read failed: ${JSON.stringify(r)}`);
            }
            const result = entryRead(r);
            assert.equal(result.status, 200);
            assert.ok(result.entry !== null);
            assert.equal(result.entry.target, "workspace:///x");
            assert.ok(result.entry.channels.body !== undefined);
        } finally { ws.close(); }
    });
});

test("{§rpc} log.read returns recent entries from the attached workspace", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///a", content: "alpha" });
            await rpcCall(ws, 3, "op.edit", { target: "workspace:///b", content: "beta" });

            const r = await rpcCall(ws, 4, "log.read");
            const result = r.result as {
                status: number;
                entries: Array<{ op: string; origin: string; tx: { target?: { pathname?: string } } }>;
            };
            assert.equal(result.status, 200);
            const edits = result.entries.filter(({ op, origin }) => op === "EDIT" && origin === "client");
            assert.deepEqual(
                edits.map(({ tx }) => tx.target?.pathname),
                ["/b", "/a"],
                "the caller's recent operations are newest-first among ordinary runtime-authored history",
            );
        } finally { ws.close(); }
    });
});

test("{§rpc} log.read respects limit", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "limit-test" });
            for (let i = 0; i < 5; i++) {
                await rpcCall(ws, 10 + i, "op.edit", { target: `workspace:///e${i}`, content: `v${i}` });
            }
            const r = await rpcCall(ws, 20, "log.read", { limit: 3 });
            const result = r.result as { entries: Array<unknown> };
            assert.equal(result.entries.length, 3);
        } finally { ws.close(); }
    });
});

test("{§rpc} log.read filters by sinceId for incremental fetch", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "since-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///a", content: "first" });
            const firstFetch = await rpcCall(ws, 3, "log.read");
            const firstResult = firstFetch.result as { entries: Array<{ id: number }> };
            const lastSeenId = firstResult.entries[0].id;

            await rpcCall(ws, 4, "op.edit", { target: "workspace:///b", content: "second" });

            const incremental = await rpcCall(ws, 5, "log.read", { sinceId: lastSeenId });
            const incrementalResult = incremental.result as { entries: Array<{ id: number; tx: { op: string; target: { pathname: string } } }> };
            assert.equal(incrementalResult.entries.length, 1, "only the new entry");
            assert.equal(incrementalResult.entries[0].tx.target.pathname, "/b");
        } finally { ws.close(); }
    });
});

test("{§rpc} log.read entries have hydrated JSON columns", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "hydration-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///x", content: "body" });

            const r = await rpcCall(ws, 3, "log.read");
            const result = r.result as {
                entries: Array<{ op: string; origin: string; tx: unknown; signal: unknown; status_rx: number }>;
            };
            const entry = result.entries.find(({ op, origin }) => op === "EDIT" && origin === "client");
            assert.ok(entry !== undefined, "the client operation remains addressable among runtime-authored history");
            // tx should be an object (parsed JSON), not a string
            assert.equal(typeof entry.tx, "object");
            // an EDIT row carries no SEND status
            assert.equal(entry.signal, null);
            assert.equal(entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("{§methods}: a full L/T/S coordinate resolves the single entry's full shape", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-coord-test" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///a", content: "alpha" });
            await rpcCall(ws, 3, "op.dispatch", { statement: Dsl.parseSingleStatement("````SEND\nParis\n````") });

            // Discover the SEND entry's DISPLAY coordinate (no hardcoded ids).
            const all = (await rpcCall(ws, 4, "log.read")).result as { entries: Array<{ id: number; op: string; loop_seq: number; turn_seq: number; sequence: number; tx: unknown }> };
            const send = all.entries.find((e) => e.op === "SEND" && /Paris/.test(JSON.stringify(e.tx)));
            assert.ok(send, "the SEND entry is in the log");

            // {§methods} — one call by L/T/S returns exactly that entry, full shape.
            const r = (await rpcCall(ws, 5, "log.read", { loopSeq: send.loop_seq, turnSeq: send.turn_seq, sequence: send.sequence })).result as { status: number; entries: Array<{ id: number; op: string; tx: unknown; rx: unknown }> };
            assert.equal(r.status, 200);
            assert.equal(r.entries.length, 1, "a full coordinate resolves exactly one entry, not a list");
            assert.equal(r.entries[0].id, send.id, "the coordinate resolves the SEND entry");
            // A SEND's rx is just {status}; the model's message ('Paris') lives in tx, which
            // log.read resolves by coordinate on the server.
            assert.match(JSON.stringify(r.entries[0].tx), /Paris/, "the SEND tx body is reachable by coordinate");
        } finally { ws.close(); }
    });
});

test("{§rpc} log.read is workspace-scoped — doesn't see other workspaces' logs", async () => {
    await withDaemon(async (_db, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });

            await rpcCall(wsA, 2, "op.edit", { target: "workspace:///a", content: "from A" });
            await rpcCall(wsB, 2, "op.edit", { target: "workspace:///b", content: "from B" });

            const rA = await rpcCall(wsA, 3, "log.read");
            const rB = await rpcCall(wsB, 3, "log.read");
            const aEntries = (rA.result as {
                entries: Array<{ op: string; origin: string; tx: { target: { pathname: string } } }>;
            }).entries.filter(({ op, origin }) => op === "EDIT" && origin === "client");
            const bEntries = (rB.result as {
                entries: Array<{ op: string; origin: string; tx: { target: { pathname: string } } }>;
            }).entries.filter(({ op, origin }) => op === "EDIT" && origin === "client");

            assert.equal(aEntries.length, 1);
            assert.equal(aEntries[0].tx.target.pathname, "/a");
            assert.equal(bEntries.length, 1);
            assert.equal(bEntries[0].tx.target.pathname, "/b");
        } finally { wsA.close(); wsB.close(); }
    });
});
});

describe("WorkspaceResidency", () => {
// {§module-workspace-residency} {§module-workspace-residency} — the residency owner
// in isolation: provider registration, demand-driven activation order,
// replacement gate modes, durable state round-trips, and atomic rollback. The
// composed behavior (cooling policy, document reconciliation, coordinator
// integration) stays covered through the Daemon and Functionality specimens.










const problemOf = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof OperationFailureError, `expected an operation failure, got ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("expected the call to reject");
};

const harness = async () => {
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `residency-${crypto.randomUUID()}`);
    const calls: string[] = [];
    let rollbacks = 0;
    const engine = {
        prepareWorkspaceRuntimes: async (targetWorkspaceId: number, owner: string, normalized: unknown[]) => {
            calls.push(`prepare:${targetWorkspaceId}:${owner}:${normalized.length}`);
            return () => {
                calls.push(`commit:${targetWorkspaceId}:${owner}`);
                return () => { rollbacks += 1; };
            };
        },
        referenceEntries: async () => [],
    } as unknown as Engine;
    const workspaceGate = new WorkspaceGate(async () => false);
    const residency = new WorkspaceResidency({
        db,
        engine: () => engine,
        workspaceGate,
        normalizeRuntime: (registration) => {
            calls.push(`normalize:${registration.decl.name}`);
            return { tag: registration.decl.name, entry: {} as never, scheme: undefined };
        },
    });
    return { db, workspaceId, residency, workspaceGate, calls, rollbacks: () => rollbacks };
};

test("{§module-lifecycle} provider registration is validated and exactly-once per namespace owner", async () => {
    const { db, residency } = await harness();
    try {
        const provider = { activate: async () => {}, deactivate: async () => {} };
        assert.throws(() => residency.registerProvider("  ", provider), /non-empty namespace owner/);
        assert.throws(() => residency.registerProvider("owner", {} as never), /requires activate and deactivate/);
        residency.registerProvider("owner", provider);
        assert.throws(() => residency.registerProvider("owner", provider), /'owner' is already registered/);
    } finally {
        await db.close();
    }
});

test("{§module-workspace-residency} acquire validates the workspace, activates providers in order with a working retain, and refuses ghosts", async () => {
    const { db, workspaceId, residency, calls } = await harness();
    try {
        const order: string[] = [];
        residency.registerProvider("first", {
            activate: async (context) => {
                order.push(`first:${context.workspaceId}`);
                const release = context.retain();
                release();
            },
            deactivate: async () => { order.push("first:down"); },
        });
        residency.registerProvider("second", {
            activate: async () => { order.push("second"); },
            deactivate: async () => { order.push("second:down"); },
        });
        assert.equal((await problemOf(() => residency.acquire(workspaceId + 999))).type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-not-found");
        assert.equal((await problemOf(() => residency.identity(workspaceId + 999))).status, 404);
        const release = await residency.acquire(workspaceId);
        assert.deepEqual(order, [`first:${workspaceId}`, "second"], "providers activate in registration order with the workspace identity");
        assert.equal(residency.isActive(workspaceId), true);
        assert.deepEqual(residency.activeWorkspaceIds(), [workspaceId]);
        const again = await residency.acquire(workspaceId);
        assert.deepEqual(order.length, 2, "a second demand reuses the resident activation");
        release();
        again();
        assert.deepEqual(await residency.identity(workspaceId), { workspaceId });
        void calls;
    } finally {
        await db.close();
    }
});

test("{§module-workspace-residency} a failed provider activation deactivates what activated and surfaces the cause", async () => {
    const { db, workspaceId, residency } = await harness();
    try {
        const order: string[] = [];
        residency.registerProvider("ok", {
            activate: async () => { order.push("ok:up"); },
            deactivate: async () => { order.push("ok:down"); },
        });
        residency.registerProvider("broken", {
            activate: async () => { throw new Error("activation refused"); },
            deactivate: async () => { order.push("broken:down"); },
        });
        await assert.rejects(() => residency.acquire(workspaceId), /activation refused/);
        assert.deepEqual(order, ["ok:up", "broken:down", "ok:down"], "cleanup deactivates in reverse order");
        assert.equal(residency.isActive(workspaceId), false);
    } finally {
        await db.close();
    }
});

test("{§module-workspace-residency} activation failure unwinds while the requesting workspace turn remains held", async () => {
    const { db, workspaceId, residency, workspaceGate } = await harness();
    const held = workspaceGate.tryExclusive(workspaceId);
    assert.ok(held);
    await held.acquired;
    let deactivated = false;
    const cause = new Error("resource owner activation refused");
    residency.registerProvider("broken", {
        activate: async () => { throw cause; },
        deactivate: async () => { deactivated = true; },
    });
    const failed = assert.rejects(() => residency.acquire(workspaceId), (error) => error === cause);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            failed,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("activation cleanup waited for its requesting turn")), HARNESS_WAIT_MS); }),
        ]);
        assert.equal(deactivated, true);
        assert.equal(residency.isActive(workspaceId), false);
    } finally {
        clearTimeout(timer);
        held.release();
        await failed;
        await db.close();
    }
});

test("{§module-workspace-residency} replacement: gate modes, durable state round-trip, owner mismatch, and atomic rollback", async () => {
    const { db, workspaceId, residency, workspaceGate, calls, rollbacks } = await harness();
    try {
        const registration = (owner: string, name: string) => ({
            namespaceOwner: owner,
            decl: { name, glyph: "x", summary: "s", invocation: { body: { role: "r", required: false }, example: {} } },
            executor: {} as never,
            availability: { available: true },
        });
        // A held workspace refuses `try`, queues `wait` behind the holder, and
        // admits `none` inside the holder's own context.
        const held = workspaceGate.tryExclusive(workspaceId);
        assert.ok(held !== null);
        await held.acquired;
        const refused = await problemOf(() => residency.replace({ workspaceId, namespaceOwner: "own", state: { v: 1 }, runtimes: [] }));
        assert.equal(refused.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
        await residency.replace({ workspaceId, namespaceOwner: "own", state: { v: 1 }, runtimes: [] }, { gate: "none" });
        assert.deepEqual(await residency.readModuleState(workspaceId, "own"), { v: 1 });
        const waited = residency.replace({ workspaceId, namespaceOwner: "own", state: { v: 2 }, runtimes: [registration("own", "tag-a")] }, { gate: "wait" });
        assert.deepEqual(await residency.readModuleState(workspaceId, "own"), { v: 1 }, "a waiting replacement has not run while the gate is held");
        held.release();
        await waited;
        assert.deepEqual(await residency.readModuleState(workspaceId, "own"), { v: 2 });
        assert.ok(calls.includes("normalize:tag-a") && calls.includes(`prepare:${workspaceId}:own:1`) && calls.includes(`commit:${workspaceId}:own`), `replacement normalized, prepared, and committed: ${calls.join(",")}`);
        // Identity and ownership are exact.
        assert.equal((await problemOf(() => residency.replace({ workspaceId: workspaceId + 999, namespaceOwner: "own", state: null, runtimes: [] }))).type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-not-found");
        await assert.rejects(
            () => residency.replace({ workspaceId, namespaceOwner: "own", state: null, runtimes: [registration("other", "tag-b")] }),
            /does not match 'own'/,
        );
        // A refused publication rolls the committed runtimes and durable state back.
        const engineRefusal = residency.replace({ workspaceId, namespaceOwner: "own", state: { v: 3 }, runtimes: [] }, { gate: "none" });
        await engineRefusal;
        assert.deepEqual(await residency.readModuleState(workspaceId, "own"), { v: 3 });
        residency.publish();
        const priorRollbacks = rollbacks();
        const failing = {
            prepareWorkspaceRuntimes: async () => { throw new Error("host refused the runtime set"); },
        };
        const failingResidency = new WorkspaceResidency({
            db,
            engine: () => failing as unknown as Engine,
            workspaceGate,
            normalizeRuntime: () => ({ tag: "t", entry: {} as never, scheme: undefined }),
        });
        await assert.rejects(
            () => failingResidency.replace({ workspaceId, namespaceOwner: "own", state: { v: 4 }, runtimes: [] }),
            /host refused the runtime set/,
        );
        assert.deepEqual(await residency.readModuleState(workspaceId, "own"), { v: 3 }, "durable state is unchanged after a refused preparation");
        assert.equal(rollbacks(), priorRollbacks, "nothing was committed, so nothing rolled back");
        // state: null forgets the durable row.
        await residency.replace({ workspaceId, namespaceOwner: "own", state: null, runtimes: [] }, { gate: "none" });
        assert.equal(await residency.readModuleState(workspaceId, "own"), null);
    } finally {
        await db.close();
    }
});
});

describe("default-modules", () => {
// {§module-lifecycle} — a daemon with nothing registered composes the installed default modules
// by discovery alone, as the service does.







const VERBS = ["add", "disable", "discover", "enable", "list", "remove", "replace"];

test("{§mcp-module} {§schedule-family} a bare daemon discovers the MCP and schedule families", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const names = daemon.listModuleActions().map(({ name }) => name);
    for (const family of ["mcp", "schedule"]) {
        assert.deepEqual(
            names.filter((name) => name.startsWith(`workspace.${family}.`)).map((name) => name.slice(`workspace.${family}.`.length)).filter((verb) => VERBS.includes(verb)).toSorted(),
            VERBS,
            `the ${family} family arrives without explicit composition`,
        );
    }
});

// {§functionality-replacement} — the inputs each family declares, as its discover action
// advertises them. The test floor configures the MCP Registry, so the mcp family serves discovery.
const DISCOVERY: Readonly<Record<string, { readonly inputs: readonly string[]; readonly emptyListsAll?: true }>> = {
    "workspace.skills.discover": { inputs: ["source"] },
    "workspace.schedule.discover": { inputs: ["source"] },
    "workspace.mcp.discover": { inputs: ["query"] },
    "workspace.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
    "session.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
    "workspace.members.discover": { inputs: ["query"] },
};
const INPUTS = ["query", "source", "configuration"];

test("{§functionality-replacement} each family's discover advertises exactly the inputs it serves, and any other is refused by name", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const actions = new Map(daemon.listModuleActions().map((action) => [action.name, action]));
    assert.deepEqual([...actions.keys()].filter((name) => name.endsWith(".discover")).toSorted(), Object.keys(DISCOVERY).toSorted(),
        "every family serving discovery has its discover action, and no other has one");
    for (const [name, { inputs, emptyListsAll }] of Object.entries(DISCOVERY)) {
        const schema = actions.get(name)!.inputSchema as JsonSchema & { properties: Readonly<Record<string, unknown>> };
        assert.deepEqual(Object.keys(schema.properties).filter((key) => key !== "scope"), inputs, `${name} advertises exactly its inputs`);
        assert.equal(schema.additionalProperties, false, `${name} admits no other input`);
        const atLeastOne = inputs.length === 1 ? { required: inputs } : { anyOf: inputs.map((input) => ({ required: [input] })) };
        assert.deepEqual({ required: schema.required, anyOf: schema.anyOf }, emptyListsAll === true ? { required: undefined, anyOf: undefined } : { required: undefined, anyOf: undefined, ...atLeastOne },
            `${name} ${emptyListsAll === true ? "lists everything for a request naming no input" : "requires one of its inputs"}`);
    }
    const workspaceId = await insertWorkspace(db, `discover-advertisement-${crypto.randomUUID()}`);
    for (const [name, { inputs }] of Object.entries(DISCOVERY).filter(([action]) => action.startsWith("workspace."))) {
        for (const field of INPUTS.filter((input) => !inputs.includes(input))) {
            const error = await daemon.invokeModuleAction(name, { [field]: field === "configuration" ? {} : "x" }, { scope: "workspace", workspaceId })
                .then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof OperationFailureError, `${name} refuses ${field}: ${String(error)}`);
            const { problem } = error.result;
            assert.ok(problem !== undefined, `${name} refuses ${field} with a Problem`);
            assert.equal(problem.type, "https://problems.plurnk.xyz/functionality/arguments-invalid", `${name} refuses ${field} by the shared schema check`);
            assert.ok((problem.errors as Array<{ error: string }>).some(({ error: message }) => message.includes(`"${field}"`)), `${name}'s refusal names ${field}`);
        }
    }
});

test("{§acp-daemon-client} {§module-contract} a bare daemon with a listener discovers the client interface at /acp", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    const initRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(initRes.status, 200);
    const connId = initRes.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    t.after(() => sseAbort.abort());
    const sseRes = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "acp-connection-id": connId },
        signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "acp-connection-id": connId },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "_plurnk/action",
            params: { kind: "discover", params: {} },
        }),
    });
    assert.equal(response.status, 202);
    // {§acp-plurnk-metadata} The JSON-RPC response returns the action's result on the SSE stream.
    let rpc: { id?: number; result?: { actions?: Record<string, unknown> } } | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of sseRes.body!) {
        buf += decoder.decode(chunk, { stream: true });
        for (const frame of buf.split("\n\n")) {
            if (!frame.startsWith("data: ")) continue;
            const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: { actions?: Record<string, unknown> } };
            if (parsed.id === 1) {
                rpc = parsed;
                break;
            }
        }
        if (rpc !== undefined) break;
    }
    sseAbort.abort();
    assert.ok(rpc?.result?.actions !== undefined, "the discovered client interface answers discover");
});

test("{§mcp-module} {§module-contract} an invalid registry setting is reported and MCP management keeps working", async (t) => {
    const prior = process.env.PLURNK_MCP_REGISTRY_URL;
    process.env.PLURNK_MCP_REGISTRY_URL = "ftp://example";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_MCP_REGISTRY_URL; else process.env.PLURNK_MCP_REGISTRY_URL = prior; });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.mcp.list"), "the MCP family is registered");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ owner }) => owner === "module:@plurnk/plurnk-mcp").map(({ key }) => key),
        ["PLURNK_MCP_REGISTRY_URL"],
        "the contained setting is the module's own configuration notice",
    );
});
});

describe("hooks-lifecycle", () => {
interface TerminalEvent {
    readonly workspaceId: number;
    readonly method: string;
    readonly params: {
        readonly sessionId: number;
        readonly loopId: number;
        readonly result: { readonly status: number; readonly problem?: { readonly detail: string } };
    };
}

const captureHooks = async (t: TestContext, daemon: Daemon, selection = "Stop") => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "capture.mjs");
    const output = join(root, "events.jsonl");
    await writeFile(script, [
        'import { appendFile } from "node:fs/promises";',
        'let body = "";',
        'process.stdin.setEncoding("utf8");',
        'for await (const chunk of process.stdin) body += chunk;',
        'await appendFile(process.argv[2], body);',
    ].join("\n"));
    const failures: unknown[] = [];
    daemon.registerModule(configuredModule({
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify([script, output]),
        PLURNK_HOOKS_EVENTS: selection,
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    }, (_message, cause) => { failures.push(cause); }), "test-module");
    return {
        failures,
        events: async (): Promise<HookEvent[]> => (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    };
};

test("{§module-shutdown-order} command hooks receive real loop cancellation before observer closure", { timeout: 15_000 }, async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow(), responses: [] });
    const entered = Promise.withResolvers<void>();
    provider.generate = async ({ signal }) => {
        assert.ok(signal);
        signal.throwIfAborted();
        entered.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    const daemon = new Daemon({ db, provider });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    const hooks = await captureHooks(t, daemon);
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-lifecycle" });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait for cancellation." });
    await entered.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    const events = await hooks.events();
    assert.equal(events.length, 1, "one cancellation, one command delivery");
    assert.equal(events[0].hook_event_name, "Stop");
    assert.equal(events[0].session_id, String(sessionId));
    const terminal = events[0].plurnk as TerminalEvent;
    assert.equal(terminal.workspaceId, workspaceId);
    assert.equal(terminal.method, "loop/terminated");
    assert.equal(terminal.params.sessionId, sessionId);
    assert.equal(terminal.params.loopId, loopId);
    assert.equal(terminal.params.result.status, 499);
});

for (const outcome of ["success", "failure", "delegation"] as const) {
    test(`{§hooks-event-projection} real ${outcome} events retain their full payload and owning coordinates`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: viableWindow() * 4, responses: (outcome === "delegation" ? [
            "````WORK (session://child)\nComplete the delegated work.\n````\n\n````WAIT\nAwait the child.\n````",
            "````SEND [200]\nChild work completed.\n````",
            "````SEND [200]\nParent work completed.\n````",
        ] : ["````SEND [200]\nWork completed.\n````"]).map((response) => makeMockResponse(response)) });
        if (outcome === "failure") {
            provider.generate = async () => { throw new ProviderError("mock", "request_rejected", "Fixture request rejected."); };
        }
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        const hooks = await captureHooks(t, daemon);
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `hooks-${outcome}` });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const done = Promise.withResolvers<void>();
        const published: TerminalEvent[] = [];
        daemon.subscribeToEvents((scope, method, params) => {
            if (method !== "loop/terminated") return;
            published.push(JSON.parse(JSON.stringify({ workspaceId: scope, method, params })));
            if ((params as { sessionId: number }).sessionId === sessionId) done.resolve();
        });
        const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Exercise lifecycle notifications." });
        await done.promise;
        await daemon.stop();
        const projected = await hooks.events();
        assert.ok(projected.every((event) => event.hook_event_name === "Stop" && event.session_id === String((event.plurnk as TerminalEvent).params.sessionId)));
        const events = projected.map((event) => event.plurnk as TerminalEvent);
        assert.deepEqual(hooks.failures, []);
        assert.deepEqual(events, published, "the executable receives the same event evidence as an in-process subscriber");
        assert.equal(events.length, outcome === "delegation" ? 2 : 1);
        const parent = events.find((event) => event.params.sessionId === sessionId);
        assert.ok(parent);
        assert.equal(parent.workspaceId, workspaceId);
        assert.equal(parent.params.loopId, loopId);
        assert.equal(parent.params.result.status, outcome === "failure" ? 400 : 200);
        if (outcome === "failure") assert.equal(parent.params.result.problem?.detail, "Fixture request rejected.");
        if (outcome === "delegation") {
            const child = events.find((event) => event.params.sessionId !== sessionId);
            assert.ok(child);
            assert.equal(child.workspaceId, workspaceId);
            assert.notEqual(child.params.loopId, loopId);
            assert.equal(child.params.result.status, 200);
        }
    });
}

for (const operation of ["READ", "EDIT", "KILL"]) test(`{§notifications} tool hooks bracket ${operation} dispatch, not fan-out rows or automatic observations`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const root = await mkdtemp(join(tmpdir(), "plurnk-hook-project-"));
    const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
        makeMockResponse(`\`\`\`\`EDIT (workspace:///one.txt)\nalpha\n\`\`\`\`\n\n\`\`\`\`EDIT (workspace:///two.txt)\nbeta\n\`\`\`\`\n\n\`\`\`\`${operation} (workspace:///*.txt)${operation === "EDIT" ? " <1,-1>\nupdated" : ""}\n\`\`\`\`\n\n\`\`\`\`READ (workspace:///missing.txt)\n\`\`\`\``),
        makeMockResponse("````SEND [200]\nInspected both entries and the missing path.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
    const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse,PostToolUseFailure,Stop");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-tools", projectRoot: root });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const done = Promise.withResolvers<void>();
    daemon.subscribeToEvents((_scope, method) => { if (method === "loop/terminated") done.resolve(); });
    await daemon.runLoop({ workspaceId, sessionId, prompt: "Write and inspect the entries." });
    await done.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    const events = await hooks.events();
    const tools = events.filter(({ tool_use_id }) => tool_use_id !== undefined);
    assert.deepEqual(tools.map(({ hook_event_name, tool_name }) => [hook_event_name, tool_name]), [
        ["PreToolUse", "EDIT"], ["PostToolUse", "EDIT"],
        ["PreToolUse", "EDIT"], ["PostToolUse", "EDIT"],
        ["PreToolUse", operation], ["PostToolUse", operation],
        ["PreToolUse", "READ"], ["PostToolUseFailure", "READ"],
        ["PreToolUse", "SEND"], ["PostToolUse", "SEND"],
    ]);
    for (let index = 0; index < tools.length; index += 2) {
        const start = tools[index];
        const settled = tools[index + 1];
        assert.equal(start.tool_use_id, settled.tool_use_id);
        assert.equal(start.cwd, root);
        assert.equal(start.session_id, String(sessionId));
        assert.equal(start.plurnk.workspaceId, workspaceId);
        assert.deepEqual(start.tool_input, settled.tool_input);
        assert.equal((start.plurnk.params as ApplicationOperationEvent).phase, "started");
        assert.equal((settled.plurnk.params as ApplicationOperationEvent).phase, "settled");
        assert.deepEqual(settled.tool_response, (settled.plurnk.params as ApplicationOperationEvent).result);
        assert.equal(Object.hasOwn(settled.tool_response!, "commandsExecuted"), false, "internal dispatch counts do not enter hook payloads");
        assert.equal(Object.hasOwn(settled.tool_response!, "commandsOmitted"), false);
    }
    assert.equal(new Set(tools.filter(({ hook_event_name }) => hook_event_name === "PreToolUse").map(({ tool_use_id }) => tool_use_id)).size, 5);
    assert.equal((tools[5].tool_response as { rowsWritten: number }).rowsWritten, 2, "one post for the authored fan-out, two durable operations");
    assert.equal((tools[7].tool_response as { status: number }).status, 404);
    assert.equal(events.at(-1)!.hook_event_name, "Stop", "the terminal event follows all settled dispatches");
});

test("{§notifications} concurrent BARE starts precede inference and correlate with ordered settlement", { timeout: 20_000 }, async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
        makeMockResponse("````BARE\nFirst isolated question.\n````\n\n````BARE\nSecond isolated question.\n````"),
        makeMockResponse("````SEND [200]\nBoth calls answered.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const sequence: string[] = [];
    const generate = provider.generate.bind(provider);
    const isolated = new Mock({ contextWindow: viableWindow() * 4,
        responses: [makeRawMockResponse("First isolated answer."), makeRawMockResponse("Second isolated answer.")],
    });
    provider.generate = async (args) => {
        if (args.callKind !== "bare") return generate(args);
        sequence.push("inference");
        assert.equal(sequence.filter((item) => item === "started").length, 2, "both starts precede concurrent provider calls");
        return isolated.generate(args);
    };
    const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse");
    daemon.subscribeToEvents((_scope, method, params) => {
        if (method === "operation/event" && (params as ApplicationOperationEvent).statement.op === "BARE") sequence.push((params as ApplicationOperationEvent).phase);
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-bare" });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const done = Promise.withResolvers<void>();
    daemon.subscribeToEvents((_scope, method) => { if (method === "loop/terminated") done.resolve(); });
    await daemon.runLoop({ workspaceId, sessionId, prompt: "Run isolated questions." });
    await done.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    assert.deepEqual(sequence, ["started", "started", "inference", "inference", "settled", "settled"]);
    const events = (await hooks.events()).filter(({ tool_name }) => tool_name === "BARE");
    assert.deepEqual(events.map(({ hook_event_name }) => hook_event_name), ["PreToolUse", "PreToolUse", "PostToolUse", "PostToolUse"]);
    assert.deepEqual(events.slice(0, 2).map(({ tool_use_id }) => tool_use_id), events.slice(2).map(({ tool_use_id }) => tool_use_id));
    assert.notEqual(events[0].tool_use_id, events[1].tool_use_id);
});

for (const decision of ["accept", "reject"] as const) {
    test(`{§hooks-event-projection} a ${decision} proposal settles once; executor dispatch is not stream completion`, { timeout: 20_000 }, async (t) => {
        const db = await openMigrated();
        const root = await mkdtemp(join(tmpdir(), "plurnk-hook-exec-"));
        const release = join(root, "release");
        const command = `node -e 'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { console.log("hook-stream-finished"); clearInterval(timer); } }, 10);' '${release}'`;
        const provider = new Mock({ contextWindow: viableWindow() * 4, responses: [
            makeMockResponse(`\`\`\`\`sh\n${command}\n\`\`\`\`\n\n\`\`\`\`WAIT\nAwait the command.\n\`\`\`\``),
            makeMockResponse("````SEND [200]\nThe command settled.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
        const hooks = await captureHooks(t, daemon, "PreToolUse,PostToolUse,PostToolUseFailure,PermissionRequest,Stop");
        const proposed = Promise.withResolvers<ProposalProjection>();
        const dispatched = Promise.withResolvers<ApplicationOperationEvent>();
        const done = Promise.withResolvers<void>();
        let concluded = false;
        const operations: ApplicationOperationEvent[] = [];
        daemon.subscribeToEvents((_scope, method, params) => {
            if (method === "loop/proposal") proposed.resolve(params as ProposalProjection);
            if (method === "operation/event") {
                const event = params as ApplicationOperationEvent;
                if (!("runtime" in event.statement) || event.statement.runtime !== "sh") return;
                operations.push(event);
                if (event.phase === "settled") dispatched.resolve(event);
            }
            if (method === "stream/concluded") concluded = true;
            if (method === "loop/terminated") done.resolve();
        });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `hooks-${decision}-exec`, projectRoot: root });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await ownSession(db, workspaceId, sessionId);
        await daemon.runLoop({ workspaceId, sessionId, prompt: "Execute after review." });
        const proposal = await proposed.promise;
        assert.equal(proposal.owner, TEST_OWNER);
        assert.equal(proposal.disposition.decision, "review");
        assert.deepEqual(operations.map(({ phase }) => phase), ["started"], "a proposal is not post-tool settlement");
        await daemon.resolveProposal(proposal.logEntryId, { decision }, { workspaceId, address: TEST_OWNER });
        const settled = await dispatched.promise;
        assert.equal(settled.result?.status, decision === "accept" ? 200 : 400);
        if (decision === "reject") assert.match(settled.result?.problem?.type ?? "", /\/rejected$/);
        assert.equal(concluded, false, "post-tool dispatch must not pretend that the process has exited");
        if (decision === "accept") await writeFile(release, "ready");
        await done.promise;
        await daemon.stop();
        assert.deepEqual(hooks.failures, []);
        const events = await hooks.events();
        const tool = events.filter(({ tool_name }) => tool_name === "sh");
        assert.deepEqual(tool.map(({ hook_event_name }) => hook_event_name), ["PreToolUse", "PermissionRequest", decision === "accept" ? "PostToolUse" : "PostToolUseFailure"]);
        assert.equal(tool[0].tool_use_id, tool[2].tool_use_id);
        assert.deepEqual(tool[2].tool_response, settled.result);
        assert.equal(events.filter(({ hook_event_name }) => hook_event_name === "Stop").length, 1);
        assert.equal(concluded, decision === "accept");
    });
}

test("{§hooks-module} the discovered hooks module delivers once the operator configures it", { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-discovered-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "capture.mjs");
    const output = join(root, "events.jsonl");
    await writeFile(script, [
        'import { appendFile } from "node:fs/promises";',
        'let body = "";',
        'process.stdin.setEncoding("utf8");',
        'for await (const chunk of process.stdin) body += chunk;',
        'await appendFile(process.argv[2], body);',
    ].join("\n"));
    const settings: Record<string, string> = {
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify([script, output]),
        PLURNK_HOOKS_EVENTS: "Stop",
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    };
    const prior = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    t.after(() => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow(), responses: [] });
    const entered = Promise.withResolvers<void>();
    provider.generate = async ({ signal }) => {
        assert.ok(signal);
        entered.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    // The installed package set, where the service finds @plurnk/plurnk-hooks by its declaration.
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve(import.meta.dirname, "../../..", "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-discovered" });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait for cancellation." });
    await entered.promise;
    await daemon.stop();
    const events = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HookEvent);
    assert.deepEqual(events.map(({ hook_event_name }) => hook_event_name), ["Stop"], "exactly one module delivered: the discovered one");
    assert.equal(events[0].session_id, String(sessionId));
});
});

describe("module-mounts", () => {
// {§module-contract} — modules claim their HTTP prefixes before any module sets up; a claim has
// one owner, the root is optional, a module mounts exactly what it
// claimed, and the listener is admitted only after every module has started.









const reply = (label: string): HttpRouteHandler => (_req, res) => {
    res.writeHead(200);
    res.end(label);
};

// A module that claims `mounts` and mounts each with a handler answering its own prefix.
const serving = (mounts: readonly string[], mounted: readonly string[] = mounts, beforeMount?: () => Promise<void>) => ({
    mounts,
    start: async (port: ApplicationPort) => {
        await beforeMount?.();
        for (const prefix of mounted) port.registerHttpRoute(prefix, reply(prefix));
    },
});

const fixture = async (t: TestContext, client: Parameters<Daemon["registerModule"]>[0] = {}) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32_768, responses: [] }), http });
    // {§module-lifecycle} — registering its package's name holds the client interface out of
    // discovery, so each test composes its own client interface.
    daemon.registerModule(client, "@plurnk/plurnk-acp");
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });
    const { port } = http.httpAddress();
    const get = async (pathname: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
        return { status: response.status, body: await response.text() };
    };
    return { daemon, get, port };
};

test("{§module-contract} a prefix claimed by two modules fails boot naming both owners", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["/shared"]), "@acme/first");
    daemon.registerModule(serving(["/shared"]), "@acme/second");
    await assert.rejects(daemon.start(), /HTTP mount '\/shared' is claimed by both '@acme\/first' and '@acme\/second'/u);
});

test("{§module-contract} a daemon with a listener needs no root owner", async (t) => {
    const { daemon, get } = await fixture(t);
    daemon.registerModule(serving(["/only"]), "@acme/only");
    await daemon.start();
    assert.deepEqual(await get("/only"), { status: 200, body: "/only" });
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/missing")).status, 404);
});

test("{§acp-http-authorization} ACP serves /acp without occupying the root", async (t) => {
    const client = AcpModule.create();
    assert.deepEqual(client.mounts, ["/acp"]);
    const { daemon, get, port } = await fixture(t, client);
    await daemon.start();
    const rootResponse = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(rootResponse.status, 404);
    const problem = await rootResponse.json() as { type: string };
    assert.equal(problem.type, "https://problems.plurnk.xyz/http/route-not-found");

    const rpc = await new Promise<{ result?: { actions?: Record<string, unknown> } }>((res, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
            }));
        });
        ws.addEventListener("message", (event) => {
            const parsed = JSON.parse(String(event.data)) as { id?: number; result?: { actions?: Record<string, unknown> } };
            if (parsed.id === 0) {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "_plurnk/action",
                    params: { kind: "discover", params: {} },
                }));
            } else if (parsed.id === 1) {
                ws.close();
                res(parsed);
            }
        });
        ws.addEventListener("error", (err) => reject(err));
    });
    assert.ok(rpc.result?.actions !== undefined);
    assert.equal((await get("/")).status, 404);
});

test("{§auth-oauth} an authenticating AuthModule claims its authorization server's paths beside /acp, never the root", async (t) => {
    const auth = AuthModule.create({ auth: true });
    assert.deepEqual(auth.mounts, ["/oauth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]);
    const client = AcpModule.create();
    const { daemon, get, port } = await fixture(t, client);
    daemon.registerModule(auth, "@plurnk/plurnk-auth");
    await daemon.start();
    const metadata = await get("/.well-known/oauth-authorization-server");
    assert.equal(metadata.status, 200);
    assert.equal(JSON.parse(metadata.body).issuer, `http://127.0.0.1:${port}`, "the issuer is the address the request reached");
    assert.equal(JSON.parse((await get("/.well-known/oauth-protected-resource")).body).resource, `http://127.0.0.1:${port}`);
    assert.equal((await get("/")).status, 404);
    const acpRefused = await fetch(`http://127.0.0.1:${port}/acp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(acpRefused.status, 401);
    assert.match(acpRefused.headers.get("www-authenticate") ?? "", /^Bearer realm="plurnk", resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"$/u);
});

test("{§module-contract} an independent root module coexists with ACP", async (t) => {
    const { daemon, get } = await fixture(t, AcpModule.create());
    daemon.registerModule(serving(["/"]), "@acme/web");
    await daemon.start();
    assert.deepEqual(await get("/"), { status: 200, body: "/" });
    assert.deepEqual(await get("/page"), { status: 200, body: "/" });
    const acp = await get("/acp");
    assert.equal(acp.status, 404, "GET is not an ACP run");
    assert.equal(JSON.parse(acp.body).type, "https://problems.plurnk.xyz/acp/http/route-not-found");
});

test("{§module-contract} a declared mount that is not an absolute pathname prefix names its module", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["relative"]), "@acme/sloppy");
    await assert.rejects(daemon.start(), /module '@acme\/sloppy' declares HTTP mount 'relative', which is not an absolute pathname prefix/u);
});

test("{§module-contract} a module mounts exactly what it claimed", async (t) => {
    const unclaimed = await fixture(t);
    unclaimed.daemon.registerModule(serving(["/"], ["/", "/stray"]), "@acme/root");
    await assert.rejects(unclaimed.daemon.start(), /no module declared '\/stray' among its mounts/u);

    const unmounted = await fixture(t);
    unmounted.daemon.registerModule(serving(["/", "/promised"], ["/"]), "@acme/root");
    await assert.rejects(unmounted.daemon.start(), /module '@acme\/root' claimed HTTP mount '\/promised' but did not mount it at start/u);

    const unclaimedUpgrade = await fixture(t);
    unclaimedUpgrade.daemon.registerModule({
        mounts: ["/ws"],
        start: (port: ApplicationPort) => {
            port.registerHttpUpgrade("/ws", (_req, socket) => { socket.end(); });
            port.registerHttpUpgrade("/stray", (_req, socket) => { socket.end(); });
        },
    }, "@acme/ws");
    await assert.rejects(unclaimedUpgrade.daemon.start(), /no module declared '\/stray' among its mounts/u);
});

test("{§module-contract} the listener is admitted after every module started, whatever order they mounted in", async (t) => {
    const { daemon, get } = await fixture(t);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // The root owner registers first and mounts first; the later module's start is still running.
    daemon.registerModule(serving(["/"]), "@acme/root");
    const entered = Promise.withResolvers<void>();
    daemon.registerModule(serving(["/late"], ["/late"], () => { entered.resolve(); return gate; }), "@acme/late");
    const started = daemon.start();
    // The later module's start has begun, so the root's has mounted it.
    await entered.promise;
    assert.equal((await get("/late/x")).status, 503, "a mounted root does not admit traffic early");
    assert.equal((await get("/")).status, 503);
    release();
    await started;
    assert.equal((await get("/late/x")).body, "/late", "the later prefix is never swallowed by the root");
    assert.equal((await get("/elsewhere")).body, "/");
});
});
