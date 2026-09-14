import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { docsOnly, formatPhaseSummary, partitionByScript, scopeIntg } from "./drill.mjs";

const DIRS = ["plurnk-contracts", "plurnk-core", "plurnk-mimetypes-text-html", "plurnk-execs-jq"];

describe("drill scopeIntg — changed-workspace intg scoping", () => {
    it("scopes to the single leaf workspace whose files changed", () => {
        assert.deepEqual([...scopeIntg(["plurnk-execs-jq/src/x.ts"], DIRS)], ["plurnk-execs-jq"]);
    });

    it("scopes to every changed leaf workspace", () => {
        const s = scopeIntg(["plurnk-execs-jq/src/x.ts", "plurnk-mimetypes-text-html/src/y.ts"], DIRS);
        assert.deepEqual([...s].sort(), ["plurnk-execs-jq", "plurnk-mimetypes-text-html"]);
    });

    it("returns null (full intg) on a change under a framework package", () => {
        assert.equal(scopeIntg(["plurnk-core/src/x.ts"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-contracts/plurnk.md"], DIRS), null);
        assert.equal(scopeIntg(["plurnk-execs-jq/src/x.ts", "plurnk-core/SPEC.md"], DIRS), null);
    });

    it("returns null (full intg) on any root-level change", () => {
        assert.equal(scopeIntg(["scripts/drill.mjs"], DIRS), null);
        assert.equal(scopeIntg(["package.json"], DIRS), null);
        assert.equal(scopeIntg(["AGENTS.md"], DIRS), null);
    });

    it("a root change alongside a leaf change → full (conservative)", () => {
        assert.equal(scopeIntg(["plurnk-execs-jq/src/x.ts", "package.json"], DIRS), null);
    });

    it("an empty diff scopes to nothing (lint+unit already ran full)", () => {
        assert.deepEqual([...scopeIntg([], DIRS)], []);
    });
});

describe("drill tier inventory", () => {
    it("runs root-owned lint and unit coverage before the workspace tiers", async () => {
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
    });

    it("reports applicable and inapplicable workspaces explicitly", () => {
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

    it("names every failing package in the tier summary", () => {
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
    it("README, CHANGELOG, and a SPEC are documentation", () => {
        assert.equal(docsOnly(["README.md", "CHANGELOG.md", "plurnk-core/SPEC.md"]), true);
    });
    it("plurnk.md is model-facing teaching that tests parse, never documentation-only", () => {
        assert.equal(docsOnly(["README.md", "plurnk-contracts/plurnk.md"]), false);
    });
    it("any non-Markdown file, or no file at all, is not a documentation-only push", () => {
        assert.equal(docsOnly(["README.md", "scripts/drill.mjs"]), false);
        assert.equal(docsOnly([]), false);
    });
});
