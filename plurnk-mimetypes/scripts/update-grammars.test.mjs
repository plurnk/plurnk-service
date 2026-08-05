import assert from "node:assert/strict";
import { mkdtempDisposable, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGrammarLeaves, runGrammarLifecycle } from "./update-grammars.mjs";

const makeFamily = async (slugs = ["alpha", "beta"]) => {
    const temporary = await mkdtempDisposable(path.join(tmpdir(), "grammar-lifecycle-"));
    const frameworkRoot = path.join(temporary.path, "framework");
    const familyRoot = path.join(temporary.path, "family");
    await mkdir(frameworkRoot);
    await mkdir(familyRoot);
    await writeFile(path.join(frameworkRoot, "package.json"), JSON.stringify({
        devDependencies: Object.fromEntries(slugs.map((slug) => [
            `@plurnk/plurnk-mimetypes-grammar-${slug}`,
            "1.0.0",
        ])),
    }));
    for (const slug of slugs) {
        const directory = path.join(familyRoot, `plurnk-mimetypes-grammar-${slug}`);
        await mkdir(directory);
        await writeFile(path.join(directory, "package.json"), JSON.stringify({
            name: `@plurnk/plurnk-mimetypes-grammar-${slug}`,
            version: "1.0.0",
        }));
    }
    return {
        familyRoot,
        frameworkRoot,
        temporary,
        [Symbol.asyncDispose]: () => temporary.remove(),
    };
};

test("requires every framework-declared grammar checkout", async () => {
    await using fixture = await makeFamily();
    await writeFile(path.join(fixture.frameworkRoot, "package.json"), JSON.stringify({
        devDependencies: {
            "@plurnk/plurnk-mimetypes-grammar-alpha": "1.0.0",
            "@plurnk/plurnk-mimetypes-grammar-missing": "1.0.0",
        },
    }));
    await assert.rejects(resolveGrammarLeaves(fixture), /missing grammar leaf checkouts: missing/);
});

test("check mode fails when any leaf probe fails", async () => {
    await using fixture = await makeFamily();
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

test("check mode is read-only and reports every declared leaf", async () => {
    await using fixture = await makeFamily();
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

test("check mode recognizes an upstream with no stable release tags as current", async () => {
    await using fixture = await makeFamily(["alpha"]);
    const run = async () => ({
        stdout: "https://example.test/alpha.git: no stable release tags upstream — staying pinned\n",
        stderr: "",
    });
    const results = await runGrammarLifecycle({ ...fixture, check: true, run });
    assert.equal(results[0].state, "current");
});

test("update refuses mutation without repository-local issue provenance", async () => {
    await using fixture = await makeFamily(["alpha"]);
    const run = async () => ({ stdout: "BUMP old -> new\n", stderr: "" });
    await assert.rejects(runGrammarLifecycle({ ...fixture, check: false, run }),
        /update requires --issue-map/);
});

test("update stops at the first failed lifecycle command", async () => {
    await using fixture = await makeFamily(["alpha"]);
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
        if (command === "git" && args[0] === "var") return { stdout: "plurnk_codex <agent@example.test> 0 +0000\n", stderr: "" };
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
