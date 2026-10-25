import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { docsOnly, formatPhaseSummary, hostBudget, partitionByScript, scopeIntg, shares, tierFiles } from "./drill.mjs";

const DIRS = ["plurnk-contracts", "plurnk-core", "plurnk-mimetypes-text-html", "plurnk-execs-common"];

describe("drill scopeIntg — changed-workspace intg scoping", () => {
    it("{§drill-scope} scopes to the single workspace whose files changed", () => {
        assert.deepEqual([...scopeIntg(["plurnk-execs-common/src/x.ts"], DIRS)], ["plurnk-execs-common"]);
    });

    it("{§drill-scope} scopes to every changed workspace", () => {
        const s = scopeIntg(["plurnk-execs-common/src/x.ts", "plurnk-mimetypes-text-html/src/y.ts"], DIRS);
        assert.deepEqual([...s].toSorted(), ["plurnk-execs-common", "plurnk-mimetypes-text-html"]);
    });

    it("{§drill-scope} returns null (full intg) on a change under a framework package", () => {
        assert.equal(scopeIntg(["plurnk-core/src/x.ts"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-contracts/plurnk.md"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-execs-common/src/x.ts", "plurnk-core/SPEC.md"], DIRS), null);
    });

    it("{§drill-scope} returns null (full intg) on any root-level change", () => {
        assert.equal(scopeIntg(["scripts/drill.mjs"], DIRS), null);
        assert.equal(scopeIntg(["package.json"], DIRS), null);
        assert.equal(scopeIntg(["AGENTS.md"], DIRS), null);
    });

    it("{§drill-scope} a root change alongside a workspace change → full (conservative)", () => {
        assert.equal(scopeIntg(["plurnk-execs-common/src/x.ts", "package.json"], DIRS), null);
    });

    it("{§drill-scope} an empty diff scopes to nothing (lint+unit already ran full)", () => {
        assert.deepEqual([...scopeIntg([], DIRS)], []);
    });
});

describe("drill tier inventory", () => {
    it("{§drill-scope} runs root-owned lint and unit coverage before the workspace tiers", async () => {
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

    it("{§drill-scope} reports applicable and inapplicable workspaces explicitly", () => {
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

    it("{§drill-scope} names every failing package in the tier summary", () => {
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
    it("{§drill-scope} README, CHANGELOG, and a SPEC are documentation", () => {
        assert.equal(docsOnly(["README.md", "CHANGELOG.md", "plurnk-core/SPEC.md"]), true);
    });
    it("{§drill-scope} plurnk.md is model-facing teaching that tests parse, never documentation-only", () => {
        assert.equal(docsOnly(["README.md", "plurnk-contracts/plurnk.md"]), false);
    });
    it("{§drill-scope} any non-Markdown file, or no file at all, is not a documentation-only push", () => {
        assert.equal(docsOnly(["README.md", "scripts/drill.mjs"]), false);
        assert.equal(docsOnly([]), false);
    });
});

describe("drill parallelism — the host's, shared by work", () => {
    const GiB = 2 ** 30;
    it("{§drill-parallelism} the budget is the host's cores, bounded by the test processes its available memory holds", () => {
        assert.equal(hostBudget(24, 64 * GiB), 24, "cores bound a host with memory to spare");
        assert.equal(hostBudget(24, 4 * GiB), 8, "memory bounds a host with cores to spare");
        assert.equal(hostBudget(2, 64 * GiB), 2);
        assert.equal(hostBudget(8, 0), 1, "a host always runs one");
    });

    it("{§drill-parallelism} the largest lane has the whole budget, and each other lane a share scaled by its test files, at least one", () => {
        assert.deepEqual(shares(24, [439, 21, 41, 25, 2, 3, 2, 1]), [24, 1, 2, 1, 1, 1, 1, 1]);
        assert.deepEqual(shares(23, [106, 48, 36, 1]), [23, 10, 8, 1]);
        assert.deepEqual(shares(4, [439, 21, 41]), [4, 1, 1], "a small host runs every lane");
        assert.deepEqual(shares(8, [0, 0]), [8, 8], "lanes whose files are unknown each have the budget");
    });

    it("{§drill-parallelism} every node --test tier takes its share, and no tier fixes its own", async () => {
        const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        const dirs = [".", ...manifest.workspaces];
        for (const dir of dirs) {
            const { scripts = {} } = JSON.parse(await readFile(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
            for (const [name, command] of Object.entries(scripts)) {
                if (!/ --test( |$)/u.test(command)) continue;
                assert.match(command, / --test \$\{PLURNK_TEST_CONCURRENCY:\+--test-concurrency=\$PLURNK_TEST_CONCURRENCY\}/u, `${dir} ${name} takes the drill's share`);
                assert.doesNotMatch(command, /--test-concurrency=\d/u, `${dir} ${name} fixes no concurrency of its own`);
                if (name === "test:unit" || name === "test:intg") {
                    assert.ok(await tierFiles(new URL(`../${dir}/`, import.meta.url).pathname, command) > 0, `${dir} ${name} names the test files it runs`);
                }
            }
        }
    });
});
