import test from "node:test";
import assert from "node:assert/strict";
import AstBuilder from "../../src/AstBuilder.ts";
import { PathSyntax, PlurnkParseError, PlurnkParser, WORKER_NAME, RESERVED_AUTHORITIES } from "../../src/index.ts";

// {§path-syntax} Detailed target admission behind the public parsePath helper.

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
    assert.equal(p.query, "q=1");
    assert.equal(p.fragment, "frag");
});

test("parsePath: authority-less scheme uses three slashes — empty authority, leading-slash path", () => {
    const p = AstBuilder.parsePath("worker:///philosophy/existentialism/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "worker");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/philosophy/existentialism/meaning");
    assert.equal(p.port, null);
    assert.equal(p.username, null);
    assert.equal(p.password, null);
});

test("parsePath: two-slash URL parses the first segment as its host", () => {
    const p = AstBuilder.parsePath("known://philosophy/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.hostname, "philosophy");
    assert.equal(p.pathname, "/meaning");
});

test("parsePath: empty-authority scheme preserves query and fragment", () => {
    const p = AstBuilder.parsePath("wiki:///Paris?lang=fr#History");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
    assert.equal(p.query, "lang=fr");
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

test("parsePath: query preserves ordering and duplicate names", () => {
    const p = AstBuilder.parsePath("https://example.com/?q=1&lang=en&q=2");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.query, "q=1&lang=en&q=2");
});

test("parsePath: absent and explicitly empty queries remain distinct", () => {
    const absent = AstBuilder.parsePath("https://example.com/");
    const empty = AstBuilder.parsePath("https://example.com/?");
    if (absent?.kind !== "url" || empty?.kind !== "url") { assert.fail("expected urls"); return; }
    assert.equal(absent.query, null);
    assert.equal(empty.query, "");
});

test("parsePath: hash-leading spellings are ordinary local paths", () => {
    for (const raw of ["#stdout", "#draft.*#i", "#issue\\#42#"]) {
        const p = AstBuilder.parsePath(raw);
        assert.equal(p?.kind, "local");
        assert.equal(p?.raw, raw);
    }
});

test("parsePath: a bare local path with literal braces is left untouched (no split)", () => {
    const p = AstBuilder.parsePath("config/a{b}.txt");
    assert.equal(p?.kind, "local");
    if (p?.kind !== "local") return;
    assert.equal(p.raw, "config/a{b}.txt");
});

test("parsePath: schemed brace globs remain path syntax and encoded braces remain literal", () => {
    const glob = AstBuilder.parsePath("log:///1/[1-7]/*/{PLAN,READ}");
    assert.equal(glob?.kind, "url");
    if (glob?.kind !== "url") return;
    assert.equal(glob.pathname, "/1/[1-7]/*/{PLAN,READ}");
    assert.equal(PathSyntax.hasGlob(glob.pathname), true);

    const literal = AstBuilder.parsePath("log:///1/%7BPLAN,READ%7D");
    assert.equal(literal?.kind, "url");
    if (literal?.kind !== "url") return;
    assert.equal(literal.pathname, "/1/%7BPLAN,READ%7D");
    assert.equal(PathSyntax.hasGlob(literal.pathname), false);
});

test("malformed URL diagnostics do not relay native parser text", () => {
    assert.throws(
        () => AstBuilder.parsePath("https://uri-user:uri-password@[bad"),
        (error) => error instanceof PlurnkParseError
            && error.source === "visitor"
            && error.message === "invalid URI in path",
    );
});

// {§path-syntax} Scheme-generic decomposition keeps the WebSocket surface reachable.
test("parsePath: ws:// and wss:// decompose as UrlPath (scheme, host, port, query)", () => {
    const ws = AstBuilder.parsePath("ws://api.example.com/feed");
    assert.equal(ws?.kind, "url");
    if (ws?.kind !== "url") return;
    assert.equal(ws.scheme, "ws");
    assert.equal(ws.hostname, "api.example.com");
    assert.equal(ws.pathname, "/feed");

    const wss = AstBuilder.parsePath("wss://api.example.com:8443/feed?room=x");
    assert.equal(wss?.kind, "url");
    if (wss?.kind !== "url") return;
    assert.equal(wss.scheme, "wss");
    assert.equal(wss.port, 8443);
    assert.equal(wss.query, "room=x");
});

test("parsePath: the ws op trio (READ open+stream, SEND push, KILL close) parses to url targets", () => {
    const src = [
        "## READ0 (ws://api.example.com/feed)",
        "",
        "## SEND0 (wss://api.example.com/feed)",
        "hello",
        "",
        "## KILL0 (ws://api.example.com/feed)",
    ].join("\n");
    const result = PlurnkParser.parseStatements(src);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const schemes = result.items
        .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
        .map((i) => ("target" in i.statement && i.statement.target?.kind === "url" ? i.statement.target.scheme : null));
    assert.deepEqual(schemes, ["ws", "wss", "ws"]);
});

// {§worker-name} The mintable worker-name contract is a lowercase DNS label. The single
// source core's auto-namer and schemes' registry derive from. The parser stays permissive
// (any authority decomposes); this pins the CONTRACT constant, not ingestion behavior.
test("worker-name contract: WORKER_NAME is a lowercase DNS label", () => {
    for (const ok of ["alice", "child3", "brisk-otter", "3com", "a", "self", "plurnk"]) {
        assert.ok(WORKER_NAME.test(ok), `${ok} must be mintable`);
    }
    for (const bad of ["Alice", "-lead", "trail-", "under_score", "dot.name", "~", "", "sp ace"]) {
        assert.ok(!WORKER_NAME.test(bad), `${bad} must NOT be mintable`);
    }
    assert.deepEqual([...RESERVED_AUTHORITIES], ["commons", "plurnk"]);
});

test("worker-name contract: the case footgun is real — parser preserves authority case", () => {
    // WHY lowercase-only: non-special schemes do not lowercase the authority, so `Alice` and
    // `alice` would be distinct principals. The charset closes the whole class at minting.
    const upper = AstBuilder.parsePath("worker://Alice/x");
    const lower = AstBuilder.parsePath("worker://alice/x");
    if (upper?.kind !== "url" || lower?.kind !== "url") { assert.fail("both must decompose"); return; }
    assert.equal(upper.hostname, "Alice");
    assert.equal(lower.hostname, "alice");
    assert.notEqual(upper.hostname, lower.hostname);
});

test("worker-name contract: `~` decomposes as a one-char authority but is outside the mintable alphabet", () => {
    const p = AstBuilder.parsePath("worker://~/draft");
    if (p?.kind !== "url") { assert.fail("~ authority must decompose"); return; }
    assert.equal(p.hostname, "~");
    assert.ok(!WORKER_NAME.test("~"));
});
