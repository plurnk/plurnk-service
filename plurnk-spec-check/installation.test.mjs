import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { packRecords } from "../scripts/npm-json.mjs";

const run = promisify(execFile);
const declare = (tag) => `${"§"}${tag}`;
const cite = (tag) => `{${declare(tag)}}`;

test("{§spec-check-cli} packed CLI checks only the selected consumer tree", { timeout: 60_000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "plurnk-spec-check-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const consumer = path.join(directory, "consumer");
    const source = path.join(directory, "source");
    await mkdir(consumer);
    await mkdir(source);
    const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: import.meta.dirname });
    const [archive] = packRecords(stdout);
    assert.ok(archive.files.some(({ path: name }) => name === "check.mjs"));
    assert.ok(!archive.files.some(({ path: name }) => name.endsWith(".test.mjs")));
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "spec-check-consumer", private: true }));
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(directory, archive.filename)], { cwd: consumer });
    const installed = JSON.parse(await readFile(path.join(consumer, "node_modules/@plurnk/plurnk-spec-check/package.json"), "utf8"));
    assert.equal(installed.dependencies, undefined, "the CLI has no runtime dependencies");
    const bin = path.join(consumer, "node_modules/.bin/plurnk-spec-check");
    const check = (args = [source], cwd = consumer) => run(bin, args, { cwd });
    const fails = async (args, expected) => assert.rejects(check(args), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, expected);
        return true;
    });
    await run("git", ["init", "--quiet"], { cwd: source });
    const spec = `# ${declare("fixture-contract")} One real contract\n`;
    const specPath = path.join(source, "SPEC.md");
    const witnessPath = path.join(source, "witness.js");
    await writeFile(specPath, spec);
    await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
    await writeFile(path.join(source, "removed.md"), "tracked but deleted\n");
    await run("git", ["add", "SPEC.md", "witness.js", "removed.md"], { cwd: source });
    await rm(path.join(source, "removed.md"));
    await writeFile(path.join(source, ".gitignore"), "generated/\n");
    await mkdir(path.join(source, "generated"));
    await writeFile(path.join(source, "generated/ignored.md"), cite("not-real"));
    await writeFile(path.join(source, "binary.js"), `\0${cite("not-real")}`);
    await writeFile(path.join(directory, "outside.md"), cite("not-real"));
    await symlink(path.join(directory, "outside.md"), path.join(source, "linked.md"));

    await t.test("{§spec-check-cli} explicit directory, current directory and help", async () => {
        assert.match((await check()).stdout, /spec references OK/u);
        assert.match((await check([], source)).stdout, /spec references OK/u);
        assert.match((await check(["--help"])).stdout, /^Usage: plurnk-spec-check/u);
        await fails(["--unknown"], /Unknown option/u);
        await fails([source, consumer], /Expected at most one source directory/u);
        await fails([source, "--write"], /--write requires --allowance/u);
    });

    await t.test("{§spec-check-tags} malformed, missing and duplicate tags fail with locations", async () => {
        const cases = [
            [spec, `// ${cite("missing")}\n`, new RegExp(`witness\\.js:1 \\{${declare("missing")}\\}`, "u")],
            [`${spec}\n${spec}`, `// ${cite("fixture-contract")}\n`, /fixture-contract: SPEC\.md:1, SPEC\.md:3/u],
            [spec, `// ${declare("bad_tag")}\n`, new RegExp(`witness\\.js:1 ${declare("bad_tag")}`, "u")],
        ];
        for (const [text, witness, diagnostic] of cases) {
            await writeFile(specPath, text);
            await writeFile(witnessPath, witness);
            await fails([source], diagnostic);
        }
        await writeFile(specPath, spec);
        await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
    });

    await t.test("{§spec-check-cli} untracked source participates", async () => {
        const extra = path.join(source, "untracked.js");
        await writeFile(extra, `// ${cite("untracked-missing")}\n`);
        await fails([source], /untracked\.js:1/u);
        await rm(extra);
    });

    await t.test("{§spec-check-witnesses} allowances are explicit, validated and never silently rewritten", async () => {
        await writeFile(witnessPath, "// No citation.\n");
        await fails([source], /fixture-contract is cited by no implementation/u);
        const allowance = path.join(source, "allowance.json");
        const text = JSON.stringify({ "SPEC.md": ["fixture-contract"] });
        await writeFile(allowance, text);
        await fails([source], /fixture-contract is cited by no implementation/u);
        assert.match((await check([source, "--allowance", "allowance.json"])).stdout, /1 anchors await/u);
        assert.equal(await readFile(allowance, "utf8"), text);
        await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
        await fails([source, "--allowance", "allowance.json"], /is witnessed or gone; strike it from the allowance/u);
        assert.equal(await readFile(allowance, "utf8"), text);
        assert.match((await check([source, "--allowance", "allowance.json", "--write"])).stdout, /spec references OK/u);
        assert.deepEqual(JSON.parse(await readFile(allowance, "utf8")), {});
        for (const value of [null, [], { "SPEC.md": "fixture-contract" }, { "SPEC.md": [1] }]) {
            await writeFile(allowance, JSON.stringify(value));
            await fails([source, "--allowance", "allowance.json"], /Witness allowance must map/u);
        }
        await fails([source, "--allowance", "missing.json"], /ENOENT/u);
    });

    assert.equal(await readFile(specPath, "utf8"), spec, "checking never modifies the contract");
});
