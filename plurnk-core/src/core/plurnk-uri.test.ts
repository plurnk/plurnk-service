import test, { describe } from "node:test";
import assert from "node:assert/strict";
import FileAddress from "./FileAddress.ts";
import Namespace from "./namespace.ts";
import { parsePath } from "@plurnk/plurnk-parser";
import { entryAddress, entryCoordinateOf, foldAuthorityIntoPath, missExtensions, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import { pathToFileURL } from "node:url";
import { pathScope, pathScopeMatches } from "../schemes/_path-scope.ts";

describe("plurnk-uri", () => {
// Entry authority is an explicit durable coordinate. Namespace schemes fold it,
// resource schemes preserve it, and owner schemes consume it outside entry identity.





test("{§fs-namespace} file address renderers protect literal home-like names", () => {
    for (const [key, expected] of [["~", "./~"], ["~/x.md", "./~/x.md"], ["~/a(b).md", "./~/a%28b%29.md"], ["~someone/x", "~someone/x"], ["src/~/x", "src/~/x"]] as const) {
        assert.equal(entryAddress("file", "", key), expected);
        assert.equal(renderTarget({ scheme: null, pathname: key }), expected);
        assert.equal(missExtensions("file", entryAddress("file", "", key)).target, expected);
    }
    assert.equal(entryAddress("session", "alice", "/~/x"), "session://alice/~/x", "non-file paths are untouched");
    const escaped = entryAddress("file", "", "~/a\\b", "/project");
    assert.equal(escaped, "file:///project/%7E/a%5Cb");
    assert.equal(missExtensions("file", escaped).target, escaped, "a rendered address is not escaped twice");
});

test("{§scheme-address} foldAuthorityIntoPath folds a namespace authority into the canonical path", () => {
    assert.equal(foldAuthorityIntoPath("docs", "/x.md"), "/docs/x.md");
    assert.equal(foldAuthorityIntoPath("skills", "/x.md"), "/skills/x.md");
    // no authority → unchanged (empty-authority schemes are a no-op)
    assert.equal(foldAuthorityIntoPath(null, "/manifest.json"), "/manifest.json");
    assert.equal(foldAuthorityIntoPath(null, "/docs/x.md"), "/docs/x.md");
});

test("{§manifest} {§scheme-address} entryCoordinateOf distinguishes namespace and resource authority", () => {
    const notes = parsePath("notes://docs/fact.md");
    const mcp = parsePath("mcp://researcher/tasks/t-1");
    const session = parsePath("session://ada/task");
    assert.ok(notes);
    assert.ok(mcp);
    assert.ok(session);
    assert.deepEqual(entryCoordinateOf(notes, "namespace"), {
        authority: "",
        pathname: "/docs/fact.md",
    });
    assert.deepEqual(entryCoordinateOf(mcp, "resource"), {
        authority: "researcher",
        pathname: "/tasks/t-1",
    });
    assert.deepEqual(entryCoordinateOf(session, "resource"), {
        authority: "ada",
        pathname: "/task",
    });
});

test("{§scheme-address} resource entry identity preserves canonical authority, port, and serialized query", () => {
    const target = parsePath("https://Example.org:8443/a%28b%29?b=2&a=1&a=3#preview");
    assert.ok(target);
    assert.deepEqual(entryCoordinateOf(target, "resource"), {
        authority: "example.org:8443",
        pathname: "/a(b)?b=2&a=1&a=3",
    });
});

test("{§scheme-address} renderAddress renders only the durable entry coordinate", () => {
    assert.equal(renderAddress({ scheme: "notes", authority: "", pathname: "/docs/x.md" }), "notes:///docs/x.md");
    assert.equal(renderAddress({ scheme: "mcp", authority: "researcher", pathname: "/tasks/t-1" }), "mcp://researcher/tasks/t-1");
    assert.equal(renderAddress({ scheme: "https", authority: "example.org:8443", pathname: "/a(b)?x=1" }), "https://example.org:8443/a%28b%29?x=1");
});

test("{§path-syntax} renderAddress preserves literal and percent-encoded network query parentheses", () => {
    assert.equal(
        renderAddress({
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
        }),
        String.raw`https://example.test/x?literal=\)&encoded=%29`,
    );
});

test("{§scheme-address}: http routes through https and ws routes through wss", () => {
    assert.equal(schemeNameOf(parsePath("https://example.org/x")), "https");
    assert.equal(schemeNameOf(parsePath("http://example.org/x")), "https", "plain http folds into the https face (#340)");
    assert.equal(schemeNameOf(parsePath("wss://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("ws://example.org/socket")), "wss");
    assert.equal(schemeNameOf(parsePath("notes:///fact")), "notes");
});

test("{§path-syntax} renderTarget is the non-secret inverse for decomposed operation targets", () => {
    assert.equal(renderTarget({
        scheme: "https",
        hostname: "example.org",
        port: 8443,
        pathname: "/a(b)",
        query: "b=(2)&a=%281%29&a=3",
        fragment: "pre(view)",
    }), String.raw`https://example.org:8443/a%28b%29?b=\(2\)&a=%281%29&a=3#pre\(view\)`);
    assert.equal(renderTarget({
        scheme: "session",
        hostname: "ada",
        port: null,
        pathname: "/task",
        query: null,
        fragment: null,
    }), "session://ada/task");
    assert.equal(renderTarget({
        scheme: null,
        pathname: "/docs/a(b).md",
    }), "docs/a%28b%29.md");
});

test("{§path-syntax} renderTarget round-trips exact URI query and fragment spelling through the target lexer", () => {
    const rendered = renderTarget({
        scheme: "https",
        hostname: "example.org",
        pathname: "/x",
        query: "literal=)&encoded=%29&slash=\\",
        fragment: "preview(\\",
    });
    assert.equal(
        rendered,
        String.raw`https://example.org/x?literal=\)&encoded=%29&slash=\\#preview\(\\`,
    );
    const parsed = parsePath(rendered ?? "");
    if (parsed?.kind !== "url") assert.fail("expected rendered URL target");
    assert.equal(parsed.query, "literal=)&encoded=%29&slash=\\");
    assert.equal(parsed.fragment, "preview(\\");
});
});

describe("FileAddress", () => {
test("{§fs-namespace} native file URLs decode once, independently of bare-path aliases", () => {
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

test("{§fs-namespace} unsupported file URLs are explicit operation failures", () => {
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

test("{§fs-namespace} rendered file addresses preserve literal names and default channels", () => {
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
    // {§fs-namespace} A key beyond the root is the absolute path it names; the spelling round-trips.
    for (const [key, spelling] of [["../shared/a.md", "/shared/a.md"], ["../../tmp/x/", "/tmp/x/"], ["..", "/"], ["../a#b", "file:///a%23b"]]) {
        assert.equal(FileAddress.render(key, "/project"), spelling, key);
    }
    assert.equal(Namespace.canonicalizeSpelling("/shared/a.md", "/project"), "../shared/a.md");
    assert.equal(FileAddress.render("../shared/a.md", null), "../shared/a.md", "without a root there is nothing to resolve against");
});

test("{§fs-namespace} URI-encoded glob characters remain data beside authored selectors", () => {
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

test("{§fs-namespace} rendered selectors preserve literal metacharacters separately from glob syntax", () => {
    for (const spelling of ["file:///project/dir%2A/*.txt", "file:///project/dir%3F/@(a|b).txt", "file:///project/{a,b}.txt"]) {
        const target = parsePath(spelling)!;
        const rendered = FileAddress.renderSelector("not-a-literal-key", target);
        assert.equal(FileAddress.selector(parsePath(rendered)!), FileAddress.selector(target));
    }
    assert.equal(FileAddress.renderSelector("src/*.ts", parsePath("/project/src/*.ts")!), "src/*.ts");
    assert.equal(FileAddress.selector(parsePath("file:///project/{a,b}.txt")!), "/project/{a,b}.txt");
});
});
