import test from "node:test";
import assert from "node:assert/strict";
import { pathFolderSummaries, pathScope, pathScopeMatches } from "./_path-scope.ts";

test("terminal `*` is a complete one-level structural selector", () => {
    const scope = pathScope("src/*", true);
    assert.equal(pathScopeMatches(scope, "src/a.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/.hidden.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/deep/a.ts"), false);
    assert.equal(pathScopeMatches(scope, "other/a.ts"), false);
});

test("terminal `**` is a complete recursive structural selector", () => {
    const root = pathScope("**", true);
    assert.equal(pathScopeMatches(root, ".env.defaults"), true);
    assert.equal(pathScopeMatches(root, ".github/workflows/ci.yml"), true);

    const nested = pathScope("src/**", true);
    assert.equal(pathScopeMatches(nested, "src/a.ts"), true);
    assert.equal(pathScopeMatches(nested, "src/.internal/a.ts"), true);
    assert.equal(pathScopeMatches(nested, "other/a.ts"), false);
});

test("richer path patterns retain native shell-glob semantics", () => {
    const scope = pathScope("src/**/*.ts", true);
    assert.equal(pathScopeMatches(scope, "src/a.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/deep/a.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/.internal/a.ts"), false);
    assert.equal(pathScopeMatches(scope, "src/deep/a.go"), false);
});

test("a `**` glued to a name still crosses directories: `**.go` is `**/*.go` (run67)", () => {
    const glued = pathScope("**.go", true);
    assert.equal(pathScopeMatches(glued, "main.go"), true);
    assert.equal(pathScopeMatches(glued, "terminal/history.go"), true, "the taught rule: `**` crosses directories");
    assert.equal(pathScopeMatches(glued, "a/b/c.go"), true);
    assert.equal(pathScopeMatches(glued, "main.gox"), false);
    assert.equal(pathScopeMatches(glued, "docs/readme.md"), false);
    const nested = pathScope("src/**.ts", true);
    assert.equal(pathScopeMatches(nested, "src/c.ts"), true);
    assert.equal(pathScopeMatches(nested, "src/a/b.ts"), true);
    assert.equal(pathScopeMatches(nested, "lib/a.ts"), false);
    const suffixed = pathScope("**_test.go", true);
    assert.equal(pathScopeMatches(suffixed, "pkg/x_test.go"), true);
    assert.equal(pathScopeMatches(suffixed, "pkg/x.go"), false);
});

test("generic path bracket segments remain native character classes", () => {
    const scope = pathScope("src/[ab].ts", true);
    assert.equal(pathScopeMatches(scope, "src/a.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/b.ts"), true);
    assert.equal(pathScopeMatches(scope, "src/ab.ts"), false);
    assert.equal(pathScopeMatches(scope, "src/c.ts"), false);
});

test("an empty declared folder root is a recursive collection", () => {
    const scope = pathScope("", true);
    assert.equal(scope.kind, "folder");
    assert.equal(pathScopeMatches(scope, "src/a.ts"), true);
});

test("one-level maps group every deeper entry under exact recursive selectors", () => {
    const scope = pathScope("*", true);
    assert.deepEqual(pathFolderSummaries(scope, [
        ".env.defaults",
        ".github/workflows/ci.yml",
        "README.md",
        "src/a.ts",
        "src/deep/b.ts",
    ]), [
        { selector: ".github/**", pathnames: [".github/workflows/ci.yml"] },
        { selector: "src/**", pathnames: ["src/a.ts", "src/deep/b.ts"] },
    ]);
});
