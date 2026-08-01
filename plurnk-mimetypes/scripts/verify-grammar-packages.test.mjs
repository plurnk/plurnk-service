import assert from "node:assert/strict";
import { mkdtempDisposable, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertGrammarLeafContract } from "./verify-grammar-packages.mjs";

const makeLeaf = async (overrides = {}) => {
    const temporary = await mkdtempDisposable(path.join(tmpdir(), "grammar-leaf-contract-"));
    const directory = temporary.path;
    await mkdir(path.join(directory, "scripts"));
    const manifest = {
        name: "@plurnk/plurnk-mimetypes-grammar-fixture",
        files: [".grammar-source", ".grammar-pin"],
        devDependencies: { "tree-sitter-cli": "0.26.9" },
        allowScripts: { "tree-sitter-cli@0.26.9": true },
        ...overrides.manifest,
    };
    const lock = {
        packages: {
            "": { devDependencies: { "tree-sitter-cli": "0.26.9" } },
            "node_modules/tree-sitter-cli": {
                version: "0.26.9",
                integrity: "sha512-fixture",
            },
        },
        ...overrides.lock,
    };
    const acquisition = overrides.acquisition ?? [
        'const source = (await readFile(path.join(repoRoot, ".grammar-source"), "utf-8")).trim();',
        'await using temporary = await mkdtempDisposable(path.join(tmpdir(), "grammar-fixture-"));',
        "const work = temporary.path;",
        'await run("git", ["init", "--quiet", "src"], { cwd: work });',
        'await run("git", ["fetch", "--quiet", "--depth=1", source, pin], { cwd: path.join(work, "src") });',
        'await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: path.join(work, "src") });',
    ].join("\n");
    const pinValidation = overrides.pinValidation ?? [
        "if (!/^[0-9a-f]{40}$/i.test(pin)) {",
        "    throw new Error(`.grammar-pin must be a full git commit SHA, got: ${pin}`);",
        "}",
    ].join("\n");
    const script = [
        acquisition,
        pinValidation,
        'const cli = path.join(repoRoot, "node_modules", ".bin", "tree-sitter");',
        overrides.script ?? "",
    ].join("\n");
    await Promise.all([
        writeFile(path.join(directory, "package.json"), JSON.stringify(manifest)),
        writeFile(path.join(directory, "package-lock.json"), JSON.stringify(lock)),
        writeFile(path.join(directory, ".grammar-source"), overrides.source ?? "https://example.test/tree-sitter-fixture.git\n"),
        writeFile(path.join(directory, ".grammar-pin"), overrides.pin ?? "0123456789abcdef0123456789abcdef01234567\n"),
        writeFile(path.join(directory, ".npmrc"), overrides.npmrc ?? "strict-allow-scripts=true\n"),
        writeFile(path.join(directory, "scripts", "build-wasm.mjs"), script),
        writeFile(path.join(directory, "scripts", "verify-wasm.mjs"), script),
        writeFile(
            path.join(directory, "scripts", "update-pin.mjs"),
            [
                'const source = (await readFile(path.join(repoRoot, ".grammar-source"), "utf-8")).trim();',
                pinValidation,
                'execFileSync("git", ["ls-remote", "--tags", source]);',
            ].join("\n"),
        ),
    ]);
    return { directory, [Symbol.asyncDispose]: () => temporary.remove() };
};

test("accepts one exact, locked, strictly authorized local CLI", async () => {
    await using leaf = await makeLeaf();
    await assert.doesNotReject(assertGrammarLeafContract(leaf.directory));
});

test("rejects a floating CLI version", async () => {
    await using leaf = await makeLeaf({
        manifest: {
            devDependencies: { "tree-sitter-cli": "^0.26.0" },
            allowScripts: { "tree-sitter-cli": true },
        },
    });
    await assert.rejects(assertGrammarLeafContract(leaf.directory), /must be an exact version/);
});

test("rejects an ad hoc or uncontained dependency install", async () => {
    await using leaf = await makeLeaf({
        script: 'await run("npm", ["install", "--no-save", "tree-sitter-cli@^0.26.0"], { cwd: work });',
    });
    await assert.rejects(assertGrammarLeafContract(leaf.directory), /retains an ad hoc CLI install/);

    await using upstreamLeaf = await makeLeaf({
        script: 'await run("npm", ["install"], { cwd: path.join(work, "src") });',
    });
    await assert.rejects(assertGrammarLeafContract(upstreamLeaf.directory), /uncontained upstream dependency install/);
});

test("rejects a non-exact or persistent upstream checkout", async () => {
    await using shortPinLeaf = await makeLeaf({ pin: "0123456\n" });
    await assert.rejects(assertGrammarLeafContract(shortPinLeaf.directory), /full git commit SHA/);

    await using uncheckedPinLeaf = await makeLeaf({ pinValidation: "" });
    await assert.rejects(assertGrammarLeafContract(uncheckedPinLeaf.directory), /must validate the full source pin/);

    await using persistentLeaf = await makeLeaf({
        acquisition: [
            'const source = (await readFile(path.join(repoRoot, ".grammar-source"), "utf-8")).trim();',
            'const work = await mkdtemp(path.join(tmpdir(), "grammar-fixture-"));',
            'await run("git", ["clone", "--no-checkout", source, "src"], { cwd: work });',
            'await run("git", ["checkout", pin], { cwd: path.join(work, "src") });',
        ].join("\n"),
    });
    await assert.rejects(assertGrammarLeafContract(persistentLeaf.directory), /disposable temporary checkout/);
});

test("rejects an invalid or unpublished source locator", async () => {
    await using invalidSourceLeaf = await makeLeaf({ source: "git@example.test:fixture.git\n" });
    await assert.rejects(assertGrammarLeafContract(invalidSourceLeaf.directory), /HTTPS git URL/);

    await using unpublishedSourceLeaf = await makeLeaf({
        manifest: { files: [".grammar-pin"] },
    });
    await assert.rejects(assertGrammarLeafContract(unpublishedSourceLeaf.directory), /publish .grammar-source/);
});

test("rejects an abrupt exit that bypasses disposal", async () => {
    await using leaf = await makeLeaf({ script: "process.exit(1);" });
    await assert.rejects(assertGrammarLeafContract(leaf.directory), /bypasses temporary checkout disposal/);
});
