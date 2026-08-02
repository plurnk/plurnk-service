// {§fs-namei} {§fs-canonical-name} {§fs-namespace} — the pure resolver, table-driven over
// every spelling class the model produces plus the adversarial set (traversal, NUL, the
// out-and-back-in aliasing, the root-mount degenerates). The aliasing property rides the
// table: every spelling of one file maps to ONE canonical key, and canon is a fixpoint.
import test from "node:test";
import assert from "node:assert/strict";
import Namespace from "./namespace.ts";

const ROOT = "/home/bob/project";

test("every spelling of a member resolves to its one canonical key — slash rule, dot resolution, out-and-back-in aliasing", () => {
    const cases: Array<[string, string | null]> = [
        // the slash rule (CWD=/): bare and slashed are one name
        ["example.md", "example.md"],
        ["/example.md", "example.md"],
        ["//example.md", "example.md"],
        ["src/main.js", "src/main.js"],
        ["/src/main.js", "src/main.js"],
        // dot segments resolve lexically before storage
        ["./example.md", "example.md"],
        ["src/./main.js", "src/main.js"],
        ["src/lib/../main.js", "src/main.js"],
        ["a/b/../../c.md", "c.md"],
        ["src//main.js", "src/main.js"],
        ["src/main.js/", "src/main.js"],
        // the owner's infinite-spellings class: walk out of the tree, walk back in — one name
        ["../project/example.md", "example.md"],
        ["../../bob/project/example.md", "example.md"],
        ["../../../home/bob/project/example.md", "example.md"],
        ["../../../home/bob/project/src/main.js", "src/main.js"],
        // leading mount runs that stay outside survive as declared-mount keys (git-style)
        ["../lib/x.md", "../lib/x.md"],
        ["../../shared/y.md", "../../shared/y.md"],
        ["/../lib/x.md", "../lib/x.md"],
        ["../lib/./x.md", "../lib/x.md"],
        ["../lib/sub/../x.md", "../lib/x.md"],
        // nothing a file entry can be
        ["", null],
        ["/", null],
        [".", null],
        ["./", null],
        ["..", null],
        ["../..", null],
        ["src/..", null],
        ["../project", null],                       // out-and-back-in onto the root itself
        ["bad\0name", null],
    ];
    for (const [spelling, expected] of cases) {
        assert.equal(Namespace.canonicalize(spelling, ROOT), expected, `canonicalize(${JSON.stringify(spelling)})`);
    }
});

test("canon is a fixpoint — the world-state invariant's predicate", () => {
    for (const key of ["example.md", "src/main.js", "../lib/x.md", "../../shared/y.md", "a-b_c.d/e f.md"]) {
        assert.equal(Namespace.canonicalize(key, ROOT), key, `${key} is its own canon`);
        assert.ok(Namespace.isCanonical(key, ROOT), `isCanonical(${key})`);
    }
    for (const spelling of ["/example.md", "./x.md", "src//y.md", "src/main.js/", "../project/example.md"]) {
        assert.ok(!Namespace.isCanonical(spelling, ROOT), `${spelling} is a spelling, not a canon`);
    }
});

test("the root-mount degenerate: at project_root=/ the jail is the whole filesystem — no mounts can exist, host-style spellings ARE member keys", () => {
    // The benchmark topology: /text.md on disk IS the member text.md. Same two rules,
    // no special case — and every '..' escape re-enters the tree by construction.
    assert.equal(Namespace.canonicalize("/text.md", "/"), "text.md");
    assert.equal(Namespace.canonicalize("text.md", "/"), "text.md");
    assert.equal(Namespace.canonicalize("/app/evaluator/functions.go", "/"), "app/evaluator/functions.go", "a root-mount path keeps its full key — nothing is special about 'app'");
    assert.equal(Namespace.canonicalize("../etc/passwd", "/"), "etc/passwd", "nothing is outside /: the mount notation degenerates to in-tree keys");
    assert.equal(Namespace.canonicalize("../../..", "/"), null, "the root itself is never an entry, from any spelling");
});
