import test from "node:test";
import assert from "node:assert/strict";
import Namespace from "./namespace.ts";

const ROOT = "/home/bob/project";

test("{§fs-home} authored home paths resolve once before project-relative translation", () => {
    const home = "/home/bob";
    const cases: [string, string | null, string | null][] = [
        ["~/x.md", ROOT, "../x.md"],
        ["~/x.md", "/work/project", "../../home/bob/x.md"],
        ["~/x.md", home, "x.md"],
        ["~/x.md", "/", "home/bob/x.md"],
        ["~", ROOT, "../"],
        ["~", home, ""],
        ["~/", ROOT, "../"],
        ["~//x.md", ROOT, "../x.md"],
        ["~/project/../x.md", ROOT, "../x.md"],
        ["~/project/*.md", ROOT, "*.md"],
        ["~", null, null],
        ["~/x.md", null, null],
        ["./~/x.md", ROOT, "~/x.md"],
        ["./~/x.md", null, "~/x.md"],
        ["a/../~/x.md", ROOT, "~/x.md"],
        ["~someone/x.md", ROOT, "~someone/x.md"],
        ["~someone/x.md", null, "~someone/x.md"],
        ["./~", ROOT, "~"],
        ["~/bad\0name", ROOT, null],
    ];
    for (const [spelling, root, expected] of cases) {
        assert.equal(Namespace.canonicalizeSpelling(spelling, root, home), expected, `${root}: ${spelling}`);
    }
});

test("{§fs-home} literal keys stay unchanged and displayed addresses round-trip", () => {
    for (const root of [ROOT, "/", null]) {
        for (const key of ["~", "~/x.md", "~/nested/~", "~someone/x.md", "src/~/x.md", "plain.md"]) {
            assert.equal(Namespace.canonicalize(key, root), key);
            assert.equal(Namespace.isCanonical(key, root), true);
            const spelling = Namespace.literalSpelling(key);
            assert.equal(spelling, key === "~" || key.startsWith("~/") ? `./${key}` : key);
            assert.equal(Namespace.canonicalizeSpelling(spelling, root, "/other/home"), key);
        }
    }
    assert.equal(Namespace.fromRepositoryPath("project/~/x.md", "/repo/project", "/repo"), "~/x.md");
});

test("{§fs-namei} filesystem spellings resolve to one project-relative file key", () => {
    const cases: Array<[string, string | null]> = [
        ["example.md", "example.md"],
        [`${ROOT}/example.md`, "example.md"],
        [`/${ROOT}/example.md`, "example.md"],
        ["/example.md", "../../../example.md"],
        ["//example.md", "../../../example.md"],
        ["src/main.js", "src/main.js"],
        ["/src/main.js", "../../../src/main.js"],
        // dot segments resolve lexically before storage
        ["./example.md", "example.md"],
        ["src/./main.js", "src/main.js"],
        ["src/lib/../main.js", "src/main.js"],
        [`${ROOT}/src/lib/../main.js`, "src/main.js"],
        ["a/b/../../c.md", "c.md"],
        ["src//main.js", "src/main.js"],
        ["src/main.js/", "src/main.js"],
        ["../project/example.md", "example.md"],
        ["../../bob/project/example.md", "example.md"],
        ["../../../home/bob/project/example.md", "example.md"],
        ["../../../home/bob/project/src/main.js", "src/main.js"],
        // leading mount runs that stay outside survive as declared-mount keys (git-style)
        ["../lib/x.md", "../lib/x.md"],
        ["../../shared/y.md", "../../shared/y.md"],
        ["/../lib/x.md", "../../../lib/x.md"],
        ["../lib/./x.md", "../lib/x.md"],
        ["../lib/sub/../x.md", "../lib/x.md"],
        [`${ROOT}-other/x.md`, "../project-other/x.md"],
        // nothing a file entry can be
        ["", null],
        ["/", null],
        [".", null],
        ["./", null],
        ["..", null],
        ["../..", null],
        ["src/..", null],
        ["../project", null],                       // out-and-back-in onto the root itself
        [ROOT, null],
        ["bad\0name", null],
    ];
    for (const [spelling, expected] of cases) {
        assert.equal(Namespace.canonicalize(spelling, ROOT), expected, `canonicalize(${JSON.stringify(spelling)})`);
    }
});

test("{§fs-canonical-name} canonical keys are project-relative fixpoints", () => {
    for (const key of ["example.md", "src/main.js", "../lib/x.md", "../../shared/y.md", "a-b_c.d/e f.md", "文/稿.md"]) {
        assert.equal(Namespace.canonicalize(key, ROOT), key, `${key} is its own canon`);
        assert.ok(Namespace.isCanonical(key, ROOT), `isCanonical(${key})`);
    }
    for (const spelling of ["/example.md", `${ROOT}/example.md`, "./x.md", "src//y.md", "src/main.js/", "../project/example.md"]) {
        assert.ok(!Namespace.isCanonical(spelling, ROOT), `${spelling} is a spelling, not a canon`);
    }
});

test("{§fs-namei} Git paths resolve from the containing repository, including a root-mounted repository", () => {
    assert.equal(Namespace.fromRepositoryPath("project/src/x.ts", "/repo/project", "/repo"), "src/x.ts");
    assert.equal(Namespace.fromRepositoryPath("project/src/x.ts", "/project", "/"), "src/x.ts");
    assert.equal(Namespace.fromRepositoryPath("shared/x.ts", "/project", "/"), "../shared/x.ts");
    assert.throws(() => Namespace.fromRepositoryPath("../escape", "/repo/project", "/repo"), /escapes its repository/u);
});

test("{§fs-namespace} root-mounted workspaces use the same resolver", () => {
    assert.equal(Namespace.canonicalize("/text.md", "/"), "text.md");
    assert.equal(Namespace.canonicalize("text.md", "/"), "text.md");
    assert.equal(Namespace.canonicalize("/app/evaluator/functions.go", "/"), "app/evaluator/functions.go", "a root-mount path keeps its full key — nothing is special about 'app'");
    assert.equal(Namespace.canonicalize("../etc/passwd", "/"), "etc/passwd", "nothing is outside /: the mount notation degenerates to in-tree keys");
    assert.equal(Namespace.canonicalize("../../..", "/"), null, "the root itself is never an entry, from any spelling");
    assert.equal(Namespace.canonicalizeSpelling("/", "/"), "");
});

test("{§fs-namei} collection and glob addresses retain filesystem coordinates", () => {
    const cases: [string, string][] = [
        ["", ""], [".", ""], ["./", ""], [ROOT, ""], [`${ROOT}/`, ""],
        ["/", "../../../"], ["..", "../"], ["../..", "../../"],
        [`${ROOT}/src/`, "src/"], [`${ROOT}/src/*.ts`, "src/*.ts"],
        ["/other/**/*.ts", "../../../other/**/*.ts"],
        ["../project/src/", "src/"], ["src/../", ""],
    ];
    for (const [spelling, expected] of cases) {
        assert.equal(Namespace.canonicalizeSpelling(spelling, ROOT), expected, spelling);
    }
    assert.equal(Namespace.canonicalizeSpelling("bad\0name/", ROOT), null);
});

test("{§fs-namespace} headless canonicalization never invents a filesystem base", () => {
    assert.equal(Namespace.canonicalize("src/./x.md", null), "src/x.md");
    assert.equal(Namespace.canonicalize("../x.md", null), "../x.md");
    assert.equal(Namespace.canonicalize("/src/x.md", null), null);
    assert.equal(Namespace.canonicalizeSpelling("/", null), null);
    assert.equal(Namespace.canonicalizeSpelling("/src/", null), null);
});
