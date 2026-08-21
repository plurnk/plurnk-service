// Off-hot-path e2e: install the built package into a clean sandbox as a consumer would, then
// prove it works out of the box — the embedder ships in the default composition with no
// native install scripts, the bin boots the DB from the installed dist, the daemon listens, and a
// fresh install has no active model ({§operator-config-shipped-defaults}): the pointer surfaces instead.
// The hosted-model round-trip is a deliberate red until that endpoint is live.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import { installPacked, installSandbox, uninstallSandbox, sandbox } from "./install-sandbox.mjs";

let failures = 0;
const ok = (cond, msg) => { process.stdout.write(`  ${cond ? "✓" : "✗"} ${msg}\n`); if (!cond) failures++; };
const bin = resolve(sandbox, "node_modules", ".bin", "plurnk-service");
const isogitPackage = "@plurnk/plurnk-execs-isogit";
const sandboxHostEnv = {
    HOME: sandbox,
    XDG_CONFIG_HOME: resolve(sandbox, ".config"),
    XDG_DATA_HOME: resolve(sandbox, ".local", "share"),
    XDG_STATE_HOME: resolve(sandbox, ".local", "state"),
    XDG_CACHE_HOME: resolve(sandbox, ".cache"),
};

const installedManifest = (packageName) => JSON.parse(readFileSync(
    resolve(sandbox, "node_modules", ...packageName.split("/"), "package.json"),
    "utf8",
));

// Probe the actual packed configuration, discovery, import, and availability
// path in a fresh Node process. Running outside the monorepo prevents a
// workspace-hoisted optional package from satisfying the assertion.
const packedExecInventory = (env = {}) => {
    const childEnv = { ...process.env };
    for (const key of ["PLURNK_EXECS_ONLY", "PLURNK_EXECS_GIT", "PLURNK_EXECS_ISOGIT"]) delete childEnv[key];
    Object.assign(childEnv, { PLURNK_SERVICE_GIT_ALLOWED: "1" }, env);
    const program = `
        import { resolve } from "node:path";
        import { pathToFileURL } from "node:url";
        const serviceRoot = resolve("node_modules/@plurnk/plurnk-service");
        const nodeModules = resolve("node_modules");
        const { default: EnvDefaults } = await import(pathToFileURL(resolve(serviceRoot, "dist/core/env-defaults.js")));
        const { default: ExecutorRegistry } = await import(pathToFileURL(resolve(serviceRoot, "dist/core/ExecutorRegistry.js")));
        const { Advertise, discover } = await import(pathToFileURL(resolve(nodeModules, "@plurnk/plurnk-execs/dist/index.js")));
        const files = await EnvDefaults.collect(serviceRoot, nodeModules);
        const merged = EnvDefaults.merge(files);
        EnvDefaults.apply(merged);
        const discovery = await discover({ cwd: process.cwd() });
        const executors = await ExecutorRegistry.build({ cwd: process.cwd() });
        process.stdout.write(JSON.stringify({
            defaultValue: process.env.PLURNK_EXECS_ISOGIT ?? null,
            defaultOwner: merged.get("PLURNK_EXECS_ISOGIT")?.owner ?? null,
            disabled: discovery.disabled,
            advertise: typeof Advertise,
            owners: Object.fromEntries([...discovery.registry].map(([tag, info]) => [tag, info.packageName])),
            advertised: executors.availableRuntimes(),
        }));
    `;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
        cwd: sandbox,
        encoding: "utf8",
        env: childEnv,
    }));
};

const packedMimetypeInventory = () => {
    const program = `
        import { resolve } from "node:path";
        import { pathToFileURL } from "node:url";
        const framework = resolve("node_modules/@plurnk/plurnk-mimetypes/dist/index.js");
        const { Mimetypes, discover } = await import(pathToFileURL(framework));
        const discovery = await discover({ cwd: process.cwd(), includeTreeSitter: false });
        const mimetypes = new Mimetypes({
            discoverOptions: { cwd: process.cwd(), includeTreeSitter: false },
        });
        const json = await mimetypes.process(
            { content: '{"installed":true}', ext: ".json" },
            { channels: ["symbols"] },
        );
        const embedder = await mimetypes.embedderInfo();
        const tokenizer = await mimetypes.tokenizer("o200k", { strict: true });
        process.stdout.write(JSON.stringify({
            owners: Object.fromEntries([...discovery.handlers].map(([name, info]) => [name, info.packageName])),
            json: { ok: json.ok, mimetype: json.mimetype },
            embedder: embedder !== null,
            tokenizer: tokenizer.exact,
        }));
        await mimetypes.dispose();
    `;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
        cwd: sandbox,
        encoding: "utf8",
    }));
};

const packedPublicSurface = () => {
    const program = `
        const root = await import("@plurnk/plurnk-service");
        const digest = await import("@plurnk/plurnk-service/digest");
        process.stdout.write(JSON.stringify({
            root: Object.keys(root).sort(),
            digestDefault: typeof digest.default,
        }));
    `;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
        cwd: sandbox,
        encoding: "utf8",
    }));
};

const runBin = (args, env = {}) => {
    try {
        const stdout = execFileSync(bin, args, { cwd: sandbox, encoding: "utf8", env: { ...process.env, ...sandboxHostEnv, ...env } });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
};

const bootStart = (env = {}, probe) => new Promise((res) => {
    // Run from OUTSIDE the install dir so discovery must resolve plugins package-relative,
    // not from CWD/node_modules — the global-dogfood scenario (start from your own project).
    const childEnv = { ...process.env };
    for (const key of ["PLURNK_AGUI_TOKEN", "PLURNK_AGUI_MAX_TURNS", "PLURNK_AGUI_HEARTBEAT_MS"]) delete childEnv[key];
    Object.assign(childEnv, sandboxHostEnv, { PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" }, env);
    const child = spawn(bin, ["start"], { cwd: resolve(sandbox, ".."), env: childEnv });
    let stdout = "", stderr = "", listening = false, probeResult, probeError;
    // Resolve on EXIT (after a graceful SIGTERM) so both pipes fully drain — the
    // embedder notice rides stderr and races the stdout startup line otherwise.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (c) => {
        stdout += c;
        const address = stdout.match(/plurnk-service agui=(http:\/\/\S+)/u)?.[1];
        if (address === undefined || listening) return;
        listening = true;
        if (probe === undefined) {
            setTimeout(() => child.kill("SIGTERM"), 300);
            return;
        }
        void Promise.resolve(probe(address)).then(
            (value) => { probeResult = value; child.kill("SIGTERM"); },
            (cause) => { probeError = cause; child.kill("SIGTERM"); },
        );
    });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("exit", () => { clearTimeout(hardKill); res({ stdout, stderr, listening, probeResult, probeError }); });
    child.once("error", () => { clearTimeout(hardKill); res({ stdout, stderr, listening, probeResult, probeError, error: true }); });
});

process.stdout.write("== plurnk-service installation e2e ==\n");
process.stdout.write("-- local sandbox install --\n");
const { tarballs } = installSandbox();
ok(existsSync(bin), "plurnk-service bin linked in the sandbox");

const mods = resolve(sandbox, "node_modules");
const installedRoot = resolve(mods, "@plurnk", "plurnk-service");
const installedPackage = JSON.parse(readFileSync(resolve(installedRoot, "package.json"), "utf8"));
const buildInfo = JSON.parse(readFileSync(resolve(installedRoot, "dist", "build-info.json"), "utf8"));
const installedRequire = createRequire(resolve(installedRoot, "package.json"));
const revision = execFileSync("git", ["-C", resolve(import.meta.dirname, ".."), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", resolve(import.meta.dirname, ".."), "status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
ok(buildInfo.package === installedPackage.name, "packed build provenance names the installed package");
ok(buildInfo.version === installedPackage.version, "packed build provenance matches the installed package version");
ok(buildInfo.revision === revision, "packed build provenance matches the checkout revision");
ok(buildInfo.dirty === dirty, "packed build provenance reports checkout cleanliness");

const publicSurface = packedPublicSurface();
ok(
    JSON.stringify(publicSurface.root) === JSON.stringify([
        "Daemon",
        "Engine",
        "EnvFlags",
        "Exec",
        "File",
        "Log",
        "Mimetypes",
        "Mock",
        "Paths",
        "Prompt",
        "SchemeRegistry",
        "Skill",
    ]),
    "the packed 1.x root compatibility barrel remains frozen",
);
ok(publicSurface.digestDefault === "function", "the packed digest subpath remains importable");
ok(installedPackage.name === "@plurnk/plurnk-service", "the packed package.json subpath remains addressable");
const rootDeclarations = readFileSync(resolve(installedRoot, "dist", "index.d.ts"), "utf8");
ok(
    !/DaemonModule|ModuleActionHandler|ModuleSetupSeam|RuntimeRegistration|StartedModule/.test(rootDeclarations),
    "never-published daemon-composition types do not become root API promises",
);

const serviceDependencies = Object.keys(installedPackage.dependencies ?? {});
const defaultExecPackages = serviceDependencies.filter((name) => name.startsWith("@plurnk/plurnk-execs-"));
const defaultMimetypePackages = serviceDependencies.filter((name) => name.startsWith("@plurnk/plurnk-mimetypes-"));
const execFrameworkDependencies = Object.keys(installedManifest("@plurnk/plurnk-execs").dependencies ?? {});
const mimetypeFrameworkDependencies = Object.keys(installedManifest("@plurnk/plurnk-mimetypes").dependencies ?? {});
ok(
    !execFrameworkDependencies.some((name) => name.startsWith("@plurnk/plurnk-execs-")),
    "the executor framework contains no leaf-consumer dependency edges",
);
ok(
    !mimetypeFrameworkDependencies.some((name) => name.startsWith("@plurnk/plurnk-mimetypes-")),
    "the mimetype framework contains no leaf-consumer dependency edges",
);

const mimetypeInventory = packedMimetypeInventory();
for (const packageName of defaultMimetypePackages) {
    const manifest = installedManifest(packageName);
    for (const handler of manifest.plurnk?.handlers ?? []) {
        ok(
            mimetypeInventory.owners[handler.name] === packageName,
            `${handler.name} is discovered from the service-owned ${packageName} leaf`,
        );
    }
}
ok(
    mimetypeInventory.json.ok === true && mimetypeInventory.json.mimetype === "application/json",
    "a packed default handler loads through the composed service module graph",
);
ok(mimetypeInventory.embedder === true, "the packed default embedding artifact resolves");
ok(mimetypeInventory.tokenizer === true, "the packed default tokenizer artifact resolves exactly");

const embedderRoot = resolve(mods, "@plurnk", "plurnk-mimetypes-embeddings");
ok(existsSync(embedderRoot), "embedder ships in the default service composition");
for (const [providerPackage, provider] of [
    ["@ai-sdk/openai-compatible", "OpenAI-compatible and Cloudflare"],
    ["@ai-sdk/google", "Google"],
    ["@openrouter/ai-sdk-provider", "OpenRouter"],
    ["@ai-sdk/xai", "xAI"],
]) {
    let installed = false;
    try {
        installedRequire.resolve(providerPackage);
        installed = true;
    } catch {}
    ok(installed, `${provider} AI SDK adapter ships OOTB`);
}
ok(!existsSync(resolve(mods, "onnxruntime-node")) && !existsSync(resolve(mods, "sharp")), "native onnxruntime/sharp NOT pulled (script-free, portable)");

const help = runBin(["--help"], { PLURNK_SERVICE_DB_PATH: resolve(sandbox, "x.db"), PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" });
ok(help.code === 0 && /usage: plurnk-service/.test(help.stdout), "`--help` prints usage, exit 0");

const migratedDb = resolve(sandbox, "test.db");
const mig = runBin(["migrate"], { PLURNK_SERVICE_DB_PATH: migratedDb });
ok(mig.code === 0 && /migrated:/.test(mig.stdout), "`migrate` boots the DB from installed dist (SQL + cosine load)");

// {§digest-programmatic-surface}: exercise the package export from the clean
// consumer, not the workspace source condition. A successful run proves the
// packed dist/digest/digest.sql resolved beside Digest.js.
const packedDigestDir = resolve(sandbox, "packed-digest");
const digestFixture = new SqlRiteSync({
    path: migratedDb,
    dir: dirname(fileURLToPath(import.meta.url)),
});
try {
    const workspace = digestFixture.installation_insert_workspace.get({ name: "packed-digest-workspace" });
    const worker = digestFixture.installation_insert_worker.get({
        workspace_id: workspace.id,
        name: "packed-digest-worker",
    });
    const loop = digestFixture.installation_insert_loop.get({
        worker_id: worker.id,
        prompt: "packed-digest-prompt",
    });
    digestFixture.installation_insert_turn.run({ loop_id: loop.id });
} finally {
    digestFixture.close();
}
const packedDigestProgram = `
    import Digest from "@plurnk/plurnk-service/digest";
    Digest.run({ dbPath: ${JSON.stringify(migratedDb)}, digestDir: ${JSON.stringify(packedDigestDir)} });
`;
execFileSync(process.execPath, ["--input-type=module", "--eval", packedDigestProgram], {
    cwd: sandbox,
    encoding: "utf8",
});
const packedDigest = JSON.parse(readFileSync(resolve(packedDigestDir, "digest.json"), "utf8"));
ok(
    packedDigest.workspaces.some(({ name }) => name === "packed-digest-workspace")
        && packedDigest.workers.some(({ name }) => name === "packed-digest-worker")
        && packedDigest.loops.some(({ prompt }) => prompt === "packed-digest-prompt")
        && packedDigest.turns.length === 1,
    "the packed digest subpath resolves its SQL and writes selected forensic artifacts",
);
ok(
    !existsSync(resolve(packedDigestDir, "packet000.packet.md")),
    "the packed digest does not invent a model packet artifact for an operation turn",
);

const firstEnv = resolve(sandbox, "cascade-first.env");
const secondEnv = resolve(sandbox, "cascade-second.env");
const firstDb = resolve(sandbox, "cascade-first.db");
const secondDb = resolve(sandbox, "cascade-second.db");
writeFileSync(firstEnv, `PLURNK_SERVICE_DB_PATH=${firstDb}\n`);
writeFileSync(secondEnv, `PLURNK_SERVICE_DB_PATH=${secondDb}\n`);
const cascadeEnv = { ...process.env, HOME: sandbox };
delete cascadeEnv.PLURNK_SERVICE_DB_PATH;
const cascade = execFileSync(bin, [`--env-file=${firstEnv}`, `--env-file=${secondEnv}`, "migrate"], {
    cwd: sandbox,
    encoding: "utf8",
    env: cascadeEnv,
});
ok(cascade.includes(`migrated: ${secondDb}`), "the packed bin applies repeated env files in later-file-wins order");

// First-run bootstrap splits configuration and durable data by XDG semantics.
const home = runBin(["migrate"], {});
ok(
    existsSync(resolve(sandboxHostEnv.XDG_CONFIG_HOME, "plurnk", ".env"))
        && existsSync(resolve(sandboxHostEnv.XDG_DATA_HOME, "plurnk", "plurnk.db")),
    "first run seeds XDG configuration and homes SQLite under XDG data",
);
void home;

const configDefaults = runBin(["config", "defaults"]);
ok(
    configDefaults.code === 0
        && /Generated on demand/.test(configDefaults.stdout)
        && /@plurnk\/plurnk-service/.test(configDefaults.stdout),
    "the packed binary projects the installed owner-labelled option catalog",
);
ok(
    existsSync(resolve(mods, "@plurnk", "plurnk-meta", "skills", "find-skills", "SKILL.md")),
    "the attributed bundled find-skills asset ships inside plurnk-meta",
);

// Drive the installed daemon through its real AG-UI boundary, then inspect its
// durable address space. This composes the packed bundle, standard project
// location, workspace bootstrap, and skill materializer without a provider.
const packedSkillProject = resolve(sandbox, "packed-skill-project");
const packedSkillDir = resolve(packedSkillProject, ".agents", "skills", "inspect");
mkdirSync(packedSkillDir, { recursive: true });
writeFileSync(resolve(packedSkillDir, "SKILL.md"), [
    "---",
    "name: inspect",
    "description: Inspect a packed installation.",
    "---",
    "Use the installed product boundary.",
].join("\n"));
const packedSkillDb = resolve(sandbox, "packed-skills.db");
const skillBoot = await bootStart({ PLURNK_SERVICE_DB_PATH: packedSkillDb }, async (address) => {
    const response = await fetch(address, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            runId: "packed-skills",
            threadId: "packed-skills",
            workerId: "packed-skills",
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "workspace.create",
                        projectRoot: packedSkillProject,
                    },
                },
            },
        }),
    });
    const body = await response.text();
    if (!response.ok || !/plurnk\.action\.result/u.test(body) || !/"ok":true/u.test(body)) {
        throw new Error(`packed workspace.create failed (${response.status}): ${body}`);
    }
});
ok(
    skillBoot.listening === true && skillBoot.probeError === undefined,
    "the packed AG-UI workspace bootstrap accepts a conventional project skill without a provider",
);
const skillDb = new SqlRiteSync({ path: packedSkillDb, dir: import.meta.dirname });
const packedSkills = new Map(
    skillDb.installation_select_skills.all().map(({ pathname, content }) => [pathname, content]),
);
skillDb.close();
ok(
    packedSkills.get("/skills/inspect.md")?.includes("Inspect a packed installation.") === true,
    "the installed product materializes .agents/skills project content",
);
ok(
    packedSkills.get("/skills/find-skills.md")?.includes("# find-skills") === true,
    "the installed product materializes its bundled discovery skill",
);
ok(
    packedSkills.get("/skills/index.md")?.includes("**inspect**") === true
        && packedSkills.get("/skills/index.md")?.includes("**find-skills**") === true,
    "the installed product publishes both skills through one model-facing index",
);

const boot = await bootStart({
    PLURNK_SERVICE_DB_PATH: resolve(sandbox, "start.db"),
});
ok(boot.listening === true, "{§agui-daemon-client}: `start` boots the daemon with its AG-UI+ listener");
ok(!/embedder inactive/.test(boot.stderr), "no embedder-inactive notice — the shipped embedder is active");
// {§operator-config-shipped-defaults}: a fresh install resolves no model and names
// the available configuration paths instead.
ok(/ no model\n?$/m.test(boot.stdout) || /no model/.test(boot.stdout), "startup line reports 'no model' on an untouched install (no hosted default)");
ok(
    /no model configured/.test(boot.stderr)
        && /config defaults/.test(boot.stderr)
        && /\.config\/plurnk\/\.env/.test(boot.stderr),
    "the no-model diagnostic points to the XDG user config and complete option catalog",
);

const aguiDefaultsPath = resolve(mods, "@plurnk", "plurnk-agui", ".env.defaults");
const aguiDefaults = readFileSync(aguiDefaultsPath, "utf8");
try {
    writeFileSync(
        aguiDefaultsPath,
        aguiDefaults.replace(/^PLURNK_AGUI_HEARTBEAT_MS=.*$/m, "PLURNK_AGUI_HEARTBEAT_MS=invalid"),
    );
    const invalidAguiFloor = await bootStart({
        PLURNK_SERVICE_DB_PATH: resolve(sandbox, "invalid-agui-floor.db"),
    });
    ok(
        invalidAguiFloor.listening === false
            && /PLURNK_AGUI_HEARTBEAT_MS must be a safe integer/.test(invalidAguiFloor.stderr),
        "the packed AG-UI default reaches its owning validator before the listener binds",
    );
} finally {
    writeFileSync(aguiDefaultsPath, aguiDefaults);
}

const withheldEmbedderRoot = `${embedderRoot}.withheld`;
renameSync(embedderRoot, withheldEmbedderRoot);
const brokenComposition = await bootStart({
    PLURNK_SERVICE_DB_PATH: resolve(sandbox, "broken-composition.db"),
});
renameSync(withheldEmbedderRoot, embedderRoot);
ok(
    brokenComposition.listening === false
        && /default service composition is missing required @plurnk\/plurnk-mimetypes-embeddings/.test(brokenComposition.stderr),
    "a missing required default artifact fails as a broken service install",
);

process.stdout.write("-- optional executor lifecycle --\n");
const isogitRoot = resolve(mods, "@plurnk", "plurnk-execs-isogit");
ok(!existsSync(isogitRoot), "isogit is absent from a clean service install");
const absentIsogit = packedExecInventory({ PLURNK_EXECS_ISOGIT: "1" });
ok(absentIsogit.advertise === "function", "the packed executor framework retains its frozen 1.x Advertise export");
for (const packageName of defaultExecPackages) {
    const manifest = installedManifest(packageName);
    for (const runtime of manifest.plurnk?.runtimes ?? []) {
        ok(
            absentIsogit.owners[runtime.name] === packageName,
            `EXEC runtime ${runtime.name} is discovered from the service-owned ${packageName} leaf`,
        );
    }
}
ok(!absentIsogit.advertised.includes("isogit"), "configuration cannot advertise an executor package that is not installed");

installPacked(tarballs, isogitPackage);
ok(existsSync(resolve(isogitRoot, "package.json")), "the exact packed isogit leaf installs into the service-visible module graph");
const disabledIsogit = packedExecInventory();
ok(disabledIsogit.defaultValue === "0" && disabledIsogit.defaultOwner === isogitPackage,
    "the installed leaf uniquely owns and applies its disabled default");
ok(disabledIsogit.disabled.includes("isogit") && !disabledIsogit.advertised.includes("isogit"),
    "installed isogit remains unadvertised by default");

const enabledIsogit = packedExecInventory({ PLURNK_EXECS_ISOGIT: "1" });
ok(enabledIsogit.defaultValue === "1" && enabledIsogit.advertised.includes("isogit"),
    "explicitly enabled isogit is discovered, probed, and advertised");
ok(enabledIsogit.owners.git === "@plurnk/plurnk-execs-git" && enabledIsogit.owners.isogit === isogitPackage,
    "native git and optional isogit retain distinct runtime owners");

process.stdout.write("  ⚠ hosted-model round-trip: deliberate red (endpoint not live) — not yet asserted\n");

uninstallSandbox();
process.stdout.write(failures === 0 ? "\n== PASS ==\n" : `\n== FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
