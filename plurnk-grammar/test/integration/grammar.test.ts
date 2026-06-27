import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, PlurnkParseError, parsePath } from "../../src/index.ts";

const statementsOf = (input: string) =>
    PlurnkParser.parseStatements(input).items.filter((i) => i.kind === "statement");

const errorsOf = (input: string) =>
    PlurnkParser.parseStatements(input).items.filter((i) => i.kind === "error").map((i) => i.error);

// -------------------------------------------------------------------------
// Single-statement parses
// -------------------------------------------------------------------------

test("ex 3 — simple EDIT with body", () => {
    assert.equal(statementsOf("<<EDIT(known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT").length, 1);
});

test("ex 4 — bare READ, empty body", () => {
    assert.equal(statementsOf("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ").length, 1);
});

test("ex 12 — EDIT with empty body (clear)", () => {
    assert.equal(statementsOf("<<EDIT(known://countries/france/capital)::EDIT").length, 1);
});

test("ex 17 — SEND with signal, no path", () => {
    assert.equal(statementsOf("<<SEND[102]:decomposed prompt; plan initialized:SEND").length, 1);
});

test("ex 6 — EDIT with signal, path, and body", () => {
    assert.equal(statementsOf("<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT").length, 1);
});

test("ex 8 — EDIT with single-line marker", () => {
    assert.equal(statementsOf("<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT").length, 1);
});

test("ex 21 — FIND with range pagination, empty body", () => {
    assert.equal(statementsOf("<<FIND(known://**)<1-20>::FIND").length, 1);
});

test("body containing literal OP keyword (no false-match)", () => {
    assert.equal(statementsOf("<<EDIT(p):the EDIT command takes a path:EDIT").length, 1);
});

test("body starting with bare paren (modifier-like content)", () => {
    assert.equal(statementsOf("<<EDIT(p):() abc:EDIT").length, 1);
});

test("body containing internal colons (predicate falsifies)", () => {
    assert.equal(statementsOf("<<EDIT(p):key:value:more:stuff:EDIT").length, 1);
});

test("ex 31 — nested EDIT via suffix discipline", () => {
    const input = "<<EDITouter(known://demo):quoted: <<EDIT(known://inner):hello world:EDIT:EDITouter";
    assert.equal(statementsOf(input).length, 1);
});

// -------------------------------------------------------------------------
// Multi-statement parses
// -------------------------------------------------------------------------

test("two statements in sequence", () => {
    const input = "<<EDIT(p)::EDIT<<READ(q)::READ";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("interstatement whitespace is hidden, not captured as text", () => {
    const input = "<<EDIT(p)::EDIT\n\n<<READ(q)::READ";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    // whitespace is a hidden token now — pure inter-op whitespace surfaces no text items
    assert.equal(result.items.filter((i) => i.kind === "text").length, 0);
});

// -------------------------------------------------------------------------
// Per-statement error recovery
// -------------------------------------------------------------------------

test("three valid statements in sequence parse independently", () => {
    const input = "<<EDIT(p1):one:EDIT\n<<EDIT(p2):two:EDIT\n<<EDIT(p3):three:EDIT";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 3);
});

test("malformed path (unclosed paren) produces error, not silent swallowing", () => {
    // Statement 2's path is missing its `)`. With tightened PATH_INNER,
    // the lexer rejects `<<` inside path content and produces an error
    // instead of greedily consuming statement 3.
    const input = "<<EDIT(p1):one:EDIT<<EDIT(broken<<EDIT(p3):three:EDIT";
    const result = PlurnkParser.parseStatements(input);
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1, "expected at least one error from malformed path");
});

test("error carries line, column, and source", () => {
    // Malformed: missing close.
    const input = "<<EDIT(p):body without close";
    const result = PlurnkParser.parseStatements(input);
    const errs = errorsOf(input);
    assert.ok(errs.length >= 1 || result.unparsedTail);
    if (errs.length >= 1) {
        const e = errs[0];
        assert.equal(typeof e.line, "number");
        assert.equal(typeof e.column, "number");
        assert.ok(e.source === "lexer" || e.source === "parser");
        assert.ok(e instanceof PlurnkParseError);
    }
});

test("boundary-destroying error produces unparsedTail", () => {
    // No close tag at all: lexer stuck in BODY mode at EOF.
    const result = PlurnkParser.parseStatements("<<EDIT(p):body never closed");
    assert.ok(result.unparsedTail, "expected unparsedTail to be set");
});

test("clean parse has no unparsedTail", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):body:EDIT");
    assert.equal(result.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// Domain AST shape
// -------------------------------------------------------------------------

test("AST: minimal EDIT extracts op, suffix, body", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):hello:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    const s = item.statement;
    assert.equal(s.op, "EDIT");
    assert.equal(s.suffix, "");
    assert.equal(s.target?.kind, "local");
    assert.equal(s.target?.raw, "p");
    assert.equal(s.body, "hello");
    assert.equal(s.signal, null);
    assert.equal(s.lineMarker, null);
});

test("AST: suffix is extracted on nested outer", () => {
    const result = PlurnkParser.parseStatements("<<EDITouter(p):body:EDITouter");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.op, "EDIT");
    assert.equal(item.statement.suffix, "outer");
});

test("AST: signal CSV splits on comma", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[france,geography](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.signal, ["france", "geography"]);
});

test("AST: SEND signal is coerced to a number", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, 200);
});

test("AST: EXEC signal is coerced to a string", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node](./):console.log(1):EXEC");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.signal, "node");
});

test("AST: SEND with no signal slot yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<SEND:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, null);
});

test("AST: empty signal on tag-bearing OP yields empty array", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EDIT") return;
    assert.deepEqual(item.statement.signal, []);
});

test("AST: FIND signal is tag filter (string[])", () => {
    const result = PlurnkParser.parseStatements("<<FIND[urgent,critical](known://**):pattern:FIND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["urgent", "critical"]);
});

test("AST: COPY signal is tags-to-apply (string[])", () => {
    const result = PlurnkParser.parseStatements("<<COPY[archive,2026](known://draft):known://archive/draft:COPY");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.deepEqual(item.statement.signal, ["archive", "2026"]);
});

test("lexer error: SEND with non-numeric signal", () => {
    const result = PlurnkParser.parseStatements("<<SEND[abc]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
    assert.match(errors[0].error.message, /expected integer for SEND/);
});

test("lexer error: SEND with multiple signal values", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200,extra]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
});

test("lexer error: EXEC with multiple signal values", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node,extra](./):cmd:EXEC");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
    assert.match(errors[0].error.message, /expected executor for EXEC/);
});

test("permissive: SEND with empty signal [] yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<SEND[]:msg:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, null);
});

test("permissive: EXEC with empty signal [] yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[](./):cmd:EXEC");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.signal, null);
});

test("permissive: tag signal tolerates stray commas", () => {
    const result = PlurnkParser.parseStatements("<<FIND[,a,,b,](p):m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["a", "b"]);
});

test("permissive: tag signal accepts whitespace-separated tags", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a b c](p):m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["a", "b", "c"]);
});

// -------------------------------------------------------------------------
// Native-JS validation: URL and regex
// -------------------------------------------------------------------------

test("valid path (https URL) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://example.com/page)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid path (custom scheme) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(known://entries/foo)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("valid path (relative, falls back to file://) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(./README.md)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("valid path (glob pattern under file://) accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/**/*.xml)::FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid path (unterminated IPv6 bracket) produces visitor error", () => {
    // WHATWG URL accepts many surprising things (spaces auto-encode, custom schemes
    // pass through, etc.), but it rejects malformed authority forms like an
    // unclosed IPv6 bracket — and similar URL-protocol violations.
    const result = PlurnkParser.parseStatements("<<READ(http://[bad):body:READ");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("valid regex body accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://errors):#timeout|deadline#i:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("regex body missing closing hash falls back to glob, not error", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):#unclosed-regex:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 0, "disambiguation should fall back, not error");
    const stmt = result.items.find((i) => i.kind === "statement");
    if (!stmt || stmt.kind !== "statement" || stmt.statement.op !== "FIND") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});

test("invalid regex pattern (unterminated character class) falls back to glob, not error", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):#[abc#:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 0, "disambiguation should fall back, not error");
    const stmt = result.items.find((i) => i.kind === "statement");
    if (!stmt || stmt.kind !== "statement" || stmt.statement.op !== "FIND") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});

test("MatcherBody: single-slash `/path`-shaped literal falls back to glob (`/` is freed)", () => {
    const result = PlurnkParser.parseStatements("<<READ(host.conf):/etc/hosts:READ");
    const stmt = result.items.find((i) => i.kind === "statement");
    if (!stmt || stmt.kind !== "statement" || stmt.statement.op !== "READ") return;
    const b = stmt.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "glob");
    assert.equal(b.raw, "/etc/hosts");
});

test("valid xpath body (//user[@role='admin']) accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/x.xml)://user[@role='admin']:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid xpath body with complex predicate accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://book[price>10 and @lang='en']/title:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid xpath body (unterminated predicate) falls back to glob, not error", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://book[unterminated:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 0, "disambiguation should fall back, not error");
    const stmt = result.items.find((i) => i.kind === "statement");
    assert.ok(stmt && stmt.kind === "statement");
    if (stmt.kind !== "statement" || stmt.statement.op !== "FIND") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});

test("invalid xpath body (stray operators) falls back to glob, not error", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://**/foo{bar}:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 0, "disambiguation should fall back, not error");
    const stmt = result.items.find((i) => i.kind === "statement");
    assert.ok(stmt && stmt.kind === "statement");
    if (stmt.kind !== "statement" || stmt.statement.op !== "FIND") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});

test("valid jsonpath body ($.greeting) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(lang/en.json):$.greeting:READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid jsonpath body with descendant and wildcard accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(books.json):$..book[*].price:READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid jsonpath body (unclosed paren) falls back to glob, not error", () => {
    const result = PlurnkParser.parseStatements("<<READ(books.json):$[(:READ");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 0, "disambiguation should fall back, not error");
    const stmt = result.items.find((i) => i.kind === "statement");
    if (!stmt || stmt.kind !== "statement" || stmt.statement.op !== "READ") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});


test("glob body (no special prefix) skips regex validation", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**):Paris*:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("non-matcher OP body never triggers regex validation", () => {
    // EDIT body starting with '/' is content, not regex; should not be validated.
    const result = PlurnkParser.parseStatements("<<EDIT(p):/this looks like regex but is EDIT content/x:EDIT");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("AST: line marker single position", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<5>:line:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [5] });
});

test("AST: line marker positive range", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<4-7>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [4, 7] });
});

test("AST: line marker append sentinel", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-1] });
});

test("AST: line marker negative range like <0--5>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<0--5>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [0, -5] });
});

test("AST: line marker range with negative start <-3--1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-3--1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-3, -1] });
});

test("AST: line marker comma-separated range <4,7>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<4,7>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [4, 7] });
});

test("AST: line marker comma-separated with negative end <1,-1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<1,-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [1, -1] });
});

test("AST: line marker comma+space tolerance <1, -1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<1, -1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [1, -1] });
});

test("AST: line marker comma-separated negative-to-negative <-3,-1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-3,-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-3, -1] });
});

test("AST: empty body is null, not empty string", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)::EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.body, null);
});

test("AST: missing path is null", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.target, null);
});

// -------------------------------------------------------------------------
// ParsedPath: local vs URL discrimination, URL component breakdown
// -------------------------------------------------------------------------

test("ParsedPath: bare path is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<READ(./README.md)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    assert.equal(p.kind, "local");
    assert.equal(p.raw, "./README.md");
});

test("ParsedPath: glob path is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/**/*.xml)::FIND");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    assert.equal(p.kind, "local");
    assert.equal(p.raw, "config/**/*.xml");
});

test("ParsedPath: https URL decomposed fully", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://user:pass@sub.example.com:8080/foo/bar?q=1&q=2#frag)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pass");
    assert.equal(p.hostname, "sub.example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/foo/bar");
    assert.deepEqual(p.params, { q: ["1", "2"] });
    assert.equal(p.fragment, "frag");
});

test("ParsedPath: known:/// — empty authority, leading-slash pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(known:///entries/foo/bar)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "known");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/entries/foo/bar");
});

test("ParsedPath: log:/// — empty authority, full address in pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(log:///1/turn/2/action/3/get)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "log");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/1/turn/2/action/3/get");
});

test("ParsedPath: two-slash on an authority-less scheme parses the first segment as host", () => {
    const result = PlurnkParser.parseStatements("<<READ(known://entries/foo)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    if (p?.kind !== "url") return;
    assert.equal(p.hostname, "entries");
    assert.equal(p.pathname, "/foo");
});

test("ParsedPath: file:///… scheme parses, empty hostname", () => {
    const result = PlurnkParser.parseStatements("<<READ(file:///tmp/foo.txt)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

test("ParsedPath: empty query and fragment are null/empty", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://example.com/foo)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.deepEqual(p.params, {});
    assert.equal(p.fragment, null);
});

// -------------------------------------------------------------------------
// Uniform authority — `://` introduces an authority for every scheme; an
// authority-less reference uses the empty-authority form `scheme:///path`.
// No per-scheme allowlist (replaces the issue #5 cleavage).
// -------------------------------------------------------------------------

test("ParsedPath cleavage: HTTPS retains authority decomposition", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://user:pw@example.com:8080/api/data?q=1#frag)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pw");
    assert.equal(p.hostname, "example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/api/data");
    assert.deepEqual(p.params, { q: "1" });
    assert.equal(p.fragment, "frag");
});

test("ParsedPath: sh:/// — empty authority, leading-slash pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(sh:///run-tests)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "sh");
    assert.equal(p.username, null);
    assert.equal(p.password, null);
    assert.equal(p.hostname, null);
    assert.equal(p.port, null);
    assert.equal(p.pathname, "/run-tests");
});

test("ParsedPath: wiki:/// — single-segment pathname under empty authority", () => {
    const result = PlurnkParser.parseStatements("<<READ(wiki:///Paris)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
});

test("ParsedPath: empty-authority scheme preserves params and fragment", () => {
    const result = PlurnkParser.parseStatements("<<READ(wiki:///Paris?lang=fr#History)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
    assert.deepEqual(p.params, { lang: "fr" });
    assert.equal(p.fragment, "History");
});

test("ParsedPath: known:/// nested path stays whole", () => {
    const result = PlurnkParser.parseStatements("<<READ(known:///philosophy/existentialism/meaning)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "known");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/philosophy/existentialism/meaning");
});

test("ParsedPath cleavage: file:// stays authority-bearing", () => {
    const result = PlurnkParser.parseStatements("<<READ(file:///tmp/foo.txt)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

// -------------------------------------------------------------------------
// Typed body: MatcherBody, ParsedPath (COPY/MOVE destination), SendBody
// -------------------------------------------------------------------------

test("MatcherBody: regex returns dialect + compiled regexp", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):#foo|bar#i:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    if (b.dialect !== "regex") return;
    assert.equal(b.pattern, "foo|bar");
    assert.equal(b.flags, "i");
    // Consumers reconstruct via `new RegExp(pattern, flags)` when they need the compiled object.
    const rx = new RegExp(b.pattern, b.flags);
    assert.equal(rx.test("foo"), true);
    assert.equal(rx.test("FOO"), true); // i flag works
});

test("target: path-name regex `#…#flags` parses to a regex ParsedPath", () => {
    const result = PlurnkParser.parseStatements("<<FIND(#draft.*#i)::FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const t = item.statement.target;
    if (t?.kind !== "regex") { assert.fail("expected regex target"); return; }
    assert.equal(t.pattern, "draft.*");
    assert.equal(t.flags, "i");
});

test("MatcherBody: xpath returns dialect + raw", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://user[@role='admin']:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "xpath");
    assert.equal(b.raw, "//user[@role='admin']");
});

test("MatcherBody: jsonpath returns dialect + raw", () => {
    const result = PlurnkParser.parseStatements("<<READ(lang/en.json):$.greeting:READ");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "READ") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "jsonpath");
    assert.equal(b.raw, "$.greeting");
});

test("MatcherBody: glob returns dialect + raw (no metacharacters)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://countries/**):Paris*:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "glob");
    assert.equal(b.raw, "Paris*");
});

test("MatcherBody: semantic returns dialect + raw (natural language query)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**):~distributed consensus algorithms:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
    assert.equal(b.raw, "~distributed consensus algorithms");
});

test("MatcherBody: semantic dispatches with top-K via <L>", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**)<5>:~graph algorithms:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [5] });
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
    assert.equal(b.raw, "~graph algorithms");
});

test("MatcherBody: semantic accepts arbitrary text after tilde (no parse step)", () => {
    const result = PlurnkParser.parseStatements("<<OPEN:~find me anything about: !@#$%^ malformed (but valid as query):OPEN");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "OPEN") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
});

test("MatcherBody: graph inbound query (@<symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@<createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@<createCoder");
});

test("MatcherBody: graph outbound query (@>symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@>createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@>createCoder");
});

test("MatcherBody: graph neighborhood query (@symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@createCoder");
});

test("MatcherBody: //-prefix code comment falls back to glob (xpath disambiguation)", () => {
    const result = PlurnkParser.parseStatements("<<READ(src/app.js):// TODO: add error handling:READ");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "READ") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "glob");
    assert.equal(b.raw, "// TODO: add error handling");
});

test("MatcherBody: //-prefix string with non-xpath syntax falls back to glob", () => {
    const result = PlurnkParser.parseStatements("<<READ(file.txt):// foo {bar}:READ");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "READ") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "glob");
});

test("MatcherBody: valid xpath still dispatches xpath even after disambiguation", () => {
    const result = PlurnkParser.parseStatements("<<READ(page.html)://h1/text():READ");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "READ") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "xpath");
    assert.equal(b.raw, "//h1/text()");
});

test("COPY body is an opaque raw string (scheme interprets — dest or fork prompt)", () => {
    const result = PlurnkParser.parseStatements("<<COPY(known://draft):known://archive/2026-05-14/draft:COPY");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.equal(item.statement.body, "known://archive/2026-05-14/draft");
});

test("COPY body carries a run-fork prompt verbatim", () => {
    const result = PlurnkParser.parseStatements("<<COPY(run://.):Re-derive the capital from a primary source.:COPY");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.equal(item.statement.body, "Re-derive the capital from a primary source.");
});

test("parsePath export resolves a COPY destination into the same ParsedPath as a (target) slot", () => {
    const result = PlurnkParser.parseStatements("<<COPY(known:///draft):known:///archive/draft:COPY");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    const dest = parsePath(item.statement.body!);
    assert.ok(dest);
    if (dest.kind !== "url") return;
    assert.equal(dest.scheme, "known");
    assert.equal(dest.pathname, "/archive/draft");
    // A bare/local destination stays local, never throws.
    assert.deepEqual(parsePath("archive/2026/draft"), { kind: "local", raw: "archive/2026/draft" });
});

test("MOVE body is a ParsedPath", () => {
    const result = PlurnkParser.parseStatements("<<MOVE(known:///draft):known:///final/answer:MOVE");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "MOVE") return;
    const b = item.statement.body;
    assert.ok(b);
    if (b.kind !== "url") return;
    assert.equal(b.scheme, "known");
    assert.equal(b.hostname, null);
    assert.equal(b.pathname, "/final/answer");
});

test("MOVE body with local destination is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<MOVE(known://draft):./out.txt:MOVE");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "MOVE") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.kind, "local");
    assert.equal(b.raw, "./out.txt");
});

test("SendBody: JSON-shaped body has parsed json", () => {
    const result = PlurnkParser.parseStatements(`<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND`);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.raw, `{"answer":"Paris","confidence":0.95}`);
    assert.deepEqual(b.json, { answer: "Paris", confidence: 0.95 });
});

test("SendBody: plain-text body has json=null but raw preserved", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.raw, "Paris");
    assert.equal(b.json, null);
});

test("EDIT body remains raw string", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(known://entry):line one\nline two:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") return;
    assert.equal(item.statement.body, "line one\nline two");
});

test("EXEC body remains raw string", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node](./):console.log(1+1):EXEC");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.body, "console.log(1+1)");
});

// -------------------------------------------------------------------------
// Error message text — protocol vocabulary, no parser jargon
// -------------------------------------------------------------------------

const firstError = (input: string) => {
    const r = PlurnkParser.parseStatements(input);
    const e = r.items.find((i) => i.kind === "error");
    if (!e || e.kind !== "error") throw new Error("no error in result");
    return e.error;
};

test("error message: missing close tag uses 'close tag' wording", () => {
    const e = firstError("<<EDIT(p):body without close");
    assert.match(e.message, /close tag/);
    assert.doesNotMatch(e.message, /CLOSE_TAG|EOF|<EOF>|RPAREN|LBRACKET/);
});

test("error message: << inside target says 'in target'", () => {
    const e = firstError("<<EDIT(<<broken):body:EDIT");
    assert.match(e.message, /unrecognized character '<<' in target/);
});

test("error message: << inside signal says 'in tag signal'", () => {
    const e = firstError("<<EDIT[<<broken](p):body:EDIT");
    assert.match(e.message, /unrecognized character '<<' in tag signal/);
});

test("error message: stray char in slot region names what's allowed", () => {
    const e = firstError("<<EDIT(p)X:body:EDIT");
    assert.match(e.message, /unrecognized character 'X' in slot region/);
    assert.match(e.message, /\[signal\].*\(target\).*<L>.*:body:/);
});

test("error message: no ANTLR-y terminology leaks through", () => {
    const inputs = [
        "<<EDIT(p):body without close",
        "<<EDIT(p)X:body:EDIT",
        "<<EDIT(<<x):body:EDIT",
        "<<EDIT[<<x](p):body:EDIT",
    ];
    const forbidden = /token recognition|mismatched|extraneous|expecting|no viable|RPAREN|LBRACKET|RBRACKET|LPAREN|COLON|CLOSE_TAG|BODY_TEXT|<EOF>|ATN/;
    for (const input of inputs) {
        const r = PlurnkParser.parseStatements(input);
        for (const item of r.items) {
            if (item.kind !== "error") continue;
            assert.doesNotMatch(item.error.message, forbidden, `forbidden text in: ${item.error.message}`);
        }
    }
});

test("AST: position points to opening << column", () => {
    const result = PlurnkParser.parseStatements("\n\n  <<EDIT(p):body:EDIT");
    const item = result.items.find((i) => i.kind === "statement");
    assert.ok(item);
    if (item?.kind !== "statement") return;
    assert.equal(item.statement.position.line, 3);
    assert.equal(item.statement.position.column, 2);
});

test("AST: discriminated union narrows correctly per op", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):body:EDIT<<READ(q)::READ");
    const statements = result.items.filter((i) => i.kind === "statement");
    assert.equal(statements.length, 2);
    if (statements[0].kind !== "statement" || statements[1].kind !== "statement") return;
    assert.equal(statements[0].statement.op, "EDIT");
    assert.equal(statements[1].statement.op, "READ");
});

test("unparsedTail: mismatched close-tag suffix names the open tag", () => {
    const result = PlurnkParser.parseStatements("<<EDITouter(p):body:EDIT");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /`<<EDITouter`/);
    assert.match(result.unparsedTail!.reason, /add `:EDITouter`/);
});

test("unparsedTail: unclosed signal slot names what's missing", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[tag");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /signal slot of `<<EDIT`/);
    assert.match(result.unparsedTail!.reason, /add `]`/);
});

test("unparsedTail: unclosed target slot names what's missing", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(path");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /target slot of `<<EDIT`/);
    assert.match(result.unparsedTail!.reason, /add `\)`/);
});

test("error message: slot region errors enumerate the four slots", () => {
    const e = firstError("<<EDIT(p)X:body:EDIT");
    assert.match(e.message, /any order/);
});

test("slot order: canonical [signal](path)<L> parses", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a,b](p)<1-5>:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: (path)[signal]<L> accepted (reordered)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(p)[a,b]<1-5>:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: <L>(path)[signal] accepted (reordered)", () => {
    const result = PlurnkParser.parseStatements("<<FIND<1-5>(p)[a,b]:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: all 6 permutations of 3-slot FIND yield equivalent ASTs", () => {
    const variants = [
        "<<FIND[t](p)<2>:m:FIND",
        "<<FIND[t]<2>(p):m:FIND",
        "<<FIND(p)[t]<2>:m:FIND",
        "<<FIND(p)<2>[t]:m:FIND",
        "<<FIND<2>[t](p):m:FIND",
        "<<FIND<2>(p)[t]:m:FIND",
    ];
    for (const input of variants) {
        const result = PlurnkParser.parseStatements(input);
        assert.equal(result.items.filter((i) => i.kind === "error").length, 0, `errors for: ${input}`);
        const item = result.items[0];
        if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail(`not FIND for: ${input}`); return; }
        assert.deepEqual(item.statement.signal, ["t"], `signal mismatch for: ${input}`);
        assert.equal(item.statement.target?.kind, "local", `path mismatch for: ${input}`);
        assert.equal(item.statement.lineMarker?.marks[0], 2, `L mismatch for: ${input}`);
    }
});

test("slot order: SEND with (path)[signal] reversed", () => {
    const result = PlurnkParser.parseStatements("<<SEND(agent://named)[200]:msg:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("not SEND"); return; }
    assert.equal(item.statement.signal, 200);
    assert.equal(item.statement.target?.kind, "url");
});

test("slot order: duplicate signal slots rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a][b](p):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("slot order: duplicate path slots rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND(p1)(p2):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("slot order: duplicate line markers rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND<1><2>(p):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("SEND: <L> slot rejected; EXEC: <L> slot accepted (timeout,poll)", () => {
    const r1 = PlurnkParser.parseStatements("<<SEND[200]<1>:msg:SEND");
    assert.ok(r1.items.filter((i) => i.kind === "error").length >= 1); // SEND has no <L>
    const r2 = PlurnkParser.parseStatements("<<EXEC[node]<60,5>(./):cmd:EXEC");
    assert.equal(r2.items.filter((i) => i.kind === "error").length, 0, `EXEC <timeout,poll> should parse: ${JSON.stringify(r2.items)}`);
    const stmt = r2.items.find((i) => i.kind === "statement");
    assert.ok(stmt?.kind === "statement" && stmt.statement.op === "EXEC" && stmt.statement.lineMarker !== null, "EXEC lineMarker should be populated");
});

// -------------------------------------------------------------------------
// Degenerate / adversarial inputs: delimiter chars in opaque slots must not
// break the parser. Bodies are opaque (BODY mode), so brackets/braces/parens
// and JSON arrays are content; only a stray delimiter in the SIGNAL region is
// a (graceful) error, never a throw or hang.
// -------------------------------------------------------------------------

const cleanParse = (input: string) => {
    const r = PlurnkParser.parseStatements(input);
    return {
        stmts: r.items.filter((i) => i.kind === "statement").length,
        errs: r.items.filter((i) => i.kind === "error").length,
        tail: r.unparsedTail !== undefined,
    };
};

test("degenerate: stray right bracket in a SEND body is opaque content", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:array[0] and a stray ] bracket:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: JSON array in a SEND body parses clean", () => {
    assert.deepEqual(cleanParse(`<<SEND[400]:{"expected":["a","b"],"got":[1,2]}:SEND`), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: all-brackets / mixed delimiters in a body parse clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:]]]) }{[ <> mixed:SEND"), { stmts: 1, errs: 0, tail: false });
    assert.deepEqual(cleanParse("<<EDIT(a.md):x = arr[0] + (y) + {z}:EDIT"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: bracket body on a targeted (terminate-and-report) SEND parses clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200](run://parent):result ] arr[0]:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: bracket immediately before the close tag parses clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:value]:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: stray bracket in the SIGNAL region errors gracefully (no throw)", () => {
    const r = cleanParse("<<SEND[200]]:body:SEND");
    assert.equal(r.stmts, 0);
    assert.ok(r.errs >= 1, "expected a graceful parse error, not a clean parse");
});

// -------------------------------------------------------------------------
// parseLog — multi-turn logs (Plurnk Script): each turn WRAPPED in <<TURN…:…:TURN
// -------------------------------------------------------------------------

// wrap a bare sandwich in the TURN enclosure
const turn = (sandwich: string) => `<<TURN:${sandwich}:TURN`;
const logResult = (input: string) => {
    const r = PlurnkParser.parseLog(input);
    return {
        stmts: r.items.filter((i) => i.kind === "statement").length,
        errs: r.items.filter((i) => i.kind === "error").length,
        tail: r.unparsedTail !== undefined,
    };
};
const logInvalid = (input: string) => {
    const r = PlurnkParser.parseLog(input);
    return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
};

test("parseLog: a multi-turn log of <<TURN>-wrapped turns parses clean and flattens in order", () => {
    const log =
        turn("<<PLAN:find it:PLAN <<READ(known:///x)::READ <<SEND[102]:reading:SEND") + "\n" +
        turn("<<PLAN:answer:PLAN <<SEND[200]:done:SEND");
    assert.deepEqual(logResult(log), { stmts: 5, errs: 0, tail: false }); // PLAN READ SEND | PLAN SEND
});

test("parseLog: a single wrapped turn is a valid log", () => {
    assert.deepEqual(logResult(turn("<<PLAN:p:PLAN <<SEND[200]:done:SEND")), { stmts: 2, errs: 0, tail: false });
});

test("parseLog: prose inside a wrapped turn is tolerated (comments)", () => {
    assert.equal(logResult(turn("thinking <<PLAN:p:PLAN consider <<READ(known:///x)::READ <<SEND[200]:done:SEND")).errs, 0);
});

test("parseLog: a BARE (unwrapped) turn is NOT a valid log — TURN wrapping is required", () => {
    assert.ok(logInvalid("<<PLAN:p:PLAN <<SEND[200]:done:SEND"), "log requires <<TURN wrapping");
});

test("parseLog: a wrapped turn missing its inner PLAN is invalid (sandwich is law)", () => {
    assert.ok(logInvalid(turn("<<READ(known:///x)::READ <<SEND[200]:done:SEND")), "no PLAN inside the TURN");
});

test("parseLog: a wrapped turn missing its terminal SEND is invalid", () => {
    assert.ok(logInvalid(turn("<<PLAN:p:PLAN <<READ(known:///x)::READ")), "no terminal SEND inside the TURN");
});

test("parseLog: an unclosed <<TURN is invalid", () => {
    assert.ok(logInvalid("<<TURN:<<PLAN:p:PLAN <<SEND[200]:done:SEND"), "TURN never closed");
});

test("parseLog: empty input is not a valid log (needs at least one wrapped turn)", () => {
    assert.ok(logInvalid(""), "a log needs >=1 turn");
});

test("parse: rejects a <<TURN>-wrapped turn (wrapping is parseLog's path, not parse's)", () => {
    const r = PlurnkParser.parse(turn("<<PLAN:p:PLAN <<SEND[200]:done:SEND"));
    assert.ok(r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined);
});

// -------------------------------------------------------------------------
// parse() is strictly ONE PLAN-anchored turn — no mid-PLAN, no multi-turn
// -------------------------------------------------------------------------

const parseInvalid = (input: string) => {
    const r = PlurnkParser.parse(input);
    return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
};

test("parse: rejects multi-turn input (that is parseLog's job)", () => {
    assert.ok(parseInvalid("<<PLAN:a:PLAN\n<<SEND[200]:x:SEND\n<<PLAN:b:PLAN\n<<SEND[200]:y:SEND"));
});

test("parse: rejects a mid-batch PLAN (PLAN is the anchor, never a mid-op)", () => {
    assert.ok(parseInvalid("<<PLAN:a:PLAN\n<<PLAN:b:PLAN\n<<SEND[200]:done:SEND"));
});

test("parse: the canonical single sandwich is valid", () => {
    const r = PlurnkParser.parse("<<PLAN:p:PLAN\n<<READ(known:///x)::READ\n<<SEND[200]:done:SEND");
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(r.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// TURN close-tag hardening (caught in self-review): suffix + non-ident follow
// -------------------------------------------------------------------------

test("parseLog: a :TURN-prefixed word in a turn's prose does not false-close", () => {
    assert.equal(logResult(turn("<<PLAN:p:PLAN mentioning :TURNING here <<SEND[200]:done:SEND")).errs, 0);
});

test("parseLog: TURN suffix discipline — only the matching :TURN<suffix> closes", () => {
    assert.equal(logResult("<<TURN1:<<PLAN:p:PLAN <<SEND[200]:x:SEND:TURN1").errs, 0);   // matched suffix closes
    assert.ok(logInvalid("<<TURN1:<<PLAN:p:PLAN <<SEND[200]:x:SEND:TURN2"));             // mismatch => unclosed
});

test("parseLog: :TURN inside an inner op body is opaque content, not a close", () => {
    assert.equal(logResult(turn("<<PLAN:p:PLAN <<SEND[200]:done :TURN literally:SEND")).errs, 0);
});

// -------------------------------------------------------------------------
// #42: narrow single-colon empty-body toleration (close only at a boundary)
// -------------------------------------------------------------------------

const ssCount = (s: string) => PlurnkParser.parseStatements(s).items.filter((i) => i.kind === "statement").length;
const ssClean = (s: string) => {
    const r = PlurnkParser.parseStatements(s);
    return !r.items.some((i) => i.kind === "error") && !r.unparsedTail;
};

test("#42: single-colon body-less ops no longer merge — close at newline", () => {
    const r = PlurnkParser.parseStatements("<<READ(known://x/a):READ\n<<READ(known://x/b):READ");
    assert.equal(r.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
});

test("#42: single-colon body-less closes at EOF and at a glued <<", () => {
    assert.ok(ssClean("<<READ(t):READ"));                     // EOF boundary
    assert.equal(ssCount("<<READ(t):READ"), 1);
    assert.equal(ssCount("<<READ(a):READ<<FIND(b):FIND"), 2); // glued, next << boundary
});

test("#42: canonical ::OP empty body still works", () => {
    assert.equal(ssCount("<<READ(a)::READ\n<<READ(b)::READ"), 2);
});

test("#42: a body starting with the op keyword is NOT mis-closed (non-boundary follow)", () => {
    const r = PlurnkParser.parseStatements("<<EDIT(t):EDIT this line:EDIT");
    const it = r.items[0];
    assert.ok(it.kind === "statement" && it.statement.body === "EDIT this line");
});

test("#42: a body equal to the op keyword is expressible via a suffix", () => {
    const r = PlurnkParser.parseStatements("<<FIND1(t):FIND:FIND1");
    const it = r.items[0];
    assert.ok(it.kind === "statement" && (it.statement.body as any)?.raw === "FIND");
});
