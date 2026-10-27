import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextDiff, { scanDiff } from "./TextDiff.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";

// ─── TextDiff.test.ts ───
{
const metadata = {
    mimetype: "text/x-diff",
    glyph: "🔀",
    extensions: [".diff", ".patch"] as const,
};

const h = new TextDiff(metadata);

// Helpers — pull the deepJson tree's typed shapes for assertions.
type FileNode = {
    type: "file";
    oldPath: string | null;
    newPath: string | null;
    additions: number;
    deletions: number;
    binary: boolean;
    line: number;
    endLine: number;
    hunks: HunkNode[];
};
type HunkNode = {
    type: "hunk";
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    heading: string | null;
    line: number;
    endLine: number;
};
const deep = (src: string) => h.deepJson(src) as { type: "diff"; files: FileNode[] };

// A multi-file git diff: edit + new + delete + rename + mode-only + binary.
const MULTI = [
    "diff --git a/src/edit.js b/src/edit.js",                  // 1
    "index 1111111..2222222 100644",                          // 2
    "--- a/src/edit.js",                                      // 3
    "+++ b/src/edit.js",                                      // 4
    "@@ -1,3 +1,4 @@",                                        // 5
    " context line",                                          // 6
    "-removed line",                                          // 7
    "+added line one",                                        // 8
    "+added line two",                                        // 9
    " trailing context",                                      // 10
    "diff --git a/src/new.js b/src/new.js",                   // 11
    "new file mode 100644",                                  // 12
    "index 0000000..3333333",                                // 13
    "--- /dev/null",                                          // 14
    "+++ b/src/new.js",                                      // 15
    "@@ -0,0 +1,2 @@",                                        // 16
    "+brand new",                                            // 17
    "+second line",                                          // 18
    "diff --git a/src/gone.js b/src/gone.js",                 // 19
    "deleted file mode 100644",                              // 20
    "index 4444444..0000000",                                // 21
    "--- a/src/gone.js",                                      // 22
    "+++ /dev/null",                                         // 23
    "@@ -1,2 +0,0 @@",                                        // 24
    "-old one",                                              // 25
    "-old two",                                              // 26
    "diff --git a/old/name.js b/new/name.js",                 // 27
    "similarity index 95%",                                  // 28
    "rename from old/name.js",                               // 29
    "rename to new/name.js",                                 // 30
    "index 5555555..6666666 100644",                         // 31
    "--- a/old/name.js",                                     // 32
    "+++ b/new/name.js",                                     // 33
    "@@ -1 +1 @@",                                            // 34
    "-was this",                                             // 35
    "+now that",                                             // 36
    "diff --git a/script.sh b/script.sh",                     // 37
    "old mode 100644",                                       // 38
    "new mode 100755",                                       // 39
    "diff --git a/logo.png b/logo.png",                       // 40
    "index 7777777..8888888 100644",                         // 41
    "Binary files a/logo.png and b/logo.png differ",         // 42
].join("\n");

describe("{§diff-line-budget} file sections are modules and hunks are their fields", () => {
    it("{§diff-line-budget} emits one module symbol per file section (6 files)", () => {
        const syms = h.extractRaw(MULTI);
        const modules = syms.filter((s) => s.kind === "module");
        assert.equal(modules.length, 6);
    });

    it("{§diff-line-budget} names the rename module `old → new`", () => {
        const syms = h.extractRaw(MULTI);
        const names = syms.filter((s) => s.kind === "module").map((s) => s.name);
        assert.ok(names.includes("old/name.js → new/name.js"));
    });

    it("{§diff-line-budget} names the pure-deletion module by its old path", () => {
        const syms = h.extractRaw(MULTI);
        const names = syms.filter((s) => s.kind === "module").map((s) => s.name);
        assert.ok(names.includes("src/gone.js"));
    });

    it("{§diff-line-budget} names edit/new modules by their new path", () => {
        const syms = h.extractRaw(MULTI);
        const names = new Set(syms.filter((s) => s.kind === "module").map((s) => s.name));
        assert.ok(names.has("src/edit.js"));
        assert.ok(names.has("src/new.js"));
    });

    it("{§diff-line-budget} emits hunks as `field` symbols contained by their file module", () => {
        const syms = h.extractRaw(MULTI);
        const hunks = syms.filter((s) => s.kind === "field");
        // edit(1) + new(1) + delete(1) + rename(1); mode-only and binary have none.
        assert.equal(hunks.length, 4);
        const editHunk = hunks.find((s) => s.container === "src/edit.js");
        assert.ok(editHunk);
        assert.equal(editHunk.container, "src/edit.js");
    });
});

describe("{§diff-line-budget} git sections recover their paths with or without hunks", () => {
    it("{§diff-line-budget} recovers binary section paths from the diff --git line", () => {
        const { files } = scanDiff(MULTI);
        const bin = files.find((f) => f.binary);
        assert.ok(bin);
        assert.equal(bin.newPath, "logo.png");
        assert.equal(bin.oldPath, "logo.png");
    });

    it("{§diff-line-budget} recovers mode-only section paths with no hunk", () => {
        const { files } = scanDiff(MULTI);
        const mode = files.find((f) => f.newPath === "script.sh");
        assert.ok(mode);
        assert.equal(mode.hunks.length, 0);
        assert.equal(mode.binary, false);
    });
});

describe("{§diff-line-budget} deepJson carries per-file counts and hunk coordinates", () => {
    it("{§diff-line-budget} carries per-file add/del counts in deepJson", () => {
        const { files } = deep(MULTI);
        const edit = files.find((f) => f.newPath === "src/edit.js")!;
        assert.equal(edit.additions, 2);
        assert.equal(edit.deletions, 1);
        const created = files.find((f) => f.newPath === "src/new.js")!;
        assert.equal(created.additions, 2);
        assert.equal(created.deletions, 0);
        assert.equal(created.oldPath, null); // /dev/null
        const gone = files.find((f) => f.oldPath === "src/gone.js")!;
        assert.equal(gone.deletions, 2);
        assert.equal(gone.additions, 0);
        assert.equal(gone.newPath, null);
    });

    it("{§diff-line-budget} carries hunk oldStart/newStart/counts in deepJson", () => {
        const { files } = deep(MULTI);
        const edit = files.find((f) => f.newPath === "src/edit.js")!;
        assert.deepEqual(edit.hunks[0], {
            type: "hunk",
            oldStart: 1, oldCount: 3, newStart: 1, newCount: 4,
            heading: null, line: 5, endLine: 10, column: 1, endColumn: 18,
        });
    });
});

describe("{§diff-line-budget} a bare ---/+++ pair opens a section without a diff --git line", () => {
    const src = [
        "--- original.txt\t2026-01-01 00:00:00.000 +0000",
        "+++ modified.txt\t2026-01-02 00:00:00.000 +0000",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
    ].join("\n");

    it("{§diff-line-budget} opens a file section from the bare ---/+++ pair, timestamp tails stripped", () => {
        const { files } = scanDiff(src);
        assert.equal(files.length, 1);
        assert.equal(files[0].oldPath, "original.txt");
        assert.equal(files[0].newPath, "modified.txt");
    });

    it("{§diff-line-budget} counts the single hunk's add/del", () => {
        const { files } = scanDiff(src);
        assert.equal(files[0].additions, 1);
        assert.equal(files[0].deletions, 1);
        assert.equal(files[0].hunks.length, 1);
    });
});

describe("{§diff-line-budget} a combined diff reads N prefix columns against one summed budget", () => {
    // Two parents → `@@@` fence, 2 old ranges + 1 new range. Conflict-marker
    // lines (<<<<<<<, =======, >>>>>>>) appear as additions in the new column.
    const src = [
        "diff --cc merged.txt",
        "index 1111,2222..3333",
        "--- a/merged.txt",
        "+++ b/merged.txt",
        "@@@ -1,3 -1,3 +1,5 @@@",
        "  shared context",
        "++<<<<<<< ours",
        "+ ours line",
        "++=======",
        "+ theirs line",
        "++>>>>>>> theirs",
        "  more shared",
    ].join("\n");

    it("{§diff-line-budget} does not crash and bounds the hunk correctly", () => {
        const { files } = scanDiff(src);
        assert.equal(files.length, 1);
        assert.equal(files[0].hunks.length, 1);
        const hunk = files[0].hunks[0];
        // The hunk header is on line 5; the budget closes it on the last
        // content line (12), not beyond.
        assert.equal(hunk.line, 5);
        assert.equal(hunk.endLine, 12);
    });

    it("{§diff-line-budget} counts conflict-marker lines as additions", () => {
        const { files } = scanDiff(src);
        // 5 lines carry a `+` in some column → 5 additions.
        assert.equal(files[0].additions, 5);
    });
});

describe("{§diff-line-budget} a hunk is named by its heading text, else its new-file coordinates", () => {
    const src = [
        "diff --git a/greet.js b/greet.js",
        "--- a/greet.js",
        "+++ b/greet.js",
        "@@ -10,3 +10,3 @@ function greet(name) {",
        " const msg = `hi`;",
        "-return msg;",
        "+return msg.trim();",
    ].join("\n");

    it("{§diff-line-budget} names the hunk by its section-heading text", () => {
        const syms = h.extractRaw(src);
        const hunk = syms.find((s) => s.kind === "field");
        assert.ok(hunk);
        assert.equal(hunk.name, "function greet(name) {");
    });

    it("{§diff-line-budget} stores the heading in deepJson", () => {
        const { files } = deep(src);
        assert.equal(files[0].hunks[0].heading, "function greet(name) {");
        assert.equal(files[0].hunks[0].oldStart, 10);
        assert.equal(files[0].hunks[0].newStart, 10);
    });

    it("{§diff-line-budget} falls back to `@@ +c,d` coords when no heading is present", () => {
        const noHeading = [
            "--- a/x",
            "+++ b/x",
            "@@ -1,1 +1,1 @@",
            "-a",
            "+b",
        ].join("\n");
        const syms = h.extractRaw(noHeading);
        const hunk = syms.find((s) => s.kind === "field");
        assert.ok(hunk);
        assert.equal(hunk.name, "@@ +1,1");
    });
});

describe("{§diff-line-budget} an unsatisfied budget closes at the end of the document", () => {
    // The header promises 5 new lines but the diff is cut off after 2.
    const src = [
        "--- a/big.txt",
        "+++ b/big.txt",
        "@@ -1,5 +1,5 @@",
        " line one",
        "+added",
    ].join("\n");

    it("{§diff-line-budget} closes the unsatisfied hunk at the last seen line, no throw", () => {
        const { files } = scanDiff(src);
        assert.equal(files.length, 1);
        const hunk = files[0].hunks[0];
        assert.equal(hunk.line, 3);
        assert.equal(hunk.endLine, 5); // last line of the (truncated) document
        assert.equal(files[0].additions, 1);
    });
});

describe("{§diff-line-budget} lines outside any section are skipped", () => {
    const src = [
        "Some commit prose before the diff.",
        "Signed-off-by: Someone <x@y.z>",
        "",
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
        "-- ",                    // mail signature delimiter (garbage, not a hunk)
        "trailing prose",
    ].join("\n");

    it("{§diff-line-budget} skips non-header lines and parses only the real section", () => {
        const { files } = scanDiff(src);
        assert.equal(files.length, 1);
        assert.equal(files[0].newPath, "f.txt");
        assert.equal(files[0].additions, 1);
        assert.equal(files[0].deletions, 1);
    });
});

describe("{§diff-line-budget} a deleted line beginning `---` is content inside an open hunk", () => {
    // A hunk DELETING a line whose content starts with `---`. Without the line
    // budget this `--- old config` reads as a new file header. With the budget,
    // it is authoritatively a deletion inside the open hunk.
    const src = [
        "diff --git a/config.txt b/config.txt",
        "--- a/config.txt",
        "+++ b/config.txt",
        "@@ -1,3 +1,2 @@",
        " [settings]",
        "--- old config",          // CONTENT being deleted, not a header
        "+++ new config",          // CONTENT being added, not a header
        " [end]",
    ].join("\n");

    it("{§diff-line-budget} reads `--- old config` as a deletion, not a new file section", () => {
        const { files } = scanDiff(src);
        // ONE file section — the trap line did NOT open a second.
        assert.equal(files.length, 1);
        assert.equal(files[0].newPath, "config.txt");
    });

    it("{§diff-line-budget} counts the trap lines as one deletion and one addition", () => {
        const { files } = scanDiff(src);
        assert.equal(files[0].deletions, 1); // `--- old config`
        assert.equal(files[0].additions, 1); // `+++ new config`
    });

    it("{§diff-line-budget} keeps both trap lines inside the single hunk span", () => {
        const { files } = scanDiff(src);
        assert.equal(files[0].hunks.length, 1);
        assert.equal(files[0].hunks[0].endLine, 8); // ` [end]` line
    });
});

describe("{§diff-line-budget} the no-newline annotation spends no budget", () => {
    const src = [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,1 +1,1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
    ].join("\n");

    it("{§diff-line-budget} does not consume budget or count as add/del", () => {
        const { files } = scanDiff(src);
        assert.equal(files[0].additions, 1);
        assert.equal(files[0].deletions, 1);
    });
});

describe("{§diff-line-budget} input with no section projects nothing", () => {
    it("{§diff-line-budget} returns [] symbols for empty input", () => {
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("{§diff-line-budget} returns an empty files tree for empty input", () => {
        const { files } = deep("");
        assert.deepEqual(files, []);
    });

    it("{§diff-line-budget} returns [] for prose with no diff", () => {
        assert.deepEqual(h.extractRaw("just some text\nno diff here\n"), []);
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// Structural matches carry honest regions in the readable text.
const h = new TextDiff({ mimetype: "text/x-diff", glyph: "🔀", extensions: [".diff", ".patch"] });

const src = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n";

describe("{§mimetype-query} sections are exact regions and scalars enclosing in both dialects", () => {
    for (const separator of ["\n", "\r\n", "\r"]) it(`{§diff-line-budget} exact diff sections use source code-point columns with ${JSON.stringify(separator)}`, async () => {
        const source = ["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-old", "+😀"].join(separator);
        const regions = [{ startLine: 1, startColumn: 1, endLine: 5, endColumn: 3 }];
        assert.deepEqual((await h.query(source, "jsonpath", "$.files[0]"))[0].regions, regions);
        assert.deepEqual((await h.query(source, "xpath", "//file"))[0].regions, regions);
        assert.deepEqual((await h.query(source, "xpath", "//hunk"))[0].regions, [{ ...regions[0], startLine: 3 }]);
    });
    it("{§diff-line-budget} jsonpath distinguishes an exact file section from an enclosing scalar region", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.files[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.files[0].newPath",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
        ]);
    });
    it("{§diff-line-budget} xpath distinguishes an exact file section from an enclosing scalar region", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "//file",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//newPath",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
        ]);
    });
});
}
