import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { describe, it } from "node:test";
import { liveInvocation } from "../plurnk-core/scripts/live.mjs";
import { coverageReport, docsOnly, formatPhaseSummary, hostBudget, partitionByScript, scopeIntg, shares, tierFiles } from "./drill.mjs";
import { candidateDaemonArgs } from "./lib/candidate-daemon.mjs";
import { gateProfile } from "./lib/environment.mjs";
import { benchmarksRoot, testArtifactDirectory, testArtifactPath, tierRunPath } from "./lib/test-artifacts.ts";

const DIRS = ["plurnk-contracts", "plurnk-core", "plurnk-mimetypes-text-html", "plurnk-execs-common"];
const root = resolve(import.meta.dirname, "..");
const rootUrl = new URL("../", import.meta.url);
const profilePath = resolve(root, "plurnk-core", ".env.test");
const operatorEnvironment = resolve(root, "scripts", "operator-environment.sh");
const LANES = ["plurnk-core", "plurnk-acp", "plurnk-schedule"];
const expectedProfile = {
    PLURNK_SERVICE_FILES_ITEMS: "-1",
    PLURNK_SERVICE_GIT_AUTO: "1",
    PLURNK_SERVICE_PROPOSALS: "accept",
    PLURNK_SERVICE_POLICY: "",
    PLURNK_SERVICE_PACKET_INJECT: "",
    PLURNK_SERVICE_ROOTS: "project",
    // {§credential-authority} — a gate daemon authenticates nothing; the operator's secret never reaches it.
    PLURNK_AUTH: "0",
    PLURNK_MCP_ENABLED: "0",
    PLURNK_SCHEDULE_ENABLED: "0",
};

const parseProfile = (source) => Object.fromEntries(source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        assert.ok(match !== null, `invalid test-profile line: ${line}`);
        return [match[1], match[2]];
    }));

describe("drill scopeIntg — changed-workspace intg scoping", () => {
    it("{§lint-gate} scopes to the single workspace whose files changed", () => {
        assert.deepEqual([...scopeIntg(["plurnk-execs-common/src/x.ts"], DIRS)], ["plurnk-execs-common"]);
    });

    it("{§lint-gate} scopes to every changed workspace", () => {
        const s = scopeIntg(["plurnk-execs-common/src/x.ts", "plurnk-mimetypes-text-html/src/y.ts"], DIRS);
        assert.deepEqual([...s].toSorted(), ["plurnk-execs-common", "plurnk-mimetypes-text-html"]);
    });

    it("{§lint-gate} returns null (full intg) on a change under a framework package", () => {
        assert.equal(scopeIntg(["plurnk-core/src/x.ts"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-contracts/plurnk.md"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-execs-common/src/x.ts", "plurnk-core/SPEC.md"], DIRS), null);
    });

    it("{§lint-gate} returns null (full intg) on any root-level change", () => {
        assert.equal(scopeIntg(["scripts/drill.mjs"], DIRS), null);
        assert.equal(scopeIntg(["package.json"], DIRS), null);
        assert.equal(scopeIntg(["AGENTS.md"], DIRS), null);
    });

    it("{§lint-gate} a root change alongside a workspace change → full (conservative)", () => {
        assert.equal(scopeIntg(["plurnk-execs-common/src/x.ts", "package.json"], DIRS), null);
    });

    it("{§lint-gate} an empty diff scopes to nothing (lint+unit already ran full)", () => {
        assert.deepEqual([...scopeIntg([], DIRS)], []);
    });
});

describe("drill tier inventory", () => {
    it("{§lint-gate} runs root-owned lint and unit coverage before the workspace tiers", async () => {
        const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        assert.equal(
            manifest.scripts["test:lint"],
            "npm run root:lint && npm run test:lint --workspaces --if-present",
            "the direct lint command and drill must share one root-lint owner",
        );
        assert.equal(
            manifest.scripts["test:unit"],
            "npm run root:unit && npm run test:unit --workspaces --if-present",
            "the direct unit command and drill must share one root-unit owner",
        );
        const source = await readFile(new URL("./drill.mjs", import.meta.url), "utf8");
        const rootLint = source.indexOf('phase("root", "root:lint"');
        const rootUnit = source.indexOf('phase("root unit", "root:unit"');
        const workspaceLint = source.indexOf('phase("lint", "test:lint"');
        const workspaceUnit = source.indexOf('phase("unit", "test:unit"');
        assert.ok(rootLint >= 0 && rootLint < workspaceLint, "npm test must gate root policy before workspace lint");
        assert.ok(rootUnit >= 0 && rootUnit < workspaceUnit, "npm test must gate root unit coverage before workspace unit");
        const build = source.indexOf('phase("build", "build"');
        assert.ok(build >= 0 && build < rootLint && build < rootUnit, "the one build precedes every phase that reads its output");
        const hook = await readFile(new URL("../.githooks/pre-push", import.meta.url), "utf8");
        assert.doesNotMatch(hook, /npm run build/u, "the hook leaves the build to the drill");
    });

    it("{§lint-gate} reports applicable and inapplicable workspaces explicitly", () => {
        const workspaces = [
            { dir: "unit", scripts: ["test:unit"] },
            { dir: "integration", scripts: ["test:intg"] },
            { dir: "both", scripts: ["test:unit", "test:intg"] },
        ];
        assert.deepEqual(partitionByScript(workspaces, "test:intg"), {
            included: [workspaces[1], workspaces[2]],
            excluded: [workspaces[0]],
        });
    });

    it("{§lint-gate} names every failing package in the tier summary", () => {
        const results = [
            { dir: "green", code: 0 },
            { dir: "red-one", code: 1 },
            { dir: "red-two", code: 2 },
        ];
        assert.equal(formatPhaseSummary({
            title: "intg",
            results,
            reds: results.filter((result) => result.code !== 0),
            excluded: [{ dir: "not-applicable" }],
            elapsedSeconds: 95,
        }), "intg: 1/3 green in 95s; red: red-one, red-two; 1 n/a: not-applicable");
    });
});

describe("drill docsOnly — a Markdown-only push runs the root lint alone", () => {
    it("{§lint-gate} README, CHANGELOG, and a SPEC are documentation", () => {
        assert.equal(docsOnly(["README.md", "CHANGELOG.md", "plurnk-core/SPEC.md"]), true);
    });
    it("{§lint-gate} plurnk.md is model-facing teaching that tests parse, never documentation-only", () => {
        assert.equal(docsOnly(["README.md", "plurnk-contracts/plurnk.md"]), false);
    });
    it("{§lint-gate} any non-Markdown file, or no file at all, is not a documentation-only push", () => {
        assert.equal(docsOnly(["README.md", "scripts/drill.mjs"]), false);
        assert.equal(docsOnly([]), false);
    });
});

describe("drill parallelism — the host's, shared by work", () => {
    const GiB = 2 ** 30;
    it("{§lint-gate} the budget is the host's cores, bounded by the test processes its available memory holds", () => {
        assert.equal(hostBudget(24, 64 * GiB), 24, "cores bound a host with memory to spare");
        assert.equal(hostBudget(24, 4 * GiB), 8, "memory bounds a host with cores to spare");
        assert.equal(hostBudget(2, 64 * GiB), 2);
        assert.equal(hostBudget(8, 0), 1, "a host always runs one");
    });

    it("{§lint-gate} the largest lane has the whole budget, and each other lane a share scaled by its test files, at least one", () => {
        assert.deepEqual(shares(24, [439, 21, 41, 25, 2, 3, 2, 1]), [24, 1, 2, 1, 1, 1, 1, 1]);
        assert.deepEqual(shares(23, [106, 48, 36, 1]), [23, 10, 8, 1]);
        assert.deepEqual(shares(4, [439, 21, 41]), [4, 1, 1], "a small host runs every lane");
        assert.deepEqual(shares(8, [0, 0]), [8, 8], "lanes whose files are unknown each have the budget");
    });

    it("{§lint-gate} every node --test tier takes its share, positions native coverage before --test, and sets no coverage threshold", async () => {
        const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        const dirs = [".", ...manifest.workspaces];
        for (const dir of dirs) {
            const { scripts = {} } = JSON.parse(await readFile(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
            for (const [name, command] of Object.entries(scripts)) {
                if (!/ --test( |$)/u.test(command)) continue;
                assert.match(command, / --experimental-test-coverage --test-coverage-include-all '?--test-coverage-include=[^\s']+'? --test \$\{PLURNK_TEST_CONCURRENCY:\+--test-concurrency=\$PLURNK_TEST_CONCURRENCY\}/u, `${dir} ${name} positions report-only coverage before --test and takes the drill's share`);
                assert.doesNotMatch(command, /--test-concurrency=\d/u, `${dir} ${name} fixes no concurrency of its own`);
                assert.doesNotMatch(command, /--test-coverage-(?:branches|functions|lines)/u, `${dir} ${name} sets no coverage threshold`);
                if (name === "test:unit" || name === "test:intg") {
                    assert.ok(await tierFiles(new URL(`../${dir}/`, import.meta.url).pathname, command) > 0, `${dir} ${name} names the test files it runs`);
                }
            }
        }
    });

    it("{§lint-gate} coverageReport extracts the per-file coverage table from passing output without altering phase red/green semantics", () => {
        const sample = [
            "✔ test passes (1.0ms)",
            "ℹ start of coverage report",
            "ℹ file | line % | branch % | funcs % | uncovered lines",
            "ℹ src/x.ts | 12.50 | 50.00 | 0.00 | 10-40",
            "ℹ end of coverage report",
        ].join("\n");
        assert.equal(coverageReport(sample), [
            "ℹ start of coverage report",
            "ℹ file | line % | branch % | funcs % | uncovered lines",
            "ℹ src/x.ts | 12.50 | 50.00 | 0.00 | 10-40",
            "ℹ end of coverage report",
        ].join("\n"));
        assert.equal(coverageReport("✔ no coverage block here"), null);
    });
});

test("{§credential-authority} the committed real-model profile contains only universal gate invariants", () => {
    assert.deepEqual(parseProfile(readFileSync(profilePath, "utf8")), expectedProfile);
});

test("{§credential-authority} test entrypoints exclude personal XDG policy while daily driving and explicit benchmark policy remain intact", async (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), "plurnk-policy-profile-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = resolve(directory, "plurnk");
    mkdirSync(config);
    const personalPolicy = "# Personal policy\nDOGFOOD_ONLY_SENTINEL";
    const personalPath = resolve(config, "AGENTS.md");
    writeFileSync(personalPath, personalPolicy);
    const fixturePolicy = "# Benchmark policy\nFIXTURE_ONLY_SENTINEL";
    const fixturePath = resolve(directory, "fixture.md");
    writeFileSync(fixturePath, fixturePolicy);
    const baseEnv = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory };
    delete baseEnv.PLURNK_SERVICE_POLICY;
    const live = await liveInvocation();
    const policyLoader = new URL("../plurnk-core/src/core/packet-inject.ts", import.meta.url).href;
    const gatePolicy = readFileSync(resolve(root, "plurnk-meta", "POLICY.md"), "utf8").trim() || null;
    const profileArgs = candidateDaemonArgs(root, root).slice(0, 1);
    const cases = [
        { name: "daily driving", args: [], expected: personalPolicy },
        { name: "unit/integration", args: ["--import=./test/setup.ts"], expected: null },
        {
            name: "live",
            args: live.args.filter((arg) => arg.startsWith("--env-file")),
            env: live.env,
            expected: gatePolicy,
        },
        { name: "candidate/benchmark", args: profileArgs, expected: null },
        { name: "explicit benchmark policy", args: profileArgs, env: { PLURNK_SERVICE_POLICY: fixturePath }, expected: fixturePolicy },
    ];
    for (const scenario of cases) {
        const result = spawnSync(process.execPath, [
            "--conditions=plurnk-dev", ...scenario.args, "--input-type=module", "--eval",
            `const { readSystemPolicy } = await import(${JSON.stringify(policyLoader)}); process.stdout.write(JSON.stringify(await readSystemPolicy()));`,
        ], { cwd: resolve(root, "plurnk-core"), encoding: "utf8", env: { ...baseEnv, ...scenario.env } });
        assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout), scenario.expected, scenario.name);
    }
    assert.equal(readFileSync(personalPath, "utf8"), personalPolicy, "the operator's policy is never rewritten");
});

test("{§credential-authority} the gate defaults operator schedules to disabled unless explicitly enabled in the shell", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "plurnk-schedule-profile-"));
    try {
        const operatorFile = resolve(directory, ".env");
        writeFileSync(operatorFile, "PLURNK_SCHEDULE_ENABLED=1\n");
        for (const selected of [undefined, "1"]) {
            const env = { ...process.env };
            if (selected === undefined) delete env.PLURNK_SCHEDULE_ENABLED;
            else env.PLURNK_SCHEDULE_ENABLED = selected;
            const result = spawnSync(process.execPath, [
                `--env-file=${operatorFile}`, `--env-file=${profilePath}`,
                "--eval", "process.stdout.write(process.env.PLURNK_SCHEDULE_ENABLED)",
            ], { encoding: "utf8", env });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, selected ?? "0");
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("{§credential-authority} the pre-push gate scrubs git's hook environment before the drill (#402)", () => {
    const hook = readFileSync(resolve(root, ".githooks", "pre-push"), "utf8");
    const scrub = hook.indexOf("unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR");
    const drill = hook.indexOf("\nnpm test\n");
    assert.ok(scrub !== -1, "the hook unsets git's exported environment");
    assert.ok(drill !== -1 && scrub < drill, "the scrub precedes the drill, so no gate test inherits GIT_DIR");
});

test("{§credential-authority} the pre-push gate drills the pushed commit in a throwaway worktree, never the working tree (#642)", () => {
    const hook = readFileSync(resolve(root, ".githooks", "pre-push"), "utf8");
    const add = hook.indexOf('git worktree add --detach --quiet "$gate" "$main_sha"');
    const enter = hook.indexOf('cd "$gate" || exit 1');
    const drill = hook.indexOf("\nnpm test\n");
    assert.ok(add !== -1 && enter !== -1 && add < enter && enter < drill, "the worktree at the pushed sha is entered before the drill runs");
    assert.match(hook, /trap cleanup EXIT INT TERM HUP/u, "the worktree is removed however the drill ends");
    assert.doesNotMatch(hook, /git status --porcelain/u, "a dirty working tree does not block a push: it is not what the drill tests");
});

test("{§credential-authority} a root alias of a workspace script delegates by workspace name and passes its arguments through", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    assert.match(pkg.scripts.start, /^npm start -w @plurnk\/plurnk-service$/u);
    for (const name of ["test:live", "share", "probe:providers"]) {
        assert.match(pkg.scripts[name], /^npm run (?:-s )?[\w:]+ -w @plurnk\/[\w-]+ --$/u, `${name}: delegates and ends with -- so npm run ${name} -- <arguments> reaches the script`);
    }
});

test("{§credential-authority} live operator bootstrap carries Tavily and Brave from the authoritative shell equally", () => {
    const home = mkdtempSync(resolve(tmpdir(), "plurnk-operator-env-"));
    try {
        writeFileSync(resolve(home, ".bashrc"), [
            "export BRAVE_API_KEY=brave-test-key",
            "export TAVILY_API_KEY=tavily-test-key",
            "",
        ].join("\n"));
        const env = { ...process.env, HOME: home };
        delete env.BRAVE_API_KEY;
        delete env.TAVILY_API_KEY;
        const result = spawnSync("bash", [
            operatorEnvironment,
            process.execPath,
            "--input-type=module",
            "--eval",
            "process.stdout.write(JSON.stringify({ brave: process.env.BRAVE_API_KEY, tavily: process.env.TAVILY_API_KEY }))",
        ], { encoding: "utf8", env });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            brave: "brave-test-key",
            tavily: "tavily-test-key",
        });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("{§credential-authority} live and benchlet launch through the operator environment", async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "plurnk-core", "package.json"), "utf8"));
    const live = await liveInvocation();
    assert.ok(live.args.includes(`--env-file-if-exists=${gateProfile()}`), "the live tier layers the committed gate profile");
    assert.equal(live.env.PLURNK_SERVICE_POLICY, "../plurnk-meta/POLICY.md");

    for (const name of ["test:live", "test:benchlet"]) {
        assert.match(
            pkg.scripts[name],
            /^bash \.\.\/scripts\/operator-environment\.sh /,
            `${name} loads the operator environment before entering the test harness`,
        );
    }
});

test("{§credential-authority} the candidate daemon loads the same profile below direct benchmark overrides", () => {
    const [profileArg, servicePath, command] = candidateDaemonArgs(root, root);
    assert.deepEqual(
        [profileArg, servicePath, command],
        [
            `--env-file=${profilePath}`,
            resolve(root, "plurnk-core", "dist", "service.js"),
            "start",
        ],
    );

    const cleanEnv = { ...process.env };
    for (const key of Object.keys(expectedProfile)) delete cleanEnv[key];
    const result = spawnSync(process.execPath, [
        profileArg,
        "--input-type=module",
        "--eval",
        "process.stdout.write(JSON.stringify({ model: process.env.PLURNK_MODEL, files: process.env.PLURNK_SERVICE_FILES_ITEMS, git: process.env.PLURNK_SERVICE_GIT_AUTO, policy: process.env.PLURNK_SERVICE_POLICY }))",
    ], {
        encoding: "utf8",
        env: {
            ...cleanEnv,
            PLURNK_MODEL: "spark",
            PLURNK_SERVICE_GIT_AUTO: "0",
            PLURNK_SERVICE_POLICY: "/bench/candidate-policy.md",
        },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        model: "spark",
        files: "-1",
        git: "0",
        policy: "/bench/candidate-policy.md",
    });
});

test("{§acp-first-party-client-conformance}: a missing explicit client fails instead of using the sibling", async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "plurnk-client-location-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const missing = join(fixture, "missing client");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "test-client-conformance.mjs")], {
        cwd: fixture,
        env: { ...process.env, PLURNK_CLIENT_CHECKOUT: "./missing client" },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`client conformance needs an installed terminal client checkout: ${missing}.`), result.stderr);
    assert.match(result.stderr, /set PLURNK_CLIENT_CHECKOUT to another installed checkout/);
    assert.equal(result.stdout, "", "the prerequisite fails before packing or starting products");
});

test("{§test-artifact-retention} a run's databases live under the one artifact home, never in the checkout", (t) => {
    const prior = process.env.PLURNK_BENCHMARKS;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_BENCHMARKS;
        else process.env.PLURNK_BENCHMARKS = prior;
    });

    delete process.env.PLURNK_BENCHMARKS;
    assert.equal(benchmarksRoot(), join(homedir(), "benchmarks"), "the default home is ~/benchmarks");

    const home = join(tmpdir(), "plurnk-artifacts-fixture");
    process.env.PLURNK_BENCHMARKS = home;
    assert.equal(benchmarksRoot(), home, "the operator's home wins");
    assert.ok(
        testArtifactPath("core").startsWith(`${home}/`),
        "a lane's directory is inside the artifact home and nowhere else",
    );
});

test("{§test-artifact-retention} a stamped tier run is one directory under the home; an unstamped session has none", (t) => {
    const prior = { PLURNK_BENCHMARKS: process.env.PLURNK_BENCHMARKS, PLURNK_TIER_RUN: process.env.PLURNK_TIER_RUN };
    t.after(() => {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const home = join(tmpdir(), "plurnk-artifacts-fixture");
    process.env.PLURNK_BENCHMARKS = home;
    process.env.PLURNK_TIER_RUN = "live-20261012T000000Z";
    assert.equal(tierRunPath(), join(home, "tier-live-20261012T000000Z"));
    assert.equal(tierRunPath("demo-20261012T000000Z"), join(home, "tier-demo-20261012T000000Z"), "a driver names the run it is about to stamp");
    delete process.env.PLURNK_TIER_RUN;
    assert.equal(tierRunPath(), null);
});

test("{§test-artifact-retention} each lane's run is one directory, stamped once and shared by every test process", (t) => {
    const prior = process.env.PLURNK_TEST_RUN;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_TEST_RUN;
        else process.env.PLURNK_TEST_RUN = prior;
    });

    process.env.PLURNK_TEST_RUN = "20260920T000000Z";
    const first = testArtifactPath("core");
    assert.equal(testArtifactPath("core"), first, "the same stamp resolves to the same directory");
    assert.notEqual(testArtifactPath("acp"), first, "lanes do not share a directory");
    assert.ok(first.endsWith("intg-core-20260920T000000Z"), first);

    delete process.env.PLURNK_TEST_RUN;
    assert.ok(testArtifactPath("core").endsWith("intg-core-adhoc"), testArtifactPath("core"));
});

test("{§test-artifact-retention} the directory is created on demand, with no pretest step to remember", async (t) => {
    const prior = process.env.PLURNK_BENCHMARKS;
    process.env.PLURNK_BENCHMARKS = join(tmpdir(), `plurnk-artifacts-${crypto.randomUUID()}`);
    t.after(async () => {
        await rm(process.env.PLURNK_BENCHMARKS, { recursive: true, force: true });
        if (prior === undefined) delete process.env.PLURNK_BENCHMARKS;
        else process.env.PLURNK_BENCHMARKS = prior;
    });

    const directory = await testArtifactDirectory("core");
    assert.ok((await stat(directory)).isDirectory(), "opening a database needs no prior ceremony");
});

test("{§test-artifact-retention} each lane stamps its run once and reclaims only a green run", async () => {
    for (const lane of LANES) {
        const { scripts } = JSON.parse(await readFile(new URL(`${lane}/package.json`, rootUrl), "utf8"));
        assert.match(scripts["test:intg"], /^export PLURNK_TEST_RUN=/u, `${lane} stamps its run once for every test process`);
        const reclaimed = /reclaim-green-run\.mjs ([a-z]+)$/u.exec(scripts["test:intg"])?.[1];
        if (lane !== "plurnk-core") assert.equal(/ PLURNK_TEST_LANE=([a-z]+); /u.exec(scripts["test:intg"])?.[1], reclaimed, `${lane} names the lane it reclaims`);
        assert.match(scripts["test:intg"], / && node \.\.\/scripts\/reclaim-green-run\.mjs [a-z]+$/u, `${lane} reclaims only a green run`);
        assert.doesNotMatch(scripts["test:intg"], /\brm\b/u, `${lane} keeps no sweep of its own`);
    }
});

test("{§test-artifact-retention} no lane writes run output back into the checkout", async () => {
    for (const lane of LANES) {
        const ignore = await readFile(new URL(`${lane}/.gitignore`, rootUrl), "utf8").catch(() => "");
        assert.doesNotMatch(ignore, /test\/intg\/\.tmp/u, `${lane} keeps no scratch inside the tree`);
    }
});
