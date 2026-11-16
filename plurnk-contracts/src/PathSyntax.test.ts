import assert from "node:assert/strict";
import test from "node:test";
import PathSyntax from "./PathSyntax.ts";

test("{§path-syntax} decodeParens decodes only the target-slot parenthesis spelling", () => {
    assert.equal(PathSyntax.decodeParens("/dir/file%28v1%29.txt"), "/dir/file(v1).txt");
    assert.equal(PathSyntax.decodeParens("/a%28b%29c%28d%29"), "/a(b)c(d)");
    assert.equal(
        PathSyntax.decodeParens("/50%off %20literal.txt"),
        "/50%off %20literal.txt",
    );
});

test("{§path-syntax} target-slot escaping preserves parentheses verbatim and round-trips backslashes without decoding glob escapes", () => {
    assert.equal(PathSyntax.escapeTarget("a(b)"), "a(b)");
    assert.equal(
        PathSyntax.escapeTarget(String.raw`a\b`),
        String.raw`a\\b`,
    );
    assert.equal(
        PathSyntax.unescapeTarget(String.raw`a\\\(b\\\)`),
        String.raw`a\(b\)`,
    );
    assert.equal(PathSyntax.unescapeTarget(String.raw`docs/a\*.md`), String.raw`docs/a\*.md`);

    for (const target of [
        "plain",
        "a(b)c",
        String.raw`slash\path`,
        "trailing\\",
    ]) {
        assert.equal(PathSyntax.unescapeTarget(PathSyntax.escapeTarget(target)), target);
    }
});

test("{§path-syntax} path-glob classification recognizes the complete shared syntax", () => {
    assert.equal(PathSyntax.hasGlob("/docs/exact.md"), false);
    assert.equal(PathSyntax.globMagicIndex("/docs/exact.md"), -1);
    assert.equal(PathSyntax.globMagicIndex("/docs/[ab].md"), 6);
    for (const pattern of [
        "/docs/*.md",
        "/docs/file?.md",
        "/docs/[ab].md",
        "/docs/{a,b}.md",
        "/docs/@(a|b).md",
        "/docs/a\\*.md",
    ]) {
        assert.equal(PathSyntax.hasGlob(pattern), true, pattern);
    }
});
