import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scopeIntg } from "./drill.mjs";

const DIRS = ["plurnk-grammar", "plurnk-core", "plurnk-mimetypes-text-html"];

describe("drill scopeIntg — changed-workspace intg scoping", () => {
    it("scopes to the single workspace whose files changed", () => {
        assert.deepEqual([...scopeIntg(["plurnk-grammar/plurnk.md"], DIRS)], ["plurnk-grammar"]);
    });

    it("scopes to every changed workspace", () => {
        const s = scopeIntg(["plurnk-grammar/plurnk.md", "plurnk-core/src/x.ts"], DIRS);
        assert.deepEqual([...s].sort(), ["plurnk-core", "plurnk-grammar"]);
    });

    it("returns null (full intg) on any root-level change", () => {
        assert.equal(scopeIntg(["scripts/drill.mjs"], DIRS), null);
        assert.equal(scopeIntg(["package.json"], DIRS), null);
        assert.equal(scopeIntg(["AGENTS.md"], DIRS), null);
    });

    it("a root change alongside a workspace change → full (conservative)", () => {
        assert.equal(scopeIntg(["plurnk-grammar/plurnk.md", "package.json"], DIRS), null);
    });

    it("an empty diff scopes to nothing (lint+unit already ran full)", () => {
        assert.deepEqual([...scopeIntg([], DIRS)], []);
    });
});
