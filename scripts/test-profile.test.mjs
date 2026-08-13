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
    PLURNK_MODEL: "turboderp",
    PLURNK_SERVICE_EMBED_DISABLE: "0",
    PLURNK_SERVICE_FILES_ITEMS: "-1",
    PLURNK_SERVICE_GIT_AUTO: "1",
    PLURNK_SERVICE_MD_POLICY: "",
    PLURNK_SERVICE_PACKET_INJECT: "",
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

test("live and demo load the shared profile and retain their exact policy owner", async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "plurnk-core", "package.json"), "utf8"));
    const live = await liveInvocation();
    assert.equal(pkg.scripts["build:rail"], "npm run build:gbnf -w @plurnk/plurnk-contracts");
    for (const name of ["pretest:live", "pretest:live:specimen", "pretest:demo", "pretest:demo:zeropin"]) {
        assert.equal(pkg.scripts[name], "npm run build:rail", `${name} regenerates the model rail before use`);
    }
    assert.ok(live.args.includes("--env-file-if-exists=.env.test"));
    assert.equal(live.env.PLURNK_SERVICE_POLICY, "../plurnk-meta/PLURNK_PERSONALITY.md");
    assert.equal(pkg.scripts["test:live:zeropin"], "PLURNK_ZERO_PIN=1 npm run test:live");

    for (const name of ["test:live", "test:live:specimen", "test:demo", "test:demo:zeropin"]) {
        assert.match(
            pkg.scripts[name],
            /^bash \.\.\/scripts\/operator-environment\.sh /,
            `${name} loads the operator environment before entering the test harness`,
        );
    }

    for (const name of ["test:demo", "test:demo:zeropin"]) {
        const script = pkg.scripts[name];
        assert.match(script, /--env-file-if-exists=\.env\.test(?:\s|$)/, `${name} loads the shared profile`);
        assert.match(script, /PLURNK_SERVICE_POLICY=\.\.\/plurnk-meta\/PLURNK_PERSONALITY\.md/, `${name} selects the gate policy`);
        assert.doesNotMatch(script, /PLURNK_SERVICE_EMBED_DISABLE=/, `${name} does not duplicate the shared semantic posture`);
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
