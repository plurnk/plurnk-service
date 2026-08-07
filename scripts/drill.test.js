import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partitionByScript, scopeIntg } from "./drill.mjs";

const DIRS = ["plurnk-contracts", "plurnk-core", "plurnk-mimetypes-text-html"];

describe("drill scopeIntg — changed-workspace intg scoping", () => {
    it("scopes to the single workspace whose files changed", () => {
        assert.deepEqual([...scopeIntg(["plurnk-contracts/plurnk.md"], DIRS)], ["plurnk-contracts"]);
    });

    it("scopes to every changed workspace", () => {
        const s = scopeIntg(["plurnk-contracts/plurnk.md", "plurnk-core/src/x.ts"], DIRS);
        assert.deepEqual([...s].sort(), ["plurnk-contracts", "plurnk-core"]);
    });

    it("returns null (full intg) on any root-level change", () => {
        assert.equal(scopeIntg(["scripts/drill.mjs"], DIRS), null);
        assert.equal(scopeIntg(["package.json"], DIRS), null);
        assert.equal(scopeIntg(["AGENTS.md"], DIRS), null);
    });

    it("a root change alongside a workspace change → full (conservative)", () => {
        assert.equal(scopeIntg(["plurnk-contracts/plurnk.md", "package.json"], DIRS), null);
    });

    it("an empty diff scopes to nothing (lint+unit already ran full)", () => {
        assert.deepEqual([...scopeIntg([], DIRS)], []);
    });
});

describe("drill tier inventory", () => {
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
});
