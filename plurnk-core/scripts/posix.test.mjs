import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ServiceHelp from "../src/core/ServiceHelp.ts";
import { renderPosix } from "./generate-posix.mjs";

const flags = await ServiceHelp.flags();
const help = ServiceHelp.format(flags);
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const date = "2026-10-09";

test("{§service-posix-artifacts} manual and completions derive their commands and options from service help", () => {
    const artifacts = renderPosix(help, version, date);
    assert.equal(artifacts.size, 4);
    const manual = artifacts.get("man/plurnk-service.1");
    assert.ok(manual.includes(`plurnk-service ${version}`));
    for (const { flagName, envName } of flags) {
        assert.ok(manual.includes(flagName), flagName);
        assert.ok(manual.includes(envName), envName);
        assert.ok(artifacts.get("completions/plurnk-service.bash").includes(flagName), flagName);
        assert.ok(artifacts.get("completions/_plurnk-service").includes(flagName), flagName);
        assert.ok(artifacts.get("completions/plurnk-service.fish").includes(`-l ${flagName.slice(2)}`), flagName);
    }
    for (const command of ["start", "migrate", "config", "share", "requiem"]) {
        for (const content of artifacts.values()) assert.ok(content.includes(command), command);
    }
    for (const flag of ["env-file", "env-file-if-exists", "config", "workspace", "requiem", "version", "help"]) {
        assert.ok(artifacts.get("completions/plurnk-service.fish").includes(`-l ${flag}`), flag);
    }
    const extended = renderPosix(help.replace("\n\n", "\n       plurnk-service [options] example\n\n") + "  --example=<value>  example\n", version, date);
    for (const content of extended.values()) assert.ok(content.includes("example"));
    assert.ok(extended.get("completions/plurnk-service.fish").includes("-l example"));
    assert.deepEqual(renderPosix(help, version, date), artifacts);
});

test("{§service-posix-artifacts} native parsers accept the generated files", async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-service-posix-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    for (const [path, content] of renderPosix(help, version, date)) {
        await mkdir(dirname(join(folder, path)), { recursive: true });
        await writeFile(join(folder, path), content);
    }
    for (const [command, ...args] of [
        ["mandoc", "-T", "lint", "man/plurnk-service.1"],
        ["bash", "-n", "completions/plurnk-service.bash"],
        ["zsh", "-n", "completions/_plurnk-service"],
        ["fish", "--no-config", "-n", "completions/plurnk-service.fish"],
        ["shellcheck", "-s", "bash", "completions/plurnk-service.bash"],
    ]) {
        const result = spawnSync(command, args, { cwd: folder, encoding: "utf8", timeout: 10_000 });
        await t.test(command, { skip: result.error?.code === "ENOENT" ? `${command} is not installed` : false }, () => {
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stdout + result.stderr);
        });
    }
});

test("{§service-posix-artifacts} bash completes locally and preserves literal filenames", async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-service-completion-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const script = join(folder, "completion.bash");
    await writeFile(script, renderPosix(help, version, date).get("completions/plurnk-service.bash"));
    const files = ["alpha beta.db", "alpha[x].db", "alpha*star.db", "alpha\\slash.db"];
    for (const file of files) await writeFile(join(folder, file), "");
    const bash = execFileSync("bash", ["--noprofile", "--norc", "-c", 'command -v bash'], { encoding: "utf8" }).trim();
    const complete = (words) => execFileSync(bash, ["--noprofile", "--norc", "-c", [
        'source "$1"',
        "shift",
        'COMP_WORDS=("$@")',
        "COMP_CWORD=$(($# - 1))",
        "_plurnk_service",
        'if (( ${#COMPREPLY[@]} )); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
    ].join("\n"), "completion-test", script, ...words], {
        cwd: folder,
        // Completion cannot consult a daemon or any external executable.
        env: { PATH: "" },
        encoding: "utf8",
    }).split("\0").filter(Boolean).sort();
    assert.deepEqual(complete(["plurnk-service", "mi"]), ["migrate"]);
    assert.deepEqual(complete(["plurnk-service", "--env-f"]), ["--env-file", "--env-file-if-exists"]);
    assert.deepEqual(complete(["plurnk-service", "share", "alpha"]), files.sort());
    assert.deepEqual(complete(["plurnk-service", "share", "alpha b"]), ["alpha beta.db"]);
    assert.deepEqual(complete(["plurnk-service", "share", "missing"]), []);
});
