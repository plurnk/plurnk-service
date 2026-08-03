import assert from "node:assert/strict";
import test from "node:test";
import PathSyntax from "./PathSyntax.ts";

test("decodeParens decodes only the target-slot parenthesis spelling", () => {
    assert.equal(PathSyntax.decodeParens("/dir/file%28v1%29.txt"), "/dir/file(v1).txt");
    assert.equal(PathSyntax.decodeParens("/a%28b%29c%28d%29"), "/a(b)c(d)");
    assert.equal(
        PathSyntax.decodeParens("/50%off %20literal.txt"),
        "/50%off %20literal.txt",
    );
});

test("encodeParens is the model-facing inverse without general URL encoding", () => {
    assert.equal(PathSyntax.encodeParens("/wiki/Igor_(politician)"), "/wiki/Igor_%28politician%29");
    assert.equal(PathSyntax.encodeParens("/wiki/Igor_%28politician%29"), "/wiki/Igor_%28politician%29");
});
