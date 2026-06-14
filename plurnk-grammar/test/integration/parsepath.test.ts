import test from "node:test";
import assert from "node:assert/strict";
import { AstBuilder, PlurnkParseError } from "../../src/index.ts";

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
