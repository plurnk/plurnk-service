import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { liveInvocation } from "../plurnk-core/scripts/live.mjs";
import { candidateDaemonArgs } from "./candidate-daemon.mjs";

const root = resolve(import.meta.dirname, "..");
const profilePath = resolve(root, "plurnk-core", ".env.test");
const operatorEnvironment = resolve(root, "scripts", "operator-environment.sh");
const expectedProfile = {
    PLURNK_MODEL: "rtx5070",
    PLURNK_SERVICE_EMBED_DISABLE: "0",
    PLURNK_SERVICE_FILES_ITEMS: "-1",
    PLURNK_SERVICE_GIT_AUTO: "1",
    PLURNK_SERVICE_MD_POLICY: "",
    PLURNK_SERVICE_PACKET_INJECT: "",
    PLURNK_MCP_ENABLED: "[]",
    PLURNK_MCP_EXPANDED: "[]",
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

test("the committed real-model profile contains only universal gate invariants", () => {
    assert.deepEqual(parseProfile(readFileSync(profilePath, "utf8")), expectedProfile);
});

test("the pre-push gate scrubs git's hook environment before the drill (#402)", () => {
    const hook = readFileSync(resolve(root, ".githooks", "pre-push"), "utf8");
    const scrub = hook.indexOf("unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR");
    const drill = hook.indexOf("exec npm test");
    assert.ok(scrub !== -1, "the hook unsets git's exported environment");
    assert.ok(drill !== -1 && scrub < drill, "the scrub precedes the drill, so no gate test inherits GIT_DIR");
});

test("the repository root exposes the service's basic operator lifecycle", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    assert.equal(pkg.scripts.start, "npm start -w @plurnk/plurnk-service");
    assert.equal(pkg.scripts["test:live"], "npm run test:live -w @plurnk/plurnk-service");
    assert.equal(pkg.scripts["test:demo"], "npm run test:demo -w @plurnk/plurnk-service");
});

test("live/demo operator bootstrap carries Tavily and Brave from the authoritative shell equally", () => {
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

test("live, demo, and benchlet launch through the operator environment", async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "plurnk-core", "package.json"), "utf8"));
    const live = await liveInvocation();
    assert.equal(pkg.scripts["build:rail"], "npm run build:gbnf -w @plurnk/plurnk-contracts");
    for (const name of ["pretest:live", "pretest:live:specimen", "pretest:demo", "pretest:demo:zeropin"]) {
        assert.equal(pkg.scripts[name], "npm run build:rail", `${name} regenerates the model rail before use`);
    }
    assert.ok(live.args.includes("--env-file-if-exists=.env.test"));
    assert.equal(live.env.PLURNK_SERVICE_POLICY, "../plurnk-meta/POLICY.md");
    assert.equal(pkg.scripts["test:live:zeropin"], "PLURNK_ZERO_PIN=1 npm run test:live");

    const { demoInvocation } = await import("../plurnk-core/scripts/demo.mjs");
    const demo = await demoInvocation();
    assert.ok(demo.args.includes("--env-file-if-exists=.env.test"), "the demo driver loads the shared profile");
    assert.equal(demo.env.PLURNK_SERVICE_POLICY, "../plurnk-meta/POLICY.md", "the demo driver selects the gate policy");
    assert.equal(demo.env.PLURNK_SERVICE_EMBED_DISABLE, undefined, "the demo driver does not duplicate the shared semantic posture");

    for (const name of ["test:live", "test:live:specimen", "test:demo", "test:demo:specimen", "test:benchlet"]) {
        assert.match(
            pkg.scripts[name],
            /^bash \.\.\/scripts\/operator-environment\.sh /,
            `${name} loads the operator environment before entering the test harness`,
        );
    }

    for (const name of ["test:live:zeropin", "test:demo:zeropin"]) {
        assert.match(
            pkg.scripts[name],
            /^PLURNK_ZERO_PIN=1 npm run test:(live|demo)$/,
            `${name} delegates to the operator-environment entrypoint`,
        );
    }
});

test("the candidate daemon loads the same profile below direct benchmark overrides", () => {
    const [profileArg, servicePath, command] = candidateDaemonArgs(root);
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
        "process.stdout.write(JSON.stringify({ model: process.env.PLURNK_MODEL, embed: process.env.PLURNK_SERVICE_EMBED_DISABLE, files: process.env.PLURNK_SERVICE_FILES_ITEMS, git: process.env.PLURNK_SERVICE_GIT_AUTO, policy: process.env.PLURNK_SERVICE_POLICY }))",
    ], {
        encoding: "utf8",
        env: {
            ...cleanEnv,
            PLURNK_MODEL: "spark",
            PLURNK_SERVICE_EMBED_DISABLE: "1",
            PLURNK_SERVICE_GIT_AUTO: "0",
            PLURNK_SERVICE_POLICY: "/bench/candidate-policy.md",
        },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        model: "spark",
        embed: "1",
        files: "-1",
        git: "0",
        policy: "/bench/candidate-policy.md",
    });
});
