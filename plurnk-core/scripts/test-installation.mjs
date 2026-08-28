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
const pdfPackage = "@plurnk/plurnk-mimetypes-application-pdf";
const tokenizersPackage = "@plurnk/plurnk-mimetypes-tokenizers";
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
    delete childEnv.PLURNK_EXECS_ONLY;
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
        const tokenizer = await mimetypes.tokenizer("o200k");
        process.stdout.write(JSON.stringify({
            owners: Object.fromEntries([...discovery.handlers].map(([name, info]) => [name, info.packageName])),
            json: { ok: json.ok, mimetype: json.mimetype },
            embedder: embedder !== null,
            tokenizer: {
                exact: tokenizer.exact,
                plurnkPackage: tokenizer.notices?.[0]?.plurnkPackage ?? null,
            },
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
    for (const key of Object.keys(childEnv)) {
        if (key.startsWith("PLURNK_MCP_")) delete childEnv[key];
    }
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

const aguiAction = async (address, kind, params = {}, workspace) => {
    const response = await fetch(address, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            runId: crypto.randomUUID(),
            threadId: "installation-probe",
            workerId: "installation-probe",
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {
                plurnk: {
                    ...(workspace === undefined ? {} : { workspace }),
                    action: { kind, ...params },
                },
            },
        }),
    });
    const body = await response.text();
    const events = body
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)));
    const outcome = events.find((event) =>
        event.type === "CUSTOM" && event.name === "plurnk.action.result")?.value;
    if (!response.ok || outcome?.ok !== true) {
        throw new Error(`packed ${kind} failed (${response.status}): ${body}`);
    }
    return outcome.result;
};

const markerCount = (path) => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length
    : 0;

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
ok(
    mimetypeInventory.tokenizer.exact === false
        && mimetypeInventory.tokenizer.plurnkPackage === tokenizersPackage,
    "the clean service reports the optional tokenizer artifact honestly",
);

const pdfRoot = resolve(mods, "@plurnk", "plurnk-mimetypes-application-pdf");
const tokenizersRoot = resolve(mods, "@plurnk", "plurnk-mimetypes-tokenizers");
ok(!existsSync(pdfRoot), "the heavyweight PDF handler is absent from a clean service install");
ok(!existsSync(tokenizersRoot), "the tokenizer vocabulary artifact is absent from a clean service install");
ok(
    !Object.values(mimetypeInventory.owners).includes(pdfPackage),
    "a clean service does not advertise the uninstalled PDF handler",
);

process.stdout.write("-- optional mimetype lifecycle --\n");
installPacked(tarballs, pdfPackage);
ok(existsSync(resolve(pdfRoot, "package.json")), "the exact packed PDF leaf installs into the service-visible module graph");
const pdfInventory = packedMimetypeInventory();
ok(pdfInventory.owners["application/pdf"] === pdfPackage, "the installed PDF leaf is discovered without a service rebuild");

installPacked(tarballs, tokenizersPackage);
ok(existsSync(resolve(tokenizersRoot, "package.json")), "the exact packed tokenizer artifact installs into the service-visible module graph");
const tokenizerInventory = packedMimetypeInventory();
ok(tokenizerInventory.tokenizer.exact === true, "the installed tokenizer artifact resolves an exact bundled vocabulary");

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
const packedTurnOps = '# PLAN0\n[{"content":"Exercise the installed digest.","status":"in_progress"}]\n## SEND0 [200]\ndone';
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
    const turn = digestFixture.installation_insert_turn.get({ loop_id: loop.id });
    digestFixture.installation_insert_turn_ops.run({
        worker_id: worker.id,
        loop_id: loop.id,
        turn_id: turn.id,
        rx: JSON.stringify({ content: packedTurnOps, mimetype: "text/vnd.plurnk" }),
        weight: Math.ceil(packedTurnOps.length / 2),
    });
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
    readFileSync(resolve(packedDigestDir, "packet000.assistant.md"), "utf8") === packedTurnOps
        && !existsSync(resolve(packedDigestDir, "packet000.system.md"))
        && !existsSync(resolve(packedDigestDir, "packet000.user.md"))
        && !existsSync(resolve(packedDigestDir, "packet000.assistantRaw.json")),
    "the packed digest projects exact source-only turnOps without fabricated provider artifacts",
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
    !existsSync(resolve(mods, "@plurnk", "plurnk-meta", "skills")),
    "plurnk-meta ships no bundled Agent Skills; the skills family is the only discovery affordance",
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
    const primary = await aguiAction(address, "workspace.create", { projectRoot: packedSkillProject });
    await aguiAction(address, "workspace.create", { name: "packed-dormant-two" });
    await aguiAction(address, "workspace.create", { name: "packed-dormant-three" });
    const anchorWorkspace = await aguiAction(address, "workspace.create", { name: "packed-anchor-range" });
    const anchorTarget = "worker:///packed-anchor.md";
    const anchorContent = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
    await aguiAction(address, "op.parse", {
        text: `## EDIT0 (${anchorTarget})\n${anchorContent}`,
    }, anchorWorkspace.name);
    const anchoredRead = (await aguiAction(address, "op.parse", {
        text: `## READ0 (${anchorTarget})`,
    }, anchorWorkspace.name)).results[0];
    const [one, two] = anchoredRead.lineAnchors;
    const applied = await aguiAction(address, "op.parse", {
        text: `## EDIT0 (${anchorTarget}) <${one},${two}>`,
    }, anchorWorkspace.name);
    const landed = (await aguiAction(address, "op.parse", {
        text: `## READ0 (${anchorTarget})`,
    }, anchorWorkspace.name)).results[0];
    const [three, four, five, six, seven, eight] = landed.lineAnchors;
    const rejected = await aguiAction(address, "op.parse", {
        text: `## EDIT0 (${anchorTarget}) <${three},${four},${five},${six},${seven},${eight}>\nreplacement`,
    }, anchorWorkspace.name);
    const unchanged = (await aguiAction(address, "op.parse", {
        text: `## READ0 (${anchorTarget})`,
    }, anchorWorkspace.name)).results[0];
    return {
        primary,
        anchors: {
            rejected: rejected.results,
            unchanged: unchanged.content,
            applied: applied.results,
            landed: landed.content,
            offending: three,
        },
    };
});
ok(
    skillBoot.listening === true && skillBoot.probeError === undefined,
    "the packed AG-UI workspace bootstrap accepts a conventional project skill without a provider",
);
const packedAnchorProbe = skillBoot.probeResult?.anchors;
const packedAnchorProjectionWorks = packedAnchorProbe?.applied?.[0]?.status === 200
        && packedAnchorProbe?.landed === "three\nfour\nfive\nsix\nseven\neight"
        && packedAnchorProbe?.rejected?.[0]?.status === 400
        && packedAnchorProbe?.rejected?.[0]?.problem?.anchor === packedAnchorProbe?.offending
        && packedAnchorProbe?.unchanged === "three\nfour\nfive\nsix\nseven\neight";
ok(
    packedAnchorProjectionWorks,
    "the packed AG-UI path applies two-anchor ranges and attributes malformed coordinates exactly",
);
const dormantWorkspaceId = skillBoot.probeResult?.primary?.id;
if (!Number.isSafeInteger(dormantWorkspaceId) || dormantWorkspaceId <= 0) {
    throw new Error(`packed workspace.create returned no usable id: ${JSON.stringify(skillBoot.probeResult)}`);
}
const readPackedCapabilityDocs = () => {
    const skillDb = new SqlRiteSync({ path: packedSkillDb, dir: import.meta.dirname });
    try {
        return new Map(
            skillDb.installation_select_capability_docs.all()
                .filter(({ workspace_id }) => workspace_id === dormantWorkspaceId)
                .map(({ pathname, content }) => [pathname, content]),
        );
    } finally {
        skillDb.close();
    }
};
ok(
    readPackedCapabilityDocs().size === 0,
    "passive packed workspace bootstrap publishes no capability documentation",
);

const mcpStartMarker = resolve(sandbox, "packed-mcp-starts.txt");
const mcpFixture = resolve(import.meta.dirname, "../../plurnk-mcp/src/fixtures/echo-server.mjs");
const dormantMcpEnv = {
    PLURNK_SERVICE_DB_PATH: packedSkillDb,
    PLURNK_MCP_BROKEN: resolve(sandbox, "missing-mcp-server"),
    PLURNK_MCP_ECHO: process.execPath,
    PLURNK_MCP_ECHO_ARGS: JSON.stringify([mcpFixture]),
    PLURNK_MCP_ECHO_ENV: JSON.stringify({ PLURNK_MCP_TEST_START_MARKER: mcpStartMarker }),
    PLURNK_MCP_ENABLED: JSON.stringify(["broken", "echo"]),
};
const dormantBoot = await bootStart(dormantMcpEnv, async (address) => {
    const before = markerCount(mcpStartMarker);
    const attached = await aguiAction(address, "workspace.attach", { id: dormantWorkspaceId });
    const afterFirstAttach = markerCount(mcpStartMarker);
    await aguiAction(address, "workspace.attach", { id: dormantWorkspaceId });
    const afterSecondAttach = markerCount(mcpStartMarker);
    const listed = await aguiAction(address, "worker.mcp.list", {}, attached.name);
    const afterDemand = markerCount(mcpStartMarker);
    await aguiAction(address, "worker.mcp.list", {}, attached.name);
    return {
        before,
        afterFirstAttach,
        afterSecondAttach,
        afterDemand,
        afterRepeatedDemand: markerCount(mcpStartMarker),
        states: Object.fromEntries(listed.definitions.map(({ alias, state }) => [alias, state])),
    };
});
ok(
    dormantBoot.listening === true
        && dormantBoot.probeError === undefined
        && dormantBoot.probeResult?.before === 0
        && dormantBoot.probeResult?.afterFirstAttach === 0
        && dormantBoot.probeResult?.afterSecondAttach === 0,
    "the packed daemon leaves persisted worker Functionality cold through boot and attachment",
);
ok(
    dormantBoot.probeResult?.afterDemand > 0
        && dormantBoot.probeResult?.afterRepeatedDemand === dormantBoot.probeResult?.afterDemand,
    "the packed daemon activates one demanded worker once and keeps it warm",
);
ok(
    dormantBoot.probeResult?.states?.broken === "unavailable"
        && dormantBoot.probeResult?.states?.echo === "active",
    "one unavailable packed MCP remains visible without withholding its healthy peer",
);
const packedSkills = readPackedCapabilityDocs();
ok(
    packedSkills.get("/_plurnk/skills/inspect.md")?.includes("Inspect a packed installation.") === true,
    "first packed capability demand materializes .agents/skills project content",
);
ok(
    packedSkills.get("/_plurnk/skills/find-skills.md") === undefined,
    "no bundled discovery skill is materialized into the packed Worker",
);
ok(
    packedSkills.get("/_plurnk/skills/index.md")?.includes("**inspect**") === true,
    "first packed capability demand publishes the project skill through the model-facing index",
);
ok(
    packedSkills.get("/_plurnk/plurnk/skills.md")?.includes("EXEC0 [skills] (discover)") === true,
    "the packed Worker learns Skills management from the generated family manager, not a bundled skill",
);
const startsAfterActivation = markerCount(mcpStartMarker);
const coldRestart = await bootStart(dormantMcpEnv);
ok(
    coldRestart.listening === true
        && markerCount(mcpStartMarker) === startsAfterActivation
        && !/MCP server .* unavailable during worker activation/u.test(coldRestart.stderr),
    "restart leaves previously activated worker integrations cold until fresh demand",
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

process.stdout.write("-- executor inventory --\n");
const packedExecs = packedExecInventory();
ok(packedExecs.advertise === "function", "the packed executor framework retains its frozen 1.x Advertise export");
for (const packageName of defaultExecPackages) {
    const manifest = installedManifest(packageName);
    for (const runtime of manifest.plurnk?.runtimes ?? []) {
        ok(
            packedExecs.owners[runtime.name] === packageName,
            `EXEC runtime ${runtime.name} is discovered from the service-owned ${packageName} leaf`,
        );
    }
}
ok(!("git" in packedExecs.owners) && !("isogit" in packedExecs.owners),
    "the installed executor inventory contains no bespoke Git dialect");

process.stdout.write("  ⚠ hosted-model round-trip: deliberate red (endpoint not live) — not yet asserted\n");

uninstallSandbox();
process.stdout.write(failures === 0 ? "\n== PASS ==\n" : `\n== FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
