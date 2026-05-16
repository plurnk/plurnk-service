import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";
import { PlurnkParser } from "../../src/index.ts";

// -------------------------------------------------------------------------
// Position
// -------------------------------------------------------------------------

test("Validator: Position accepts well-formed", () => {
    const { valid, errors } = Validator.validatePosition({ line: 1, column: 0 });
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
});

test("Validator: Position rejects missing column", () => {
    const { valid } = Validator.validatePosition({ line: 1 });
    assert.equal(valid, false);
});

test("Validator: Position rejects missing line", () => {
    const { valid } = Validator.validatePosition({ column: 0 });
    assert.equal(valid, false);
});

test("Validator: Position rejects negative line", () => {
    const { valid } = Validator.validatePosition({ line: -1, column: 0 });
    assert.equal(valid, false);
});

test("Validator: Position rejects non-integer line", () => {
    const { valid } = Validator.validatePosition({ line: 1.5, column: 0 });
    assert.equal(valid, false);
});

test("Validator: Position rejects extra property", () => {
    const { valid } = Validator.validatePosition({ line: 1, column: 0, foo: "bar" });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// LineMarker
// -------------------------------------------------------------------------

test("Validator: LineMarker accepts single-position", () => {
    const { valid } = Validator.validateLineMarker({ first: 1, last: null });
    assert.equal(valid, true);
});

test("Validator: LineMarker accepts range", () => {
    const { valid } = Validator.validateLineMarker({ first: 1, last: 10 });
    assert.equal(valid, true);
});

test("Validator: LineMarker accepts negative sentinel (append)", () => {
    const { valid } = Validator.validateLineMarker({ first: -1, last: null });
    assert.equal(valid, true);
});

test("Validator: LineMarker accepts zero sentinel (prepend)", () => {
    const { valid } = Validator.validateLineMarker({ first: 0, last: null });
    assert.equal(valid, true);
});

test("Validator: LineMarker accepts negative range", () => {
    const { valid } = Validator.validateLineMarker({ first: -3, last: -1 });
    assert.equal(valid, true);
});

test("Validator: LineMarker rejects missing last", () => {
    const { valid } = Validator.validateLineMarker({ first: 1 });
    assert.equal(valid, false);
});

test("Validator: LineMarker rejects string first", () => {
    const { valid } = Validator.validateLineMarker({ first: "1", last: null });
    assert.equal(valid, false);
});

test("Validator: LineMarker rejects extra property", () => {
    const { valid } = Validator.validateLineMarker({ first: 1, last: null, extra: true });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Round-trip: parser output validates against schemas
// -------------------------------------------------------------------------

test("Round-trip: AST.position from parsed statement validates", () => {
    const result = PlurnkParser.parse("<<EDIT(p):body:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const { valid, errors } = Validator.validatePosition(item.statement.position);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.lineMarker (single) from parsed statement validates", () => {
    const result = PlurnkParser.parse("<<FIND(p)<5>:m:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.lineMarker (range) from parsed statement validates", () => {
    const result = PlurnkParser.parse("<<FIND(p)<1-10>:m:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.lineMarker (append sentinel) from parsed statement validates", () => {
    const result = PlurnkParser.parse("<<EDIT(p)<-1>:appended:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") { assert.fail("expected EDIT"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: JSON-serialized AST.position round-trips through validator", () => {
    const result = PlurnkParser.parse("<<EDIT(p):body:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const serialized = JSON.stringify(item.statement.position);
    const reloaded = JSON.parse(serialized);
    const { valid } = Validator.validatePosition(reloaded);
    assert.equal(valid, true);
});

// -------------------------------------------------------------------------
// ParsedPath
// -------------------------------------------------------------------------

test("Validator: ParsedPath accepts local", () => {
    const { valid } = Validator.validateParsedPath({ kind: "local", raw: "config/foo.xml" });
    assert.equal(valid, true);
});

test("Validator: ParsedPath accepts url with full decomposition", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com:8080/path?q=1#frag",
        scheme: "https",
        username: null,
        password: null,
        hostname: "example.com",
        port: 8080,
        pathname: "/path",
        params: { q: "1" },
        fragment: "frag",
    });
    assert.equal(valid, true);
});

test("Validator: ParsedPath accepts url with null authority fields", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "known://philosophy",
        scheme: "known",
        username: null,
        password: null,
        hostname: "philosophy",
        port: null,
        pathname: "",
        params: {},
        fragment: null,
    });
    assert.equal(valid, true);
});

test("Validator: ParsedPath rejects unknown kind", () => {
    const { valid } = Validator.validateParsedPath({ kind: "remote", raw: "foo" });
    assert.equal(valid, false);
});

test("Validator: ParsedPath rejects url missing required field", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com/",
        scheme: "https",
    });
    assert.equal(valid, false);
});

test("Validator: ParsedPath accepts multi-value params (array)", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com/?q=1&q=2",
        scheme: "https",
        username: null,
        password: null,
        hostname: "example.com",
        port: null,
        pathname: "/",
        params: { q: ["1", "2"] },
        fragment: null,
    });
    assert.equal(valid, true);
});

test("Round-trip: AST.path (local) validates", () => {
    const result = PlurnkParser.parse("<<EDIT(config/foo.xml):body:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    assert.ok(item.statement.path);
    const { valid, errors } = Validator.validateParsedPath(item.statement.path);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.path (url) validates after JSON round-trip", () => {
    const result = PlurnkParser.parse("<<EDIT(https://example.com:8080/p?q=1&q=2#frag):body:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const reloaded = JSON.parse(JSON.stringify(item.statement.path));
    const { valid, errors } = Validator.validateParsedPath(reloaded);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

// -------------------------------------------------------------------------
// MatcherBody
// -------------------------------------------------------------------------

test("Validator: MatcherBody accepts xpath", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "xpath", raw: "//user[@role]" });
    assert.equal(valid, true);
});

test("Validator: MatcherBody accepts regex with pattern+flags", () => {
    const { valid } = Validator.validateMatcherBody({
        dialect: "regex",
        raw: "/foo|bar/i",
        pattern: "foo|bar",
        flags: "i",
    });
    assert.equal(valid, true);
});

test("Validator: MatcherBody accepts jsonpath", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "jsonpath", raw: "$.greeting" });
    assert.equal(valid, true);
});

test("Validator: MatcherBody accepts glob", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "glob", raw: "*.xml" });
    assert.equal(valid, true);
});

test("Validator: MatcherBody rejects unknown dialect", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "sql", raw: "SELECT *" });
    assert.equal(valid, false);
});

test("Validator: MatcherBody rejects regex missing pattern/flags", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "regex", raw: "/foo/i" });
    assert.equal(valid, false);
});

test("Round-trip: AST.body (regex MatcherBody) validates", () => {
    const result = PlurnkParser.parse("<<FIND(p):/foo|bar/i:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.body (xpath MatcherBody) validates", () => {
    const result = PlurnkParser.parse("<<FIND(p)://user[@role]:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.body (jsonpath MatcherBody) validates", () => {
    const result = PlurnkParser.parse("<<FIND(p):$.field:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.body (glob MatcherBody) validates", () => {
    const result = PlurnkParser.parse("<<FIND(p):*.xml:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

// -------------------------------------------------------------------------
// SendBody
// -------------------------------------------------------------------------

test("Validator: SendBody accepts plain text body", () => {
    const { valid } = Validator.validateSendBody({ raw: "Paris", json: null });
    assert.equal(valid, true);
});

test("Validator: SendBody accepts JSON body with parsed value", () => {
    const { valid } = Validator.validateSendBody({
        raw: '{"answer":"Paris"}',
        json: { answer: "Paris" },
    });
    assert.equal(valid, true);
});

test("Validator: SendBody accepts JSON array", () => {
    const { valid } = Validator.validateSendBody({ raw: "[1,2,3]", json: [1, 2, 3] });
    assert.equal(valid, true);
});

test("Validator: SendBody accepts json field as any primitive", () => {
    assert.equal(Validator.validateSendBody({ raw: "42", json: 42 }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "true", json: true }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "\"s\"", json: "s" }).valid, true);
});

test("Validator: SendBody rejects missing raw", () => {
    const { valid } = Validator.validateSendBody({ json: null });
    assert.equal(valid, false);
});

test("Round-trip: AST.body (SendBody with JSON) validates", () => {
    const result = PlurnkParser.parse('<<SEND[200]:{"answer":"Paris"}:SEND');
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("Round-trip: AST.body (SendBody plain text) validates", () => {
    const result = PlurnkParser.parse("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body!);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});
