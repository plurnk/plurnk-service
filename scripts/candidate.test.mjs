import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";
import { serviceDefinitions } from "../plurnk-mcp/src/config.ts";
import { parseCandidateClientEnv } from "./lib/candidate-env.mjs";
import { pinRuntime } from "./lib/candidate-runtime.mjs";
import { applyRealModelEnvironment, floorModule, gateProfile, realModelLayers, realModelNodeFlags } from "./lib/environment.mjs";
import { gateResourceEnvironment } from "./lib/gate-environment.mjs";
import { evaluateOrientation } from "./lib/orientation-verdict.mjs";
import { resolveCandidateTopology, resolveClientCheckout } from "./lib/project-topology.mjs";

const root = resolve(import.meta.dirname, "..");
const KEY = "PLURNK_ENVIRONMENT_WITNESS";
const serviceRoot = "/open/plurnk-service";
const cwd = "/experiments/current";

const stage = async (t, defined) => {
    const dir = await mkdtemp(path.join(tmpdir(), "plurnk-environment-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "plurnk-core"), { recursive: true });
    const operatorFile = path.join(dir, "operator.env");
    const files = {
        defaults: path.join(dir, "plurnk-core", ".env.defaults"),
        operator: operatorFile,
        local: `${operatorFile}.local`,
        gate: path.join(dir, "plurnk-core", ".env.test"),
    };
    for (const [layer, file] of Object.entries(files)) {
        if (layer in defined) await writeFile(file, `${KEY}=${defined[layer]}\n`);
    }
    return { root: dir, operatorFile };
};

test("{§operator-config-precedence} a pinned runtime retains the installed native configuration catalog", { timeout: 30_000 }, (t) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-defaults-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const pinned = pinRuntime(root, resolve(fixture, "runtime"));
    const env = {
        ...process.env,
        XDG_CONFIG_HOME: resolve(fixture, "config"),
        PLURNK_SERVICE_ROOTS: "project",
        PLURNK_EXTENSIONS_TRUSTED_ONLY: "1",
    };
    const catalog = (runtime) => execFileSync(process.execPath, [resolve(runtime, "plurnk-core/dist/service.js"), "config", "defaults"], {
        env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const installed = catalog(root);
    assert.match(installed, /# Plurnk installed configuration defaults/);
    assert.equal(catalog(pinned), installed, "linking dependencies preserves every installed owner's panel");
});

test("{§share} candidate SIGTERM stops its client and daemon, runs and exports from its pinned runtime, and preserves the signal status", { timeout: 30_000 }, async (t) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-signal-"));
    const clientRoot = resolve(fixture, "client");
    const candidateDir = resolve(fixture, "candidate");
    mkdirSync(resolve(clientRoot, "bin"), { recursive: true });
    writeFileSync(resolve(clientRoot, "bin", "plurnk.js"), [
        'process.stderr.write("fixture-client-ready\\n");',
        "setInterval(() => {}, 1_000);",
        "",
    ].join("\n"));
    const sourceGuard = resolve(fixture, "source-unavailable.mjs");
    writeFileSync(sourceGuard, [
        'import { registerHooks } from "node:module";',
        "registerHooks({ load(url, context, nextLoad) {",
        '    if (url.endsWith(".ts")) throw new Error("Candidate imported unbuilt source: " + url);',
        // {§share} — no service module may load from the shared checkout.
        `    if (url.startsWith(${JSON.stringify(pathToFileURL(root).href + "/plurnk-")}) && !url.includes("/node_modules/")) throw new Error("Candidate imported the live checkout: " + url);`,
        "    return nextLoad(url, context);",
        "} });",
        "",
    ].join("\n"));

    const env = {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${sourceGuard}`,
        XDG_CONFIG_HOME: resolve(fixture, ".config"),
        OPENAI_API_KEY: "candidate-fixture",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PLURNK_MODEL: "openai/gpt-4.1-mini",
        PLURNK_CANDIDATE_DIR: candidateDir,
        PLURNK_CANDIDATE_SKIP_BUILD: "1",
        PLURNK_CLIENT_CHECKOUT: clientRoot,
    };
    for (const key of Object.keys(env)) {
        if (key === "PLURNK_PROVIDERS_GBNF" || key.startsWith("PLURNK_PROVIDERS_GBNF_")) delete env[key];
    }
    env.PLURNK_PROVIDERS_GBNF = "0";

    const child = spawn(process.execPath, ["scripts/candidate.mjs"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(fixture, { recursive: true, force: true });
    });

    let stdout = "";
    let stderr = "";
    let signaled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (!signaled && stderr.includes("fixture-client-ready")) {
            signaled = true;
            child.kill("SIGTERM");
        }
    });

    const result = await new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => accept({ code, signal }));
    });

    assert.equal(signaled, true, `the fixture client started\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.deepEqual(result, { code: 143, signal: null }, `SIGTERM is finalized by the launcher\n${stderr}`);
    assert.match(stderr, /candidate artifact:/, "the launcher reports the preserved artifact");
    assert.equal(existsSync(resolve(candidateDir, "digest", "digest.json")), true, "SIGTERM still produces the supported digest");
    assert.ok(stderr.includes(` dist ${resolve(candidateDir, "runtime", "plurnk-core")}`), `the daemon ran from the pinned runtime\n${stderr}`);
    assert.equal(existsSync(resolve(candidateDir, "runtime")), false, "the pinned runtime is removed once the digest is written");
});

test("{§environment-layers} candidate reaps its daemon when the client is terminated by a signal", { timeout: 30_000 }, async (t) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-client-signal-"));
    const clientRoot = resolve(fixture, "client");
    const candidateDir = resolve(fixture, "candidate");
    mkdirSync(resolve(clientRoot, "bin"), { recursive: true });
    writeFileSync(resolve(clientRoot, "bin", "plurnk.js"), [
        'process.stderr.write("fixture-client-ready\\n");',
        'setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);',
        "",
    ].join("\n"));

    const env = {
        ...process.env,
        XDG_CONFIG_HOME: resolve(fixture, ".config"),
        OPENAI_API_KEY: "candidate-fixture",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PLURNK_MODEL: "openai/gpt-4.1-mini",
        PLURNK_CANDIDATE_DIR: candidateDir,
        PLURNK_CANDIDATE_SKIP_BUILD: "1",
        PLURNK_CLIENT_CHECKOUT: clientRoot,
        PLURNK_PROVIDERS_GBNF: "0",
    };
    for (const key of Object.keys(env)) {
        if (key.startsWith("PLURNK_PROVIDERS_GBNF_")) delete env[key];
    }

    const child = spawn(process.execPath, ["scripts/candidate.mjs"], {
        cwd: root,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch (error) {
            if (error?.code !== "ESRCH") throw error;
        }
        rmSync(fixture, { recursive: true, force: true });
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => accept({ code, signal }));
    });

    const address = stderr.match(/acp=(http:\/\/127\.0\.0\.1:\d+\/acp)/)?.[1];
    assert.ok(address !== undefined, `the daemon published its address\n${stderr}`);
    assert.deepEqual(result, { code: 1, signal: null }, `the client signal remains a visible failure\n${stderr}`);
    assert.match(stderr, /client terminated by SIGTERM/, "the failure preserves the client signal");
    assert.match(stderr, /candidate artifact:/, "the launcher reports the preserved artifact");
    assert.equal(existsSync(resolve(candidateDir, "digest", "digest.json")), true, "the failed candidate still produces a digest");
    await assert.rejects(
        fetch(address, { signal: AbortSignal.timeout(1_000) }),
        "the candidate daemon endpoint is no longer reachable",
    );
});

test("{§environment-layers} candidate deadline snapshot photographs the project root while the run plays on", { timeout: 30_000 }, async (t) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-deadline-"));
    const clientRoot = resolve(fixture, "client");
    const candidateDir = resolve(fixture, "candidate");
    const projectRoot = resolve(fixture, "repo");
    mkdirSync(resolve(clientRoot, "bin"), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(resolve(projectRoot, "before.txt"), "present at the deadline\n");
    writeFileSync(resolve(clientRoot, "bin", "plurnk.js"), [
        'process.stderr.write("fixture-client-ready\\n");',
        "setTimeout(() => {",
        '    require("node:fs").writeFileSync(process.argv[3] + "/after.txt", "written past the deadline\\n");',
        "    process.exit(0);",
        "}, 3_000);",
        "",
    ].join("\n"));

    const env = {
        ...process.env,
        XDG_CONFIG_HOME: resolve(fixture, ".config"),
        OPENAI_API_KEY: "candidate-fixture",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PLURNK_MODEL: "openai/gpt-4.1-mini",
        PLURNK_CANDIDATE_DIR: candidateDir,
        PLURNK_CANDIDATE_SKIP_BUILD: "1",
        PLURNK_CLIENT_CHECKOUT: clientRoot,
        PLURNK_CANDIDATE_GRADE_DEADLINE_SEC: "1",
    };
    for (const key of Object.keys(env)) {
        if (key === "PLURNK_PROVIDERS_GBNF" || key.startsWith("PLURNK_PROVIDERS_GBNF_")) delete env[key];
    }
    env.PLURNK_PROVIDERS_GBNF = "0";

    const child = spawn(process.execPath, ["scripts/candidate.mjs", "--project-root", projectRoot], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(fixture, { recursive: true, force: true });
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => accept({ code, signal }));
    });

    assert.equal(result.code, 0, `clean client exit finalizes normally\n${stderr}`);
    assert.match(stderr, /candidate: deadline snapshot at 1s/, "the snapshot announces itself");
    const snapshot = resolve(candidateDir, "repo@deadline");
    assert.equal(existsSync(resolve(snapshot, "before.txt")), true, "the photograph holds the pre-deadline file");
    assert.equal(existsSync(resolve(snapshot, "after.txt")), false, "work past the deadline never enters the photograph");
    assert.equal(existsSync(resolve(projectRoot, "after.txt")), true, "the live repo kept playing past the deadline");
});

test("{§environment-layers} the layers run lowest to highest, and the flags say so", () => {
    const layers = realModelLayers("/repo", { operatorFile: "/home/op/.config/plurnk/.env" });
    assert.deepEqual(layers, [
        "/repo/plurnk-core/.env.defaults",
        "/home/op/.config/plurnk/.env",
        "/home/op/.config/plurnk/.env.local",
        "/repo/plurnk-core/.env.test",
    ]);
    assert.equal(gateProfile("/repo"), "/repo/plurnk-core/.env.test");
    assert.deepEqual(realModelNodeFlags("/repo", { operatorFile: "/home/op/.config/plurnk/.env" }), [
        `--import=${floorModule("/repo")}`,
        ...layers.map((layer) => `--env-file-if-exists=${layer}`),
    ]);
});

test("{§environment-layers} precedence: the gate profile over the local and base operator files over the defaults, the shell over all", async (t) => {
    const cases = [
        [{ defaults: "d" }, "d"],
        [{ operator: "o" }, "o"],
        [{ local: "l" }, "l"],
        [{ gate: "g" }, "g"],
        [{ defaults: "d", operator: "o" }, "o"],
        [{ operator: "o", local: "l" }, "l"],
        [{ local: "l", gate: "g" }, "g"],
        [{ defaults: "d", operator: "o", local: "l", gate: "g" }, "g"],
        [{ defaults: "d", gate: "g" }, "g"],
    ];
    for (const [defined, expected] of cases) {
        await t.test(`{§environment-layers} ${Object.keys(defined).join("+")} → ${expected}`, async (t) => {
            delete process.env[KEY];
            const { root: stagedRoot, operatorFile } = await stage(t, defined);
            await applyRealModelEnvironment(stagedRoot, { operatorFile, floor: false });
            assert.equal(process.env[KEY], expected);
            delete process.env[KEY];
        });
    }
    await t.test("{§environment-layers} shell → shell", async (t) => {
        process.env[KEY] = "shell";
        const { root: stagedRoot, operatorFile } = await stage(t, { defaults: "d", operator: "o", gate: "g" });
        await applyRealModelEnvironment(stagedRoot, { operatorFile, floor: false });
        assert.equal(process.env[KEY], "shell");
        delete process.env[KEY];
    });
    await t.test("{§environment-layers} a missing layer is skipped, not an error", async (t) => {
        delete process.env[KEY];
        const { root: stagedRoot, operatorFile } = await stage(t, {});
        await applyRealModelEnvironment(stagedRoot, { operatorFile, floor: false });
        assert.equal(process.env[KEY], undefined);
    });
});

test("{§environment-layers} candidate client overrides parse one deterministic string map", () => {
    assert.deepEqual(
        parseCandidateClientEnv("{\"PLURNK_EXECS_ONLY\":\"atlas\"}"),
        { PLURNK_EXECS_ONLY: "atlas" },
    );
    assert.deepEqual(parseCandidateClientEnv(undefined), {});
});

test("{§environment-layers} candidate client overrides reject ambiguous values and daemon routing", () => {
    assert.throws(
        () => parseCandidateClientEnv("[]"),
        /JSON object with string values/,
    );
    assert.throws(
        () => parseCandidateClientEnv("{\"PLURNK_EXECS_ONLY\":1}"),
        /JSON object with string values/,
    );
    assert.throws(
        () => parseCandidateClientEnv("{\"PLURNK_PORT\":\"1\"}"),
        /candidate-owned daemon routing/,
    );
});

test("{§environment-layers} candidate topology requires an explicit outside client checkout", () => {
    for (const value of [undefined, "", "   "]) {
        assert.throws(
            () => resolveCandidateTopology(serviceRoot, {
                ...(value === undefined ? {} : { PLURNK_CLIENT_CHECKOUT: value }),
            }, cwd),
            /PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout/,
        );
    }
});

test("{§environment-layers} the explicit client checkout is shared by candidate and release lifecycles", () => {
    assert.equal(
        resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: "../client" }, cwd),
        resolve(cwd, "../client"),
    );
});

test("{§environment-layers} conformance's sibling default applies only when no client checkout is supplied", () => {
    const sibling = resolve(serviceRoot, "../plurnk");
    for (const value of [undefined, "", "   "]) {
        assert.equal(resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: value }, cwd, sibling), sibling);
    }
    for (const value of ["../other client", "/independent/client", "/missing/client"]) {
        assert.equal(
            resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: ` ${value} ` }, cwd, sibling),
            resolve(cwd, value),
            "an explicit path overrides the default without guessing from filesystem availability",
        );
    }
});

test("{§test-artifact-retention} candidate topology defaults artifacts to the one benchmark home", () => {
    assert.deepEqual(
        resolveCandidateTopology(serviceRoot, {
            PLURNK_CLIENT_CHECKOUT: "../client",
            PLURNK_BENCHMARKS: " ",
            PLURNK_CANDIDATE_DIR: "",
        }, cwd),
        {
            clientRoot: resolve(cwd, "../client"),
            // {§test-artifact-retention} — the one benchmark home, as every harness resolves it.
            benchmarks: resolve(homedir(), "benchmarks"),
            candidateDir: undefined,
        },
    );
});

test("{§environment-layers} candidate topology preserves explicit relative experiment overrides", () => {
    assert.deepEqual(
        resolveCandidateTopology(serviceRoot, {
            PLURNK_CLIENT_CHECKOUT: "  clients/open  ",
            PLURNK_BENCHMARKS: "../artifacts",
            PLURNK_CANDIDATE_DIR: "../artifacts/run7",
        }, cwd),
        {
            clientRoot: resolve(cwd, "clients/open"),
            benchmarks: resolve(cwd, "../artifacts"),
            candidateDir: resolve(cwd, "../artifacts/run7"),
        },
    );
});

const orientationRecord = {
    schemaVersion: 1,
    response: `The daemon in plurnk-service/plurnk-core/src/service.ts orchestrates the platform, while
plurnk-service/plurnk-contracts/README.md owns the DSL and outside-client/README.md documents the client.
The repository topology is a monorepo plus outside repositories. No canonical forge issue feed
was available, so the current stabilization goal is unverified; that missing context limits confidence.`,
    finalStatus: 200,
    hitMaxTurns: false,
    timedOut: false,
    usage: { costUsd: 42 },
    turns: [{
        turn: 1,
        ops: [
            { op: "FIND", target: "**", status: 200, origin: "model" },
            { op: "READ", target: "plurnk-service/plurnk-core/src/service.ts", status: 200, origin: "model" },
            { op: "READ", target: "plurnk-service/plurnk-contracts/README.md", status: 200, origin: "model" },
            { op: "READ", target: "outside-client/README.md", status: 200, origin: "model" },
        ],
    }],
};

const orientationDigest = {
    sessions: [{ id: 1, name: "_plurnk" }, { id: 2, name: "meta" }],
    loops: [{ id: 1, session_id: 1 }, { id: 2, session_id: 2 }],
    turns: [
        { id: 1, loop_id: 1, model: null },
        { id: 2, loop_id: 2, model: "endpoint/model" },
    ],
    log_entries: [
        { turn_id: 1, op: "EDIT", status_rx: 201 },
        { turn_id: 2, op: "READ", status_rx: 200 },
    ],
};

test("{§environment-layers} orientation verdict accepts a terminal, inspected, evidence-bearing report", () => {
    const verdict = evaluateOrientation(orientationRecord, orientationDigest);
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.failed, []);
    assert.equal(verdict.model, "endpoint/model");
    assert.equal(verdict.costUsd, 42);
});

test("{§environment-layers} orientation verdict rejects a plausible answer that did not inspect its evidence", () => {
    const shallow = structuredClone(orientationRecord);
    shallow.turns = [{ turn: 1, ops: [{ op: "FIND", target: "**", status: 200, origin: "model" }] }];
    const verdict = evaluateOrientation(shallow, orientationDigest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("inspection"));
    assert.ok(verdict.failed.includes("evidence"));
});

test("{§turn-source-resources} orientation verdict counts only the model's own inspection", () => {
    const harnessOnly = structuredClone(orientationRecord);
    harnessOnly.turns = [
        { turn: 1, ops: [
            { op: "READ", target: "ops://meta/1/1", status: 200, origin: "_plurnk" },
            ...Array.from({ length: 8 }, () => ({ op: "FIND", target: "workspace:///_plurnk/plurnk/*.md", status: 200, origin: "_plurnk" })),
            { op: "READ", target: "reasoning://meta/1/1", status: 200, origin: "_plurnk" },
        ] },
        { turn: 2, ops: [
            { op: "READ", target: "ops://meta/1/2", status: 200, origin: "_plurnk" },
            { op: "SEND", target: null, status: 200, origin: "model" },
        ] },
    ];
    const verdict = evaluateOrientation(harnessOnly, orientationDigest);
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.checks.inspection.detail, { successfulRetrievals: 0, operations: [] });
});

test("{§environment-layers} orientation verdict does not count archived issue URLs as inspected repository evidence", () => {
    const archaeological = {
        ...orientationRecord,
        response: orientationRecord.response
            .replace("plurnk-service/plurnk-core/src/service.ts", "https://github.com/plurnk/plurnk-service/issues/583")
            .replace("plurnk-service/plurnk-contracts/README.md", "https://github.com/plurnk/plurnk-service/issues/585")
            .replace("outside-client/README.md", "https://github.com/plurnk/plurnk-service/issues/621"),
    };
    const verdict = evaluateOrientation(archaeological, orientationDigest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("evidence"));
});

test("{§environment-layers} orientation verdict rejects failed documentation publication independently of model success", () => {
    const broken = structuredClone(orientationDigest);
    broken.log_entries.push({ turn_id: 1, op: "EDIT", status_rx: 400 });
    const verdict = evaluateOrientation(orientationRecord, broken);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("workspacePublication"));
});

test("{§environment-layers} orientation verdict rejects timeout, missing coverage, and empty delivery", () => {
    const failed = { ...orientationRecord, response: "", timedOut: true, finalStatus: 499 };
    const verdict = evaluateOrientation(failed, orientationDigest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("lifecycle"));
    assert.ok(verdict.failed.includes("coverage"));
});

test("{§environment-layers} orientation verdict rejects a report that omits current-forge evidence availability", () => {
    const stale = {
        ...orientationRecord,
        response: orientationRecord.response.replace(
            /No canonical forge issue feed[\s\S]*?limits confidence\./,
            "The architecture appears stable.",
        ),
    };
    const verdict = evaluateOrientation(stale, orientationDigest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("coverage"));
});

test("{§operator-config-precedence} personal resources stay inspectable but do not activate in disposable runs", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-gate-environment-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const envPath = join(directory, ".env");
    const source = [
        'PLURNK_MCP_web_search={"name":"web-search","type":"stdio","command":"node"}',
        "PLURNK_MCP_web_search_ENABLED=1",
        'PLURNK_MCP_future_TOOLS=["search"]',
        'PLURNK_SCHEDULE_check={"unused":"fixture"}',
        "PLURNK_MEMBERS_docs=docs/**",
        'PLURNK_SKILLS_3d_tools={"name":"3d-tools","source":"/srv/3d-tools"}',
        'PLURNK_SKILLS_分析={"name":"分析","source":"/srv/分析"}',
        "PLURNK_SKILLS_分析_ENABLED=1",
        "PLURNK_SKILLS_ENABLED=1",
        "PLURNK_MODEL=selected",
        "PLURNK_PROVIDERS_OUTPUT_BUDGET=16384",
        "PROVIDER_API_KEY=fixture-secret",
        "",
    ].join("\n");
    await writeFile(envPath, source);
    const environment = { PLURNK_MCP_web_search_ENABLED: "1", PLURNK_MODEL: "explicit" };
    assert.deepEqual(await gateResourceEnvironment(envPath, environment), {
        PLURNK_MCP_future_ENABLED: "0",
        PLURNK_SCHEDULE_check_ENABLED: "0",
        PLURNK_MEMBERS_docs_ENABLED: "0",
        PLURNK_SKILLS_3d_tools_ENABLED: "0",
        PLURNK_SKILLS_分析_ENABLED: "0",
    });
    assert.deepEqual(environment, { PLURNK_MCP_web_search_ENABLED: "1", PLURNK_MODEL: "explicit" });
    const personal = parseEnv(source);
    const disabled = await gateResourceEnvironment(envPath, {});
    assert.deepEqual(serviceDefinitions({ ...personal, PLURNK_MCP_ENABLED: "0", ...disabled }), [{
        alias: "web-search", enabled: false,
        definition: { name: "web-search", type: "stdio", command: "node" },
        provenance: { kind: "environment", source: "PLURNK_MCP_web_search" },
    }]);
    assert.equal(serviceDefinitions({ ...personal, PLURNK_MCP_ENABLED: "0", ...disabled, ...environment })[0].enabled, true);
    assert.equal(await readFile(envPath, "utf8"), source);
    assert.deepEqual(await gateResourceEnvironment(join(directory, "absent"), {}), {});
    await assert.rejects(gateResourceEnvironment(directory, {}), { code: "EISDIR" });
});

