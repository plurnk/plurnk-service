import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { parsePath } from "@plurnk/plurnk-parser";
import FileAddress from "./FileAddress.ts";
import Namespace from "./namespace.ts";
import { pathScope, pathScopeMatches } from "../schemes/_path-scope.ts";

test("{§file-url} native file URLs decode once, independently of bare-path aliases", () => {
    const paths = ["~/file.txt", "space name", "café", "literal%20", "literal%28", "literal%29", "literal%2F", "50%off", "a(b)", "a#b", "a?b", "a*b", "a[b]", "a{b}", "a\\b", "a<b", "a\nb"];
    for (const key of paths) {
        const absolute = `/project/${key}`;
        const target = parsePath(pathToFileURL(absolute).href)!;
        assert.equal(FileAddress.pathname(target), absolute, key);
    }
    assert.equal(FileAddress.pathname(parsePath("literal%20")!), "literal%20");
    assert.equal(FileAddress.pathname(parsePath("a%28b%29")!), "a(b)");
    assert.equal(FileAddress.pathname(parsePath("file://localhost/project/a%23b#body")!), "/project/a#b");
});

test("{§file-url} unsupported file URLs are explicit operation failures", () => {
    for (const [target, detail] of [
        ["file:///project/a%2Fb", /encoded \/ characters/u],
        ["file:///project/a%00b", /NUL/u],
        ["file:///project/a%xyb", /URI malformed/u],
        ["file:///project/%FF", /URI malformed/u],
        ["file://remote/project/a", /localhost.*empty/u],
    ] as const) {
        const result = FileAddress.pathname(parsePath(target)!);
        assert.notEqual(typeof result, "string", target);
        if (typeof result === "string") assert.fail(target);
        assert.equal(result.status, 400, target);
        assert.match(result.problem!.type, /invalid-file-url$/u);
        assert.match(result.problem!.detail, detail);
    }
});

test("{§fs-canonical-name} rendered file addresses preserve literal names and default channels", () => {
    for (const key of ["normal.txt", "~/literal", "space name", " leading", "trailing ", "a\tb", "a(b)", "literal%28", "literal%29", "a#b", "a<b", "a\nb", "a*b", "a?b", "a[b]", "a{b}", "a\\b", "@(a)"]) {
        const spelling = FileAddress.render(key, "/project");
        const parsed = parsePath(spelling)!;
        assert.ok(parsed);
        assert.ok(parsed.fragment == null, spelling);
        assert.equal(FileAddress.isPattern(parsed), false, spelling);
        const pathname = FileAddress.pathname(parsed);
        assert.equal(typeof pathname, "string");
        assert.equal(Namespace.canonicalizeSpelling(pathname as string, "/project"), key, spelling);
    }
    assert.equal(FileAddress.render("normal.txt", "/project"), "normal.txt");
    assert.equal(FileAddress.render("literal%20", "/project"), "literal%20");
    assert.equal(FileAddress.render("a(b)", "/project"), "a%28b%29");
    assert.equal(FileAddress.render("a#b", "/project"), "file:///project/a%23b");
    assert.throws(() => FileAddress.render("a#b", null), /requires its project root/u);
    // {§file-path-normalization} A key beyond the root is the absolute path it names; the spelling round-trips.
    for (const [key, spelling] of [["../shared/a.md", "/shared/a.md"], ["../../tmp/x/", "/tmp/x/"], ["..", "/"], ["../a#b", "file:///a%23b"]]) {
        assert.equal(FileAddress.render(key, "/project"), spelling, key);
    }
    assert.equal(Namespace.canonicalizeSpelling("/shared/a.md", "/project"), "../shared/a.md");
    assert.equal(FileAddress.render("../shared/a.md", null), "../shared/a.md", "without a root there is nothing to resolve against");
});

test("{§file-url} URI-encoded glob characters remain data beside authored selectors", () => {
    const target = parsePath("file:///project/dir%3F%5Ba%5D/*.txt")!;
    assert.equal(FileAddress.isPattern(target), true);
    assert.equal(FileAddress.selector(target), String.raw`/project/dir\?\[a\]/*.txt`);
    const scope = pathScope(FileAddress.selector(target) as string, true);
    assert.equal(pathScopeMatches(scope, "/project/dir?[a]/file.txt"), true);
    assert.equal(pathScopeMatches(scope, "/project/dirxa/file.txt"), false);
    for (const character of ["*", "?", "[", "]", "{", "}", "(", ")", "\\"]) {
        const encoded = `%${character.charCodeAt(0).toString(16)}`;
        const pattern = FileAddress.selector(parsePath(`file:///project/a${encoded}b/*.txt`)!);
        assert.equal(typeof pattern, "string");
        assert.equal(pathScopeMatches(pathScope(pattern as string, true), `/project/a${character}b/file.txt`), true, character);
        assert.equal(pathScopeMatches(pathScope(pattern as string, true), "/project/axb/file.txt"), false, character);
    }
    assert.equal(FileAddress.selector(parsePath("file:///project/literal%2A.txt")!), "/project/literal*.txt");
    const backslash = pathScope(FileAddress.selector(parsePath("file:///project/dir%5Cname/*.txt")!) as string, true);
    assert.equal(pathScopeMatches(backslash, String.raw`/project/dir\name/file.txt`), true);
    assert.equal(pathScopeMatches(backslash, "/project/dir/name/file.txt"), false);
    assert.equal(pathScopeMatches(backslash, "/project/dirname/file.txt"), false);
    const rooted = FileAddress.selector(parsePath("file:///project%5Bbase%5D/dir%3F/*.txt")!, "/project[base]");
    assert.equal(Namespace.canonicalizeSpelling(rooted as string, "/project[base]"), String.raw`dir\?/*.txt`, "the real base never becomes glob syntax");
    assert.equal(FileAddress.selector(parsePath("file:///project%5Cbase/*.txt")!, "/project\\base"), "/project\\base/*.txt", "literal base characters never reach the matcher");
});

test("{§file-url} rendered selectors preserve literal metacharacters separately from glob syntax", () => {
    for (const spelling of ["file:///project/dir%2A/*.txt", "file:///project/dir%3F/@(a|b).txt", "file:///project/{a,b}.txt"]) {
        const target = parsePath(spelling)!;
        const rendered = FileAddress.renderSelector("not-a-literal-key", target);
        assert.equal(FileAddress.selector(parsePath(rendered)!), FileAddress.selector(target));
    }
    assert.equal(FileAddress.renderSelector("src/*.ts", parsePath("/project/src/*.ts")!), "src/*.ts");
    assert.equal(FileAddress.selector(parsePath("file:///project/{a,b}.txt")!), "/project/{a,b}.txt");
});
