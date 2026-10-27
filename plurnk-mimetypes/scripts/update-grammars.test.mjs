import assert from "node:assert/strict";
import { mkdtempDisposable, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGrammarPackages, runGrammarLifecycle } from "./update-grammars.mjs";
import { assertGrammarPackageContract } from "./verify-grammar-packages.mjs";

// ─── update-grammars.test.mjs ───
{
const makeGrammars = async (slugs = ["alpha", "beta"]) => {
    const temporary = await mkdtempDisposable(path.join(tmpdir(), "grammar-lifecycle-"));
    const frameworkRoot = path.join(temporary.path, "framework");
    const grammarsRoot = path.join(temporary.path, "grammars");
    await mkdir(frameworkRoot);
    await mkdir(grammarsRoot);
    await writeFile(path.join(frameworkRoot, "package.json"), JSON.stringify({
        devDependencies: Object.fromEntries(slugs.map((slug) => [
            `@plurnk/plurnk-mimetypes-grammar-${slug}`,
            "1.0.0",
        ])),
    }));
    for (const slug of slugs) {
        const directory = path.join(grammarsRoot, `plurnk-mimetypes-grammar-${slug}`);
        await mkdir(directory);
        await writeFile(path.join(directory, "package.json"), JSON.stringify({
            name: `@plurnk/plurnk-mimetypes-grammar-${slug}`,
            version: "1.0.0",
        }));
    }
    return {
        grammarsRoot,
        frameworkRoot,
        temporary,
        [Symbol.asyncDispose]: () => temporary.remove(),
    };
};

test("{§mimetype-grammar-packages} requires every framework-declared grammar checkout", async () => {
    await using fixture = await makeGrammars();
    await writeFile(path.join(fixture.frameworkRoot, "package.json"), JSON.stringify({
        devDependencies: {
            "@plurnk/plurnk-mimetypes-grammar-alpha": "1.0.0",
            "@plurnk/plurnk-mimetypes-grammar-missing": "1.0.0",
        },
    }));
    await assert.rejects(resolveGrammarPackages(fixture), /missing grammar package checkouts: missing/);
});

test("{§mimetype-grammar-packages} check mode fails when any grammar probe fails", async () => {
    await using fixture = await makeGrammars();
    const run = async (command, args, cwd) => {
        if (path.basename(cwd).endsWith("alpha")) throw new Error("probe failed");
        return { stdout: "up to date\n", stderr: "" };
    };
    await assert.rejects(runGrammarLifecycle({
        ...fixture,
        check: true,
        run,
    }), /probe failed/);
});

test("{§mimetype-grammar-packages} check mode is read-only and reports every declared grammar", async () => {
    await using fixture = await makeGrammars();
    const calls = [];
    const run = async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { stdout: path.basename(cwd).endsWith("alpha") ? "BUMP old -> new\n" : "up to date\n", stderr: "" };
    };
    const results = await runGrammarLifecycle({ ...fixture, check: true, run });
    assert.deepEqual(results.map(({ slug, state }) => ({ slug, state })), [
        { slug: "alpha", state: "behind" },
        { slug: "beta", state: "current" },
    ]);
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
        ["node", ["scripts/update-pin.mjs", "--check"]],
        ["node", ["scripts/update-pin.mjs", "--check"]],
    ]);
});

test("{§mimetype-grammar-packages} check mode recognizes an upstream with no stable release tags as current", async () => {
    await using fixture = await makeGrammars(["alpha"]);
    const run = async () => ({
        stdout: "https://example.test/alpha.git: no stable release tags upstream — staying pinned\n",
        stderr: "",
    });
    const results = await runGrammarLifecycle({ ...fixture, check: true, run });
    assert.equal(results[0].state, "current");
});

test("{§mimetype-grammar-packages} update refuses mutation without repository-local issue provenance", async () => {
    await using fixture = await makeGrammars(["alpha"]);
    const run = async () => ({ stdout: "BUMP old -> new\n", stderr: "" });
    await assert.rejects(runGrammarLifecycle({ ...fixture, check: false, run }),
        /update requires --issue-map/);
});

test("{§mimetype-grammar-packages} update stops at the first failed lifecycle command", async () => {
    await using fixture = await makeGrammars(["alpha"]);
    const issueMapPath = path.join(fixture.temporary.path, "issues.json");
    await writeFile(issueMapPath, JSON.stringify({ alpha: 7 }));
    const calls = [];
    const run = async (command, args) => {
        calls.push([command, args]);
        if (command === "node" && args[0] === "scripts/update-pin.mjs" && args.includes("--check")) {
            return { stdout: "BUMP old -> new\n", stderr: "" };
        }
        if (command === "node" && args[0] === "scripts/update-pin.mjs" && args.length === 1) {
            throw new Error("pin failed");
        }
        if (command === "git" && args[0] === "status") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "branch") return { stdout: "main\n", stderr: "" };
        if (command === "git" && args[0] === "remote") {
            return { stdout: "ssh://git@ssh.possumtech.com/plurnk/plurnk-mimetypes-grammar-alpha.git\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "" };
        if (command === "git" && args[0] === "var") return { stdout: "an-agent <agent@example.test> 0 +0000\n", stderr: "" };
        if (command === "git" && args[0] === "config") return { stdout: "signer@example.test\n", stderr: "" };
        return { stdout: "", stderr: "" };
    };
    await assert.rejects(runGrammarLifecycle({
        ...fixture,
        check: false,
        issueMapPath,
        run,
    }), /alpha: update stopped/);
    assert.equal(calls.some(([command, args]) => command === "npm" && args[0] === "run"), false);
    assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "push"), false);
});
}

// ─── verify-grammar-packages.test.mjs ───
{
const makePackage = async (overrides = {}) => {
    const temporary = await mkdtempDisposable(path.join(tmpdir(), "grammar-package-contract-"));
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

test("{§mimetype-grammar-packages} accepts one exact, locked, strictly authorized local CLI", async () => {
    await using pkg = await makePackage();
    await assert.doesNotReject(assertGrammarPackageContract(pkg.directory));
});

test("{§mimetype-grammar-packages} rejects a framework dependency on a data-only grammar", async () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        await using pkg = await makePackage({
            manifest: { [field]: { "@plurnk/plurnk-mimetypes": "^2.0.0" } },
        });
        await assert.rejects(assertGrammarPackageContract(pkg.directory), /grammar assets must not depend on the Plurnk framework/);
    }
});

test("{§mimetype-grammar-packages} rejects a floating CLI version", async () => {
    await using pkg = await makePackage({
        manifest: {
            devDependencies: { "tree-sitter-cli": "^0.26.0" },
            allowScripts: { "tree-sitter-cli": true },
        },
    });
    await assert.rejects(assertGrammarPackageContract(pkg.directory), /must be an exact version/);
});

test("{§mimetype-grammar-packages} rejects an ad hoc or uncontained dependency install", async () => {
    await using pkg = await makePackage({
        script: 'await run("npm", ["install", "--no-save", "tree-sitter-cli@^0.26.0"], { cwd: work });',
    });
    await assert.rejects(assertGrammarPackageContract(pkg.directory), /retains an ad hoc CLI install/);

    await using upstreamPackage = await makePackage({
        script: 'await run("npm", ["install"], { cwd: path.join(work, "src") });',
    });
    await assert.rejects(assertGrammarPackageContract(upstreamPackage.directory), /uncontained upstream dependency install/);
});

test("{§mimetype-grammar-packages} rejects a non-exact or persistent upstream checkout", async () => {
    await using shortPinPackage = await makePackage({ pin: "0123456\n" });
    await assert.rejects(assertGrammarPackageContract(shortPinPackage.directory), /full git commit SHA/);

    await using uncheckedPinPackage = await makePackage({ pinValidation: "" });
    await assert.rejects(assertGrammarPackageContract(uncheckedPinPackage.directory), /must validate the full source pin/);

    await using persistentPackage = await makePackage({
        acquisition: [
            'const source = (await readFile(path.join(repoRoot, ".grammar-source"), "utf-8")).trim();',
            'const work = await mkdtemp(path.join(tmpdir(), "grammar-fixture-"));',
            'await run("git", ["clone", "--no-checkout", source, "src"], { cwd: work });',
            'await run("git", ["checkout", pin], { cwd: path.join(work, "src") });',
        ].join("\n"),
    });
    await assert.rejects(assertGrammarPackageContract(persistentPackage.directory), /disposable temporary checkout/);
});

test("{§mimetype-grammar-packages} rejects an invalid or unpublished source locator", async () => {
    await using invalidSourcePackage = await makePackage({ source: "git@example.test:fixture.git\n" });
    await assert.rejects(assertGrammarPackageContract(invalidSourcePackage.directory), /HTTPS git URL/);

    await using unpublishedSourcePackage = await makePackage({
        manifest: { files: [".grammar-pin"] },
    });
    await assert.rejects(assertGrammarPackageContract(unpublishedSourcePackage.directory), /publish .grammar-source/);
});

test("{§mimetype-grammar-packages} rejects an abrupt exit that bypasses disposal", async () => {
    await using pkg = await makePackage({ script: "process.exit(1);" });
    await assert.rejects(assertGrammarPackageContract(pkg.directory), /bypasses temporary checkout disposal/);
});
}
