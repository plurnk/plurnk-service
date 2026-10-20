import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

test("{§native-source-toolchain} the root pins the ordinary Node and npm toolchain", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    assert.equal(manifest.engines.node, ">=26");
    assert.equal(manifest.packageManager, "npm@12.2.0");
    assert.equal(manifest.scripts.prepare, "git config core.hooksPath .githooks && npm run build");
    assert.equal(manifest.scripts["config:defaults"], "node --conditions=plurnk-dev plurnk-core/src/service.ts config defaults");
    assert.equal(await readFile(new URL(".node-version", root), "utf8"), "26\n");
});

test("{§native-source-toolchain}: source checking has one modern ECMAScript module contract", async () => {
    const { compilerOptions } = JSON.parse(await readFile(new URL("tsconfig.base.json", root), "utf8"));
    assert.equal(compilerOptions.target, "ESNext");
    assert.deepEqual(compilerOptions.lib, ["ESNext"]);
    assert.equal(compilerOptions.module, "NodeNext");
    assert.equal(compilerOptions.moduleResolution, "NodeNext");
    assert.equal(compilerOptions.erasableSyntaxOnly, true);
    assert.equal(compilerOptions.verbatimModuleSyntax, true);
    const { workspaces } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    for (const workspace of workspaces.filter((name) => name !== "plurnk-spec-check")) {
        const config = JSON.parse(await readFile(new URL(`${workspace}/tsconfig.json`, root), "utf8"));
        assert.equal(config.extends, "../tsconfig.base.json", workspace);
        for (const option of ["target", "lib", "module", "moduleResolution", "erasableSyntaxOnly", "verbatimModuleSyntax"]) {
            assert.equal(Object.hasOwn(config.compilerOptions ?? {}, option), false,
                `${workspace} inherits ${option}; browser-specific checking belongs in its own config`);
        }
    }
});

test("{§lint-gate} every file the type-aware lint reads is in the program of a tsconfig.json", async () => {
    const repository = fileURLToPath(root);
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8" })
        .split("\n").filter(Boolean);
    const { ignorePatterns } = JSON.parse((await readFile(new URL(".oxlintrc.json", root), "utf8")).replaceAll(/^\s*\/\/.*$/gmu, ""));
    const ignored = ignorePatterns.map((pattern) => {
        const directory = /^\*\*\/([^/*]+)\/\*\*$/u.exec(pattern)?.[1];
        assert.ok(directory, `${pattern} names one directory`);
        return directory;
    });
    const contained = new Set();
    for (const project of tracked.filter((file) => path.basename(file) === "tsconfig.json")) {
        const program = execFileSync(path.join(repository, "node_modules/.bin/tsc"), ["--listFilesOnly", "-p", project], { cwd: repository, encoding: "utf8" });
        for (const file of program.split("\n").filter(Boolean)) contained.add(path.resolve(repository, file));
    }
    const outside = tracked
        .filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && !path.dirname(file).split("/").some((segment) => ignored.includes(segment)))
        .filter((file) => !contained.has(path.resolve(repository, file)));
    assert.deepEqual(outside, [], "files in no tsconfig.json program");
});
