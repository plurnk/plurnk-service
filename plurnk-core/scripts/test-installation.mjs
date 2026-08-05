// Off-hot-path e2e: install the built package into a clean sandbox as a consumer would, then
// prove it works out of the box — the embedder ships in the default composition with no
// native install scripts, the bin boots the DB from the installed dist, the daemon listens, and a
// fresh install has no active model ({§operator-config-shipped-defaults}): the pointer surfaces instead.
// The hosted-model round-trip is a deliberate red until that endpoint is live.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installPacked, installSandbox, uninstallSandbox, sandbox } from "./install-sandbox.mjs";

let failures = 0;
const ok = (cond, msg) => { process.stdout.write(`  ${cond ? "✓" : "✗"} ${msg}\n`); if (!cond) failures++; };
const bin = resolve(sandbox, "node_modules", ".bin", "plurnk-service");
const isogitPackage = "@plurnk/plurnk-execs-isogit";

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
        const { discover } = await import(pathToFileURL(resolve(nodeModules, "@plurnk/plurnk-execs/dist/index.js")));
        const files = await EnvDefaults.collect(serviceRoot, nodeModules);
        const merged = EnvDefaults.merge(files);
        EnvDefaults.apply(merged);
        const discovery = await discover({ cwd: process.cwd() });
        const executors = await ExecutorRegistry.build({ cwd: process.cwd() });
        process.stdout.write(JSON.stringify({
            defaultValue: process.env.PLURNK_EXECS_ISOGIT ?? null,
            defaultOwner: merged.get("PLURNK_EXECS_ISOGIT")?.owner ?? null,
            disabled: discovery.disabled,
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

const runBin = (args, env = {}) => {
    try {
        const stdout = execFileSync(bin, args, { cwd: sandbox, encoding: "utf8", env: { ...process.env, HOME: sandbox, ...env } });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
};

const bootStart = (env = {}) => new Promise((res) => {
    // Run from OUTSIDE the install dir so discovery must resolve plugins package-relative,
    // not from CWD/node_modules — the global-dogfood scenario (start from your own project).
    const childEnv = { ...process.env };
    for (const key of ["PLURNK_AGUI_TOKEN", "PLURNK_AGUI_MAX_TURNS", "PLURNK_AGUI_HEARTBEAT_MS"]) delete childEnv[key];
    Object.assign(childEnv, { HOME: sandbox, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" }, env);
    const child = spawn(bin, ["start"], { cwd: resolve(sandbox, ".."), env: childEnv });
    let stdout = "", stderr = "", listening = false;
    // Resolve on EXIT (after a graceful SIGTERM) so both pipes fully drain — the
    // embedder notice rides stderr and races the stdout startup line otherwise.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (c) => { stdout += c; if (/plurnk-service agui=http:\/\//.test(stdout) && !listening) { listening = true; setTimeout(() => child.kill("SIGTERM"), 300); } });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("exit", () => { clearTimeout(hardKill); res({ stdout, stderr, listening }); });
    child.once("error", () => { clearTimeout(hardKill); res({ stdout, stderr, listening, error: true }); });
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
const digestFixture = new DatabaseSync(migratedDb);
try {
    digestFixture.exec("PRAGMA foreign_keys = ON");
    const workspace = digestFixture.prepare(
        "INSERT INTO workspaces (name) VALUES (?) RETURNING id",
    ).get("packed-digest-workspace");
    const worker = digestFixture.prepare(
        "INSERT INTO workers (workspace_id, name, origin) VALUES (?, ?, 'model') RETURNING id",
    ).get(workspace.id, "packed-digest-worker");
    const loop = digestFixture.prepare(
        "INSERT INTO loops (worker_id, sequence, prompt) VALUES (?, 1, ?) RETURNING id",
    ).get(worker.id, "packed-digest-prompt");
    digestFixture.prepare(
        "INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, 1, 200, NULL)",
    ).run(loop.id);
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
    /journal-only turn dispatched operations/.test(readFileSync(resolve(packedDigestDir, "packet000.packet.md"), "utf8")),
    "the packed digest writes its model-visible packet artifact",
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

// first-run bootstrap: ~/.plurnk seeded with config (HOME → sandbox), no PLURNK_SERVICE_DB_PATH so it homes the DB
const home = runBin(["migrate"], {});
ok(existsSync(resolve(sandbox, ".plurnk", ".env")) && existsSync(resolve(sandbox, ".plurnk", "plurnk.db")),
    "first run bootstraps ~/.plurnk (.env seeded + DB homed there, not CWD)");
void home;

const boot = await bootStart({
    PLURNK_SERVICE_DB_PATH: resolve(sandbox, "start.db"),
    // {§browser-provisioning}: this fixture provisions no operator browser.
    PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
});
ok(boot.listening === true, "{§agui-daemon-client}: `start` boots the daemon with its AG-UI+ listener");
ok(!/embedder inactive/.test(boot.stderr), "no embedder-inactive notice — the shipped embedder is active");
// {§operator-config-shipped-defaults}: a fresh install resolves no model and names
// the available configuration paths instead.
ok(/ no model\n?$/m.test(boot.stdout) || /no model/.test(boot.stdout), "startup line reports 'no model' on an untouched install (no hosted default)");
ok(/no model configured/.test(boot.stderr) && /local \/ cloud \/ plurnk\.ai/.test(boot.stderr), "the pointer names the three options in ~/.plurnk/.env");

const aguiDefaultsPath = resolve(mods, "@plurnk", "plurnk-agui", ".env.defaults");
const aguiDefaults = readFileSync(aguiDefaultsPath, "utf8");
try {
    writeFileSync(
        aguiDefaultsPath,
        aguiDefaults.replace(/^PLURNK_AGUI_HEARTBEAT_MS=.*$/m, "PLURNK_AGUI_HEARTBEAT_MS=invalid"),
    );
    const invalidAguiFloor = await bootStart({
        PLURNK_SERVICE_DB_PATH: resolve(sandbox, "invalid-agui-floor.db"),
        PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
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
    PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
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
for (const packageName of defaultExecPackages) {
    const manifest = installedManifest(packageName);
    for (const runtime of manifest.plurnk?.runtimes ?? []) {
        ok(
            absentIsogit.owners[runtime.name] === packageName,
            `EXEC[${runtime.name}] is discovered from the service-owned ${packageName} leaf`,
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
