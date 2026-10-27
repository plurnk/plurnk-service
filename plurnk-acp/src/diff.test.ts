import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedDiff } from "./diff.ts";

describe("buildUnifiedDiff", { concurrency: true }, () => {
    test("{§acp-body-reference} {§acp-plurnk-metadata}: emits context-bounded hunks with preserved surrounding lines", () => {
        const oldText = ["one", "two", "three", "four"].join("\n") + "\n";
        const newText = ["one", "TWO", "three", "four"].join("\n") + "\n";
        const diff = buildUnifiedDiff("src/file.ts", oldText, newText);
        assert.equal(
            diff,
            [
                "--- a/src/file.ts",
                "+++ b/src/file.ts",
                "@@ -1,4 +1,4 @@",
                " one",
                "-two",
                "+TWO",
                " three",
                " four",
            ].join("\n"),
        );
    });

    test("{§acp-body-reference} {§acp-plurnk-metadata}: separates non-overlapping changes into distinct hunks", () => {
        const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
        const modified = [...lines];
        modified[0] = "LINE-1";
        modified[11] = "LINE-12";
        const diff = buildUnifiedDiff("/workspace/alpha/app.ts", lines.join("\n"), modified.join("\n"), 2);
        assert.equal(
            diff,
            [
                "--- a/workspace/alpha/app.ts",
                "+++ b/workspace/alpha/app.ts",
                "@@ -1,3 +1,3 @@",
                "-line-1",
                "+LINE-1",
                " line-2",
                " line-3",
                "@@ -10,3 +10,3 @@",
                " line-10",
                " line-11",
                "-line-12",
                "+LINE-12",
            ].join("\n"),
        );
    });

    test("{§acp-body-reference}: handles file creation and complete deletion", () => {
        const created = buildUnifiedDiff("new.txt", "", "alpha\nbeta\n");
        assert.equal(
            created,
            [
                "--- a/new.txt",
                "+++ b/new.txt",
                "@@ -0,0 +1,2 @@",
                "+alpha",
                "+beta",
            ].join("\n"),
        );

        const deleted = buildUnifiedDiff("old.txt", "alpha\nbeta\n", "");
        assert.equal(
            deleted,
            [
                "--- a/old.txt",
                "+++ b/old.txt",
                "@@ -1,2 +0,0 @@",
                "-alpha",
                "-beta",
            ].join("\n"),
        );
    });
});
