import test from "node:test";
import assert from "node:assert/strict";
import { AstBuilder, PlurnkParseError, PlurnkParser } from "../../src/index.ts";

// AstBuilder.parsePath was promoted from private to public in 0.3.2 (issue #7)
// so consumer RPC layers can decompose path strings without round-tripping
// through a fake HEREDOC. As of the uniform-authority change, parsing is plain
// WHATWG with no per-scheme allowlist: `://` introduces an authority for every
// scheme; authority-less references use the empty-authority form `scheme:///path`.

test("parsePath: empty string returns null", () => {
    assert.equal(AstBuilder.parsePath(""), null);
});

test("parsePath: bare path returns kind=local", () => {
    const p = AstBuilder.parsePath("config/foo.xml");
    assert.ok(p);
    assert.equal(p?.kind, "local");
    if (p?.kind !== "local") return;
    assert.equal(p.raw, "config/foo.xml");
});

test("parsePath: glob bare path stays local", () => {
    const p = AstBuilder.parsePath("**/*.json");
    assert.equal(p?.kind, "local");
});

test("parsePath: HTTPS retains full authority decomposition", () => {
    const p = AstBuilder.parsePath("https://user:pw@example.com:8080/api?q=1#frag");
    assert.ok(p);
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pw");
    assert.equal(p.hostname, "example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/api");
    assert.deepEqual(p.params, { q: "1" });
    assert.equal(p.fragment, "frag");
});

test("parsePath: authority-less scheme uses three slashes — empty authority, leading-slash path", () => {
    const p = AstBuilder.parsePath("known:///philosophy/existentialism/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "known");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/philosophy/existentialism/meaning");
    assert.equal(p.port, null);
    assert.equal(p.username, null);
    assert.equal(p.password, null);
});

test("parsePath: two-slash now parses the first segment as host (uniform WHATWG, no allowlist)", () => {
    const p = AstBuilder.parsePath("known://philosophy/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.hostname, "philosophy");
    assert.equal(p.pathname, "/meaning");
});

test("parsePath: empty-authority scheme preserves params and fragment", () => {
    const p = AstBuilder.parsePath("wiki:///Paris?lang=fr#History");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
    assert.deepEqual(p.params, { lang: "fr" });
    assert.equal(p.fragment, "History");
});

test("parsePath: nested addressing stays whole in pathname", () => {
    const p = AstBuilder.parsePath("log:///1/turn/2/action/3/get");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "log");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/1/turn/2/action/3/get");
});

test("parsePath: file:// stays authority-bearing", () => {
    const p = AstBuilder.parsePath("file:///tmp/foo.txt");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

test("parsePath: throws PlurnkParseError on malformed URI", () => {
    assert.throws(
        () => AstBuilder.parsePath("http://[bad"),
        (err) => err instanceof PlurnkParseError && err.source === "visitor",
    );
});

test("parsePath: default position has line/column = 0", () => {
    // Verifying the optional-position contract.
    try {
        AstBuilder.parsePath("http://[bad");
        assert.fail("expected throw");
    } catch (err) {
        if (!(err instanceof PlurnkParseError)) throw err;
        assert.equal(err.line, 0);
        assert.equal(err.column, 0);
    }
});

test("parsePath: explicit position propagates to error", () => {
    try {
        AstBuilder.parsePath("http://[bad", { line: 7, column: 11 });
        assert.fail("expected throw");
    } catch (err) {
        if (!(err instanceof PlurnkParseError)) throw err;
        assert.equal(err.line, 7);
        assert.equal(err.column, 11);
    }
});

test("parsePath: multi-value params parse to array", () => {
    const p = AstBuilder.parsePath("https://example.com/?q=1&q=2");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.deepEqual(p.params, { q: ["1", "2"] });
});

// Path-name regex (`#pattern#flags`): a leading `#` dispatches a regex over path
// names, distinct from addressing a single path. `#` is collision-free — schemes
// never lead with it and `#channel` is a postfix.
test("parsePath: leading `#…#flags` returns kind=regex with split pattern/flags", () => {
    const p = AstBuilder.parsePath("#draft.*#i");
    if (p?.kind !== "regex") { assert.fail("expected regex"); return; }
    assert.equal(p.raw, "#draft.*#i");
    assert.equal(p.pattern, "draft.*");
    assert.equal(p.flags, "i");
});

test("parsePath: flagless path regex returns empty flags", () => {
    const p = AstBuilder.parsePath("#^known:///archive#");
    if (p?.kind !== "regex") { assert.fail("expected regex"); return; }
    assert.equal(p.pattern, "^known:///archive");
    assert.equal(p.flags, "");
});

test("parsePath: escaped `\\#` stays inside the pattern", () => {
    const p = AstBuilder.parsePath("#issue\\#42#");
    if (p?.kind !== "regex") { assert.fail("expected regex"); return; }
    assert.equal(p.pattern, "issue\\#42");
});

test("parsePath: leading `#` with no closing `#` falls back to local", () => {
    const p = AstBuilder.parsePath("#stdout");
    assert.equal(p?.kind, "local");
});

test("parsePath: leading `#` with invalid flags falls back to local", () => {
    const p = AstBuilder.parsePath("#a#zzz");
    assert.equal(p?.kind, "local");
});

// Request-metadata headers (#46): trailing `{key: value}` blocks split off a URL
// target before WHATWG decomposition, exposed as ordered pairs for the scheme
// handler (auth, content-type, method affordance). One header per block, so a
// value may hold commas/colons; the URL components reflect the stripped URL.
test("parsePath: single `{header}` block splits into an ordered pair; URL stays clean", () => {
    const p = AstBuilder.parsePath("https://api.github.com/user{Authorization: Bearer ghp_x}");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "https");
    assert.equal(p.hostname, "api.github.com");
    assert.equal(p.pathname, "/user");
    assert.deepEqual(p.headers, [["Authorization", "Bearer ghp_x"]]);
    assert.equal(p.raw, "https://api.github.com/user{Authorization: Bearer ghp_x}");
});

test("parsePath: multiple blocks preserve order", () => {
    const p = AstBuilder.parsePath("https://x.dev/a{Authorization: Bearer x}{Accept: application/json}");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.deepEqual(p.headers, [
        ["Authorization", "Bearer x"],
        ["Accept", "application/json"],
    ]);
});

test("parsePath: comma in a value is kept (block ends at `}`, not at `,`)", () => {
    const p = AstBuilder.parsePath("https://x.dev/a{Accept: text/html, application/json}");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.deepEqual(p.headers, [["Accept", "text/html, application/json"]]);
});

test("parsePath: only the first `:` splits key/value; internal colons stay in the value", () => {
    const p = AstBuilder.parsePath("https://x.dev/a{X-When: 12:00:00}");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.deepEqual(p.headers, [["X-When", "12:00:00"]]);
});

test("parsePath: duplicate header names survive (ordered pairs, not a map)", () => {
    const p = AstBuilder.parsePath("https://x.dev/a{Set-Cookie: a=1}{Set-Cookie: b=2}");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.deepEqual(p.headers, [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]);
});

test("parsePath: URL with no block has no headers field (back-compat)", () => {
    const p = AstBuilder.parsePath("https://x.dev/a");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal("headers" in p, false);
});

test("parsePath: a bare local path with literal braces is left untouched (no split)", () => {
    const p = AstBuilder.parsePath("config/a{b}.txt");
    assert.equal(p?.kind, "local");
    if (p?.kind !== "local") return;
    assert.equal(p.raw, "config/a{b}.txt");
});

test("parsePath: unclosed `{` in a URL target throws a visitor error", () => {
    assert.throws(
        () => AstBuilder.parsePath("https://x.dev/a{Authorization: Bearer x"),
        (err) => err instanceof PlurnkParseError && err.source === "visitor",
    );
});

test("parsePath: a keyless/colonless block throws a visitor error", () => {
    assert.throws(
        () => AstBuilder.parsePath("https://x.dev/a{no-colon-here}"),
        (err) => err instanceof PlurnkParseError && err.source === "visitor",
    );
});

test("parsePath: headers flow through a full parse to the statement target", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://api.dev/me{Authorization: Bearer x}{Accept: q})::READ");
    const item = result.items[0];
    if (item?.kind !== "statement") { assert.fail("expected statement"); return; }
    const { statement } = item;
    if (statement.op !== "READ" || statement.target?.kind !== "url") { assert.fail("expected READ with url target"); return; }
    assert.deepEqual(statement.target.headers, [["Authorization", "Bearer x"], ["Accept", "q"]]);
});
